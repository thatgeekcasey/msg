import { setTimeout as sleep } from "node:timers/promises";
import type { CDPSession, Page } from "puppeteer-core";
import { atRate, messageText } from "../load.ts";
import type { RoomClient, Session } from "../room-client.ts";
import { summarize, type Summary } from "../stats.ts";
import { signInPage } from "./browser.ts";

// What it feels like to sit in a busy room: how long an incoming message takes to reach the screen,
// and what each one costs the main thread, with a short and a long timeline loaded.

export interface RenderOptions {
  burst: { messages: number; rate: number };
  timelineSizes: number[];
}

export interface BurstResult {
  /** Messages in the timeline when the burst began. */
  timeline: number;
  messages: number;
  rate: number;
  /** A message.created frame reaching the page to its row being in the DOM. */
  frameToDom: Summary | null;
  /** The same, to the next frame being painted. */
  frameToPaint: Summary | null;
  /** Main-thread time per incoming message, from Chrome's own task accounting. */
  mainThreadMsPerMessage: number;
  /** Where that time went. The rest is mostly paint, compositing and garbage collection. */
  mainThreadBreakdown: { scriptMs: number; styleMs: number; layoutMs: number };
  longTasks: number;
  totalBlockingTimeMs: number;
  /** Main-thread time per second with nothing arriving, measured just before the burst. */
  idleMainThreadMsPerSecond: number;
  heapMb: number;
  /** Burst messages that never showed up. */
  missing: number;
}

export interface RenderResult {
  cpuSlowdown: number;
  /** Navigation start to the room's newest messages being in the DOM. */
  roomReadyMs: number;
  /** Scrolling to the top to the next page of history being in the DOM. */
  loadOlder: Summary | null;
  bursts: BurstResult[];
}

interface PagePerf {
  firstMessageAt?: number;
  /** Timings per burst message number. */
  burst: Record<number, { frameAt?: number; domAt?: number; paintAt?: number }>;
  longTasks: Array<{ start: number; duration: number }>;
}

declare global {
  interface Window {
    __emberPerf: PagePerf;
  }
}

const TIMELINE = '[role="log"]';
const IDLE_MS = 5_000;

const burstBody = (n: number) => `<p>burst#${n} ${messageText(n)}</p>`;
let nextBurst = 0;

/**
 * Runs in the page before the app does. Timestamps each burst message when its frame lands (this
 * listener is added before the app's own, so it runs first), when its row enters the DOM, and when
 * the frame after that is painted. Self-contained: it's serialized into the page.
 */
function instrument() {
  const mark = /burst#(\d+)/;
  const perf: PagePerf = { burst: {}, longTasks: [] };
  window.__emberPerf = perf;
  const timings = (n: number) => (perf.burst[n] ??= {});

  new PerformanceObserver((list) => {
    for (const task of list.getEntries()) perf.longTasks.push({ start: task.startTime, duration: task.duration });
  }).observe({ type: "longtask" });

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", (event) => {
        const data = String(event.data);
        const n = data.startsWith('{"type":"message.created"') ? data.match(mark)?.[1] : undefined;
        if (n !== undefined) timings(Number(n)).frameAt = performance.now();
      });
    }
  };

  new MutationObserver((mutations) => {
    const now = performance.now();
    const added: Array<{ paintAt?: number }> = [];
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const article of node.matches("article") ? [node] : node.querySelectorAll("article")) {
          perf.firstMessageAt ??= now;
          const n = article.textContent?.match(mark)?.[1];
          if (n === undefined) continue;
          const entry = timings(Number(n));
          entry.domAt ??= now;
          added.push(entry);
        }
      }
    }
    // A task queued from requestAnimationFrame runs once that frame has been painted.
    if (added.length) requestAnimationFrame(() => setTimeout(() => added.forEach((entry) => (entry.paintAt ??= performance.now()))));
  }).observe(document, { childList: true, subtree: true });
}

const METRICS = ["TaskDuration", "ScriptDuration", "RecalcStyleDuration", "LayoutDuration", "JSHeapUsedSize"] as const;
type Metrics = Record<(typeof METRICS)[number], number>;

/** Chrome's running totals: seconds of main-thread work by kind, and heap bytes. */
async function cdpMetrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(METRICS.map((name) => [name, metrics.find((m) => m.name === name)?.value ?? 0])) as Metrics;
}

/** Milliseconds per message of one kind of work between two readings, to two decimals. */
const perMessage = (before: Metrics, after: Metrics, name: keyof Metrics, messages: number) =>
  Math.round(((after[name] - before[name]) * 1000 * 100) / messages) / 100;

const messageCount = (page: Page) => page.$$eval(`${TIMELINE} article`, (rows) => rows.length);

/** Scrolls to the top until the timeline holds `target` messages, timing each page of history. */
async function growTimeline(page: Page, target: number): Promise<number[]> {
  const { times, reached } = await page.$eval(
    TIMELINE,
    async (log, target) => {
      const count = () => log.querySelectorAll("article").length;
      const times: number[] = [];
      while (count() < target) {
        const before = count();
        const started = performance.now();
        log.scrollTop = 0;
        const grew = await new Promise<boolean>((resolve) => {
          const finish = (grew: boolean) => {
            observer.disconnect();
            resolve(grew);
          };
          const observer = new MutationObserver(() => count() > before && finish(true));
          observer.observe(log, { childList: true, subtree: true });
          setTimeout(() => finish(false), 10_000);
        });
        if (!grew) break;
        times.push(performance.now() - started);
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
      }
      log.scrollTop = log.scrollHeight;
      return { times, reached: count() };
    },
    target,
  );
  // A burst on a shorter timeline than asked for would pass for a faster one.
  if (reached < target) throw new Error(`Paging in history stopped at ${reached} messages, short of the ${target} the next burst needs`);
  return times;
}

/** Measures idle cost, then has `bot` post a burst at the room's current size and times each message onto the screen. */
async function burst(page: Page, cdp: CDPSession, bot: RoomClient, { messages, rate }: RenderOptions["burst"]): Promise<BurstResult> {
  await page.$eval(TIMELINE, (log) => (log.scrollTop = log.scrollHeight));
  const timeline = await messageCount(page);

  const idleBefore = await cdpMetrics(cdp);
  await sleep(IDLE_MS);
  const idleMainThreadMsPerSecond = ((await cdpMetrics(cdp)).TaskDuration - idleBefore.TaskDuration) * 1000 / (IDLE_MS / 1000);

  const first = nextBurst;
  nextBurst += messages;
  const startedAt = await page.evaluate(() => performance.now());
  const before = await cdpMetrics(cdp);
  await atRate(messages, rate, (i) => bot.send({ type: "message.create", clientMessageId: `burst-${first + i}`, body: burstBody(first + i) }));
  await page
    .waitForFunction(
      (from: number, to: number) => {
        for (let n = from; n < to; n++) if (window.__emberPerf.burst[n]?.paintAt === undefined) return false;
        return true;
      },
      { timeout: 30_000, polling: 50 },
      first,
      first + messages,
    )
    .catch(() => {}); // Whatever never arrived is counted as missing below.
  const after = await cdpMetrics(cdp);

  const { rows, longTasks } = await page.evaluate(
    (from: number, to: number, since: number) => ({
      rows: Array.from({ length: to - from }, (_, i) => window.__emberPerf.burst[from + i] ?? {}),
      longTasks: window.__emberPerf.longTasks.filter((t) => t.start >= since),
    }),
    first,
    first + messages,
    startedAt,
  );
  const shown = rows.filter((r) => r.frameAt !== undefined && r.domAt !== undefined && r.paintAt !== undefined);

  return {
    timeline,
    messages,
    rate,
    frameToDom: summarize(shown.map((r) => r.domAt! - r.frameAt!)),
    frameToPaint: summarize(shown.map((r) => r.paintAt! - r.frameAt!)),
    mainThreadMsPerMessage: perMessage(before, after, "TaskDuration", messages),
    mainThreadBreakdown: {
      scriptMs: perMessage(before, after, "ScriptDuration", messages),
      styleMs: perMessage(before, after, "RecalcStyleDuration", messages),
      layoutMs: perMessage(before, after, "LayoutDuration", messages),
    },
    longTasks: longTasks.length,
    totalBlockingTimeMs: Math.round(longTasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0)),
    idleMainThreadMsPerSecond: Math.round(idleMainThreadMsPerSecond * 10) / 10,
    heapMb: Math.round((after.JSHeapUsedSize / 2 ** 20) * 10) / 10,
    missing: messages - shown.length,
  };
}

/** Opens the room at `roomUrl` signed in as `reader`, then measures bursts from `bot` at each timeline size. */
export async function measureRendering(page: Page, roomUrl: string, reader: Session, bot: RoomClient, options: RenderOptions, cpuSlowdown: number): Promise<RenderResult> {
  const cdp = await page.createCDPSession();
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuSlowdown });
  await page.evaluateOnNewDocument(instrument);
  await signInPage(page, roomUrl, reader);

  await page.goto(roomUrl);
  await page.waitForFunction(() => window.__emberPerf.firstMessageAt !== undefined, { timeout: 30_000 });
  const roomReadyMs = Math.round(await page.evaluate(() => window.__emberPerf.firstMessageAt!));
  // Paging starts from the room's first page drawn whole: the room draws its newest messages first.
  await page.waitForSelector(`${TIMELINE}:not([aria-busy])`, { timeout: 30_000 });

  const loadOlder: number[] = [];
  const bursts: BurstResult[] = [];
  for (const size of options.timelineSizes) {
    loadOlder.push(...(await growTimeline(page, size)));
    bursts.push(await burst(page, cdp, bot, options.burst));
  }
  return { cpuSlowdown, roomReadyMs, loadOlder: summarize(loadOlder), bursts };
}
