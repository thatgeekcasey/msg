import { devices, type PlaywrightTestOptions, type PlaywrightWorkerOptions, type Project } from "@playwright/test";

/**
 * The web app manifest's screenshots of Ember on a phone, which `pnpm screenshots` makes: 360px wide at
 * three device pixels a CSS pixel, the most common Android width, and 800px tall, so each is 1080×2400,
 * the size of Campfire's.
 */
export const screenshotProjects: Project<PlaywrightTestOptions, PlaywrightWorkerOptions>[] = [
  {
    name: "screenshots",
    testDir: "./tests/screenshots",
    use: { ...devices["Galaxy S24"], viewport: { width: 360, height: 800 }, browserName: "chromium" },
  },
];
