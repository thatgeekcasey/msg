// The Ruby and Active Support string behaviors Action Text's output depends on.

/** `String#strip`: NUL and ASCII whitespace off both ends (not Unicode spaces like U+00A0). */
export function strip(value: string): string {
  const stripped = (c: string | undefined) => c !== undefined && "\0\t\n\v\f\r ".includes(c);
  let start = 0;
  let end = value.length;
  while (start < end && stripped(value[start])) start++;
  while (end > start && stripped(value[end - 1])) end--;
  return value.slice(start, end);
}

/** Active Support's `String#blank?`: empty, or only Unicode whitespace. */
export function isBlank(value: string): boolean {
  return /^\p{White_Space}*$/u.test(value);
}

/** `Object#presence` for an optional string. */
export function presence(value: string | undefined): string | undefined {
  return value === undefined || isBlank(value) ? undefined : value;
}

/** `String#chomp("")`: every trailing `\n` or `\r\n`, but not a lone `\r`. */
export function chompNewlines(value: string): string {
  let end = value.length;
  while (value[end - 1] === "\n") end -= value[end - 2] === "\r" ? 2 : 1;
  return value.slice(0, end);
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** `ERB::Util.html_escape` */
export function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/** `ERB::Util.url_encode`: every UTF-8 byte but `a-z`, `A-Z`, `0-9`, `_`, `-`, `.` and `~` as `%XX`. */
export function urlEncode(value: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) {
    const c = String.fromCharCode(byte);
    encoded += /[a-zA-Z0-9_.~-]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/** `String#chomp`: one trailing `\r\n`, `\n` or `\r`. */
export function chomp(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  return value.endsWith("\n") || value.endsWith("\r") ? value.slice(0, -1) : value;
}

/**
 * Active Support's `String#truncate(length, omission: "…")`, in characters: a string longer than
 * `length` keeps as many as fit before the omission.
 */
export function truncate(value: string, length: number, omission = "…"): string {
  const characters = Array.from(value);
  if (characters.length <= length) return value;
  return characters.slice(0, length - Array.from(omission).length).join("") + omission;
}
