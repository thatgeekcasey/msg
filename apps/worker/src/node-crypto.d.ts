// The one piece of node:crypto the Worker uses (passwords.ts), typed here rather than by bringing all of
// @types/node's globals in beside @cloudflare/workers-types'. Node answers with a Buffer, a Uint8Array.
declare module "node:crypto" {
  export function scrypt(
    password: Uint8Array,
    salt: Uint8Array,
    keylen: number,
    options: { N: number; r: number; p: number; maxmem: number },
    callback: (error: Error | null, derivedKey: Uint8Array) => void,
  ): void;
}
