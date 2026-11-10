import { toBase64url, urlsafeDecode64 } from "../encoding";
import type { Env } from "../env";

// The key pair that signs Web Push requests (VAPID, RFC 8292), read from VAPID_PUBLIC_KEY and
// VAPID_PRIVATE_KEY: missing or invalid keys turn Web Push off rather than failing each push.

/** Why Web Push is off. */
export const KEYS_MISSING = "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY aren't set";
export const INVALID_PUBLIC_KEY = "VAPID_PUBLIC_KEY isn't a Base64 P-256 public key";
export const INVALID_PRIVATE_KEY = "VAPID_PRIVATE_KEY isn't a Base64 P-256 private key";
export const MISMATCHED_KEYS = "VAPID_PUBLIC_KEY isn't the public key of VAPID_PRIVATE_KEY";

export interface VapidKeys {
  /** The public key as browsers subscribe with it: the uncompressed point, in URL-safe Base64 without padding. */
  publicKey: string;
  /** Signs each push's token. */
  privateKey: CryptoKey;
}

/** Web Push with this deployment's keys, or why it's off. */
export type WebPush = { on: true; keys: VapidKeys } | { on: false; reason: string };

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;

/** A P-256 private key's PKCS #8 encoding up to its 32-byte scalar, with no public key, which importing derives. */
const PKCS8_SCALAR_PREFIX = Uint8Array.from([
  0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
  0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
]);

/** The keys last read, and the settings they were read from, so an isolate reads them and logs why push is off once. */
let read: { from: string; webPush: Promise<WebPush> } | undefined;

/**
 * Web Push as the deployment's keys allow it. Blank settings count as unset, which logs a warning when
 * they're missing and an error when they're invalid.
 */
export function webPush(env: Env): Promise<WebPush> {
  const settings = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY].map((value) => (value?.trim() ? value : undefined));
  const from = JSON.stringify(settings);
  if (read?.from !== from) read = { from, webPush: readKeys(settings[0], settings[1]).then(logged) };
  return read.webPush;
}

function logged(webPush: WebPush): WebPush {
  if (!webPush.on) (webPush.reason === KEYS_MISSING ? console.warn : console.error)(`Web Push is off: ${webPush.reason}`);
  return webPush;
}

/**
 * Reads the VAPID keys: the public key is a P-256 point, compressed or not, and the private key a scalar
 * of up to 32 bytes, left-padded, both in URL-safe Base64, and the point must be the scalar's.
 */
async function readKeys(publicText: string | undefined, privateText: string | undefined): Promise<WebPush> {
  if (publicText === undefined || privateText === undefined) return { on: false, reason: KEYS_MISSING };
  const point = urlsafeDecode64(publicText);
  const publicKey = point && (await crypto.subtle.importKey("raw", point, P256, true, ["verify"]).catch(() => null));
  if (!publicKey) return { on: false, reason: INVALID_PUBLIC_KEY };
  const scalar = urlsafeDecode64(privateText);
  const privateKey = scalar && scalar.length <= 32 && (await importScalar(scalar).catch(() => null));
  if (!privateKey) return { on: false, reason: INVALID_PRIVATE_KEY };

  const [given, derived] = await Promise.all([jwkOf(publicKey), jwkOf(privateKey)]);
  if (given.x !== derived.x || given.y !== derived.y) return { on: false, reason: MISMATCHED_KEYS };
  const uncompressed = new Uint8Array((await crypto.subtle.exportKey("raw", publicKey)) as ArrayBuffer);
  return { on: true, keys: { publicKey: toBase64url(uncompressed), privateKey } };
}

const jwkOf = async (key: CryptoKey) => (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;

function importScalar(scalar: Uint8Array): Promise<CryptoKey> {
  const encoded = new Uint8Array(PKCS8_SCALAR_PREFIX.length + 32);
  encoded.set(PKCS8_SCALAR_PREFIX);
  encoded.set(scalar, encoded.length - scalar.length);
  return crypto.subtle.importKey("pkcs8", encoded, P256, true, ["sign"]);
}
