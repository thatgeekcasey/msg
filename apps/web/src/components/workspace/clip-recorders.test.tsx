import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { posterTimeOf } from "@/lib/clips";
import { FakeRecorder, installRecording, lastRecorder as recorder, type FakeMedia } from "@/test-recording";
import {
  ASKING_FOR_CAMERA,
  ASKING_FOR_MICROPHONE,
  AudioClipRecorder,
  NO_CLIP_CAMERA,
  NO_CLIP_MICROPHONE,
  NOT_RECORDED,
  SILENT_CLIP,
  VideoClipDialog,
} from "./clip-recorders";

let media: FakeMedia;

beforeEach(() => {
  media = installRecording();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:clip");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  // jsdom plays nothing.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "mediaDevices");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function showVideoRecorder() {
  const onRecorded = vi.fn((_clip: File) => {});
  const onClose = vi.fn();
  const view = render(<VideoClipDialog onRecorded={onRecorded} onClose={onClose} />);
  return { ...view, onRecorded, onClose, user: userEvent.setup() };
}

const status = () => screen.getByRole("status");
const button = (name: string) => screen.getByRole("button", { name });

/** Has the clip played say how long it is, as a browser does once it has read that far. */
function loadClip(seconds: number) {
  const played = screen.getByLabelText("Your clip");
  Object.defineProperty(played, "duration", { value: seconds, configurable: true });
  fireEvent.loadedMetadata(played);
}

describe("Record video clip", () => {
  it("shows your camera, as a mirror does, once the browser lets Ember use it and the microphone, then records both until Stop recording", async () => {
    media.pending = true;
    const { user } = showVideoRecorder();
    expect(screen.getByRole("dialog", { name: "Record video clip" })).toHaveAccessibleDescription("A clip can be up to 5 minutes long.");
    expect(screen.getByText(ASKING_FOR_CAMERA)).toBeInTheDocument();
    expect(status()).toHaveTextContent(ASKING_FOR_MICROPHONE);
    expect(button("Record")).toBeDisabled();
    // A picture as large as a message shows one.
    expect(media.asked).toContainEqual({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });

    await media.answer();
    expect(screen.getByLabelText("Your camera")).toHaveClass("-scale-x-100");
    expect(status()).toBeEmptyDOMElement();
    expect(screen.getByLabelText("Microphone")).toHaveDisplayValue("Built-in Microphone");
    expect(screen.getByLabelText("Camera")).toHaveDisplayValue("FaceTime HD Camera");

    await user.click(button("Record"));
    expect(recorder().stream.getTracks()).toEqual([...media.tracks("video"), ...media.tracks("audio")]);
    expect(screen.getByRole("timer")).toHaveAccessibleName("Recording, 0:00 of 5:00");
    expect(screen.getByLabelText("Microphone")).toBeDisabled();
    expect(screen.getByLabelText("Camera")).toBeDisabled();

    await user.click(button("Stop recording"));
    expect(recorder().state).toBe("inactive");
    await recorder().end();
    expect(screen.getByLabelText("Your clip")).toHaveAttribute("src", "blob:clip");
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });

  it("chooses the clip's thumbnail from it, then leaves the clip to go with the next message on Done", async () => {
    const { user, onRecorded, onClose } = showVideoRecorder();
    await user.click(await screen.findByRole("button", { name: "Record" }));
    await user.click(button("Stop recording"));
    await recorder().end();
    // Only once the browser knows how long the clip is.
    expect(screen.queryByLabelText("Thumbnail")).not.toBeInTheDocument();
    loadClip(12.5);
    const thumbnail = screen.getByLabelText("Thumbnail");
    expect(thumbnail).toHaveAttribute("max", "12.5");
    expect(thumbnail).toHaveAccessibleDescription("The picture the clip shows before it's played.");

    fireEvent.change(thumbnail, { target: { value: "3" } });
    expect(thumbnail).toHaveAttribute("aria-valuetext", "0:03");
    expect(screen.getByLabelText<HTMLVideoElement>("Your clip").currentTime).toBe(3);

    await user.click(button("Done"));
    expect(onRecorded).toHaveBeenCalledOnce();
    const [clip] = onRecorded.mock.calls[0]!;
    expect(clip.type).toBe("video/mp4");
    expect(clip.name).toMatch(/^Video clip .+\.mp4$/);
    expect(posterTimeOf(clip)).toBe(3);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("takes the thumbnail from the start, as any video's, where none is chosen", async () => {
    const { user, onRecorded } = showVideoRecorder();
    await user.click(await screen.findByRole("button", { name: "Record" }));
    await user.click(button("Stop recording"));
    await recorder().end();
    loadClip(4);
    await user.click(button("Done"));
    expect(posterTimeOf(onRecorded.mock.calls[0]![0])).toBeUndefined();
  });

  it("records again, discarding the clip, and Cancel closes it, letting go of the camera and microphone", async () => {
    const { user, onRecorded, onClose, unmount } = showVideoRecorder();
    await user.click(await screen.findByRole("button", { name: "Record" }));
    await user.click(button("Stop recording"));
    await recorder().end();
    await user.click(button("Record again"));
    expect(screen.getByLabelText("Your camera")).toBeInTheDocument();
    expect(button("Record")).toBeEnabled();

    await user.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(onRecorded).not.toHaveBeenCalled();
    expect([...media.tracks("audio"), ...media.tracks("video")].every((track) => track.stopped)).toBe(true);
  });

  it("discards what it's recording as it closes", async () => {
    const { user, onRecorded, unmount } = showVideoRecorder();
    await user.click(await screen.findByRole("button", { name: "Record" }));
    await user.keyboard("{Escape}");
    unmount();
    expect(recorder().state).toBe("inactive");
    await recorder().end();
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("mutes the microphone and turns off the camera, in the clip too", async () => {
    const { user } = showVideoRecorder();
    await user.click(await screen.findByRole("button", { name: "Mute microphone" }));
    expect(media.tracks("audio")[0]!.enabled).toBe(false);
    await user.click(button("Turn off camera"));
    expect(media.tracks("video")[0]!.enabled).toBe(false);
    expect(screen.getByText("Your camera is off.")).toBeInTheDocument();

    await user.click(button("Unmute microphone"));
    await user.click(button("Turn on camera"));
    expect(media.tracks("audio")[0]!.enabled).toBe(true);
    expect(media.tracks("video")[0]!.enabled).toBe(true);
  });

  it("opens the camera chosen in place of the last, which it lets go of", async () => {
    const { user } = showVideoRecorder();
    await user.selectOptions(await screen.findByLabelText("Camera"), "USB Webcam");
    expect(media.asked.at(-1)).toEqual({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, deviceId: { exact: "cam-2" } } });
    expect(media.tracks("video")[0]!.stopped).toBe(true);
    expect(await screen.findByLabelText("Camera")).toHaveDisplayValue("USB Webcam");
  });

  it("records the camera alone where there's no microphone, saying the clip will have no sound", async () => {
    media.refusesMicrophones = true;
    const { user } = showVideoRecorder();
    expect(await screen.findByText(SILENT_CLIP)).toBeInTheDocument();
    expect(button("Mute microphone")).toBeDisabled();
    await user.click(button("Record"));
    expect(recorder().stream.getTracks()).toEqual(media.tracks("video"));
  });

  it("can't record without a camera, saying how to let Ember use one", async () => {
    media.refusesCameras = true;
    showVideoRecorder();
    expect(await screen.findByText(NO_CLIP_CAMERA)).toBeInTheDocument();
    expect(button("Record")).toBeDisabled();
    expect(button("Turn off camera")).toBeDisabled();
  });

  it("says so where the browser won't record", async () => {
    FakeRecorder.refuses = true;
    const { user } = showVideoRecorder();
    await user.click(await screen.findByRole("button", { name: "Record" }));
    expect(status()).toHaveTextContent(NOT_RECORDED);
    expect(button("Record")).toBeEnabled();
  });

  it("says so where the browser fails as it records, showing nothing to keep, but Record", async () => {
    const { user } = showVideoRecorder();
    await user.click(await screen.findByRole("button", { name: "Record" }));
    await recorder().fail();
    expect(status()).toHaveTextContent(NOT_RECORDED);
    expect(screen.queryByLabelText("Your clip")).not.toBeInTheDocument();
    expect(button("Record")).toBeEnabled();
  });
});

function showAudioRecorder() {
  const onRecorded = vi.fn((_clip: File) => {});
  const onClose = vi.fn();
  const view = render(<AudioClipRecorder onRecorded={onRecorded} onClose={onClose} />);
  return { ...view, onRecorded, onClose, user: userEvent.setup() };
}

describe("Record audio clip", () => {
  it("records from the microphone once the browser lets Ember use it, until Done, which leaves the clip to go with the next message", async () => {
    media.pending = true;
    const { user, onRecorded, onClose } = showAudioRecorder();
    const recording = screen.getByRole("group", { name: "Record audio clip" });
    expect(recording).toHaveFocus();
    expect(status()).toHaveTextContent(ASKING_FOR_MICROPHONE);
    expect(media.asked).toEqual([{ audio: true }]);

    await media.answer();
    expect(recorder().stream).toBe(media.opened[0]);
    expect(recorder().mimeType).toBe("audio/mp4");
    expect(screen.getByRole("timer")).toHaveAccessibleName("Recording, 0:00 of 5:00");
    expect(button("Done")).toHaveFocus();

    await user.click(button("Done"));
    expect(recorder().state).toBe("inactive");
    await recorder().end();
    expect(onRecorded).toHaveBeenCalledOnce();
    const [clip] = onRecorded.mock.calls[0]!;
    expect(clip.type).toBe("audio/mp4");
    expect(clip.name).toMatch(/^Audio clip .+\.m4a$/);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("discards the clip on Cancel, or Escape", async () => {
    const { user, onRecorded, onClose } = showAudioRecorder();
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    await recorder().end();
    expect(onRecorded).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("lets go of the microphone as it closes", async () => {
    const { unmount } = showAudioRecorder();
    await screen.findByRole("timer");
    unmount();
    expect(media.tracks("audio")[0]!.stopped).toBe(true);
    expect(recorder().state).toBe("inactive");
  });

  it("says how to let Ember use a microphone where there's none, until it's closed", async () => {
    media.refusesMicrophones = true;
    const { user, onClose } = showAudioRecorder();
    expect(await screen.findByText(NO_CLIP_MICROPHONE)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    await user.click(button("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says so where the browser won't record", async () => {
    FakeRecorder.refuses = true;
    showAudioRecorder();
    expect(await screen.findByText(NOT_RECORDED)).toBeInTheDocument();
  });

  it("says so where the browser fails as it records, leaving nothing to go with the next message, until it's closed", async () => {
    media.pending = true;
    const { user, onRecorded, onClose } = showAudioRecorder();
    await media.answer();
    expect(button("Done")).toHaveFocus();
    await recorder().fail();
    expect(status()).toHaveTextContent(NOT_RECORDED);
    expect(onRecorded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // Done goes, and focus with it stays in the recorder, where Escape closes it, as Close does.
    expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Record audio clip" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    await user.click(button("Close"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("leaves focus on Cancel, which becomes Close, where the browser fails as it records", async () => {
    media.pending = true;
    const { user } = showAudioRecorder();
    await media.answer();
    await user.tab({ shift: true });
    expect(button("Cancel")).toHaveFocus();
    await recorder().fail();
    expect(button("Close")).toHaveFocus();
  });
});
