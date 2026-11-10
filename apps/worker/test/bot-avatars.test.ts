import type { BotAnswer, Bots, BotSettings, NewWorkspace, UserId } from "@ember/protocol";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BOT_AVATAR } from "../src/default-bot-avatar";
import type { Env } from "../src/env";
import { api, apiWith, avatarVersionOf, cookieOf, freshDeploy, openWorkspaceSocket, origin, recordedImage, shown, stopTheClock, workspaceSql, type Session } from "./support";

// Bots' avatars.

const files = (env as unknown as Env).FILES!;

const LONG_AGO = "2026-01-01T00:00:00.000Z";

beforeEach(freshDeploy);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler design" };

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** Grace joins with the join link, as a member, signed in. */
async function joinAsGrace(): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify(grace) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: Session["user"] }).user), cookie: cookieOf(response) };
}

/** moon.jpg, a JPEG of 640×640. */
const moon = () => new File([recordedImage("moon-thumb.jpg")], "moon.jpg", { type: "image/jpeg" });

/** The variant of moon.jpg, a WebP of 512×512, standing in for the one the browser makes. */
const moonVariant = () => new File([recordedImage("moon-avatar.webp")], "blob", { type: "image/webp" });

/** A bot form with `fields` as JSON in its `user`, and moon.jpg and its variant as the avatar unless `avatar` says otherwise. */
function botForm(fields: unknown, avatar: { file: File | string; variant?: File } | null = { file: moon(), variant: moonVariant() }): FormData {
  const form = new FormData();
  form.append("user", JSON.stringify(fields));
  if (avatar) form.append("avatar", avatar.file);
  if (avatar?.variant) form.append("variant", avatar.variant);
  return form;
}

/** `form` as a browser sends it, with its length, signed in as `session` if given. */
async function sent(form: FormData, session: Session | null): Promise<{ body: ArrayBuffer; headers: Record<string, string> }> {
  const request = new Request(origin, { method: "POST", body: form });
  const body = await request.arrayBuffer();
  const headers = { "Content-Type": request.headers.get("Content-Type")!, "Content-Length": String(body.byteLength) };
  return { body, headers: session ? { ...headers, Cookie: session.cookie } : headers };
}

const addBot = async (session: Session | null, form: FormData) => api("/api/account/bots", { method: "POST", ...(await sent(form, session)) });
const changeBot = async (session: Session | null, id: UserId, form: FormData) => api(`/api/account/bots/${id}`, { method: "PATCH", ...(await sent(form, session)) });
const renameBot = (session: Session, id: UserId, name: string) => api(`/api/account/bots/${id}`, { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify({ name }) });

/** The bot an answer gives, once it's checked to have succeeded with `status`. */
async function botOf(response: Response, status = 200): Promise<BotSettings> {
  expect(response.status, await response.clone().text()).toBe(status);
  return ((await response.json()) as BotAnswer).bot;
}

/** The avatar at `path`, as `viewer` fetches it. */
const avatar = (path: string, viewer: Session) => api(path, { headers: { Cookie: viewer.cookie } });

/** Everything R2 keeps of avatars. */
const storedAvatars = async () => (await files.list({ prefix: "avatars/" })).objects.map(({ key }) => key).sort();

const avatarKeyOf = async (userId: UserId) => ((await workspaceSql("SELECT avatar_key FROM users WHERE id = ?", userId)) as Array<{ avatar_key: string | null }>)[0]!.avatar_key;

const pendingDeletions = () => workspaceSql("SELECT object_key FROM pending_picture_deletions ORDER BY object_key");

describe("Add and edit a bot", () => {
  it("adds a bot with the avatar its form brings, served as the variant the browser made, keeping the picture as it came", async () => {
    const administrator = await setUp();
    const bot = await botOf(await addBot(administrator, botForm({ name: "Build Bot", webhookUrl: "https://ci.example.com/hook" })), 201);
    expect(bot).toMatchObject({ name: "Build Bot", webhookUrl: "https://ci.example.com/hook", rooms: [{ name: "general" }, { name: "random" }] });

    const response = await avatar(bot.avatarUrl, administrator);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(recordedImage("moon-avatar.webp"));
    const key = (await avatarKeyOf(bot.id))!;
    expect(await storedAvatars()).toEqual([key, `${key}/512`]);
    expect((await files.head(key))?.httpMetadata?.contentType).toBe("image/jpeg");
    // Given to the bot, the picture stays in R2.
    expect(await pendingDeletions()).toEqual([]);
  });

  it("gives a bot the avatar a change brings in place of its own, which R2 deletes, and every page signed in hears of its new address", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const added = await botOf(await addBot(administrator, botForm({ name: "Build Bot" }, null)), 201);
    expect(await (await avatar(added.avatarUrl, administrator)).text()).toBe(DEFAULT_BOT_AVATAR);
    // An avatar's address counts seconds, so the bot was added a while ago.
    await workspaceSql("UPDATE users SET updated_at = ? WHERE id = ?", LONG_AGO, added.id);
    const bot = await botOf(await api(`/api/account/bots/${added.id}`, { headers: { Cookie: administrator.cookie } }));
    const workspace = await openWorkspaceSocket(member);

    const changed = await botOf(await changeBot(administrator, bot.id, botForm({})));
    expect(changed).toMatchObject({ name: "Build Bot", webhookUrl: null });
    expect(changed.avatarUrl).not.toBe(bot.avatarUrl);
    expect(await workspace.next()).toEqual({
      type: "user.updated",
      user: { id: bot.id, name: "Build Bot", bio: null, role: "bot", status: "active", avatarUrl: changed.avatarUrl },
    });
    expect((await avatar(changed.avatarUrl, member)).headers.get("Content-Type")).toBe("image/webp");
    const first = (await avatarKeyOf(bot.id))!;

    // A second picture, with a new name, in one change.
    const renamed = await botOf(await changeBot(administrator, bot.id, botForm({ name: "Deploy Bot" })));
    expect(renamed.name).toBe("Deploy Bot");
    const second = (await avatarKeyOf(bot.id))!;
    expect(second).not.toBe(first);
    await vi.waitFor(async () => expect(await storedAvatars()).toEqual([second, `${second}/512`]), { timeout: 5_000 });
  });

  it("gives a bot's avatar a later address with each change, even one in the same second as the last, which nothing after takes back, as browsers keep the picture they have at one", async () => {
    // Adding the bot, changing its avatar, renaming it and changing its avatar again, all at once.
    stopTheClock();
    const administrator = await setUp();
    const added = await botOf(await addBot(administrator, botForm({ name: "Build Bot" }, null)), 201);
    const changed = await botOf(await changeBot(administrator, added.id, botForm({})));
    const renamed = await botOf(await renameBot(administrator, added.id, "Deploy Bot"));
    const again = await botOf(await changeBot(administrator, added.id, botForm({})));

    const pictures = [added, changed, again].map(({ avatarUrl }) => avatarVersionOf(avatarUrl));
    expect(pictures).toEqual([...pictures].sort((a, b) => a - b));
    expect(new Set(pictures).size).toBe(3);
    // The same picture, at the address it had or a later one.
    expect(avatarVersionOf(renamed.avatarUrl)).toBeGreaterThanOrEqual(avatarVersionOf(changed.avatarUrl));
    expect(avatarVersionOf(renamed.avatarUrl)).toBeLessThan(avatarVersionOf(again.avatarUrl));
  });

  it("keeps a bot's avatar through a change that brings none", async () => {
    const administrator = await setUp();
    const bot = await botOf(await addBot(administrator, botForm({ name: "Build Bot" })), 201);
    const key = await avatarKeyOf(bot.id);

    const renamed = await botOf(await renameBot(administrator, bot.id, "Deploy Bot"));
    expect(await botOf(await changeBot(administrator, bot.id, botForm({ webhookUrl: "https://ci.example.com/hook" }, null)))).toMatchObject({ name: "Deploy Bot" });
    expect(await avatarKeyOf(bot.id)).toBe(key);
    expect((await avatar(renamed.avatarUrl, administrator)).headers.get("Content-Type")).toBe("image/webp");
  });

  it("stores no avatar for anyone but an administrator, a bot that isn't active, or fields it refuses", async () => {
    const administrator = await setUp();
    const member = await joinAsGrace();
    const bot = await botOf(await addBot(administrator, botForm({ name: "Build Bot" }, null)), 201);

    expect((await addBot(null, botForm({ name: "Sneaky Bot" }))).status).toBe(401);
    expect((await addBot(member, botForm({ name: "Sneaky Bot" }))).status).toBe(403);
    expect((await changeBot(member, bot.id, botForm({ name: "Sneaky Bot" }))).status).toBe(403);
    expect((await changeBot(administrator, member.user.id, botForm({ name: "Sneaky Bot" }))).status).toBe(404);
    for (const response of [await addBot(administrator, botForm({ name: " " })), await changeBot(administrator, bot.id, botForm({ webhookUrl: "ftp://files.example.com" }))]) {
      expect(response.status).toBe(422);
    }
    expect(await storedAvatars()).toEqual([]);
    expect(await pendingDeletions()).toEqual([]);
    expect(await avatarKeyOf(bot.id)).toBeNull();
  });

  it("refuses an avatar that isn't a picture's file, and one without an R2 bucket, adding no bot, while a bot without one still saves", async () => {
    const administrator = await setUp();
    const notAFile = await addBot(administrator, botForm({ name: "Build Bot" }, { file: "moon.jpg" }));
    expect([notAFile.status, await notAFile.json()]).toEqual([400, { error: "Choose a picture" }]);

    const form = await sent(botForm({ name: "Build Bot" }), administrator);
    const unbound = await apiWith({ FILES: undefined }, "/api/account/bots", { method: "POST", ...form });
    expect([unbound.status, await unbound.json()]).toEqual([503, { error: "Ember isn't set up to store files" }]);
    expect(((await (await api("/api/account/bots", { headers: { Cookie: administrator.cookie } })).json()) as Bots).bots).toEqual([]);

    const plain = await sent(botForm({ name: "Build Bot" }, null), administrator);
    expect((await botOf(await apiWith({ FILES: undefined }, "/api/account/bots", { method: "POST", ...plain }), 201)).name).toBe("Build Bot");
  });
});
