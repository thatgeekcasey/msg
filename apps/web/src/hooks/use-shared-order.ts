import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Me, RoomId, SavedRoomLayout, SectionId, SharedRoom, SidebarSection } from "@ember/protocol";
import { useMounted } from "@/hooks/use-mounted";
import { useRoomDrag, type OrderStatus } from "@/hooks/use-room-drag";
import { isSignedOut, setSharedOrder } from "@/lib/api";
import { inSidebarOrder, movedBefore } from "@/lib/room-list";

// The order's rows are a room's, by its id, or a section's heading, by `headingOf` its id, which no
// room's id can be, as a room's has no colon. The rooms in no section come first, then each section's
// heading, and under it its rooms, so a room's section is the heading above it, if any.

const HEADING = "section:";

/** The row of section `sectionId`'s heading. */
export const headingOf = (sectionId: SectionId) => `${HEADING}${sectionId}`;

/** The section whose heading `row` is, or null for a room's row. */
export const sectionOfHeading = (row: string): SectionId | null => (row.startsWith(HEADING) ? row.slice(HEADING.length) : null);

interface Options {
  /** The rooms in this administrator's sidebar, but their DMs, in the order they were put in them. */
  rooms: SharedRoom[];
  /** The ones of them the shared order ranks, in its order. */
  sharedOrder: RoomId[];
  /** Every section, in order, with which of `rooms` are in it. */
  sections: SidebarSection[];
  /** Called with the layout as the server answers it, once one is saved. */
  onSaved: (layout: SavedRoomLayout) => void;
  /** Called with null when the session has expired. */
  onSessionChanged: (me: Me | null) => void;
}

/** A layout staged: the rooms in order, the section each room moved is put in, or null for none, and the sections in order. */
interface Staged {
  roomIds: RoomId[];
  moved: ReadonlyMap<RoomId, SectionId | null>;
  sectionIds: SectionId[];
}

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** `staged` without the ids that aren't in `now` any more, and then the ones in it that weren't yet. */
function stillStaged(staged: string[], now: string[]): string[] {
  const there = new Set(now);
  const kept = staged.filter((id) => there.has(id));
  const listed = new Set(kept);
  return [...kept, ...now.filter((id) => !listed.has(id))];
}

/**
 * The rows of `roomIds` and `sectionIds`, in their orders: the rooms in no section, then each section's
 * heading and its rooms, each room in the section `sectionOf` says, or in none when that isn't one of them.
 */
function rowsOf(roomIds: RoomId[], sectionIds: SectionId[], sectionOf: (roomId: RoomId) => SectionId | null): string[] {
  const inSection = new Map(sectionIds.map((id) => [id, [] as RoomId[]]));
  const loose: RoomId[] = [];
  for (const roomId of roomIds) {
    const sectionId = sectionOf(roomId);
    (inSection.get(sectionId ?? "") ?? loose).push(roomId);
  }
  return [...loose, ...sectionIds.flatMap((id) => [headingOf(id), ...inSection.get(id)!])];
}

/**
 * `rows` once section `heading`'s heading is where `draft` has put it, after as many of the other
 * headings as it's after there: its rooms go with it, and every other row stays with its own heading.
 * The drag that made `draft` began with the rows as they were then, so a section made since stays where
 * it is, and one deleted since, the dragged one too, is gone.
 */
export function withSectionMoved(rows: string[], draft: string[], heading: string): string[] {
  const roomsUnder = new Map<string, string[]>();
  const loose: string[] = [];
  let under: string[] = loose;
  for (const row of rows) {
    if (sectionOfHeading(row) === null) under.push(row);
    else roomsUnder.set(row, (under = []));
  }
  if (!roomsUnder.has(heading)) return rows;
  const others = rows.filter((row) => row !== heading && roomsUnder.has(row));
  const place = draft.slice(0, draft.indexOf(heading)).filter((row) => roomsUnder.has(row)).length;
  const headings = [...others.slice(0, place), heading, ...others.slice(place)];
  return [...loose, ...headings.flatMap((row) => [row, ...roomsUnder.get(row)!])];
}

/**
 * `rows` with room `roomId` where `draft` has put it: in the section whose heading is above it there, or
 * in none, after the last row above it there that's in that section now, or else first in it. The drag
 * that made `draft` began with the rows as they were then, so every other row stays as it is now, in
 * whatever section others have put it in since, and a room dropped in a section deleted since is in none.
 */
export function withRoomMoved(rows: string[], draft: string[], roomId: RoomId): string[] {
  const others = rows.filter((row) => row !== roomId);
  const headingOver = new Map<string, string | null>();
  let under: string | null = null;
  for (const row of others) {
    if (sectionOfHeading(row) === null) headingOver.set(row, under);
    else under = row;
  }
  const above = draft.slice(0, draft.indexOf(roomId));
  const heading = above.findLast((row) => sectionOfHeading(row) !== null);
  const into = heading !== undefined && others.includes(heading) ? heading : null;
  const after = above.findLast((row) => row === into || headingOver.get(row) === into);
  const place = after === undefined ? 0 : others.indexOf(after) + 1;
  return [...others.slice(0, place), roomId, ...others.slice(place)];
}

/** `rows` without the rooms under heading `heading`, which a heading dragged folds away as it goes. */
function folded(rows: string[], heading: string): string[] {
  const start = rows.indexOf(heading) + 1;
  if (start === 0) return rows;
  let end = start;
  while (end < rows.length && sectionOfHeading(rows[end]!) === null) end++;
  return [...rows.slice(0, start), ...rows.slice(end)];
}

/** The middle of the rows of the section whose heading is drawn as `heading`: the heading and the rooms under it. */
function sectionMiddle(heading: HTMLElement): number {
  let last = heading;
  for (let row = heading.nextElementSibling; row instanceof HTMLElement && row.dataset.roomId !== undefined; row = row.nextElementSibling) {
    if (sectionOfHeading(row.dataset.roomId) !== null) break;
    last = row;
  }
  return (heading.getBoundingClientRect().top + last.getBoundingClientRect().bottom) / 2;
}

/** How many rooms `rows` has under each section's heading. */
function roomsUnder(rows: string[]): Map<SectionId, number> {
  const counts = new Map<SectionId, number>();
  let under: SectionId | null = null;
  for (const row of rows) {
    const sectionId = sectionOfHeading(row);
    if (sectionId !== null) counts.set((under = sectionId), 0);
    else if (under !== null) counts.set(under, counts.get(under)! + 1);
  }
  return counts;
}

/**
 * The order rooms come in for everyone, and the sections they come in, staged on workspace settings
 * (`staged`): a room's row is dragged at once by its handle, or moved with Alt and an arrow
 * (`useRoomDrag`), past others and past the sections' headings, which puts it in the section it's moved
 * under; a heading moves the same ways, among the others, taking its rooms with it, which a drag folds
 * under it as it goes, so it passes another section at that one's middle. Each move is only
 * staged until Save order saves the whole layout, or Cancel puts it back as saved. The rooms the shared
 * order doesn't rank come after the ones it does, in each section and out of them, in the order the
 * administrator was put in them, as they do in the sidebar. A room or a section that comes or goes
 * meanwhile joins or leaves what's staged, a room in its own section, at its end, and a room put in
 * another section elsewhere stays in that one, unless it's been moved here.
 */
export function useSharedOrder({ rooms, sharedOrder, sections, onSaved, onSessionChanged }: Options) {
  const [staged, setStaged] = useState<Staged | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const mounted = useMounted();
  // The save under way, as it is now rather than as last drawn, which saving again waits for.
  const saved = useRef<Promise<boolean> | null>(null);
  // A heading moved with the keyboard, which keeps the focus wherever it's drawn.
  const focusAfterMove = useRef<string | null>(null);

  const savedRooms = useMemo(() => inSidebarOrder(rooms, [], sharedOrder).map((room) => room.id), [rooms, sharedOrder]);
  const savedSections = useMemo(() => sections.map((section) => section.id), [sections]);
  const savedSectionOf = useMemo(() => new Map(sections.flatMap((section) => section.roomIds.map((roomId) => [roomId, section.id] as const))), [sections]);
  const savedRows = useMemo(() => rowsOf(savedRooms, savedSections, (roomId) => savedSectionOf.get(roomId) ?? null), [savedRooms, savedSections, savedSectionOf]);
  const rows = useMemo(() => {
    if (!staged) return savedRows;
    const sectionIds = stillStaged(staged.sectionIds, savedSections);
    const there = new Set(sectionIds);
    const sectionOf = (roomId: RoomId) => {
      const moved = staged.moved.get(roomId);
      // Moved to a section deleted since, it's in the one it's saved in.
      return moved !== undefined && (moved === null || there.has(moved)) ? moved : (savedSectionOf.get(roomId) ?? null);
    };
    return rowsOf(stillStaged(staged.roomIds, savedRooms), sectionIds, sectionOf);
  }, [staged, savedRows, savedRooms, savedSections, savedSectionOf]);
  const changed = !sameOrder(rows, savedRows);
  const nameOf = (row: string) => {
    const sectionId = sectionOfHeading(row);
    if (sectionId !== null) return sections.find((section) => section.id === sectionId)?.name ?? "";
    return rooms.find((room) => room.id === row)?.name ?? "";
  };

  /** Stages the layout `moved` shows: each room in the section whose heading is above it, if any. */
  function stage(moved: string[]) {
    const roomIds: RoomId[] = [];
    const sectionIds: SectionId[] = [];
    const movedRooms = new Map<RoomId, SectionId | null>();
    let under: SectionId | null = null;
    for (const row of moved) {
      const sectionId = sectionOfHeading(row);
      if (sectionId !== null) {
        sectionIds.push((under = sectionId));
        continue;
      }
      roomIds.push(row);
      if (under !== (savedSectionOf.get(row) ?? null)) movedRooms.set(row, under);
    }
    setStaged({ roomIds, moved: movedRooms, sectionIds });
    setStatus({ message: "Unsaved room order. Save to apply it to everyone.", error: false });
  }

  // A heading dragged is placed among the other headings only, so its own rooms, drawn under it as it
  // goes, aren't where it's dropped.
  const [draggingHeading, setDraggingHeading] = useState(false);
  const headings = useMemo(() => rows.filter((row) => sectionOfHeading(row) !== null), [rows]);
  const drag = useRoomDrag({
    order: rows,
    movable: draggingHeading ? headings : rows,
    holdMs: 0,
    grabs: (target) => target.closest("[data-room-order-handle]") !== null,
    middleOf: draggingHeading ? sectionMiddle : undefined,
    isLocked: () => saved.current !== null,
    onDrag: (row) => {
      setDraggingHeading(sectionOfHeading(row) !== null);
      setStatus({ message: `Moving ${nameOf(row)}. Release to place, or press Escape to cancel.`, error: false });
    },
    onMove: (moved, row) => {
      setDraggingHeading(false);
      const room = sectionOfHeading(row) === null;
      // Others change rooms and sections while a row's dragged, so the drop moves only that row, among the
      // rows as they are now. One deleted meanwhile has nowhere to go.
      if (!rows.includes(row)) return setStatus({ message: room ? "Room move canceled." : "Section move canceled. It was deleted.", error: false });
      stage(room ? withRoomMoved(rows, moved, row) : withSectionMoved(rows, moved, row));
    },
    onCancel: () => {
      setDraggingHeading(false);
      setStatus({ message: "Room move canceled.", error: false });
    },
  });
  // A heading dragged takes its rooms with it, folded away until it's let go.
  const shown = drag.moving !== null && sectionOfHeading(drag.moving) !== null ? folded(withSectionMoved(rows, drag.order, drag.moving), drag.moving) : drag.order;
  const counts = useMemo(() => roomsUnder(rows), [rows]);

  useLayoutEffect(() => {
    if (focusAfterMove.current === null) return;
    drag.listRef.current?.querySelector<HTMLElement>(`[data-room-id="${CSS.escape(focusAfterMove.current)}"]`)?.focus({ preventScroll: true });
    focusAfterMove.current = null;
  });

  /**
   * Alt and an arrow move a heading past the section above or below it, with its rooms, where the
   * rooms' rows go past one row at a time (`useRoomDrag`).
   */
  function onKeyDown(event: KeyboardEvent) {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-room-id]")?.dataset.roomId : undefined;
    const up = event.key === "ArrowUp";
    if (row === undefined || sectionOfHeading(row) === null || !event.altKey || (!up && event.key !== "ArrowDown")) return drag.listProps.onKeyDown(event);
    event.preventDefault();
    if (saved.current || drag.moving) return;
    const place = headings.indexOf(row);
    const neighbor = headings[place + (up ? -1 : 1)];
    if (!neighbor) return;
    // Put before the heading above, or before the one after the heading below, if there is one.
    focusAfterMove.current = row;
    stage(withSectionMoved(rows, movedBefore(rows, row, up ? neighbor : (headings[place + 2] ?? null)), row));
  }

  /**
   * Saves the layout staged, putting back a row being dragged, so what's saved is what shows, and
   * settles with whether it's saved, waiting for a save already under way rather than saving again.
   */
  function save(): Promise<boolean> {
    if (saved.current) return saved.current;
    if (!changed) return Promise.resolve(true);
    drag.release();
    setSaving(true);
    setStatus({ message: "Saving room order…", error: false });
    saved.current = send().finally(() => {
      saved.current = null;
      if (mounted.current) setSaving(false);
    });
    return saved.current;
  }

  /** Sends the layout staged, saying how that went, and settles with whether it's saved. */
  async function send(): Promise<boolean> {
    const roomIds = rows.filter((row) => sectionOfHeading(row) === null);
    const inSection = new Map<SectionId, RoomId[]>();
    let under: RoomId[] | null = null;
    for (const row of rows) {
      const sectionId = sectionOfHeading(row);
      if (sectionId !== null) inSection.set(sectionId, (under = []));
      else under?.push(row);
    }
    // Without sections, it says nothing of them, as a layout from before them did.
    const sections = [...inSection].map(([id, roomIds]) => ({ id, roomIds }));
    try {
      onSaved(await setSharedOrder({ roomIds, ...(sections.length > 0 && { sections }) }));
      if (mounted.current) {
        setStaged(null);
        setStatus({ message: "Room order saved for everyone.", error: false });
      }
      return true;
    } catch (error) {
      // Once another person's workspace has taken this one's place, the session it hears about is gone.
      if (!mounted.current) return false;
      if (isSignedOut(error)) onSessionChanged(null);
      else setStatus({ message: "Couldn’t save room order. Please try again.", error: true });
      return false;
    }
  }

  /** Puts the rows back in the order saved, a row being dragged included. */
  function reset() {
    if (saved.current) return;
    drag.release();
    setStaged(null);
    setStatus(null);
  }

  return {
    order: shown,
    moving: drag.moving,
    /** How many rooms each section has, as staged. */
    counts,
    status,
    changed,
    saving,
    listRef: drag.listRef,
    listProps: { ...drag.listProps, onKeyDown },
    save,
    reset,
  };
}
