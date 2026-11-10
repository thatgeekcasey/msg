import { atRate, closeAll, joinMany, measure, messageBody, Outbox, newRoom, settle, waitFor, type Window } from "../load.ts";
import type { Server } from "../server.ts";
import { summarize, type Summary } from "../stats.ts";

export interface LatencyOptions {
  messages: number;
  rate: number;
}

export interface LatencyResult extends LatencyOptions {
  /** Sender to its own copy of message.created: the write and the broadcast, end to end. */
  ack: Summary | null;
  /** Sender to another member of the room. */
  delivery: Summary | null;
  lost: number;
  window: Window;
}

/** Two people in a room, one posting at a steady, unhurried rate. The floor for every other number. */
export async function latency(server: Server, { messages, rate }: LatencyOptions): Promise<LatencyResult> {
  const room = await newRoom(server, "latency");
  const {
    clients: [sender, listener],
  } = await joinMany(server, room, 2);
  await settle([sender!, listener!]);

  const outbox = new Outbox();
  const ack: number[] = [];
  const delivery: number[] = [];
  const record = (samples: number[]) => (message: { clientMessageId: string }, at: number) => {
    const ms = outbox.since(message.clientMessageId, at);
    if (ms !== undefined) samples.push(ms);
  };
  sender!.onMessage = record(ack);
  listener!.onMessage = record(delivery);

  const { window } = await measure(server, async () => {
    await atRate(messages, rate, (i) => outbox.post(sender!, `latency-${i}`, messageBody(i)));
    await waitFor(() => ack.length + delivery.length === messages * 2, 10_000);
  });
  closeAll([sender!, listener!]);

  return { messages, rate, ack: summarize(ack), delivery: summarize(delivery), lost: messages * 2 - ack.length - delivery.length, window };
}
