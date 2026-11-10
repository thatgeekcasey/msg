import { useSyncExternalStore } from "react";

// Light / Dark / System, saved per browser and kept in step across tabs and with the device.

export type Appearance = "light" | "dark" | "system";

const KEY = "ember:appearance";
const media = () => matchMedia("(prefers-color-scheme: dark)");
const isAppearance = (value: unknown): value is Appearance => value === "light" || value === "dark" || value === "system";

/** The choice saved in this browser: System when there's none, it's unreadable or it's anything else. */
export function savedAppearance(): Appearance {
  try {
    const value = localStorage.getItem(KEY);
    return isAppearance(value) ? value : "system";
  } catch {
    return "system";
  }
}

/**
 * The choice the page shows, which `<html>` carries from index.html's script on. It's this page's
 * own, so a choice storage refused still holds when the device's theme changes.
 */
export function shownAppearance(): Appearance {
  const shown = document.documentElement.dataset.appearance;
  return isAppearance(shown) ? shown : savedAppearance();
}

const listeners = new Set<() => void>();

/**
 * Shows the page in a choice: the `dark` class the palette follows, the choice in `data-appearance`
 * with the matching `color-scheme`, and the theme color the browser draws around the page.
 */
export function applyAppearance(appearance: Appearance): void {
  const dark = appearance === "dark" || (appearance === "system" && media().matches);
  const html = document.documentElement;
  html.classList.toggle("dark", dark);
  html.dataset.appearance = appearance;
  html.style.colorScheme = dark ? "dark" : "light";
  // The page's background, in place of index.html's colors for the system's scheme.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = dark ? "#171717" : "#ffffff";
  listeners.forEach((listener) => listener());
}

/** Saves a choice, System as `system` like the others, and shows it. */
export function chooseAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(KEY, appearance);
  } catch {
    // Storage can be unavailable; the choice still applies to this page.
  }
  applyAppearance(appearance);
}

/**
 * Keeps the page in step with the device while it shows System, and with choices made in other tabs,
 * including clearing the site's storage, which goes back to System. Every page does this.
 */
export function followAppearance(): () => void {
  // First catch up with what changed while the page loaded, before anything was listening: another tab's
  // choice, or the device's theme under System.
  applyAppearance(savedAppearance());
  const onDeviceChange = () => {
    if (shownAppearance() === "system") applyAppearance("system");
  };
  // Clearing storage sends an event without a key.
  const onStorage = (event: StorageEvent) => (event.key === KEY || event.key === null) && applyAppearance(savedAppearance());
  const mql = media();
  mql.addEventListener("change", onDeviceChange);
  window.addEventListener("storage", onStorage);
  return () => {
    mql.removeEventListener("change", onDeviceChange);
    window.removeEventListener("storage", onStorage);
  };
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** The choice the page shows, re-rendering when it changes. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, shownAppearance);
}
