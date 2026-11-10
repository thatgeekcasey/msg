import { toBase64url, urlsafeDecode64 } from "../encoding";
import type { VapidKeys } from "./keys";

// A push as the web-push gem sends it: encrypted for the browser's keys with the `aes128gcm` content
// coding, and signed with the deployment's VAPID key, all with WebCrypto.

/** What the gem raises as an `ArgumentError`: a blank message or key, a key that isn't Base64, or a push too big to send. */
export class PushArgumentError extends Error {}

/** The browser's key isn't a P-256 point, so no push can reach the subscription, which is deleted. */
export class InvalidPushKeyError extends Error {}

/** How long the token a push is signed with lasts, as the gem's `expiration` has it: 12 hours. */
const EXPIRATION_SECONDS = 12 * 60 * 60;

/** The most a push service takes of a push's record. */
const MAX_RECORD_BYTES = 4096;

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const encoder = new TextEncoder();

/** How a push is framed, and, for tests, the key pair and salt it's made with in place of fresh ones. */
export interface Framing {
  /** The record size the header gives, which the gem gives as the ciphertext's length. */
  recordSize?: number;
  /** What follows the message before it's encrypted: the gem's last-record delimiter and a zero. */
  padding: Uint8Array;
  serverKeys?: CryptoKeyPair;
  salt?: Uint8Array;
}

/** The gem's framing, a single record of the ciphertext's own length. RFC 8291's example frames another way. */
const GEM: Framing = { padding: Uint8Array.of(2, 0) };

/**
 * `message` encrypted for the browser whose subscription has keys `p256dh` and `auth` (URL-safe Base64),
 * as the gem's `WebPush::Encryption.encrypt` does: the salt, the record size, the server's public key,
 * and the ciphertext.
 */
export async function encryptPush(message: Uint8Array, p256dh: string, auth: string, framing: Framing = GEM): Promise<Uint8Array> {
  if (message.length === 0) throw new PushArgumentError("message cannot be blank");
  if (!p256dh) throw new PushArgumentError("p256dh cannot be blank");
  if (!auth) throw new PushArgumentError("auth cannot be blank");
  // OpenSSL drops leading zero bytes before it reads the point.
  const browserPublic = stripLeadingZeros(decoded(p256dh));
  const browserKey = await crypto.subtle.importKey("raw", browserPublic, ECDH, false, []).catch(() => {
    throw new InvalidPushKeyError("invalid encoding");
  });
  const secret = decoded(auth);

  const server = framing.serverKeys ?? ((await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair);
  const serverPublic = new Uint8Array((await crypto.subtle.exportKey("raw", server.publicKey)) as ArrayBuffer);
  // workers-types calls the browser's key `$public`, which is `public` to the runtime.
  const agreement = { name: "ECDH", public: browserKey };
  const shared = new Uint8Array(await crypto.subtle.deriveBits(agreement, server.privateKey, 256));
  const salt = framing.salt ?? crypto.getRandomValues(new Uint8Array(16));

  const key = await hkdf(secret, shared, concat(encoder.encode("WebPush: info\0"), browserPublic, serverPublic), 32);
  const contentKey = await hkdf(salt, key, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, key, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(message, framing.padding)));
  if (ciphertext.length > MAX_RECORD_BYTES) throw new PushArgumentError("encrypted payload is too big");

  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, framing.recordSize ?? ciphertext.length);
  header[20] = serverPublic.length;
  return concat(header, serverPublic, ciphertext);
}

/**
 * The `Authorization` header that signs a push to the push service at `audience` (`https://<host>`) at
 * `now` (in seconds), as the gem's `build_vapid_header` writes it: a token whose claims are, in this
 * order, the audience, when it expires and `subject`, whom the push service may contact, and the public key.
 */
export async function vapidAuthorization(audience: string, now: number, keys: VapidKeys, subject: string): Promise<string> {
  const segment = (json: string) => toBase64url(encoder.encode(json));
  const signed = `${segment('{"typ":"JWT","alg":"ES256"}')}.${segment(JSON.stringify({ aud: audience, exp: now + EXPIRATION_SECONDS, sub: subject }))}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, encoder.encode(signed)));
  return `vapid t=${signed}.${toBase64url(signature)},k=${keys.publicKey}`;
}

/** The bytes of a subscription's key, read as the gem's `decode64` reads it. */
function decoded(key: string): Uint8Array {
  const bytes = urlsafeDecode64(key);
  if (!bytes) throw new PushArgumentError("invalid base64");
  return bytes;
}

async function hkdf(salt: Uint8Array, secret: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  const first = bytes.findIndex((byte) => byte !== 0);
  return bytes.subarray(first < 0 ? bytes.length : first);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}
