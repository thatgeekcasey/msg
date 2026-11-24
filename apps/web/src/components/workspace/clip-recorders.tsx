import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { Field } from "@/components/field";
import { Microphone, MicrophoneMute, VideoCamera, VideoCameraOff, Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useClipRecorder } from "@/hooks/use-clip-recorder";
import { clipTime, MAX_CLIP_SECONDS } from "@/lib/clip-recording";
import { choosePoster } from "@/lib/clips";
import {
  cameraOf,
  closeDevice,
  facesAway,
  listDevices,
  microphoneOf,
  NO_DEVICES,
  openCameraSized,
  openMicrophone,
  rememberDevice,
  rememberedDevice,
  watchDevices,
  withOpen,
} from "@/lib/huddle-devices";
import { cn } from "@/lib/utils";
import { HuddlePicture } from "./huddle-picture";
import { SELECT } from "./model-picker";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE, MAIN_ACTION, OTHER_ACTION } from "./unsaved-changes";

// Slack's clips, which the composer's Record video clip and Record audio clip record: a video clip in a
// dialog with your camera's picture, an audio clip in the composer's place. Both go as files with the next
// message, and load with the pages few visits need (pages.ts), as few messages need them.

/** What a video clip asks of a camera: a picture as large as a message shows one. */
const CLIP_CAMERA: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
const openClipCamera = (deviceId: string | null) => openCameraSized(deviceId, CLIP_CAMERA);

/** What a recorder says while the browser asks whether Ember may use the camera, or the microphone, and once there's none it may use. */
export const ASKING_FOR_CAMERA = "Waiting for your browser to let Ember use your camera…";
export const NO_CLIP_CAMERA = "Ember has no camera to use. To record a video clip, let this site use your camera in your browser's settings.";
export const ASKING_FOR_MICROPHONE = "Waiting for your browser to let Ember use your microphone…";
export const NO_CLIP_MICROPHONE = "Ember has no microphone to use. To record an audio clip, let this site use your microphone in your browser's settings.";
/** And what a video clip's recorder says once there's a camera but no microphone. */
export const SILENT_CLIP = "Ember has no microphone to use, so the clip will have no sound.";
/** What either says once the browser wouldn't record. */
export const NOT_RECORDED = "Your browser couldn't record a clip. Try again, or upload one from your computer.";

/**
 * The microphone or camera a clip records, which opens as its recorder does, as the one this browser last
 * chose, and closes with it: undefined while the browser asks the person, and null once there's none to
 * use. `choose` opens another in its place, which this browser remembers, as a huddle's choice is.
 */
function useClipDevice(kind: "microphone" | "camera", open: (deviceId: string | null) => Promise<MediaStream | null>) {
  const [stream, setStream] = useState<MediaStream | null>();
  const current = useRef<MediaStream | null>(null);
  // Counts what the browser has been asked, so an answer to anything but the last is closed again.
  const asked = useRef(0);

  const ask = useCallback(
    async (deviceId: string | null) => {
      const asking = ++asked.current;
      closeDevice(current.current);
      current.current = null;
      setStream(undefined);
      const opened = await open(deviceId);
      if (asked.current !== asking) return closeDevice(opened);
      current.current = opened;
      setStream(opened);
    },
    [open],
  );

  useEffect(() => {
    void ask(rememberedDevice(kind));
    return () => {
      asked.current++;
      closeDevice(current.current);
      current.current = null;
    };
  }, [ask, kind]);

  const choose = (deviceId: string) => {
    rememberDevice(kind, deviceId);
    void ask(deviceId);
  };
  return { stream, choose };
}

/** The microphones and cameras the browser lists, by name once one is open, as each opens and as they're plugged in and taken away. */
function useDevices(microphone: MediaStream | null | undefined, camera: MediaStream | null | undefined) {
  const [devices, setDevices] = useState(NO_DEVICES);
  const list = useEffectEvent(() => void listDevices().then(setDevices));
  useEffect(() => watchDevices(() => list()), []);
  useEffect(() => list(), [microphone, camera]);
  return devices;
}

/** An object URL of `blob` while it's shown, let go once it isn't. */
function useObjectUrl(blob: Blob | null): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return setUrl(undefined);
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return url;
}

interface SwitchProps {
  label: string;
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

/** A round switch over the camera's picture, filled in ink while what it switches is on, as a huddle preview's are. */
function ClipSwitch({ label, on, disabled, onClick, children }: SwitchProps) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-10 cursor-pointer place-items-center rounded-full border touch:size-11 disabled:cursor-default disabled:opacity-50 [&_svg]:size-5",
        on ? "border-transparent bg-foreground text-background" : "bg-background text-foreground enabled:hover:bg-hover",
      )}
    >
      {children}
    </button>
  );
}

/** How long a clip has run, of the five minutes it may: a red dot and the time, which screen readers read when asked rather than as it ticks. */
function ClipTimer({ seconds, className }: { seconds: number; className?: string }) {
  return (
    <p role="timer" aria-label={`Recording, ${clipTime(seconds)} of ${clipTime(MAX_CLIP_SECONDS)}`} className={cn("flex items-center gap-1.5 text-[13px] font-semibold tabular-nums", className)}>
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-negative motion-safe:animate-pulse" />
      <span aria-hidden>
        {clipTime(seconds)} / {clipTime(MAX_CLIP_SECONDS)}
      </span>
    </p>
  );
}

/** Keeps a button's words on one line beside the other button, on a phone 320px wide too. */
const ON_ONE_LINE = "whitespace-nowrap upto-480px:px-4";

interface Props {
  /** Has the clip recorded, to go with the next message. */
  onRecorded: (clip: File) => void;
  onClose: () => void;
}

/**
 * Slack's Record video clip: your camera's picture, as a mirror shows you, over the switches that mute the
 * microphone and turn the camera off, and what to record with, then Record. It records up to five minutes,
 * showing how long it has run, until Stop recording, then plays the clip, to choose its thumbnail, the
 * picture it shows before it's played, with Done, which leaves it to go with the next message, or Record
 * again. Opening it asks the browser for the camera and the microphone this browser last chose, and
 * closing it lets go of them, discarding what's recorded but not done.
 */
export function VideoClipDialog({ onRecorded, onClose }: Props) {
  const microphone = useClipDevice("microphone", openMicrophone);
  const camera = useClipDevice("camera", openClipCamera);
  const devices = useDevices(microphone.stream, camera.stream);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [clip, setClip] = useState<File | null>(null);
  const [failed, setFailed] = useState(false);
  const recorder = useClipRecorder("video", setClip, () => setFailed(true));
  const url = useObjectUrl(clip);
  const played = useRef<HTMLVideoElement>(null);
  const [length, setLength] = useState<number | null>(null);
  // Where the thumbnail is taken from, once it's been chosen, and until then a tenth of a second in, as any video's is.
  const [poster, setPoster] = useState<number | null>(null);
  const title = useRef<HTMLHeadingElement>(null);

  // Muting silences the microphone, and turning the camera off darkens its picture, in the clip too.
  useEffect(() => {
    for (const track of microphone.stream?.getAudioTracks() ?? []) track.enabled = !muted;
  }, [microphone.stream, muted]);
  useEffect(() => {
    for (const track of camera.stream?.getVideoTracks() ?? []) track.enabled = !cameraOff;
  }, [camera.stream, cameraOff]);

  const record = () => {
    setFailed(false);
    const tracks = [...camera.stream!.getVideoTracks(), ...(microphone.stream?.getAudioTracks() ?? [])];
    if (!recorder.start(new MediaStream(tracks))) setFailed(true);
  };
  const again = () => {
    setClip(null);
    setLength(null);
    setPoster(null);
  };
  const done = () => {
    if (poster !== null) choosePoster(clip!, poster);
    onRecorded(clip!);
    onClose();
  };
  const choosePosterAt = (seconds: number) => {
    setPoster(seconds);
    const video = played.current;
    if (!video) return;
    video.pause();
    video.currentTime = seconds;
  };

  const microphoneId = microphoneOf(microphone.stream ?? null);
  const microphones = withOpen(devices.microphones, microphoneId, microphone.stream?.getAudioTracks()[0]);
  const cameraId = cameraOf(camera.stream ?? null);
  const cameras = withOpen(devices.cameras, cameraId, camera.stream?.getVideoTracks()[0]);
  const status = failed ? NOT_RECORDED : microphone.stream === undefined ? ASKING_FOR_MICROPHONE : microphone.stream === null && camera.stream ? SILENT_CLIP : null;

  return (
    <Dialog open onOpenChange={(open) => open || onClose()}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={DIALOG_BACKDROP}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        className={cn(DIALOG, "w-[560px]")}
      >
        <button type="button" aria-label="Close" onClick={onClose} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle ref={title} tabIndex={-1} className={cn(DIALOG_TITLE, "pe-10 outline-none")}>
          Record video clip
        </DialogTitle>
        <DialogDescription className="leading-[1.65] text-muted-foreground">A clip can be up to 5 minutes long.</DialogDescription>

        <div className="relative mt-5 aspect-[16/9] overflow-hidden rounded-xl border bg-surface">
          {clip ? (
            <video
              ref={played}
              src={url}
              controls
              playsInline
              aria-label="Your clip"
              onLoadedMetadata={(event) => {
                const { duration } = event.currentTarget;
                setLength(Number.isFinite(duration) ? duration : null);
              }}
              className="absolute inset-0 size-full bg-black object-contain"
            />
          ) : (
            <>
              {camera.stream && !cameraOff ? (
                <HuddlePicture stream={camera.stream} label="Your camera" mirrored={!facesAway(camera.stream)} />
              ) : (
                <p className="absolute inset-0 grid place-items-center px-6 pb-16 text-center leading-[1.65] text-muted-foreground">
                  {camera.stream === undefined ? ASKING_FOR_CAMERA : camera.stream === null ? NO_CLIP_CAMERA : "Your camera is off."}
                </p>
              )}
              {recorder.recording && <ClipTimer seconds={recorder.seconds} className="absolute start-3 top-3 rounded-full bg-background/85 px-2.5 py-1" />}
              <div className="absolute inset-x-0 bottom-3 flex justify-center gap-2.5">
                <ClipSwitch label={muted ? "Unmute microphone" : "Mute microphone"} on={!muted && !!microphone.stream} disabled={!microphone.stream} onClick={() => setMuted(!muted)}>
                  {muted || !microphone.stream ? <MicrophoneMute /> : <Microphone />}
                </ClipSwitch>
                <ClipSwitch label={cameraOff ? "Turn on camera" : "Turn off camera"} on={!cameraOff && !!camera.stream} disabled={!camera.stream} onClick={() => setCameraOff(!cameraOff)}>
                  {cameraOff || !camera.stream ? <VideoCameraOff /> : <VideoCamera />}
                </ClipSwitch>
              </div>
            </>
          )}
        </div>

        {clip
          ? length !== null && (
              <div className="mt-5">
                <Field id="clip_thumbnail" label="Thumbnail">
                  <input
                    id="clip_thumbnail"
                    type="range"
                    min={0}
                    max={length}
                    step="any"
                    value={poster ?? 0}
                    aria-valuetext={clipTime(poster ?? 0)}
                    aria-describedby="clip_thumbnail_hint"
                    onChange={(event) => choosePosterAt(Number(event.target.value))}
                    className="w-full accent-foreground"
                  />
                </Field>
                <p id="clip_thumbnail_hint" className="mt-1.5 text-[13px] leading-normal text-muted-foreground">
                  The picture the clip shows before it's played.
                </p>
              </div>
            )
          : (microphone.stream || camera.stream) && (
              <div className="mt-5 grid gap-3.5 sm:grid-cols-2">
                {microphone.stream && (
                  <Field id="clip_microphone" label="Microphone">
                    <select id="clip_microphone" value={microphoneId} disabled={recorder.recording} onChange={(event) => microphone.choose(event.target.value)} className={SELECT}>
                      {microphones.map(({ deviceId, label }, index) => (
                        <option key={deviceId} value={deviceId}>
                          {label || `Microphone ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {camera.stream && (
                  <Field id="clip_camera" label="Camera">
                    <select id="clip_camera" value={cameraId} disabled={recorder.recording} onChange={(event) => camera.choose(event.target.value)} className={SELECT}>
                      {cameras.map(({ deviceId, label }, index) => (
                        <option key={deviceId} value={deviceId}>
                          {label || `Camera ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
            )}
        <p role="status" className="mt-5 leading-[1.65] text-muted-foreground empty:mt-0">
          {clip ? null : status}
        </p>

        <div className="mt-[26px] flex justify-end gap-2.5">
          {clip ? (
            <>
              <button type="button" onClick={again} className={cn(OTHER_ACTION, ON_ONE_LINE)}>
                Record again
              </button>
              <button type="button" onClick={done} className={cn(MAIN_ACTION, ON_ONE_LINE)}>
                Done
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} className={cn(OTHER_ACTION, ON_ONE_LINE)}>
                Cancel
              </button>
              {recorder.recording ? (
                <button type="button" onClick={recorder.stop} className={cn(MAIN_ACTION, ON_ONE_LINE)}>
                  Stop recording
                </button>
              ) : (
                <button type="button" disabled={!camera.stream || microphone.stream === undefined} onClick={record} className={cn(MAIN_ACTION, ON_ONE_LINE)}>
                  Record
                </button>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** How many of the last moments of sound the audio recorder shows, a tenth of a second each. */
const LEVELS = 40;

/** How loud the microphone has been, from 0 to 1, over the last four seconds, while `stream` is recorded, where the browser can tell. */
function useLevels(stream: MediaStream | null | undefined): number[] {
  const [levels, setLevels] = useState<number[]>([]);
  useEffect(() => {
    if (!stream || typeof AudioContext !== "function") return;
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      setLevels((levels) => [...levels.slice(1 - LEVELS), level]);
    }, 100);
    return () => {
      clearInterval(timer);
      void context.close();
    };
  }, [stream]);
  return levels;
}

/** The recorder's own buttons, smaller than a dialog's, to fit the composer. */
const BAR_ACTION = "inline-flex h-9 shrink-0 cursor-pointer items-center justify-center rounded-[9px] border px-3.5 text-sm font-semibold touch:h-11";

/**
 * Slack's Record audio clip, over the composer's card: it asks for the microphone this browser last chose
 * and records from it at once, showing how long it has run and how loud it hears you, until Done, which
 * leaves the clip to go with the next message, as five minutes do, when it stops by itself, or Cancel or
 * Escape, which discard it. Without a microphone, it says why, until it's closed.
 */
export function AudioClipRecorder({ onRecorded, onClose }: Props) {
  const microphone = useClipDevice("microphone", openMicrophone);
  const [failed, setFailed] = useState(false);
  const recorder = useClipRecorder(
    "audio",
    (clip) => {
      onRecorded(clip);
      onClose();
    },
    () => setFailed(true),
  );
  const levels = useLevels(recorder.recording ? microphone.stream : null);
  const group = useRef<HTMLDivElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);

  // Focus is in it from the start, as what was under it is out of reach, on Done once it records, and
  // back in it where recording fails, should it have been on Done, which goes.
  useEffect(() => group.current?.focus(), []);
  useEffect(() => {
    if (recorder.recording) doneButton.current?.focus();
  }, [recorder.recording]);
  useEffect(() => {
    if (failed && !group.current?.contains(document.activeElement)) group.current?.focus();
  }, [failed]);

  const start = useEffectEvent((stream: MediaStream) => {
    if (!recorder.start(stream)) setFailed(true);
  });
  useEffect(() => {
    if (microphone.stream) start(microphone.stream);
  }, [microphone.stream]);

  const cancel = () => {
    recorder.discard();
    onClose();
  };
  const said = failed ? NOT_RECORDED : microphone.stream === undefined ? ASKING_FOR_MICROPHONE : microphone.stream === null ? NO_CLIP_MICROPHONE : null;

  return (
    <div
      ref={group}
      role="group"
      aria-label="Record audio clip"
      tabIndex={-1}
      data-clip-recorder
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
      className="absolute inset-0 z-10 flex items-center gap-3 rounded-[12px] bg-surface px-4 outline-none"
    >
      {said ? (
        <p role="status" className="min-w-0 flex-1 text-[13px] leading-normal text-muted-foreground">
          {said}
        </p>
      ) : (
        <>
          <ClipTimer seconds={recorder.seconds} />
          <div aria-hidden className="flex h-7 min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden">
            {levels.map((level, index) => (
              <span key={index} className="w-[3px] shrink-0 rounded-full bg-muted-foreground" style={{ height: `${Math.max(3, Math.round(level * 28))}px` }} />
            ))}
          </div>
        </>
      )}
      <button type="button" onClick={cancel} className={cn(BAR_ACTION, "bg-background text-foreground")}>
        {said ? "Close" : "Cancel"}
      </button>
      {!said && (
        <button ref={doneButton} type="button" disabled={!recorder.recording} onClick={recorder.stop} className={cn(BAR_ACTION, "border-transparent bg-foreground text-background hover:not-active:brightness-70")}>
          Done
        </button>
      )}
    </div>
  );
}
