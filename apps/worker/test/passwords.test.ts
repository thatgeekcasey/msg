import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { toBase64 } from "../src/encoding";
import type { Env } from "../src/env";
import { DUMMY_DIGEST, hashPassword, isCurrentDigest, passwordHasher, verifyPassword } from "../src/passwords";
import { pbkdf2Digest } from "./support";

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));
const utf8 = (text: string) => new TextEncoder().encode(text);
const hasher = () => passwordHasher(env as unknown as Env);

describe("Set up the workspace", () => {
  it("keeps a password as a salted scrypt digest that names its scheme and cost", async () => {
    const digest = await hashPassword("correct horse");
    // OWASP's cost, 16 bytes of salt and 32 of hash, in unpadded base64.
    expect(digest).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(digest).not.toContain("correct horse");
    expect(isCurrentDigest(digest)).toBe(true);
  });

  it("verifies the password a digest was made from, and no other", async () => {
    const digest = await hashPassword("correct horse");
    expect(await verifyPassword("correct horse", digest)).toBe(true);
    for (const other of ["Correct horse", "correct horse ", "correct", ""]) expect(await verifyPassword(other, digest), other).toBe(false);
  });

  it("salts every digest, so the same password never makes the same one twice", async () => {
    const [first, second] = await Promise.all([hashPassword("12345678"), hashPassword("12345678")]);
    expect(first).not.toBe(second);
    expect(await verifyPassword("12345678", second!)).toBe(true);
  });

  it("verifies with the cost and length a digest names", async () => {
    // RFC 7914's second test vector: P = "password", S = "NaCl", N = 1024, r = 8, p = 16, dkLen = 64.
    const hash = fromHex("fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640");
    const digest = `$scrypt$ln=10,r=8,p=16$${toBase64(utf8("NaCl"))}$${toBase64(hash)}`;
    expect(await verifyPassword("password", digest)).toBe(true);
    expect(await verifyPassword("Password", digest)).toBe(false);
    // Another cost than today's is one to replace.
    expect(isCurrentDigest(digest)).toBe(false);
  });

  it("still verifies a PBKDF2-SHA256 digest from before scrypt, with the iterations and length it names", async () => {
    // RFC 7914's PBKDF2-HMAC-SHA256 test vector: P = "passwd", S = "salt", c = 1, dkLen = 64.
    const hash = fromHex("55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783");
    const digest = `$pbkdf2-sha256$i=1$${toBase64(utf8("salt"))}$${toBase64(hash)}`;
    expect(await verifyPassword("passwd", digest)).toBe(true);
    expect(await verifyPassword("Passwd", digest)).toBe(false);
    expect(isCurrentDigest(digest)).toBe(false);
    const legacy = await pbkdf2Digest("compiler");
    expect(legacy).toMatch(/^\$pbkdf2-sha256\$i=100000\$/);
    expect(await verifyPassword("compiler", legacy)).toBe(true);
    expect(await verifyPassword("Compiler", legacy)).toBe(false);
  });

  it.each([
    ["nothing", ""],
    ["bcrypt's", "$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW"],
    ["another scheme's", "$pbkdf2-sha1$i=100000$c2FsdA$c2FsdA"],
    ["no iterations", "$pbkdf2-sha256$i=0$c2FsdA$c2FsdA"],
    ["no salt", "$pbkdf2-sha256$i=1$$c2FsdA"],
    ["padded base64", "$pbkdf2-sha256$i=1$c2FsdA==$c2FsdA=="],
    ["base64 that decodes to nothing", "$pbkdf2-sha256$i=1$c2FsdA$A"],
    ["scrypt with no cost", "$scrypt$ln=0,r=8,p=1$c2FsdA$c2FsdA"],
    ["scrypt with a cost nothing could pay", "$scrypt$ln=60,r=8,p=1$c2FsdA$c2FsdA"],
    ["scrypt with padded base64", "$scrypt$ln=10,r=8,p=1$c2FsdA==$c2FsdA=="],
    ["scrypt with no hash", "$scrypt$ln=10,r=8,p=1$c2FsdA$A"],
  ])("refuses every password for %s digest", async (_, digest) => {
    expect(await verifyPassword("passwd", digest)).toBe(false);
  });

  it("hashes in a Durable Object, where there's CPU time for it", async () => {
    const digest = await hasher().hash("12345678");
    expect(digest).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$/);
    expect(await verifyPassword("12345678", digest)).toBe(true);
    expect(await hasher().verify("12345678", digest)).toEqual({ matches: true, rehash: null });
    expect(await hasher().verify("12345679", digest)).toEqual({ matches: false, rehash: null });
  });

  it("makes a digest to keep in place of one from before scrypt when its password matches, and none when it doesn't", async () => {
    const legacy = await pbkdf2Digest("compiler");
    const { matches, rehash } = await hasher().verify("compiler", legacy);
    expect(matches).toBe(true);
    expect(rehash).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$/);
    expect(await verifyPassword("compiler", rehash!)).toBe(true);
    expect(await hasher().verify("Compiler", legacy)).toEqual({ matches: false, rehash: null });
    // As for one made at another cost.
    const costly = `$scrypt$ln=10,r=8,p=16$${toBase64(utf8("NaCl"))}$${toBase64(fromHex("fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640"))}`;
    expect((await hasher().verify("password", costly)).rehash).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$/);
  });
});

describe("Sign in with email and password", () => {
  it("checks an unknown address's password against a digest that costs as much as a real one and matches nothing", async () => {
    // The same scheme and cost as a new digest's, so the check takes as long, and leaves nothing to replace.
    expect(isCurrentDigest(DUMMY_DIGEST)).toBe(true);
    for (const password of ["12345678", "password", "analytical engine"]) expect(await verifyPassword(password, DUMMY_DIGEST), password).toBe(false);
    expect(await hasher().verify("12345678", DUMMY_DIGEST)).toEqual({ matches: false, rehash: null });
  });
});
