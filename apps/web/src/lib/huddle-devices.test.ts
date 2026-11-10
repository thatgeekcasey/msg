import { afterEach, describe, expect, it, vi } from "vitest";
import { closeMicrophone, listDevices, listsSpeaker, microphoneOf, NO_DEVICES, openMicrophone, rememberDevice, rememberedDevice, watchDevices } from "./huddle-devices";

/** A stream from the microphone `deviceId`, as much of one as the code reads. */
function streamFrom(deviceId: string) {
  const track = { stop: vi.fn(), getSettings: () => ({ deviceId }) };
  return { stream: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream, track };
}

/** What the browser throws for a request it turns down, by its name. */
const refusal = (name: string) => Object.assign(new Error(name), { name });

const device = (kind: MediaDeviceKind, deviceId: string, label = deviceId) => ({ kind, deviceId, label, groupId: "" }) as MediaDeviceInfo;

/** Gives the page the browser's media devices, as much of them as the code asks. */
function withMedia(media: Partial<MediaDevices>) {
  vi.stubGlobal("navigator", { mediaDevices: media });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
});

describe("The devices a huddle remembers", () => {
  it("remembers a microphone and a speaker apart", () => {
    expect(rememberedDevice("microphone")).toBeNull();
    rememberDevice("microphone", "mic-2");
    rememberDevice("speaker", "speaker-1");
    expect(rememberedDevice("microphone")).toBe("mic-2");
    expect(rememberedDevice("speaker")).toBe("speaker-1");
  });

  it("forgets one once the browser's own choice is taken", () => {
    rememberDevice("speaker", "speaker-1");
    rememberDevice("speaker", "");
    expect(rememberedDevice("speaker")).toBeNull();
  });

  it("goes without when storage is refused", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("refused");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("refused");
    });
    expect(() => rememberDevice("microphone", "mic-2")).not.toThrow();
    expect(rememberedDevice("microphone")).toBeNull();
  });
});

describe("Opening a microphone", () => {
  it("opens the browser's own choice when none is asked for", async () => {
    const { stream } = streamFrom("mic-1");
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    withMedia({ getUserMedia });
    expect(await openMicrophone(null)).toBe(stream);
    expect(getUserMedia.mock.calls).toEqual([[{ audio: true }]]);
  });

  it("opens the one asked for", async () => {
    const { stream } = streamFrom("mic-2");
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    withMedia({ getUserMedia });
    expect(await openMicrophone("mic-2")).toBe(stream);
    expect(getUserMedia.mock.calls).toEqual([[{ audio: { deviceId: { exact: "mic-2" } } }]]);
  });

  it.each(["OverconstrainedError", "NotFoundError"])("opens the browser's own choice when the one asked for is gone (%s)", async (name) => {
    const { stream } = streamFrom("mic-1");
    const getUserMedia = vi.fn().mockRejectedValueOnce(refusal(name)).mockResolvedValue(stream);
    withMedia({ getUserMedia });
    expect(await openMicrophone("mic-2")).toBe(stream);
    expect(getUserMedia.mock.calls).toEqual([[{ audio: { deviceId: { exact: "mic-2" } } }], [{ audio: true }]]);
  });

  it("takes a browser's word that the one asked for is gone when what it throws isn't an Error", async () => {
    const { stream } = streamFrom("mic-1");
    const getUserMedia = vi.fn().mockRejectedValueOnce({ name: "OverconstrainedError", constraint: "deviceId" }).mockResolvedValue(stream);
    withMedia({ getUserMedia });
    expect(await openMicrophone("mic-2")).toBe(stream);
  });

  it("doesn't ask twice of someone who refuses", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(refusal("NotAllowedError"));
    withMedia({ getUserMedia });
    expect(await openMicrophone("mic-2")).toBeNull();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("has none when there's no microphone at all", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(refusal("NotFoundError"));
    withMedia({ getUserMedia });
    expect(await openMicrophone("mic-2")).toBeNull();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(await openMicrophone(null)).toBeNull();
    expect(getUserMedia).toHaveBeenCalledTimes(3);
  });

  it("has none on a page the browser gives no microphone", async () => {
    vi.stubGlobal("navigator", {});
    expect(await openMicrophone(null)).toBeNull();
  });

  it("says which device a stream is from, and stops it", () => {
    const { stream, track } = streamFrom("mic-2");
    expect(microphoneOf(stream)).toBe("mic-2");
    expect(microphoneOf(null)).toBe("");
    closeMicrophone(stream);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(() => closeMicrophone(null)).not.toThrow();
  });
});

describe("Listing a huddle's devices", () => {
  const DEVICES = [
    device("audioinput", "mic-1", "Built-in Microphone"),
    device("audioinput", "mic-2", "USB Microphone"),
    device("audiooutput", "speaker-1", "Built-in Speakers"),
    device("videoinput", "camera-1", "FaceTime HD Camera"),
  ];

  it("lists the microphones, and no speakers where the browser can't play through one it's told", async () => {
    withMedia({ enumerateDevices: vi.fn().mockResolvedValue(DEVICES) });
    const { microphones, speakers } = await listDevices();
    expect(microphones.map(({ label }) => label)).toEqual(["Built-in Microphone", "USB Microphone"]);
    expect(speakers).toEqual([]);
  });

  it("lists the speakers where it can", async () => {
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { value: vi.fn(), configurable: true });
    withMedia({ enumerateDevices: vi.fn().mockResolvedValue(DEVICES) });
    expect((await listDevices()).speakers.map(({ label }) => label)).toEqual(["Built-in Speakers"]);
  });

  it("leaves out the devices a browser lists without an id, as it does before a microphone is allowed", async () => {
    withMedia({ enumerateDevices: vi.fn().mockResolvedValue([device("audioinput", "", ""), device("audiooutput", "", "")]) });
    expect(await listDevices()).toEqual(NO_DEVICES);
  });

  it("lists none when the browser can't say", async () => {
    withMedia({ enumerateDevices: vi.fn().mockRejectedValue(new Error("refused")) });
    expect(await listDevices()).toEqual(NO_DEVICES);
    vi.stubGlobal("navigator", {});
    expect(await listDevices()).toEqual(NO_DEVICES);
  });

  it("says whether a speaker is still listed, and counts one the browser can't say of as there", async () => {
    withMedia({ enumerateDevices: vi.fn().mockResolvedValue(DEVICES) });
    expect(await listsSpeaker("speaker-1")).toBe(true);
    expect(await listsSpeaker("speaker-2")).toBe(false);
    // A microphone of that id isn't a speaker.
    expect(await listsSpeaker("mic-1")).toBe(false);
    withMedia({ enumerateDevices: vi.fn().mockRejectedValue(new Error("refused")) });
    expect(await listsSpeaker("speaker-2")).toBe(true);
    vi.stubGlobal("navigator", {});
    expect(await listsSpeaker("speaker-2")).toBe(true);
  });

  it("hears of devices plugged in and taken away until it's told to stop", () => {
    const media = new EventTarget();
    withMedia(media as MediaDevices);
    const changed = vi.fn();
    const stop = watchDevices(changed);
    media.dispatchEvent(new Event("devicechange"));
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
    media.dispatchEvent(new Event("devicechange"));
    expect(changed).toHaveBeenCalledTimes(1);
    vi.stubGlobal("navigator", {});
    expect(() => watchDevices(changed)()).not.toThrow();
  });
});
