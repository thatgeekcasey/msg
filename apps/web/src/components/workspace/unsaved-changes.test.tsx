import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { leave, navigate } from "@/hooks/use-route";
import { UnsavedChanges } from "./unsaved-changes";

const SETTINGS_PATH = "/rooms/opens/design/edit";

type Props = Partial<Omit<ComponentProps<typeof UnsavedChanges>, "form">>;

/** A room's form under the guard, as the room pages have it, with a dialog of its own, as the icon picker's. */
function RoomForm({ changed = true, stays = () => false, onSave = async () => {} }: Props) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={form}>
        <input aria-label="Room name" required defaultValue="Design" />
        <dialog aria-label="Choose a room icon" />
      </form>
      <UnsavedChanges changed={changed} stays={stays} onSave={onSave} form={form} />
    </>
  );
}

/** The form at a room's settings, having come from `from` when there's one. */
function showForm(props: Props = {}, { from }: { from?: string } = {}) {
  if (from) {
    navigate(from, { replace: true });
    navigate(SETTINGS_PATH);
  } else {
    history.replaceState(null, "", SETTINGS_PATH);
  }
  const { rerender } = render(<RoomForm {...props} />);
  return { rerender: (props: Props) => rerender(<RoomForm {...props} />), user: userEvent.setup() };
}

const asking = () => screen.queryByRole("dialog", { name: "Unsaved Changes" });
const button = (name: string) => screen.getByRole("button", { name });
const goTo = (path: string) => act(() => navigate(path));
/** Whether the browser would ask before reloading or closing the tab. */
const unloadAsks = () => !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("Unsaved changes guard", () => {
  it("asks before another page, saying what's unsaved, with Save to hand", async () => {
    const { user } = showForm();
    goTo("/rooms/general");
    const dialog = await screen.findByRole("dialog", { name: "Unsaved Changes" });
    expect(dialog).toHaveAccessibleDescription("You’ve made changes to this room. Save them before you leave, or discard them to keep things as they were.");
    expect(button("Save")).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(location.pathname).toBe(SETTINGS_PATH);

    // Tab goes round the dialog's buttons.
    await user.tab();
    expect(button("Keep editing")).toHaveFocus();
    await user.tab();
    expect(button("Discard")).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(button("Save")).toHaveFocus();
  });

  it("keeps editing with the close button or Escape, but not a click beside it", async () => {
    const { user } = showForm();
    goTo("/rooms/general");
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(asking()).not.toBeInTheDocument());
    expect(location.pathname).toBe(SETTINGS_PATH);

    goTo("/rooms/general");
    await screen.findByRole("dialog", { name: "Unsaved Changes" });
    await user.click(document.querySelector("[data-slot=dialog-overlay]")!);
    expect(asking()).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(asking()).not.toBeInTheDocument());
    expect(location.pathname).toBe(SETTINGS_PATH);
  });

  it("discards the changes and goes on, asking no more", async () => {
    const { user } = showForm();
    goTo("/rooms/general");
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(location.pathname).toBe("/rooms/general");
    await waitFor(() => expect(asking()).not.toBeInTheDocument());
    expect(unloadAsks()).toBe(false);

    goTo(SETTINGS_PATH);
    expect(location.pathname).toBe(SETTINGS_PATH);
    expect(asking()).not.toBeInTheDocument();
  });

  it("saves the changes, holding the page until they're saved, then goes on", async () => {
    let saved = () => {};
    const onSave = vi.fn(() => new Promise<void>((resolve) => (saved = resolve)));
    const { user } = showForm({ onSave });
    goTo("/rooms/general");
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(asking()).toHaveAttribute("aria-busy", "true");
    expect(button("Saving…")).toBeDisabled();
    expect(button("Discard")).toBeDisabled();
    expect(button("Keep editing")).toBeDisabled();
    await user.keyboard("{Escape}");
    goTo("/rooms/random");
    expect(asking()).toBeInTheDocument();
    expect(location.pathname).toBe(SETTINGS_PATH);

    await act(async () => saved());
    expect(location.pathname).toBe("/rooms/general");
    await waitFor(() => expect(asking()).not.toBeInTheDocument());
  });

  it("stays, saying so, when the changes couldn't be saved", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("Name must be 1 to 100 characters")).mockResolvedValue(undefined);
    const { user } = showForm({ onSave });
    goTo("/rooms/general");
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your changes couldn’t be saved. Please try again, or keep editing.");
    expect(button("Save")).toBeEnabled();
    expect(location.pathname).toBe(SETTINGS_PATH);

    // Asking again starts afresh.
    await user.click(button("Keep editing"));
    await waitFor(() => expect(asking()).not.toBeInTheDocument());
    goTo("/rooms/general");
    await screen.findByRole("dialog", { name: "Unsaved Changes" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(button("Save"));
    await waitFor(() => expect(location.pathname).toBe("/rooms/general"));
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("closes the form's own dialogs first, which would stay above it, as the icon picker's native one does", async () => {
    showForm();
    const picker = document.querySelector("dialog")!;
    picker.showModal();
    goTo("/rooms/general");
    expect(await screen.findByRole("dialog", { name: "Unsaved Changes" })).toBeInTheDocument();
    expect(picker.open).toBe(false);
  });

  it("has the form point out a field it won't take, rather than saving", async () => {
    const report = vi.spyOn(HTMLFormElement.prototype, "reportValidity");
    const onSave = vi.fn(async () => {});
    const { user } = showForm({ onSave });
    await user.clear(screen.getByRole("textbox", { name: "Room name" }));
    goTo("/rooms/general");
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(asking()).not.toBeInTheDocument());
    expect(report).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    expect(location.pathname).toBe(SETTINGS_PATH);
  });

  it("doesn't ask without changes, or for the form's other address", () => {
    const { rerender } = showForm({ changed: false });
    goTo("/rooms/general");
    expect(location.pathname).toBe("/rooms/general");

    goTo(SETTINGS_PATH);
    rerender({ stays: (path) => path === "/rooms/closeds/design/edit" });
    act(() => navigate("/rooms/closeds/design/edit", { replace: true }));
    expect(location.pathname).toBe("/rooms/closeds/design/edit");
    expect(asking()).not.toBeInTheDocument();
  });

  it("asks before going Back, and goes Back once the changes are discarded", async () => {
    const { user } = showForm({}, { from: "/rooms/general" });
    act(() => history.back());
    await screen.findByRole("dialog", { name: "Unsaved Changes" });
    await waitFor(() => expect(location.pathname).toBe(SETTINGS_PATH));
    await user.click(button("Discard"));
    await waitFor(() => expect(location.pathname).toBe("/rooms/general"));
  });

  it("asks before signing out, and signs out once the changes are saved", async () => {
    const signOut = vi.fn();
    const onSave = vi.fn(async () => {});
    const { user } = showForm({ onSave });
    act(() => leave(signOut));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("lets a sign-out through once the changes are discarded, and guards them again if it fails", async () => {
    let signedOut = (_: boolean) => {};
    const signOut = vi.fn(() => new Promise<boolean>((resolve) => (signedOut = resolve)));
    const { user } = showForm();
    act(() => leave(signOut));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(signOut).toHaveBeenCalledOnce();
    // Signing out goes on to load the sign-in page, which mustn't ask.
    expect(unloadAsks()).toBe(false);

    await act(async () => signedOut(false));
    expect(unloadAsks()).toBe(true);
    goTo("/rooms/general");
    expect(await screen.findByRole("dialog", { name: "Unsaved Changes" })).toBeInTheDocument();
    expect(location.pathname).toBe(SETTINGS_PATH);
  });

  it("has the browser ask before reloading or closing the tab, only while there are changes", () => {
    const { rerender } = showForm({ changed: false });
    expect(unloadAsks()).toBe(false);
    rerender({ changed: true });
    expect(unloadAsks()).toBe(true);
    rerender({ changed: false });
    expect(unloadAsks()).toBe(false);
  });
});
