import { qrCodeSvg } from "@ember/protocol/qr-code";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInLink } from "./sign-in-link";

const TRANSFER_ID = "u2.mgk3x2a9.Ab-_9z";
const LINK = `http://localhost:3000/session/transfers#token=${TRANSFER_ID}`;
const YOURS = "Use this link to login automatically on another device";
const THEIRS = "Share to get them back into their account";

/** Gives the browser `name`, as some browsers have it, until the test ends. */
function stubNavigator(name: "clipboard" | "canShare" | "share", value: unknown) {
  Object.defineProperty(navigator, name, { value, configurable: true });
  stubbed.push(name);
}
const stubbed: string[] = [];

afterEach(() => {
  for (const name of stubbed.splice(0)) delete (navigator as unknown as Record<string, unknown>)[name];
});

/** The Iconoir icons in `element`, by the class Iconoir names each with. */
const iconsOf = (element: Element) => [...element.querySelectorAll("svg")].map((icon) => [...icon.classList].find((name) => name.startsWith("iconoir-")));

describe("Private sign-in link", () => {
  it("shows your own link, read-only, named for screen readers only, under a laptop, an arrow and a phone", () => {
    render(<SignInLink transferId={TRANSFER_ID} mine />);
    const link = screen.getByRole("textbox", { name: YOURS });
    expect(link).toHaveValue(LINK);
    expect(link).toHaveAttribute("readonly");
    expect(screen.getByText(YOURS)).toHaveClass("sr-only");
    expect(iconsOf(screen.getByRole("group").querySelector("legend")!)).toEqual(["iconoir-laptop", "iconoir-arrow-right", "iconoir-smartphone-device"]);
    expect(screen.queryByText(THEIRS)).toBeNull();
  });

  it("says, beside a crown, that someone else's gets them back into their account", () => {
    render(<SignInLink transferId={TRANSFER_ID} mine={false} />);
    expect(screen.getByRole("textbox", { name: THEIRS })).toHaveValue(LINK);
    const label = screen.getByText(THEIRS);
    expect(label).not.toHaveClass("sr-only");
    expect(iconsOf(label.parentElement!)).toEqual(["iconoir-crown"]);
  });

  it("has the join link's buttons, named for the sign-in link, and shares it with a warning", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stubNavigator("canShare", () => true);
    stubNavigator("share", share);
    render(<SignInLink transferId={TRANSFER_ID} mine />);
    const qrCode = screen.getByRole("button", { name: "Show auto-login QR code" });
    const copy = screen.getByRole("button", { name: "Copy auto-login link" });
    expect([qrCode.nextElementSibling, copy.nextElementSibling]).toEqual([copy, screen.getByRole("button", { name: "Share auto-login link" })]);

    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator("clipboard", { writeText });
    await userEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(LINK);
    await userEvent.click(screen.getByRole("button", { name: "Share auto-login link" }));
    expect(share).toHaveBeenCalledWith({
      title: "Your sign-in link",
      text: "This is your own private sign-in URL, DO NOT SHARE IT. Use it to sign-in on another device or if you get locked out.",
      url: LINK,
    });
  });

  it("offers sharing only where the browser can share", () => {
    render(<SignInLink transferId={TRANSFER_ID} mine />);
    expect(screen.queryByRole("button", { name: "Share auto-login link" })).toBeNull();
  });
});

describe("QR codes for links", () => {
  it("draws the link's QR code in the page, as the Worker draws one, so the link never reaches the Worker", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const drawn: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      drawn.push(blob as Blob);
      return "blob:qr-code";
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    render(<SignInLink transferId={TRANSFER_ID} mine />);
    await userEvent.click(screen.getByRole("button", { name: "Show auto-login QR code" }));
    const viewer = await screen.findByRole("dialog", { name: "Image Viewer (Press escape to close)" });
    expect(viewer).toHaveAttribute("open");
    expect(viewer.querySelector("img")).toHaveAttribute("src", "blob:qr-code");
    const download = within(viewer).getByRole("link", { name: "Download file" });
    expect(download).toHaveAttribute("href", "blob:qr-code");
    expect(download).toHaveAttribute("download", "QR code.svg");
    expect(drawn.map((blob) => blob.type)).toEqual(["image/svg+xml; charset=utf-8"]);
    expect(await drawn[0]!.text()).toBe(qrCodeSvg(new TextEncoder().encode(LINK)));
    expect(fetch).not.toHaveBeenCalled();

    // Closing the viewer lets the drawing go.
    await userEvent.click(within(viewer).getByRole("button", { name: "Close image viewer" }));
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:qr-code");
    vi.restoreAllMocks();
  });
});
