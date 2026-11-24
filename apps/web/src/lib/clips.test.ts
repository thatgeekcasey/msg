import { afterEach, describe, expect, it, vi } from "vitest";
import { choosePoster, posterTimeOf, recordsClips } from "./clips";

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("clips", () => {
  it("records clips only where the browser has a recorder and can open a camera and microphone", () => {
    expect(recordsClips()).toBe(false);
    vi.stubGlobal("MediaRecorder", function MediaRecorder() {});
    expect(recordsClips()).toBe(false);
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => null }, configurable: true });
    expect(recordsClips()).toBe(true);
  });

  it("keeps where a clip's thumbnail was chosen from with the clip", () => {
    const clip = new File(["clip"], "clip.mp4", { type: "video/mp4" });
    expect(posterTimeOf(clip)).toBeUndefined();
    choosePoster(clip, 2.5);
    expect(posterTimeOf(clip)).toBe(2.5);
    expect(posterTimeOf(new File(["clip"], "clip.mp4", { type: "video/mp4" }))).toBeUndefined();
  });
});
