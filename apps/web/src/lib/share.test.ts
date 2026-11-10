import { afterEach, describe, expect, it, vi } from "vitest";
import { shareFile } from "./share";

const MOON = "/files/k1/s1/moon.jpg";

/** A response with a picture of the moon. */
const moon = () => ({ ok: true, blob: async () => new Blob(["moon"], { type: "image/jpeg" }) });

/** What the browser says when the click that asked to share has expired. */
const tooLate = () => new DOMException("Must be handling a user gesture to perform a share request.", "NotAllowedError");

/** Gives the browser a share sheet that does what `share` does, and `fetch`, until the test ends. */
function stub(share: ReturnType<typeof vi.fn>, fetch: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "share", { value: share, configurable: true });
  vi.stubGlobal("fetch", fetch);
}

/** The file the share sheet got in its `call`th call. */
const fileOf = (share: ReturnType<typeof vi.fn>, call: number) => (share.mock.calls[call] as [ShareData])[0].files![0];

afterEach(() => {
  delete (navigator as Partial<Navigator>).share;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Download and share files", () => {
  it("keeps a file that came too late for the click that asked for it, sharing it at once the next time", async () => {
    const share = vi.fn().mockRejectedValueOnce(tooLate()).mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue(moon());
    stub(share, fetch);

    expect(await shareFile(MOON)).toBe("ready");
    expect(await shareFile(MOON)).toBe("opened");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fileOf(share, 1)).toBe(fileOf(share, 0));
    // Once.
    expect(await shareFile(MOON)).toBe("opened");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps it only for its own Share, and for a minute", async () => {
    vi.useFakeTimers();
    const share = vi.fn().mockRejectedValueOnce(tooLate()).mockResolvedValueOnce(undefined).mockRejectedValueOnce(tooLate()).mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue(moon());
    stub(share, fetch);

    expect(await shareFile(MOON)).toBe("ready");
    expect(await shareFile("/files/k2/s2/earth.jpg")).toBe("opened");
    expect(fetch).toHaveBeenLastCalledWith("/files/k2/s2/earth.jpg");
    expect(await shareFile(MOON)).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(60_000);
    expect(await shareFile(MOON)).toBe("opened");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("shares nothing when the file can't be had, rather than the error page", async () => {
    const share = vi.fn();
    const missing = { ok: false, status: 404, blob: async () => new Blob([], { type: "text/html" }) };
    stub(share, vi.fn().mockResolvedValueOnce(missing).mockRejectedValueOnce(new TypeError("Failed to fetch")));

    expect(await shareFile(MOON)).toBe("failed");
    expect(await shareFile(MOON)).toBe("failed");
    expect(share).not.toHaveBeenCalled();
  });

  it("fails for a file the browser won't share, even one kept for a fresh click", async () => {
    // As Chrome refuses a program right in the click that asked, after the download that outlasted the one before.
    const refused = () => new DOMException("Permission denied", "NotAllowedError");
    const share = vi
      .fn()
      .mockRejectedValueOnce(tooLate())
      .mockRejectedValueOnce(refused())
      .mockRejectedValueOnce(new TypeError("An invalid file was given"))
      .mockRejectedValueOnce(new DOMException("Unsupported file", "DataError"));
    stub(share, vi.fn().mockResolvedValue(moon()));

    expect(await shareFile(MOON)).toBe("ready");
    expect(await shareFile(MOON)).toBe("failed");
    expect(await shareFile(MOON)).toBe("failed");
    expect(await shareFile(MOON)).toBe("failed");
    expect(share).toHaveBeenCalledTimes(4);
  });

  it("needs no answer when the sheet is closed", async () => {
    stub(vi.fn().mockRejectedValue(new DOMException("Share canceled", "AbortError")), vi.fn().mockResolvedValue(moon()));
    expect(await shareFile(MOON)).toBe("opened");
  });
});
