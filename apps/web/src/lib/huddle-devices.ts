// The microphone and the speaker a huddle uses, which its preview lets someone choose, and this browser
// remembers for the next.

export type HuddleDevice = "microphone" | "speaker";

const KEYS: Record<HuddleDevice, string> = { microphone: "ember:huddle-microphone", speaker: "ember:huddle-speaker" };

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

/** Stops a microphone's stream, which lets go of the device. */
export function closeMicrophone(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export interface HuddleDevices {
  microphones: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
}

export const NO_DEVICES: HuddleDevices = { microphones: [], speakers: [] };

/** Whether this browser can play a huddle through a speaker other than the system's, which Safari can't. */
const choosesSpeaker = () => typeof HTMLMediaElement.prototype.setSinkId === "function";

/**
 * The microphones and speakers the browser lists, which it does by name only once a microphone is open.
 * It lists no speakers where the huddle couldn't play through one of them.
 */
export async function listDevices(): Promise<HuddleDevices> {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.deviceId !== "");
    return {
      microphones: devices.filter((device) => device.kind === "audioinput"),
      speakers: choosesSpeaker() ? devices.filter((device) => device.kind === "audiooutput") : [],
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

/** Has `changed` hear whenever a device is plugged in or taken away, until the function returned is called. */
export function watchDevices(changed: () => void): () => void {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  media?.addEventListener?.("devicechange", changed);
  return () => media?.removeEventListener?.("devicechange", changed);
}
