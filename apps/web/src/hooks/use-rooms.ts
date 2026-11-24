import { createContext, useMemo } from "react";
import type { Room, RoomId, SharedRoom } from "@ember/protocol";

/** A room as a mention of it shows it and the # prompt lists it. */
export type RoomCard = Pick<SharedRoom, "id" | "kind" | "name" | "icon">;

/** The rooms someone's in, but DMs, by id: open rooms, which everyone is in, and the private rooms they're in. */
export type Rooms = ReadonlyMap<RoomId, RoomCard>;

/**
 * The rooms whoever's signed in is in, as their sidebar last listed them: those a mention of a room shows
 * them by name, and the # prompt offers. Null until the sidebar loads.
 */
export const RoomsContext = createContext<Rooms | null>(null);

const cardsOf = (room: Room): RoomCard[] => (room.kind === "direct" ? [] : [{ id: room.id, kind: room.kind, name: room.name, icon: room.icon }]);

/**
 * The rooms of the sidebar's list but DMs, as `RoomsContext` holds them: the same map until a room comes or
 * goes, or changes its name, kind or icon, rather than a new one with every unread mark, so that what shows
 * rooms by it draws again only then.
 */
export function useRoomCards(list: readonly Room[] | null): Rooms | null {
  const cards = list?.flatMap(cardsOf) ?? null;
  const key = cards && JSON.stringify(cards);
  // Made again only as its key changes, which says all the map holds.
  return useMemo(() => cards && new Map(cards.map((card) => [card.id, card])), [key]);
}
