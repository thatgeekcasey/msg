import type { Profile } from "./profiles.ts";
import { connections, type ConnectionsResult } from "./scenarios/connections.ts";
import { fanoutAt, type FanoutResult } from "./scenarios/fanout.ts";
import { history, type HistoryResult } from "./scenarios/history.ts";
import { latency, type LatencyResult } from "./scenarios/latency.ts";
import { searchAt, type SearchResult } from "./scenarios/search.ts";
import { tabs, type TabsResult } from "./scenarios/tabs.ts";
import { throughput, type ThroughputResult } from "./scenarios/throughput.ts";
import { unreadAt, type UnreadResult } from "./scenarios/unread.ts";
import { existingServer, startServer, type Server, type Storage } from "./server.ts";

export const SCENARIOS = ["latency", "throughput", "fanout", "connections", "tabs", "unread", "history", "search"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface BackendResults {
  latency?: LatencyResult;
  throughput?: ThroughputResult;
  fanout?: FanoutResult[];
  connections?: ConnectionsResult;
  tabs?: TabsResult;
  unread?: UnreadResult[];
  history?: HistoryResult;
  search?: SearchResult;
}

interface Target {
  storage: Storage;
  /** A server to reuse instead of starting `wrangler dev` per run. */
  url?: string;
}

/**
 * Each scenario, and each fan-out size, gets its own `wrangler dev` with empty storage, so leftovers
 * from one (hundreds of sockets saying goodbye, say) can't slow the next.
 */
async function withServer<T>({ storage, url }: Target, fn: (server: Server) => Promise<T>): Promise<T> {
  const server = url ? await existingServer(url, storage) : await startServer(storage);
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}

export async function runBackend(target: Target, profile: Profile, scenarios: readonly Scenario[], log: (line: string) => void): Promise<BackendResults> {
  const results: BackendResults = {};
  for (const scenario of scenarios) {
    log(`${target.storage} · ${scenario}`);
    switch (scenario) {
      case "latency":
        results.latency = await withServer(target, (server) => latency(server, profile.latency));
        break;
      case "throughput":
        results.throughput = await withServer(target, (server) => throughput(server, profile.throughput));
        break;
      case "fanout":
        results.fanout = [];
        for (const members of profile.fanout.sizes) {
          log(`${target.storage} · fanout · ${members} members`);
          results.fanout.push(await withServer(target, (server) => fanoutAt(server, members, profile.fanout)));
        }
        break;
      case "connections":
        results.connections = await withServer(target, (server) => connections(server, profile.connections));
        break;
      case "tabs":
        results.tabs = await withServer(target, (server) => tabs(server, profile.tabs));
        break;
      case "unread":
        results.unread = [];
        for (const members of profile.unread.sizes) {
          log(`${target.storage} · unread · ${members} members away`);
          results.unread.push(await withServer(target, (server) => unreadAt(server, members, profile.unread)));
        }
        break;
      case "history":
        results.history = await withServer(target, (server) => history(server, profile.history));
        break;
      case "search":
        results.search = await withServer(target, (server) => searchAt(server, profile.search));
        break;
    }
  }
  return results;
}
