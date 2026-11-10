import { closeAll, joinMany, measure, newRoom, settle, sum, type Window } from "../load.ts";
import type { RoomClient } from "../room-client.ts";
import type { Server } from "../server.ts";
import { perSecond, summarize, type Summary } from "../stats.ts";

export interface ConnectionsOptions {
  /** Room sizes to grow through, in order. */
  sizes: number[];
  /** Joins in flight at once. */
  concurrency: number;
  /** Stop growing once a step's p95 time-to-welcome passes this. */
  maxConnectP95Ms: number;
}

export interface ConnectionsStep {
  members: number;
  joins: number;
  /** Opening a socket to receiving the room's welcome frame. */
  connect: Summary | null;
  joinsPerSecond: number;
  /** Presence frames the room sent per join, summed over everyone already in it. */
  presenceKbPerJoin: number;
  window: Window;
}

export interface ConnectionsResult extends ConnectionsOptions {
  steps: ConnectionsStep[];
  /** Why the ramp ended early, if it did. */
  stopped: string | null;
}

/** Grows one room step by step and times each join, to find how many sockets one Durable Object holds well. */
export async function connections(server: Server, options: ConnectionsOptions): Promise<ConnectionsResult> {
  const room = await newRoom(server, "connections");
  const members: RoomClient[] = [];
  const steps: ConnectionsStep[] = [];
  let stopped: string | null = null;

  for (const size of options.sizes) {
    const presenceBefore = sum(members.map((m) => m.presenceBytes));
    try {
      const { result: joined, window } = await measure(server, async () => {
        const joined = await joinMany(server, room, size - members.length, { concurrency: options.concurrency, name: `member-${members.length}` });
        members.push(...joined.clients);
        await settle(members);
        return joined;
      });
      const joins = joined.clients.length;
      const connect = summarize(joined.connectMs);
      steps.push({
        members: members.length,
        joins,
        connect,
        joinsPerSecond: perSecond(joins, window.ms),
        presenceKbPerJoin: Math.round((sum(members.map((m) => m.presenceBytes)) - presenceBefore) / joins / 1024),
        window,
      });
      if (connect && connect.p95 > options.maxConnectP95Ms) {
        stopped = `p95 time-to-welcome passed ${options.maxConnectP95Ms}ms at ${members.length} members`;
        break;
      }
    } catch (error) {
      stopped = `Joining failed past ${members.length} members: ${(error as Error).message}`;
      break;
    }
  }
  closeAll(members);
  return { ...options, steps, stopped };
}
