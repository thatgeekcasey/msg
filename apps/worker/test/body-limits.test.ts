import { MAX_CUSTOM_STYLES_LENGTH, type BotAnswer, type NewWorkspace, type RoomId, type UserId } from "@ember/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { BODY_TOO_LARGE, MAX_JSON_BODY_BYTES } from "../src/bodies";
import { RECOVERY_PATH } from "../src/recovery";
import { api, apiWith, cookieOf, createRoom, freshDeploy, shown, workspaceSql, type Session } from "./support";

// Every route that reads JSON reads no more than 1 MiB of it, however large a body Cloudflare lets
// through.

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };
const RECOVERY_TOKEN = "0123456789abcdef".repeat(4);

/** How much of a body arrives at a time. */
const CHUNK = 64 * 1024;

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

/** A route that reads a JSON body: its method, its address, and the headers that get a request as far as its body. */
type Route = [method: string, path: string, headers: Record<string, string>];

/** The route's method and address, which say which one failed. */
const labelOf = ([method, path]: Route) => `${method} ${path}`;

/** Setting Ember up, which reads its form only before it's set up. */
const FIRST_RUN: Route = ["POST", "/api/first_run", {}];

/** What the other routes need once Ember is set up, with Open and Email domain on: Ada, signed in as its administrator, a bot and a room, and the join code. */
interface Ember {
  ada: Session;
  bot: UserId;
  room: RoomId;
  joinCode: string;
}

/**
 * Sets Ember up, with a bot and a room, letting anyone sign up, and people at an email domain ask for a
 * link, so that open sign-up's form and Email domain's are read.
 */
async function setUpEmber(): Promise<Ember> {
  const ada = await setUp();
  const opened = await api("/api/account", {
    method: "PATCH",
    headers: { Cookie: ada.cookie },
    body: JSON.stringify({ emailFrom: "ember@example.com", emailDomains: ["example.org"], settings: { openSignUp: true, emailDomainSignUp: true } }),
  });
  expect(opened.status).toBe(200);
  const added = await api("/api/account/bots", { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify({ name: "Deploys" }) });
  expect(added.status).toBe(201);
  const { id: bot } = ((await added.json()) as BotAnswer).bot;
  const { id: room } = await createRoom("Limits", { as: ada });
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  return { ada, bot, room, joinCode };
}

/** Every other route that reads a JSON body, as someone who gets as far as reading it sends it. */
function jsonRoutes({ ada, bot, room, joinCode }: Ember): Route[] {
  const signedIn = { Cookie: ada.cookie };
  return [
    ["POST", "/api/session", {}],
    ["DELETE", "/api/session", signedIn],
    ["POST", "/api/session/transfers", {}],
    ["PATCH", "/api/account", signedIn],
    ["PATCH", "/api/account/custom_styles", signedIn],
    ["PUT", "/api/account/resend_api_key", signedIn],
    ["PUT", "/api/account/turnstile_keys", signedIn],
    ["PUT", "/api/account/room_order", signedIn],
    ["PATCH", `/api/account/users/${ada.user.id}`, signedIn],
    ["POST", "/api/account/bots", signedIn],
    ["PATCH", `/api/account/bots/${bot}`, signedIn],
    ["PUT", "/api/sidebar/order", signedIn],
    ["PATCH", "/api/users/me/profile", signedIn],
    ["POST", "/api/rooms", signedIn],
    ["PATCH", `/api/rooms/${room}`, signedIn],
    ["PUT", `/api/rooms/${room}/favorite`, signedIn],
    ["PUT", `/api/rooms/${room}/involvement`, signedIn],
    ["POST", `/api/rooms/${room}/uploads`, signedIn],
    ["POST", "/api/directs", signedIn],
    // Only someone signed out can join, or sign up while anyone may.
    ["POST", `/api/join/${joinCode}`, {}],
    ["POST", "/api/join", {}],
    ["POST", "/api/join/invitation", {}],
    ["POST", "/api/join/email", {}],
    ["POST", "/api/email_links", {}],
    ["POST", "/api/email_links/lookup", {}],
    ["POST", "/api/password_resets", {}],
    ["PUT", "/api/password_resets", {}],
    ["POST", "/api/invitations", signedIn],
    ["POST", "/api/unfurl", signedIn],
    ["POST", "/api/searches", signedIn],
    ["POST", "/api/push-subscriptions", signedIn],
    ["POST", RECOVERY_PATH, { Authorization: `Bearer ${RECOVERY_TOKEN}` }],
  ];
}

/**
 * `text` sent to `route` as JSON from the app's own pages, to a Worker that has a recovery token, with
 * `length` as its Content-Length if given. Its bytes arrive `CHUNK` at a time, each only once the Worker
 * reads for it; with no text, they're spaces that never end. Answers how the route answered, and how
 * many bytes of the body it read.
 */
async function sendArriving(route: Route, text?: string, length?: number) {
  const [method, path, headers] = route;
  const bytes = text === undefined ? null : new TextEncoder().encode(text);
  let read = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = bytes ? bytes.subarray(read, read + CHUNK) : new Uint8Array(CHUNK).fill(0x20);
        if (chunk.length === 0) return controller.close();
        read += chunk.length;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  const response = await apiWith({ EMBER_RECOVERY_TOKEN: RECOVERY_TOKEN }, path, {
    method,
    headers: { "Content-Type": "application/json", ...headers, ...(length === undefined ? {} : { "Content-Length": String(length) }) },
    body,
  });
  return { status: response.status, answer: await response.json(), read };
}

const TOO_LARGE = { status: 413, answer: { error: BODY_TOO_LARGE } };

const sessionCount = async () => ((await workspaceSql("SELECT count(*) AS n FROM sessions")) as Array<{ n: number }>)[0]!.n;

/** Whether `session` is still signed in. */
const stillSignedIn = async (session: Session) => (await api("/api/me", { headers: { Cookie: session.cookie } })).status === 200;

beforeEach(freshDeploy);

describe("Request and connection limits", () => {
  it("refuses a body whose Content-Length is over 1 MiB on every route that reads JSON, before reading any of it", async () => {
    const tooLong = " ".repeat(MAX_JSON_BODY_BYTES + 1);
    expect(await sendArriving(FIRST_RUN, tooLong, tooLong.length)).toEqual({ ...TOO_LARGE, read: 0 });

    const ember = await setUpEmber();
    for (const route of jsonRoutes(ember)) expect(await sendArriving(route, tooLong, tooLong.length), labelOf(route)).toEqual({ ...TOO_LARGE, read: 0 });
    // Nobody signed in, joined or signed out.
    expect(await sessionCount()).toBe(1);
    expect(await stillSignedIn(ember.ada)).toBe(true);
  });

  it("reads a body sent without its length no further than 1 MiB on every route that reads JSON", async () => {
    const setUpSent = await sendArriving(FIRST_RUN);
    expect(setUpSent).toMatchObject(TOO_LARGE);
    expect(setUpSent.read).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES + CHUNK);

    const ember = await setUpEmber();
    for (const route of jsonRoutes(ember)) {
      const sent = await sendArriving(route);
      expect(sent, labelOf(route)).toMatchObject(TOO_LARGE);
      expect(sent.read, labelOf(route)).toBeLessThanOrEqual(MAX_JSON_BODY_BYTES + CHUNK);
    }
    expect(await sessionCount()).toBe(1);
    expect(await stillSignedIn(ember.ada)).toBe(true);
  });

  it("reads a body of 1 MiB, with or without its length, and refuses one a byte longer", async () => {
    await setUp();
    const signIn: Route = ["POST", "/api/session", {}];
    // JSON may end in as many spaces as it likes.
    const padded = (length: number) => JSON.stringify({ emailAddress: ada.emailAddress, password: ada.password }).padEnd(length, " ");
    for (const withLength of [false, true]) {
      const label = withLength ? "with its length" : "without its length";
      const sent = (length: number) => sendArriving(signIn, padded(length), withLength ? length : undefined);
      expect((await sent(MAX_JSON_BODY_BYTES)).status, label).toBe(201);
      expect(await sent(MAX_JSON_BODY_BYTES + 1), label).toMatchObject(TOO_LARGE);
    }
    expect(await sessionCount()).toBe(3);
  });

  it("takes the largest body the app sends: custom CSS as long as it can be, of the characters JSON writes longest", async () => {
    const administrator = await setUp();
    // Each is `\u0001` in JSON, so the body is some 600 KB.
    const longest = "\u0001".repeat(MAX_CUSTOM_STYLES_LENGTH);
    const response = await api("/api/account/custom_styles", { method: "PATCH", headers: { Cookie: administrator.cookie }, body: JSON.stringify({ customStyles: longest }) });
    expect(response.status).toBe(200);
    expect(await workspaceSql("SELECT custom_styles FROM accounts")).toEqual([{ custom_styles: longest }]);
  });
});
