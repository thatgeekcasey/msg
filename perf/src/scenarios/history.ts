import { HISTORY_PAGE_SIZE, type Message } from "@ember/protocol";
import { closeAll, joinMany, newRoom, seedRoom } from "../load.ts";
import { RoomClient } from "../room-client.ts";
import type { Server } from "../server.ts";
import { summarize, type Summary } from "../stats.ts";

export interface HistoryOptions {
  messages: number;
  /** Every nth message gets two reactions, so pages read boosts too. */
  boostEvery: number;
  /** Fresh connections to time. Each one reads the newest page for its welcome. */
  welcomes: number;
  /** Times to page from the newest message back to the first. */
  passes: number;
}

export interface HistoryResult extends HistoryOptions {
  /** Opening a socket to its welcome frame, which carries the newest page. */
  welcome: Summary | null;
  /** A history.before request to its page of 40. */
  page: Summary | null;
}

/** A room with a long backlog: how fast it hands out pages, which is where the two storage backends differ most. */
export async function history(server: Server, options: HistoryOptions): Promise<HistoryResult> {
  const room = await newRoom(server, "history");
  const {
    clients: [writer],
  } = await joinMany(server, room, 1, { name: "writer" });
  await seedRoom([writer!], options.messages, options.boostEvery);

  const welcomeMs: number[] = [];
  let newestPage: Message[] = [];
  for (let i = 0; i < options.welcomes; i++) {
    const { client, opening, ms } = await RoomClient.connect(server.url, room, writer!.session);
    welcomeMs.push(ms);
    newestPage = opening.messages;
    client.close();
  }

  const pageMs: number[] = [];
  for (let pass = 0; pass < options.passes; pass++) {
    let read = newestPage.length;
    for (let before = newestPage[0]!.id, hasMore = true; hasMore; ) {
      const page = await writer!.history(before, HISTORY_PAGE_SIZE);
      pageMs.push(page.ms);
      read += page.messages.length;
      hasMore = page.hasMore;
      before = page.messages[0]?.id ?? before;
    }
    // History that ends early would pass for a faster read path.
    if (read !== options.messages) throw new Error(`Paging back through history read ${read} of the room's ${options.messages} messages`);
  }
  closeAll([writer!]);

  return { ...options, welcome: summarize(welcomeMs), page: summarize(pageMs) };
}
