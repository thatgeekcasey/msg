import type { RoomIconName } from "@ember/protocol";
import type { IconContext } from "@/components/icons/room-icon-label";

// The icon pickers' catalog and its search: the catalog's orders do the editorial ranking, and a search
// keeps them, putting the icons named for it before those only tagged for it.

/** Where an icon comes from, or, for the picker's tabs, either. */
export type IconCollection = "All" | "Lucide" | "Iconoir";

export const ICON_COLLECTIONS: IconCollection[] = ["All", "Lucide", "Iconoir"];

/** An icon as the catalog has it. */
export interface CatalogIcon {
  name: RoomIconName;
  label: string;
  /** For an icon suggested for a room, what the room is for, such as Engineering for code-xml. */
  roomLabel?: string;
  collection: Exclude<IconCollection, "All">;
  tags: string[];
  /** Its drawing, checked by catalog.test.ts. */
  svg: string;
}

/** The picker's catalog (icons/picker/catalog.json): every icon, by name, and an order of them for each context. */
export interface Catalog {
  icons: CatalogIcon[];
  roomOrder: RoomIconName[];
  navigationOrder: RoomIconName[];
}

interface SearchableIcon extends CatalogIcon {
  searchName: string;
  searchRoomName: string;
  searchTags: string;
}

/** The catalog ready to search: each context's order, of every icon and of each collection's. */
export type PreparedCatalog = Record<IconContext, Record<IconCollection, SearchableIcon[]>>;

/** Text as search compares it: lowercase words between spaces, so a short term can match a whole word. */
const searchable = (text: string) => ` ${text.toLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** Whether `text` holds `term`, as a whole word when it's two letters or fewer, so "hr" doesn't find thrush. */
const includesTerm = (text: string, term: string) => text.includes(term.length <= 2 ? ` ${term} ` : term);

/** What the picker calls an icon: for a room, what the room is for, where the catalog suggests it for one. */
export const displayLabel = (icon: CatalogIcon, context: IconContext) => (context === "room" && icon.roomLabel) || icon.label;

export function prepareCatalog(catalog: Catalog): PreparedCatalog {
  const icons = new Map(
    catalog.icons.map((icon): [RoomIconName, SearchableIcon] => [
      icon.name,
      {
        ...icon,
        searchName: searchable(`${icon.name} ${icon.label}`),
        searchRoomName: searchable(`${icon.name} ${icon.label} ${icon.roomLabel ?? ""}`),
        searchTags: searchable(icon.tags.join(" ")),
      },
    ]),
  );
  const ordered = (order: RoomIconName[]): Record<IconCollection, SearchableIcon[]> => {
    const all = order.map((name) => icons.get(name)!);
    return { All: all, Lucide: all.filter((icon) => icon.collection === "Lucide"), Iconoir: all.filter((icon) => icon.collection === "Iconoir") };
  };
  return { room: ordered(catalog.roomOrder), navigation: ordered(catalog.navigationOrder) };
}

/**
 * The icons of `collection` that match every word of `query`, in `context`'s order: first those the
 * search names exactly, then those whose names hold every word, then those whose tags hold the rest.
 * With no words, the whole order.
 */
export function searchIcons(catalog: PreparedCatalog, context: IconContext, query: string, collection: IconCollection = "All"): CatalogIcon[] {
  const ordered = catalog[context][collection];
  const phrase = searchable(query).trim();
  const terms = phrase.split(/\s+/).filter(Boolean);
  if (!terms.length) return ordered;
  const exact: CatalogIcon[] = [];
  const named: CatalogIcon[] = [];
  const tagged: CatalogIcon[] = [];
  for (const icon of ordered) {
    const name = context === "room" ? icon.searchRoomName : icon.searchName;
    if (displayLabel(icon, context).toLowerCase() === phrase || icon.label.toLowerCase() === phrase || icon.name === query.trim().toLowerCase()) exact.push(icon);
    else if (terms.every((term) => includesTerm(name, term))) named.push(icon);
    else if (terms.every((term) => includesTerm(name, term) || includesTerm(icon.searchTags, term))) tagged.push(icon);
  }
  return [...exact, ...named, ...tagged];
}
