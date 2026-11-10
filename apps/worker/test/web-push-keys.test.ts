import type { Bootstrap } from "@ember/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromHex, toBase64url } from "../src/encoding";
import type { Env } from "../src/env";
import { INVALID_PRIVATE_KEY, INVALID_PUBLIC_KEY, KEYS_MISSING, MISMATCHED_KEYS, webPush } from "../src/push/keys";
import { apiWith } from "./support";

type Keys = Pick<Env, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY">;

/** A fresh key pair as `pnpm vapid:keys` writes it, and its public key's point. */
async function keyPair(): Promise<Required<Keys> & { point: Uint8Array }> {
  const { publicKey, privateKey } = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const point = new Uint8Array((await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer);
  const { d } = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  return { VAPID_PUBLIC_KEY: toBase64url(point), VAPID_PRIVATE_KEY: d!, point };
}

/** The point as SEC 1 compresses it: its x, after 2 or 3 for whether its y is even or odd. */
const compressed = (point: Uint8Array) => Uint8Array.of(2 + (point[64]! & 1), ...point.subarray(1, 33));

/** The private key 1, whose public key is the curve's generator. */
const SMALLEST = {
  VAPID_PUBLIC_KEY: toBase64url(
    fromHex("046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5")!,
  ),
  VAPID_PRIVATE_KEY: toBase64url(Uint8Array.of(1)),
};

/** Neither key, where this suite's Worker has a pair. */
const UNSET: Keys = { VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined };

/** A recovery token, which /api/health describes the deployment to whoever sends. */
const TOKEN = "ab".repeat(32);

/** What /api/health says of push from a Worker with `keys`. */
async function healthWith(keys: Keys): Promise<unknown> {
  const response = await apiWith({ ...keys, EMBER_RECOVERY_TOKEN: TOKEN }, "/api/health", { headers: { Authorization: `Bearer ${TOKEN}` } });
  expect(response.status).toBe(200);
  return ((await response.json()) as { push: unknown }).push;
}

/** The key the app subscribes browsers with, from a Worker with `keys`. */
const keyGivenWith = async (keys: Keys) => ((await (await apiWith(keys, "/api/bootstrap")).json()) as Bootstrap).vapidPublicKey;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Web Push configuration", () => {
  it("turns push on with a key pair, saying so in /api/health and giving the app the public key", async () => {
    const keys = await keyPair();
    expect(await healthWith(keys)).toEqual({ on: true });
    expect(await keyGivenWith(keys)).toBe(keys.VAPID_PUBLIC_KEY);
  });

  it("takes a compressed public key, giving the app the uncompressed one browsers subscribe with", async () => {
    const keys = await keyPair();
    expect(await keyGivenWith({ ...keys, VAPID_PUBLIC_KEY: toBase64url(compressed(keys.point)) })).toBe(keys.VAPID_PUBLIC_KEY);
  });

  it("reads the keys as Ruby's urlsafe_decode64 does: a private key shorter than 32 bytes, and padding", async () => {
    expect(await keyGivenWith(SMALLEST)).toBe(SMALLEST.VAPID_PUBLIC_KEY);
    expect(await keyGivenWith({ VAPID_PUBLIC_KEY: `${SMALLEST.VAPID_PUBLIC_KEY}=`, VAPID_PRIVATE_KEY: "AQ==" })).toBe(SMALLEST.VAPID_PUBLIC_KEY);
  });

  it.each([
    ["neither is set", UNSET],
    ["they're blank", { VAPID_PUBLIC_KEY: " ", VAPID_PRIVATE_KEY: "" }],
    ["only one is set", { ...UNSET, VAPID_PUBLIC_KEY: SMALLEST.VAPID_PUBLIC_KEY }],
  ])("turns push off when %s, giving the app no key, though the Worker is healthy", async (_, keys) => {
    expect(await healthWith(keys)).toEqual({ on: false, reason: KEYS_MISSING });
    expect(await keyGivenWith(keys)).toBeNull();
  });

  it.each([
    ["a public key that isn't Base64", { VAPID_PUBLIC_KEY: "not a key" }, INVALID_PUBLIC_KEY],
    ["a public key that isn't a point", { VAPID_PUBLIC_KEY: toBase64url(new Uint8Array(65).fill(4)) }, INVALID_PUBLIC_KEY],
    ["a private key that isn't Base64", { VAPID_PRIVATE_KEY: "%%" }, INVALID_PRIVATE_KEY],
    ["a private key longer than 32 bytes", { VAPID_PRIVATE_KEY: toBase64url(Uint8Array.of(0, ...fromHex("01".padStart(64, "0"))!)) }, INVALID_PRIVATE_KEY],
    ["a private key of 0", { VAPID_PRIVATE_KEY: "AA" }, INVALID_PRIVATE_KEY],
    ["a private key past the curve's order", { VAPID_PRIVATE_KEY: toBase64url(new Uint8Array(32).fill(255)) }, INVALID_PRIVATE_KEY],
    ["a private key whose public key is another", { VAPID_PRIVATE_KEY: "Ag" }, MISMATCHED_KEYS],
  ])("turns push off for %s, logging why once", async (_, change, reason) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const keys = { ...SMALLEST, ...change };
    expect(await healthWith(keys)).toEqual({ on: false, reason });
    expect(await keyGivenWith(keys)).toBeNull();
    expect(logged.mock.calls).toEqual([[`Web Push is off: ${reason}`]]);
  });

  it("warns once that push is off while the keys aren't set", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Read with keys first, so that reading without them reads them again.
    await webPush(SMALLEST as Env);
    for (let i = 0; i < 2; i++) expect(await webPush({} as Env)).toEqual({ on: false, reason: KEYS_MISSING });
    expect(warned.mock.calls).toEqual([["Web Push is off: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY aren't set"]]);
  });
});
