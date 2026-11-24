import type { ClipKind } from "./clips";
import { withDuration } from "./webm-duration";

// How the composer's clips are recorded: as what, how fast, named how, and for how long at most.

/** How long a clip may be, in seconds, after which it stops by itself. */
export const MAX_CLIP_SECONDS = 5 * 60;

/**
 * The types a clip is recorded as, in the order tried: MP4 with H.264 and AAC, which every browser plays,
 * as Safari and Chrome on a Mac or Windows record, then any MP4 the browser records, which says how long it
 * is, and last WebM, as Firefox records, which the clip has its length written into.
 */
const TYPES: Record<ClipKind, readonly string[]> = {
  video: ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"],
  audio: ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm"],
};

/** How many bits a second a clip is recorded at, which keeps five minutes of video to about 75 MB. */
export const CLIP_BITRATES: Record<ClipKind, MediaRecorderOptions> = {
  video: { videoBitsPerSecond: 1_900_000, audioBitsPerSecond: 96_000 },
  audio: { audioBitsPerSecond: 96_000 },
};

/** The type a `kind` of clip is recorded as here, or empty, to take whatever the browser records. */
export const clipType = (kind: ClipKind) => TYPES[kind].find((type) => MediaRecorder.isTypeSupported(type)) ?? "";

/** The extension a clip's file name ends in, for its type without its codecs. */
function extensionOf(type: string): string {
  if (type === "audio/mp4") return "m4a";
  if (type.endsWith("/mp4")) return "mp4";
  if (type.endsWith("/ogg")) return "ogg";
  return "webm";
}

/**
 * A clip's file name, which says when it was recorded, as a Mac names a screen recording:
 * "Video clip 2026-11-17 at 6.45.12 PM.mp4", in the time's local form, with dots for colons, which
 * Windows keeps out of names.
 */
export function clipName(kind: ClipKind, at: Date, type: string): string {
  const day = [at.getFullYear(), at.getMonth() + 1, at.getDate()].map((part) => String(part).padStart(2, "0")).join("-");
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).replaceAll(":", ".").replace(/\s+/g, " ");
  return `${kind === "video" ? "Video" : "Audio"} clip ${day} at ${time}.${extensionOf(type)}`;
}

/** How much of a WebM's start holds what comes before its first picture or sound, its Info among it. */
const WEBM_HEAD = 64 * 1024;

/**
 * The clip `recording` is, recorded at `at` for `milliseconds`, as a file of its type without its codecs,
 * named for when it was recorded. A WebM has its length written in, which MediaRecorder leaves out.
 */
export async function recordedClip(kind: ClipKind, recording: Blob, milliseconds: number, at: Date): Promise<File> {
  const type = recording.type.split(";")[0]!.trim() || `${kind}/webm`;
  let clip = recording;
  if (type.endsWith("/webm")) {
    const written = withDuration(new Uint8Array(await recording.slice(0, WEBM_HEAD).arrayBuffer()), milliseconds);
    if (written) clip = new Blob([written.head, recording.slice(written.replaced)]);
  }
  return new File([clip], clipName(kind, at, type), { type });
}

/** How long a clip has run, as its recorder shows it: minutes and seconds, as 0:07 or 4:59. */
export function clipTime(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
