import { useId, useMemo, useState } from "react";
import type { Me, RoomId, SavedRoomLayout, Section, SectionId, SharedRoom, SidebarSection } from "@ember/protocol";
import { DotsGrid3x3, EditPencil, Trash } from "@/components/icons/iconoir";
import { RoomIcon } from "@/components/icons/room-icon";
import { PageLink } from "@/components/page-link";
import { useMounted } from "@/hooks/use-mounted";
import { roomSettingsPath, WORKSPACE_SETTINGS_PATH } from "@/hooks/use-route";
import { sectionOfHeading, useSharedOrder } from "@/hooks/use-shared-order";
import { ApiError, deleteSection, isSignedOut } from "@/lib/api";
import { roomCount } from "@/lib/room-list";
import { cn } from "@/lib/utils";
import { SectionNameDialog } from "./section-name-dialog";
import { UnsavedChanges } from "./unsaved-changes";

/**
 * Save order and Cancel: Campfire's `.btn`, 40px tall, 44px for fingers. Disabled, each is dimmed as
 * Campfire dims a disabled submit button.
 */
const ACTION =
  "inline-flex min-h-10 cursor-pointer items-center justify-center rounded-[9px] border px-3.5 py-2 font-medium touch:min-h-11 disabled:cursor-not-allowed disabled:opacity-50 disabled:grayscale disabled:contrast-50";

/** A row of the list, a room's or a section's heading, with the row being moved marked at its start. */
const ROW = "flex min-h-[52px] items-center gap-2.5 py-1 not-first:border-t focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-muted-foreground";
const MOVING = "bg-hover shadow-[inset_3px_0_var(--color-foreground)]";

/** A row's grip, 44px wide, so a fingertip on it doesn't land on the row around it instead. */
const GRIP =
  "inline-flex min-h-11 min-w-9 cursor-grab touch-none items-center justify-center rounded-md p-2 text-muted-foreground touch:min-w-11 hover:bg-hover hover:text-foreground";

/** A section's Rename and Delete. */
const SECTION_ACTION =
  "grid size-9 cursor-pointer place-items-center rounded-md text-muted-foreground touch:size-11 hover:bg-hover hover:text-foreground disabled:cursor-default disabled:opacity-50";

/** What the unsaved changes dialog says about an order staged, as it says of a room's form. */
const ORDER_CHANGES = "You’ve changed the room order. Save it before you leave, or discard it to keep things as they were.";

export const CONFIRM_DELETE_SECTION = "Are you sure you want to delete this section? Its rooms stay, in no section.";

/** Whether going to `path` keeps workspace settings, as Back and Forward between its sections do. */
const staysInSettings = (path: string) => path === WORKSPACE_SETTINGS_PATH;

/** Each of `rows` with the section whose heading it is, or that it's under, if any. */
function withSections(rows: string[]): Array<{ row: string; sectionId: SectionId | null }> {
  let under: SectionId | null = null;
  return rows.map((row) => ({ row, sectionId: (under = sectionOfHeading(row) ?? under) }));
}

interface Props {
  /** The rooms in this administrator's sidebar, but their DMs, in the order they were put in them. */
  rooms: SharedRoom[];
  /** The ones of them the shared order ranks, in its order. */
  sharedOrder: RoomId[];
  /** Every section, in order, with which of `rooms` are in it. */
  sections: SidebarSection[];
  /** Called with the layout as the server answers it, once one is saved. */
  onSaved: (layout: SavedRoomLayout) => void;
  /** Called once a section is renamed or deleted, for the sidebar to load again, settling once it has or failed. */
  onSectionsChanged: () => Promise<void>;
  /** Says why renaming or deleting a section failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
  /** Called with null when the session has expired. */
  onSessionChanged: (me: Me | null) => void;
}

/**
 * The order rooms come in for everyone, in workspace settings' Rooms and permissions: a row per room,
 * after the rooms in no section, each section's heading with its rooms under it, every row dragged by
 * its grip or moved with Alt and an arrow (`useSharedOrder`), then Save order or Cancel. The rest of a
 * room's row links to its settings, saying who it's open to, and a heading says how many rooms the
 * section has, with Rename and Delete, which take effect at once. What the list last said about a move
 * shows under it. Leaving the page with an order staged asks to save or discard it, as leaving a room's
 * form does.
 */
export function RoomOrder({ rooms, sharedOrder, sections, onSaved, onSectionsChanged, onFailed, onSessionChanged }: Props) {
  const { order, moving, counts, status, changed, saving, listRef, listProps, save, reset } = useSharedOrder({ rooms, sharedOrder, sections, onSaved, onSessionChanged });
  const byId = useMemo(() => new Map(rooms.map((room) => [room.id, room])), [rooms]);
  const sectionsById = useMemo(() => new Map(sections.map((section) => [section.id, section])), [sections]);
  const helpId = useId();
  const namesId = useId();
  const nameIdOf = (sectionId: SectionId) => `${namesId}-${sectionId}`;
  const [renaming, setRenaming] = useState<Section | null>(null);
  // The section being deleted, until the sidebar has loaded without it.
  const [deleting, setDeleting] = useState<SectionId | null>(null);
  const mounted = useMounted();

  /** Saves the order staged for the unsaved changes dialog, which says so when it isn't saved. */
  const saveBeforeLeaving = async () => {
    if (!(await save())) throw new Error("The room order wasn't saved");
  };

  /** Once it's confirmed, deletes `section`, whose rooms stay, in none, as they do when it's gone already. */
  const remove = (section: Section) => {
    if (!confirm(CONFIRM_DELETE_SECTION)) return;
    setDeleting(section.id);
    deleteSection(section.id)
      .then(onSectionsChanged, (error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return onSectionsChanged();
        if (mounted.current || isSignedOut(error)) onFailed(error);
      })
      .finally(() => mounted.current && setDeleting(null));
  };

  return (
    <div className="border-t">
      <p id={helpId} className="my-[1em] text-[0.8em] text-muted-foreground">
        {sections.length > 0
          ? "Drag a room to reorder your community sidebar, or into a section. Click a room to set its permissions."
          : "Drag a room to reorder your community sidebar. Click a room to set its permissions."}
      </p>
      <div
        ref={listRef}
        {...listProps}
        role="list"
        aria-label="Room order"
        className={cn("max-h-[360px] overflow-y-auto overscroll-contain rounded-[10px] border bg-background", moving && "select-none")}
      >
        {withSections(order).map(({ row, sectionId }) => {
          const section = sectionId === null ? null : (sectionsById.get(sectionId) ?? null);
          if (sectionOfHeading(row) !== null) {
            if (!section) return null;
            return (
              <div
                key={row}
                role="listitem"
                tabIndex={0}
                data-room-id={row}
                aria-labelledby={nameIdOf(section.id)}
                aria-describedby={helpId}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                className={cn(ROW, "bg-surface pr-2 pl-1", row === moving && MOVING)}
              >
                <button type="button" data-room-order-handle aria-label={`Move ${section.name}`} title="Drag to reorder, or press Alt + Up / Down" className={GRIP}>
                  <DotsGrid3x3 className="size-[18px]" />
                </button>
                <span id={nameIdOf(section.id)} className="min-w-0 truncate font-semibold">
                  {section.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground max-md:hidden">{roomCount(counts.get(section.id) ?? 0)}</span>
                <span className="ml-auto flex shrink-0 items-center">
                  <button
                    type="button"
                    disabled={deleting === section.id}
                    aria-label={`Rename ${section.name}`}
                    title="Rename"
                    onClick={() => setRenaming(section)}
                    className={SECTION_ACTION}
                  >
                    <EditPencil className="size-[17px]" />
                  </button>
                  <button
                    type="button"
                    disabled={deleting === section.id}
                    aria-label={`Delete ${section.name}`}
                    title="Delete"
                    onClick={() => remove(section)}
                    className={SECTION_ACTION}
                  >
                    <Trash className="size-[17px]" />
                  </button>
                </span>
              </div>
            );
          }
          const room = byId.get(row);
          if (!room) return null;
          return (
            <div
              key={row}
              role="listitem"
              tabIndex={0}
              data-room-id={row}
              // A room in a section is described as in it.
              aria-describedby={section ? `${nameIdOf(section.id)} ${helpId}` : helpId}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              className={cn(ROW, "pr-3", section ? "pl-8 max-md:pl-6" : "pl-1", row === moving && MOVING)}
            >
              <button type="button" data-room-order-handle aria-label={`Move ${room.name}`} title="Drag to reorder, or press Alt + Up / Down" className={GRIP}>
                <DotsGrid3x3 className="size-[18px]" />
              </button>
              {/* The room's settings, filling the row beside the grip, with who it's open to at its end. */}
              <PageLink
                href={roomSettingsPath(room.kind, room.id)}
                aria-label={`Settings for ${room.name}`}
                className="group flex min-w-0 flex-1 items-center gap-2.5 self-stretch"
              >
                <RoomIcon icon={room.icon} size={19} className="w-[18px] shrink-0 text-center text-[22px] leading-none text-muted-foreground" />
                <span className="min-w-0 truncate group-hover:underline">{room.name}</span>
                <span className="ml-auto shrink-0 rounded-full border bg-hover px-2 py-[3px] text-[11px] whitespace-nowrap text-muted-foreground">
                  {room.kind === "closed" ? "Selected people" : "Everyone"}
                </span>
              </PageLink>
            </div>
          );
        })}
      </div>
      {order.length === 0 && <p className="my-[1em] text-[0.8em] text-muted-foreground">No rooms to arrange yet.</p>}
      <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2">
        {/* Always there for screen readers to hear, it takes no room until it says something. */}
        <p role="status" aria-live="polite" className={cn("basis-full", status?.error ? "text-negative" : "text-muted-foreground", !status && "sr-only")}>
          {status?.message}
        </p>
        <button type="button" disabled={saving || !changed} onClick={reset} className={cn(ACTION, "bg-background text-foreground")}>
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || !changed}
          onClick={() => void save()}
          className={cn(ACTION, "border-transparent bg-foreground text-background hover:not-active:brightness-70")}
        >
          Save order
        </button>
      </div>
      <UnsavedChanges changed={changed} stays={staysInSettings} onSave={saveBeforeLeaving} description={ORDER_CHANGES} />
      {renaming && (
        <SectionNameDialog
          section={renaming}
          onSaved={() => void onSectionsChanged()}
          onClose={() => setRenaming(null)}
          onFailed={onFailed}
        />
      )}
    </div>
  );
}
