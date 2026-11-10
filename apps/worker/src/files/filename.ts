// File names as Active Storage keeps and serves them: `ActiveStorage::Filename`, with Ruby's
// `File.basename` and `File.extname`, the `Content-Disposition` Rails sends a file with, and the
// escaping its routes give a name in an address.

import { strip } from "@ember/richtext";

/** What `sanitized` makes "-": the right-to-left override, path separators, and shell and HTML metacharacters. */
const UNSAFE = /[‮%$|:;/<>?*"\t\r\n\\]/g;

/** `ActiveStorage::Filename#sanitized`, which Active Storage names and identifies a file by. */
export const sanitizedFilename = (name: string) => strip(name).replace(UNSAFE, "-");

/** `File.basename(path)`: the last component, ignoring trailing slashes. */
export function basename(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  const trimmed = path.slice(0, end);
  if (trimmed === "") return path === "" ? "" : "/";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * `File.extname(path)` on Unix: leading dots don't start an extension, and a trailing dot is an
 * extension of its own (`"foo."` is `"."`).
 */
export function extname(path: string): string {
  const name = basename(path).replace(/^\.+/, "");
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

/** `I18n::Backend::Transliterator::HashTransliterator::DEFAULT_APPROXIMATIONS`, from i18n 1.14.7. */
const APPROXIMATIONS: Record<string, string> = {
  À: "A", Á: "A", Â: "A", Ã: "A", Ä: "A", Å: "A", Æ: "AE", Ç: "C", È: "E", É: "E", Ê: "E", Ë: "E", Ì: "I", Í: "I",
  Î: "I", Ï: "I", Ð: "D", Ñ: "N", Ò: "O", Ó: "O", Ô: "O", Õ: "O", Ö: "O", "×": "x", Ø: "O", Ù: "U", Ú: "U", Û: "U",
  Ü: "U", Ý: "Y", Þ: "Th", ß: "ss", à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", æ: "ae", ç: "c", è: "e", é: "e",
  ê: "e", ë: "e", ì: "i", í: "i", î: "i", ï: "i", ð: "d", ñ: "n", ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o",
  ù: "u", ú: "u", û: "u", ü: "u", ý: "y", þ: "th", ÿ: "y", Ā: "A", ā: "a", Ă: "A", ă: "a", Ą: "A", ą: "a", Ć: "C",
  ć: "c", Ĉ: "C", ĉ: "c", Ċ: "C", ċ: "c", Č: "C", č: "c", Ď: "D", ď: "d", Đ: "D", đ: "d", Ē: "E", ē: "e", Ĕ: "E",
  ĕ: "e", Ė: "E", ė: "e", Ę: "E", ę: "e", Ě: "E", ě: "e", Ĝ: "G", ĝ: "g", Ğ: "G", ğ: "g", Ġ: "G", ġ: "g", Ģ: "G",
  ģ: "g", Ĥ: "H", ĥ: "h", Ħ: "H", ħ: "h", Ĩ: "I", ĩ: "i", Ī: "I", ī: "i", Ĭ: "I", ĭ: "i", Į: "I", į: "i", İ: "I",
  ı: "i", Ĳ: "IJ", ĳ: "ij", Ĵ: "J", ĵ: "j", Ķ: "K", ķ: "k", ĸ: "k", Ĺ: "L", ĺ: "l", Ļ: "L", ļ: "l", Ľ: "L", ľ: "l",
  Ŀ: "L", ŀ: "l", Ł: "L", ł: "l", Ń: "N", ń: "n", Ņ: "N", ņ: "n", Ň: "N", ň: "n", ŉ: "'n", Ŋ: "NG", ŋ: "ng", Ō: "O",
  ō: "o", Ŏ: "O", ŏ: "o", Ő: "O", ő: "o", Œ: "OE", œ: "oe", Ŕ: "R", ŕ: "r", Ŗ: "R", ŗ: "r", Ř: "R", ř: "r", Ś: "S",
  ś: "s", Ŝ: "S", ŝ: "s", Ş: "S", ş: "s", Š: "S", š: "s", Ţ: "T", ţ: "t", Ť: "T", ť: "t", Ŧ: "T", ŧ: "t", Ũ: "U",
  ũ: "u", Ū: "U", ū: "u", Ŭ: "U", ŭ: "u", Ů: "U", ů: "u", Ű: "U", ű: "u", Ų: "U", ų: "u", Ŵ: "W", ŵ: "w", Ŷ: "Y",
  ŷ: "y", Ÿ: "Y", Ź: "Z", ź: "z", Ż: "Z", ż: "z", Ž: "Z", ž: "z", ẞ: "SS",
};

/** `I18n.transliterate` with the default approximations, and "?" for anything else beyond ASCII. */
function transliterate(text: string): string {
  let ascii = "";
  for (const character of text) ascii += character <= "\x7f" ? character : (APPROXIMATIONS[character] ?? "?");
  return ascii;
}

const encoder = new TextEncoder();

/** `text` with each byte of UTF-8 that `keep` doesn't keep as `%XX`. Everything kept is ASCII, so going byte by byte is the same as by character. */
function percentEscape(text: string, keep: RegExp): string {
  let escaped = "";
  for (const byte of encoder.encode(text)) {
    const character = String.fromCharCode(byte);
    escaped += byte < 0x80 && keep.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return escaped;
}

/** What `TRADITIONAL_ESCAPED_CHAR` leaves alone in `filename=`. */
const TRADITIONAL = /[ A-Za-z0-9!#$+.^_`|~-]/;
/** What `RFC_5987_ESCAPED_CHAR` leaves alone in `filename*=`. */
const RFC_5987 = /[A-Za-z0-9!#$&+.^_`|~-]/;
/** What `Journey::Router::Utils.escape_path` leaves alone: unreserved characters, sub-delimiters, ":", "@" and "/". */
const PATH = /[A-Za-z0-9\-._~!$&'()*+,;=:@/]/;

/**
 * `ActiveStorage::Service#content_disposition_with`, which `ActionDispatch::Http::ContentDisposition.format`
 * writes: "attachment", or "inline" for anything else, named by `name`, a sanitized file name, in ASCII for
 * old clients, transliterated where it can be, and in full in RFC 5987's `filename*`.
 */
export function contentDisposition(disposition: string, name: string): string {
  const kind = disposition === "attachment" ? "attachment" : "inline";
  return `${kind}; filename="${percentEscape(transliterate(name), TRADITIONAL)}"; filename*=UTF-8''${percentEscape(name, RFC_5987)}`;
}

/** `Journey::Router::Utils.escape_path`, as Active Storage's routes put a file's name in its address. */
export const escapePath = (text: string) => percentEscape(text, PATH);
