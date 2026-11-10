import { useId, useMemo, useState, type MouseEvent } from "react";
import type { Favorites, Me, RoomId, SidebarRoom, User, UserId } from "@ember/protocol";
import { ChatPlusIn, StarSolid } from "@/components/icons/iconoir";
import { RoomIcon } from "@/components/icons/room-icon";
import { useAccount } from "@/hooks/use-account";
import { useNameOf } from "@/hooks/use-directory";
import { useMounted } from "@/hooks/use-mounted";
import { leave, NEW_DIRECT_PATH, roomPath } from "@/hooks/use-route";
import { useStarOrder } from "@/hooks/use-star-order";
import { membersShown } from "@/lib/directs";
import { apart, inDirectOrder, inSidebarOrder, markedUnread, suggestedPeople, type DirectSidebarRoom } from "@/lib/room-list";
import { cn } from "@/lib/utils";
import { AgentBadge, useIsAgent, useIsWithAgent } from "./agent-badge";
import { opensNewDirect } from "./new-direct-dialog";
import { UserAvatar } from "./user-avatar";

/** A row of the list, a room's or a DM's. */
const ROW =
  "flex min-h-9 items-center gap-2.5 rounded-lg px-[9px] py-[7px] text-sm leading-[22px] text-foreground no-underline touch:min-h-11 hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:font-semibold";

/** How many avatars a group DM's row shows. */
const MAX_FACES = 4;

interface Props {
  /** The workspace's name, which heads the list. */
  workspaceName: string;
  /** Who the sidebar is for, whose DMs name the others in them. */
  meId: UserId;
  /** Someone's rooms and DMs, in any order. */
  rooms: SidebarRoom[];
  /** Whether their list has come, before which nothing says there's nothing in it. */
  loaded: boolean;
  /** The people suggested for DMs, as the server last listed them. */
  suggestions: User[];
  /** The rooms they've starred, whose rows come first, end with a star, and can be moved among themselves. */
  favorites: Favorites;
  /** The rooms the workspace's shared order ranks, which come next, in its order. */
  sharedOrder: RoomId[];
  currentRoomId: string | null;
  /** Whether Activity is on, which shows only the rows marked unread. */
  unreadOnly: boolean;
  onSelect: (roomId: string) => void;
  /** Opens New direct message, which the DMs heading's link does in place, from the link that opened it. */
  onNewDirect: (opener: HTMLElement) => void;
  /** Starts the DM with someone suggested, or opens the one they have, and goes there, settling with whether it did. */
  onStartDirect: (person: User) => Promise<boolean>;
  /** Called with this person's stars as the server answers them, once a new order for them is saved. */
  onStarred: (favorites: Favorites) => void;
  /** Called with null when the session has expired. */
  onSessionChanged: (me: Me | null) => void;
}

/**
 * The conversation list: rooms, then DMs, under the workspace name, and under that in small type the
 * tagline an administrator gave it, if it has one. The starred rooms come first, then the ones the
 * shared order ranks, in its order, then the rest by name, and a starred room's row ends with a star,
 * with no grip, as the project's owner chose: held, the row can be dragged among the other starred rows,
 * or moved with Alt and an arrow (`useStarOrder`). The DMs come latest active first, and a DM's row shows
 * who else is in it. People suggested for DMs follow. A room or DM marked unread is bold with a dot at
 * the end of its row. With Activity on, only those rows show, and with none it says everything's read;
 * with it off and nothing to list, it says it found nothing.
 */
export function Sidebar({
  workspaceName,
  meId,
  rooms,
  loaded,
  suggestions,
  favorites,
  sharedOrder,
  currentRoomId,
  unreadOnly,
  onSelect,
  onNewDirect,
  onStartDirect,
  onStarred,
  onSessionChanged,
}: Props) {
  const { tagline } = useAccount();
  const { shared, directs } = useMemo(() => apart(unreadOnly ? rooms.filter((room) => markedUnread(room, currentRoomId)) : rooms), [rooms, unreadOnly, currentRoomId]);
  const shown = useMemo(() => new Set(shared.map((room) => room.id)), [shared]);
  const nameOf = (roomId: RoomId) => {
    const room = rooms.find((r) => r.id === roomId);
    return room && room.kind !== "direct" ? room.name : "";
  };
  const { order, moving, status, listRef, scrollerRef, listProps } = useStarOrder({ favorites, shown, nameOf, onSaved: onStarred, onSessionChanged });
  const listed = useMemo(() => inSidebarOrder(shared, order, sharedOrder), [shared, order, sharedOrder]);
  const starred = useMemo(() => new Set(order), [order]);
  const directsListed = useMemo(() => inDirectOrder(directs), [directs]);
  // Activity hides the suggestions.
  const suggested = useMemo(() => (unreadOnly ? [] : suggestedPeople(suggestions, rooms)), [unreadOnly, suggestions, rooms]);
  const empty = loaded && listed.length === 0 && directsListed.length === 0 && suggested.length === 0;
  const helpId = useId();
  const unreadId = useId();
  const mounted = useMounted();
  // Who's suggested whose DM is starting, which another click doesn't start again.
  const [starting, setStarting] = useState<UserId | null>(null);
  // A suggestion starts its DM once the page's guard lets it, from a page with changes to lose.
  const startWith = (person: User) => {
    if (starting) return;
    leave(async () => {
      setStarting(person.id);
      try {
        return await onStartDirect(person);
      } finally {
        if (mounted.current) setStarting(null);
      }
    });
  };
  // A row followed in place shows its room here, and one opened elsewhere, as in a new tab, leaves this page be.
  const select = (event: MouseEvent, roomId: RoomId) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onSelect(roomId);
  };
  return (
    <div ref={scrollerRef} className="flex h-full flex-col gap-3.5 overflow-y-auto overflow-x-hidden bg-surface px-3 pt-5 pb-[max(20px,env(safe-area-inset-bottom))] [scrollbar-gutter:stable] narrow:px-2 max-md:gap-4 max-md:px-2.5 max-md:pt-4 max-md:pb-[max(16px,env(safe-area-inset-bottom))]">
      {/* The workspace's heading, as an hgroup, HTML's element for a heading and its tagline. At 900px and
          below the drawer's close button sits at the end of the name's row, and the tagline keeps clear of it
          too. A long name wraps rather than running under the sidebar's edge, and so does a tagline in a
          narrower sidebar or wider letters than its length allows for. */}
      <hgroup className="px-1.5 max-md:pr-10">
        <h2 className="flex min-h-7 items-center gap-2 text-[17px] leading-6 font-[650] wrap-anywhere">{workspaceName}</h2>
        {tagline && <p className="text-[13px] leading-[18px] text-muted-foreground wrap-anywhere">{tagline}</p>}
      </hgroup>

      <section aria-label="Rooms" className="flex flex-col">
        <p id={helpId} className="sr-only">
          Hold a starred room to drag it, or press Alt and the up or down arrow to reorder your favorites. Other rooms follow the workspace order.
        </p>
        <span id={unreadId} hidden>
          Unread
        </span>
        <div ref={listRef} {...listProps} className={cn("flex flex-col gap-[3px]", moving && "select-none")}>
          {listed.map((room) => {
            const unread = markedUnread(room, currentRoomId);
            const star = starred.has(room.id);
            return (
              <a
                key={room.id}
                data-room-id={room.id}
                href={roomPath(room.id)}
                draggable={false}
                aria-current={room.id === currentRoomId ? "page" : undefined}
                // Every row says how the stars are reordered, and a marked one says it's unread, which the eye
                // sees by its weight and dot.
                aria-describedby={unread ? `${unreadId} ${helpId}` : helpId}
                aria-keyshortcuts={star ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                onClick={(event) => select(event, room.id)}
                className={cn(
                  ROW,
                  "[-webkit-touch-callout:none]",
                  unread && "font-[650]",
                  star && "cursor-grab",
                  room.id === moving && "relative z-[1] cursor-grabbing bg-background! shadow-[0_4px_14px_var(--color-drag-shadow)] outline outline-muted-foreground",
                )}
              >
                <RoomIcon icon={room.icon} size={19} className="w-[18px] shrink-0 text-center text-[22px] leading-none text-muted-foreground" />
                <span className="truncate">{room.name}</span>
                {/* The dot and star sit together at the row's end, pushed there by one auto margin. The star's
                    muted at 65%. */}
                {unread && <span aria-hidden="true" className="ml-auto size-[7px] shrink-0 rounded-full bg-foreground" />}
                {star && <StarSolid aria-label="Favorite" className={cn("size-3.5 shrink-0 text-muted-foreground/65", !unread && "ml-auto")} />}
              </a>
            );
          })}
        </div>
        {/* Moves are told to screen readers, and a save that fails is shown. */}
        <p role="status" className={status?.error ? "mx-[9px] my-1 text-xs leading-normal text-negative wrap-anywhere" : "sr-only"}>
          {status?.message}
        </p>
      </section>

      <section aria-labelledby="directs-heading" className="flex flex-col gap-[3px]">
        <div className="mb-[5px] flex items-center gap-2 px-[9px] text-xs font-medium text-muted-foreground">
          <h3 id="directs-heading">DMs</h3>
          <a
            href={NEW_DIRECT_PATH}
            title="New direct message"
            aria-label="New direct message"
            onClick={opensNewDirect(onNewDirect)}
            className="ml-auto flex size-7 items-center justify-center rounded-lg text-foreground hover:bg-hover touch:size-11"
          >
            <ChatPlusIn className="size-[15px]" />
          </a>
        </div>
        {directsListed.map((room) => (
          <DirectRow
            key={room.id}
            room={room}
            meId={meId}
            current={room.id === currentRoomId}
            unreadId={markedUnread(room, currentRoomId) ? unreadId : null}
            onClick={(event) => select(event, room.id)}
          />
        ))}
        {suggested.map((person) => (
          <SuggestionRow key={person.id} person={person} starting={person.id === starting} onClick={() => startWith(person)} />
        ))}
      </section>
      {empty && (
        <p className="px-[9px] text-[13px] text-muted-foreground">{unreadOnly ? "You’re all caught up. No unread conversations." : "No conversations found."}</p>
      )}
    </div>
  );
}

interface DirectRowProps {
  room: DirectSidebarRoom;
  meId: UserId;
  /** Whether it's the DM the tab shows. */
  current: boolean;
  /** The element saying the DM is unread, when it's marked so, or null. */
  unreadId: string | null;
  onClick: (event: MouseEvent) => void;
}

/**
 * A DM's row: the avatar of the one other person in it, or of up to four in a group, at 24px or 14px
 * each, then their names, or yours in a DM with yourself, and the agent badge in a DM with an AI agent
 * alone.
 */
function DirectRow({ room, meId, current, unreadId, onClick }: DirectRowProps) {
  const nameOf = useNameOf();
  const isWithAgent = useIsWithAgent();
  const members = membersShown(room, meId);
  return (
    <a
      href={roomPath(room.id)}
      aria-current={current ? "page" : undefined}
      aria-describedby={unreadId ?? undefined}
      onClick={onClick}
      className={cn(ROW, unreadId && "font-[650]")}
    >
      {members.length > 1 ? (
        // Campfire's `.avatar__group` (avatars.css): two to a row, centered on the 24px a single avatar takes.
        <span aria-hidden="true" className="grid size-6 shrink-0 grid-cols-2 grid-rows-[min-content] place-content-center gap-px">
          {members.slice(0, MAX_FACES).map((member) => (
            <UserAvatar key={member.id} user={member} className="size-3.5" />
          ))}
        </span>
      ) : (
        members.map((member) => <UserAvatar key={member.id} user={member} className="size-6" />)
      )}
      {/* The space after the hidden words starts the visible line, where it doesn't show. */}
      <span className="min-w-0 flex-1 truncate">
        <span className="sr-only">Direct message with</span> {members.map((member) => `${nameOf(member)}${member.id === meId ? " (you)" : ""}`).join(", ")}
        {isWithAgent(room) && <AgentBadge className="ms-0.5" />}
      </span>
      {unreadId && <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-foreground" />}
    </a>
  );
}

interface SuggestionRowProps {
  person: User;
  /** Whether the DM with them is starting, which another click doesn't start again. */
  starting: boolean;
  onClick: () => void;
}

/**
 * Someone suggested for a DM: a button in a DM row's style with their avatar and name, and the agent
 * badge for an AI agent, which starts the DM with them.
 */
function SuggestionRow({ person, starting, onClick }: SuggestionRowProps) {
  const nameOf = useNameOf();
  const isAgent = useIsAgent();
  return (
    <button type="button" aria-disabled={starting || undefined} onClick={onClick} className={cn(ROW, "w-full cursor-pointer text-start aria-disabled:cursor-default")}>
      <UserAvatar user={person} className="size-6" />
      {/* The space after the hidden words starts the visible line, where it doesn't show. */}
      <span className="min-w-0 flex-1 truncate">
        <span className="sr-only">Start a direct message with</span> {nameOf(person)}
        {isAgent(person) && <AgentBadge className="ms-0.5" />}
      </span>
    </button>
  );
}
