import type { EphemeralMessage, RoomId, User, UserId } from "@ember/protocol";
import type { PausedAnswer } from "../assistant/gateway";
import type { RoomRead } from "../assistant/room-tools";
import { statement, type Db } from "../db";
import type { GivenTool } from "./tools";

// The calls of connected apps' tools that wait to be allowed in a room (migrations 0057 and 0084): each
// with its model's answer as far as it got, which goes on once whoever asked answers the card the room
// showed them alone, as a message only they see.

/** How long a call waits to be allowed. After that its card says nobody did, and the room forgets it (`takeLate`). */
export const CALL_WAITS_MS = 15 * 60_000;

/** The most calls `takeLate` takes at once, each as much as `MAX_CALL_BYTES`. */
const LATE_CALLS_TAKEN = 5;

/** A call that waited too long, and the card it waited on, by its id. */
export interface LateCall {
  messageId: string;
  call: WaitingCall;
}

/** The most bytes of JSON a waiting call is kept in: well under what a row holds on either backend. */
const MAX_CALL_BYTES = 1_000_000;

/**
 * A call that waits: the message asked and the bot that answers it, who asked, by their name then, the
 * tool, as the card shows it, and what it's called with, every app's tool the model was given, by the
 * names it calls them, its answer as it waits, what it has read of the room, and when the card was
 * posted.
 */
export interface WaitingCall {
  questionId: string;
  botId: UserId;
  asker: User;
  tool: GivenTool;
  input: Record<string, unknown>;
  tools: GivenTool[];
  paused: PausedAnswer;
  /**
   * What the answer's calls of the room's tools have read (`RoomRead`): how much more they may, and who
   * wrote what they did, which it goes on with. A call that began to wait before they shared it has none.
   */
  read?: RoomRead;
  askedAt: number;
  /**
   * The card only whoever asked sees, as the room showed it to them, which it shows each tab of theirs that
   * opens the room while the call waits. A call that started to wait before there were such cards has none,
   * and waits on a card that's a message in the room, as they all did then.
   */
  card?: EphemeralMessage;
}

/** Whether `call` is small enough to keep. */
export const fits = (call: WaitingCall) => new TextEncoder().encode(JSON.stringify(call)).byteLength <= MAX_CALL_BYTES;

export class WaitingCalls {
  constructor(
    private readonly db: Db,
    readonly roomId: RoomId,
  ) {}

  /** Keeps `call`, which waits on the card `messageId`. */
  async keep(messageId: string, call: WaitingCall): Promise<void> {
    await this.db.run(
      `INSERT INTO waiting_calls (room_id, message_id, call, asked_at, asker_id) VALUES (?, ?, ?, ?, ?)`,
      this.roomId,
      messageId,
      JSON.stringify(call),
      call.askedAt,
      call.asker.id,
    );
  }

  /** The cards of the calls that wait on `askerId` here, oldest first, as only they see them. */
  async cardsFor(askerId: UserId): Promise<EphemeralMessage[]> {
    const rows = await this.db.all<{ call: string }>(`SELECT call FROM waiting_calls WHERE room_id = ? AND asker_id = ? ORDER BY asked_at`, this.roomId, askerId);
    return rows.flatMap(({ call }) => (JSON.parse(call) as WaitingCall).card ?? []);
  }

  /**
   * Takes the calls that have waited too long to be allowed by `now`, the oldest few, and answers them
   * with when the oldest still waiting will have, which is past while more are left to take, or null
   * when none waits.
   */
  async takeLate(now: number): Promise<{ late: LateCall[]; next: number | null }> {
    const rows = await this.db.all<{ message_id: string; call: string }>(
      `SELECT message_id, call FROM waiting_calls WHERE room_id = ? AND asked_at < ? ORDER BY asked_at LIMIT ${LATE_CALLS_TAKEN}`,
      this.roomId,
      now - CALL_WAITS_MS,
    );
    const taken = rows.map(({ message_id }) => statement(`DELETE FROM waiting_calls WHERE room_id = ? AND message_id = ?`, this.roomId, message_id));
    const results = await this.db.batch([...taken, statement(`SELECT min(asked_at) AS oldest FROM waiting_calls WHERE room_id = ?`, this.roomId)]);
    const [{ oldest }] = results.at(-1) as [{ oldest: number | null }];
    return { late: rows.map(({ message_id, call }) => ({ messageId: message_id, call: JSON.parse(call) as WaitingCall })), next: oldest === null ? null : oldest + CALL_WAITS_MS + 1 };
  }

  /** When the oldest call that waits here will have waited too long, or null when none waits. */
  async nextLate(): Promise<number | null> {
    const [row] = await this.db.all<{ oldest: number | null }>(`SELECT min(asked_at) AS oldest FROM waiting_calls WHERE room_id = ?`, this.roomId);
    return row === undefined || row.oldest === null ? null : row.oldest + CALL_WAITS_MS + 1;
  }

  /** The call that waits on the card `messageId`, or null when none does. */
  async find(messageId: string): Promise<WaitingCall | null> {
    const [row] = await this.db.all<{ call: string }>(`SELECT call FROM waiting_calls WHERE room_id = ? AND message_id = ?`, this.roomId, messageId);
    return row ? (JSON.parse(row.call) as WaitingCall) : null;
  }

  /** Takes the call that waits on the card `messageId`, so that it's answered once, or answers null when none does. */
  async take(messageId: string): Promise<WaitingCall | null> {
    const [[row]] = (await this.db.batch([
      statement(`SELECT call FROM waiting_calls WHERE room_id = ? AND message_id = ?`, this.roomId, messageId),
      statement(`DELETE FROM waiting_calls WHERE room_id = ? AND message_id = ?`, this.roomId, messageId),
    ])) as [Array<{ call: string }>, unknown[]];
    return row ? (JSON.parse(row.call) as WaitingCall) : null;
  }

  /** Forgets every call that waits here, as the room is deleted. */
  async forget(): Promise<void> {
    await this.db.run(`DELETE FROM waiting_calls WHERE room_id = ?`, this.roomId);
  }
}
