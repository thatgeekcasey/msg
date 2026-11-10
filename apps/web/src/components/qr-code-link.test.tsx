import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drawnQrCode } from "@/lib/qr-code";
import { QrCodeLink } from "./qr-code-link";

vi.mock("@/lib/qr-code", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/qr-code")>()), drawnQrCode: vi.fn() }));

const LINK = "http://localhost:3000/session/transfers#token=u2.mgk3x2a9.Ab-_9z";

/** Holds each drawing the button asks for until the returned function finishes them all at once. */
function holdDrawings(): () => Promise<void> {
  const held: Array<{ drawing: Promise<Blob>; finish: (drawing: Blob) => void }> = [];
  vi.mocked(drawnQrCode).mockImplementation(() => {
    let finish!: (drawing: Blob) => void;
    const drawing = new Promise<Blob>((resolve) => (finish = resolve));
    held.push({ drawing, finish });
    return drawing;
  });
  return () =>
    act(async () => {
      for (const { finish } of held) finish(new Blob(["<svg/>"], { type: "image/svg+xml; charset=utf-8" }));
      await Promise.all(held.map(({ drawing }) => drawing));
    });
}

/** The addresses given to drawings, and those let go since. */
function trackAddresses() {
  const given: string[] = [];
  const letGo: string[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    const address = `blob:drawing-${given.length}`;
    given.push(address);
    return address;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((address) => void letGo.push(address));
  return { given, letGo };
}

afterEach(() => vi.restoreAllMocks());

describe("QR codes for links", () => {
  it("gives no address to a drawing finished after the button has gone", async () => {
    const finishDrawings = holdDrawings();
    const { given } = trackAddresses();
    const { unmount } = render(
      <QrCodeLink url={LINK} drawn>
        QR code
      </QrCodeLink>,
    );
    fireEvent.click(screen.getByRole("button", { name: "QR code" }));
    unmount();
    await finishDrawings();
    expect(given).toEqual([]);
  });

  it("lets every drawing go once the viewer closes, however often the button was pressed", async () => {
    const finishDrawings = holdDrawings();
    const { given, letGo } = trackAddresses();
    render(
      <QrCodeLink url={LINK} drawn>
        QR code
      </QrCodeLink>,
    );
    fireEvent.click(screen.getByRole("button", { name: "QR code" }));
    fireEvent.click(screen.getByRole("button", { name: "QR code" }));
    await finishDrawings();
    const viewer = screen.getByRole("dialog", { name: "Image Viewer (Press escape to close)" });
    expect(viewer.querySelector("img")).toHaveAttribute("src", given.at(-1));
    expect(letGo).toEqual(given.slice(0, -1));

    fireEvent.click(within(viewer).getByRole("button", { name: "Close image viewer" }));
    expect(letGo).toEqual(given);
  });
});
