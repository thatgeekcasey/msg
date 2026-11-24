// Slack's clips: video and audio recorded from the composer, which wait there to go with the next message
// as files, up to five minutes long, as Slack's are. How they're recorded is in clip-recording.ts, which loads
// with their recorders.

export type ClipKind = "video" | "audio";

/** Whether this browser can record a clip: one that records media, on a page given a camera and microphone, which plain HTTP isn't. */
export const recordsClips = () => typeof MediaRecorder === "function" && typeof navigator.mediaDevices?.getUserMedia === "function";

/** Where in each video clip its poster is to be taken from, as the person who recorded it chose. */
const posterTimes = new WeakMap<File, number>();

/** Has the poster of `clip` taken from `seconds` in, as its thumbnail was chosen. */
export const choosePoster = (clip: File, seconds: number) => void posterTimes.set(clip, seconds);

/** Where in `file` its poster was chosen from, in seconds, if it was. */
export const posterTimeOf = (file: File): number | undefined => posterTimes.get(file);
