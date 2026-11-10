import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type TouchEvent } from "react";
import type { RoomId } from "@ember/protocol";
import { movedBefore } from "@/lib/room-list";

// A row is pressed with a mouse, a pen or a finger, and held a while first where the list asks for that,
// unless it moves 8px meanwhile, then dragged, the list scrolling 8px a frame while the pointer is
// within 64px of its top or bottom, and placed where it's let go. A click within 500ms of letting go is
// ignored, so a drop never opens a room.
const STILL_PX = 8;
const EDGE_PX = 64;
const SCROLL_PX = 8;
const CLICK_GUARD_MS = 500;

/** What a list of rooms last said about moving one: to screen readers, or on screen. */
export interface OrderStatus {
  message: string;
  error: boolean;
}

/** A row held down, until it's let go, and whether it's being dragged yet. */
interface Press {
  roomId: RoomId;
  x: number;
  y: number;
  lastY: number;
  kind: "pointer" | "touch";
  dragging: boolean;
}

interface Point {
  clientX: number;
  clientY: number;
}

interface Options {
  /** The rooms, in the order the list shows them. */
  order: RoomId[];
  /** The rooms whose rows can move among themselves, in that order. With only one, none can. */
  movable: RoomId[];
  /** How long a row is held before it's dragged, or 0 to drag it at once. */
  holdMs: number;
  /** Whether a press on `target` picks up the row it's in. Anywhere in the row does, unless this says otherwise. */
  grabs?: (target: Element) => boolean;
  /** Whether the rows stay where they are for now, as while an order saves. */
  isLocked: () => boolean;
  /** Called as a row starts being dragged. */
  onDrag: (roomId: RoomId) => void;
  /** Called with the order a row has been moved to, as a dragged one is let go, or as Alt and an arrow move one. */
  onMove: (order: RoomId[], roomId: RoomId) => void;
  /** Called as a dragged row is put back. */
  onCancel: () => void;
}

/** The room whose row `target` is in, if it's in one. */
const roomOf = (target: EventTarget | null) => (target instanceof Element ? (target.closest<HTMLElement>("[data-room-id]")?.dataset.roomId ?? null) : null);

const sameOrder = (a: RoomId[], b: RoomId[] | null) => b !== null && a.length === b.length && a.every((id, i) => id === b[i]);

const anywhere = () => true;

/**
 * Moves the rows of a list of rooms among themselves, by dragging one or pressing Alt and an arrow on
 * one: the sidebar's stars, and the rooms an administrator puts in order for everyone. It answers the
 * order to show the rooms in: while a row is dragged, the order it's been dragged to, and otherwise
 * `order`, which `onMove` changes.
 *
 * The list's element takes `listRef` and `listProps`, its rows carry `data-room-id`, and the element the
 * list scrolls in takes `scrollerRef`, unless that's the list itself.
 */
export function useRoomDrag({ order, movable, holdMs, grabs = anywhere, isLocked, onDrag, onMove, onCancel }: Options) {
  const listRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<RoomId[] | null>(null);
  const [moving, setMoving] = useState<RoomId | null>(null);

  // Pointers can move faster than the list draws, so what's pressed and the order it's been dragged to
  // are kept here too, as they are now rather than as last drawn.
  const press = useRef<Press | null>(null);
  const drafted = useRef<RoomId[] | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  const frame = useRef(0);
  const clicksIgnoredUntil = useRef(0);
  const focusAfterMove = useRef<RoomId | null>(null);

  const redraft = (next: RoomId[] | null) => {
    drafted.current = next;
    setDraft(next);
  };
  const rowOf = (roomId: RoomId) => listRef.current?.querySelector<HTMLElement>(`[data-room-id="${CSS.escape(roomId)}"]`) ?? null;

  function cleanUp() {
    clearTimeout(hold.current);
    cancelAnimationFrame(frame.current);
    press.current = null;
    setMoving(null);
  }

  /** Lets go of the row held, if one is, putting a dragged one back. */
  function cancel() {
    if (!press.current) return;
    const dragged = press.current.dragging;
    cleanUp();
    if (!dragged) return;
    clicksIgnoredUntil.current = Date.now() + CLICK_GUARD_MS;
    redraft(null);
    onCancel();
  }

  function start(roomId: RoomId, point: Point, kind: Press["kind"]) {
    if (isLocked() || !movable.includes(roomId) || movable.length < 2) return;
    cancel();
    press.current = { roomId, x: point.clientX, y: point.clientY, lastY: point.clientY, kind, dragging: false };
    if (holdMs > 0) hold.current = setTimeout(() => latest.current.begin(), holdMs);
    else begin();
  }

  function begin() {
    const pressed = press.current;
    if (!pressed || !movable.includes(pressed.roomId)) return cancel();
    pressed.dragging = true;
    setMoving(pressed.roomId);
    redraft(order);
    onDrag(pressed.roomId);
    scroll();
  }

  function move(point: Point) {
    const pressed = press.current;
    if (!pressed) return;
    if (!pressed.dragging) {
      if (Math.hypot(point.clientX - pressed.x, point.clientY - pressed.y) > STILL_PX) cancel();
      return;
    }
    pressed.lastY = point.clientY;
    // The row goes before the first other one that can move whose middle is below the pointer, or after
    // the last of them.
    const before = movable.find((id) => {
      const box = id === pressed.roomId ? undefined : rowOf(id)?.getBoundingClientRect();
      return box !== undefined && point.clientY < box.top + box.height / 2;
    });
    const next = movedBefore(drafted.current ?? order, pressed.roomId, before ?? null);
    if (!sameOrder(next, drafted.current)) redraft(next);
  }

  function scroll() {
    const pressed = press.current;
    if (!pressed?.dragging) return;
    const scroller = scrollerRef.current ?? listRef.current;
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const step = pressed.lastY < box.top + EDGE_PX ? -SCROLL_PX : pressed.lastY > box.bottom - EDGE_PX ? SCROLL_PX : 0;
      const before = scroller.scrollTop;
      scroller.scrollTop += step;
      // A pointer held still has the rows scroll past under it.
      if (scroller.scrollTop !== before) move({ clientX: pressed.x, clientY: pressed.lastY });
    }
    frame.current = requestAnimationFrame(() => latest.current.scroll());
  }

  /** Lets go of the row held, placing a dragged one where it's been dragged to. */
  function finish() {
    const pressed = press.current;
    const dragged = drafted.current;
    if (!pressed) return;
    cleanUp();
    if (!pressed.dragging || !dragged) return;
    clicksIgnoredUntil.current = Date.now() + CLICK_GUARD_MS;
    redraft(null);
    rowOf(pressed.roomId)?.focus({ preventScroll: true });
    onMove(dragged, pressed.roomId);
  }

  /**
   * Alt and an arrow move the row focused past the one that can move above or below it, unless a row is
   * held down, whose drag places it where it's let go.
   */
  function onKeyDown(event: KeyboardEvent) {
    const roomId = roomOf(event.target);
    const up = event.key === "ArrowUp";
    if (!roomId || !movable.includes(roomId) || !event.altKey || (!up && event.key !== "ArrowDown")) return;
    event.preventDefault();
    if (isLocked() || press.current) return;
    const neighbor = movable[movable.indexOf(roomId) + (up ? -1 : 1)];
    if (!neighbor) return;
    focusAfterMove.current = roomId;
    onMove(up ? movedBefore(order, roomId, neighbor) : movedBefore(order, neighbor, roomId), roomId);
  }

  // The hold's timer, the window's listeners and each frame of scrolling act on the newest of these.
  const latest = useRef({ begin, move, scroll, finish, cancel });
  useLayoutEffect(() => {
    latest.current = { begin, move, scroll, finish, cancel };
  });

  // A row moved with the keyboard keeps the focus wherever it's drawn.
  useLayoutEffect(() => {
    if (focusAfterMove.current === null) return;
    rowOf(focusAfterMove.current)?.focus({ preventScroll: true });
    focusAfterMove.current = null;
  });

  useEffect(() => {
    const pressedWith = (kind: Press["kind"]) => press.current?.kind === kind;
    const onPointerMove = (event: globalThis.PointerEvent) => {
      if (!pressedWith("pointer")) return;
      if (press.current?.dragging) event.preventDefault();
      latest.current.move(event);
    };
    const onPointerUp = () => pressedWith("pointer") && latest.current.finish();
    // Until a finger has held a row long enough, it scrolls the list as usual.
    const onTouchMove = (event: globalThis.TouchEvent) => {
      if (!pressedWith("touch") || !event.touches[0]) return;
      if (press.current?.dragging && event.cancelable) event.preventDefault();
      latest.current.move(event.touches[0]);
    };
    const onTouchEnd = () => pressedWith("touch") && latest.current.finish();
    const onCancel = () => latest.current.cancel();
    // Escape puts a dragged row back wherever the focus is, even outside the list, which a click doesn't
    // move the focus to in Safari. Heard before anything else, it closes nothing else, such as the
    // drawer the list is in.
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !press.current?.dragging) return;
      event.preventDefault();
      latest.current.cancel();
    };
    window.addEventListener("keydown", onEscape, { capture: true });
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onCancel);
    return () => {
      window.removeEventListener("keydown", onEscape, { capture: true });
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onCancel);
      clearTimeout(hold.current);
      cancelAnimationFrame(frame.current);
    };
  }, []);

  /** The room whose row a press on `target` picks up, if it picks one up. */
  const pickedUp = (target: EventTarget) => (target instanceof Element && grabs(target) ? roomOf(target) : null);

  const listProps = {
    onPointerDown: (event: PointerEvent) => {
      const roomId = pickedUp(event.target);
      if (roomId && event.pointerType !== "touch" && event.button === 0) start(roomId, event, "pointer");
    },
    onTouchStart: (event: TouchEvent) => {
      if (event.touches.length !== 1) return cancel();
      const roomId = pickedUp(event.target);
      if (roomId) start(roomId, event.touches[0]!, "touch");
    },
    onKeyDown,
    onClickCapture: (event: MouseEvent) => {
      if (Date.now() >= clicksIgnoredUntil.current || !roomOf(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    },
    // A link dragged would otherwise go to the browser as a link.
    onDragStart: (event: MouseEvent) => event.preventDefault(),
    // A long press would otherwise open the link's menu over the drag.
    onContextMenu: (event: MouseEvent) => press.current?.dragging && event.preventDefault(),
  };

  /** Lets go of the row held, if one is, putting a dragged one back, as news that the rooms changed elsewhere does. */
  const release = useCallback(() => latest.current.cancel(), []);

  return { order: draft ?? order, moving, listRef, scrollerRef, listProps, release };
}
