let boundary: HTMLElement | undefined;

/**
 * An invisible box over the part of the screen that's clear of a phone's notch, rounded corners and
 * home indicator. Menus use it as their collision boundary, so they never open underneath those.
 */
export function safeAreaBoundary(): HTMLElement {
  if (!boundary) {
    boundary = document.createElement("div");
    boundary.style.cssText =
      "position: fixed; inset: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); visibility: hidden; pointer-events: none";
    document.body.append(boundary);
  }
  return boundary;
}
