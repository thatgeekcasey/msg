import { useEffect, useRef, useState } from "react";
import type { Favorites, Me, RoomId } from "@ember/protocol";
import { useMounted } from "@/hooks/use-mounted";
import { useRoomDrag, type OrderStatus } from "@/hooks/use-room-drag";
import { isSignedOut, setFavoriteOrder } from "@/lib/api";

/**
 * How long a starred room's row is held before it's dragged, so that a finger can still scroll the list.
 */
const HOLD_MS = 400;

interface Options {
  favorites: Favorites;
  /** The rooms the list shows. Activity hides the rest, whose stars keep their places. */
  shown: ReadonlySet<RoomId>;
  /** The name a room's move is announced by. */
  nameOf: (roomId: RoomId) => string;
  /** Called with this person's stars as the server answers them, once an order is saved. */
  onSaved: (favorites: Favorites) => void;
  /** Called with null when the session has expired. */
  onSessionChanged: (me: Me | null) => void;
}

/**
 * Reorders someone's starred rooms in the sidebar's list, by holding a starred row and dragging it or
 * pressing Alt and an arrow on one (`useRoomDrag`), saving each move. It answers the order to show their
 * stars in: while a row is dragged, the order it's been dragged to, and while an order saves, that
 * order, until the answer comes or news that the stars changed otherwise. A failed save puts the stars
 * back as the server last said they were, which is the order before the move unless they changed
 * meanwhile.
 *
 * The list's element takes `listRef` and `listProps`, its rows carry `data-room-id`, and the element the
 * list scrolls in takes `scrollerRef`.
 */
export function useStarOrder({ favorites, shown, nameOf, onSaved, onSessionChanged }: Options) {
  const [saving, setSaving] = useState<{ order: RoomId[]; version: number } | null>(null);
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const mounted = useMounted();
  // Whether an order is saving, as it is now rather than as last drawn.
  const saved = useRef(false);

  const order = saving?.version === favorites.version ? saving.order : favorites.rooms;

  async function save(next: RoomId[]) {
    saved.current = true;
    setSaving({ order: next, version: favorites.version });
    setStatus({ message: "Saving room order…", error: false });
    try {
      onSaved(await setFavoriteOrder(next));
      if (mounted.current) setStatus({ message: "Starred room order saved.", error: false });
    } catch (error) {
      // Once another person's workspace has taken this one's place, the session it hears about is gone.
      if (!mounted.current) return;
      if (isSignedOut(error)) return onSessionChanged(null);
      setStatus({ message: "Couldn’t save room order. Please try again.", error: true });
    } finally {
      saved.current = false;
      if (mounted.current) setSaving(null);
    }
  }

  const drag = useRoomDrag({
    order,
    // The rows that can move: starred ones the list shows.
    movable: order.filter((id) => shown.has(id)),
    holdMs: HOLD_MS,
    isLocked: () => saved.current,
    onDrag: (roomId) => setStatus({ message: `Moving ${nameOf(roomId)}. Release to save, or press Escape to cancel.`, error: false }),
    // A starred room that went while a row was dragged, deleted or no longer theirs, left the stars
    // without news that they changed, so the order saved leaves it out too.
    onMove: (moved) => void save(moved.filter((id) => favorites.rooms.includes(id))),
    onCancel: () => setStatus({ message: "Room move canceled.", error: false }),
  });

  // News that the stars changed ends a hold or a drag.
  const { release } = drag;
  useEffect(() => release(), [favorites.version, release]);

  return { order: drag.order, moving: drag.moving, status, listRef: drag.listRef, scrollerRef: drag.scrollerRef, listProps: drag.listProps };
}
