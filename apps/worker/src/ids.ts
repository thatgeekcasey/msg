// Sortable ids: 10 chars of millisecond time + 6 random chars, base36.
// Lexicographic order matches creation order, which history paging relies on.
// Each room has a single writer (its Durable Object), so bumping the clock on
// a collision is enough to keep ids from one room strictly increasing.

let last = 0;

export function sortableId(now = Date.now()): string {
  const time = Math.max(now, last + 1);
  last = time;
  const random = crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36).padStart(7, "0").slice(-6);
  return time.toString(36).padStart(10, "0") + random;
}

const ALPHANUMERICS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";

/** `length` random characters of `alphabet`, each as likely as the next. */
function random(alphabet: string, length: number): string {
  // Bytes from the largest multiple of the alphabet's size up are thrown away, so none is likelier.
  const limit = 256 - (256 % alphabet.length);
  let text = "";
  while (text.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < limit && text.length < length) text += alphabet[byte % alphabet.length];
    }
  }
  return text;
}

/** `length` random letters and digits, as Ruby's `SecureRandom.alphanumeric` makes them. */
export const alphanumeric = (length: number) => random(ALPHANUMERICS, length);

/** `length` random lowercase letters and digits, as Rails' `SecureRandom.base36` makes Active Storage's keys. */
export const base36 = (length: number) => random(BASE36, length);

/** `length` random digits, as a code someone types is made of. */
export const digits = (length: number) => random(DIGITS, length);
