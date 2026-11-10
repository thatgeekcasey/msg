import { DurableObject } from "cloudflare:workers";
import { scrypt } from "node:crypto";
import { fromBase64, toBase64 } from "./encoding";
import type { Env } from "./env";

// Passwords are kept as scrypt digests that name their scheme and cost, in the PHC string format:
// `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<hash>`. Campfire uses bcrypt, which Workers could only run
// compiled to WebAssembly, where Node's scrypt runs natively, and scrypt is memory-hard where bcrypt and
// PBKDF2 aren't, so a guess costs an attacker's GPU about what it costs here. Digests from before
// scrypt, PBKDF2-SHA256 at the 100,000 iterations Web Crypto allows on Workers
// (`$pbkdf2-sha256$i=<iterations>$<salt>$<hash>`), still verify, and are replaced as their passwords
// sign in. Because each digest says how it was made, a stronger hash later is the same move again.

/** scrypt's cost: OWASP's N = 2^15, r = 8, p = 3, which takes 32 MiB and under a quarter of a second of CPU. */
const LOG_N = 15;
const R = 8;
const P = 3;
/** The most memory a hash may take, 128·N·r bytes: a digest naming a cost past it is refused rather than paid. */
const MAX_MEMORY = 64 * 1024 * 1024;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
/** What a digest made now starts with, so one made with another cost is replaced like one from before scrypt. */
const CURRENT = `$scrypt$ln=${LOG_N},r=${R},p=${P}$`;
const SCRYPT_DIGEST = /^\$scrypt\$ln=([1-9]\d?),r=([1-9]\d*),p=([1-9]\d*)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const PBKDF2_DIGEST = /^\$pbkdf2-sha256\$i=([1-9]\d*)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
/** The iterations Ember made PBKDF2 digests with, which checking one costs besides the scrypt that replaces it. */
const PBKDF2_ITERATIONS_BEFORE_SCRYPT = 100_000;
const DUMMY_SALT = new Uint8Array(SALT_BYTES);

const encoder = new TextEncoder();

/** The hashes in this isolate, run in turn, so one holds one scrypt block at a time whatever its objects are doing. */
let hashing: Promise<unknown> = Promise.resolve();

/**
 * `password` hashed with scrypt at the cost `ln`, `r` and `p` name, by Node's `crypto.scrypt`, which
 * Workers run natively under `nodejs_compat`; in JavaScript it would take over ten times as long.
 */
function scryptHash(password: string, salt: Uint8Array, ln: number, r: number, p: number, bytes: number): Promise<Uint8Array> {
  const hash = hashing.then(
    () =>
      new Promise<Uint8Array>((resolve, reject) =>
        scrypt(encoder.encode(password), salt, bytes, { N: 2 ** ln, r, p, maxmem: MAX_MEMORY }, (error, key) =>
          error ? reject(error) : resolve(new Uint8Array(key.buffer, key.byteOffset, key.byteLength)),
        ),
      ),
  );
  hashing = hash.catch(() => undefined);
  return hash;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, bytes * 8));
}

/**
 * A digest made like any other from a random password that was then thrown away, so checking a password
 * against it takes as long as a real check and never matches. The `DUMMY_DIGEST` does the same for
 * unknown email addresses.
 */
export const DUMMY_DIGEST = "$scrypt$ln=15,r=8,p=3$cXt5Up9/mQWmqmnLLqmevQ$kAon/70wa5yerAyUhn+tnjdjQ1XQcGWQCb3GbPU4TQI";

/** A new digest of `password`, with a salt of its own. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return `${CURRENT}${toBase64(salt)}$${toBase64(await scryptHash(password, salt, LOG_N, R, P, HASH_BYTES))}`;
}

/** Whether `digest` was made as a new one is now, so a sign-in has nothing to replace. */
export const isCurrentDigest = (digest: string) => digest.startsWith(CURRENT);

/** Whether `password` is the one `digest` was made from. */
export async function verifyPassword(password: string, digest: string): Promise<boolean> {
  const candidate = await candidateFor(password, digest);
  return candidate !== null && crypto.subtle.timingSafeEqual(candidate.made, candidate.stored);
}

/**
 * `password` hashed as `digest` was, beside the hash `digest` holds, or null where `digest` names no
 * scheme this knows, or a cost it can't pay.
 */
async function candidateFor(password: string, digest: string): Promise<{ made: Uint8Array; stored: Uint8Array } | null> {
  const [, ln, r, p, scryptSalt, scryptHashText] = SCRYPT_DIGEST.exec(digest) ?? [];
  if (ln) {
    const [salt, stored] = [fromBase64(scryptSalt!), fromBase64(scryptHashText!)];
    if (!salt || !stored?.length) return null;
    try {
      return { made: await scryptHash(password, salt, Number(ln), Number(r), Number(p), stored.length), stored };
    } catch {
      return null;
    }
  }
  const [, iterations, pbkdf2Salt, pbkdf2HashText] = PBKDF2_DIGEST.exec(digest) ?? [];
  if (iterations) {
    const [salt, stored] = [fromBase64(pbkdf2Salt!), fromBase64(pbkdf2HashText!)];
    if (!salt || !stored?.length) return null;
    return { made: await pbkdf2(password, salt, Number(iterations), stored.length), stored };
  }
  return null;
}

/** What checking a password against a digest tells: whether it matched, and a digest to keep instead when there's a better one to have. */
export interface Verification {
  matches: boolean;
  /** A digest made now of the password, when it matched one made before scrypt or at another cost. */
  rehash: string | null;
}

/**
 * Hashes passwords where there's CPU time for it. A hash takes under a quarter of a second of CPU, and
 * on Workers Free a Worker's request gets 10 ms where a Durable Object's gets 30 seconds. It keeps
 * nothing, so each hash can run in a new object of its own, near the request and in nobody's way.
 */
export class PasswordHasher extends DurableObject<Env> {
  hash(password: string): Promise<string> {
    return hashPassword(password);
  }

  /**
   * Checks `password` against `digest`, and when it matches a digest from before scrypt, or one made
   * at another cost, makes one to keep instead. Such a digest is checked in a fraction of the time, so
   * the password is hashed anew whether it matched or not, and a current digest, the dummy one for an
   * unknown address among them, pays the PBKDF2 that one from before costs, so the answer takes as
   * long whatever the address and however old its digest.
   */
  async verify(password: string, digest: string): Promise<Verification> {
    const matches = await verifyPassword(password, digest);
    if (!isCurrentDigest(digest)) {
      const rehash = await hashPassword(password);
      return { matches, rehash: matches ? rehash : null };
    }
    await pbkdf2(password, DUMMY_SALT, PBKDF2_ITERATIONS_BEFORE_SCRYPT, HASH_BYTES);
    return { matches, rehash: null };
  }
}

/** A new object to hash a password in, near this request. */
export const passwordHasher = (env: Env) => env.PASSWORD_HASHER.get(env.PASSWORD_HASHER.newUniqueId());
