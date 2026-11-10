import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InviteLink } from "./invite-link";

const JOIN_CODE = "aB3d-Ef5h-iJ7k";
const LINK = `http://localhost:3000/join/${JOIN_CODE}`;
/** The link as padded URL-safe base64. */
const QR_CODE = "/qr_code/aHR0cDovL2xvY2FsaG9zdDozMDAwL2pvaW4vYUIzZC1FZjVoLWlKN2s=";

/** Gives the browser `name`, as some browsers have it, until the test ends. */
function stubNavigator(name: "clipboard" | "canShare" | "share", value: unknown) {
  Object.defineProperty(navigator, name, { value, configurable: true });
  stubbed.push(name);
}
const stubbed: string[] = [];

afterEach(() => {
  for (const name of stubbed.splice(0)) delete (navigator as unknown as Record<string, unknown>)[name];
});

describe("Join link", () => {
  it("shows the absolute join link, read-only, under a label everyone sees", () => {
    render(<InviteLink joinCode={JOIN_CODE} />);
    const link = screen.getByRole("textbox", { name: "Share to invite more people" });
    expect(link).toHaveValue(LINK);
    expect(link).toHaveAttribute("readonly");
    expect(screen.getByText("Share to invite more people")).not.toHaveClass("sr-only");
  });

  it("has the welcome card's buttons, in its order", async () => {
    stubNavigator("canShare", () => true);
    render(<InviteLink joinCode={JOIN_CODE} />);
    const qrCode = screen.getByRole("link", { name: "Show join link QR code" });
    expect(qrCode).toHaveAttribute("href", QR_CODE);
    const copy = screen.getByRole("button", { name: "Copy join link" });
    expect([qrCode.nextElementSibling, copy.nextElementSibling]).toEqual([copy, screen.getByRole("button", { name: "Share join link" })]);

    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator("clipboard", { writeText });
    await userEvent.click(copy);
    expect(writeText).toHaveBeenCalledWith(LINK);
  });

  it("offers sharing only where the browser can share", () => {
    render(<InviteLink joinCode={JOIN_CODE} />);
    expect(screen.queryByRole("button", { name: "Share join link" })).not.toBeInTheDocument();
  });
});

describe("Regenerate the join link", () => {
  it("ends with Regenerate join link for whoever can regenerate it", async () => {
    const onRegenerate = vi.fn();
    render(<InviteLink joinCode={JOIN_CODE} onRegenerate={onRegenerate} />);
    const regenerate = screen.getByRole("button", { name: "Regenerate join link" });
    expect(regenerate.previousElementSibling).toBe(screen.getByRole("button", { name: "Copy join link" }));
    await userEvent.click(regenerate);
    expect(onRegenerate).toHaveBeenCalledOnce();
  });

  it("can't regenerate it again while a new code is on its way", () => {
    render(<InviteLink joinCode={JOIN_CODE} onRegenerate={vi.fn()} regenerating />);
    expect(screen.getByRole("button", { name: "Regenerate join link" })).toBeDisabled();
  });

  it("has no Regenerate join link for anyone else", () => {
    render(<InviteLink joinCode={JOIN_CODE} />);
    expect(screen.queryByRole("button", { name: "Regenerate join link" })).not.toBeInTheDocument();
  });
});

describe("QR codes for links", () => {
  it("opens the join link's QR code in the image viewer", async () => {
    render(<InviteLink joinCode={JOIN_CODE} />);
    await userEvent.click(screen.getByRole("link", { name: "Show join link QR code" }));
    const viewer = screen.getByRole("dialog", { name: "Image Viewer (Press escape to close)" });
    expect(viewer).toHaveAttribute("open");
    expect(viewer.querySelector(`img[src="${QR_CODE}"]`)).toBeInTheDocument();
    expect(within(viewer).getByRole("link", { name: "Download file" })).toHaveAttribute("download", "QR code.svg");
  });
});
