import type { RoomIconName } from "@ember/protocol";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import picker from "@/components/icons/picker/catalog.json";
import { useSelectOnEntry } from "@/hooks/use-select-on-entry";
import { IconPicker } from "./icon-picker";

// Part of the catalog, in its orders: the icons whose names start with "a", which none it suggests
// first for rooms does, and a few others, Iconoir's among them.
const OTHERS = ["coffee", "rocket", "gamepad", "gamepad-2", "gamepad-directional", "code-xml", "messages-circle", "house"];
const ICONOIR = ["iconoir:regular:megaphone", "iconoir:regular:building", "iconoir:regular:home", "iconoir:regular:coffee-cup", "iconoir:regular:gamepad", "iconoir:solid:heart"];
const icons = picker.icons.filter(({ name }) => name.startsWith("a") || OTHERS.includes(name) || ICONOIR.includes(name));
const included = (name: string) => icons.some((icon) => icon.name === name);
const catalog = { icons, roomOrder: picker.roomOrder.filter(included), navigationOrder: picker.navigationOrder.filter(included) };

// The picker keeps each catalog it loads for the page, so every test loads its own.
let catalogUrl: string;
beforeEach(() => {
  catalogUrl = `/catalog-${crypto.randomUUID()}.json`;
});
afterEach(() => vi.restoreAllMocks());

/** Answers the catalog with `responses` in turn, then with the icons. */
function serveCatalog(...responses: Array<() => Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => (responses.shift() ?? (() => Response.json(catalog)))());
}

function showPicker(icon: RoomIconName | null = null, { disabled = false } = {}) {
  const onChange = vi.fn();
  const onSubmit = vi.fn((event: Event) => event.preventDefault());
  render(
    <form onSubmit={(event) => onSubmit(event.nativeEvent)}>
      <IconPicker icon={icon} onChange={onChange} disabled={disabled} catalogUrl={catalogUrl} />
    </form>,
  );
  return { onChange, onSubmit, user: userEvent.setup() };
}

const trigger = () => screen.getByRole("button", { name: "Choose room icon" });
/** The picker, open or closed: closed, it has no name to be found by. */
const dialog = () => screen.getByRole("dialog", { hidden: true }) as HTMLDialogElement;
const grid = () => within(dialog()).getByRole("group", { name: "Room icons" });
/** The icons the grid shows, by name, in order. */
const shown = () => within(grid()).queryAllByRole("button").map((button) => button.dataset.icon);
const status = () => within(dialog()).getByRole("status");
const searchBox = () => within(dialog()).getByRole("searchbox", { name: "Search icons" });
const tab = (name: string) => within(dialog()).getByRole("tab", { name });
/** What the footer says Use icon would apply. */
const staged = () => dialog().querySelector("footer")!.textContent;

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  await waitFor(() => expect(within(dialog()).getByRole("group", { name: "Room icons" })).not.toHaveAttribute("aria-busy"));
}

describe("Room icon picker", () => {
  it("shows the room's icon on the button that opens the picker, named for what the room is for", () => {
    showPicker("coffee");
    expect(screen.getByText("Room icon")).toBeInTheDocument();
    expect(trigger()).toHaveTextContent("Break RoomChoose from Lucide and Iconoir");
    expect(trigger()).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger().querySelector('[data-icon="coffee"]')).toBeInTheDocument();
    expect(screen.getByText("Shown beside this room for everyone in the workspace.")).toBeInTheDocument();
  });

  it("credits Iconoir's icons, and says Default hashtag for a room with `#`", () => {
    showPicker("iconoir:regular:building");
    expect(trigger()).toHaveTextContent("Company Info · IconoirChoose from Lucide and Iconoir");
    expect(trigger().querySelector('[data-icon="iconoir:regular:building"]')).toBeInTheDocument();
    showPicker(null);
    expect(screen.getAllByRole("button", { name: "Choose room icon" })[1]).toHaveTextContent("#Default hashtagChoose from Lucide and Iconoir");
  });

  it("opens on every icon, as the catalog orders them for rooms, with the room's icon picked and the search box focused", async () => {
    const fetch = serveCatalog();
    const { user } = showPicker("rocket");
    await user.click(trigger());
    expect(screen.getByRole("dialog", { name: "Choose a room icon" })).toHaveAttribute("open");
    expect(screen.getByText("Search by room name, like engineering, parenting, or book club.")).toBeInTheDocument();
    expect(searchBox()).toHaveFocus();
    await waitFor(() => expect(status()).toHaveTextContent(`${icons.length} icons · 72 shown`));
    expect(fetch).toHaveBeenCalledWith(catalogUrl, { credentials: "same-origin" });
    expect(shown().slice(0, 5)).toEqual(["messages-circle", "iconoir:regular:megaphone", "code-xml", "iconoir:regular:building", "coffee"]);
    expect(within(grid()).getByRole("button", { name: "Use Launches icon", pressed: true })).toHaveAttribute("tabindex", "0");
    expect(within(grid()).getByRole("button", { name: "Use General icon" })).toHaveAttribute("tabindex", "-1");
    expect(staged()).toContain("Launches");
  });

  it("names each icon for what a room with it is for, as well as by its own name, crediting Iconoir's", async () => {
    serveCatalog();
    const { user } = showPicker();
    await open(user);
    const general = within(grid()).getByRole("button", { name: "Use General icon" });
    expect(general).toHaveTextContent(/^General$/);
    expect(general).toHaveAttribute("title", "General (Messages Circle) · Lucide");
    const announcements = within(grid()).getByRole("button", { name: "Use Announcements icon from Iconoir" });
    expect(announcements).toHaveAttribute("title", "Announcements (Megaphone) · Iconoir");
    // The catalog's own drawing.
    expect(announcements.querySelector("svg.iconoir")).toBeInTheDocument();
    expect(within(grid()).getByRole("button", { name: "Use Air Vent icon" })).toHaveAttribute("title", "Air Vent · Lucide");
  });

  it("says it's loading until the icons come", async () => {
    let answer = (_: Response) => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { user } = showPicker();
    await user.click(trigger());
    expect(status()).toHaveTextContent("Loading icons…");
    expect(grid()).toHaveAttribute("aria-busy", "true");
    await act(async () => answer(Response.json(catalog)));
    expect(status()).toHaveTextContent(`${icons.length} icons`);
  });

  it("finds the icons a search names before those whose names only hold its words, and by what rooms they suit", async () => {
    serveCatalog();
    const { user } = showPicker();
    await open(user);
    await user.type(searchBox(), "gamepad 2");
    expect(shown()).toEqual(["gamepad-2"]);
    expect(status()).toHaveTextContent(/^1 icon$/);
    await user.clear(searchBox());
    await user.type(searchBox(), "Gamepad");
    expect(shown()).toEqual(["gamepad", "iconoir:regular:gamepad", "gamepad-2", "gamepad-directional"]);
    await user.clear(searchBox());
    await user.type(searchBox(), "engineering");
    expect(shown()).toEqual(["code-xml"]);
    await user.type(searchBox(), "zz");
    expect(shown()).toEqual([]);
    expect(status()).toHaveTextContent("No icons match your search. Try another word.");
  });

  it("shows Lucide's or Iconoir's icons alone in their tabs, searching just them", async () => {
    serveCatalog();
    const { user } = showPicker();
    await open(user);
    expect(within(dialog()).getByRole("tablist", { name: "Icon collection" })).toBeInTheDocument();
    expect(tab("All")).toHaveAttribute("aria-selected", "true");
    const results = within(dialog()).getByRole("tabpanel", { name: "All" });
    expect(tab("All")).toHaveAttribute("aria-controls", results.id);

    await user.click(tab("Iconoir"));
    expect(tab("Iconoir")).toHaveAttribute("aria-selected", "true");
    expect(tab("All")).toHaveAttribute("aria-selected", "false");
    expect(within(dialog()).getByRole("tabpanel", { name: "Iconoir" })).toBe(results);
    expect(shown()).toEqual(catalog.roomOrder.filter((name) => name.startsWith("iconoir:")));
    expect(status()).toHaveTextContent(/^6 icons$/);
    await user.type(searchBox(), "coffee");
    expect(shown()).toEqual(["iconoir:regular:coffee-cup"]);

    await user.click(tab("Lucide"));
    expect(shown()).toEqual(["coffee"]);
    await user.type(searchBox(), "zz");
    expect(status()).toHaveTextContent("No icons match in Lucide. Try another word or choose All.");
  });

  it("moves between the tabs with the arrow keys, Home and End, choosing each", async () => {
    serveCatalog();
    const { user } = showPicker();
    await open(user);
    expect(tab("All")).toHaveAttribute("tabindex", "0");
    expect(tab("Lucide")).toHaveAttribute("tabindex", "-1");
    tab("All").focus();
    await user.keyboard("{ArrowRight}");
    expect(tab("Lucide")).toHaveFocus();
    expect(tab("Lucide")).toHaveAttribute("aria-selected", "true");
    expect(tab("Lucide")).toHaveAttribute("tabindex", "0");
    expect(shown().every((name) => !name!.startsWith("iconoir:"))).toBe(true);
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(tab("All")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(tab("Iconoir")).toHaveFocus();
    expect(tab("Iconoir")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(tab("All")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(tab("Iconoir")).toHaveFocus();
    expect(tab("Iconoir")).toHaveAttribute("aria-selected", "true");
  });

  it("opens on every icon of the tab last chosen again after a search", async () => {
    serveCatalog();
    const { user } = showPicker();
    await open(user);
    await user.type(searchBox(), "gamepad");
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));

    await open(user);
    expect(searchBox()).toHaveValue("");
    expect(status()).toHaveTextContent(`${icons.length} icons · 72 shown`);
    expect(shown().slice(0, 3)).toEqual(["messages-circle", "iconoir:regular:megaphone", "code-xml"]);
    await user.click(tab("Iconoir"));
    await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));

    await open(user);
    expect(tab("Iconoir")).toHaveAttribute("aria-selected", "true");
    expect(status()).toHaveTextContent(/^6 icons$/);
  });

  it("searches the tab chosen and the words typed while the icons loaded, once they come", async () => {
    let answer = (_: Response) => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { user } = showPicker();
    await user.click(trigger());
    await user.click(tab("Iconoir"));
    await user.type(searchBox(), "coffee");
    expect(status()).toHaveTextContent("Loading icons…");
    await act(async () => answer(Response.json(catalog)));
    expect(tab("Iconoir")).toHaveAttribute("aria-selected", "true");
    expect(shown()).toEqual(["iconoir:regular:coffee-cup"]);
    await user.clear(searchBox());
    expect(shown()).toEqual(catalog.roomOrder.filter((name) => name.startsWith("iconoir:")));
  });

  it("applies the icon picked only with Use icon, and hands focus back to the button", async () => {
    serveCatalog();
    const { onChange, onSubmit, user } = showPicker("coffee");
    await open(user);
    await user.click(within(grid()).getByRole("button", { name: "Use Company Info icon from Iconoir" }));
    expect(within(grid()).getByRole("button", { name: "Use Company Info icon from Iconoir" })).toHaveAttribute("aria-pressed", "true");
    expect(staged()).toContain("Company Info · Iconoir");
    expect(onChange).not.toHaveBeenCalled();

    await user.click(within(dialog()).getByRole("button", { name: "Use icon" }));
    expect(onChange).toHaveBeenCalledWith("iconoir:regular:building");
    expect(dialog()).not.toHaveAttribute("open");
    expect(trigger()).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("goes back to `#` with Use default icon", async () => {
    serveCatalog();
    const { onChange, user } = showPicker("coffee");
    await open(user);
    const useDefault = within(dialog()).getByRole("button", { name: "Use default icon" });
    expect(useDefault).toHaveAttribute("aria-pressed", "false");
    await user.click(useDefault);
    expect(useDefault).toHaveAttribute("aria-pressed", "true");
    expect(staged()).toContain("Default hashtag");
    await user.click(within(dialog()).getByRole("button", { name: "Use icon" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it.each([
    ["Cancel", () => fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }))],
    ["Close", () => fireEvent.click(within(dialog()).getByRole("button", { name: "Close icon picker" }))],
    ["Escape", () => fireEvent(dialog(), new Event("cancel", { cancelable: true }))],
    ["a click outside it", () => fireEvent.click(dialog(), { clientX: -10, clientY: -10 })],
  ])("keeps the icon as it was with %s, and picks it again next time", async (_, close) => {
    serveCatalog();
    const { onChange, user } = showPicker("coffee");
    await open(user);
    await user.click(within(grid()).getByRole("button", { name: "Use Launches icon" }));
    close();
    expect(dialog()).not.toHaveAttribute("open");
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveFocus();

    await open(user);
    expect(within(grid()).getByRole("button", { name: "Use Break Room icon" })).toHaveAttribute("aria-pressed", "true");
    expect(staged()).toContain("Break Room");
  });

  it("picks the first icon found with Enter, without applying it or sending the form", async () => {
    serveCatalog();
    const { onChange, onSubmit, user } = showPicker();
    await open(user);
    await user.type(searchBox(), "rock{Enter}");
    expect(staged()).toContain("Launches");
    expect(dialog()).toHaveAttribute("open");
    expect(onChange).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows 72 icons at a time, and Show more icons focuses the first it adds", async () => {
    serveCatalog();
    const { user } = showPicker();
    await open(user);
    expect(shown()).toHaveLength(72);
    await user.click(within(dialog()).getByRole("button", { name: "Show more icons" }));
    expect(shown()).toHaveLength(icons.length);
    expect(status()).toHaveTextContent(new RegExp(`^${icons.length} icons$`));
    expect(within(grid()).getAllByRole("button")[72]).toHaveFocus();
    expect(within(dialog()).queryByRole("button", { name: "Show more icons" })).not.toBeInTheDocument();
  });

  it("moves through the icons with the arrow keys, a row at a time up and down, and Home and End", async () => {
    // jsdom lays nothing out, so the grid says it has 5 columns, as it does on a wide screen.
    const getComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = getComputedStyle(element, pseudo);
      if (element.getAttribute("aria-label") === "Room icons") Object.defineProperty(style, "gridTemplateColumns", { value: Array(5).fill("106px").join(" ") });
      return style;
    });
    serveCatalog();
    const { user } = showPicker();
    await open(user);
    const button = (index: number) => within(grid()).getAllByRole("button")[index]!;
    button(0).focus();
    await user.keyboard("{ArrowRight}");
    expect(button(1)).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(button(6)).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(button(0)).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(button(0)).toHaveFocus();
    await user.keyboard("{End}");
    expect(button(71)).toHaveFocus();
    expect(button(71)).toHaveAttribute("tabindex", "0");
    expect(button(0)).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{Home}");
    expect(button(0)).toHaveFocus();
  });

  it("says when the icons can't load, keeping the room's icon, and tries again", async () => {
    serveCatalog(() => new Response("", { status: 500 }));
    const { onChange, user } = showPicker("coffee");
    await user.click(trigger());
    await waitFor(() => expect(status()).toHaveTextContent("Icons couldn’t load. Try again; your current icon is unchanged."));
    expect(shown()).toEqual([]);
    await user.click(within(dialog()).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(shown()).toHaveLength(72));
    expect(within(dialog()).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("loads the icons once for every picker on the page", async () => {
    const fetch = serveCatalog();
    const { user } = showPicker();
    await open(user);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await open(user);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("can't be opened while the form saves", () => {
    showPicker("coffee", { disabled: true });
    expect(trigger()).toBeDisabled();
  });
});

describe("Select a field's text on entry", () => {
  it("leaves what's in the search box alone when it's entered", async () => {
    serveCatalog();
    renderHook(() => useSelectOnEntry());
    const { user } = showPicker();
    await open(user);
    const search = searchBox();
    await user.type(search, "cof");
    await user.click(within(dialog()).getByRole("heading", { name: "Choose a room icon" }));
    await user.click(search);
    await user.keyboard("fee");
    expect(search).toHaveValue("coffee");
  });
});
