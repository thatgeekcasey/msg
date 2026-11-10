import { describe, expect, it } from "vitest";
import picker from "@/components/icons/picker/catalog.json";
import { displayLabel, prepareCatalog, searchIcons, type Catalog, type CatalogIcon } from "./icon-catalog";

// The icon pickers' search, and how the catalog's orders rank what it finds.

const icon = (name: string, label: string, tags: string[], more: Partial<CatalogIcon> = {}) => ({ name, label, collection: "Lucide", tags, svg: "<svg></svg>", ...more }) as CatalogIcon;

const source = {
  icons: [
    icon("coffee", "Coffee", ["chat", "break", "social"]),
    icon("house", "House", ["home", "navigation"]),
    icon("iconoir:regular:chat-bubble", "Chat Bubble", ["chat", "introductions", "social"], { collection: "Iconoir" }),
    icon("life-buoy", "Life Buoy", ["help", "support"]),
  ],
  roomOrder: ["coffee", "iconoir:regular:chat-bubble", "life-buoy", "house"],
  navigationOrder: ["house", "life-buoy", "iconoir:regular:chat-bubble", "coffee"],
} as Catalog;

const names = (icons: CatalogIcon[]) => icons.map((icon) => icon.name);

describe("Room icon picker", () => {
  it("lists every icon in its context's order with nothing searched for", () => {
    const catalog = prepareCatalog(source);
    expect(names(searchIcons(catalog, "room", ""))).toEqual(source.roomOrder);
    expect(names(searchIcons(catalog, "navigation", " "))).toEqual(source.navigationOrder);
  });

  it("puts the icons named for a search before those only tagged for it, keeping their order", () => {
    const catalog = prepareCatalog(source);
    const found = (query: string) => names(searchIcons(catalog, "room", query));
    expect(found("introductions")).toEqual(["iconoir:regular:chat-bubble"]);
    expect(found("HELP")).toEqual(["life-buoy"]);
    expect(found("chat")).toEqual(["iconoir:regular:chat-bubble", "coffee"]);
    expect(found("social chat")).toEqual(["coffee", "iconoir:regular:chat-bubble"]);
    expect(found("chat-bubble")).toEqual(["iconoir:regular:chat-bubble"]);
    expect(found("not present")).toEqual([]);
  });

  it("matches a search of two letters or fewer to whole words only", () => {
    const icons = [
      icon("users-round", "Users Round", ["hr", "human resources", "people team"]),
      icon("chromecast", "Chromecast", ["streaming"]),
      icon("bird", "Bird", ["thrush", "birds"]),
      icon("network", "Network", ["it", "information technology"]),
      icon("guitar", "Guitar", ["music"]),
    ];
    const order = names(icons);
    const catalog = prepareCatalog({ icons, roomOrder: order, navigationOrder: order });
    expect(names(searchIcons(catalog, "room", "HR"))).toEqual(["users-round"]);
    expect(names(searchIcons(catalog, "room", "it"))).toEqual(["network"]);
  });

  it("searches one collection's icons in the same order", () => {
    const catalog = prepareCatalog(source);
    for (const context of ["room", "navigation"] as const) {
      for (const collection of ["Lucide", "Iconoir"] as const) {
        expect(searchIcons(catalog, context, "", collection)).toEqual(searchIcons(catalog, context, "").filter((icon) => icon.collection === collection));
        expect(searchIcons(catalog, context, "chat", collection).every((icon) => icon.collection === collection)).toBe(true);
      }
    }
    expect(searchIcons(catalog, "room", "coffee", "Iconoir")).toEqual([]);
    expect(searchIcons(catalog, "room", "introductions", "Lucide")).toEqual([]);
  });

  it("calls an icon what a room is for only among room icons, and finds it by either name", () => {
    const codeXml = icon("code-xml", "Code Xml", ["software"], { roomLabel: "Engineering" });
    const catalog = prepareCatalog({ icons: [codeXml], roomOrder: [codeXml.name], navigationOrder: [codeXml.name] });
    expect(displayLabel(codeXml, "room")).toBe("Engineering");
    expect(displayLabel(codeXml, "navigation")).toBe("Code Xml");
    for (const query of ["Engineering", "Code Xml", "code-xml", "software"]) expect(searchIcons(catalog, "room", query, "Lucide")[0]?.name).toBe("code-xml");
    expect(searchIcons(catalog, "room", "Engineering", "Iconoir")).toEqual([]);
  });

  it("finds the icon for what common rooms are for first, and none for an acronym's letters inside a word", () => {
    const catalog = prepareCatalog(picker as Catalog);
    const examples = [
      ["engineering", "code-xml"],
      ["company info", "iconoir:regular:building"],
      ["hr", "users-round"],
      ["product", "package"],
      ["parenting", "baby"],
      ["book club", "book-open"],
    ];
    expect(examples.map(([query]) => [query, searchIcons(catalog, "room", query!)[0]?.name])).toEqual(examples);
    expect(names(searchIcons(catalog, "room", "hr")).filter((name) => /chromecast|thrush/.test(name))).toEqual([]);
  });
});
