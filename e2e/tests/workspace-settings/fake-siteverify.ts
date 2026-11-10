import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TURNSTILE_WIDGET, turnstileTokenFor } from "../../fixtures";
import { SITEVERIFY_PORT } from "../../projects/workspace-settings";

// Turnstile's siteverify for the Turnstile spec, at the address the second test server's
// TURNSTILE_SITEVERIFY_URL names, as Ember asks it (apps/worker/src/turnstile.ts): it knows one widget,
// `TURNSTILE_WIDGET`, whose check the fake Turnstile passes, and refuses as Cloudflare does a secret key
// it doesn't know, or a token that isn't from that widget's check.

/** What Ember asks siteverify about a check. */
export interface Siteverified {
  secret: string;
  response: string;
  remoteip?: string;
}

export interface FakeSiteverify {
  /** What it was asked, in order. */
  asked: Siteverified[];
  close(): Promise<void>;
}

/** Starts siteverify. */
export async function startFakeSiteverify(): Promise<FakeSiteverify> {
  const asked: Siteverified[] = [];
  const server = createServer((request, response) => {
    answer(request, response, asked).catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(SITEVERIFY_PORT, "127.0.0.1", resolve));
  return { asked, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function answer(request: IncomingMessage, response: ServerResponse, asked: Siteverified[]): Promise<void> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  const check = JSON.parse(body) as Siteverified;
  asked.push(check);
  const codes =
    check.secret !== TURNSTILE_WIDGET.secretKey ? ["invalid-input-secret"] : check.response !== turnstileTokenFor(TURNSTILE_WIDGET.siteKey) ? ["invalid-input-response"] : [];
  const outcome = codes.length === 0 ? { success: true, "error-codes": [], hostname: "127.0.0.1" } : { success: false, "error-codes": codes };
  response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(outcome));
}
