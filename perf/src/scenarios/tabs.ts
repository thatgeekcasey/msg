import { setTimeout as sleep } from "node:timers/promises";
import { measure, type Window } from "../load.ts";
import { createRoom, signIn } from "../room-client.ts";
import type { Server } from "../server.ts";
import { perSecond, summarize, type Summary } from "../stats.ts";
import { TabClient, type TabTimings } from "../tab-client.ts";

export interface TabsOptions {
  /** Open tabs to grow through, in order. */
  sizes: number[];
  /** Rooms the tabs spread over, one open in each tab. */
  rooms: number;
  /** Tabs opening at once. */
  concurrency: number;
  /** Stop growing once a step's p95 time to the workspace's welcome passes this. */
  maxConnectP95Ms: number;
}

export interface TabsStep {
  tabs: number;
  /** Opening the workspace socket to its welcome. */
  welcome: Summary | null;
  /** Each load of the sidebar: one as the page loads, and one on the welcome. */
  sidebar: Summary | null;
  /** Each load of the people directory, alongside the sidebar's. */
  directory: Summary | null;
  tabsPerSecond: number;
  window: Window;
}

/** Every tab connecting again at once, as after a deploy. */
export interface TabsReconnect {
  tabs: number;
  welcome: Summary | null;
  roomWelcome: Summary | null;
  sidebar: Summary | null;
  directory: Summary | null;
  /** From the deploy, when every tab starts waiting to connect again, to the last having both welcomes, its sidebar and its people directory. */
  allBackMs: number;
  failures: number;
  window: Window;
}

export interface TabsResult extends TabsOptions {
  steps: TabsStep[];
  reconnect: TabsReconnect | null;
  /** Why growing ended early, if it did. */
  stopped: string | null;
}

/**
 * How long each socket waits to connect again after a deploy, as the app spreads them: a room's
 * (reconnecting-socket.ts, `DEPLOY_SPREAD_MS`), and the workspace's (use-sidebar.ts).
 */
const ROOM_DEPLOY_SPREAD_MS = [250, 2_000] as const;
const WORKSPACE_DEPLOY_SPREAD_MS = [2_000, 10_000] as const;
const spread = ([from, to]: readonly [number, number]) => from + Math.random() * (to - from);

/** A deploy drops sockets without the goodbyes closing them here sends, so those finish before timing. */
const GOODBYES_MS = 3_000;

/**
 * Opens `count` tabs, `concurrency` at a time, each signing in someone new. If one fails, no more
 * start, the ones that opened close, and the first error is thrown.
 */
async function openMany(server: Server, rooms: string[], first: number, count: number, concurrency: number) {
  const tabs: TabClient[] = [];
  const timings: TabTimings[] = [];
  let next = first;
  let failure: Error | null = null;
  const worker = async () => {
    while (next < first + count && !failure) {
      try {
        const i = next++;
        const tab = new TabClient(server.url, await signIn(server.url, `tab-${i}`), rooms[i % rooms.length]!);
        timings.push(await tab.open());
        tabs.push(tab);
      } catch (error) {
        failure ??= error as Error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  if (failure) {
    for (const tab of tabs) tab.close();
    throw failure;
  }
  return { tabs, timings };
}

/** Closes every tab's sockets, then has each connect again as the app does after a deploy. */
async function reconnectAll(server: Server, tabs: TabClient[]): Promise<TabsReconnect> {
  for (const tab of tabs) tab.close();
  await sleep(GOODBYES_MS);
  const timings: TabTimings[] = [];
  let failures = 0;
  const { result: allBackMs, window } = await measure(server, async () => {
    const started = performance.now();
    await Promise.all(
      tabs.map(async (tab) => {
        try {
          timings.push(await tab.reopen({ room: spread(ROOM_DEPLOY_SPREAD_MS), workspace: spread(WORKSPACE_DEPLOY_SPREAD_MS) }));
        } catch {
          failures++;
        }
      }),
    );
    return Math.round(performance.now() - started);
  });
  return {
    tabs: tabs.length,
    welcome: summarize(timings.map((t) => t.welcome)),
    roomWelcome: summarize(timings.map((t) => t.roomWelcome)),
    sidebar: summarize(timings.flatMap((t) => t.sidebar)),
    directory: summarize(timings.flatMap((t) => t.directory)),
    allBackMs,
    failures,
    window,
  };
}

/**
 * Opens tabs step by step, each with a room's socket, the workspace socket, the sidebar and the people
 * directory, to find how many the Workspace, one Durable Object, holds well. Then they all connect
 * again at once, the load a deploy puts on it.
 */
export async function tabs(server: Server, options: TabsOptions): Promise<TabsResult> {
  const host = await signIn(server.url, "tabs host");
  const rooms: string[] = [];
  for (let i = 0; i < options.rooms; i++) rooms.push(await createRoom(server.url, host, `tabs-${i}`));
  const open: TabClient[] = [];
  const steps: TabsStep[] = [];
  let stopped: string | null = null;

  for (const size of options.sizes) {
    try {
      const { result, window } = await measure(server, () => openMany(server, rooms, open.length, size - open.length, options.concurrency));
      open.push(...result.tabs);
      const welcome = summarize(result.timings.map((t) => t.welcome));
      steps.push({
        tabs: open.length,
        welcome,
        sidebar: summarize(result.timings.flatMap((t) => t.sidebar)),
        directory: summarize(result.timings.flatMap((t) => t.directory)),
        tabsPerSecond: perSecond(result.tabs.length, window.ms),
        window,
      });
      if (welcome && welcome.p95 > options.maxConnectP95Ms) {
        stopped = `p95 time to the workspace's welcome passed ${options.maxConnectP95Ms}ms at ${open.length} tabs`;
        break;
      }
    } catch (error) {
      stopped = `Opening tabs failed past ${open.length}: ${(error as Error).message}`;
      break;
    }
  }

  const reconnect = open.length > 0 ? await reconnectAll(server, open) : null;
  for (const tab of open) tab.close();
  return { ...options, steps, reconnect, stopped };
}
