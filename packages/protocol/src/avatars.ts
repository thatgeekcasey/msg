// Campfire's generated avatars (Users::AvatarsHelper): someone's initials in white on one of 18 colors,
// picked by the CRC32 of their id, drawn by users/avatars/show.svg. The Worker serves it as their
// avatar, and the app shows it while a served one loads.

const AVATAR_COLORS = [
  "#AF2E1B", "#CC6324", "#3B4B59", "#BFA07A", "#ED8008", "#ED3F1C", "#BF1B1B", "#736B1E", "#D07B53",
  "#736356", "#AD1D1D", "#BF7C2A", "#C09C6F", "#698F9C", "#7C956B", "#5D618F", "#3B3633", "#67695E",
];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** `text` as UTF-8, as TextEncoder encodes it, which this package, written for any runtime, can't count on. */
function* utf8(text: string): Generator<number> {
  for (const char of text) {
    let code = char.codePointAt(0)!;
    // A surrogate left on its own, which TextEncoder replaces.
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) yield code;
    else if (code < 0x800) yield* [0xc0 | (code >> 6), 0x80 | (code & 0x3f)];
    else if (code < 0x10000) yield* [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)];
    else yield* [0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)];
  }
}

/** zlib's CRC32 of `text` as UTF-8, which Ruby's `Zlib.crc32` gives too. */
export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (const byte of utf8(text)) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** `avatar_background_color(user)`: the color the CRC32 of their id picks. */
export function avatarColor(userId: string): string {
  return AVATAR_COLORS[crc32(userId) % AVATAR_COLORS.length]!;
}

const ASCII_WORD = /^[A-Za-z0-9_]$/;
/** What Ruby's `\b` counts as part of a word: a letter or digit of any script, or `_`. */
const WORD = /^[\p{Alphabetic}\p{N}_]$/u;

/**
 * `User#initials`, Campfire's `name.scan(/\b\w/).join`: every ASCII letter, digit or underscore that
 * doesn't follow a letter, digit or underscore of any script, as many as there are, so "Élodie" has
 * none and "Élodie Ünal-Smith o'Brien 3po _x ñ" is "SoB3_".
 */
export function initials(name: string): string {
  let found = "";
  let previous = "";
  for (const char of name) {
    if (ASCII_WORD.test(char) && !WORD.test(previous)) found += char;
    previous = char;
  }
  return found;
}

/**
 * Someone's initials avatar, byte for byte as Campfire renders users/avatars/show.svg: three or more
 * initials are squeezed to fit, and a name with none gets a plain tile. Initials are ASCII letters,
 * digits and underscores, so nothing in it needs escaping.
 */
export function avatarSvg(userId: string, name: string): string {
  const shown = initials(name);
  return [
    `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`,
    `  viewBox="0 0 512 512" class="avatar" aria-hidden="true">`,
    `  <defs>`,
    `    <clipPath id="porthole">`,
    `      <circle cx="50%" cy="50%" r="50%" />`,
    `    </clipPath>`,
    `  </defs>`,
    ``,
    `  <g>`,
    `    <rect width="100%" height="100%" rx="50" fill="${avatarColor(userId)}" />`,
    ``,
    `    <text x="50%" y="50%" fill="#FFFFFF"`,
    `      text-anchor="middle" dy="0.35em"`,
    `      ${shown.length >= 3 ? `textLength="85%" lengthAdjust="spacingAndGlyphs"` : ""}`,
    `      font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif"`,
    `      font-size="230"`,
    `      font-weight="800"`,
    `      letter-spacing="-5">`,
    `      ${shown}`,
    `    </text>`,
    `  </g>`,
    `</svg>`,
    ``,
  ].join("\n");
}

// Avatars, which people upload on their profile and the setup and sign-up forms, and the Worker keeps in
// R2 with the one variant Campfire serves of them, `:square`. The uploader's browser makes the variant.

/** Where your avatar goes: `PUT` uploads one, as a form's `avatar` and `variant`, and `DELETE` removes it. */
export const AVATAR_PATH = "/api/users/me/avatar";

/** The box an avatar's variant fits within, as Campfire's `:square` scales it. */
export const AVATAR_BOX = 512;

/**
 * The largest avatar Ember takes, in decimal bytes: the Worker reads an avatar into memory to keep it,
 * and a Worker has 128 MB for every request at once.
 */
export const MAX_AVATAR_SIZE = 16_000_000;

/** What the Worker's 413 and the app say of a larger one. */
export const AVATAR_TOO_LARGE = "Photos must be 16 MB or smaller.";

// The workspace's logo, which administrators upload as people upload avatars, and the Worker keeps in R2
// with the two variants Campfire serves of it, `:large` and `:small`, which the uploader's browser makes
// too.

/** Where the workspace's logo goes: `PUT` uploads one, as a form's `logo`, `large` and `small`, and `DELETE` removes it. */
export const LOGO_PATH = "/api/account/logo";

/** The boxes a logo's variants fit within, as Campfire's `:large` and `:small` scale it. */
export const LOGO_BOXES = { large: 512, small: 192 } as const;

/** The largest logo Ember takes, as for an avatar. */
export const MAX_LOGO_SIZE = MAX_AVATAR_SIZE;

/** What the Worker's 413 and the app say of a larger one. */
export const LOGO_TOO_LARGE = "Logos must be 16 MB or smaller.";
