import { useEffect } from "react";

// Select on entry: tabbing or clicking into a one-line field selects what's in it, so typing replaces
// it, and a second click or a drag places the cursor as usual.

/** The fields that select on entry. Text areas, the message box among them, never do. */
const REPLACEABLE_TYPES = new Set(["text", "search", "email", "url", "tel", "password"]);
/** How far the pointer may move between pressing and clicking for the click to select. */
const CLICK_SLOP_PX = 6;
/**
 * The mark for a field that keeps the usual cursor, such as the icon picker's search. A page can carry
 * it too, for every field on it, as first-run setup does.
 */
const PRESERVED = "[data-ember-preserve-selection]";

function isReplaceable(target: EventTarget | null): target is HTMLInputElement {
  return target instanceof HTMLInputElement && REPLACEABLE_TYPES.has(target.type) && !target.disabled && !target.readOnly && !target.closest(PRESERVED);
}

/** Selects what's in a one-line field whenever one is entered, anywhere on the page. */
export function useSelectOnEntry(): void {
  useEffect(() => {
    // A press on a field that didn't have focus yet, and where. The click that ends it selects, not the
    // focus it gives: pressing on selected text drags it, so selecting on that focus would have a drag
    // across the field pick up all its text instead of selecting some.
    let press: { field: HTMLInputElement; x: number; y: number } | undefined;
    // What had focus when the window lost it. Coming back to the window focuses it again, which isn't
    // entering it, so it isn't selected again, which would have typing on replace what was typed before.
    let left: Element | null = null;

    const focusIn = (event: FocusEvent) => {
      const returning = event.target === left;
      left = null;
      if (!returning && press?.field !== event.target && isReplaceable(event.target)) event.target.select();
    };
    const pointerDown = (event: PointerEvent) => {
      press = event.button === 0 && isReplaceable(event.target) && document.activeElement !== event.target ? { field: event.target, x: event.clientX, y: event.clientY } : undefined;
    };
    const pointerCancel = () => {
      press = undefined;
    };
    // A press counts only while its field keeps focus, since the click can fail to come, as when
    // Control-click opens a menu instead.
    const focusOut = (event: FocusEvent) => {
      if (press?.field === event.target) press = undefined;
    };
    // Unless the pointer moved, as it does dragging to select part of the text.
    const click = (event: MouseEvent) => {
      if (press?.field === event.target && Math.hypot(event.clientX - press.x, event.clientY - press.y) < CLICK_SLOP_PX) press.field.select();
      press = undefined;
    };
    const windowBlur = () => {
      left = document.activeElement;
    };

    // Listening on the way down, so nothing a page does on the way back up can stop them.
    document.addEventListener("focusin", focusIn, true);
    document.addEventListener("focusout", focusOut, true);
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("pointercancel", pointerCancel, true);
    document.addEventListener("click", click, true);
    window.addEventListener("blur", windowBlur);
    return () => {
      document.removeEventListener("focusin", focusIn, true);
      document.removeEventListener("focusout", focusOut, true);
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("pointercancel", pointerCancel, true);
      document.removeEventListener("click", click, true);
      window.removeEventListener("blur", windowBlur);
    };
  }, []);
}
