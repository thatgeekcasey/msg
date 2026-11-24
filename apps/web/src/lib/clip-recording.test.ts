import { afterEach, describe, expect, it, vi } from "vitest";
import { clipName, clipTime, clipType, recordedClip } from "./clip-recording";

/** A browser's MediaRecorder that records `supported` types alone. */
function recorderRecording(...supported: string[]) {
  vi.stubGlobal("MediaRecorder", Object.assign(function MediaRecorder() {}, { isTypeSupported: (type: string) => supported.includes(type) }));
}

afterEach(() => vi.unstubAllGlobals());

/** A WebM's start, as MediaRecorder writes it: its header, a segment of unknown size, and Info, counting in milliseconds, without a duration. */
const WEBM_START = [
  ...[0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01],
  ...[0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  ...[0x15, 0x49, 0xa9, 0x66, 0x87, 0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40],
];
/** What follows it: Tracks, then a cluster. */
const WEBM_REST = [0x16, 0x54, 0xae, 0x6b, 0x80, 0x1f, 0x43, 0xb6, 0x75, 0x80];

describe("clip recording", () => {
  it("records MP4 with H.264 and AAC where the browser can, as every browser plays, then any MP4, then WebM", () => {
    recorderRecording("video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm", "audio/mp4", "audio/webm;codecs=opus");
    expect(clipType("video")).toBe("video/mp4;codecs=avc1.42E01E,mp4a.40.2");
    expect(clipType("audio")).toBe("audio/mp4");

    recorderRecording("video/webm;codecs=vp8,opus", "video/webm", "audio/webm;codecs=opus", "audio/webm");
    expect(clipType("video")).toBe("video/webm;codecs=vp8,opus");
    expect(clipType("audio")).toBe("audio/webm;codecs=opus");

    recorderRecording();
    expect(clipType("video")).toBe("");
  });

  it("names a clip for when it was recorded, with dots for colons, and the extension of its type", () => {
    const at = new Date(2026, 10, 7, 18, 5, 9);
    const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).replaceAll(":", ".").replace(/\s+/g, " ");
    expect(clipName("video", at, "video/mp4")).toBe(`Video clip 2026-11-07 at ${time}.mp4`);
    expect(clipName("audio", at, "audio/mp4")).toBe(`Audio clip 2026-11-07 at ${time}.m4a`);
    expect(clipName("audio", at, "audio/webm")).toBe(`Audio clip 2026-11-07 at ${time}.webm`);
    expect(clipName("audio", at, "audio/ogg")).toBe(`Audio clip 2026-11-07 at ${time}.ogg`);
    expect(time).not.toContain(":");
  });

  it("makes a recording a file of its type without its codecs, writing a WebM's length into it, and leaving an MP4 as it is", async () => {
    const at = new Date(2026, 10, 7, 18, 5, 9);
    const webm = await recordedClip("video", new Blob([Uint8Array.from([...WEBM_START, ...WEBM_REST])], { type: "video/webm;codecs=vp9,opus" }), 2500, at);
    expect(webm.type).toBe("video/webm");
    expect(webm.name).toBe(clipName("video", at, "video/webm"));
    const bytes = new Uint8Array(await webm.arrayBuffer());
    // The Info's size is written in eight bytes now, seven more than it was, and holds the duration after what it had.
    const duration = WEBM_START.length + 7;
    expect([...bytes.subarray(duration, duration + 3)]).toEqual([0x44, 0x89, 0x88]);
    expect(new DataView(bytes.buffer, duration + 3, 8).getFloat64(0)).toBe(2500);
    expect([...bytes.subarray(duration + 11)]).toEqual(WEBM_REST);

    const mp4 = new Blob([new TextEncoder().encode("\0\0\0\x18ftypmp42")], { type: "audio/mp4" });
    const clip = await recordedClip("audio", mp4, 2500, at);
    expect(clip.type).toBe("audio/mp4");
    expect(clip.name.endsWith(".m4a")).toBe(true);
    expect(await clip.text()).toBe(await mp4.text());
  });

  it("calls a recording that doesn't say its type a WebM of its kind, as only WebM's recorders leave it out", async () => {
    const clip = await recordedClip("audio", new Blob(["sound"]), 1000, new Date());
    expect(clip.type).toBe("audio/webm");
  });

  it("shows how long a clip has run in minutes and seconds", () => {
    expect(clipTime(0)).toBe("0:00");
    expect(clipTime(7.9)).toBe("0:07");
    expect(clipTime(299.99)).toBe("4:59");
    expect(clipTime(300)).toBe("5:00");
  });
});
