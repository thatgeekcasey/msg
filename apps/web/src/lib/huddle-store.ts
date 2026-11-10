import type { RoomId, User } from "@ember/protocol";
import type { HuddlePerson } from "@ember/protocol/huddles";

/**
 * The huddle this tab is in, as its room's header and the huddle's bar show it. A tab is in one huddle at
 * most, and only while it's open: loading the page again leaves it.
 */
export interface JoinedHuddle {
  roomId: RoomId;
  /** Whether the room has let the tab in: not as it joins, nor while its connection to the room is down. */
  connected: boolean;
  /** This tab's person, once the room has said who they are. */
  you: User | null;
  /** Everyone in the huddle, in the order they joined, as the room last said. */
  people: HuddlePerson[];
  muted: boolean;
  /** Whether the tab has a microphone to unmute. Without one its person only listens. */
  microphone: boolean;
}

/** What the tab's huddle takes from outside it, which its header button, its bar and the shortcuts ask of it. */
export interface HuddleControls {
  leave(): void;
  setMuted(muted: boolean): void;
}

let joined: JoinedHuddle | null = null;
let controls: HuddleControls | null = null;
const listeners = new Set<() => void>();
let ended: ((why: string) => void) | null = null;

/** Hears whenever the tab's huddle changes, until the function returned is called, as `useSyncExternalStore` takes it. */
export function watchHuddle(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The huddle the tab is in, or null. */
export const joinedHuddle = () => joined;

/** Shows the tab's huddle as `huddle`, which `its` controls work, or that it's in none. The huddle's own code calls this. */
export function showHuddle(huddle: JoinedHuddle | null, its: HuddleControls | null = controls): void {
  joined = huddle;
  controls = huddle && its;
  for (const listener of listeners) listener();
}

/** Leaves the huddle the tab is in, if it's in one. */
export const leaveHuddle = () => controls?.leave();

/** Mutes the tab's microphone in its huddle, or unmutes it, if it's in one. */
export const muteHuddle = (muted: boolean) => controls?.setMuted(muted);

/** Has `say` told why whenever the room ends the tab's huddle for it, until the function returned is called. */
export function hearHuddleEnd(say: (why: string) => void): () => void {
  ended = say;
  return () => {
    if (ended === say) ended = null;
  };
}

/** Shows that the room ended the tab's huddle, and says `why`. */
export function endHuddle(why: string): void {
  showHuddle(null);
  ended?.(why);
}
