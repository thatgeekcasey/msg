// Resets someone's password on a deployed Worker, through the Worker's recovery endpoint
// (src/recovery.ts), which answers only while the Worker's EMBER_RECOVERY_TOKEN secret is set. The
// script takes the same token from its environment, never from its arguments, which shell history keeps:
//
//   node apps/worker/scripts/reset-password.ts https://ember.example.com ada@example.com
//
// On a terminal it asks for the new password twice without showing it. Otherwise it reads exactly one
// password from stdin.

import { isPasswordTooLong, isPasswordTooShort } from "@ember/protocol";
import { fileURLToPath } from "node:url";
import { workerUrl } from "./worker-url.ts";

/** The most of stdin `ember reset-password` takes. */
const MAX_PASSWORD_BYTES = 4096;
const LF = 0x0a;
const CR = 0x0d;
/** EMBER_RECOVERY_TOKEN's shape, as the Worker requires it. */
const RECOVERY_TOKEN = /^[0-9a-f]{64}$/;
/** How long the Worker may take to answer, hashing the password included. */
const REQUEST_TIMEOUT_MS = 30_000;

const USAGE = "Usage: node apps/worker/scripts/reset-password.ts <the Worker's address> <email address>, with the Worker's recovery token in EMBER_RECOVERY_TOKEN";

/** What a hidden prompt does with the keys a terminal's line editing would act on. */
const ENTER = new Set(["\r", "\n"]);
const ERASE = new Set(["\u007f", "\b"]);
/** Ctrl-U. */
const ERASE_LINE = "\u0015";
/** Ctrl-C and Ctrl-D, which raw mode hands over rather than acting on. */
const CANCEL = new Set(["\u0003", "\u0004"]);

/** A problem with how the script was run, which exits with 2 rather than 1. */
class UsageError extends Error {}

/**
 * The password `input` holds, read from stdin: one trailing LF or CRLF is dropped, and every other
 * character kept, spaces included. Anything else throws, saying what's wrong.
 */
export function readPassword(input: Uint8Array): string {
  if (input.length > MAX_PASSWORD_BYTES) throw new Error(`password input exceeds ${MAX_PASSWORD_BYTES} bytes`);
  let end = input.length;
  if (input[end - 1] === LF) {
    end--;
    if (input[end - 1] === CR) end--;
  }
  const bytes = input.subarray(0, end);
  if (bytes.some((byte) => byte === LF || byte === CR || byte === 0)) throw new Error("provide exactly one password on stdin");
  let password: string;
  try {
    // Keeping a byte order mark, as Rust's `String::from_utf8` does.
    password = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("password must be UTF-8");
  }
  if (isPasswordTooShort(password)) throw new Error("password must contain at least 8 characters");
  return password;
}

/**
 * Asks `question` on the terminal and reads the answer without showing it, as Python's `getpass` does,
 * settling once Enter is pressed. Ctrl-C or Ctrl-D gives up.
 */
export function askHidden(question: string, input: NodeJS.ReadStream, output: NodeJS.WritableStream): Promise<string> {
  output.write(question);
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return new Promise((resolve, reject) => {
    let typed = "";
    const done = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(typed);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (ENTER.has(character)) return done();
        if (CANCEL.has(character)) return done(new Error("Cancelled."));
        if (ERASE.has(character)) typed = Array.from(typed).slice(0, -1).join("");
        else if (character === ERASE_LINE) typed = "";
        else typed += character;
      }
    };
    input.on("data", onData);
  });
}

/** What `input` holds, reading no more than one byte past what `ember reset-password` takes. */
async function readAll(input: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(bytes);
    size += bytes.length;
    if (size > MAX_PASSWORD_BYTES) break;
  }
  return Buffer.concat(chunks).subarray(0, MAX_PASSWORD_BYTES + 1);
}

/**
 * The new password: asked for twice on a terminal, and refused unless it has 8 to 72 characters, as
 * sign-in's form takes, and is typed the same both times. Otherwise the one password `input` holds.
 */
export async function newPassword(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Promise<string> {
  if (!input.isTTY) return readPassword(await readAll(input));
  const password = await askHidden("New password: ", input, output);
  if (isPasswordTooShort(password) || isPasswordTooLong(password)) throw new Error("Password must contain at least eight characters and no more than 72.");
  if ((await askHidden("Repeat new password: ", input, output)) !== password) throw new Error("Passwords do not match.");
  return password;
}

/** Asks the Worker at `baseUrl` to reset the password, answering what it says it did. */
async function reset(baseUrl: URL, token: string, emailAddress: string, password: string): Promise<string> {
  const response = await fetch(new URL("/api/recovery/reset-password", baseUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ emailAddress, password }),
    // A redirect would drop the token, or take the password somewhere else.
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const answer = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
  if (response.ok && answer.message) return answer.message;
  // What the Worker answers anything without its token, as it does an address its API doesn't have.
  if (response.status === 404 && answer.error === "Not found") {
    throw new Error("The Worker took no recovery request: set its EMBER_RECOVERY_TOKEN secret to the token in EMBER_RECOVERY_TOKEN here");
  }
  throw new Error(answer.error ?? `The Worker answered ${response.status}`);
}

async function main(args: string[], token: string | undefined): Promise<string> {
  if (args.length !== 2) throw new UsageError(USAGE);
  const [address = "", emailAddress = ""] = args;
  const baseUrl = workerUrl(address);
  if (!baseUrl) throw new UsageError("Pass the Worker's https:// address, or an http:// one on this machine.");
  // Checked so that an option can't pass for one.
  if (!emailAddress || emailAddress.startsWith("-") || emailAddress.includes("\n")) throw new UsageError("Pass an email address.");
  if (!token || !RECOVERY_TOKEN.test(token)) {
    throw new UsageError("Set EMBER_RECOVERY_TOKEN to the Worker's recovery token: 64 lowercase hex characters, from openssl rand -hex 32.");
  }
  return reset(baseUrl, token, emailAddress, await newPassword());
}

/** An error and its causes, such as fetch's "fetch failed" and the refused connection behind it. */
function explain(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause ? `${error.message}: ${explain(error.cause)}` : error.message;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(await main(process.argv.slice(2), process.env.EMBER_RECOVERY_TOKEN));
  } catch (error) {
    console.error(`✗ ${explain(error)}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
