import { useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from "react";
import type { RoomIconName } from "@ember/protocol";
import { CheckCircle, NavArrowRight, Search, Xmark } from "@/components/icons/iconoir";
import CATALOG_URL from "@/components/icons/picker/catalog.json?url";
import { RoomIcon } from "@/components/icons/room-icon";
import { iconLabel, roomIconLabel, type IconContext } from "@/components/icons/room-icon-label";
import { cn } from "@/lib/utils";
import { displayLabel, ICON_COLLECTIONS, prepareCatalog, searchIcons, type Catalog, type CatalogIcon, type IconCollection, type PreparedCatalog } from "./icon-catalog";

// The icon pickers, the room's and the rail's, and their dialog. The icon applied here is saved with the
// form.

/** How many icons the grid shows at a time. */
const PAGE_SIZE = 72;

// The catalog (3.2 MB, 436 KB compressed) is fetched when a picker first opens, once for every picker
// on the page, and again next time if it fails.
const catalogs = new Map<string, Promise<PreparedCatalog>>();

function loadCatalog(url: string): Promise<PreparedCatalog> {
  let catalog = catalogs.get(url);
  if (!catalog) {
    catalog = fetch(url, { credentials: "same-origin" }).then(async (response) => {
      if (!response.ok) throw new Error("Icon catalog could not be loaded");
      return prepareCatalog((await response.json()) as Catalog);
    });
    catalog.catch(() => catalogs.delete(url));
    catalogs.set(url, catalog);
  }
  return catalog;
}

/** What the results line says once the catalog is in. */
function resultsLabel(count: number, shown: number, collection: IconCollection): string {
  if (!count) return collection === "All" ? "No icons match your search. Try another word." : `No icons match in ${collection}. Try another word or choose All.`;
  return `${count.toLocaleString()} ${count === 1 ? "icon" : "icons"}${count > shown ? ` · ${shown} shown` : ""}`;
}

/** Campfire's `.btn`, which no hover changes. */
const BUTTON = "inline-flex cursor-pointer items-center justify-center gap-[0.5em] rounded-[9px] border bg-background px-[1.1em] py-[0.5em] font-medium text-foreground";
/** The dialog's footer buttons, 44px tall on touch screens. */
const FOOTER_BUTTON = "min-h-10 px-3.5 py-2 touch:min-h-11";

/** What the dialog opens for: an icon chosen so far, its default, and where the icon applied goes. */
export interface IconChoice {
  /** The icon chosen, or null for the default. */
  icon: RoomIconName | null;
  /** The default's icon, or null for `#`, and what it's called. */
  defaultIcon: RoomIconName | null;
  defaultLabel: string;
  /** Called with the icon applied. */
  apply: (icon: RoomIconName | null) => void;
  /** The button that opened the dialog, which has focus back when it closes. */
  trigger: HTMLElement | null;
}

export interface IconDialogHandle {
  open: (choice: IconChoice) => void;
}

interface IconDialogProps {
  ref: Ref<IconDialogHandle>;
  /** What its icons are for, which orders them and names them. */
  context: IconContext;
  title: string;
  description: string;
  /** What the grid of icons is called, such as Room icons. */
  group: string;
  /** Where the catalog comes from. */
  catalogUrl?: string;
}

/**
 * The icon dialog: every icon in the catalog, in Lucide's and Iconoir's tabs or both, to search, page
 * through and pick from, by pointer or keyboard, before applying one or keeping the icon as it was. A
 * picker opens it with what it's choosing.
 */
export function IconDialog({ ref, context, title, description, group, catalogUrl = CATALOG_URL }: IconDialogProps) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const browse = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  // Counts each opening and closing, so a catalog that arrives for a picker since closed is ignored.
  const opening = useRef(0);
  const [choice, setChoice] = useState<IconChoice | null>(null);
  const [catalog, setCatalog] = useState<PreparedCatalog | null>(null);
  const [status, setStatus] = useState<"loading" | "failed" | "ready">("loading");
  // The tab, which stays as it was the next time the dialog opens.
  const [collection, setCollection] = useState<IconCollection>("All");
  // The tab as it is now, which icons still loading when another was chosen are searched in.
  const collectionNow = useRef(collection);
  const [matches, setMatches] = useState<CatalogIcon[]>([]);
  const [visible, setVisible] = useState(PAGE_SIZE);
  // The icon picked here, which Use icon applies.
  const [staged, setStaged] = useState<RoomIconName | null>(null);
  // The icon the keyboard last moved to, which Tab reaches in the grid; until it moves, the staged
  // icon or the first.
  const [roving, setRoving] = useState<RoomIconName | null>(null);
  const focusing = useRef<RoomIconName | null>(null);

  const shown = matches.slice(0, visible);
  const tabStop = [roving, staged].find((name) => shown.some((icon) => icon.name === name)) ?? shown[0]?.name;

  // Show more icons focuses the first it adds, once it's drawn.
  useEffect(() => {
    if (!focusing.current) return;
    grid.current?.querySelector<HTMLButtonElement>(`[data-icon="${focusing.current}"]`)?.focus();
    focusing.current = null;
  }, [visible]);

  const find = (value: string, icons = catalog, within = collectionNow.current) => {
    if (!icons) return;
    setMatches(searchIcons(icons, context, value, within));
    setVisible(PAGE_SIZE);
    setRoving(null);
    if (browse.current) browse.current.scrollTop = 0;
  };

  const load = async () => {
    const ticket = ++opening.current;
    setStatus("loading");
    try {
      const icons = catalog ?? (await loadCatalog(catalogUrl));
      setCatalog(icons);
      if (ticket !== opening.current || !dialog.current?.open) return;
      setStatus("ready");
      find(searchBox.current?.value ?? "", icons);
    } catch {
      if (ticket !== opening.current || !dialog.current?.open) return;
      setStatus("failed");
    }
  };

  useImperativeHandle(ref, () => ({
    open(next) {
      // Cleared here, since the search reads the field itself: a catalog already in is searched before
      // React would draw the field again.
      if (searchBox.current) searchBox.current.value = "";
      setChoice(next);
      setStaged(next.icon);
      dialog.current?.showModal();
      searchBox.current?.focus();
      if (browse.current) browse.current.scrollTop = 0;
      void load();
    },
  }));

  const cancel = () => {
    opening.current++;
    if (dialog.current?.open) dialog.current.close();
  };

  const apply = () => {
    choice?.apply(staged);
    dialog.current?.close();
  };

  const showCollection = (next: IconCollection) => {
    collectionNow.current = next;
    setCollection(next);
    find(searchBox.current?.value ?? "");
  };

  // As a tablist's arrows do, choosing the tab they move to.
  const navigateCollections = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else return;
    event.preventDefault();
    tabs[next]!.focus();
    showCollection(ICON_COLLECTIONS[next]!);
  };

  const more = () => {
    const next = matches[Math.min(visible, matches.length)];
    setVisible(visible + PAGE_SIZE);
    if (!next) return;
    setRoving(next.name);
    focusing.current = next.name;
  };

  // Arrows move by one, or by a row of however many columns the grid has, stopping at the ends.
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-icon]");
    if (!button || !grid.current) return;
    const buttons = [...grid.current.querySelectorAll<HTMLButtonElement>("button[data-icon]")];
    const columns = getComputedStyle(grid.current).gridTemplateColumns.split(" ").length;
    const movement: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
    const index = buttons.indexOf(button);
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key in movement) next = Math.max(0, Math.min(buttons.length - 1, index + movement[event.key]!));
    else return;
    event.preventDefault();
    const target = buttons[next]!;
    setRoving(target.dataset.icon as RoomIconName);
    target.focus();
  };

  // A click on the backdrop, outside the dialog's box, closes it.
  const backdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target !== dialog.current) return;
    const box = dialog.current.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) cancel();
  };

  const defaultIcon = choice?.defaultIcon ?? null;

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      onClose={() => {
        opening.current++;
        choice?.trigger?.focus({ preventScroll: true });
      }}
      onClick={backdrop}
      className={cn(
        "m-auto w-[600px] overflow-hidden rounded-2xl border bg-background p-0 text-foreground shadow-[0_16px_60px_var(--color-dialog-shadow)] backdrop:bg-dialog-backdrop open:flex open:flex-col",
        // Centered in the safe area, clear of the notch and the home indicator.
        "inset-[env(safe-area-inset-top)_env(safe-area-inset-right)_env(safe-area-inset-bottom)_env(safe-area-inset-left)]",
        "max-h-[min(720px,calc(100dvh-40px-env(safe-area-inset-top)-env(safe-area-inset-bottom)))] max-w-[calc(100dvw-32px-env(safe-area-inset-left)-env(safe-area-inset-right))]",
        "upto-600px:max-h-[calc(100dvh-24px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] upto-600px:max-w-[calc(100dvw-24px-env(safe-area-inset-left)-env(safe-area-inset-right))]",
        "short:max-h-[calc(100dvh-16px-env(safe-area-inset-top)-env(safe-area-inset-bottom))]",
      )}
    >
      <header className="flex flex-none items-start justify-between gap-4 px-6 pt-[23px] pb-[18px] upto-600px:px-4 upto-600px:pt-[18px] upto-600px:pb-4 short:pt-3 short:pb-2">
        <div>
          <h2 id={titleId} className="mb-[5px] text-start text-[19px] font-semibold upto-600px:text-[17px]">
            {title}
          </h2>
          <p className="text-[13px] text-muted-foreground">{description}</p>
        </div>
        <button type="button" aria-label="Close icon picker" onClick={cancel} className="grid size-9 flex-none cursor-pointer place-items-center rounded-[9px] touch:size-11">
          <Xmark className="size-5" />
        </button>
      </header>

      {/* A label, so a tap anywhere on it reaches the field. */}
      <label className="mx-6 mb-4 flex flex-none cursor-text items-center gap-2.5 rounded-[9px] border px-3 py-2.5 focus-within:border-foreground focus-within:ring-1 focus-within:ring-foreground upto-600px:mx-4 short:mb-2">
        <Search className="size-[18px] flex-[0_0_18px] text-muted-foreground" />
        <input
          ref={searchBox}
          type="search"
          placeholder="Search icons, e.g. coffee or rocket"
          aria-label="Search icons"
          autoComplete="off"
          data-ember-preserve-selection
          onChange={(event) => find(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // Stages the first match without applying it, and doesn't send the form.
            event.preventDefault();
            if (matches[0]) setStaged(matches[0].name);
          }}
          className="w-full min-w-0 bg-transparent p-0 text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none touch:text-base"
        />
      </label>

      {/* Its tabs are 44px tall on touch screens. */}
      <div role="tablist" aria-label="Icon collection" onKeyDown={navigateCollections} className="mx-6 mb-4 flex flex-none gap-1 rounded-[9px] border bg-surface p-1 upto-600px:mx-4 short:mb-2">
        {ICON_COLLECTIONS.map((name) => (
          <button
            key={name}
            id={`${titleId}_${name}`}
            type="button"
            role="tab"
            aria-selected={name === collection}
            aria-controls={`${titleId}_results`}
            tabIndex={name === collection ? 0 : -1}
            onClick={() => showCollection(name)}
            className="min-h-9 flex-1 cursor-pointer rounded-md border border-transparent px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground aria-selected:border-border aria-selected:bg-background aria-selected:font-semibold aria-selected:text-foreground aria-selected:shadow-[0_1px_2px_#0001] upto-600px:min-h-10 touch:min-h-11"
          >
            {name}
          </button>
        ))}
      </div>

      {/* At least 150px of icons, but on a short screen, where that would push the footer off a phone in landscape. */}
      <div
        ref={browse}
        id={`${titleId}_results`}
        role="tabpanel"
        aria-labelledby={`${titleId}_${collection}`}
        className="min-h-[150px] flex-auto overflow-y-auto overscroll-contain px-6 pb-5 upto-600px:px-4 short:min-h-0"
      >
        <button
          type="button"
          aria-pressed={staged === null}
          onClick={() => setStaged(null)}
          className="group flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[9px] border bg-surface px-3 py-2.5 text-start text-foreground aria-pressed:border-foreground"
        >
          <RoomIcon icon={defaultIcon} size={24} className="w-[26px] text-center text-[23px] leading-none text-muted-foreground" />
          <span>Use default icon</span>
          <CheckCircle className="ms-auto size-[18px] flex-none opacity-0 group-aria-pressed:opacity-100" />
        </button>
        <p role="status" aria-live="polite" className="mt-[17px] mb-[11px] text-xs text-muted-foreground">
          {status === "loading" ? "Loading icons…" : status === "failed" ? "Icons couldn’t load. Try again; your current icon is unchanged." : resultsLabel(matches.length, shown.length, collection)}
        </p>
        <div
          ref={grid}
          role="group"
          aria-label={group}
          aria-busy={status === "loading" || undefined}
          onKeyDown={navigate}
          className="grid grid-cols-5 gap-1.5 upto-600px:grid-cols-3 upto-600px:gap-[5px]"
        >
          {shown.map((option) => {
            const label = displayLabel(option, context);
            return (
              <button
                key={option.name}
                type="button"
                data-icon={option.name}
                title={`${label}${label !== option.label ? ` (${option.label})` : ""} · ${option.collection}`}
                tabIndex={option.name === tabStop ? 0 : -1}
                aria-label={`Use ${label} icon${option.collection === "Iconoir" ? " from Iconoir" : ""}`}
                aria-pressed={option.name === staged}
                onClick={() => setStaged(option.name)}
                className="flex min-h-[66px] min-w-0 cursor-pointer flex-col items-center justify-center gap-[7px] rounded-[9px] border border-transparent bg-background px-[3px] pt-[9px] pb-[7px] text-foreground hover:bg-hover focus-visible:outline-offset-0 aria-pressed:border-foreground aria-pressed:bg-hover"
              >
                {/* The catalog's own markup, checked by catalog.test.ts. */}
                <span aria-hidden="true" className="flex [&>svg]:size-[23px]" dangerouslySetInnerHTML={{ __html: option.svg }} />
                <span className="line-clamp-2 min-h-[2.6em] w-full text-[11px] leading-[1.3] wrap-anywhere hyphens-auto text-muted-foreground">{label}</span>
              </button>
            );
          })}
        </div>
        {status === "ready" && shown.length < matches.length && (
          <button type="button" onClick={more} className={cn(BUTTON, "mt-4 w-full bg-surface p-[9px] text-[13px] touch:min-h-11")}>
            Show more icons
          </button>
        )}
        {status === "failed" && (
          <button type="button" onClick={() => void load()} className={cn(BUTTON, "mt-4 w-full bg-surface p-[9px] text-[13px] touch:min-h-11")}>
            Try again
          </button>
        )}
      </div>

      <footer className="flex flex-none items-center justify-between gap-4 border-t px-6 py-4 upto-600px:flex-col upto-600px:items-stretch upto-600px:gap-[13px] upto-600px:px-4 upto-600px:py-3.5 short:py-2">
        <span className="flex min-w-0 items-center gap-2.5 text-xs">
          <RoomIcon icon={staged ?? defaultIcon} size={21} className="flex flex-[0_0_22px] items-center justify-center text-2xl" />
          <span className="truncate">{staged ? iconLabel(staged, context) : choice?.defaultLabel}</span>
        </span>
        <div className="flex flex-none gap-2 upto-600px:justify-end">
          <button type="button" onClick={cancel} className={cn(BUTTON, FOOTER_BUTTON)}>
            Cancel
          </button>
          <button type="button" onClick={apply} className={cn(BUTTON, FOOTER_BUTTON, "border-transparent bg-foreground text-background hover:not-active:brightness-70")}>
            Use icon
          </button>
        </div>
      </footer>
    </dialog>
  );
}

interface IconTriggerProps {
  /** What the button's called, such as Choose room icon. */
  label: string;
  /** The icon chosen, drawn 23px wide. */
  preview: ReactNode;
  /** The button's two lines. */
  title: string;
  subtitle: string;
  disabled: boolean;
  onOpen: (trigger: HTMLButtonElement) => void;
}

/** The picker's button: the icon chosen and what it is, with a chevron, opening the dialog to choose another. */
export function IconTrigger({ label, preview, title, subtitle, disabled, onOpen }: IconTriggerProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="dialog"
      disabled={disabled}
      onClick={(event) => onOpen(event.currentTarget)}
      className="flex min-h-[74px] w-full cursor-pointer items-center gap-[13px] rounded-[10px] border bg-background px-[15px] py-[13px] text-start text-foreground enabled:hover:border-muted-foreground enabled:hover:bg-surface disabled:cursor-not-allowed"
    >
      <span className="flex size-[42px] flex-[0_0_42px] items-center justify-center rounded-[9px] bg-hover text-[26px] text-foreground">{preview}</span>
      <span className="grid min-w-0 flex-1 gap-[3px]">
        <strong className="text-sm font-medium wrap-anywhere">{title}</strong>
        <span className="text-xs text-muted-foreground">{subtitle}</span>
      </span>
      <NavArrowRight className="size-[18px] flex-[0_0_18px] text-muted-foreground" />
    </button>
  );
}

interface Props {
  /** The icon the form saves, or null for `#`. */
  icon: RoomIconName | null;
  /** Called with the icon chosen when it's applied. */
  onChange: (icon: RoomIconName | null) => void;
  /** While the form saves, which sends the icon shown when Save was pressed. */
  disabled?: boolean;
  /** Where the catalog comes from. */
  catalogUrl?: string;
}

/** The room's icon, with a button that opens the dialog to choose another. */
export function IconPicker({ icon, onChange, disabled = false, catalogUrl }: Props) {
  const dialog = useRef<IconDialogHandle>(null);
  return (
    <div className="mt-[22px] flex min-w-0 flex-col gap-[7px] text-start">
      <div>
        <span className="flex items-center gap-2 text-[13px] font-[550]">Room icon</span>
        <IconTrigger
          label="Choose room icon"
          preview={<RoomIcon icon={icon} size={23} />}
          title={roomIconLabel(icon)}
          subtitle="Choose from Lucide and Iconoir"
          disabled={disabled}
          onOpen={(trigger) => dialog.current?.open({ icon, defaultIcon: null, defaultLabel: "Default hashtag", apply: onChange, trigger })}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Shown beside this room for everyone in the workspace.</p>
      <IconDialog
        ref={dialog}
        context="room"
        title="Choose a room icon"
        description="Search by room name, like engineering, parenting, or book club."
        group="Room icons"
        catalogUrl={catalogUrl}
      />
    </div>
  );
}
