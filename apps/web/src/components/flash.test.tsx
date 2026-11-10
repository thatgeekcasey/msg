import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flashOnNextPage, type FlashMessage } from "@/lib/flash";
import { FlashProvider, useFlash } from "./flash";

/** A page with a button for each message it flashes. */
function Page({ messages }: { messages: FlashMessage[] }) {
  const flash = useFlash();
  return messages.map(({ kind, text }) => (
    <button key={`${kind} ${text}`} type="button" onClick={() => flash(kind, text)}>
      {`${kind}: ${text}`}
    </button>
  ));
}

const REFUSED: FlashMessage = { kind: "alert", text: "Too many requests or unauthorized." };
const SAVED: FlashMessage = { kind: "notice", text: "Changes saved." };
const CHECK: FlashMessage = { kind: "notice", text: "✓" };

/** Shows a page that can flash `messages`, and flashes the first. */
async function flashFirst(messages: FlashMessage[], { workspace = false } = {}) {
  render(
    <FlashProvider workspace={workspace}>
      <Page messages={messages} />
    </FlashProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getAllByRole("button")[0]!);
  return user;
}

afterEach(() => sessionStorage.clear());

describe("Saved notices", () => {
  it("alerts in white on red with a warning sign, fading in and out", async () => {
    await flashFirst([REFUSED]);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Too many requests or unauthorized.");
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert).toHaveClass("animate-flash", "bg-negative", "text-white");
    expect(alert.querySelector("svg")).toHaveClass("iconoir-warning-triangle");
  });

  it("gives notices a check in white on green", async () => {
    await flashFirst([SAVED]);
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("Changes saved.");
    expect(notice).toHaveClass("animate-flash", "bg-positive", "text-white");
    expect(notice.querySelectorAll("svg")).toHaveLength(1);
    expect(notice.querySelector("svg")).toHaveClass("iconoir-check-circle");
  });

  it("shows a notice of just ✓ as the check alone, read as Changes saved", async () => {
    await flashFirst([CHECK]);
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(/^Changes saved$/);
    expect(notice.querySelector("span")).toHaveClass("sr-only");
    expect(notice.querySelectorAll("svg")).toHaveLength(1);
  });

  it("shows without fading, for as long, to people who ask for reduced motion", async () => {
    await flashFirst([SAVED]);
    expect(screen.getByRole("alert")).toHaveClass("motion-reduce:animate-flash-still");
  });

  it("goes once it has faded", async () => {
    await flashFirst([REFUSED]);
    fireEvent.animationEnd(screen.getByRole("alert"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows one at a time, the latest fading in afresh, even when it's the same again", async () => {
    const user = await flashFirst([REFUSED, SAVED]);
    const refused = screen.getByRole("alert");
    await user.click(screen.getByRole("button", { name: /^notice/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Changes saved.");
    expect(refused).not.toBeInTheDocument();

    const saved = screen.getByRole("alert");
    await user.click(screen.getByRole("button", { name: /^notice/ }));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).not.toBe(saved);
  });

  it("is centered over the window outside the workspace", async () => {
    await flashFirst([REFUSED]);
    expect(screen.getByRole("alert").parentElement).toHaveClass("left-1/2");
    expect(screen.getByRole("alert").parentElement).not.toHaveClass("md:left-[calc((100%+env(safe-area-inset-left)+var(--spacing-rail)+var(--spacing-sidebar))/2)]");
  });

  it("is centered beside the rail and sidebar over the workspace", async () => {
    await flashFirst([REFUSED], { workspace: true });
    expect(screen.getByRole("alert").parentElement).toHaveClass("md:left-[calc((100%+env(safe-area-inset-left)+var(--spacing-rail)+var(--spacing-sidebar))/2)]");
  });

  it("flashes what the page before a full page load kept for it, once", async () => {
    flashOnNextPage(CHECK);
    const { unmount } = render(<FlashProvider>page</FlashProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Changes saved");
    unmount();

    render(<FlashProvider>page</FlashProvider>);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("can only flash inside a FlashProvider", () => {
    // React reports the error it rethrows.
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Page messages={[REFUSED]} />)).toThrow("useFlash needs a FlashProvider around it");
    report.mockRestore();
  });
});
