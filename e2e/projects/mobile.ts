import { devices, type PlaywrightTestOptions, type PlaywrightWorkerOptions, type Project } from "@playwright/test";
import type { MobileOptions, SafeArea } from "../tests/mobile/fixtures";

type MobileProject = Project<PlaywrightTestOptions & MobileOptions, PlaywrightWorkerOptions>;

// Phones from the narrowest still in use to the largest, plus two landscape cases, all emulated in
// Chromium (viewport, pixel ratio, touch, and coarse-pointer / no-hover media queries).

// Insets the page sees with viewport-fit=cover: the Dynamic Island and home indicator on recent
// iPhones, and Chrome on Android drawing edge to edge above the gesture bar.
const NONE: SafeArea = { top: 0, right: 0, bottom: 0, left: 0 };
const IPHONE_PORTRAIT: SafeArea = { top: 62, right: 0, bottom: 34, left: 0 };
const IPHONE_LANDSCAPE: SafeArea = { top: 0, right: 62, bottom: 21, left: 62 };
const ANDROID_EDGE_TO_EDGE: SafeArea = { top: 0, right: 0, bottom: 24, left: 0 };

function phone(name: string, device: (typeof devices)[string], safeArea: SafeArea, viewport = device.viewport): MobileProject {
  return {
    name: `mobile ${name}`,
    testDir: "./tests/mobile",
    use: { ...device, viewport, browserName: "chromium", safeArea },
  };
}

export const mobileProjects: MobileProject[] = [
  // 320px is the narrowest phone width and WCAG 1.4.10's reflow width.
  phone("iPhone SE", devices["iPhone SE"]!, NONE),
  // 360px is the most common Android width.
  phone("Galaxy S24", devices["Galaxy S24"]!, NONE),
  phone("iPhone 17", devices["iPhone 17"]!, IPHONE_PORTRAIT),
  phone("Pixel 8", devices["Pixel 8"]!, ANDROID_EDGE_TO_EDGE),
  phone("iPhone 17 Pro Max", devices["iPhone 17 Pro Max"]!, IPHONE_PORTRAIT),
  // With viewport-fit=cover a landscape page spans the whole screen, notch side included, so these
  // use the screen width rather than Playwright's letterboxed one. 874px still gets the drawer layout;
  // 956px is past the 900px breakpoint, so it is the desktop layout on a touch screen.
  phone("iPhone 17 landscape", devices["iPhone 17 landscape"]!, IPHONE_LANDSCAPE, { width: 874, height: 352 }),
  phone("iPhone 17 Pro Max landscape", devices["iPhone 17 Pro Max landscape"]!, IPHONE_LANDSCAPE, { width: 956, height: 390 }),
];
