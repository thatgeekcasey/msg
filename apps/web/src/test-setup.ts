// First, so React sees it when it loads.
import "./test-animation-event";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { installMatchMedia, setPrefersDark } from "./test-media";

// Lexxy doesn't keep what's written under jsdom, so the message editor is a stand-in here
// (components/workspace/__mocks__/rich-text-editor.tsx), and e2e/ tests the real one.
vi.mock("./components/workspace/rich-text-editor");

// jsdom has no matchMedia, so this one says every query is false (a mouse, light mode) unless a
// test sets the color scheme or stubs it.
installMatchMedia();

// jsdom doesn't lay anything out, so nothing ever resizes or scrolls into view. The message list
// only needs to be able to start observing; its own tests say what's in view.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
} as unknown as typeof IntersectionObserver;
Element.prototype.scrollIntoView ??= () => {};

// jsdom's dialogs can't open or close, so these do what browsers do, short of the top layer and
// moving focus.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  if (!this.open) return;
  this.open = false;
  this.dispatchEvent(new Event("close"));
};

afterEach(() => {
  // Testing Library only unmounts between tests by itself when Vitest's globals are on.
  cleanup();
  localStorage.clear();
  setPrefersDark(false);
  // What the appearance puts on <html>.
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-appearance");
  document.documentElement.removeAttribute("style");
});
