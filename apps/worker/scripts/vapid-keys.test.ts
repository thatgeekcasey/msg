import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { vapidKeys } from "./vapid-keys.ts";

const SCRIPT = fileURLToPath(new URL("./vapid-keys.ts", import.meta.url));
const ECDSA = { name: "ECDSA", hash: "SHA-256" } as const;

/** Whether `privateKey` signs what `publicKey` verifies, read as the Worker reads them. */
async function isPair(publicKey: string, privateKey: string): Promise<boolean> {
  const point = Buffer.from(publicKey, "base64url");
  const curve = { name: "ECDSA", namedCurve: "P-256" } as const;
  const verifier = await crypto.subtle.importKey("raw", point, curve, false, ["verify"]);
  const [x, y] = [point.subarray(1, 33), point.subarray(33)].map((half) => half.toString("base64url"));
  const signer = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y, d: privateKey }, curve, false, ["sign"]);
  const data = new TextEncoder().encode("Ember");
  return crypto.subtle.verify(ECDSA, verifier, await crypto.subtle.sign(ECDSA, signer, data), data);
}

describe("Web Push configuration", () => {
  it("makes a new key pair each time: the uncompressed point and the 32-byte scalar, in URL-safe Base64", async () => {
    const [first, second] = [await vapidKeys(), await vapidKeys()];
    expect(first.publicKey).toMatch(/^B[\w-]{86}$/);
    expect(first.privateKey).toMatch(/^[\w-]{43}$/);
    expect(await isPair(first.publicKey, first.privateKey)).toBe(true);
    expect(second.publicKey).not.toBe(first.publicKey);
  });

  it("prints the pair as the Worker's settings, for .dev.vars or wrangler secret put", async () => {
    const run = spawnSync("node", [SCRIPT], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const [, publicKey, privateKey] = run.stdout.match(/^VAPID_PUBLIC_KEY=(\S+)\nVAPID_PRIVATE_KEY=(\S+)\n$/)!;
    expect(await isPair(publicKey!, privateKey!)).toBe(true);
  });
});
