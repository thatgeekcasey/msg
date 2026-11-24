import { useContext, useEffect, type ReactNode } from "react";
import { searchOfQuery, type Me, type Room } from "@ember/protocol";
import { Clock, Headset, Search as SearchIcon } from "@/components/icons/iconoir";
import { PageLink } from "@/components/page-link";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { historyAddressOf, recordVisit, usePageHistory, type Visit } from "@/hooks/use-page-history";
import { routeOf, useQuery, useRoute } from "@/hooks/use-route";
import { membersShown } from "@/lib/directs";
import { visitedLabel } from "@/lib/messages";
import { RoomMark, searchLabel, useSearchNames, type SearchNames } from "./search-box";
import { ShortcutTooltip } from "./shortcut-tooltip";
import { UserAvatar } from "./user-avatar";

/** A page History lists, as it's named now. */
interface Place extends Visit {
  label: string;
  mark: ReactNode;
}

/** A room's icon, or for a DM, the face of someone else in it, as the sidebar's rows show them. */
function ConversationMark({ room, me }: { room: Room; me: Me }) {
  if (room.kind !== "direct") return <RoomMark room={room} size={18} />;
  return <UserAvatar user={membersShown(room, me.id)[0]!} className="size-[18px]" />;
}

/**
 * What History lists for a visit: the room or DM by its name now, a thread by its room's or the people
 * in its DM, a search by its filters and words, someone by their name, and Huddles. Null for a room or
 * DM no longer listed, such as one left, someone the directory doesn't know, and an address that names
 * nothing it lists.
 */
function placeOf(visit: Visit, me: Me, rooms: readonly Room[], people: People, names: SearchNames): Place | null {
  const [path = "", query = ""] = visit.address.split("?", 2);
  const route = routeOf(path);
  switch (route.page) {
    case "room": {
      const room = rooms.find(({ id }) => id === route.roomId);
      if (!room) return null;
      const name = names.roomName(room);
      const label = route.threadId === undefined ? name : `Thread ${room.kind === "direct" ? "with" : "in"} ${name}`;
      return { ...visit, label, mark: <ConversationMark room={room} me={me} /> };
    }
    case "person": {
      const person = people.get(route.userId);
      return person ? { ...visit, label: person.name, mark: <UserAvatar user={person} className="size-[18px]" /> } : null;
    }
    case "search":
      return { ...visit, label: `“${searchLabel(searchOfQuery(new URLSearchParams(query)).search, names)}”`, mark: <SearchIcon className="size-[18px]" /> };
    case "huddles":
      return { ...visit, label: "Huddles", mark: <Headset className="size-[18px]" /> };
    default:
      return null;
  }
}

/**
 * History's places, as links, each with how long ago it was shown. The menu mounts them as it opens, so
 * that's as of then, however long the page has shown since it last changed.
 */
function PlaceItems({ places }: { places: readonly Place[] }) {
  const now = new Date();
  return places.map(({ address, at, label, mark }) => (
    <DropdownMenuItem key={address} asChild className="min-h-10 gap-2.5 rounded-[7px] px-2 text-[14px] text-foreground focus:bg-hover">
      <PageLink href={address}>
        <span className="grid w-[18px] shrink-0 place-items-center text-muted-foreground">{mark}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <time dateTime={new Date(at).toISOString()} className="shrink-0 text-xs text-muted-foreground">
          {visitedLabel(new Date(at), now)}
        </time>
      </PageLink>
    </DropdownMenuItem>
  ));
}

interface Props {
  me: Me;
  /** The rooms and DMs the sidebar lists, which name the places History lists, and leave out those gone. */
  rooms: readonly Room[];
  className?: string;
}

/**
 * History, after Slack's: a clock that opens the pages this browser has shown you lately, the one shown
 * now aside, newest first, each with how long ago it was, as links that go there, or open in a new tab.
 * It's in the top bar wherever the workspace is, so it lists each page as the page shows.
 */
export function HistoryMenu({ me, rooms, className }: Props) {
  const people = useContext(PeopleContext);
  const names = useSearchNames(me, rooms);
  const visits = usePageHistory(me.id);
  const here = historyAddressOf(useRoute(), useQuery());
  useEffect(() => {
    if (here !== null) recordVisit(me.id, here);
  }, [me.id, here]);
  const places = visits.filter(({ address }) => address !== here).flatMap((visit) => placeOf(visit, me, rooms, people, names) ?? []);
  return (
    <DropdownMenu>
      <ShortcutTooltip label="History">
        <DropdownMenuTrigger aria-label="History" className={className}>
          <Clock className="size-5" />
        </DropdownMenuTrigger>
      </ShortcutTooltip>
      <DropdownMenuContent align="start" sideOffset={6} className="w-[320px] rounded-[12px] bg-background p-2 shadow-[0_8px_24px_var(--color-menu-shadow)]">
        <DropdownMenuLabel className="px-2 pt-1 pb-2 text-xs font-semibold text-muted-foreground">History</DropdownMenuLabel>
        {places.length === 0 && <p className="px-2 pb-2 text-sm text-muted-foreground">Rooms, DMs and searches you visit show up here.</p>}
        <PlaceItems places={places} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
