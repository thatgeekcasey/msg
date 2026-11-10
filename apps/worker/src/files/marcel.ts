import { extname } from "./filename";
import { EXTENSIONS, MAGIC, TYPE_PARENTS, type Match } from "./marcel-tables";

// Marcel 1.1.0's content type identification (`Marcel::MimeType.for`), which Active Storage names each
// upload's type with, over the same tables.

export const BINARY = "application/octet-stream";

const typesByExtension = new Map(EXTENSIONS);
const parentsByType = new Map(TYPE_PARENTS);

/** A match with its bytes as bytes. */
interface ByteMatch {
  offset: number;
  end: number | null;
  value: Uint8Array | null;
  children: ByteMatch[];
}

const bytesOf = (value: string) => Uint8Array.from(value, (c) => c.charCodeAt(0));
const toByteMatch = ([offset, end, value, children = []]: Match): ByteMatch => ({
  offset,
  end,
  value: value === null ? null : bytesOf(value),
  children: children.map(toByteMatch),
});

let magic: [string, ByteMatch[]][] | null = null;
/** `MAGIC` with its bytes made once, on the first file a Worker identifies. */
const magicTable = () => (magic ??= MAGIC.map(([type, matches]) => [type.toLowerCase(), matches.map(toByteMatch)]));

/**
 * `Marcel::MimeType.for(io, name:, declared_type:)`, as `ActiveStorage::Blob#extract_content_type` calls it
 * on upload: the most specific of the type `data`'s bytes say, the type it was declared as, and its name's
 * extension's, a later one winning only when it's a kind of the one before.
 */
export function identify(data: Uint8Array, name: string, declaredType: string): string {
  return mostSpecificType([byMagic(data), forDeclaredType(declaredType), byExtension(extname(name))]);
}

/** `Marcel::Magic.by_extension`: case-insensitive, with or without the leading dot. */
export function byExtension(extension: string): string | null {
  const lowered = extension.toLowerCase();
  return typesByExtension.get(lowered.startsWith(".") ? lowered.slice(1) : lowered) ?? null;
}

/** `Marcel::Magic.child?` */
export function isChild(child: string, parent: string): boolean {
  return child === parent || (parentsByType.get(child) ?? []).some((type) => isChild(type, parent));
}

/** How far into a file a match can look: identifying its first this many bytes says what identifying all of it would. */
const reach = (matches: readonly ByteMatch[]): number =>
  Math.max(0, ...matches.map(({ offset, end, value, children }) => Math.max((end ?? offset) + (value?.length ?? 0), reach(children))));

/** How many of a file's first bytes `byMagic` can look at: 65,555, for the Office rule that looks for `[Content_Types].xml` up to offset 65,536. */
export const magicPrefixLength = () => Math.max(...magicTable().map(([, matches]) => reach(matches)));

/** `Marcel::Magic.by_magic`: the first type in the table whose matches hit. */
export function byMagic(data: Uint8Array): string | null {
  return magicTable().find(([, matches]) => matchesAny(data, matches))?.[0] ?? null;
}

function matchesAny(data: Uint8Array, matches: readonly ByteMatch[]): boolean {
  return matches.some(({ offset, end, value, children }) => {
    if (value === null) return false;
    // `io.read(offset.begin); io.read(offset.end - offset.begin + value.bytesize).include?(value)` for a range.
    const window = read(data, offset, end === null ? value.length : end - offset + value.length);
    const hit = window !== null && (end === null ? equal(window, value) : includes(window, value));
    return hit && (children.length === 0 || matchesAny(data, children));
  });
}

/** `IO#read(length)` after skipping `offset` bytes: null at the end, otherwise up to `length` bytes. */
function read(data: Uint8Array, offset: number, length: number): Uint8Array | null {
  if (length === 0) return new Uint8Array();
  if (offset >= data.length) return null;
  return data.subarray(offset, offset + length);
}

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

function includes(window: Uint8Array, value: Uint8Array): boolean {
  if (value.length === 0) return true;
  for (let start = 0; start + value.length <= window.length; start++) {
    if (equal(window.subarray(start, start + value.length), value)) return true;
  }
  return false;
}

/** Declared types are lowercased, stripped of parameters, and ignored when they're the binary type. */
function forDeclaredType(declaredType: string): string | null {
  const mediaType = declaredType.toLowerCase().split(/[;, \t\n\r\v\f]/)[0]!;
  return mediaType.includes("/") && mediaType !== BINARY ? mediaType : null;
}

/** `most_specific_type(*candidates, BINARY)`: a later candidate wins only when it's a kind of the current pick. */
function mostSpecificType(candidates: (string | null)[]): string {
  const unique = [...new Set([...candidates.filter((candidate) => candidate !== null), BINARY])];
  return unique.slice(1).reduce((pick, candidate) => (isChild(candidate, pick) ? candidate : pick), unique[0]!);
}
