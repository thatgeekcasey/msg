import { describe, expect, it } from "vitest";
import { withDuration } from "./webm-duration";

const EBML_HEADER = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01];
const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const INFO_ID = [0x15, 0x49, 0xa9, 0x66];
/** A timestamp scale of a millisecond, and the muxer's name, as MediaRecorder's Info has them. */
const INFO_DATA = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40, 0x4d, 0x80, 0x84, ...new TextEncoder().encode("test")];
const TRACKS = [0x16, 0x54, 0xae, 0x6b, 0x80];
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN_SIZE, 0xe7, 0x81, 0x00];

const webm = (segmentSize = UNKNOWN_SIZE, beforeInfo: number[] = [], infoData = INFO_DATA) =>
  Uint8Array.from([...EBML_HEADER, ...SEGMENT_ID, ...segmentSize, ...beforeInfo, ...INFO_ID, 0x80 | infoData.length, ...infoData, ...TRACKS, ...CLUSTER]);

const SEEK_HEAD_ID = [0x11, 0x4d, 0x9b, 0x74];
/** A SeekHead that says where the Tracks are, 38 bytes into the segment, after it and the Info, as a muxer that writes one does. */
const SEEK_HEAD = [...SEEK_HEAD_ID, 0x8e, 0x4d, 0xbb, 0x8b, 0x53, 0xab, 0x84, ...TRACKS.slice(0, 4), 0x53, 0xac, 0x81, 0x26];
/** A Duration of 0, as a float eight bytes long. */
const NO_DURATION = [0x44, 0x89, 0x88, 0, 0, 0, 0, 0, 0, 0, 0];

/** An element's size as Firefox writes every one it starts and ends, in eight bytes. */
const size8 = (size: number) => [0x01, 0, 0, 0, 0, 0, 0, size];
const ascii = (text: string) => [...new TextEncoder().encode(text)];
/** Its EBML header: version 1, IDs of up to four bytes and sizes of up to eight, and the DocType webm, version 2. */
const FIREFOX_HEADER_DATA = [0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84, ...ascii("webm"), 0x42, 0x87, 0x81, 0x02, 0x42, 0x85, 0x81, 0x02];
/** Its Info: a timestamp scale of a millisecond, a Duration of 0, and the muxer's and writer's names. */
const FIREFOX_INFO_DATA = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40, ...NO_DURATION, 0x4d, 0x80, 0x98, ...ascii("QTmuxingAppLibWebM-0.0.1"), 0x57, 0x41, 0x99, ...ascii("QTwritingAppLibWebM-0.0.1")];

/**
 * A recording's start as Firefox's MediaRecorder writes it (its `EbmlComposer::GenerateHeader`, with
 * libmkv): a segment of unknown size, an empty SeekHead, and an Info that says the recording is 0 long.
 */
const firefoxWebm = () =>
  Uint8Array.from([
    ...[0x1a, 0x45, 0xdf, 0xa3, ...size8(FIREFOX_HEADER_DATA.length), ...FIREFOX_HEADER_DATA],
    ...SEGMENT_ID,
    ...UNKNOWN_SIZE,
    ...SEEK_HEAD_ID,
    ...size8(0),
    ...[...INFO_ID, ...size8(FIREFOX_INFO_DATA.length), ...FIREFOX_INFO_DATA],
    ...TRACKS,
    ...CLUSTER,
  ]);

/** The file as it's put back together: the new start, then the rest of the old. */
const patched = (file: Uint8Array, milliseconds: number) => {
  const result = withDuration(file, milliseconds)!;
  return Uint8Array.from([...result.head, ...file.subarray(result.replaced)]);
};

const indexOf = (bytes: Uint8Array, sought: number[]) => bytes.findIndex((_, at) => sought.every((byte, i) => bytes[at + i] === byte));

describe("withDuration", () => {
  it("writes how long a WebM is into its Info, in the Info's units, after what it had, and leaves the rest as it was", () => {
    const file = patched(webm(), 1500);
    const info = indexOf(file, INFO_ID);
    // The Info's size grows by the duration's 11 bytes, written in 8.
    expect([...file.subarray(info + 4, info + 12)]).toEqual([0x01, 0, 0, 0, 0, 0, 0, INFO_DATA.length + 11]);
    expect([...file.subarray(info + 12, info + 12 + INFO_DATA.length)]).toEqual(INFO_DATA);
    const duration = info + 12 + INFO_DATA.length;
    expect([...file.subarray(duration, duration + 3)]).toEqual([0x44, 0x89, 0x88]);
    expect(new DataView(file.buffer, duration + 3, 8).getFloat64(0)).toBe(1500);
    expect([...file.subarray(duration + 11)]).toEqual([...TRACKS, ...CLUSTER]);
    expect([...file.subarray(0, info)]).toEqual([...EBML_HEADER, ...SEGMENT_ID, ...UNKNOWN_SIZE]);
  });

  it("counts the duration in the Info's own units", () => {
    // A timestamp scale of a microsecond, which counts 1.5 seconds as 1,500,000.
    const infoData = [0x2a, 0xd7, 0xb1, 0x82, 0x03, 0xe8];
    const file = patched(webm(UNKNOWN_SIZE, [], infoData), 1500);
    const duration = indexOf(file, [0x44, 0x89, 0x88]);
    expect(new DataView(file.buffer, duration + 3, 8).getFloat64(0)).toBe(1_500_000);
  });

  it("grows a segment that says how big it is by what the Info grew", () => {
    const rest = INFO_ID.length + 1 + INFO_DATA.length + TRACKS.length + CLUSTER.length;
    const file = patched(webm([0x01, 0, 0, 0, 0, 0, 0, rest]), 1000);
    const segment = indexOf(file, SEGMENT_ID);
    // The Info's size went from 1 byte to 8, and it gained the duration's 11.
    expect([...file.subarray(segment + 4, segment + 12)]).toEqual([0x01, 0, 0, 0, 0, 0, 0, rest + 7 + 11]);
    expect(file.length - (segment + 12)).toBe(rest + 7 + 11);
  });

  it("writes how long a recording of Firefox's is over the 0 its Info says, in its place, past its empty SeekHead, leaving the rest as it was", () => {
    const file = firefoxWebm();
    const result = withDuration(file, 2500)!;
    const duration = indexOf(file, NO_DURATION) + 3;
    expect(result.replaced).toBe(duration + 8);
    const written = Uint8Array.from([...result.head, ...file.subarray(result.replaced)]);
    expect(new DataView(written.buffer, duration, 8).getFloat64(0)).toBe(2500);
    expect([...written.subarray(0, duration)]).toEqual([...file.subarray(0, duration)]);
    expect([...written.subarray(duration + 8)]).toEqual([...file.subarray(duration + 8)]);
  });

  it("writes over a Duration of 0 in its place past a SeekHead that points past it, as that moves nothing, however long the float", () => {
    const file = webm(UNKNOWN_SIZE, SEEK_HEAD, [...INFO_DATA, 0x44, 0x89, 0x84, 0, 0, 0, 0]);
    const written = patched(file, 1500);
    expect(written.length).toBe(file.length);
    expect(new DataView(written.buffer, written.length - TRACKS.length - CLUSTER.length - 4, 4).getFloat32(0)).toBe(1500);
  });

  it("adds a Duration after an empty SeekHead, which points at nothing it would move", () => {
    const emptySeekHead = [...SEEK_HEAD_ID, 0x80];
    const file = patched(webm(UNKNOWN_SIZE, emptySeekHead), 1000);
    const duration = indexOf(file, [0x44, 0x89, 0x88]);
    expect(new DataView(file.buffer, duration + 3, 8).getFloat64(0)).toBe(1000);
    expect([...file.subarray(indexOf(file, SEGMENT_ID) + 12, indexOf(file, INFO_ID))]).toEqual(emptySeekHead);
  });

  it("leaves alone a file that isn't a WebM, one that says how long it is, one whose SeekHead points past the Info it would grow, and a start too short to hold its Info", () => {
    expect(withDuration(new TextEncoder().encode("\0\0\0\x20ftypisom"), 1000)).toBeNull();
    expect(withDuration(webm(UNKNOWN_SIZE, [], [...INFO_DATA, 0x44, 0x89, 0x84, 0x45, 0x9c, 0x40, 0x00]), 1000)).toBeNull();
    expect(withDuration(webm(UNKNOWN_SIZE, [], [...INFO_DATA, 0x44, 0x89, 0x88, 0x40, 0xb3, 0x88, 0, 0, 0, 0, 0]), 1000)).toBeNull();
    expect(withDuration(webm(UNKNOWN_SIZE, SEEK_HEAD), 1000)).toBeNull();
    expect(withDuration(webm().subarray(0, EBML_HEADER.length + 16), 1000)).toBeNull();
    expect(withDuration(firefoxWebm().subarray(0, indexOf(firefoxWebm(), NO_DURATION) + 6), 1000)).toBeNull();
  });
});
