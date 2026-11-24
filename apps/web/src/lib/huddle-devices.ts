import type { HuddleVideoQuality } from "@ember/protocol/huddles";

// The microphone, the speaker and the camera a huddle uses, which its preview lets someone choose, as
// the huddle's own menus do once they're in it, or on a phone, its button that switches cameras, and
// this browser remembers for the next, and the screen someone shares in one, which the browser asks
// them for each time. Cameras and screens are opened as large as the workspace's video quality has
// them go out, and each goes out at the quality it was opened at for as long as it's on.

export type HuddleDevice = "microphone" | "speaker" | "camera";

const KEYS: Record<HuddleDevice, string> = { microphone: "ember:huddle-microphone", speaker: "ember:huddle-speaker", camera: "ember:huddle-camera" };

/** The device of that kind this browser's last huddle used, by its id, or null when it used the browser's own choice. */
export function rememberedDevice(kind: HuddleDevice): string | null {
  try {
    return localStorage.getItem(KEYS[kind]) || null;
  } catch {
    return null;
  }
}

/** Remembers the device chosen, or with an empty id, that the browser's own choice was. */
export function rememberDevice(kind: HuddleDevice, deviceId: string): void {
  try {
    if (deviceId) localStorage.setItem(KEYS[kind], deviceId);
    else localStorage.removeItem(KEYS[kind]);
  } catch {
    // Storage can be refused, and then the next huddle starts with the browser's own choice.
  }
}

/** Whether what failed is that the device asked for is gone, rather than that the person or the browser refused. */
function deviceGone(error: unknown): boolean {
  // Not every browser's OverconstrainedError is an Error.
  const name = (error as { name?: unknown } | null)?.name;
  return name === "OverconstrainedError" || name === "NotFoundError";
}

/**
 * Opens a microphone, which makes the browser ask the person the first time: `deviceId`'s, or the
 * browser's own choice when it has none or that one is gone. Null when there's no microphone, the person
 * or the browser refuses one, or the page isn't one a browser gives a microphone, as over plain HTTP.
 */
export async function openMicrophone(deviceId: string | null): Promise<MediaStream | null> {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (!media?.getUserMedia) return null;
  try {
    return await media.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
  } catch (error) {
    return deviceId && deviceGone(error) ? openMicrophone(null) : null;
  }
}

/** The device a microphone's stream is from, by its id, or empty where the browser doesn't say. */
export const microphoneOf = (stream: MediaStream | null) => stream?.getAudioTracks()[0]?.getSettings().deviceId ?? "";

/**
 * Whether the browser is one known to send a camera in several sizes at once as the SFU takes them:
 * Chromium's family, by what it says of itself. Any other sends one size until it has been tried.
 */
export const sendsSizes = () => /Chrom(e|ium)\//.test(navigator.userAgent);

/** How tall a camera's picture is at each video quality, which is as tall as the largest size it's sent in. */
export const CAMERA_HEIGHTS: Record<HuddleVideoQuality, number> = { standard: 360, hd: 720, "full-hd": 1080 };

/**
 * What a huddle asks of a camera at `quality`: a picture as tall as the quality's, and as wide as most
 * cameras' are for that. A browser that sends a camera in one size, which everyone who watches it is
 * sent, asks for one only as large as Standard's.
 */
function cameraAt(quality: HuddleVideoQuality): MediaTrackConstraints {
  const height = CAMERA_HEIGHTS[sendsSizes() ? quality : "standard"];
  return { width: { ideal: (height * 16) / 9 }, height: { ideal: height } };
}

/** The video quality each camera and screen was opened at, by its track. */
const openedAt = new WeakMap<MediaStreamTrack, HuddleVideoQuality>();

/** Notes that `stream`'s pictures were opened at `quality`, and answers it. */
function openedAtQuality(stream: MediaStream, quality: HuddleVideoQuality): MediaStream {
  for (const track of stream.getVideoTracks()) openedAt.set(track, quality);
  return stream;
}

/**
 * The video quality a camera's track or a screen's was opened at, which it goes out at for as long as
 * it's on, though an administrator changes the workspace's meanwhile. Undefined of one opened elsewhere.
 */
export const qualityOpenedAt = (track: MediaStreamTrack): HuddleVideoQuality | undefined => openedAt.get(track);

/** What someone is told once there's no camera Ember may use. */
export const NO_CAMERA = "Ember has no camera to use. To show yours, let this site use your camera in your browser's settings, then turn it on again.";

/**
 * Opens a camera for a picture as large as `quality` sends, which makes the browser ask the person the
 * first time, and turns its light on: `deviceId`'s, or the browser's own choice when it has none or that
 * one is gone. Null when there's no camera, the person or the browser refuses one, or the page isn't
 * one a browser gives a camera.
 */
export async function openCamera(deviceId: string | null, quality: HuddleVideoQuality): Promise<MediaStream | null> {
  const stream = await openCameraSized(deviceId, cameraAt(quality));
  return stream && openedAtQuality(stream, quality);
}

/** Opens a camera as `openCamera` does, for a picture the size `size` asks for, as a clip's is, which goes out to nobody. */
export async function openCameraSized(deviceId: string | null, size: MediaTrackConstraints): Promise<MediaStream | null> {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (!media?.getUserMedia) return null;
  try {
    return await media.getUserMedia({ video: deviceId ? { ...size, deviceId: { exact: deviceId } } : size });
  } catch (error) {
    return deviceId && deviceGone(error) ? openCameraSized(null, size) : null;
  }
}

/** What someone in a huddle is told once the browser won't open the microphone, or the camera, they chose in place of theirs, or play through the speaker they chose. */
export const NO_OTHER_MICROPHONE = "Ember couldn't use that microphone. Nothing has changed.";
export const NO_OTHER_CAMERA = "Ember couldn't use that camera. Nothing has changed.";
export const NO_OTHER_SPEAKER = "Ember couldn't use that speaker. Nothing has changed.";
/** And once it won't open their own camera again either, which the huddle let go of for the other. */
export const CAMERA_WENT_OFF = "Ember couldn't use that camera, and your camera is off now. Turn it on again to show yours.";
/** And what someone who only listens in one is told once the browser has no microphone for them still. */
export const STILL_NO_MICROPHONE = "Ember has no microphone to use. To speak, let this site use your microphone in your browser's settings, then choose it again.";

/** The device a camera's stream is from, by its id, or empty where the browser doesn't say. */
export const cameraOf = (stream: MediaStream | null) => stream?.getVideoTracks()[0]?.getSettings().deviceId ?? "";

/** Which way a camera faces, as a phone's browser says of each of its cameras: toward its person, as the one over its screen does, or away from them. */
export type CameraFacing = "user" | "environment";

/** Which way the camera a stream is from faces, or null where the browser doesn't say, as of most computers'. */
export function facingOf(stream: MediaStream | null): CameraFacing | null {
  const facing = stream?.getVideoTracks()[0]?.getSettings().facingMode;
  return facing === "user" || facing === "environment" ? facing : null;
}

/** Whether a camera's stream is from one that faces away from its person, as a phone's back camera does, whose picture a mirror would show them the wrong way round. */
export const facesAway = (stream: MediaStream | null) => facingOf(stream) === "environment";

/** Opens the one camera `which` asks for, for a picture as large as `quality` sends, or null when the browser has none such, or won't open it. */
async function openCameraBy(which: MediaTrackConstraints, quality: HuddleVideoQuality): Promise<MediaStream | null> {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (!media?.getUserMedia) return null;
  try {
    return openedAtQuality(await media.getUserMedia({ video: { ...cameraAt(quality), ...which } }), quality);
  } catch {
    return null;
  }
}

/** The camera the browser lists after `deviceId`'s, which is the first after the last, by its id, or null when it lists no other. */
async function cameraAfter(deviceId: string): Promise<string | null> {
  const { cameras } = await listDevices();
  const next = cameras[(cameras.findIndex((camera) => camera.deviceId === deviceId) + 1) % cameras.length];
  return next && next.deviceId !== deviceId ? next.deviceId : null;
}

/**
 * Opens the camera to switch to from the one that was on, which was `deviceId`'s and faced `facing`,
 * for a picture as large as `quality` sends: the one that faces the other way, as a phone's back camera
 * does from its front one. Where the browser didn't say which way that one faced, as of a computer's,
 * or has none that faces the other, it's the next the browser lists. Null when it has no other, or
 * won't open it.
 */
export async function openOtherCamera(deviceId: string, facing: CameraFacing | null, quality: HuddleVideoQuality): Promise<MediaStream | null> {
  const turned = facing && (await openCameraBy({ facingMode: { exact: facing === "user" ? "environment" : "user" } }, quality));
  if (turned) return turned;
  const next = await cameraAfter(deviceId);
  return next === null ? null : openCameraBy({ deviceId: { exact: next } }, quality);
}

/** How large a shared screen goes out at each video quality, at most: 1080p at Standard, and 1440p, which keeps a large display's text sharp, at HD and Full HD. */
const SCREEN_SIZES: Record<HuddleVideoQuality, { width: number; height: number }> = {
  standard: { width: 1920, height: 1080 },
  hd: { width: 2560, height: 1440 },
  "full-hd": { width: 2560, height: 1440 },
};

/**
 * What a huddle asks of a screen shared at `quality`: no larger than the quality's, which a larger
 * display is scaled down to, and no more than 15 pictures a second, which leaves what its connection
 * carries to keeping text sharp. No sound, as a huddle's connections for screens carry pictures only.
 */
function screenAt(quality: HuddleVideoQuality): DisplayMediaStreamOptions {
  const { width, height } = SCREEN_SIZES[quality];
  return { video: { width: { max: width }, height: { max: height }, frameRate: { max: 15 } }, audio: false };
}

/** What someone is told once their browser couldn't share what they chose. */
export const NO_SCREEN = "Ember couldn't share your screen. To share it, let your browser record the screen in your computer's privacy settings, then share it again.";

/** Whether this browser can share a screen, which a phone's can't. */
export const sharesScreens = () => typeof (navigator.mediaDevices as MediaDevices | undefined)?.getDisplayMedia === "function";

/**
 * Whether what failed is that the person chose nothing to share, rather than that the browser couldn't
 * share what they chose. Both refuse the page, but Chrome says so of a computer that keeps it from
 * recording the screen.
 */
function choseNothing(error: unknown): boolean {
  const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
  return name === "NotAllowedError" && !(typeof message === "string" && message.includes("system"));
}

/**
 * Opens what the person chooses to share, a screen, a window or a tab, which the browser asks them each
 * time, as large as `quality` sends, and has it keep text sharp where it can't keep that and smooth
 * movement both. Null when they choose nothing. It rejects when the browser can't share one.
 */
export async function openScreen(quality: HuddleVideoQuality): Promise<MediaStream | null> {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia(screenAt(quality));
    for (const track of stream.getVideoTracks()) track.contentHint = "detail";
    return openedAtQuality(stream, quality);
  } catch (error) {
    if (choseNothing(error)) return null;
    throw error;
  }
}

/** Stops a microphone's stream, a camera's or a shared screen's, which lets go of the device, puts a camera's light out and ends the browser's sharing. */
export function closeDevice(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export interface HuddleDevices {
  microphones: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
}

export const NO_DEVICES: HuddleDevices = { microphones: [], speakers: [], cameras: [] };

/** Whether this browser can play a huddle through a speaker other than the system's, which Safari can't. */
const choosesSpeaker = () => typeof HTMLMediaElement.prototype.setSinkId === "function";

/**
 * The microphones, speakers and cameras the browser lists, which it does by name only once a microphone
 * is open, and for cameras, a camera. It lists no speakers where the huddle couldn't play through one of
 * them.
 */
export async function listDevices(): Promise<HuddleDevices> {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.deviceId !== "");
    return {
      microphones: devices.filter((device) => device.kind === "audioinput"),
      speakers: choosesSpeaker() ? devices.filter((device) => device.kind === "audiooutput") : [],
      cameras: devices.filter((device) => device.kind === "videoinput"),
    };
  } catch {
    return NO_DEVICES;
  }
}

/**
 * Whether the browser still lists the speaker `deviceId`, which it stops doing once that's unplugged. One
 * a browser can't say of counts as there.
 */
export async function listsSpeaker(deviceId: string): Promise<boolean> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).some((device) => device.kind === "audiooutput" && device.deviceId === deviceId);
  } catch {
    return true;
  }
}

/** A device to choose: its id, and what the browser calls it, which is nothing where it doesn't say. */
export type DeviceChoice = Pick<MediaDeviceInfo, "deviceId" | "label">;

/** The devices to choose among, led by the one that's open where the browser's list leaves it out. */
export function withOpen(listed: MediaDeviceInfo[], deviceId: string, open?: MediaStreamTrack): DeviceChoice[] {
  return listed.some((device) => device.deviceId === deviceId) ? listed : [{ deviceId, label: open?.label ?? "" }, ...listed];
}

/** The speakers to choose among: a browser that lists its own choice has it first, and the others get one to choose. */
export function speakerChoices(listed: MediaDeviceInfo[]): DeviceChoice[] {
  return listed.some(({ deviceId }) => deviceId === "default") ? listed : [{ deviceId: "", label: "System default" }, ...listed];
}

/** Has `changed` hear whenever a device is plugged in or taken away, until the function returned is called. */
export function watchDevices(changed: () => void): () => void {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  media?.addEventListener?.("devicechange", changed);
  return () => media?.removeEventListener?.("devicechange", changed);
}
