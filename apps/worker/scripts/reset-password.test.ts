import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askHidden, newPassword, readPassword } from "./reset-password.ts";

const SCRIPT = fileURLToPath(new URL("./reset-password.ts", import.meta.url));
const TOKEN = "0123456789abcdef".repeat(4);
const RESET = "Password updated; existing sessions and live connections for this user were revoked.";

const bytes = (text: string) => new TextEncoder().encode(text);

/** A terminal for a test to type into, which records what's written to it. */
function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => (written += chunk.toString()));
  return { input: input as typeof input & NodeJS.ReadStream, output, written: () => written, type: (keys: string) => input.write(keys) };
}

/** Stands in for the Worker, recording what it's asked and answering `answer`. */
let server: Server;
let workerUrl: string;
let requests: Array<{ method?: string; url?: string; authorization?: string; body: unknown }>;
let answer: { status: number; body: unknown; headers?: Record<string, string> };

beforeEach(async () => {
  requests = [];
  answer = { status: 200, body: { message: RESET } };
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: body ? JSON.parse(body) : null });
    response.writeHead(answer.status, { "Content-Type": "application/json", ...answer.headers });
    response.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  workerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Runs the script with `args`, `stdin` piped in, and `token` in EMBER_RECOVERY_TOKEN unless it's null. */
function run(args: string[], { stdin = "correct horse\n", token = TOKEN }: { stdin?: string | Uint8Array; token?: string | null } = {}) {
  const env = { ...process.env };
  delete env.EMBER_RECOVERY_TOKEN;
  if (token !== null) env.EMBER_RECOVERY_TOKEN = token;
  const child = spawn(process.execPath, [SCRIPT, ...args], { env });
  child.stdin.end(stdin);
  let [stdout, stderr] = ["", ""];
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

describe("Reset a password from the server", () => {
  it("reads stdin as ember reset-password does, keeping spaces and dropping one line ending", () => {
    expect(readPassword(bytes("  correct horse  \r\n"))).toBe("  correct horse  ");
    expect(readPassword(bytes("correct horse\n"))).toBe("correct horse");
    expect(readPassword(bytes("éééééééé"))).toBe("éééééééé");
    expect(readPassword(bytes("﻿correct horse"))).toBe("﻿correct horse");
    expect(readPassword(new Uint8Array(4096).fill(0x78))).toHaveLength(4096);
  });

  it.each([
    ["nothing", bytes(""), "password must contain at least 8 characters"],
    ["a short line", bytes("short\n"), "password must contain at least 8 characters"],
    ["8 bytes of 4 characters", bytes("éééé"), "password must contain at least 8 characters"],
    ["two lines", bytes("one password\nextra"), "provide exactly one password on stdin"],
    ["two line endings", bytes("correct horse\n\n"), "provide exactly one password on stdin"],
    ["a carriage return", bytes("correct\rhorse"), "provide exactly one password on stdin"],
    ["a NUL", bytes("null\0password"), "provide exactly one password on stdin"],
    ["bytes that aren't UTF-8", new Uint8Array([0x63, 0x6f, 0x72, 0x72, 0x65, 0x63, 0x74, 0xff]), "password must be UTF-8"],
    ["more than 4096 bytes", new Uint8Array(4097).fill(0x78), "password input exceeds 4096 bytes"],
  ])("refuses %s on stdin, as ember reset-password does", (_, input, error) => {
    expect(() => readPassword(input)).toThrow(error);
  });

  it("asks on a terminal without showing what's typed", async () => {
    const { input, output, written, type } = terminal();
    const answered = askHidden("New password: ", input, output);
    type("correct hosre");
    type("\u007f\u007f\u007f");
    type("rse\r");
    expect(await answered).toBe("correct horse");
    expect(written()).toBe("New password: \n");
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it("starts the line again on Ctrl-U, and gives up on Ctrl-C", async () => {
    const { input, output, type } = terminal();
    const answered = askHidden("New password: ", input, output);
    type("wrong\u0015correct horse 🐴\n");
    expect(await answered).toBe("correct horse 🐴");

    const cancelled = askHidden("New password: ", input, output);
    type("correct\u0003");
    await expect(cancelled).rejects.toThrow("Cancelled.");
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it("asks twice on a terminal, refusing a password too short or long for sign-in, or typed differently", async () => {
    /** What comes of typing `lines` on a terminal, one at each prompt. */
    const asked = async (...lines: string[]) => {
      const { input, output, type } = terminal();
      const settled = newPassword(input, output).then(
        (password) => ({ password }),
        (error: Error) => ({ error: error.message }),
      );
      for (const line of lines) {
        type(line);
        // Each prompt reads what's typed once it's asked.
        await new Promise((resolve) => setImmediate(resolve));
      }
      return settled;
    };
    expect(await asked("correct horse\r", "correct horse\r")).toEqual({ password: "correct horse" });
    expect(await asked("correct horse\r", "correct hose\r")).toEqual({ error: "Passwords do not match." });
    for (const password of ["short", "éééé", "x".repeat(73)]) {
      expect(await asked(`${password}\r`)).toEqual({ error: "Password must contain at least eight characters and no more than 72." });
    }
  });

  it("sends the Worker the email address and password with its token, and says what the Worker did", async () => {
    const { status, stdout, stderr } = await run([workerUrl, "grace@example.com"], { stdin: "  correct horse  \r\n" });
    expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: `${RESET}\n`, stderr: "" });
    expect(requests).toEqual([
      { method: "POST", url: "/api/recovery/reset-password", authorization: `Bearer ${TOKEN}`, body: { emailAddress: "grace@example.com", password: "  correct horse  " } },
    ]);
  });

  it("refuses stdin that ember reset-password refuses, before asking the Worker", async () => {
    const { status, stderr } = await run([workerUrl, "grace@example.com"], { stdin: "one password\nextra" });
    expect(status).toBe(1);
    expect(stderr).toBe("✗ provide exactly one password on stdin\n");
    expect(requests).toEqual([]);
  });

  it.each([
    ["no arguments", [], "Usage: node apps/worker/scripts/reset-password.ts"],
    ["no email address", ["WORKER"], "Usage: node apps/worker/scripts/reset-password.ts"],
    ["more than one email address", ["WORKER", "grace@example.com", "ada@example.com"], "Usage: node apps/worker/scripts/reset-password.ts"],
    ["an option for an email address", ["WORKER", "--help"], "Pass an email address."],
    ["a blank email address", ["WORKER", ""], "Pass an email address."],
    ["a plain HTTP address elsewhere", ["http://ember.example.com", "grace@example.com"], "Pass the Worker's https:// address"],
    ["something that isn't an address", ["ember", "grace@example.com"], "Pass the Worker's https:// address"],
  ])("refuses %s, before asking the Worker", async (_, args, error) => {
    const { status, stderr } = await run(args.map((arg) => (arg === "WORKER" ? workerUrl : arg)));
    expect(status).toBe(2);
    expect(stderr).toContain(error);
    expect(requests).toEqual([]);
  });

  it("takes the token only from EMBER_RECOVERY_TOKEN, in the shape the Worker takes, never printing it", async () => {
    for (const token of [null, "", "not a token", TOKEN.toUpperCase()]) {
      const { status, stdout, stderr } = await run([workerUrl, "grace@example.com"], { token });
      expect(status).toBe(2);
      expect(stderr).toContain("Set EMBER_RECOVERY_TOKEN to the Worker's recovery token");
      expect(stdout + stderr).not.toMatch(/not a token|0123456789ABCDEF/);
    }
    expect(requests).toEqual([]);
  });

  it("says why the Worker refused", async () => {
    answer = { status: 422, body: { error: "password must contain at most 72 characters" } };
    expect(await run([workerUrl, "grace@example.com"])).toMatchObject({ status: 1, stderr: "✗ password must contain at most 72 characters\n" });

    // What the Worker answers anything without its token.
    answer = { status: 404, body: { error: "Not found" } };
    const { status, stderr } = await run([workerUrl, "grace@example.com"]);
    expect(status).toBe(1);
    expect(stderr).toContain("set its EMBER_RECOVERY_TOKEN secret to the token in EMBER_RECOVERY_TOKEN here");
  });

  it("never follows a redirect, which would drop the token or take the password elsewhere", async () => {
    answer = { status: 308, body: {}, headers: { Location: "https://elsewhere.example/api/recovery/reset-password" } };
    const { status, stderr } = await run([workerUrl, "grace@example.com"]);
    expect(status).toBe(1);
    expect(stderr).toContain("redirect");
    expect(requests).toHaveLength(1);
  });
});
