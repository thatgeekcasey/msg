import {
  CANT_SEND_EMAIL,
  EMAIL_FROM_REFUSED,
  RESEND_API_KEY_REFUSED,
  SENDING_DOMAIN_REFUSED,
  type EmailSettings,
  type NewWorkspace,
  type WorkspaceSettings,
} from "@ember/protocol";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { api, cookieOf, freshDeploy, openWorkspaceSocket, shown, signIn, withWorkspaceEnv, workspaceSql, workspaceStub, type Session } from "./support";

const ada = { name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" };

/** A Resend API key, as the deployment's secret holds one. */
const RESEND_KEY = "re_test_only_not_a_key";

/** Sets Ember up with Ada as its administrator, signed in. */
async function setUp(): Promise<Session> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify(ada) });
  expect(response.status).toBe(201);
  return { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
}

const as = (session?: Session | null): Record<string, string> => (session ? { Cookie: session.cookie } : {});

const emailSettings = async (session: Session) => ((await (await api("/api/account", { headers: as(session) })).json()) as WorkspaceSettings).email;

/** Gives the workspace the From address `emailFrom` as `session`, as the Email card's Save does. */
const giveFrom = (session: Session | null, emailFrom: unknown) => api("/api/account", { method: "PATCH", headers: as(session), body: JSON.stringify({ emailFrom }) });

/** Gives the workspace the From address `emailFrom` as `administrator`, which has to work. */
async function saveFrom(administrator: Session, emailFrom: string): Promise<void> {
  const response = await giveFrom(administrator, emailFrom);
  expect(response.status, await response.clone().text()).toBe(200);
}

/** The account's settings, as the database keeps them. */
const storedSettings = async () => JSON.parse(((await workspaceSql("SELECT settings FROM accounts")) as Array<{ settings: string }>)[0]!.settings) as Record<string, unknown>;

const storedFrom = async () => (await storedSettings()).email_from;

const sendTest = (session?: Session | null) => api("/api/account/test_email", { method: "POST", headers: as(session) });

/** Stands in for Cloudflare Email Service's binding, keeping what it's asked to send, and throwing `refusal` if given. */
function fakeBinding(refusal?: unknown) {
  const sent: EmailMessageBuilder[] = [];
  const binding = {
    send: async (message: EmailMessageBuilder) => {
      sent.push(message);
      if (refusal !== undefined) throw refusal;
      return { messageId: `<${crypto.randomUUID()}@example.com>` };
    },
  } as unknown as SendEmail;
  return { binding, sent };
}

/** An error as Cloudflare Email Service's binding throws one, with `code`. */
const thrownWith = (code: string) => Object.assign(new Error(`Email Service refused it: ${code}`), { code });

/** A request the fake Resend was sent. */
interface SentToResend {
  url: string;
  method: string;
  headers: Headers;
  redirect: string;
  body: unknown;
}

/** Stands in for Resend's API, answering `answer` to each request, by its address, and keeping what it's sent. */
function fakeResend(answer: (url: string) => Response | Promise<Response> = () => Response.json({ id: crypto.randomUUID() })) {
  const requests: SentToResend[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, method: request.method, headers: request.headers, redirect: request.redirect, body: request.body && (await request.json()) });
    return answer(request.url);
  });
  return requests;
}

/** What Resend answers when a key that can only send asks to list its domains, which says Resend knows the key. */
const sendingOnly = () => Response.json({ statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails" }, { status: 401 });

/** Stands in for Resend's API as a key that can only send has it: refused the domains, but sending. */
const fakeSendingKey = () => fakeResend((url) => (url.endsWith("/domains") ? sendingOnly() : Response.json({ id: crypto.randomUUID() })));

/** Gives Ember the Resend API key `apiKey` as `session`, as Set up email does. */
const giveResendKey = (session: Session | null, apiKey: unknown) => api("/api/account/resend_api_key", { method: "PUT", headers: as(session), body: JSON.stringify({ apiKey }) });

/** Takes Ember's Resend API key away as `session`, as Set up email does when Cloudflare Email Service is chosen. */
const forgetResendKey = (session: Session | null) => api("/api/account/resend_api_key", { method: "DELETE", headers: as(session) });

/** How a workspace sends email from `from` with the Resend API key an administrator gave it. */
const withSavedKey = (from: string | null): EmailSettings => ({ provider: "resend", resendKey: "saved", cloudflare: true, from });

/** Asks, as `session`, whether `domain` is onboarded to Cloudflare Email Sending, as Set up email's From step does. */
const checkDomain = (session: Session | null, domain: unknown) =>
  api("/api/account/sending_domain_checks", { method: "POST", headers: as(session), body: JSON.stringify({ domain }) });

/** A record as Cloudflare's DNS over HTTPS answers one: its type's number, and its data. */
interface DnsRecord {
  type: number;
  data: string;
}

/** An MX record naming `host`. */
const mx = (host: string): DnsRecord => ({ type: 15, data: `10 ${host}` });
/** A TXT record of `strings`, quoted, as DNS over HTTPS writes them. */
const txt = (...strings: string[]): DnsRecord => ({ type: 16, data: strings.map((text) => `"${text}"`).join(" ") });
/** A DKIM key, as Onboard Domain publishes it, in two strings, since it's longer than one can be. */
const DKIM_KEY = txt("v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA", "iweykoi+o48IOGuP7GR3X0MOExCUDY/BCRHoWBnh3rCh");
/** The records Onboard Domain adds to a domain, by name and type, on its `cf-bounce` subdomain. */
const onboarded = (domain: string): Record<string, DnsRecord[]> => ({
  [`cf-bounce.${domain} MX`]: ["route1.mx.cloudflare.net.", "route2.mx.cloudflare.net.", "route3.mx.cloudflare.net."].map(mx),
  [`cf-bounce.${domain} TXT`]: [txt("v=spf1 include:_spf.mx.cloudflare.net ~all")],
  [`cf-bounce._domainkey.${domain} TXT`]: [DKIM_KEY],
});

/**
 * Stands in for Cloudflare's DNS over HTTPS, answering the records `records` has for a name and type,
 * and that a name it has none for doesn't exist, keeping each request as its address and Accept header.
 */
function fakeResolver(records: Record<string, DnsRecord[]>) {
  const asked: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    asked.push(`${request.url} ${request.headers.get("Accept")}`);
    const { searchParams } = new URL(request.url);
    const answer = records[`${searchParams.get("name")} ${searchParams.get("type")}`];
    return Response.json(answer ? { Status: 0, Answer: answer } : { Status: 3 });
  });
  return asked;
}

/** The answer to a test email that wasn't sent: `status` and the `error` that says why. */
async function expectRefused(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
}

beforeEach(freshDeploy);
afterEach(() => vi.restoreAllMocks());

describe("Sending email", () => {
  it("says what Ember sends email with: Resend while there's an API key, else Cloudflare Email Service's binding", async () => {
    const administrator = await setUp();
    expect(await emailSettings(administrator)).toEqual({ provider: "cloudflare", resendKey: null, cloudflare: true, from: null });
    await withWorkspaceEnv({ RESEND_API_KEY: RESEND_KEY }, async () =>
      expect(await emailSettings(administrator)).toEqual({ provider: "resend", resendKey: "secret", cloudflare: true, from: null }),
    );
    await withWorkspaceEnv({ EMAIL: undefined }, async () =>
      expect(await emailSettings(administrator)).toEqual({ provider: null, resendKey: null, cloudflare: false, from: null }),
    );
    await withWorkspaceEnv({ EMAIL: undefined, RESEND_API_KEY: "  " }, async () => expect((await emailSettings(administrator)).provider).toBeNull());
  });

  it("keeps the From address an administrator gives, as an address is written, and takes it away", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "  Ember   <ember@example.com> ");
    expect(await storedFrom()).toBe("Ember <ember@example.com>");
    expect(await emailSettings(administrator)).toEqual({ provider: "cloudflare", resendKey: null, cloudflare: true, from: "Ember <ember@example.com>" });
    const member = await signIn("Grace");
    expect((await emailSettings(member)).from).toBe("Ember <ember@example.com>");

    await saveFrom(administrator, "Acme, Inc. <chat@acme.example>");
    expect((await emailSettings(administrator)).from).toBe('"Acme, Inc." <chat@acme.example>');

    const cleared = await giveFrom(administrator, null);
    expect(cleared.status).toBe(200);
    expect(await storedFrom()).toBeNull();
    expect((await emailSettings(administrator)).from).toBeNull();
  });

  it("tells nobody's pages of a new From address, which they don't show", async () => {
    const administrator = await setUp();
    const grace = await signIn("Grace");
    const sockets = [await openWorkspaceSocket(administrator), await openWorkspaceSocket(grace)];
    await saveFrom(administrator, "chat@example.com");
    expect(await (await api("/api/account", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ emailFrom: null, tagline: "Chat" }) })).json()).toMatchObject({ account: { tagline: "Chat" } });
    for (const socket of sockets) expect(await socket.next()).toMatchObject({ type: "account.updated", account: { tagline: "Chat" } });
    expect(await storedFrom()).toBeNull();
  });

  it("refuses a From address that isn't one, and anyone but an administrator", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "ember@example.com");
    for (const emailFrom of ["Ember", "ember@", "Ember <ember@example.com", 42]) await expectRefused(await giveFrom(administrator, emailFrom), 422, EMAIL_FROM_REFUSED);
    expect((await giveFrom(await signIn("Grace"), "grace@example.com")).status).toBe(403);
    expect((await giveFrom(null, "anyone@example.com")).status).toBe(401);
    expect(await storedFrom()).toBe("ember@example.com");
  });

  it("sends an administrator a test email from the From address with Cloudflare Email Service", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "Ember Team <chat@example.com>");
    const { binding, sent } = fakeBinding();
    await withWorkspaceEnv({ EMAIL: binding }, async () => {
      const response = await sendTest(administrator);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ to: "ada@example.com" });

      await saveFrom(administrator, "chat@example.com");
      expect((await sendTest(administrator)).status).toBe(200);
    });
    expect(sent).toEqual([
      {
        from: { name: "Ember Team", email: "chat@example.com" },
        to: "ada@example.com",
        subject: "Test email from Ember",
        text: "This is a test email from Ember, at https://ember.test.\n\nIt reached you, so Ember can send email.\n",
        html: expect.stringContaining('<a href="https://ember.test">https://ember.test</a>') as unknown,
      },
      expect.objectContaining({ from: { name: "Ember", email: "chat@example.com" }, to: "ada@example.com" }),
    ]);
  });

  it("sends under the workspace's name while the From address has none, as a From line can hold it", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "join@example.com");
    const named = await api("/api/account", { method: "PATCH", headers: as(administrator), body: JSON.stringify({ name: 'The "Best" Club, Inc.' }) });
    expect(named.status).toBe(200);
    const { binding, sent } = fakeBinding();
    await withWorkspaceEnv({ EMAIL: binding }, async () => expect((await sendTest(administrator)).status).toBe(200));
    expect(sent).toEqual([expect.objectContaining({ from: { name: "The Best Club, Inc.", email: "join@example.com" } })]);
    const requests = fakeResend();
    await withWorkspaceEnv({ RESEND_API_KEY: RESEND_KEY }, async () => expect((await sendTest(administrator)).status).toBe(200));
    expect(requests.map((request) => request.body)).toEqual([expect.objectContaining({ from: '"The Best Club, Inc." <join@example.com>' })]);
  });

  it("names the workspace, as the email's text has it, and Ember's custom domain", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "chat@example.com");
    await workspaceSql("UPDATE accounts SET name = ?, settings = json_set(settings, '$.custom_domain', ?)", "Grace's <b>lab</b>", "chat.example.com");
    await evictDurableObject(workspaceStub());
    const { binding, sent } = fakeBinding();
    await withWorkspaceEnv({ EMAIL: binding }, async () => expect((await sendTest(administrator)).status).toBe(200));
    expect(sent[0]!.subject).toBe("Test email from Grace's <b>lab</b>");
    expect(sent[0]!.text).toContain("from Grace's <b>lab</b>, at https://chat.example.com.");
    expect(sent[0]!.html).toContain('from Grace&#39;s &lt;b&gt;lab&lt;/b&gt;, at <a href="https://chat.example.com">https://chat.example.com</a>.');
  });

  it("sends with the binding as wrangler dev has it, which takes the email as Ember gives it", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "Ember <ember@example.com>");
    const response = await sendTest(administrator);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ to: "ada@example.com" });
  });

  it("says why there's no test email: no session, no administrator, no way to send, no From address, or no address of one's own", async () => {
    const administrator = await setUp();
    expect((await sendTest(null)).status).toBe(401);
    const grace = await signIn("Grace");
    expect((await sendTest(grace)).status).toBe(403);
    await withWorkspaceEnv({ EMAIL: undefined }, async () => expectRefused(await sendTest(administrator), 503, CANT_SEND_EMAIL));
    await expectRefused(await sendTest(administrator), 422, "Give Ember a From address first.");

    await saveFrom(administrator, "chat@example.com");
    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", grace.user.id);
    const { binding, sent } = fakeBinding();
    await withWorkspaceEnv({ EMAIL: binding }, async () => expectRefused(await sendTest(grace), 422, "Your profile has no email address to send it to."));
    expect(sent).toEqual([]);
  });

  it("says in plain words why Cloudflare Email Service didn't send it, and logs its code, never the address", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "chat@example.com");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusals: Array<[unknown, string]> = [
      [thrownWith("E_SENDER_DOMAIN_NOT_AVAILABLE"), "The From address's domain isn't onboarded to Cloudflare Email Service. In the Cloudflare dashboard, open Email Service, Email Sending, and choose Onboard Domain."],
      [thrownWith("E_RECIPIENT_NOT_ALLOWED"), "Cloudflare won't send to that address from this account. On the Workers Free plan it sends only to the account's own verified addresses."],
      [thrownWith("E_DAILY_LIMIT_EXCEEDED"), "This account has used up its sending quota with Cloudflare for today. The quota grows with good sending."],
      [thrownWith("E_SOMETHING_NEW"), "Cloudflare Email Service didn't send it (E_SOMETHING_NEW)."],
      [thrownWith("<b>not a code</b>"), "Cloudflare Email Service didn't send it."],
      [new TypeError("Network connection lost"), "Cloudflare Email Service didn't send it."],
    ];
    for (const [thrown, refusal] of refusals) {
      const { binding } = fakeBinding(thrown);
      await withWorkspaceEnv({ EMAIL: binding }, async () => expectRefused(await sendTest(administrator), 502, refusal));
    }
    expect(logged).toHaveBeenCalledWith("Cloudflare Email Service didn't send an email:", "E_SENDER_DOMAIN_NOT_AVAILABLE");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("ada@example.com");
  });

  it("sends with Resend while the deployment has its API key, without following a redirect", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "Acme, Inc. <chat@acme.example>");
    const requests = fakeResend();
    const { binding, sent } = fakeBinding();
    await withWorkspaceEnv({ EMAIL: binding, RESEND_API_KEY: ` ${RESEND_KEY} ` }, async () => {
      const response = await sendTest(administrator);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ to: "ada@example.com" });
    });
    expect(sent).toEqual([]);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({ url: "https://api.resend.com/emails", method: "POST", redirect: "manual" });
    expect(request!.headers.get("Authorization")).toBe(`Bearer ${RESEND_KEY}`);
    expect(request!.headers.get("Content-Type")).toBe("application/json");
    expect(request!.body).toEqual({
      from: '"Acme, Inc." <chat@acme.example>',
      to: ["ada@example.com"],
      subject: "Test email from Ember",
      text: "This is a test email from Ember, at https://ember.test.\n\nIt reached you, so Ember can send email.\n",
      html: expect.stringContaining("It reached you, so Ember can send email.") as unknown,
    });
  });

  it("says in plain words why Resend didn't send it, and logs its error's name, never the address", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "chat@example.com");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const KEY_REFUSED = "Resend doesn't take the API key in RESEND_API_KEY. Check it under API Keys in Resend, or make one that can send.";
    const unverified = "The example.com domain is not verified. Please, add and verify your domain on https://resend.com/domains";
    const refusals: Array<[() => Response | Promise<Response>, string]> = [
      [() => Response.json({ name: "validation_error", message: unverified }, { status: 403 }), `Resend refused it: ${unverified}`],
      [() => Response.json({ name: "validation_error", message: "x".repeat(400) }, { status: 422 }), `Resend refused it: ${"x".repeat(300)}`],
      [() => Response.json({ name: "missing_api_key", message: "Missing API key in the authorization header" }, { status: 401 }), KEY_REFUSED],
      [() => Response.json({ name: "restricted_api_key", message: "This API key is restricted to only send emails" }, { status: 401 }), KEY_REFUSED],
      [() => Response.json({ name: "daily_quota_exceeded", message: "You have reached your daily email sending quota." }, { status: 429 }), "Resend's daily sending quota is used up. It starts again at midnight UTC."],
      [() => Response.json({ name: "monthly_quota_exceeded", message: "You have reached your monthly email sending quota." }, { status: 429 }), "Resend's monthly sending quota is used up."],
      [() => Response.json({ name: "rate_limit_exceeded", message: "Too many requests." }, { status: 429 }), "Resend is taking too many emails at once. Try again in a moment."],
      [() => new Response("Bad gateway", { status: 502 }), "Resend isn't answering as it should. Try again later."],
      [() => new Response("Not JSON", { status: 400 }), "Resend refused it (400)."],
      [() => new Response(null, { status: 307, headers: { Location: "https://elsewhere.example/emails" } }), "Resend refused it (307)."],
      [() => Promise.reject(new TypeError("Network connection lost")), "Resend didn't answer. Try again later."],
    ];
    for (const [answer, refusal] of refusals) {
      const requests = fakeResend(answer);
      await withWorkspaceEnv({ RESEND_API_KEY: RESEND_KEY }, async () => expectRefused(await sendTest(administrator), 502, refusal));
      expect(requests).toHaveLength(1);
      vi.mocked(fetch).mockRestore();
    }
    expect(logged).toHaveBeenCalledWith("Resend didn't send an email:", 403, "validation_error");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("ada@example.com");
    expect(JSON.stringify(logged.mock.calls)).not.toContain(RESEND_KEY);
  });

  it("takes a stand-in for Resend's API only at a loopback address", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "chat@example.com");
    const requests = fakeResend();
    for (const RESEND_API_URL of ["http://127.0.0.1:8796/", "https://resend.example/", "http://10.0.0.1:8796", "not a url"]) {
      await withWorkspaceEnv({ RESEND_API_KEY: RESEND_KEY, RESEND_API_URL }, async () => expect((await sendTest(administrator)).status).toBe(200));
    }
    expect(requests.map(({ url }) => url)).toEqual(["http://127.0.0.1:8796/emails", "https://api.resend.com/emails", "https://api.resend.com/emails", "https://api.resend.com/emails"]);
  });

  it("keeps a Resend API key an administrator gives once Resend takes it, sealed, and sends with it", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "chat@example.com");
    const requests = fakeSendingKey();
    const response = await giveResendKey(administrator, ` ${RESEND_KEY} `);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(withSavedKey("chat@example.com"));
    // Asked of Resend as a list of the account's domains, which a key that can only send is refused.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "https://api.resend.com/domains", method: "GET", redirect: "manual", body: null });
    expect(requests[0]!.headers.get("Authorization")).toBe(`Bearer ${RESEND_KEY}`);

    // The database holds it sealed, never as it was given.
    const sealed = (await storedSettings()).resend_api_key;
    expect(sealed).toMatch(/^v1\.[\w-]{16}\.[\w-]+$/);
    expect(JSON.stringify(await workspaceSql("SELECT * FROM accounts"))).not.toContain(RESEND_KEY);
    expect(await emailSettings(administrator)).toEqual(withSavedKey("chat@example.com"));

    // Started afresh, the Workspace reads it again, and opens it to send.
    await evictDurableObject(workspaceStub());
    const { binding, sent } = fakeBinding();
    await withWorkspaceEnv({ EMAIL: binding }, async () => expect((await sendTest(administrator)).status).toBe(200));
    expect(sent).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ url: "https://api.resend.com/emails", method: "POST", body: expect.objectContaining({ from: "Ember <chat@example.com>", to: ["ada@example.com"] }) as unknown });
    expect(requests[1]!.headers.get("Authorization")).toBe(`Bearer ${RESEND_KEY}`);

    // Given again, it's sealed afresh.
    expect((await giveResendKey(administrator, "re_another_key")).status).toBe(200);
    expect((await storedSettings()).resend_api_key).not.toBe(sealed);
    expect(await sendTest(administrator)).toHaveProperty("status", 200);
    expect(requests.at(-1)!.headers.get("Authorization")).toBe("Bearer re_another_key");
  });

  it("takes a Resend API key with full access, which can list the account's domains", async () => {
    const administrator = await setUp();
    fakeResend(() => Response.json({ object: "list", data: [] }));
    const response = await giveResendKey(administrator, RESEND_KEY);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(withSavedKey(null));
  });

  it("says why a Resend API key isn't taken, and keeps none, logging Resend's error but never the key", async () => {
    const administrator = await setUp();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const unasked = fakeResend();
    for (const apiKey of ["sk_live_123", "re_", "re_123 456", 42, null]) await expectRefused(await giveResendKey(administrator, apiKey), 422, RESEND_API_KEY_REFUSED);
    expect(unasked).toEqual([]);
    vi.mocked(fetch).mockRestore();

    const NOT_TAKEN = "Resend doesn't take this API key. Copy it again from API Keys in Resend, or make another.";
    const NOT_ACTIVE = "Resend says this API key isn't active. Make another under API Keys in Resend.";
    const refusals: Array<[() => Response | Promise<Response>, number, string]> = [
      [() => Response.json({ name: "validation_error", message: "API key is invalid" }, { status: 400 }), 422, NOT_TAKEN],
      [() => Response.json({ name: "validation_error", message: "API key is invalid" }, { status: 401 }), 422, NOT_TAKEN],
      [() => Response.json({ name: "restricted_api_key", message: "API key is not active" }, { status: 403 }), 422, NOT_ACTIVE],
      [() => Response.json({ name: "suspended_api_key", message: "This API key has been suspended" }, { status: 403 }), 422, NOT_ACTIVE],
      [() => new Response("Not JSON", { status: 401 }), 422, NOT_TAKEN],
      [() => Response.json({ name: "rate_limit_exceeded", message: "Too many requests." }, { status: 429 }), 502, "Resend is taking too many requests at once. Try again in a moment."],
      [() => new Response("Bad gateway", { status: 502 }), 502, "Resend isn't answering as it should. Try again later."],
      [() => new Response(null, { status: 307, headers: { Location: "https://elsewhere.example/domains" } }), 502, "Resend isn't answering as it should. Try again later."],
      [() => Promise.reject(new TypeError("Network connection lost")), 502, "Resend didn't answer. Try again later."],
    ];
    for (const [answer, status, refusal] of refusals) {
      const requests = fakeResend(answer);
      await expectRefused(await giveResendKey(administrator, RESEND_KEY), status, refusal);
      expect(requests).toHaveLength(1);
      vi.mocked(fetch).mockRestore();
    }
    expect(await storedSettings()).not.toHaveProperty("resend_api_key");
    expect((await emailSettings(administrator)).resendKey).toBeNull();
    expect(logged).toHaveBeenCalledWith("Resend didn't take an API key:", 400, "validation_error");
    expect(JSON.stringify(logged.mock.calls)).not.toContain(RESEND_KEY);
  });

  it("lets only administrators give or take away a Resend API key, asking Resend nothing for anyone else", async () => {
    await setUp();
    const grace = await signIn("Grace");
    const requests = fakeSendingKey();
    expect((await giveResendKey(grace, RESEND_KEY)).status).toBe(403);
    expect((await giveResendKey(null, RESEND_KEY)).status).toBe(401);
    expect((await giveResendKey(grace, "not a key")).status).toBe(403);
    expect((await forgetResendKey(grace)).status).toBe(403);
    expect((await forgetResendKey(null)).status).toBe(401);
    expect(requests).toEqual([]);
    expect(await storedSettings()).not.toHaveProperty("resend_api_key");
  });

  it("sends with the deployment's RESEND_API_KEY rather than the key given, while it has one", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "chat@example.com");
    const requests = fakeSendingKey();
    expect((await giveResendKey(administrator, "re_given_key")).status).toBe(200);
    await withWorkspaceEnv({ RESEND_API_KEY: RESEND_KEY }, async () => {
      expect(await emailSettings(administrator)).toEqual({ provider: "resend", resendKey: "secret", cloudflare: true, from: "chat@example.com" });
      expect((await sendTest(administrator)).status).toBe(200);
    });
    expect(requests.at(-1)!.headers.get("Authorization")).toBe(`Bearer ${RESEND_KEY}`);
    expect(await emailSettings(administrator)).toEqual(withSavedKey("chat@example.com"));
  });

  it("forgets the Resend API key, which leaves Cloudflare Email Service to send", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "chat@example.com");
    const requests = fakeSendingKey();
    expect((await giveResendKey(administrator, RESEND_KEY)).status).toBe(200);
    const response = await forgetResendKey(administrator);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: "cloudflare", resendKey: null, cloudflare: true, from: "chat@example.com" });
    expect((await storedSettings()).resend_api_key).toBeNull();
    const { binding, sent } = fakeBinding();
    await withWorkspaceEnv({ EMAIL: binding }, async () => expect((await sendTest(administrator)).status).toBe(200));
    expect(sent).toHaveLength(1);
    expect(requests).toHaveLength(1);
    // Forgetting none changes nothing.
    expect(await (await forgetResendKey(administrator)).json()).toEqual({ provider: "cloudflare", resendKey: null, cloudflare: true, from: "chat@example.com" });
    await withWorkspaceEnv({ EMAIL: undefined }, async () => expect((await emailSettings(administrator)).provider).toBeNull());
  });

  it("uses no Resend API key sealed under another SESSION_SECRET, which it logs", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "chat@example.com");
    fakeSendingKey();
    expect((await giveResendKey(administrator, RESEND_KEY)).status).toBe(200);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await withWorkspaceEnv({ SESSION_SECRET: "another secret, after the key was sealed" }, async () => {
      expect(await emailSettings(administrator)).toEqual({ provider: "cloudflare", resendKey: null, cloudflare: true, from: "chat@example.com" });
      await withWorkspaceEnv({ EMAIL: undefined }, async () => expectRefused(await sendTest(administrator), 503, CANT_SEND_EMAIL));
    });
    expect(logged).toHaveBeenCalledWith("The Resend API key Ember was given doesn't open under SESSION_SECRET, so it isn't used.");
    expect(await emailSettings(administrator)).toEqual(withSavedKey("chat@example.com"));
  });

  it("says a domain is onboarded to Cloudflare Email Sending once its DNS has the bounce MX and DKIM key Onboard Domain adds", async () => {
    const administrator = await setUp();
    const asked = fakeResolver(onboarded("mail.example.com"));
    const checked = await checkDomain(administrator, "Mail.Example.com");
    expect(checked.status).toBe(200);
    expect(checked.headers.get("Cache-Control")).toBe("no-store");
    expect(await checked.json()).toEqual({ onboarded: true });
    expect(asked).toEqual([
      "https://cloudflare-dns.com/dns-query?name=cf-bounce.mail.example.com&type=MX application/dns-json",
      "https://cloudflare-dns.com/dns-query?name=cf-bounce._domainkey.mail.example.com&type=TXT application/dns-json",
    ]);
  });

  it("says a domain isn't onboarded without either record, as one onboarded only to Email Routing isn't", async () => {
    const administrator = await setUp();
    fakeResolver({
      ...onboarded("example.com"),
      // Email Routing's records, on the domain itself, with its own DKIM selector.
      "routing.example MX": ["route1.mx.cloudflare.net."].map(mx),
      "cf2024-1._domainkey.routing.example TXT": [DKIM_KEY],
      "cf-bounce.elsewhere.example MX": [mx("mx.elsewhere.example.")],
      "cf-bounce._domainkey.elsewhere.example TXT": [DKIM_KEY],
      "cf-bounce.unsigned.example MX": [mx("route1.mx.cloudflare.net.")],
      "cf-bounce.revoked.example MX": [mx("route1.mx.cloudflare.net.")],
      "cf-bounce._domainkey.revoked.example TXT": [txt("v=DKIM1; k=rsa; p=")],
      "cf-bounce._domainkey.keyonly.example TXT": [DKIM_KEY],
    });
    for (const domain of ["nowhere.example", "routing.example", "elsewhere.example", "unsigned.example", "revoked.example", "keyonly.example"])
      expect(await (await checkDomain(administrator, domain)).json(), domain).toEqual({ onboarded: false });
    expect(await (await checkDomain(administrator, "example.com")).json()).toEqual({ onboarded: true });
  });

  it("says it can't tell when Cloudflare's resolver doesn't answer, which it logs", async () => {
    const administrator = await setUp();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failures = [
      () => Response.json({}, { status: 503 }),
      () => Response.json({ Status: 2 }),
      () => Promise.reject(new DOMException("The operation timed out", "TimeoutError")),
    ];
    let failure = failures[0]!;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => failure());
    for (failure of failures) expect(await (await checkDomain(administrator, "example.com")).json()).toEqual({ onboarded: null });
    expect(logged.mock.calls).toEqual([
      ["Looking up a sending domain's records failed:", "DNS over HTTPS answered 503"],
      ["Looking up a sending domain's records failed:", "DNS over HTTPS answered rcode 2"],
      ["Looking up a sending domain's records failed:", "The operation timed out"],
    ]);
  });

  it("checks a domain only for administrators, and only a domain", async () => {
    const administrator = await setUp();
    const asked = fakeResolver(onboarded("example.com"));
    expect((await checkDomain(null, "example.com")).status).toBe(401);
    expect((await checkDomain(await signIn("Grace"), "example.com")).status).toBe(403);
    for (const domain of ["", "not a domain", "localhost", "192.0.2.1", "ember@example.com", 42, undefined])
      await expectRefused(await checkDomain(administrator, domain), 422, SENDING_DOMAIN_REFUSED);
    expect(asked).toEqual([]);
  });

  it("says a key Resend no longer takes is the one given to Ember, which an administrator can replace", async () => {
    const administrator = await setUp();
    await saveFrom(administrator, "chat@example.com");
    fakeSendingKey();
    expect((await giveResendKey(administrator, RESEND_KEY)).status).toBe(200);
    vi.mocked(fetch).mockRestore();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fakeResend(() => Response.json({ name: "validation_error", message: "API key is invalid" }, { status: 401 }));
    await expectRefused(
      await sendTest(administrator),
      502,
      "Resend doesn't take Ember's API key anymore. Make another under API Keys in Resend, and give it to Ember under Email in Membership.",
    );
  });
});
