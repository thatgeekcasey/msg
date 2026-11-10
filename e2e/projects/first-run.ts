import { devices, type PlaywrightTestOptions, type PlaywrightWorkerOptions, type Project } from "@playwright/test";

/** Sets up the test server's workspace, as its first visitor would. Every other suite needs it. */
export const FIRST_RUN = "first-run";

/** The test server's EMBER_SETUP_TOKEN: its setup link carries it, as a deployed Worker's does. */
export const SETUP_TOKEN = "e2e1".repeat(16);

export const firstRunProjects: Project<PlaywrightTestOptions, PlaywrightWorkerOptions>[] = [
  {
    name: FIRST_RUN,
    testDir: "./tests/first-run",
    use: { ...devices["Desktop Chrome"], browserName: "chromium" },
  },
];
