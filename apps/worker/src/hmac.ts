// SESSION_SECRET as the key the Worker's HMACs are made under: session digests, avatar tokens, file
// addresses and sign-in links. It's imported once for the secret rather than for every signature,
// since a cheap request makes one or two.

const encoder = new TextEncoder();

let imported: { secret: string; key: Promise<CryptoKey> } | undefined;

/** `secret` as an HMAC-SHA-256 key to sign with. An import that fails is tried again next time. */
export function hmacKey(secret: string): Promise<CryptoKey> {
  if (imported?.secret !== secret) {
    const key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    key.catch(() => {
      if (imported?.key === key) imported = undefined;
    });
    imported = { secret, key };
  }
  return imported.key;
}
