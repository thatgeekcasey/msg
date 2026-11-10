import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSelectOnEntry } from "./use-select-on-entry";

function Page({ children }: { children?: ReactNode }) {
  useSelectOnEntry();
  return children;
}

const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
const selected = (input: HTMLInputElement) => input.value.slice(input.selectionStart!, input.selectionEnd!);

/** Presses on a field at (10, 10), which focuses it, as a browser does. */
function press(input: HTMLInputElement) {
  fireEvent.pointerDown(input, { button: 0, clientX: 10, clientY: 10 });
  input.focus();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Select a field's text on entry", () => {
  it("selects what's in a field Tab reaches, so typing replaces it", async () => {
    render(
      <Page>
        <button type="button">Before</button>
        <input aria-label="Room name" defaultValue="New room" />
      </Page>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Before" }));
    await user.tab();
    expect(selected(field("Room name"))).toBe("New room");
    await user.keyboard("Research");
    expect(field("Room name")).toHaveValue("Research");
  });

  it("selects it when it's clicked into, and lets a second click place the cursor", async () => {
    render(
      <Page>
        <input aria-label="Room name" defaultValue="Design" />
      </Page>,
    );
    const user = userEvent.setup();
    await user.click(field("Room name"));
    expect(selected(field("Room name"))).toBe("Design");
    await user.click(field("Room name"));
    expect(selected(field("Room name"))).toBe("");
    await user.keyboard(" team");
    expect(field("Room name")).toHaveValue("Design team");
  });

  it("selects a field focused as its page opens", () => {
    const { rerender } = render(<Page />);
    rerender(
      <Page>
        <input aria-label="Room name" defaultValue="New room" autoFocus />
      </Page>,
    );
    expect(selected(field("Room name"))).toBe("New room");
  });

  it("selects when the click ends rather than as the press focuses, so a drag can select part of the text", () => {
    render(
      <Page>
        <input aria-label="Room name" defaultValue="New room" />
        <input aria-label="Topic" defaultValue="Planning" />
      </Page>,
    );
    press(field("Room name"));
    // Selected already, the text would be dragged rather than selected by the pointer.
    expect(selected(field("Room name"))).toBe("");
    fireEvent.click(field("Room name"), { button: 0, clientX: 13, clientY: 14 });
    expect(selected(field("Room name"))).toBe("New room");

    // Dragging 6px or more selects what was dragged over, as usual.
    press(field("Topic"));
    field("Topic").setSelectionRange(3, 6);
    fireEvent.click(field("Topic"), { button: 0, clientX: 16, clientY: 10 });
    expect(selected(field("Topic"))).toBe("nni");
  });

  it("keeps what a press the browser took over selected, as a long press on a phone does", () => {
    render(
      <Page>
        <input aria-label="Room name" defaultValue="New room" />
      </Page>,
    );
    const name = field("Room name");
    press(name);
    name.setSelectionRange(0, 3);
    fireEvent.pointerCancel(name);
    fireEvent.click(name, { button: 0, clientX: 10, clientY: 10 });
    expect(selected(name)).toBe("New");
  });

  it("selects a field entered again after a press no click ended, as when Control-click opens a menu", () => {
    render(
      <Page>
        <input aria-label="Room name" defaultValue="Design" />
      </Page>,
    );
    const name = field("Room name");
    press(name);
    name.blur();
    name.focus();
    expect(selected(name)).toBe("Design");
  });

  it("selects text, search, email, URL, phone and password fields, and no others", () => {
    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    const selectable = ["text", "search", "email", "url", "tel", "password"];
    const others = ["number", "date", "checkbox", "file"];
    render(
      <Page>
        {[...selectable, ...others].map((type) => (
          <input key={type} type={type} aria-label={type} />
        ))}
      </Page>,
    );
    for (const type of [...selectable, ...others]) screen.getByLabelText(type).focus();
    expect(select.mock.contexts.map((input) => (input as HTMLInputElement).type)).toEqual(selectable);
  });

  it("never selects text areas, disabled or read-only fields, or fields marked to keep the cursor", () => {
    const select = vi.spyOn(HTMLInputElement.prototype, "select");
    render(
      <Page>
        <textarea aria-label="Message" defaultValue="Hello" />
        <input aria-label="Disabled" defaultValue="Hello" disabled />
        <input aria-label="Read-only" defaultValue="Hello" readOnly />
        <input aria-label="Search icons" type="search" defaultValue="coffee" data-ember-preserve-selection />
        <main data-ember-preserve-selection>
          <input aria-label="Name" defaultValue="Ada" />
        </main>
      </Page>,
    );
    for (const name of ["Message", "Read-only", "Search icons", "Name"]) screen.getByLabelText(name).focus();
    fireEvent.focusIn(screen.getByLabelText("Disabled"));
    expect(select).not.toHaveBeenCalled();
  });

  it("leaves a field as it was when the window comes back to it, and selects it when it's entered again", () => {
    render(
      <Page>
        <input aria-label="Room name" defaultValue="Design" />
      </Page>,
    );
    const name = field("Room name");
    name.focus();
    name.setSelectionRange(3, 3);
    // Leaving the window, then coming back, focuses the field again, as browsers do.
    fireEvent.blur(window);
    fireEvent.focusIn(name);
    expect(name.selectionStart).toBe(3);
    expect(selected(name)).toBe("");

    name.blur();
    name.focus();
    expect(selected(name)).toBe("Design");
  });

  it("stops once the app has gone", () => {
    const { unmount } = render(<Page />);
    unmount();
    render(<input aria-label="Room name" defaultValue="Design" />);
    field("Room name").focus();
    expect(selected(field("Room name"))).toBe("");
  });
});
