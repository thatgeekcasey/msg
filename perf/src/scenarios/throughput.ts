import { closeAll, joinMany, measure, messageBody, Outbox, newRoom, settle, waitFor, type Window } from "../load.ts";
import type { RoomClient } from "../room-client.ts";
import type { Server } from "../server.ts";
import { perSecond, summarize, type Summary } from "../stats.ts";

export interface ThroughputOptions {
  messages: number;
  senders: number;
  /** Messages each sender keeps in flight. */
  inFlight: number;
}

export interface ThroughputResult extends ThroughputOptions {
  messagesPerSecond: number;
  ack: Summary | null;
  /** Messages a listener saw out of id order. Ids follow arrival, so this means writes finished out of order. */
  outOfOrder: number;
  errors: number;
  timedOut: boolean;
  window: Window;
}

/** Several people posting as fast as the room acknowledges them: the most one room can write. */
export async function throughput(server: Server, { messages, senders, inFlight }: ThroughputOptions): Promise<ThroughputResult> {
  const room = await newRoom(server, "throughput");
  const { clients: writers } = await joinMany(server, room, senders, { name: "writer" });
  const {
    clients: [listener],
  } = await joinMany(server, room, 1, { name: "listener" });
  await settle([...writers, listener!]);

  const outbox = new Outbox();
  const ack: number[] = [];
  let sent = 0;
  let delivered = 0;
  const sendNext = (client: RoomClient) => {
    if (sent === messages) return;
    const i = sent++;
    outbox.post(client, `throughput-${i}`, messageBody(i));
  };
  for (const writer of writers) {
    writer.onMessage = (message, at) => {
      if (message.creator.id !== writer.session.user.id) return;
      ack.push(outbox.since(message.clientMessageId, at)!);
      sendNext(writer);
    };
  }
  listener!.onMessage = () => delivered++;

  const { result: finished, window } = await measure(server, async () => {
    for (const writer of writers) for (let i = 0; i < inFlight; i++) sendNext(writer);
    return waitFor(() => ack.length === messages && delivered === messages, 60_000);
  });
  const errors = [...writers, listener!].reduce((total, client) => total + client.errors.length, 0);
  closeAll([...writers, listener!]);

  return {
    messages,
    senders,
    inFlight,
    messagesPerSecond: perSecond(ack.length, window.ms),
    ack: summarize(ack),
    outOfOrder: listener!.outOfOrder,
    errors,
    timedOut: !finished,
    window,
  };
}
