// A WebM recorded by MediaRecorder says nothing of how long it is, as Chrome records one, or says 0, as
// Firefox records clips, which leaves a player with no length to show, or to seek by, until it has read
// the whole file. This writes the length it was recorded for into the file's Info, as a muxer that knew
// it would have.

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const INFO = 0x1549a966;
const TIMESTAMP_SCALE = 0x2ad7b1;
const DURATION = 0x4489;

/** What a WebM's Info counts its times in, in nanoseconds, unless it says otherwise: a millisecond. */
const DEFAULT_SCALE = 1_000_000;

/** An element of the file, from where it starts: its ID, where its data starts, and its data's size, which a segment can leave unknown. */
interface Element {
  id: number;
  start: number;
  dataStart: number;
  size: number | null;
}

/**
 * The variable-length number at `at` in `bytes`, as WebM writes an element's ID, with its marker, and its
 * size, without, which is unknown where every bit after the marker is set. Null where `bytes` end first.
 */
function numberAt(bytes: Uint8Array, at: number, withMarker: boolean): { value: number; length: number; unknown: boolean } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) return null;
  const mask = 0xff >> length;
  let value = withMarker ? first : first & mask;
  let unknown = (first & mask) === mask;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i]!;
    if (bytes[at + i] !== 0xff) unknown = false;
  }
  return { value, length, unknown: !withMarker && unknown };
}

/** The element at `at`, or null where `bytes` end before its data starts. */
function elementAt(bytes: Uint8Array, at: number): Element | null {
  const id = numberAt(bytes, at, true);
  const size = id && numberAt(bytes, at + id.length, false);
  if (!id || !size) return null;
  return { id: id.value, start: at, dataStart: at + id.length + size.length, size: size.unknown ? null : size.value };
}

/** `value` as a size eight bytes long, which any size up to 2^56 fits. */
function sizeOf8(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  bytes[0] = 0x01;
  for (let i = 7, left = value; i > 0; i--, left = Math.floor(left / 256)) bytes[i] = left % 256;
  return bytes;
}

/** An unsigned integer `length` bytes long at `at`. */
function uintAt(bytes: Uint8Array, at: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[at + i]!;
  return value;
}

/** What a WebM's start becomes with its length written in: `head` in place of its first `replaced` bytes. */
export interface WithDuration {
  head: Uint8Array<ArrayBuffer>;
  replaced: number;
}

/**
 * `bytes`' start to the end of the Info's Duration `written` with `time` written over it, which moves
 * nothing, or null where it says how long the file is already, or isn't a float.
 */
function overDuration(bytes: Uint8Array, written: Element, time: number): WithDuration | null {
  const size = written.size!;
  if (size !== 4 && size !== 8) return null;
  const end = written.dataStart + size;
  const head = bytes.slice(0, end);
  const float = new DataView(head.buffer, written.dataStart, size);
  const length = size === 8 ? float.getFloat64(0) : float.getFloat32(0);
  if (Number.isFinite(length) && length > 0) return null;
  if (size === 8) float.setFloat64(0, time);
  else float.setFloat32(0, time);
  return { head, replaced: end };
}

/**
 * The start of the WebM whose start is `bytes` with `milliseconds` written into its Info as its duration,
 * which `bytes` must hold to the end of: over the Duration of 0 Firefox writes, in its place, or else
 * added to the Info. Null for anything else: a file that isn't a WebM, one that says how long it is
 * already, one whose start `bytes` doesn't hold, and one whose SeekHead points at what adding to the Info
 * would move.
 */
export function withDuration(bytes: Uint8Array, milliseconds: number): WithDuration | null {
  const header = elementAt(bytes, 0);
  if (header?.id !== EBML || header.size === null) return null;
  const segment = elementAt(bytes, header.dataStart + header.size);
  if (segment?.id !== SEGMENT) return null;

  // Firefox's SeekHead, before its Info, is empty, pointing at nothing.
  let seeks = false;
  let info: Element | null = null;
  for (let at = segment.dataStart; !info; ) {
    const child = elementAt(bytes, at);
    if (!child || child.size === null) return null;
    if (child.id === SEEK_HEAD && child.size > 0) seeks = true;
    if (child.id === INFO) info = child;
    at = child.dataStart + child.size;
  }
  const infoEnd = info.dataStart + info.size!;
  if (infoEnd > bytes.length) return null;

  let scale = DEFAULT_SCALE;
  let written: Element | null = null;
  for (let at = info.dataStart; at < infoEnd; ) {
    const child = elementAt(bytes, at);
    if (!child || child.size === null || child.dataStart + child.size > infoEnd) return null;
    if (child.id === TIMESTAMP_SCALE) scale = uintAt(bytes, child.dataStart, child.size);
    if (child.id === DURATION) written = child;
    at = child.dataStart + child.size;
  }
  const time = (milliseconds * 1_000_000) / scale;
  if (written) return overDuration(bytes, written, time);
  if (seeks) return null;

  // Duration's ID, its size, which is 8, and the time as a float, in the Info's units.
  const duration = new Uint8Array(11);
  duration.set([0x44, 0x89, 0x88]);
  new DataView(duration.buffer).setFloat64(3, time);

  const infoId = bytes.subarray(info.start, info.start + numberAt(bytes, info.start, true)!.length);
  const infoData = bytes.subarray(info.dataStart, infoEnd);
  const newInfo = [infoId, sizeOf8(info.size! + duration.length), infoData, duration];
  const grown = newInfo.reduce((length, part) => length + part.length, 0) - (infoEnd - info.start);

  // A segment that says how big it is says so again, grown by what the Info grew.
  const segmentId = bytes.subarray(segment.start, segment.start + numberAt(bytes, segment.start, true)!.length);
  const segmentSize = segment.size === null ? bytes.subarray(segment.start + segmentId.length, segment.dataStart) : sizeOf8(segment.size + grown);
  const parts = [bytes.subarray(0, segment.start), segmentId, segmentSize, bytes.subarray(segment.dataStart, info.start), ...newInfo];

  const head = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    head.set(part, at);
    at += part.length;
  }
  return { head, replaced: infoEnd };
}
