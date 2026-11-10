import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlashProvider } from "./flash";
import { SHARE_FAILED, SHARE_READY, ShareButton } from "./share-button";

const MOON = "/files/k1/s1/moon.jpg";

afterEach(() => {
  delete (navigator as Partial<Navigator>).share;
  vi.unstubAllGlobals();
});

function show() {
  render(
    <FlashProvider>
      <ShareButton url={MOON} sharedTitle="moon.jpg" aria-label="Share" />
    </FlashProvider>,
  );
  return screen.getByRole("button", { name: "Share" });
}

describe("Download and share files", () => {
  it("says to choose Share again when the file came too late for the click, which then shares it", async () => {
    const share = vi.fn().mockRejectedValueOnce(new DOMException("Must be handling a user gesture", "NotAllowedError")).mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["moon"], { type: "image/jpeg" }) });
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    vi.stubGlobal("fetch", fetch);
    const button = show();

    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(SHARE_READY);
    await userEvent.click(button);
    await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(2));
    expect(share).toHaveBeenLastCalledWith({ title: "moon.jpg", text: "", files: [expect.any(File)] });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("says so when the file couldn't be had", async () => {
    const share = vi.fn();
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, blob: async () => new Blob([]) }));

    await userEvent.click(show());
    expect(await screen.findByRole("alert")).toHaveTextContent(SHARE_FAILED);
    expect(share).not.toHaveBeenCalled();
  });
});
