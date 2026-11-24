import { useEffect, useEffectEvent, useRef, useState } from "react";
import { CLIP_BITRATES, clipType, MAX_CLIP_SECONDS, recordedClip } from "@/lib/clip-recording";
import type { ClipKind } from "@/lib/clips";

/** A clip being recorded: its recorder, when it started and was stopped, and whether it's to be handed over once it stops. */
interface Recording {
  recorder: MediaRecorder;
  startedAt: number;
  stoppedAt: number | null;
  keep: boolean;
}

/** How often the time a clip has run is looked at, which is how late it stops past five minutes at most. */
const TICK = 250;

/**
 * Records a `kind` of clip from a stream, as the composer's clips are: `start` begins it, and `stop` ends
 * it, after which `onRecorded` has the clip, as it does once five minutes are up, when it stops by itself,
 * and once what it records ends, as a camera unplugged does. `discard` ends it without handing it over,
 * until it has been, and what records it going discards it too. Where the browser fails as it records,
 * what it recorded is cut short, so it's discarded, and `onFailed` hears that it couldn't record.
 * `recording` is whether it's under way, until it's handed over, and `seconds` how long it has run.
 */
export function useClipRecorder(kind: ClipKind, onRecorded: (clip: File) => void, onFailed: () => void) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const recording = useRef<Recording | null>(null);
  const recorded = useEffectEvent(onRecorded);
  const failed = useEffectEvent(onFailed);

  // Discarding a clip that was stopped to keep, before it's handed over, still discards it.
  const finish = (keep: boolean) => {
    const current = recording.current;
    if (!current) return;
    current.keep &&= keep;
    if (current.stoppedAt !== null) return;
    current.stoppedAt = performance.now();
    if (current.recorder.state !== "inactive") current.recorder.stop();
  };
  const finished = useEffectEvent(finish);

  /** Starts recording `stream`, answering whether the browser could. */
  const start = (stream: MediaStream): boolean => {
    finish(false);
    const type = clipType(kind);
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { ...CLIP_BITRATES[kind], ...(type && { mimeType: type }) });
      recorder.start(1000);
    } catch {
      return false;
    }
    const current: Recording = { recorder, startedAt: performance.now(), stoppedAt: null, keep: true };
    const chunks: Blob[] = [];
    const at = new Date();
    recorder.addEventListener("dataavailable", ({ data }) => data.size > 0 && chunks.push(data));
    // A browser that fails as it records, as when its encoder gives out, says so, then hands over what it
    // had and stops as though it had been stopped. What it had is cut short, so nothing is handed over.
    recorder.addEventListener("error", () => {
      if (recording.current !== current) return;
      recording.current = null;
      setStartedAt(null);
      if (current.keep) failed();
      current.keep = false;
    });
    recorder.addEventListener("stop", async () => {
      const milliseconds = (current.stoppedAt ??= performance.now()) - current.startedAt;
      const clip = current.keep ? await recordedClip(kind, new Blob(chunks, { type: recorder.mimeType || type }), milliseconds, at) : null;
      // One started since has taken its place.
      if (recording.current !== current) return;
      recording.current = null;
      setStartedAt(null);
      if (clip && current.keep) recorded(clip);
    });
    recording.current = current;
    setStartedAt(current.startedAt);
    setSeconds(0);
    return true;
  };

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => {
      if (recording.current?.stoppedAt !== null) return;
      const elapsed = (performance.now() - startedAt) / 1000;
      setSeconds(Math.min(elapsed, MAX_CLIP_SECONDS));
      if (elapsed >= MAX_CLIP_SECONDS) finished(true);
    }, TICK);
    return () => clearInterval(timer);
  }, [startedAt]);

  // Whatever is still recording as what records it goes is discarded.
  useEffect(() => () => finished(false), []);

  return { recording: startedAt !== null, seconds, start, stop: () => finish(true), discard: () => finish(false) };
}
