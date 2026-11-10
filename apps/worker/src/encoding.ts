// Text encodings for random tokens, digests, sealed cookies, QR codes' ids and HTML.

/** Base64 without its padding, as the PHC string format writes salts and hashes. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "");
}

/** The bytes unpadded base64 encodes, or null if `text` isn't any. */
export function fromBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*$/.test(text)) return null;
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Base64 that's safe in a URL or a cookie, without padding. */
export const toBase64url = (bytes: Uint8Array) => toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_");

/**
 * The bytes Ruby's `Base64.urlsafe_decode64` takes from `text`, or null where it raises: it pads text
 * that isn't padded and reads either alphabet, even mixed, but is strict about everything else.
 */
export function urlsafeDecode64(text: string): Uint8Array | null {
  let standard = text.replace(/-/g, "+").replace(/_/g, "/");
  if (!text.endsWith("=")) standard = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(standard)) return null;
  const binary = atob(standard);
  // Ruby also refuses bits the last character doesn't need, which encoding again would drop.
  return btoa(binary) === standard ? Uint8Array.from(binary, (char) => char.charCodeAt(0)) : null;
}

/** Every byte's two hex digits, so writing a digest is a lookup per byte. */
const HEX_DIGITS = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += HEX_DIGITS[byte];
  return hex;
}

/** The bytes lowercase hex encodes, or null if `text` isn't any. */
export const fromHex = (text: string) => (/^(?:[0-9a-f]{2})*$/.test(text) ? Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16)) : null);

/** `text` as HTML shows it, in an element or a quoted attribute. */
export const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
