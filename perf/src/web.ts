import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { closeAll, joinMany, newRoom, seedRoom } from "./load.ts";
import type { Profile } from "./profiles.ts";
import { setUp, signIn } from "./room-client.ts";
import { startServer } from "./server.ts";
import { launchChrome } from "./web/browser.ts";
import { bundleSizes, type BundleResult } from "./web/bundle.ts";
import { lighthouseRuns, type LighthouseResult } from "./web/lighthouse.ts";
import { measureRendering, type RenderResult } from "./web/render.ts";

export interface WebResults {
  chrome: string;
  bundle: BundleResult;
  lighthouse: LighthouseResult[];
  render: RenderResult[];
}

const webDist = path.resolve(import.meta.dirname, "../../apps/web/dist");

async function buildWeb(): Promise<void> {
  const child = spawn("pnpm", ["--filter", "@ember/web", "build"], { stdio: ["ignore", "ignore", "inherit"] });
  const [code] = (await once(child, "exit")) as [number | null];
  if (code !== 0) throw new Error("Building apps/web failed");
}

/** Builds the app, serves it from `wrangler dev`, and measures loading (Lighthouse) and live rendering. */
export async function runWeb(profile: Profile, log: (line: string) => void): Promise<WebResults> {
  log("web · building apps/web");
  await buildWeb();
  const bundle = await bundleSizes(webDist);

  const server = await startServer("do-sqlite", webDist);
  try {
    await setUp(server.url);
    log(`web · seeding #general with ${profile.web.backlog} messages`);
    // The room the browser opens. Everyone signed in after it's made is in it.
    const room = await newRoom(server, "general");
    const { clients: authors } = await joinMany(server, room, 3, { name: "author" });
    await seedRoom(authors, profile.web.backlog, 10);
    closeAll(authors);
    const reader = await signIn(server.url, "Perf Reader");
    const roomUrl = new URL(`/rooms/${room}`, server.url).href;

    const lighthouse: LighthouseResult[] = [];
    for (const formFactor of ["mobile", "desktop"] as const) {
      log(`web · lighthouse · sign-in page · ${formFactor}`);
      lighthouse.push(await lighthouseRuns(server.url, "sign-in", formFactor, profile.web.lighthouseRuns));
      log(`web · lighthouse · room · ${formFactor}`);
      lighthouse.push(await lighthouseRuns(roomUrl, "room", formFactor, profile.web.lighthouseRuns, reader));
    }

    const {
      clients: [bot],
    } = await joinMany(server, room, 1, { name: "bot" });
    const browser = await launchChrome();
    const chrome = (await browser.version()).replace(/^\D+\//, "");
    const render: RenderResult[] = [];
    try {
      for (const cpuSlowdown of profile.web.cpuSlowdowns) {
        log(`web · rendering · ${cpuSlowdown}x CPU slowdown`);
        const page = await browser.newPage();
        render.push(await measureRendering(page, roomUrl, reader, bot!, profile.web, cpuSlowdown));
        await page.close();
      }
    } finally {
      await browser.close();
      bot!.close();
    }
    return { chrome, bundle, lighthouse, render };
  } finally {
    await server.stop();
  }
}
