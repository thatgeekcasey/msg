import { atRate, closeAll, joinMany, measure, messageBody, Outbox, newRoom, settle, sum, waitFor, type Window } from "../load.ts";
import type { Server } from "../server.ts";
import { perSecond, summarize, type Summary } from "../stats.ts";

export interface FanoutOptions {
  /** Room sizes to try, each in a fresh room on a fresh server. */
  sizes: number[];
  messages: number;
  rate: number;
}

export interface FanoutResult {
  members: number;
  messages: number;
  rate: number;
  /** Sender to each member, over every copy delivered. */
  delivery: Summary | null;
  /** Sender to the last member to get each message: how long a broadcast takes to finish. */
  completion: Summary | null;
  deliveriesPerSecond: number;
  lost: number;
  outOfOrder: number;
  window: Window;
}

/** One person posting into a room of `members` listeners. Joins happen first, so presence traffic is over. */
export async function fanoutAt(server: Server, members: number, { messages, rate }: Omit<FanoutOptions, "sizes">): Promise<FanoutResult> {
  const room = await newRoom(server, `fanout ${members}`);
  const { clients: listeners } = await joinMany(server, room, members);
  const {
    clients: [sender],
  } = await joinMany(server, room, 1, { name: "sender" });
  await settle([...listeners, sender!]);

  const outbox = new Outbox();
  const delivery: number[] = [];
  const arrivals = new Map<string, { count: number; last: number }>();
  for (const listener of listeners) {
    listener.onMessage = (message, at) => {
      const ms = outbox.since(message.clientMessageId, at);
      if (ms === undefined) return;
      delivery.push(ms);
      const seen = arrivals.get(message.clientMessageId) ?? { count: 0, last: 0 };
      arrivals.set(message.clientMessageId, { count: seen.count + 1, last: ms });
    };
  }

  const expected = messages * members;
  const { window } = await measure(server, async () => {
    await atRate(messages, rate, (i) => outbox.post(sender!, `fanout-${members}-${i}`, messageBody(i)));
    await waitFor(() => delivery.length === expected, 30_000);
  });
  closeAll([...listeners, sender!]);

  const completion = [...arrivals.values()].filter((a) => a.count === members).map((a) => a.last);
  return {
    members,
    messages,
    rate,
    delivery: summarize(delivery),
    completion: summarize(completion),
    deliveriesPerSecond: perSecond(delivery.length, window.ms),
    lost: expected - delivery.length,
    outOfOrder: sum(listeners.map((l) => l.outOfOrder)),
    window,
  };
}
