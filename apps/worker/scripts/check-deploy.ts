// Checks a deployed Worker without signing in: /api/health answers once SESSION_SECRET is set and
// the Workspace and a room's Durable Object both read their storage, the app's page loads through
// the Worker, an address with no page answers Campfire's 404 page, the API asks for sign-in, and
// whether Ember is set up yet, or waits for its setup password or the setup link the deploy printed.
// The Preview workflow runs it after each deploy; it works against `pnpm dev` too:
//
//   node apps/worker/scripts/check-deploy.ts http://localhost:8787

import type { Bootstrap } from "@ember/protocol";
import { workerUrl } from "./worker-url.ts";

/**
 * A new Worker's workers.dev hostname, and a secret set just after its deploy, can take a little
 * while to reach every location, so each check is retried until then.
 */
const STARTUP_TIMEOUT_MS = 120_000;
const RETRY_DELAY_MS = 5_000;
/** How long one request may take, so one that stalls fails and is retried like any other. */
const REQUEST_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The Worker's recovery token, if the shell has it: /api/health describes the deployment only to
 * whoever sends it, or to an administrator. It can take over any account, so it goes only to an
 * address `workerUrl` takes, and never on to where a redirect points.
 */
const recoveryToken = process.env.EMBER_RECOVERY_TOKEN;

async function health(baseUrl: string): Promise<{ storage?: string }> {
  const headers = recoveryToken ? { Authorization: `Bearer ${recoveryToken}` } : undefined;
  const redirect = recoveryToken ? "error" : "follow";
  const response = await fetch(new URL("/api/health", baseUrl), { headers, redirect, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    // It says what's missing, such as SESSION_SECRET, to whoever sends the token; the Worker's log says so to everyone.
    const { error } = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(`/api/health answered ${response.status}${error ? `: ${error}` : " (the Worker's log says why)"}`);
  }
  return (await response.json()) as { storage?: string };
}

async function checkPage(baseUrl: string): Promise<void> {
  const response = await fetch(baseUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const html = await response.text();
  if (!response.ok || !html.includes('<div id="root">')) throw new Error(`The app's page answered ${response.status} without the app`);
  // Only the Worker adds it, so without it the page came straight from the static assets.
  if (response.headers.get("X-Content-Type-Options") !== "nosniff") throw new Error("The app's page skipped the Worker: check run_worker_first");
}

/** An address with no page answers Campfire's 404 page rather than the app's, as the assets' 404 handling has it. */
async function checkNotFound(baseUrl: string): Promise<void> {
  const response = await fetch(new URL("/no-such-page", baseUrl), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const html = await response.text();
  if (response.status !== 404 || !html.includes("<title>We can’t find that (404)</title>")) {
    throw new Error(`An address with no page answered ${response.status} without Campfire's 404 page: check not_found_handling`);
  }
}

async function checkSignInRequired(baseUrl: string): Promise<void> {
  const response = await fetch(new URL("/api/me", baseUrl), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status !== 401) throw new Error(`/api/me answered ${response.status} without a session, not 401`);
}

/**
 * Whether Ember is set up yet, and until it is, what setting it up takes: the Worker's setup password, or
 * the deploy's setup link, which nobody can use while the Worker has neither.
 */
async function checkSetup(baseUrl: string): Promise<{ fine: boolean; said: string }> {
  const response = await fetch(new URL("/api/bootstrap", baseUrl), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`/api/bootstrap answered ${response.status}`);
  const { setup, setupAccess } = (await response.json()) as Bootstrap;
  const link = `${new URL("/first_run", baseUrl).href}#token=<the token>`;
  // `wrangler secret put` asks for the value, so the person sees the token they make, which a pipe would hide.
  const newToken = "make one with openssl rand -hex 32 and give it to the Worker with wrangler secret put EMBER_SETUP_TOKEN (plus its --name, if it isn't wrangler.jsonc's), which asks for it";
  const putPassword = "wrangler secret put EMBER_SETUP_PASSWORD (plus its --name, if it isn't wrangler.jsonc's), which asks for it";
  if (setup === "complete") return { fine: true, said: "Ember is set up" };
  if (setupAccess === "password") return { fine: true, said: `Setup is waiting for the Worker's setup password at ${new URL("/first_run", baseUrl).href}` };
  if (setupAccess === "link") return { fine: true, said: `Setup is waiting for the setup link the deploy printed (if it's lost, ${newToken}, then open ${link})` };
  if (setupAccess === "open") return { fine: true, said: "Setup is waiting, open to whoever is here" };
  return {
    fine: false,
    said: `Setup is waiting, and nobody can do it: the Worker has no setup password or EMBER_SETUP_TOKEN. Give it a setup password with ${putPassword}, or deploy it with pnpm run deploy, which makes a token and prints the link`,
  };
}

async function check(baseUrl: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const eventually = async <T>(attempt: () => Promise<T>): Promise<T> => {
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        if (Date.now() >= deadline) throw new Error(`Still failing after ${STARTUP_TIMEOUT_MS / 1000}s`, { cause: error });
        await sleep(RETRY_DELAY_MS);
      }
    }
  };

  const { storage } = await eventually(() => health(baseUrl));
  console.log(`✓ /api/health answers: the Workspace and a room read their storage${storage ? ` in ${storage}` : ""}`);
  await eventually(() => checkPage(baseUrl));
  console.log("✓ The app's page loads, through the Worker");
  await eventually(() => checkNotFound(baseUrl));
  console.log("✓ An address with no page answers Campfire's 404 page");
  await eventually(() => checkSignInRequired(baseUrl));
  console.log("✓ The API asks for sign-in");
  const { fine, said } = await eventually(() => checkSetup(baseUrl));
  console.log(`${fine ? "✓" : "!"} ${said}`);
}

/** An error and its causes, such as fetch's "fetch failed" and the refused connection behind it. */
function explain(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause ? `${error.message}: ${explain(error.cause)}` : error.message;
}

const [baseUrl] = process.argv.slice(2);
if (!baseUrl) {
  console.error("Usage: node apps/worker/scripts/check-deploy.ts <url>");
  process.exit(2);
}
if (recoveryToken && !workerUrl(baseUrl)) {
  console.error("✗ With EMBER_RECOVERY_TOKEN set, pass the Worker's https:// address, or an http:// one on this machine.");
  process.exit(2);
}
try {
  await check(baseUrl);
} catch (error) {
  console.error(`✗ ${explain(error)}`);
  process.exitCode = 1;
}
