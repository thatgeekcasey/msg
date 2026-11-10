// Makes a key pair for push notifications (VAPID, RFC 8292), as `web-push generate-vapid-keys` does, and
// prints it as the Worker's two settings, ready for .dev.vars or `wrangler secret put`:
//
//   pnpm vapid:keys
//
// Browsers subscribe with the public key, so changing a deployment's keys loses every subscription,
// and everyone has to turn notifications on again. scripts/deploy.ts makes a deployment's on its first deploy.

import { fileURLToPath } from "node:url";

/** A new pair as the Worker reads it: the public key's uncompressed point and the private key's scalar, in URL-safe Base64. */
export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const point = Buffer.from(await crypto.subtle.exportKey("raw", publicKey));
  const { d } = await crypto.subtle.exportKey("jwk", privateKey);
  return { publicKey: point.toString("base64url"), privateKey: d! };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { publicKey, privateKey } = await vapidKeys();
  console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}`);
}
