import type { RoomId, ScheduledMessage, UserId } from "@ember/protocol";
import type { Db } from "./db";

// The messages people have scheduled in a room (migration 0087), which the room's alarm sends as their
// writers' once they're due, if they're in the room still.

/** The most due messages the alarm sends at once. It comes back at once for any more. */
export const SCHEDULED_SENT_AT_ONCE = 10;

/** A scheduled message as the room keeps it: with whose it is. */
export interface KeptScheduled extends ScheduledMessage {
  creatorId: UserId;
}

interface Row {
  id: string;
  creator_id: string;
  client_message_id: string;
  body: string;
  parent_id: string | null;
  also_send: number;
  send_at: string;
  failure: string | null;
}

const COLUMNS = `id, creator_id, client_message_id, body, parent_id, also_send, send_at, failure`;

const keptOf = (row: Row): KeptScheduled => ({
  id: row.id,
  creatorId: row.creator_id,
  clientMessageId: row.client_message_id,
  body: row.body,
  sendAt: row.send_at,
  ...(row.parent_id !== null && { parentId: row.parent_id, alsoSend: row.also_send === 1 }),
  ...(row.failure !== null && { failure: row.failure }),
});

/** `kept` as its writer hears of it. */
export function listed({ creatorId: _, ...message }: KeptScheduled): ScheduledMessage {
  return message;
}

export class ScheduledMessages {
  constructor(
    private readonly db: Db,
    readonly roomId: RoomId,
  ) {}

  /** `creatorId`'s scheduled messages here, soonest first. */
  async of(creatorId: UserId): Promise<KeptScheduled[]> {
    const rows = await this.db.all<Row>(`SELECT ${COLUMNS} FROM scheduled_messages WHERE room_id = ? AND creator_id = ? ORDER BY send_at, id`, this.roomId, creatorId);
    return rows.map(keptOf);
  }

  /** The scheduled message `id`, or null when there's none by that id. */
  async find(id: string): Promise<KeptScheduled | null> {
    const [row] = await this.db.all<Row>(`SELECT ${COLUMNS} FROM scheduled_messages WHERE room_id = ? AND id = ?`, this.roomId, id);
    return row ? keptOf(row) : null;
  }

  /** Keeps `message`, scheduled at `now`. */
  async keep(message: KeptScheduled, now: string): Promise<void> {
    await this.db.run(
      `INSERT INTO scheduled_messages (room_id, id, creator_id, client_message_id, body, parent_id, also_send, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      this.roomId,
      message.id,
      message.creatorId,
      message.clientMessageId,
      message.body,
      message.parentId ?? null,
      message.alsoSend ? 1 : 0,
      message.sendAt,
      now,
    );
  }

  /** Gives the scheduled message `id` the body `body`, as the room keeps one, keeping its time. */
  async edit(id: string, body: string): Promise<void> {
    await this.db.run(`UPDATE scheduled_messages SET body = ? WHERE room_id = ? AND id = ?`, body, this.roomId, id);
  }

  /** Moves the scheduled message `id` to `sendAt`, to be sent then, whatever stopped it before. */
  async move(id: string, sendAt: string): Promise<void> {
    await this.db.run(`UPDATE scheduled_messages SET send_at = ?, failure = NULL WHERE room_id = ? AND id = ?`, sendAt, this.roomId, id);
  }

  /** Keeps the scheduled message `id` from being sent, saying why it couldn't be. */
  async fail(id: string, failure: string): Promise<void> {
    await this.db.run(`UPDATE scheduled_messages SET failure = ? WHERE room_id = ? AND id = ?`, failure, this.roomId, id);
  }

  /** Forgets the scheduled message `id`, sent or deleted. */
  async remove(id: string): Promise<void> {
    await this.db.run(`DELETE FROM scheduled_messages WHERE room_id = ? AND id = ?`, this.roomId, id);
  }

  /** The scheduled messages due by `now`, the soonest `SCHEDULED_SENT_AT_ONCE`, but those that couldn't be sent. */
  async due(now: string): Promise<KeptScheduled[]> {
    const rows = await this.db.all<Row>(
      `SELECT ${COLUMNS} FROM scheduled_messages WHERE room_id = ? AND failure IS NULL AND send_at <= ? ORDER BY send_at LIMIT ${SCHEDULED_SENT_AT_ONCE}`,
      this.roomId,
      now,
    );
    return rows.map(keptOf);
  }

  /** When the next scheduled message here is due, which is past while some are due still, or null when none is to be sent. */
  async nextDue(): Promise<number | null> {
    const [row] = await this.db.all<{ next: string | null }>(`SELECT min(send_at) AS next FROM scheduled_messages WHERE room_id = ? AND failure IS NULL`, this.roomId);
    return row === undefined || row.next === null ? null : Date.parse(row.next);
  }

  /** Forgets every message `creatorId` has scheduled here, as their account is deleted. */
  async forgetBy(creatorId: UserId): Promise<void> {
    await this.db.run(`DELETE FROM scheduled_messages WHERE room_id = ? AND creator_id = ?`, this.roomId, creatorId);
  }

  /** Forgets every message scheduled here, as the room is deleted. */
  async forget(): Promise<void> {
    await this.db.run(`DELETE FROM scheduled_messages WHERE room_id = ?`, this.roomId);
  }
}
