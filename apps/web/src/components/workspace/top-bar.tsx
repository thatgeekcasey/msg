import { useContext, useMemo, type Ref } from "react";
import { hasFilters, searchOfQuery, type DirectoryUser, type Me, type Room } from "@ember/protocol";
import { useQuery, useRoute } from "@/hooks/use-route";
import { HISTORY_BUTTON, HistoryButtons } from "./history-buttons";
import { HistoryMenu } from "./history-menu";
import { NavigationIcon } from "./navigation-icon";
import { OpenSearchContext, SearchLine, searchLabel, useSearchNames } from "./search-box";
import { ShortcutTooltip } from "./shortcut-tooltip";
import { UserAvatar } from "./user-avatar";

interface Props {
  me: Me;
  /** The workspace's name, which the search field says it searches. */
  workspaceName: string;
  /** The rooms and DMs the sidebar lists, which name what History and a search show. */
  rooms: readonly Room[];
  /** The search field, which the search box opens over. */
  field: Ref<HTMLButtonElement>;
  /** @ember, while Ember AI is on and you can ask it, or null. */
  ember: DirectoryUser | null;
  /** Opens your DM with @ember. */
  onAskEmber: () => void;
}

/**
 * The top bar across the window, after Slack's: Back, Forward and History at the end of the sidebar's
 * column, the search field across the page's, and Ask @ember at its end while Ember AI is on. It's left
 * out (`no-top-bar:`) at 900px and below, where the drawer starts with the search field, and on a phone
 * in landscape, where the rail keeps Search, and fingers have their own way back, as they do at any
 * width, where Back and Forward are left out.
 */
export function TopBar({ me, workspaceName, rooms, field, ember, onAskEmber }: Props) {
  return (
    <header className="grid h-top-bar shrink-0 grid-cols-[calc(var(--spacing-rail)+env(safe-area-inset-left))_var(--spacing-sidebar)_minmax(0,1fr)] items-center border-b bg-surface no-top-bar:hidden">
      <div className="col-start-2 flex justify-end gap-1 pr-3">
        <HistoryButtons className="touch:hidden" />
        <HistoryMenu me={me} rooms={rooms} className={HISTORY_BUTTON} />
      </div>
      <div className="flex min-w-0 items-center gap-2.5 pr-[max(12px,env(safe-area-inset-right))]">
        <SearchField me={me} workspaceName={workspaceName} rooms={rooms} field={field} />
        {ember && <AskEmberButton ember={ember} onClick={onAskEmber} />}
      </div>
    </header>
  );
}

/**
 * The search field, which opens the search box over itself, for everything, or on the results page,
 * with the search they show, which it shows too, as tokens and words. Its icon is Search's, which an
 * administrator can choose in Custom styles, as the rail's used to be.
 */
function SearchField({ me, workspaceName, rooms, field }: Pick<Props, "me" | "workspaceName" | "rooms" | "field">) {
  const openSearch = useContext(OpenSearchContext);
  const names = useSearchNames(me, rooms);
  const results = useRoute().page === "search";
  const query = useQuery();
  const shown = useMemo(() => (results ? searchOfQuery(new URLSearchParams(query)) : null), [results, query]);
  const showing = shown !== null && (shown.search.q !== "" || hasFilters(shown.search));
  return (
    <button
      ref={field}
      type="button"
      aria-label={showing ? `Change search: ${searchLabel(shown.search, names)}` : undefined}
      onClick={(event) => openSearch({ opener: event.currentTarget, ...(shown && { search: shown.search, sort: shown.sort }) })}
      className="flex h-[30px] min-w-0 flex-1 cursor-text items-center gap-2 rounded-[9px] border bg-background px-2.5 text-start text-[14px] text-muted-foreground hover:border-muted-foreground touch:h-11"
    >
      <NavigationIcon slot="search" size={17} className="size-[17px] shrink-0" />
      {showing ? <SearchLine search={shown.search} names={names} className="text-foreground" /> : <span className="truncate">Search {workspaceName}</span>}
    </button>
  );
}

/** Ask @ember, with its avatar, as Slack's bar ends with Slackbot's, which opens your DM with it. */
function AskEmberButton({ ember, onClick }: { ember: DirectoryUser; onClick: () => void }) {
  return (
    <ShortcutTooltip label="Ask @ember">
      <button type="button" aria-label="Ask @ember" onClick={onClick} className="grid size-[34px] shrink-0 place-items-center rounded-[10px] border bg-background hover:bg-hover touch:size-11">
        <UserAvatar user={ember} className="size-6" />
      </button>
    </ShortcutTooltip>
  );
}
