import lighthouse, { desktopConfig, type Result } from "lighthouse";
import type { Session } from "../room-client.ts";
import { launchChrome, signInPage } from "./browser.ts";

export type FormFactor = "mobile" | "desktop";

export interface LighthouseResult {
  page: string;
  formFactor: FormFactor;
  runs: number;
  /** The Lighthouse performance score, 0 to 100. */
  score: number;
  fcpMs: number;
  lcpMs: number;
  tbtMs: number;
  cls: number;
  speedIndexMs: number;
  transferKb: number;
}

type Metrics = Omit<LighthouseResult, "page" | "formFactor" | "runs">;

function metrics(lhr: Result): Metrics {
  const value = (audit: string) => lhr.audits[audit]?.numericValue ?? Number.NaN;
  return {
    score: Math.round((lhr.categories.performance?.score ?? 0) * 100),
    fcpMs: Math.round(value("first-contentful-paint")),
    lcpMs: Math.round(value("largest-contentful-paint")),
    tbtMs: Math.round(value("total-blocking-time")),
    cls: Math.round(value("cumulative-layout-shift") * 1000) / 1000,
    speedIndexMs: Math.round(value("speed-index")),
    transferKb: Math.round(value("total-byte-weight") / 1024),
  };
}

const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!;

/**
 * Cold loads of `url` in a fresh Chrome each run, with Lighthouse's default mobile (simulated slow 4G
 * and a 4x slower CPU) or desktop settings. With a session, the page loads signed in.
 */
export async function lighthouseRuns(url: string, page: string, formFactor: FormFactor, runs: number, session?: Session): Promise<LighthouseResult> {
  const samples: Metrics[] = [];
  for (let i = 0; i < runs; i++) {
    const browser = await launchChrome();
    try {
      const tab = await browser.newPage();
      if (session) await signInPage(tab, url, session);
      const result = await lighthouse(
        url,
        // Keep the session cookie that signInPage set; the HTTP cache is still cold.
        { logLevel: "error", onlyCategories: ["performance"], disableStorageReset: Boolean(session) },
        formFactor === "desktop" ? desktopConfig : undefined,
        tab,
      );
      if (!result) throw new Error(`Lighthouse returned nothing for ${url}`);
      if (result.lhr.runtimeError) throw new Error(`Lighthouse failed on ${url}: ${result.lhr.runtimeError.message}`);
      samples.push(metrics(result.lhr));
    } finally {
      await browser.close();
    }
  }

  const medians = Object.fromEntries(Object.keys(samples[0]!).map((key) => [key, median(samples.map((s) => s[key as keyof Metrics]))])) as Metrics;
  return { page, formFactor, runs, ...medians };
}
