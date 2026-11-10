import type { StoredFile } from "@ember/protocol";
import { toBase64url } from "../encoding";
import { hmacKey } from "../hmac";
import { escapePath } from "./filename";

// The addresses that show and download a room's files, /files/<key>/<signature>/<name>: the signature
// says Ember made the address, so nobody can guess one, and as there, it never expires. The name is
// there for whoever saves the file, but what it's saved as is the name Ember keeps. A file's preview is
// at /previews/<key>/<signature>/<name>, under the same signature.

const encoder = new TextEncoder();

/** How much of its HMAC a signature keeps, as avatar tokens keep. */
const SIGNATURE_BYTES = 16;

/** The addresses that show a file and download it, and show its preview if it has one. */
export type FileUrls = Pick<StoredFile, "url" | "downloadUrl" | "previewUrl">;

/**
 * The signature of file `key` under `hmac`: the first 16 bytes of its HMAC, as base64url. Changing the
 * secret changes them all, as changing Campfire's `SECRET_KEY_BASE` does.
 */
async function signature(hmac: CryptoKey, key: string): Promise<string> {
  const signed = await crypto.subtle.sign("HMAC", hmac, encoder.encode(`file:${key}`));
  return toBase64url(new Uint8Array(signed, 0, SIGNATURE_BYTES));
}

/** Whether `given` is file `key`'s signature under `secret`. */
export async function isFileSignature(secret: string, key: string, given: string): Promise<boolean> {
  const [a, b] = [encoder.encode(given), encoder.encode(await signature(await hmacKey(secret), key))];
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}

/**
 * `name` as an address holds it, escaped as Active Storage's routes escape a path. A name a browser
 * would take out of the address, `.` or `..`, or no name at all, goes in as `-`, as sanitizing replaces
 * what a name can't hold.
 */
const addressName = (name: string) => (name === "" || name === "." || name === ".." ? "-" : escapePath(name));

/**
 * Signs files' addresses under `secret`, which it takes as a key once, however many files it signs: the
 * address that shows file `key`, named `name`, the one that downloads it, which asks for it as an
 * attachment, and the one that shows its preview, if it has one.
 */
export async function fileSigner(secret: string): Promise<(key: string, name: string, preview?: boolean) => Promise<FileUrls>> {
  const hmac = await hmacKey(secret);
  return async (key, name, preview) => {
    const signed = `${key}/${await signature(hmac, key)}/${addressName(name)}`;
    const url = `/files/${signed}`;
    return { url, downloadUrl: `${url}?disposition=attachment`, ...(preview && { previewUrl: `/previews/${signed}` }) };
  };
}
