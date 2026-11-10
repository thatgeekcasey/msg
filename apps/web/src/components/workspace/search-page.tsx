import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  hasFilters,
  isSearchable,
  normalizedSearch,
  SEARCH_FLAGS,
  searchKey,
  searchOfQuery,
  searchPath,
  type Me,
  type Room,
  type RoomId,
  type Search,
  type SearchFilters,
  type SearchFlag,
  type SearchMatch,
  type SearchResults,
  type SearchSort,
} from "@ember/protocol";
import { ArrowLeft, ClockRotateRight, NavArrowRight, Search as SearchIcon, Sort, Trash, User as UserIcon, Xmark } from "@/components/icons/iconoir";
import { MainContent } from "@/components/main-content";
import { PageLink } from "@/components/page-link";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useMounted } from "@/hooks/use-mounted";
import { navigate, pageMark, permalinkOf, SEARCHES_PATH, useQuery, useVisit } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import { clearSearches, fetchSearch, isSignedOut } from "@/lib/api";
import { dateLabel, dateTimeLabel } from "@/lib/messages";
import { FLAG_LABELS, marksFor, takeAnswer } from "@/lib/search";
import { cn } from "@/lib/utils";
import { MessageItem, type MessageEditors } from "./message-item";
import { HEADER_BUTTON, PageHeader } from "./page-header";
import { Chip, CHIPS_ROW, CONFIRM_CLEAR_SEARCHES, FLAG_ICONS, OpenSearchContext, RoomMark, searchLabel, SearchLine, useSearchNames, type SearchNames } from "./search-box";
import { SearchMarks } from "./search-marks";

/** Results can't be edited or replied to, so nothing opens an editor or writes in a composer. */
const NO_EDITORS: MessageEditors = { open() {}, close() {}, returnFocus() {}, attach() {}, reply() {} };

/** What the sort menu calls each order. */
const SORT_LABELS: Record<SearchSort, string> = { newest: "Newest first", oldest: "Oldest first" };

/** A `.btn` under the results, 44px tall for fingers. */
const BUTTON = "inline-flex cursor-pointer items-center justify-center gap-[0.5em] rounded-[9px] border bg-background px-[1.1em] py-[0.5em] font-medium hover:bg-hover touch:min-h-11";

/** What the page shows of a search: the matches loaded so far, the cursor of the next page, and the rooms they're in. */
interface Found {
  matches: SearchMatch[];
  next: number | null;
  rooms: ReadonlyMap<RoomId, Room>;
  recent: Search[];
}

const foundOf = (results: SearchResults): Found => ({
  matches: results.matches,
  next: results.next,
  rooms: new Map(results.rooms.map((room) => [room.id, room])),
  recent: results.recent,
});

/** `found` with the next page after it, leaving out any match it has already. */
function withNextPage(found: Found, results: SearchResults): Found {
  const shown = new Set(found.matches.map((match) => match.message.id));
  return {
    matches: [...found.matches, ...results.matches.filter((match) => !shown.has(match.message.id))],
    next: results.next,
    rooms: new Map([...found.rooms, ...results.rooms.map((room) => [room.id, room] as const)]),
    recent: results.recent,
  };
}

interface Props {
  me: Me;
  /** The rooms the sidebar lists, which the search's filters are named by. */
  rooms: readonly Room[];
  /** Where Exit search goes: the last room visited, or home. */
  back: string;
  /** Says why a search failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * The search results page, at `/searches?q=`, after Slack's: the search in the top bar, which opens the
 * search box to change it, its filters under it, which turn on and off as the box's chips do, and how
 * the results are sorted, then how many messages it found, and each, newest first or oldest, as a card
 * naming its room and day, with the words it matched marked, and Show more under them while there are
 * more. A page without a search lists your recent searches. Each visit asks for its address's search
 * afresh, but the one the search box goes to, which shows what its search answered. Until a visit's
 * search answers, the page goes on showing the last one, marked busy, and drops it if the search fails.
 */
export function SearchPage({ me, rooms, back, onFailed }: Props) {
  const query = useQuery();
  const visit = useVisit();
  const { search, sort, cursor } = useMemo(() => searchOfQuery(new URLSearchParams(query)), [query]);
  const names = useSearchNames(me, rooms);
  const openSearch = useContext(OpenSearchContext);
  const mounted = useMounted();
  // The page as last drawn: the visit it was drawn for, and what that visit's search found, or null if it failed.
  const [page, setPage] = useState<{ visit: number; found: Found | null } | null>(null);
  // The page whose next page is loading.
  const [loadingMore, setLoadingMore] = useState<typeof page>(null);
  const list = useRef<HTMLElement>(null);
  // What takes focus once the search box's search shows: the count of what it found, or what says it found nothing.
  const heading = useRef<HTMLHeadingElement>(null);
  const focusOnDraw = useRef(false);
  useTitle("Search");

  useEffect(() => {
    const draw = (results: SearchResults | null) => setPage({ visit, found: results && foundOf(results) });
    const answer = cursor === null ? takeAnswer(search, sort, visit) : null;
    if (answer) {
      focusOnDraw.current = true;
      draw(answer);
      return;
    }
    let stopped = false;
    fetchSearch(search, sort, cursor ?? undefined).then(
      (results) => !stopped && draw(results),
      (error: unknown) => {
        if (stopped && !isSignedOut(error)) return;
        // What another search found doesn't stay at this one's address.
        if (!stopped) draw(null);
        onFailed(error);
      },
    );
    return () => void (stopped = true);
  }, [search, sort, cursor, visit, onFailed]);
  const busy = page?.visit !== visit;
  const found = page?.found ?? null;

  // A search drawn afresh shows from its top, and the box's takes focus. The next page joins the one
  // drawn, which stays where it's scrolled to.
  const drawn = page?.visit;
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = 0;
    if (!focusOnDraw.current || drawn !== visit) return;
    focusOnDraw.current = false;
    heading.current?.focus({ preventScroll: true });
  }, [drawn, visit]);

  // Each filter turned on or off goes to the search it makes, as does each order.
  const go = (next: Search, nextSort: SearchSort = sort) => navigate(searchPath(normalizedSearch(next), nextSort));
  const without = (filter: keyof SearchFilters) => go({ ...search, [filter]: undefined });
  const toggle = (flag: SearchFlag) => (search[flag] ? without(flag) : go({ ...search, [flag]: true }));

  // The next page joins the page it's for, unless another search has shown meanwhile.
  const showMore = () => {
    const shown = page;
    if (busy || !shown?.found || shown.found.next === null || loadingMore === shown) return;
    const loaded = () => setLoadingMore((loading) => (loading === shown ? null : loading));
    setLoadingMore(shown);
    fetchSearch(search, sort, shown.found.next).then(
      (results) => {
        if (!mounted.current) return;
        loaded();
        setPage((page) => (page === shown && page.found ? { ...page, found: withNextPage(page.found, results) } : page));
      },
      (error: unknown) => {
        if (mounted.current) loaded();
        if (mounted.current || isSignedOut(error)) onFailed(error);
      },
    );
  };

  // Asked first, then the page without a search.
  const clear = () => {
    if (!confirm(CONFIRM_CLEAR_SEARCHES)) return;
    const mark = pageMark();
    clearSearches().then(
      () => mounted.current && pageMark() === mark && navigate(SEARCHES_PATH),
      (error: unknown) => (mounted.current || isSignedOut(error)) && onFailed(error),
    );
  };

  const searchable = isSearchable(search);
  // What the top bar shows of the search, if there's anything to show.
  const shown = search.q !== "" || hasFilters(search);
  const fromMe = search.from === me.id;
  const roomIn = search.in === undefined ? null : names.room(search.in);
  return (
    <>
      <PageHeader>
        <PageLink href={back} title="Exit search" className={HEADER_BUTTON}>
          <ArrowLeft className="size-5" />
          <span className="sr-only">Exit search</span>
        </PageLink>
        <h1 className="sr-only">Search messages</h1>
        {/* The search, which opens the search box to change it. */}
        <button
          type="button"
          aria-label={shown ? `Change search: ${searchLabel(search, names)}` : undefined}
          onClick={(event) => openSearch({ opener: event.currentTarget, search, sort })}
          className="flex min-h-9 max-w-[640px] min-w-0 flex-1 cursor-text items-center gap-2 rounded-[9px] border bg-surface px-3 text-start text-[15px] hover:border-muted-foreground touch:min-h-11"
        >
          <SearchIcon className="size-[18px] shrink-0 text-muted-foreground" />
          {shown ? (
            <SearchLine search={search} names={names} />
          ) : (
            <span className="text-muted-foreground">Search</span>
          )}
        </button>
      </PageHeader>
      <MainContent
        aria-busy={busy || undefined}
        className="relative flex min-h-0 min-w-0 flex-col bg-background pr-[env(safe-area-inset-right)] max-md:pl-[env(safe-area-inset-left)]"
      >
        {searchable && (
          // The filters, and the order, at the end.
          <div className="flex flex-none items-start gap-2 border-b px-[22px] py-2.5 max-md:items-center max-md:px-3">
            <div role="group" aria-label="Search filters" className={cn("flex min-w-0 flex-1 gap-2", CHIPS_ROW, "max-md:pl-0")}>
              {search.in !== undefined && (
                <ScopeChip label={`in:${roomIn ? names.roomName(roomIn) : "an unknown room"}`} onRemove={() => without("in")}>
                  <RoomMark room={roomIn} size={16} />
                </ScopeChip>
              )}
              {search.from !== undefined && !fromMe && (
                <ScopeChip label={`from:${names.person(search.from)}`} onRemove={() => without("from")}>
                  <UserIcon />
                </ScopeChip>
              )}
              <Chip pressed={fromMe} onClick={() => (fromMe ? without("from") : go({ ...search, from: me.id }))}>
                <UserIcon />
                From me
              </Chip>
              {SEARCH_FLAGS.map(({ flag }) => {
                const Icon = FLAG_ICONS[flag];
                return (
                  <Chip key={flag} pressed={search[flag] === true} onClick={() => toggle(flag)}>
                    <Icon />
                    {FLAG_LABELS[flag]}
                  </Chip>
                );
              })}
            </div>
            <SortMenu sort={sort} onSort={(order) => go(search, order)} />
          </div>
        )}

        <section
          ref={list}
          aria-label="Search results"
          className="min-h-0 flex-1 basis-0 overflow-x-hidden overflow-y-auto overscroll-contain px-[22px] pt-4 pb-[max(18px,env(safe-area-inset-bottom))] [scrollbar-gutter:stable] max-md:px-3 max-md:pt-3"
        >
          {/* A page can lose every match it found to messages deleted since, and still have one after it. */}
          {found && (found.matches.length > 0 || found.next !== null) ? (
            <>
              <h2 ref={heading} tabIndex={-1} className="mb-3 text-[13px] font-semibold text-muted-foreground outline-none">
                {countLabel(found)}
              </h2>
              <ol className="flex flex-col gap-3">
                {found.matches.map((match) => (
                  <li key={match.message.id}>
                    <Result match={match} room={found.rooms.get(match.message.roomId) ?? names.room(match.message.roomId)} me={me} names={names} />
                  </li>
                ))}
              </ol>
              {found.next !== null && (
                <div className="flex justify-center pt-4">
                  <button type="button" onClick={showMore} aria-busy={loadingMore === page || undefined} className={BUTTON}>
                    {loadingMore === page ? "Loading…" : "Show more"}
                  </button>
                </div>
              )}
            </>
          ) : found && searchable ? (
            <Nothing heading={heading} title="No messages found">
              {hasFilters(search) ? "Try different words, or take a filter off." : "Try a different word or phrase."}
            </Nothing>
          ) : found ? (
            <>
              <Nothing heading={heading} title="Find a conversation">
                Search messages across your rooms and direct messages.
                <button type="button" onClick={(event) => openSearch({ opener: event.currentTarget })} className={`${BUTTON} mt-4 text-foreground`}>
                  <SearchIcon className="size-[18px]" />
                  Search
                </button>
              </Nothing>
              {found.recent.length > 0 && <RecentSearches searches={found.recent} names={names} onClear={clear} />}
            </>
          ) : null}
        </section>
      </MainContent>
    </>
  );
}

/** The room or person a search is narrowed to, as a pressed chip, which takes the filter off. */
function ScopeChip({ label, onRemove, children }: { label: string; onRemove: () => void; children: ReactNode }) {
  return (
    <Chip pressed aria-label={`Remove ${label}`} onClick={onRemove}>
      {children}
      <span className="max-w-[16em] truncate">{label}</span>
      <Xmark />
    </Chip>
  );
}

/** How many messages the page shows, with a + while there are more. */
function countLabel({ matches, next }: Found): string {
  const count = matches.length.toLocaleString();
  if (next !== null) return `${count}+ results`;
  return matches.length === 1 ? "1 result" : `${count} results`;
}

/** Newest first or oldest first, as a menu of the two. */
function SortMenu({ sort, onSort }: { sort: SearchSort; onSort: (sort: SearchSort) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Sort: ${SORT_LABELS[sort]}`}
        className="inline-flex min-h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap hover:bg-hover touch:min-h-11 touch:min-w-11 aria-expanded:bg-hover"
      >
        <Sort className="size-4 shrink-0" />
        <span className="max-md:sr-only">{SORT_LABELS[sort]}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={sort} onValueChange={(value) => onSort(value === "oldest" ? "oldest" : "newest")}>
          <DropdownMenuRadioItem value="newest">{SORT_LABELS.newest}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="oldest">{SORT_LABELS.oldest}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A message the search found, as a card, after Slack's: its room's icon and name, and the day it was
 * written, over the message, which can't be changed, with the words the search matched marked, and a
 * link to the message where it is.
 */
function Result({ match, room, me, names }: { match: SearchMatch; room: Room | null; me: Me; names: SearchNames }) {
  const { message } = match;
  const marks = useMemo(() => marksFor(match.words), [match.words]);
  const created = new Date(message.createdAt);
  return (
    <div className="overflow-hidden rounded-xl border bg-background">
      <div className="flex min-h-9 items-center gap-2 border-b bg-surface px-4 py-1.5 text-[13px] text-muted-foreground max-md:px-3">
        <RoomMark room={room} size={15} />
        <span className="min-w-0 truncate font-semibold text-foreground">{room ? names.roomName(room) : "A room you’ve left"}</span>
        <span aria-hidden>·</span>
        <time dateTime={message.createdAt} title={dateTimeLabel(created)} className="shrink-0">
          {dateLabel(created)}
        </time>
        <PageLink
          href={permalinkOf(message)}
          className="ml-auto inline-flex shrink-0 items-center justify-center gap-0.5 rounded-md px-1.5 py-0.5 font-medium hover:bg-hover hover:text-foreground touch:min-h-11 touch:min-w-11"
        >
          {/* Only its arrow at 900px and below, leaving the room's name the room. */}
          <span className="max-md:sr-only">{room?.kind === "direct" ? "View in conversation" : "View in room"}</span>
          <NavArrowRight className="size-4" />
        </PageLink>
      </div>
      <div className="pb-1">
        <SearchMarks value={marks}>
          <MessageItem message={message} me={me} threaded={false} editing={false} actions={null} editors={NO_EDITORS} />
        </SearchMarks>
      </div>
    </div>
  );
}

/**
 * Campfire's `.message-area--empty`: a magnifying glass, faded, over what to do, which tells a search
 * that found nothing from no search at all.
 */
function Nothing({ heading, title, children }: { heading: RefObject<HTMLHeadingElement | null>; title: string; children: ReactNode }) {
  return (
    <div className="grid justify-items-center px-6 pt-[8dvh] pb-6 text-center text-muted-foreground">
      <SearchIcon className="mb-4 h-auto w-16 max-w-[25vw] text-foreground opacity-20" />
      <h2 ref={heading} tabIndex={-1} className="mb-1.5 text-xl font-bold text-foreground outline-none">
        {title}
      </h2>
      <p className="grid justify-items-center">{children}</p>
    </div>
  );
}

/** Your recent searches, newest first, each going to its results, then the trash can, which clears them. */
function RecentSearches({ searches, names, onClear }: { searches: Search[]; names: SearchNames; onClear: () => void }) {
  return (
    <section aria-labelledby="recent-searches" className="mx-auto w-full max-w-[640px] pt-6">
      <div className="flex items-center justify-between gap-2 px-2 pb-1">
        <h2 id="recent-searches" className="text-xs font-semibold text-muted-foreground">
          Recent searches
        </h2>
        <button
          type="button"
          aria-label="Clear recent searches"
          onClick={onClear}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-hover hover:text-foreground touch:min-h-11"
        >
          <Trash className="size-3.5" />
          Clear
        </button>
      </div>
      <ul>
        {searches.map((search) => (
          <li key={searchKey(search)}>
            <PageLink href={searchPath(search)} aria-label={searchLabel(search, names)} className="flex min-h-10 items-center gap-2.5 rounded-lg px-2 py-1.5 text-[14px] text-foreground hover:bg-hover touch:min-h-11">
              <ClockRotateRight className="size-[18px] shrink-0 text-muted-foreground" />
              <SearchLine search={search} names={names} />
            </PageLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
