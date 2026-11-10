// The byte ranges a request asks for, as Rack 3.2 reads its Range header, Ruby's string quirks and all.

/** An inclusive range of a file's bytes. */
export type ByteRange = readonly [start: number, end: number];

/** `Rack::Utils::MAX_RANGES`' count of commas: a header with this many asks for too much and gets the whole file. */
const MAX_COMMAS = 100;

/** Ruby's whitespace, which `String#to_i` skips. */
const SPACE = /^[\t\n\v\f\r ]*/;

/**
 * `Rack::Utils.get_byte_ranges(header, size)`: null to send the whole file, an empty list for 416, or the
 * inclusive ranges asked for, each within `size`, in the order asked.
 */
export function byteRanges(header: string | null, size: number): ByteRange[] | null {
  if (size === 0 || header === null) return null;
  const spec = rangeSpec(header);
  if (spec === null || spec.split(",").length - 1 >= MAX_COMMAS) return null;
  const ranges: ByteRange[] = [];
  for (const range of rubySplit(spec, /,[ \t]*/)) {
    if (!range.includes("-")) return null;
    // Split on "-" first, so neither end can be negative.
    const [first, second] = rubySplit(range, /-/);
    let start: number, end: number;
    if (first === undefined || first === "") {
      if (second === undefined) return null;
      [start, end] = [Math.max(size - rubyToI(second), 0), size - 1];
    } else {
      start = rubyToI(first);
      if (second === undefined) end = size - 1;
      else {
        end = rubyToI(second);
        if (end < start) return null;
        end = Math.min(end, size - 1);
      }
    }
    if (start <= end) ranges.push([start, end]);
  }
  return ranges.reduce((total, [start, end]) => total + end - start + 1, 0) > size ? [] : ranges;
}

/** `header =~ /bytes=([^;]+)/`: what follows the first `bytes=` that something other than `;` follows, up to the next `;`. */
function rangeSpec(header: string): string | null {
  return /bytes=([^;]+)/.exec(header)?.[1] ?? null;
}

/** `String#split(pattern)`, which drops the empty fields at the end. */
function rubySplit(text: string, pattern: RegExp): string[] {
  const fields = text.split(pattern);
  while (fields.at(-1) === "") fields.pop();
  return fields;
}

/**
 * `String#to_i`: leading whitespace and a sign, then an optional `0d`, then digits, with an underscore
 * allowed between two, stopping at anything else. It stops growing past the largest safe integer, beyond
 * any file's size.
 */
function rubyToI(text: string): number {
  let rest = text.replace(SPACE, "");
  const negative = rest.startsWith("-");
  if (negative || rest.startsWith("+")) rest = rest.slice(1);
  if (/^0d/i.test(rest)) rest = rest.slice(2);
  let number = 0;
  let afterDigit = false;
  for (const character of rest) {
    if (character >= "0" && character <= "9") {
      number = Math.min(number * 10 + Number(character), Number.MAX_SAFE_INTEGER);
      afterDigit = true;
    } else if (character === "_" && afterDigit) afterDigit = false;
    else break;
  }
  return negative ? -number : number;
}
