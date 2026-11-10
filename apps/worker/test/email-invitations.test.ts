import {
  EMAIL_LINK_GONE,
  INVITATION_GONE,
  INVITATIONS_AT_ONCE,
  MEMBERFUL_SIGN_IN_NEEDED,
  NO_EMAIL_ADDRESSES,
  NOT_AN_EMAIL_ADDRESS,
  PASSWORD_TOO_SHORT,
  type EmailInvitation,
  type InvitationOutcome,
  type Invited,
  type Me,
  type NewWorkspace,
  type ProfileAnswer,
  type ResentInvitation,
  type Sidebar,
  type WorkspaceSettings,
} from "@ember/protocol";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyPassword } from "../src/passwords";
import { api, apiWith, builtPages, cookieOf, createRoom, freshDeploy, origin, shown, signIn, withWorkspaceEnv, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const grace = { name: "Grace Hopper", emailAddress: "grace@example.com", password: "compiler" };
const hal = { name: "Hal", password: "heuristically" };

/** A Resend API key, as the deployment's secret holds one. */
const RESEND_KEY = "re_test_only_not_a_key";
/** The keys of a deployment whose members may sign in with Memberful. */
const MEMBERFUL_KEYS = { MEMBERFUL_URL: "https://example.memberful.com/", MEMBERFUL_CLIENT_ID: "ember-client-id", MEMBERFUL_CLIENT_SECRET: "ember-client-secret" };
const DAY_MS = 24 * 60 * 60 * 1000;

/** Sets Ember up with Ada as its administrator, signed in, answering its first room too. */
async function setUp(): Promise<Session & { general: NewWorkspace["room"] }> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  const { user, room } = (await response.json()) as NewWorkspace;
  return { user: shown(user), cookie: cookieOf(response), general: room };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

/** Gives the workspace the From address `emailFrom` as `administrator`, which has to work. */
async function saveFrom(administrator: Session, emailFrom: string): Promise<void> {
  const response = await api("/api/account", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ emailFrom }) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Switches `settings` as `administrator`, as Membership's switches do, on a deployment with Memberful's keys, which has to work. */
async function turn(administrator: Session, settings: Record<string, boolean>): Promise<void> {
  const response = await apiWith(MEMBERFUL_KEYS, "/api/account", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ settings }) });
  expect(response.status, await response.clone().text()).toBe(200);
}

/** Asks to invite `emailAddresses` as `session`, as Membership's Invite by email card does. */
const invite = (session: Session | null, emailAddresses: unknown) => api("/api/invitations", { method: "POST", headers: as(session), body: JSON.stringify({ emailAddresses }) });

/** Invites `emailAddresses` as `administrator`, which has to work, answering what came of each. */
async function invited(administrator: Session, ...emailAddresses: string[]): Promise<InvitationOutcome[]> {
  const response = await invite(administrator, emailAddresses);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as Invited).outcomes;
}

/** Invites `emailAddress` as `administrator`, answering its invitation and the link, if Ember didn't email it. */
async function inviteOne(administrator: Session, emailAddress: string): Promise<{ invitation: EmailInvitation; link: string | null }> {
  const [outcome] = await invited(administrator, emailAddress);
  if (!outcome || "member" in outcome) throw new Error(`${emailAddress} wasn't invited`);
  return outcome;
}

/** The secret in an invitation's link. */
function tokenIn(link: string | null): string {
  const hash = new URL(link!).hash;
  expect(hash).toMatch(/^#token=[\w-]{43}$/);
  return hash.slice("#token=".length);
}

/** The link in an invitation's email. */
const linkIn = (email: EmailMessageBuilder) => /Join here: (\S+)/.exec(email.text ?? "")![1]!;

/** The invitations workspace settings shows `session`. */
const invitations = async (session: Session) => ((await (await api("/api/account", { headers: as(session) })).json()) as WorkspaceSettings).invitations;

const resend = (session: Session | null, id: string) => api(`/api/invitations/${id}/resend`, { method: "POST", headers: as(session) });
const revoke = (session: Session | null, id: string) => api(`/api/invitations/${id}`, { method: "DELETE", headers: as(session) });

/** Asks whom the link with the secret `token` is for, as its page does. */
const lookUp = (token: unknown) => api("/api/email_links/lookup", { method: "POST", body: JSON.stringify({ token }) });

/** Posts an invitation's join form, with its link's secret `token`, as `person`, signed in as `session` if given. */
const joinWith = (token: unknown, person: Record<string, unknown> = hal, session?: Session) =>
  api("/api/join/invitation", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.30", "User-Agent": "Hal's laptop", ...as(session) }, body: JSON.stringify({ ...person, token }) });

/** The answer to a link that doesn't work: its join form's, or the lookup's, which says the same for every kind of link. */
async function expectGone(response: Response, error = INVITATION_GONE): Promise<void> {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error });
}

/** Signs in with an email address and password, as the sign-in form does. */
const signInWithPassword = (emailAddress: string, password: string) => api("/api/session", { method: "POST", body: JSON.stringify({ emailAddress, password }) });

/** Stands in for Cloudflare Email Service's binding, keeping what it's asked to send, and throwing what `refusalFor` gives for an address, if anything. */
function fakeBinding(refusalFor: (to: string) => unknown = () => undefined) {
  const sent: EmailMessageBuilder[] = [];
  const binding = {
    send: async (message: EmailMessageBuilder) => {
      sent.push(message);
      const refusal = refusalFor(String(message.to));
      if (refusal !== undefined) throw refusal;
      return { messageId: `<${crypto.randomUUID()}@example.com>` };
    },
  } as unknown as SendEmail;
  return { binding, sent };
}

/** A request the fake Resend was sent. */
interface SentToResend {
  url: string;
  headers: Headers;
  body: unknown;
}

/** Stands in for Resend's API, answering `answer` to each request, and keeping what it's sent. */
function fakeResend(answer: () => Response = () => Response.json({ data: [{ id: crypto.randomUUID() }] })) {
  const requests: SentToResend[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers, body: await request.json() });
    return answer();
  });
  return requests;
}

const count = async (table: string) => ((await workspaceSql(`SELECT count(*) AS n FROM ${table}`)) as Array<{ n: number }>)[0]!.n;

/** Joins as Grace with the join link, with a password. */
async function joinAsGrace(): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify(grace) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Invite people by email", () => {
  it("emails each address an administrator invites its own link, from the From address, which joins with it for 7 days", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "Ember <ember@example.com>");
    const { binding, sent } = fakeBinding();
    let outcomes: InvitationOutcome[] = [];
    await withWorkspaceEnv({ EMAIL: binding }, async () => void (outcomes = await invited(administrator, "grace@example.com", "Hal@Example.com")));

    expect(outcomes).toEqual([
      { emailAddress: "grace@example.com", invitation: expect.objectContaining({ emailAddress: "grace@example.com", invitedBy: "Ada Lovelace", delivery: "sent" }) as unknown, link: null },
      { emailAddress: "Hal@Example.com", invitation: expect.objectContaining({ emailAddress: "Hal@Example.com", invitedBy: "Ada Lovelace", delivery: "sent" }) as unknown, link: null },
    ]);
    for (const outcome of outcomes) {
      const { invitation } = outcome as { invitation: EmailInvitation };
      expect(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt)).toBe(7 * DAY_MS);
      expect(Math.abs(Date.parse(invitation.createdAt) - Date.now())).toBeLessThan(60_000);
    }

    expect(sent).toHaveLength(2);
    const [toGrace, toHal] = sent;
    expect(toGrace).toEqual({
      from: { name: "Ember", email: "ember@example.com" },
      to: "grace@example.com",
      subject: "Ada Lovelace invited you to Ember",
      text: `Ada Lovelace invited you to join Ember.\n\nJoin here: ${linkIn(toGrace!)}\n\nThe link works once, for 7 days, and joins with grace@example.com. If you weren't expecting this, you can ignore it.\n`,
      html: expect.stringContaining(`<a href="${linkIn(toGrace!)}">Join Ember</a>`) as unknown,
    });
    expect(linkIn(toGrace!)).toMatch(new RegExp(`^${origin}/join/invitation#token=[\\w-]{43}$`));
    expect(toHal).toMatchObject({ to: "Hal@Example.com", subject: "Ada Lovelace invited you to Ember" });
    expect(linkIn(toHal!)).not.toBe(linkIn(toGrace!));

    // Each link works for its own address, and only its digest is kept.
    const tokens = sent.map((email) => tokenIn(linkIn(email)));
    for (const [token, emailAddress] of [[tokens[0], "grace@example.com"], [tokens[1], "Hal@Example.com"]]) {
      const response = await lookUp(token);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ kind: "invitation", emailAddress });
    }
    const kept = JSON.stringify(await workspaceSql("SELECT * FROM email_links"));
    for (const token of tokens) expect(kept).not.toContain(token!);
  });

  it("lists the invitations no one has accepted, newest first, for administrators alone", async () => {
    const administrator = await setUp();
    const first = await inviteOne(administrator, "grace@example.com");
    const second = await inviteOne(administrator, "hal@example.com");
    expect(await invitations(administrator)).toEqual([second.invitation, first.invitation]);
    expect(first.invitation).toEqual({ id: expect.any(String), emailAddress: "grace@example.com", invitedBy: "Ada Lovelace", createdAt: expect.any(String), expiresAt: expect.any(String), delivery: null });

    const guest = await signIn("Linus");
    expect(await invitations(guest)).toEqual([]);
  });

  it("answers each link it didn't email, for the administrator to send, while Ember has no From address or can't send email", async () => {
    const administrator = await setUp();
    const { link } = await inviteOne(administrator, "grace@example.com");
    expect(link).toMatch(new RegExp(`^${origin}/join/invitation#token=[\\w-]{43}$`));
    expect(await (await lookUp(tokenIn(link))).json()).toEqual({ kind: "invitation", emailAddress: "grace@example.com" });

    await saveFrom(administrator, "ember@example.com");
    await withWorkspaceEnv({ EMAIL: undefined }, async () => {
      const unsent = await inviteOne(administrator, "hal@example.com");
      expect(unsent.invitation.delivery).toBeNull();
      expect((await lookUp(tokenIn(unsent.link))).status).toBe(200);
    });
  });

  it("puts the links at Ember's custom domain, while it has one", async () => {
    const administrator = await setUp();
    await workspaceSql("UPDATE accounts SET name = ?, settings = json_set(settings, '$.custom_domain', ?)", "Grace's <b>lab</b>", "chat.example.com");
    await evictDurableObject(workspaceStub());
    const { link } = await inviteOne(administrator, "hal@example.com");
    expect(link).toMatch(/^https:\/\/chat\.example\.com\/join\/invitation#token=[\w-]{43}$/);

    await saveFrom(administrator, "chat@example.com");
    const { binding, sent } = fakeBinding();
    await withWorkspaceEnv({ EMAIL: binding }, async () => void (await inviteOne(administrator, "grace@example.com")));
    expect(sent[0]!.subject).toBe("Ada Lovelace invited you to Grace's <b>lab</b>");
    expect(linkIn(sent[0]!)).toMatch(/^https:\/\/chat\.example\.com\/join\/invitation#token=/);
    expect(sent[0]!.html).toContain("Ada Lovelace invited you to join Grace&#39;s &lt;b&gt;lab&lt;/b&gt;.");
  });

  it("invites no address someone has an account with, whatever its case, and each address once", async () => {
    const administrator = await setUp();
    await joinAsGrace();
    const outcomes = await invited(administrator, "Grace@Example.com", "ADA@example.com", "hal@example.com", "HAL@example.com");
    expect(outcomes).toEqual([
      { emailAddress: "Grace@Example.com", member: true },
      { emailAddress: "ADA@example.com", member: true },
      { emailAddress: "hal@example.com", invitation: expect.objectContaining({ emailAddress: "hal@example.com" }) as unknown, link: expect.any(String) as unknown },
    ]);
    expect((await invitations(administrator)).map((invitation) => invitation.emailAddress)).toEqual(["hal@example.com"]);
  });

  it("gives an address invited again a new link in place of its old one, keeping the address as given last", async () => {
    const administrator = await setUp();
    const first = await inviteOne(administrator, "hal@example.com");
    const again = await inviteOne(administrator, "Hal@example.com");
    expect(again.invitation).toMatchObject({ id: first.invitation.id, emailAddress: "Hal@example.com" });
    expect(again.link).not.toBe(first.link);
    await expectGone(await lookUp(tokenIn(first.link)), EMAIL_LINK_GONE);
    expect(await (await lookUp(tokenIn(again.link))).json()).toEqual({ kind: "invitation", emailAddress: "Hal@example.com" });
    expect(await count("email_links")).toBe(1);
  });

  it("refuses anyone but an administrator, before what they sent, and a list that isn't 1 to 20 email addresses", async () => {
    const administrator = await setUp();
    const guest = await signIn("Linus");
    expect((await invite(null, ["hal@example.com"])).status).toBe(401);
    for (const emailAddresses of [["hal@example.com"], "not a list"]) {
      const response = await invite(guest, emailAddresses);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Only administrators can invite people" });
    }

    const tooMany = Array.from({ length: INVITATIONS_AT_ONCE + 1 }, (_, n) => `person${n}@example.com`);
    for (const [emailAddresses, error] of [
      [[], NO_EMAIL_ADDRESSES],
      ["hal@example.com", NO_EMAIL_ADDRESSES],
      [undefined, NO_EMAIL_ADDRESSES],
      [["hal@example.com", "hal"], NOT_AN_EMAIL_ADDRESS],
      [["Hal <hal@example.com>"], NOT_AN_EMAIL_ADDRESS],
      [[42], NOT_AN_EMAIL_ADDRESS],
      [[`${"h".repeat(250)}@example.com`], NOT_AN_EMAIL_ADDRESS],
      [tooMany, "Invite at most 20 email addresses at once"],
    ] as const) {
      const response = await invite(administrator, emailAddresses);
      expect(response.status, JSON.stringify(emailAddresses)).toBe(422);
      expect(await response.json()).toEqual({ error });
    }
    expect((await invited(administrator, ...tooMany.slice(1))).length).toBe(INVITATIONS_AT_ONCE);
    expect(await count("email_links")).toBe(INVITATIONS_AT_ONCE);
  });

  it("says why the provider didn't send each invitation it refused, answering its link, and lists why", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "chat@example.com");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const suppressed = Object.assign(new Error("Email Service refused it"), { code: "E_RECIPIENT_SUPPRESSED" });
    const { binding, sent } = fakeBinding((to) => (to === "hal@example.com" ? suppressed : undefined));
    let outcomes: InvitationOutcome[] = [];
    await withWorkspaceEnv({ EMAIL: binding }, async () => void (outcomes = await invited(administrator, "grace@example.com", "hal@example.com")));
    expect(sent.map((email) => email.to)).toEqual(["grace@example.com", "hal@example.com"]);

    const refusal = "Cloudflare won't send to that address, since email to it bounced or was marked as spam before.";
    const [toGrace, toHal] = outcomes as Array<{ invitation: EmailInvitation; link: string | null }>;
    expect(toGrace).toMatchObject({ invitation: { delivery: "sent" }, link: null });
    expect(toHal).toMatchObject({ invitation: { delivery: { refusal } } });
    expect(toHal!.link).toBe(linkIn(sent[1]!));
    // Newest first, and of one request, last first.
    expect((await invitations(administrator)).map((invitation) => invitation.delivery)).toEqual([{ refusal }, "sent"]);
  });

  it("sends a request's invitations to Resend in one batch, which it takes or refuses whole", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "Acme, Inc. <chat@acme.example>");
    const requests = fakeResend();
    await withWorkspaceEnv({ RESEND_API_KEY: RESEND_KEY }, async () => {
      const outcomes = await invited(administrator, "grace@example.com", "hal@example.com", "linus@example.com");
      expect(outcomes.map((outcome) => "invitation" in outcome && outcome.invitation.delivery)).toEqual(["sent", "sent", "sent"]);
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.resend.com/emails/batch");
    expect(requests[0]!.headers.get("Authorization")).toBe(`Bearer ${RESEND_KEY}`);
    expect(requests[0]!.body).toEqual(
      ["grace@example.com", "hal@example.com", "linus@example.com"].map((to) => ({
        from: '"Acme, Inc." <chat@acme.example>',
        to: [to],
        subject: "Ada Lovelace invited you to Ember",
        text: expect.stringContaining(`and joins with ${to}.`) as unknown,
        html: expect.stringContaining("Join Ember</a>") as unknown,
      })),
    );

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const unverified = "The acme.example domain is not verified. Please, add and verify your domain on https://resend.com/domains";
    vi.mocked(fetch).mockImplementation(async () => Response.json({ name: "validation_error", message: unverified }, { status: 403 }));
    await withWorkspaceEnv({ RESEND_API_KEY: RESEND_KEY }, async () => {
      const outcomes = (await invited(administrator, "ann@example.com", "bob@example.com")) as Array<{ invitation: EmailInvitation; link: string | null }>;
      for (const { invitation, link } of outcomes) {
        expect(invitation.delivery).toEqual({ refusal: `Resend refused it: ${unverified}` });
        expect((await lookUp(tokenIn(link))).status).toBe(200);
      }
    });
    expect(logged).toHaveBeenCalledWith("Resend didn't send 2 emails:", 403, "validation_error");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("example.com");
  });
});

describe("Invite people by email", () => {
  describe("sending again", () => {
    it("gives an invitation a new link, which only it joins with, answering it while Ember didn't email it", async () => {
      const administrator = await setUp();
      const first = await inviteOne(administrator, "hal@example.com");
      const response = await resend(administrator, first.invitation.id);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const again = (await response.json()) as ResentInvitation;
      expect(again.invitation).toMatchObject({ id: first.invitation.id, emailAddress: "hal@example.com", invitedBy: "Ada Lovelace", delivery: null });
      expect(Date.parse(again.invitation.expiresAt) - Date.parse(again.invitation.createdAt)).toBe(7 * DAY_MS);
      await expectGone(await lookUp(tokenIn(first.link)), EMAIL_LINK_GONE);
      expect((await lookUp(tokenIn(again.link))).status).toBe(200);
      expect(await invitations(administrator)).toEqual([again.invitation]);
    });

    it("emails the new link while Ember can send email", async () => {
      const administrator = await setUp();
      const { invitation, link } = await inviteOne(administrator, "hal@example.com");
      await saveFrom(administrator, "chat@example.com");
      const { binding, sent } = fakeBinding();
      await withWorkspaceEnv({ EMAIL: binding }, async () => {
        const response = await resend(administrator, invitation.id);
        expect(await response.json()).toEqual({ invitation: expect.objectContaining({ id: invitation.id, delivery: "sent" }) as unknown, link: null });
      });
      expect(sent.map((email) => email.to)).toEqual(["hal@example.com"]);
      expect(linkIn(sent[0]!)).not.toBe(link);
      expect((await lookUp(tokenIn(linkIn(sent[0]!)))).status).toBe(200);
      expect((await invitations(administrator))[0]!.delivery).toBe("sent");
    });

    it("refuses anyone but an administrator, and an invitation that's gone", async () => {
      const administrator = await setUp();
      const { invitation } = await inviteOne(administrator, "hal@example.com");
      expect((await resend(null, invitation.id)).status).toBe(401);
      expect((await resend(await signIn("Linus"), invitation.id)).status).toBe(403);
      expect((await revoke(administrator, invitation.id)).status).toBe(204);
      expect((await resend(administrator, invitation.id)).status).toBe(404);
      expect((await resend(administrator, "nothing")).status).toBe(404);
      expect(await count("email_links")).toBe(0);
    });
  });

  describe("revoking", () => {
    it("takes an invitation away, after which its link joins no one", async () => {
      const administrator = await setUp();
      const { invitation, link } = await inviteOne(administrator, "hal@example.com");
      expect((await revoke(null, invitation.id)).status).toBe(401);
      expect((await revoke(await signIn("Linus"), invitation.id)).status).toBe(403);
      expect((await lookUp(tokenIn(link))).status).toBe(200);

      const response = await revoke(administrator, invitation.id);
      expect(response.status).toBe(204);
      expect(await invitations(administrator)).toEqual([]);
      await expectGone(await lookUp(tokenIn(link)), EMAIL_LINK_GONE);
      await expectGone(await joinWith(tokenIn(link)));
      expect((await revoke(administrator, invitation.id)).status).toBe(404);
    });
  });
});

describe("Join with an invitation", () => {
  describe("the page", () => {
    /** The page as the browser asks for it, with the built app standing in, without following a redirect. */
    const page = (init: RequestInit<IncomingRequestCfProperties> = {}) => apiWith({ ASSETS: builtPages }, "/join/invitation", { redirect: "manual", ...init });

    it("is the app's, for anyone, which no cache keeps, since a redirect would carry the link's secret along", async () => {
      const administrator = await setUp();
      for (const session of [null, administrator]) {
        const response = await page({ headers: as(session) });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("page /");
        expect(response.headers.get("Cache-Control")).toBe("no-store");
      }
      expect((await page({ method: "HEAD" })).status).toBe(200);
      expect((await page({ method: "POST" })).status).toBe(404);
    });
  });

  describe("looking up a link", () => {
    it("says whom it's for, as often as it's asked, spending nothing", async () => {
      const administrator = await setUp();
      const { link } = await inviteOne(administrator, "hal@example.com");
      for (let n = 0; n < 3; n++) {
        const response = await lookUp(tokenIn(link));
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("no-store");
        expect(await response.json()).toEqual({ kind: "invitation", emailAddress: "hal@example.com" });
      }
      expect((await joinWith(tokenIn(link))).status).toBe(201);
    });

    it("says a link doesn't work when nothing's invited with it, it isn't one, or it has expired", async () => {
      const administrator = await setUp();
      const { link } = await inviteOne(administrator, "hal@example.com");
      for (const token of ["A".repeat(43), "short", 42, null, `${tokenIn(link)}x`]) await expectGone(await lookUp(token), EMAIL_LINK_GONE);
      await expectGone(await api("/api/email_links/lookup", { method: "POST", body: "not JSON" }), EMAIL_LINK_GONE);

      await workspaceSql("UPDATE email_links SET expires_at = ?", new Date(Date.now() - 1000).toISOString());
      await expectGone(await lookUp(tokenIn(link)), EMAIL_LINK_GONE);
      await expectGone(await joinWith(tokenIn(link)));
      expect(await count("users")).toBe(1);
    });
  });

  describe("joining", () => {
    it("adds a member with the address the invitation was sent to, in every open room, signed in, spending the link", async () => {
      const administrator = await setUp();
      const [design, leads] = [await createRoom("Design", { as: administrator }), await createRoom("Leads", { as: administrator, closedTo: [administrator.user.id] })];
      const { link } = await inviteOne(administrator, "Hal@Example.com");

      const response = await joinWith(tokenIn(link), { ...hal, emailAddress: "someone@else.example" });
      expect(response.status).toBe(201);
      const { user } = (await response.json()) as { user: Me };
      expect(user).toEqual({ id: expect.any(String), name: "Hal", administrator: false });
      expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^__Host-session_token=[\w-]{43}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$/)]);

      const [member] = (await workspaceSql("SELECT name, email_address, password_digest, invited_by, role, status FROM users WHERE id = ?", user.id)) as Array<Record<string, unknown>>;
      expect(member).toMatchObject({ name: "Hal", email_address: "Hal@Example.com", invited_by: administrator.user.id, role: 0, status: 0 });
      expect(await verifyPassword(hal.password, member!.password_digest as string)).toBe(true);
      expect(await workspaceSql("SELECT ip_address, user_agent FROM sessions WHERE user_id = ?", user.id)).toEqual([{ ip_address: "203.0.113.30", user_agent: "Hal's laptop" }]);

      const cookie = cookieOf(response);
      expect(await (await api("/api/me", { headers: { Cookie: cookie } })).json()).toEqual({ user });
      const { rooms } = (await (await api("/api/sidebar", { headers: { Cookie: cookie } })).json()) as Sidebar;
      expect(rooms.map((room) => room.id)).toContain(administrator.general.id);
      expect(rooms.map((room) => room.id)).toContain(design.id);
      expect(rooms.map((room) => room.id)).not.toContain(leads.id);

      expect(await invitations(administrator)).toEqual([]);
      await expectGone(await lookUp(tokenIn(link)), EMAIL_LINK_GONE);
      await expectGone(await joinWith(tokenIn(link), { name: "Someone else", password: "another password" }));
      expect(await count("users")).toBe(2);
    });

    it("adds one person when the same link joins twice at once", async () => {
      const administrator = await setUp();
      const { link } = await inviteOne(administrator, "hal@example.com");
      const answers = await Promise.all([joinWith(tokenIn(link)), joinWith(tokenIn(link), { name: "Hal 2", password: "heuristically" })]);
      expect(answers.map((response) => response.status).sort()).toEqual([201, 404]);
      expect(await count("users")).toBe(2);
    });

    it("keeps the link when the form is refused for something the person can fix", async () => {
      const administrator = await setUp();
      const { link } = await inviteOne(administrator, "hal@example.com");
      const short = await joinWith(tokenIn(link), { name: "Hal", password: "short" });
      expect(short.status).toBe(422);
      expect(await short.json()).toMatchObject({ error: PASSWORD_TOO_SHORT });
      const nameless = await joinWith(tokenIn(link), { name: " ", password: "heuristically" });
      expect(nameless.status).toBe(400);
      expect(await nameless.json()).toMatchObject({ error: "Name and password are required" });
      expect((await lookUp(tokenIn(link))).status).toBe(200);
      expect((await joinWith(tokenIn(link))).status).toBe(201);
    });

    it("sends someone with an account since to sign in with its address, keeping the link, and someone signed in home", async () => {
      const administrator = await setUp();
      const { link } = await inviteOne(administrator, "hal@example.com");
      const guest = await signIn("Linus");
      // As if Linus had given his profile the address since.
      await workspaceSql("UPDATE users SET email_address = ? WHERE id = ?", "HAL@example.com", guest.user.id);
      const taken = await joinWith(tokenIn(link));
      expect(taken.status).toBe(409);
      expect(await taken.json()).toEqual({ error: "That email address has an account already", redirect: "/session/new?email_address=hal%40example.com" });
      expect((await lookUp(tokenIn(link))).status).toBe(200);

      const signedIn = await joinWith(tokenIn(link), hal, administrator);
      expect(signedIn.status).toBe(409);
      expect(await signedIn.json()).toEqual({ error: "You're signed in already", redirect: "/" });
      expect(await count("users")).toBe(2);
    });

    it("works whichever ways to join are on, with every one off, or Memberful members only", async () => {
      const administrator = await setUp();
      await turn(administrator, { joinLink: false });
      const { link } = await inviteOne(administrator, "hal@example.com");
      expect((await joinWith(tokenIn(link))).status).toBe(201);

      await turn(administrator, { memberfulJoin: true, memberfulSignIn: true });
      const linus = await inviteOne(administrator, "linus@example.com");
      expect((await lookUp(tokenIn(linus.link))).status).toBe(200);
      expect((await joinWith(tokenIn(linus.link), { name: "Linus", password: "a long enough password" })).status).toBe(201);
    });

    it("lets the people who joined with an invitation sign in with their password while Memberful is members only", async () => {
      const administrator = await setUp();
      await joinAsGrace();
      const { link } = await inviteOne(administrator, "hal@example.com");
      expect((await joinWith(tokenIn(link))).status).toBe(201);
      await turn(administrator, { memberfulJoin: true, memberfulSignIn: true });

      const signedIn = await signInWithPassword("hal@example.com", hal.password);
      expect(signedIn.status).toBe(201);
      const member = await signInWithPassword(grace.emailAddress, grace.password);
      expect(member.status).toBe(403);
      expect(await member.json()).toEqual({ error: MEMBERFUL_SIGN_IN_NEEDED });

      // Their profile offers Memberful as another way to sign in, rather than one they need.
      const answer = await apiWith(MEMBERFUL_KEYS, "/api/users/me/profile", { headers: { Cookie: cookieOf(signedIn) } });
      expect(((await answer.json()) as ProfileAnswer).profile).toMatchObject({ membershipNeeded: false, memberful: { membersOnly: true, connected: null } });
    });

    it("takes the invitation to an address off the list when someone joins with it another way, whatever its case", async () => {
      const administrator = await setUp();
      const { link } = await inviteOne(administrator, "Grace@Example.com");
      await inviteOne(administrator, "hal@example.com");
      await joinAsGrace();
      expect((await invitations(administrator)).map((invitation) => invitation.emailAddress)).toEqual(["hal@example.com"]);
      await expectGone(await lookUp(tokenIn(link)), EMAIL_LINK_GONE);
    });
  });
});
