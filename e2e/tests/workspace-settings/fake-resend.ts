import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { APIRequestContext } from "@playwright/test";
import { administratorSession, cookieHeader, expect, SAME_ORIGIN } from "../../fixtures";
import { RESEND_API_PORT, RESEND_KEY } from "../../projects/workspace-settings";

// Resend's API for the email specs, at the address the second test server's RESEND_API_URL names, with
// what Ember asks of it (apps/worker/src/mail.ts): it knows one API key, `RESEND_KEY`, which can only
// send, as Resend suggests making, so that asked for its domains with it, it refuses as Resend does,
// which tells Ember it's a key Resend has. It takes an email, or a batch of them, sent with that key, and
// keeps them, answering as Resend does, or refuses the next one as a spec says.

/** An email as Ember sends one to Resend. */
export interface SentEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

/** What Resend answers an email it refuses with. */
export interface ResendRefusal {
  status: number;
  name: string;
  message: string;
}

export interface FakeResend {
  /** The emails it took, in order. */
  sent: SentEmail[];
  /** Refuses the next email, or batch of them, as `refusal` says. */
  refuseNext(refusal: ResendRefusal): void;
  close(): Promise<void>;
}

/** Starts the API. */
export async function startFakeResend(): Promise<FakeResend> {
  const sent: SentEmail[] = [];
  const refusals: ResendRefusal[] = [];
  const server = createServer((request, response) => {
    answer(request, response, sent, refusals).catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(RESEND_API_PORT, "127.0.0.1", resolve));
  return {
    sent,
    refuseNext: (refusal) => void refusals.push(refusal),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function answer(request: IncomingMessage, response: ServerResponse, sent: SentEmail[], refusals: ResendRefusal[]): Promise<void> {
  const json = (status: number, body: unknown) => void response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const body = await bodyOf(request);
  const known = request.headers.authorization === `Bearer ${RESEND_KEY}`;
  if (request.method === "GET" && request.url === "/domains") {
    if (!known) return json(400, { statusCode: 400, name: "validation_error", message: "API key is invalid" });
    return json(401, { statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails" });
  }
  const batch = request.url === "/emails/batch";
  if (request.method !== "POST" || (request.url !== "/emails" && !batch)) return json(404, { statusCode: 404, name: "not_found", message: "The requested endpoint does not exist." });
  if (!known) return json(401, { statusCode: 401, name: "missing_api_key", message: "Missing API key in the authorization header." });
  const refusal = refusals.shift();
  if (refusal) return json(refusal.status, { statusCode: refusal.status, name: refusal.name, message: refusal.message });
  if (!batch) {
    sent.push(JSON.parse(body) as SentEmail);
    return json(200, { id: crypto.randomUUID() });
  }
  // A batch is taken or refused whole (https://resend.com/docs/api-reference/emails/send-batch-emails).
  const emails = JSON.parse(body) as SentEmail[];
  sent.push(...emails);
  json(200, { data: emails.map(() => ({ id: crypto.randomUUID() })) });
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

/** Gives Ember the API key this API takes, as the administrator does in Set up email. */
export async function giveResendKey(request: APIRequestContext): Promise<void> {
  const response = await request.put("/api/account/resend_api_key", { data: { apiKey: RESEND_KEY }, headers: await asAdministrator(request) });
  expect(response.status(), await response.text()).toBe(200);
}

/** Takes Ember's Resend API key away, as a new workspace has none. */
export async function forgetResendKey(request: APIRequestContext): Promise<void> {
  const response = await request.delete("/api/account/resend_api_key", { headers: await asAdministrator(request) });
  expect(response.status(), await response.text()).toBe(200);
}

/** The administrator's session's headers, for the API. */
const asAdministrator = async (request: APIRequestContext) => ({ Cookie: cookieHeader(await administratorSession(request)), ...SAME_ORIGIN });
