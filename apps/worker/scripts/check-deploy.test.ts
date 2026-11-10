import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerUrl } from "./worker-url.ts";

const SCRIPT = fileURLToPath(new URL("./check-deploy.ts", import.meta.url));
const TOKEN = "0123456789abcdef".repeat(4);
const REFUSED = "✗ With EMBER_RECOVERY_TOKEN set, pass the Worker's https:// address, or an http:// one on this machine.\n";

type Answer = { status: number; body: string; headers?: Record<string, string> };

/** What a Worker that's set up answers each address the check asks about, telling its storage only to whoever sends the token. */
function answerOf(url: string, authorization: string | undefined): Answer {
  if (url === "/api/health") return { status: 200, body: JSON.stringify(authorization === `Bearer ${TOKEN}` ? { ok: true, storage: "do-sqlite" } : { ok: true }) };
  if (url === "/") return { status: 200, body: '<div id="root"></div>', headers: { "X-Content-Type-Options": "nosniff" } };
  if (url === "/api/me") return { status: 401, body: "{}" };
  if (url === "/api/bootstrap") return { status: 200, body: JSON.stringify(bootstrap) };
  return { status: 404, body: "<title>We can’t find that (404)</title>" };
}

/** Stands in for the Worker, recording what it's asked, and answering /api/health with `healthAnswer` when a test gives one. */
let server: Server;
let address: string;
let requests: Array<{ url?: string; authorization?: string }>;
let healthAnswer: Answer | null;
/** What /api/bootstrap answers: that Ember is set up, unless a test says otherwise. */
let bootstrap: object;

beforeEach(async () => {
  requests = [];
  healthAnswer = null;
  bootstrap = { setup: "complete" };
  server = createServer(({ url = "", headers: { authorization } }, response) => {
    requests.push({ url, authorization });
    const { status, body, headers } = (url === "/api/health" && healthAnswer) || answerOf(url, authorization);
    response.writeHead(status, headers);
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Starts the check of the Worker at `at`, with `token` in EMBER_RECOVERY_TOKEN unless it's null. */
function start(at: string, token: string | null = TOKEN) {
  const env = { ...process.env };
  delete env.EMBER_RECOVERY_TOKEN;
  if (token !== null) env.EMBER_RECOVERY_TOKEN = token;
  return spawn(process.execPath, [SCRIPT, at], { env });
}

/** Runs the check to its end, as `start` starts it. */
function run(at: string, token: string | null = TOKEN) {
  const child = start(at, token);
  let [stdout, stderr] = ["", ""];
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

describe("Health check", () => {
  it("sends the recovery token to /api/health alone, and hears the Worker's storage", async () => {
    const { status, stdout, stderr } = await run(address);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(stdout).toContain("✓ /api/health answers: the Workspace and a room read their storage in do-sqlite\n");
    expect(stdout).toContain("✓ Ember is set up\n");
    expect(requests).toEqual([
      { url: "/api/health", authorization: `Bearer ${TOKEN}` },
      { url: "/", authorization: undefined },
      { url: "/no-such-page", authorization: undefined },
      { url: "/api/me", authorization: undefined },
      { url: "/api/bootstrap", authorization: undefined },
    ]);
  });

  it("checks without the token when the shell hasn't got it", async () => {
    const { status, stdout } = await run(address, null);
    expect(status).toBe(0);
    expect(stdout).toContain("✓ /api/health answers: the Workspace and a room read their storage\n");
    expect(requests.map(({ authorization }) => authorization)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it.each([
    ["a plain HTTP address elsewhere", "http://ember.example.com"],
    ["something that isn't an address", "ember"],
  ])("refuses to send the token to %s, before asking anything", async (_, at) => {
    expect(await run(at)).toEqual({ status: 2, stdout: "", stderr: REFUSED });
    expect(requests).toEqual([]);
  });

  it("sends the token over HTTPS, or over plain HTTP only on this machine, where wrangler dev serves", () => {
    for (const at of ["https://ember.example.com", "https://ember.example.workers.dev/", "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) {
      expect(workerUrl(at)?.href, at).toBe(new URL(at).href);
    }
    for (const at of ["http://ember.example.com", "http://192.168.1.2:8787", "ws://localhost:8787", "ember"]) expect(workerUrl(at), at).toBeNull();
  });

  it("never follows a redirect with the token", async () => {
    healthAnswer = { status: 307, body: "", headers: { Location: "/api/health/elsewhere" } };
    const check = start(address);
    const closed = new Promise((resolve) => check.on("close", resolve));
    try {
      await vi.waitFor(() => expect(requests).not.toEqual([]), { timeout: 5_000 });
      // A redirect followed is asked for at once, where the check asks again only 5 seconds later.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      check.kill();
      await closed;
    }
    expect(requests).toEqual([{ url: "/api/health", authorization: `Bearer ${TOKEN}` }]);
  }, 10_000);
});

describe("Setup", () => {
  it.each([
    ["password", "✓ Setup is waiting for the Worker's setup password at <address>/first_run\n"],
    ["link", "✓ Setup is waiting for the setup link the deploy printed (if it's lost,"],
    ["open", "✓ Setup is waiting, open to whoever is here\n"],
    ["closed", "! Setup is waiting, and nobody can do it: the Worker has no setup password or EMBER_SETUP_TOKEN. Give it a setup password with wrangler secret put EMBER_SETUP_PASSWORD"],
  ])("says what setting Ember up takes while it waits, as its setup access is %s", async (setupAccess, said) => {
    bootstrap = { setup: "pending", setupAccess };
    const { status, stdout } = await run(address, null);
    expect(status).toBe(0);
    expect(stdout).toContain(said.replace("<address>", address));
  });
});
