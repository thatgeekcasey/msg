import { avatarSvg, type Account, type DirectoryUser } from "@ember/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountContext } from "@/hooks/use-account";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { PAUSE_CHOICES, pauseEnd, pauseEndLabel } from "@/lib/notifications-pause";
import { Rail, type Activity, type RailPage } from "./rail";
import { OpenSearchContext } from "./search-box";

const ada = { id: "u1", name: "Ada Lovelace", administrator: false };
const activityOff: Activity = { on: false, unread: 0, onToggle: () => {} };

/** The rail for the page `current` names, as `me` sees it, with `newRelease` out since this Ember's. */
const railAt = (current: RailPage, activity = activityOff, me = ada, onNewDirect = () => {}, newRelease: string | null = null) => (
  <Rail me={me} workspaceName="Analytical Engines" current={current} activity={activity} newRelease={newRelease} onNewDirect={onNewDirect} askForPause={() => () => {}} onFailed={() => {}} />
);

afterEach(() => history.replaceState(null, "", "/"));

describe("Rail", () => {
  it("puts Home, DMs, Activity, Search, Workspace, Pause notifications, appearance and your profile on the rail, leaving the arrows to the top bar", () => {
    render(railAt("home"));
    const rail = screen.getByRole("navigation", { name: "Workspace" });
    expect([...rail.querySelectorAll("a, button")].map((item) => item.getAttribute("aria-label") ?? item.textContent)).toEqual([
      "Ember home",
      "Home",
      "DMs",
      "Activity",
      "Search",
      "Workspace",
      "Pause notifications",
      "Appearance: System",
      "Your profile",
    ]);
    expect(within(rail).getByRole("link", { name: "Ember home" })).toHaveAttribute("href", "/");
    expect(within(rail).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(within(rail).getByRole("link", { name: "DMs" })).toHaveAttribute("href", "/rooms/directs/new");
    expect(within(rail).getByRole("link", { name: "Search" })).toHaveAttribute("href", "/searches");
    expect(within(rail).getByRole("link", { name: "Workspace" })).toHaveAttribute("href", "/account/edit");
    expect(within(rail).getByRole("link", { name: "Your profile" })).toHaveAttribute("href", "/users/me/profile");
  });

  it("links your avatar to your profile, titled with your name", async () => {
    render(railAt("home"));
    const profile = screen.getByRole("link", { name: "Your profile" });
    expect(profile).toHaveAttribute("title", "Ada Lovelace");
    await userEvent.click(profile);
    expect(location.pathname).toBe("/users/me/profile");
  });

  it("names the settings link Admin for administrators, and Workspace for everyone else", () => {
    const { rerender } = render(railAt("workspace", activityOff, { ...ada, administrator: true }));
    const settings = screen.getByRole("link", { name: "Admin" });
    expect(settings).toHaveAttribute("href", "/account/edit");
    expect(settings).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Workspace" })).not.toBeInTheDocument();
    rerender(railAt("workspace"));
    expect(screen.getByRole("link", { name: "Workspace" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("marks Admin with a dot while a newer release of Ember is out, which it says to screen readers", () => {
    const grace = { ...ada, administrator: true };
    const { rerender } = render(railAt("home", activityOff, grace, () => {}, "0.2"));
    const admin = screen.getByRole("link", { name: "Admin" });
    expect(admin).toHaveAccessibleDescription("Ember 0.2 is available");
    const dot = admin.lastElementChild;
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(dot).toHaveClass("absolute", "rounded-full", "border-2", "border-surface", "bg-foreground");
    rerender(railAt("home", activityOff, grace));
    expect(admin).not.toHaveAccessibleDescription();
    expect(admin.lastElementChild).toHaveTextContent("Admin");
  });

  it("marks Admin with a dot while reports are open too, saying how many", () => {
    const grace = { ...ada, administrator: true };
    const rail = (openReports: number, newRelease: string | null = null) => (
      <Rail
        me={grace}
        workspaceName="Analytical Engines"
        current="home"
        activity={activityOff}
        newRelease={newRelease}
        openReports={openReports}
        onNewDirect={() => {}}
        askForPause={() => () => {}}
        onFailed={() => {}}
      />
    );
    const { rerender } = render(rail(1));
    const admin = screen.getByRole("link", { name: "Admin" });
    expect(admin).toHaveAccessibleDescription("1 open report");
    expect(admin.lastElementChild).toHaveClass("absolute", "rounded-full", "bg-foreground");
    rerender(rail(3, "0.2"));
    expect(admin).toHaveAccessibleDescription("Ember 0.2 is available. 3 open reports");
    rerender(rail(0));
    expect(admin).not.toHaveAccessibleDescription();
  });

  it("titles the logo with the workspace's name", () => {
    render(railAt("home"));
    expect(screen.getByRole("link", { name: "Ember home" })).toHaveAttribute("title", "Analytical Engines");
  });

  it("marks the logo and Home at home, Home for a room, Workspace for its settings, your avatar for your profile, and nothing for a room's forms", () => {
    const { rerender } = render(railAt("home"));
    const current = () => screen.queryAllByRole("link", { current: "page" }).map((link) => link.getAttribute("aria-label") ?? link.textContent);
    expect(current()).toEqual(["Ember home", "Home"]);
    rerender(railAt("room"));
    expect(current()).toEqual(["Home"]);
    rerender(railAt("workspace"));
    expect(current()).toEqual(["Workspace"]);
    rerender(railAt("profile"));
    expect(current()).toEqual(["Your profile"]);
    rerender(railAt(null));
    expect(current()).toEqual([]);
  });

  it("shows the page a link names in place", async () => {
    render(railAt("home"));
    const length = history.length;
    await userEvent.click(screen.getByRole("link", { name: "Workspace" }));
    expect(location.pathname).toBe("/account/edit");
    expect(history.length).toBe(length + 1);
  });

  it("marks no page while Activity is on", () => {
    render(railAt("home", { ...activityOff, on: true }));
    expect(screen.queryAllByRole("link", { current: "page" })).toEqual([]);
  });

  it("draws Iconoir's icons, which the project's owner chose", () => {
    render(railAt("home"));
    const rail = screen.getByRole("navigation", { name: "Workspace" });
    const icons = Object.fromEntries(
      [...rail.querySelectorAll("a, button")].map((item) => [item.getAttribute("aria-label") ?? item.textContent, item.querySelector("svg")?.classList[0]]),
    );
    expect(icons).toEqual({
      "Ember home": undefined,
      Home: "iconoir-home",
      DMs: "iconoir-multi-bubble",
      Activity: "iconoir-bell",
      Search: "iconoir-search",
      Workspace: "iconoir-box",
      "Pause notifications": "iconoir-bell-off",
      "Appearance: System": "iconoir-computer",
      "Your profile": undefined,
    });
  });
});

describe("Search box", () => {
  it("has Search on a phone in landscape, which has no top bar and no drawer to search from, leaving it to the drawer's search field", () => {
    render(railAt("home"));
    const search = screen.getByRole("link", { name: "Search" });
    expect(search).toHaveClass("hidden", "md:no-top-bar:flex");
    expect(search).not.toHaveClass("max-md:flex");
  });

  it("has Search in the drawer too where the drawer holds the rail alone, with no search field", () => {
    render(<Rail me={ada} workspaceName="Analytical Engines" current="workspace" activity={activityOff} newRelease={null} onNewDirect={() => {}} searchInDrawer askForPause={() => () => {}} onFailed={() => {}} />);
    expect(screen.getByRole("link", { name: "Search" })).toHaveClass("hidden", "md:no-top-bar:flex", "max-md:flex");
  });

  it("opens the search box in place from Search, which a click with a modifier key leaves to the browser, marked while the search page shows", async () => {
    const openSearch = vi.fn();
    const { rerender } = render(<OpenSearchContext value={openSearch}>{railAt("home")}</OpenSearchContext>);
    const search = screen.getByRole("link", { name: "Search" });
    expect(search).toHaveAttribute("href", "/searches");
    expect(search).not.toHaveAttribute("aria-current");
    await userEvent.click(search);
    expect(openSearch).toHaveBeenCalledExactlyOnceWith({ opener: search });
    expect(location.pathname).toBe("/");

    openSearch.mockClear();
    expect(fireEvent.click(search, { metaKey: true })).toBe(true);
    expect(openSearch).not.toHaveBeenCalled();
    rerender(<OpenSearchContext value={openSearch}>{railAt("search")}</OpenSearchContext>);
    expect(screen.queryAllByRole("link", { current: "page" })).toEqual([search]);
  });
});

describe("New direct message dialog", () => {
  it("opens New direct message in place from DMs, which a click with a modifier key leaves to the browser", async () => {
    const onNewDirect = vi.fn();
    render(railAt("room", activityOff, ada, onNewDirect));
    const dms = screen.getByRole("link", { name: "DMs" });
    await userEvent.click(dms);
    expect(onNewDirect).toHaveBeenCalledExactlyOnceWith(dms);
    expect(location.pathname).toBe("/");

    onNewDirect.mockClear();
    const opened = fireEvent.click(dms, { ctrlKey: true });
    expect(opened).toBe(true);
    expect(onNewDirect).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/");
  });

  it("never marks DMs, whose address goes on to the last room visited", () => {
    render(railAt("room"));
    expect(screen.getByRole("link", { name: "DMs" })).not.toHaveAttribute("aria-current");
  });
});

describe("Activity filter", () => {
  it("toggles Activity and shows it pressed while it's on", async () => {
    const onToggle = vi.fn();
    const { rerender } = render(railAt("home", { ...activityOff, onToggle }));
    const activity = screen.getByRole("button", { name: "Activity" });
    expect(activity).toHaveAttribute("title", "Show unread conversations");
    expect(activity).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(activity);
    expect(onToggle).toHaveBeenCalledOnce();

    rerender(railAt("home", { ...activityOff, on: true, onToggle }));
    expect(activity).toHaveAttribute("aria-pressed", "true");
    expect(activity).toHaveClass("aria-pressed:bg-hover", "aria-pressed:text-foreground");
  });

  it("counts unread conversations in a pill at its corner, hidden at none", () => {
    const { rerender } = render(railAt("room", { ...activityOff, unread: 3 }));
    const activity = screen.getByRole("button", { name: "Activity" });
    expect(activity).toHaveAccessibleDescription("3 unread");
    const pill = within(activity).getByText("3");
    expect(pill).toHaveAttribute("aria-hidden", "true");
    expect(pill).toHaveClass("absolute", "h-[17px]", "min-w-[17px]", "border-2", "border-surface", "bg-foreground", "text-[10px]", "text-background");

    rerender(railAt("room", { ...activityOff, unread: 0 }));
    expect(activity).not.toHaveAttribute("aria-description");
    expect(activity).toHaveTextContent(/^Activity$/);
  });
});

describe("Initials avatars", () => {
  it("shows your avatar as your profile picture", () => {
    render(railAt("home"));
    const picture = screen.getByRole("link", { name: "Your profile" }).querySelector("img")!;
    expect(picture.src).toBe(`data:image/svg+xml;base64,${btoa(avatarSvg(ada.id, ada.name))}`);
  });
});

describe("Workspace logo", () => {
  it("shows Ember's flame, or the workspace's logo, filling a 56px square with rounded corners", () => {
    const account = { name: "Analytical Engines", tagline: "", hideTranslationButtons: true, customStyles: "", restrictRoomCreation: false, restrictChannelMentions: false, restrictEveryoneMention: false, warnBeforeNotifying: true, logo: null, customDomain: null, joinLink: true, openSignUp: false, memberfulJoin: false, memberfulSignIn: false, ssoJoin: false, ssoSignIn: false, emailDomainSignUp: false, emailDomains: [], navigationIcons: {}, huddles: false, huddleCameras: true, huddleScreens: true, huddleVideo: "hd" as const };
    const { rerender } = render(<AccountContext value={account}>{railAt("home")}</AccountContext>);
    const brand = screen.getByRole("link", { name: "Ember home" });
    expect(brand.querySelector("img")).toHaveAttribute("src", "/ember-icon.png");
    expect(brand).toHaveClass("size-14", "rounded-[10px]");
    expect(brand.querySelector("img")).toHaveClass("size-14", "rounded-[inherit]", "object-contain");

    rerender(<AccountContext value={{ ...account, logo: "/account/logo?v=20261017120000" }}>{railAt("home")}</AccountContext>);
    expect(brand.querySelector("img")).toHaveAttribute("src", "/account/logo?v=20261017120000");
    expect(brand.querySelector("img")).toHaveAttribute("alt", "");
    expect(brand.querySelector("img")).toHaveClass("size-14", "rounded-[inherit]", "object-cover");
    // On no background of its own.
    expect(brand).not.toHaveClass("bg-background");
  });
});

describe("Navigation icons", () => {
  it("draws the icons an administrator chose for its buttons, and Iconoir's for the rest", () => {
    const account: Account = {
      name: "Analytical Engines",
      tagline: "",
      hideTranslationButtons: true,
      customStyles: "",
      restrictRoomCreation: false,
      restrictChannelMentions: false,
      restrictEveryoneMention: false,
      warnBeforeNotifying: true,
      logo: null,
      customDomain: null,
      joinLink: true,
      openSignUp: false,
      memberfulJoin: false,
      memberfulSignIn: false,
      ssoJoin: false,
      ssoSignIn: false,
      emailDomainSignUp: false,
      emailDomains: [],
      navigationIcons: { home: "coffee", search: "iconoir:solid:heart" },
      huddles: false,
      huddleCameras: true,
      huddleScreens: true,
      huddleVideo: "hd",
    };
    render(<AccountContext value={account}>{railAt("home", activityOff, { ...ada, administrator: true })}</AccountContext>);
    const icon = (name: string) => screen.getByRole(name === "Activity" ? "button" : "link", { name }).querySelector("[data-icon], svg");
    expect(icon("Home")).toHaveAttribute("data-icon", "coffee");
    expect(icon("Home")).toHaveStyle({ maskImage: "url(/lucide/icons/coffee.svg)", width: "22px", height: "22px" });
    expect(icon("Search")).toHaveStyle({ maskImage: "url(/iconoir/icons/solid/heart.svg)" });
    expect(icon("DMs")).toHaveClass("iconoir-multi-bubble", "size-[22px]");
    expect(icon("Activity")).toHaveClass("iconoir-bell");
    expect(icon("Admin")).toHaveClass("iconoir-box");
  });
});

describe("Pause notifications", () => {
  /** Ada as the people directory lists her, paused until `pausedUntil` if it's given. */
  const listed = (pausedUntil?: string): DirectoryUser => ({ ...ada, bio: null, role: "member", status: "active", avatarUrl: "/users/t1/avatar?v=1", ...(pausedUntil && { pausedUntil }) });
  /** The rail, with the people directory listing `people`, saying what's saved by `onPaused`. */
  const railWith = (people: People, onPaused = vi.fn()) => (
    <PeopleContext value={people}>
      <Rail me={ada} workspaceName="Analytical Engines" current="home" activity={activityOff} newRelease={null} onNewDirect={() => {}} askForPause={() => onPaused} onFailed={() => {}} />
    </PeopleContext>
  );
  /** Answers each pause with Ada paused as it asks. */
  function pauses() {
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => Response.json({ user: listed((JSON.parse(init!.body as string) as { until: string | null }).until ?? undefined) }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  /** When the pause each call asked for ends, in milliseconds since the epoch. */
  const endsAsked = (fetch: ReturnType<typeof pauses>) => fetch.mock.calls.map(([, init]) => (JSON.parse(init!.body as string) as { until: string | null }).until);

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("pauses them for 30 minutes, 1 hour, 2 hours or until 9 AM tomorrow, as its menu offers, giving you as the directory then lists you", async () => {
    const fetch = pauses();
    const onPaused = vi.fn();
    render(railWith(new Map(), onPaused));
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Pause notifications" });
    expect(button.querySelector("svg")).toHaveClass("iconoir-bell-off", "size-[18px]");

    await user.click(button);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["30 minutes", "1 hour", "2 hours", "Until tomorrow"]);
    const asked = Date.now();
    await user.click(screen.getByRole("menuitem", { name: "1 hour" }));
    await waitFor(() => expect(onPaused).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/users/me/notifications-pause", expect.objectContaining({ method: "PUT" }));
    const [hour] = endsAsked(fetch);
    expect(Date.parse(hour!) - asked).toBeGreaterThanOrEqual(60 * 60_000);
    expect(Date.parse(hour!) - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    expect(onPaused).toHaveBeenCalledWith(listed(hour!));

    await user.click(button);
    await user.click(screen.getByRole("menuitem", { name: "Until tomorrow" }));
    await waitFor(() => expect(onPaused).toHaveBeenCalledTimes(2));
    expect(endsAsked(fetch)[1]).toBe(pauseEnd(PAUSE_CHOICES[3]!).toISOString());
  });

  it("says until when they're paused, with Resume notifications first, and marks your picture with a half-moon until the pause ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetch = pauses();
    const until = new Date(Date.now() + 90_000).toISOString();
    render(railWith(new Map([[ada.id, listed(until)]])));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const button = screen.getByRole("button", { name: `Notifications paused until ${pauseEndLabel(new Date(until))}` });
    const moon = () => screen.getByRole("link", { name: "Your profile" }).querySelector("[data-paused] svg");
    expect(moon()).toHaveClass("iconoir-half-moon", "text-foreground");

    await user.click(button);
    expect(screen.getByRole("menu")).toHaveTextContent(`Paused until ${pauseEndLabel(new Date(until))}`);
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Resume notifications", "30 minutes", "1 hour", "2 hours", "Until tomorrow"]);
    await user.click(screen.getByRole("menuitem", { name: "Resume notifications" }));
    await waitFor(() => expect(endsAsked(fetch)).toEqual([null]));

    // The directory still lists the pause, which ends by itself.
    act(() => vi.advanceTimersByTime(90_000));
    expect(screen.getByRole("button", { name: "Pause notifications" })).toBeInTheDocument();
    expect(moon()).toBeNull();
  });
});
