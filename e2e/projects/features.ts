import { devices, type PlaywrightTestOptions, type PlaywrightWorkerOptions, type Project } from "@playwright/test";

// The feature-by-feature suite: one test file per area of the app, on a desktop Chromium. Tests that
// need a phone or a second person open their own browser contexts with `members.signIn`.

/** The test server's made-up recovery token, which, like its session secret, guards nothing real. */
export const RECOVERY_TOKEN = "e2e0".repeat(16);

export const featureProjects: Project<PlaywrightTestOptions, PlaywrightWorkerOptions>[] = [
  {
    name: "features",
    testDir: "./tests/features",
    use: { ...devices["Desktop Chrome"], browserName: "chromium" },
  },
];
