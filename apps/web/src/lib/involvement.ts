import type { Involvement, Room, SidebarRoom } from "@ember/protocol";
import { byName } from "./people";
import type { DirectSidebarRoom, SharedSidebarRoom } from "./room-list";

/** What each level's button says it does, Campfire's `HUMANIZE_INVOLVEMENT`. */
export const INVOLVEMENT_LABELS: Record<Involvement, string> = {
  mentions: "Notifying about @ mentions",
  everything: "Notifying about all messages",
  nothing: "Notifications are off",
  invisible: "Notifications are off and room invisible in sidebar",
};

const ROOM_LEVELS: Involvement[] = ["mentions", "everything", "nothing", "invisible"];
const DIRECT_LEVELS: Involvement[] = ["everything", "nothing"];

/**
 * The level after `involvement` in `room`, as its button goes round them, Campfire's
 * `next_involvement_for`: @mentions, all messages, off, then off and hidden in a room, and all messages
 * and off in a DM, starting again from the first after the last or any other.
 */
export function nextInvolvement(room: Room, involvement: Involvement): Involvement {
  const levels = room.kind === "direct" ? DIRECT_LEVELS : ROOM_LEVELS;
  return levels[(levels.indexOf(involvement) + 1) % levels.length]!;
}

/** Whether someone has hidden `room` from their sidebar, which still lists it for them to open. */
export const isHidden = (room: SidebarRoom) => room.involvement === "invisible";

/**
 * `rooms` as your profile lists your levels in them: the rooms by name, compared as SQLite compares
 * `LOWER(name)`, as people are listed, and by id where names match, which SQLite leaves in no particular
 * order, then the DMs, which have no name, in the order they were made. The ones you've hidden are
 * listed too, for you to show again.
 */
export function profileOrder(rooms: SidebarRoom[]): { shared: SharedSidebarRoom[]; directs: DirectSidebarRoom[] } {
  const shared: SharedSidebarRoom[] = [];
  const directs: DirectSidebarRoom[] = [];
  for (const room of rooms) {
    if (room.kind === "direct") directs.push(room);
    else shared.push(room);
  }
  return { shared: byName(shared), directs };
}
