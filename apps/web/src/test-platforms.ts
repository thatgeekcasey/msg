import type { Platform } from "@ember/protocol";

// Browsers as the Worker reads them from their user agents (apps/worker/test/fixtures/user-agents.json),
// for tests of what depends on the browser, such as the notification setup help.

const NO_BROWSER: Platform = {
  ios: false,
  android: false,
  desktop: true,
  windows: false,
  chrome: false,
  firefox: false,
  safari: false,
  edge: false,
  browser: "",
  operatingSystem: "",
};

export const CHROME_MAC: Platform = { ...NO_BROWSER, chrome: true, browser: "Chrome", operatingSystem: "macOS" };
export const SAFARI_MAC: Platform = { ...NO_BROWSER, safari: true, browser: "Safari", operatingSystem: "macOS" };
export const CHROME_LINUX: Platform = { ...NO_BROWSER, chrome: true, browser: "Chrome", operatingSystem: "Linux" };
export const SAFARI_IPHONE: Platform = { ...NO_BROWSER, desktop: false, ios: true, safari: true, browser: "Safari", operatingSystem: "iPhone" };
export const OPERA_ANDROID: Platform = { ...NO_BROWSER, desktop: false, android: true, browser: "Opera", operatingSystem: "Android 10" };
