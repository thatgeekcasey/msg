import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRecorder, installRecording } from "@/test-recording";
import { useClipRecorder } from "./use-clip-recorder";

const stream = {} as MediaStream;

beforeEach(() => void installRecording());

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

function renderRecorder(kind: "video" | "audio" = "video") {
  const onRecorded = vi.fn((_clip: File) => {});
  const onFailed = vi.fn();
  const view = renderHook(() => useClipRecorder(kind, onRecorded, onFailed));
  const start = () => act(() => void expect(view.result.current.start(stream)).toBe(true));
  return { ...view, onRecorded, onFailed, start, recorder: (index = 0) => FakeRecorder.made[index]! };
}

describe("useClipRecorder", () => {
  it("records until it's stopped, a second at a time, then hands over the clip, named for when it was recorded", async () => {
    const { result, onRecorded, start, recorder } = renderRecorder();
    expect(result.current.recording).toBe(false);
    start();
    expect(result.current.recording).toBe(true);
    expect(recorder().options).toEqual({ videoBitsPerSecond: 1_900_000, audioBitsPerSecond: 96_000, mimeType: "video/mp4" });
    expect(recorder().timeslice).toBe(1000);

    act(() => result.current.stop());
    expect(recorder().state).toBe("inactive");
    // Under way until it's handed over.
    expect(result.current.recording).toBe(true);
    await recorder().end();
    expect(result.current.recording).toBe(false);
    expect(onRecorded).toHaveBeenCalledOnce();
    const [clip] = onRecorded.mock.calls[0]!;
    expect(clip.type).toBe("video/mp4");
    expect(clip.name).toMatch(/^Video clip \d{4}-\d\d-\d\d at .+\.mp4$/);
    expect(await clip.text()).toBe("recorded");
  });

  it("records sound alone at its own rate", () => {
    const { start, recorder } = renderRecorder("audio");
    start();
    expect(recorder().options).toEqual({ audioBitsPerSecond: 96_000, mimeType: "audio/mp4" });
  });

  it("takes whatever the browser records where it records none of the types it's asked for", async () => {
    FakeRecorder.records = [];
    const { result, onRecorded, start, recorder } = renderRecorder();
    start();
    expect(recorder().options).not.toHaveProperty("mimeType");
    act(() => result.current.stop());
    await recorder().end();
    expect(onRecorded.mock.calls[0]![0].type).toBe("video/webm");
  });

  it("counts how long it has run, and stops by itself at five minutes, handing over the clip", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    const { result, onRecorded, start, recorder } = renderRecorder();
    start();
    act(() => vi.advanceTimersByTime(7_000));
    expect(Math.floor(result.current.seconds)).toBe(7);
    expect(recorder().state).toBe("recording");

    act(() => vi.advanceTimersByTime(293_000));
    expect(result.current.seconds).toBe(300);
    expect(recorder().state).toBe("inactive");
    await recorder().end();
    expect(onRecorded).toHaveBeenCalledOnce();
  });

  it("hands over the clip once what it records ends, as a camera unplugged does", async () => {
    const { result, onRecorded, start, recorder } = renderRecorder();
    start();
    await recorder().end();
    expect(result.current.recording).toBe(false);
    expect(onRecorded).toHaveBeenCalledOnce();
  });

  it("discards a clip, though it was stopped to keep, until it's been handed over", async () => {
    const { result, onRecorded, start, recorder } = renderRecorder();
    start();
    act(() => result.current.stop());
    act(() => result.current.discard());
    await recorder().end();
    expect(onRecorded).not.toHaveBeenCalled();
    expect(result.current.recording).toBe(false);
  });

  it("discards what it was recording when it starts again, or goes", async () => {
    const { result, onRecorded, start, recorder, unmount } = renderRecorder();
    start();
    start();
    expect(recorder(0).state).toBe("inactive");
    await recorder(0).end();
    expect(onRecorded).not.toHaveBeenCalled();
    // The second is still under way.
    expect(result.current.recording).toBe(true);

    unmount();
    expect(recorder(1).state).toBe("inactive");
    await recorder(1).end();
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("hands over nothing where the browser fails as it records, saying it couldn't record, unless it was being discarded", async () => {
    const { result, onRecorded, onFailed, start, recorder } = renderRecorder();
    start();
    await recorder(0).fail();
    expect(result.current.recording).toBe(false);
    expect(onRecorded).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledOnce();

    start();
    act(() => result.current.discard());
    await recorder(1).fail();
    expect(onFailed).toHaveBeenCalledOnce();
  });

  it("says it couldn't start where the browser won't record", () => {
    FakeRecorder.refuses = true;
    const { result } = renderRecorder();
    act(() => void expect(result.current.start(stream)).toBe(false));
    expect(result.current.recording).toBe(false);
  });
});
