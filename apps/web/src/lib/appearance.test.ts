import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setPrefersDark } from "@/test-media";
import { applyAppearance, chooseAppearance, followAppearance, savedAppearance, shownAppearance, useAppearance } from "./appearance";

const html = document.documentElement;
const isDark = () => html.classList.contains("dark");

/** Another tab's change to the saved choice, or its clearing the site's storage when `key` is null. */
function changeInAnotherTab(key: string | null, value?: string) {
  if (key === null) localStorage.clear();
  else if (value !== undefined) localStorage.setItem(key, value);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value ?? null }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Light, dark or system appearance", () => {
  it("saves each choice in this browser, System as `system`, and applies it", () => {
    chooseAppearance("dark");
    expect(localStorage.getItem("ember:appearance")).toBe("dark");
    expect(isDark()).toBe(true);

    chooseAppearance("light");
    expect(localStorage.getItem("ember:appearance")).toBe("light");
    expect(isDark()).toBe(false);

    setPrefersDark(true);
    chooseAppearance("system");
    expect(localStorage.getItem("ember:appearance")).toBe("system");
    expect(savedAppearance()).toBe("system");
    expect(isDark()).toBe(true);
  });

  it("follows the system when nothing's saved, or something unexpected is", () => {
    expect(savedAppearance()).toBe("system");
    localStorage.setItem("ember:appearance", "sepia");
    expect(savedAppearance()).toBe("system");
  });

  it("puts the choice and its color scheme on <html>", () => {
    applyAppearance("dark");
    expect(html.dataset.appearance).toBe("dark");
    expect(html.style.colorScheme).toBe("dark");

    applyAppearance("light");
    expect(html.dataset.appearance).toBe("light");
    expect(html.style.colorScheme).toBe("light");

    setPrefersDark(true);
    applyAppearance("system");
    expect(html.dataset.appearance).toBe("system");
    expect(html.style.colorScheme).toBe("dark");
  });

  it("colors the browser around the page to match, in place of the colors for the system's scheme", () => {
    // index.html's.
    document.head.innerHTML = `<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">`;
    const themeColors = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((meta) => meta.content);

    chooseAppearance("dark");
    expect(themeColors()).toEqual(["#171717", "#171717"]);
    chooseAppearance("light");
    expect(themeColors()).toEqual(["#ffffff", "#ffffff"]);
    setPrefersDark(true);
    applyAppearance("system");
    expect(themeColors()).toEqual(["#171717", "#171717"]);
    document.head.innerHTML = "";
  });

  it("starts from the choice index.html's script put on <html>", () => {
    localStorage.setItem("ember:appearance", "dark");
    expect(shownAppearance()).toBe("dark");
    html.dataset.appearance = "light";
    expect(shownAppearance()).toBe("light");
  });

  it("keeps up with the device while showing System, and only then", () => {
    const stop = followAppearance();
    setPrefersDark(true);
    expect(isDark()).toBe(true);
    setPrefersDark(false);
    expect(isDark()).toBe(false);

    chooseAppearance("light");
    setPrefersDark(true);
    expect(isDark()).toBe(false);
    stop();
  });

  it("follows a choice made in another tab, and its clearing the site's storage", () => {
    const stop = followAppearance();
    changeInAnotherTab("ember:appearance", "dark");
    expect(html.dataset.appearance).toBe("dark");
    expect(isDark()).toBe(true);

    changeInAnotherTab("something-else", "light");
    expect(html.dataset.appearance).toBe("dark");

    changeInAnotherTab(null);
    expect(html.dataset.appearance).toBe("system");
    expect(isDark()).toBe(false);
    stop();
  });

  it("catches up with a choice another tab made while the page loaded, before it was listening", () => {
    // index.html's script showed Light, then another tab chose Dark before the app started.
    applyAppearance("light");
    localStorage.setItem("ember:appearance", "dark");

    const stop = followAppearance();
    expect(shownAppearance()).toBe("dark");
    expect(isDark()).toBe(true);
    stop();
  });

  it("catches up with the device turning dark while the page loaded, on System", () => {
    applyAppearance("system");
    setPrefersDark(true);
    expect(isDark()).toBe(false);

    const stop = followAppearance();
    expect(isDark()).toBe(true);
    stop();
  });

  it("keeps a choice storage refused for this page, even as the device changes", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    const stop = followAppearance();
    expect(shownAppearance()).toBe("system");
    chooseAppearance("dark");
    expect(isDark()).toBe(true);

    setPrefersDark(true);
    setPrefersDark(false);
    expect(isDark()).toBe(true);
    expect(shownAppearance()).toBe("dark");
    stop();
  });

  it("re-renders with each change, here or from another tab", () => {
    const stop = followAppearance();
    const { result } = renderHook(useAppearance);
    expect(result.current).toBe("system");

    act(() => chooseAppearance("dark"));
    expect(result.current).toBe("dark");
    act(() => changeInAnotherTab("ember:appearance", "light"));
    expect(result.current).toBe("light");
    stop();
  });
});
