import { setTimeout as sleep } from "node:timers/promises";
import type { WorkspaceServerFrame } from "@ember/protocol";
import { atRate, joinMany, measure, messageBody, newRoom, Outbox, waitFor, type Window } from "../load.ts";
import { signIn } from "../room-client.ts";
import type { Server } from "../server.ts";
import { summarize, type Summary } from "../stats.ts";
import { connectWorkspace } from "../tab-client.ts";

export interface UnreadOptions {
  /** Room sizes to try, each in a fresh room on a fresh server: the members away from it. */
  sizes: number[];
  /** Messages posted once the room is marked for everyone away, and how fast. */
  messages: number;
  rate: number;
  /** Workspace sockets opening at once. */
  concurrency: number;
}

export interface UnreadResult {
  members: number;
  messages: number;
  rate: number;
  /** From the first message to each member away hearing the room is unread. */
  marked: Summary | null;
  /** Members away who never heard. */
  missed: number;
  /** The messages after it, which mark nobody new: from sending each to its coming back to the poster. */
  ack: Summary | null;
  /** Those that never came back. */
  lost: number;
  /** While those messages are posted, and the Workspace applies each. */
  window: Window;
}

const MARKED_TIMEOUT_MS = 30_000;
/** Longer than a room pauses after each call to the Workspace (chat-room.ts, `GATHER_MS`). */
const READ_SENT_MS = 1_000;

/**
 * Signs in `count` people, `concurrency` at a time, and opens each one's workspace socket alone, as a
 * tab showing another page does. If one fails, no more start, the ones that opened close, and the
 * first error is thrown.
 */
async function openWorkspaces(server: Server, count: number, concurrency: number): Promise<WebSocket[]> {
  const sockets: WebSocket[] = [];
  let next = 0;
  let failure: Error | null = null;
  const worker = async () => {
    while (next < count && !failure) {
      try {
        const { ws } = await connectWorkspace(server.url, await signIn(server.url, `away-${next++}`));
        sockets.push(ws);
      } catch (error) {
        failure ??= error as Error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  if (failure) {
    for (const ws of sockets) ws.close(1000);
    throw failure;
  }
  return sockets;
}

/**
 * One person posting in a room everyone else is away from, with only the workspace's socket open.
 * The first message marks the room unread for each of them, which the Workspace writes and tells
 * them of; the rest find them marked already, so they cost the room's log and the calls that take
 * them to the Workspace, a few at a time, which look over the room's members and change nothing.
 */
export async function unreadAt(server: Server, members: number, { messages, rate, concurrency }: Omit<UnreadOptions, "sizes">): Promise<UnreadResult> {
  const room = await newRoom(server, `unread ${members}`);
  const away = await openWorkspaces(server, members, concurrency);
  const {
    clients: [poster],
  } = await joinMany(server, room, 1, { name: "poster" });
  // Opening the room in a shown tab reads it, and the room pauses after sending that, so the first
  // message waits until it has, as anyone reads a moment before they write.
  await sleep(READ_SENT_MS);

  const markedAt: number[] = [];
  for (const ws of away) {
    ws.onmessage = (event) => {
      const frame = JSON.parse(event.data as string) as WorkspaceServerFrame;
      if (frame.type === "room.unread" && frame.roomId === room) markedAt.push(performance.now());
    };
  }
  const outbox = new Outbox();
  const acks: number[] = [];
  poster!.onMessage = (message, at) => {
    const ms = outbox.since(message.clientMessageId, at);
    if (ms !== undefined && message.clientMessageId !== "unread-first") acks.push(ms);
  };

  const sentAt = performance.now();
  outbox.post(poster!, "unread-first", messageBody(0));
  await waitFor(() => markedAt.length === members, MARKED_TIMEOUT_MS);
  const marked = summarize(markedAt.map((at) => at - sentAt));
  const missed = members - markedAt.length;

  const { window } = await measure(server, async () => {
    await atRate(messages, rate, (i) => outbox.post(poster!, `unread-${i}`, messageBody(i + 1)));
    await waitFor(() => acks.length === messages, 30_000);
  });
  poster!.close();
  for (const ws of away) ws.close(1000);

  return { members, messages, rate, marked, missed, ack: summarize(acks), lost: messages - acks.length, window };
}
