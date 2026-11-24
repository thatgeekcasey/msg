import { act } from "@testing-library/react";
import { vi } from "vitest";

// jsdom has no microphones, cameras or media recorder. These stand in for a browser's, as much of each as
// Ember's clips use, for tests of recording them.

/** A microphone's track or a camera's. */
export class FakeTrack extends EventTarget {
  enabled = true;
  stopped = false;
  constructor(
    readonly kind: "audio" | "video",
    readonly deviceId: string,
    readonly label: string,
  ) {
    super();
  }
  stop() {
    this.stopped = true;
  }
  getSettings() {
    return { deviceId: this.deviceId };
  }
}

/** A stream of tracks, as the browser opens one and as `new MediaStream(tracks)` makes one. */
export class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter(({ kind }) => kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter(({ kind }) => kind === "video");
  }
}

const device = (kind: MediaDeviceKind, deviceId: string, label: string) => ({ kind, deviceId, label, groupId: "" }) as MediaDeviceInfo;

/**
 * The browser's microphones and cameras, two of each: it opens the one asked for, or the first, unless it
 * `refusesMicrophones` or `refusesCameras`. With `pending`, each request waits to be answered.
 */
export class FakeMedia extends EventTarget {
  devices = [device("audioinput", "mic-1", "Built-in Microphone"), device("audioinput", "mic-2", "USB Microphone"), device("videoinput", "cam-1", "FaceTime HD Camera"), device("videoinput", "cam-2", "USB Webcam")];
  refusesMicrophones = false;
  refusesCameras = false;
  pending = false;
  /** The streams it has opened, oldest first. */
  opened: FakeStream[] = [];
  /** What each request asked for. */
  asked: MediaStreamConstraints[] = [];
  private waiting: (() => void)[] = [];

  getUserMedia = async (constraints: MediaStreamConstraints) => {
    this.asked.push(constraints);
    if (this.pending) await new Promise<void>((answer) => this.waiting.push(answer));
    const camera = constraints.video !== undefined;
    if (camera ? this.refusesCameras : this.refusesMicrophones) throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    const asked = (camera ? constraints.video : constraints.audio) as MediaTrackConstraints | true;
    const wanted = asked === true ? undefined : (asked.deviceId as { exact: string } | undefined)?.exact;
    const found = this.devices.find(({ kind, deviceId }) => kind === (camera ? "videoinput" : "audioinput") && (wanted === undefined || deviceId === wanted))!;
    const stream = new FakeStream([new FakeTrack(camera ? "video" : "audio", found.deviceId, found.label)]);
    this.opened.push(stream);
    return stream;
  };

  enumerateDevices = async () => this.devices;

  /** Answers the requests that are waiting. */
  async answer() {
    await act(async () => {
      for (const answer of this.waiting.splice(0)) answer();
    });
  }

  /** The tracks of a kind it has opened, oldest first. */
  tracks(kind: "audio" | "video") {
    return this.opened.flatMap((stream) => stream.getTracks()).filter((track) => track.kind === kind);
  }
}

/**
 * A media recorder: it records `FakeRecorder.records`' types, or won't record at all while it `refuses`.
 * Stopped, it's inactive at once, and `end` is the browser handing over what it recorded and saying it has
 * stopped, which a browser does a moment after it's stopped, or once what it records ends by itself.
 */
export class FakeRecorder extends EventTarget {
  /** The recorders made, oldest first. */
  static made: FakeRecorder[] = [];
  static records = ["video/mp4", "audio/mp4"];
  static refuses = false;
  static isTypeSupported = (type: string) => FakeRecorder.records.includes(type);

  state: RecordingState = "inactive";
  timeslice: number | undefined;
  readonly mimeType: string;

  constructor(
    readonly stream: FakeStream,
    readonly options: MediaRecorderOptions = {},
  ) {
    super();
    if (FakeRecorder.refuses) throw new DOMException("Not supported", "NotSupportedError");
    // Asked for no type, it records its own, as Firefox records WebM.
    this.mimeType = options.mimeType ?? "video/webm;codecs=vp8,opus";
    FakeRecorder.made.push(this);
  }

  start(timeslice?: number) {
    this.state = "recording";
    this.timeslice = timeslice;
  }

  stop() {
    this.state = "inactive";
  }

  async end() {
    this.state = "inactive";
    await act(async () => {
      this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob(["recorded"]) }));
      this.dispatchEvent(new Event("stop"));
    });
  }

  /**
   * The browser failing as it records, as when its encoder gives out: as Chromium does, it says why, then
   * hands over what it had recorded and says it has stopped, as though it had been stopped.
   */
  async fail() {
    this.state = "inactive";
    await act(async () => {
      this.dispatchEvent(Object.assign(new Event("error"), { error: new DOMException("Recording failed", "UnknownError") }));
      this.dispatchEvent(Object.assign(new Event("dataavailable"), { data: new Blob(["recorded"]) }));
      this.dispatchEvent(new Event("stop"));
    });
  }
}

/** The recorder made last. */
export const lastRecorder = () => FakeRecorder.made.at(-1)!;

/**
 * Gives the page a browser that records clips, its microphones and cameras the media returned, until the
 * test's globals are unstubbed and `navigator.mediaDevices` is deleted.
 */
export function installRecording(): FakeMedia {
  FakeRecorder.made = [];
  FakeRecorder.records = ["video/mp4", "audio/mp4"];
  FakeRecorder.refuses = false;
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("MediaStream", FakeStream);
  const media = new FakeMedia();
  Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
  return media;
}
