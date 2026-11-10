import type { Room } from "@ember/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlashProvider } from "@/components/flash";
import { Sheet } from "@/components/ui/sheet";
import { leave, navigate, useRoute } from "@/hooks/use-route";
import { ApiError } from "@/lib/api";
import { NewRoomPage } from "./new-room-page";

const ada = { id: "u1", name: "Ada Lovelace" };
const grace = { id: "u2", name: "Grace Hopper" };
const linus = { id: "u3", name: "Linus Torvalds" };

/** Answers the people for the form, or `formRefusal`, then `created` (or `refusal`) for a new room. */
function serve({ created, refusal, formRefusal }: { created?: Room; refusal?: { status: number; error: string }; formRefusal?: { status: number; error: string } } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (init?.method === "POST") return refusal ? Response.json({ error: refusal.error }, { status: refusal.status }) : Response.json({ room: created }, { status: 201 });
    expect(input).toBe("/api/rooms/new");
    return formRefusal ? Response.json({ error: formRefusal.error }, { status: formRefusal.status }) : Response.json({ people: [ada, grace, linus] });
  });
}

/** Answers the people for the form, and holds the new room until the returned function answers it. */
function holdCreation() {
  let answer = (_: Response) => {};
  vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
    init?.method === "POST" ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(Response.json({ people: [ada, grace, linus] })),
  );
  return (response: Response) => act(async () => answer(response));
}

/** The page, at the form its address names, as the workspace shows it. */
function NewRoomRoute(props: { onCreated: (room: Room) => void; onFailed: (error: unknown) => void }) {
  const route = useRoute();
  return route.page === "new-room" ? <NewRoomPage access={route.access} me={ada} {...props} /> : null;
}

function showPage(path = "/rooms/opens/new") {
  const [onCreated, onFailed] = [vi.fn(), vi.fn()];
  history.replaceState(null, "", path);
  render(
    <FlashProvider workspace>
      <Sheet>
        <NewRoomRoute onCreated={onCreated} onFailed={onFailed} />
      </Sheet>
    </FlashProvider>,
  );
  return { onCreated, onFailed, user: userEvent.setup() };
}

const roomName = () => screen.findByRole("textbox", { name: "Room name" });
const rowOf = (name: string) => screen.getByText(name).closest("li")!;
const hasCheckMark = (name: string) => rowOf(name).querySelector("svg.iconoir-check-circle") !== null;
/** The names listed, in order, not counting the avatars' initials. */
const names = () => screen.getAllByRole("listitem").map((row) => row.querySelector("strong")!.textContent);
const asking = () => screen.queryByRole("dialog", { name: "Unsaved Changes" });
const posted = () => JSON.parse(vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST")![1]!.body as string) as unknown;

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("Create an open room", () => {
  it("reads New room, prefilled, with Go Back to community settings' rooms", async () => {
    serve();
    showPage();
    expect(document.title).toBe("New chat room");
    expect(screen.getByRole("heading", { level: 1, name: "New room" })).toBeInTheDocument();
    expect(screen.getByText("Create a place for a team, topic, or project.")).toBeInTheDocument();
    expect(await roomName()).toHaveValue("New room");
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/account/edit#channel-settings");
  });

  it("lists everyone with a check mark under Everyone, which is on", async () => {
    serve();
    showPage();
    await roomName();
    expect(screen.getByRole("switch", { name: "Give only some access to this room" })).toBeChecked();
    expect(names()).toEqual(["Everyone", "Ada Lovelace", "Grace Hopper", "Linus Torvalds"]);
    for (const person of [ada, grace, linus]) {
      expect(hasCheckMark(person.name)).toBe(true);
      expect(within(rowOf(person.name)).queryByRole("switch")).not.toBeInTheDocument();
    }
  });

  it("creates an open room with the name given", async () => {
    const created = { id: "design", name: "Design", kind: "open", icon: null } satisfies Room;
    serve({ created });
    const { onCreated, user } = showPage();
    await user.clear(await roomName());
    await user.type(await roomName(), "Design{Enter}");
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(posted()).toEqual({ kind: "open", name: "Design", icon: "" });
    expect(location.pathname).toBe("/rooms/design");
  });

  it("creates the room with the icon chosen", async () => {
    const ROCKET = { name: "rocket", label: "Rocket", roomLabel: "Launches", collection: "Lucide", tags: ["launches"], svg: "<svg></svg>" };
    const created = { id: "design", name: "New room", kind: "open", icon: "rocket" } satisfies Room;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("catalog.json")) return Response.json({ icons: [ROCKET], roomOrder: ["rocket"], navigationOrder: ["rocket"] });
      return init?.method === "POST" ? Response.json({ room: created }, { status: 201 }) : Response.json({ people: [ada, grace, linus] });
    });
    const { onCreated, user } = showPage();
    expect(await screen.findByRole("button", { name: "Choose room icon" })).toHaveTextContent("Default hashtag");
    await user.click(screen.getByRole("button", { name: "Choose room icon" }));
    await user.click(await screen.findByRole("button", { name: "Use Launches icon" }));
    await user.click(screen.getByRole("button", { name: "Use icon" }));
    expect(screen.getByRole("button", { name: "Choose room icon" })).toHaveTextContent("Launches");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(posted()).toEqual({ kind: "open", name: "New room", icon: "rocket" });
  });

  it("lists a room whose answer comes after the page was left, without taking over the page shown then", async () => {
    const created = { id: "design", name: "Design", kind: "open", icon: null } satisfies Room;
    const answer = holdCreation();
    const { onCreated, user } = showPage();
    await user.click(await screen.findByRole("button", { name: "Save" }));
    // Leaving for workspace settings, then opening New room again, starts a new form.
    act(() => navigate("/account/edit"));
    act(() => navigate("/rooms/opens/new"));
    await answer(Response.json({ room: created }, { status: 201 }));
    expect(onCreated).toHaveBeenCalledWith(created);
    expect(location.pathname).toBe("/rooms/opens/new");
  });

  it("drops a failure that answers after the page was left", async () => {
    const answer = holdCreation();
    const { onFailed, user } = showPage();
    await user.click(await screen.findByRole("button", { name: "Save" }));
    act(() => navigate("/account/edit"));
    await answer(Response.json({ error: "Service unavailable" }, { status: 503 }));
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("still reports a session that's ended, though the page was left before the answer", async () => {
    const answer = holdCreation();
    const { onFailed, user } = showPage();
    await user.click(await screen.findByRole("button", { name: "Save" }));
    act(() => navigate("/account/edit"));
    await answer(Response.json({ error: "Sign in to continue" }, { status: 401 }));
    expect(onFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401 }));
  });

  it("says why a room wasn't created, and lets you try again", async () => {
    serve({ refusal: { status: 422, error: "Name must be 1 to 100 characters" } });
    const { onCreated, onFailed, user } = showPage();
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 422, message: "Name must be 1 to 100 characters" })));
    expect(onFailed.mock.calls[0]![0]).toBeInstanceOf(ApiError);
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("says when it can't load the form", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    const { onFailed } = showPage();
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.any(TypeError)));
  });

  it("reports only a session that's ended when the form answers after the page was left", async () => {
    const answers: ((response: Response) => void)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const { onFailed } = showPage();
    act(() => navigate("/account/edit"));
    act(() => navigate("/rooms/opens/new"));
    act(() => navigate("/account/edit"));
    await act(async () => answers[0]!(Response.json({ error: "Service unavailable" }, { status: 503 })));
    expect(onFailed).not.toHaveBeenCalled();
    await act(async () => answers[1]!(Response.json({ error: "Sign in to continue" }, { status: 401 })));
    expect(onFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401 }));
  });
});

describe("Only administrators create rooms (setting)", () => {
  const ONLY_ADMINISTRATORS = "Only administrators can create rooms";

  it("sends anyone but an administrator to Rooms and permissions, saying why, while only they can create rooms", async () => {
    serve({ formRefusal: { status: 403, error: ONLY_ADMINISTRATORS } });
    const { onFailed } = showPage("/rooms/closeds/new");
    expect(await screen.findByRole("alert")).toHaveTextContent(ONLY_ADMINISTRATORS);
    expect(location.pathname + location.hash).toBe("/account/edit#channel-settings");
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("stays where it was sent when the refusal comes after the page was left", async () => {
    let answer = (_: Response) => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { onFailed } = showPage();
    act(() => navigate("/rooms/general"));
    await act(async () => answer(Response.json({ error: ONLY_ADMINISTRATORS }, { status: 403 })));
    expect(location.pathname).toBe("/rooms/general");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says why a room wasn't created once only administrators can create them, keeping the form", async () => {
    serve({ refusal: { status: 403, error: ONLY_ADMINISTRATORS } });
    const { onFailed, user } = showPage();
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 403, message: ONLY_ADMINISTRATORS })));
    expect(location.pathname).toBe("/rooms/opens/new");
    expect(await roomName()).toHaveValue("New room");
  });
});

describe("Create a private room", () => {
  it("turns Everyone off for the private form in place, keeping the name", async () => {
    serve();
    const { user } = showPage();
    await user.clear(await roomName());
    await user.type(await roomName(), "Leads");
    const length = history.length;
    await user.click(screen.getByRole("switch", { name: "Give only some access to this room" }));
    expect(location.pathname).toBe("/rooms/closeds/new");
    expect(history.length).toBe(length);
    expect(await roomName()).toHaveValue("Leads");
    expect(screen.getByRole("switch", { name: "Give everyone access to this room" })).not.toBeChecked();
  });

  it("lists you with a check mark and everyone else with a switch, off", async () => {
    serve();
    showPage("/rooms/closeds/new");
    await roomName();
    expect(hasCheckMark(ada.name)).toBe(true);
    expect(within(rowOf(ada.name)).queryByRole("switch")).not.toBeInTheDocument();
    for (const person of [grace, linus]) {
      expect(screen.getByRole("switch", { name: `Give ${person.name} access to this room` })).not.toBeChecked();
    }
  });

  it("creates a private room with you and the people chosen", async () => {
    const created = { id: "leads", name: "Leads", kind: "closed", icon: null } satisfies Room;
    serve({ created });
    const { onCreated, user } = showPage("/rooms/closeds/new");
    await user.clear(await roomName());
    await user.type(await roomName(), "Leads");
    await user.click(screen.getByRole("switch", { name: `Give ${linus.name} access to this room` }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    expect(posted()).toEqual({ kind: "closed", name: "Leads", icon: "", memberIds: [ada.id, linus.id] });
  });

  it("keeps who's chosen when Everyone goes on and off again", async () => {
    serve();
    const { user } = showPage("/rooms/closeds/new");
    await user.click(await screen.findByRole("switch", { name: `Give ${grace.name} access to this room` }));
    await user.click(screen.getByRole("switch", { name: "Give everyone access to this room" }));
    expect(location.pathname).toBe("/rooms/opens/new");
    await user.click(screen.getByRole("switch", { name: "Give only some access to this room" }));
    expect(screen.getByRole("switch", { name: `Give ${grace.name} access to this room` })).toBeChecked();
  });
});

describe("Unsaved changes guard", () => {
  it("leaves a form as it opened without asking", async () => {
    serve();
    showPage();
    await roomName();
    act(() => navigate("/account/edit"));
    expect(location.pathname).toBe("/account/edit");
  });

  it("asks before leaving anything filled in, and leaves once it's discarded", async () => {
    serve();
    const { onCreated, user } = showPage();
    await user.type(await roomName(), " for design");
    act(() => navigate("/account/edit"));
    expect(await screen.findByRole("dialog", { name: "Unsaved Changes" })).toBeInTheDocument();
    expect(location.pathname).toBe("/rooms/opens/new");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(location.pathname).toBe("/account/edit");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("counts the private form and the people chosen, but asks nothing of the Everyone switch", async () => {
    serve();
    const { user } = showPage();
    await user.click(await screen.findByRole("switch", { name: "Give only some access to this room" }));
    expect(location.pathname).toBe("/rooms/closeds/new");
    expect(asking()).not.toBeInTheDocument();
    act(() => navigate("/account/edit"));
    await user.click(await screen.findByRole("button", { name: "Keep editing" }));

    await user.click(screen.getByRole("switch", { name: "Give everyone access to this room" }));
    act(() => navigate("/account/edit"));
    expect(location.pathname).toBe("/account/edit");
    expect(asking()).not.toBeInTheDocument();
  });

  it("creates the room from the dialog, then goes where you were going", async () => {
    const created = { id: "leads", name: "Leads", kind: "closed", icon: null } satisfies Room;
    serve({ created });
    const { onCreated, user } = showPage("/rooms/closeds/new");
    await user.click(await screen.findByRole("switch", { name: `Give ${grace.name} access to this room` }));
    await user.clear(await roomName());
    await user.type(await roomName(), "Leads");
    act(() => navigate("/account/edit"));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(location.pathname).toBe("/account/edit"));
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(created);
    expect(posted()).toEqual({ kind: "closed", name: "Leads", icon: "", memberIds: [ada.id, grace.id] });
  });

  it("shows the room the dialog's Save made when signing out then fails, as its own Save does", async () => {
    const created = { id: "design", name: "Design", kind: "open", icon: null } satisfies Room;
    serve({ created });
    const { onCreated, user } = showPage();
    await user.clear(await roomName());
    await user.type(await roomName(), "Design");
    const signOut = vi.fn(async () => false);
    act(() => leave(signOut));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(location.pathname).toBe("/rooms/design"));
    expect(signOut).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(created);
    expect(screen.queryByRole("textbox", { name: "Room name" })).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("makes the room once when its own Save is pressed while the dialog's Save goes on", async () => {
    const created = { id: "design", name: "Design", kind: "open", icon: null } satisfies Room;
    serve({ created });
    const { onCreated, user } = showPage();
    await user.type(await roomName(), " team");
    let signedOut = (_: boolean) => {};
    const signOut = vi.fn(() => new Promise<boolean>((resolve) => (signedOut = resolve)));
    act(() => leave(signOut));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    // While signing out is under way, the form's Save shows the room made.
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(location.pathname).toBe("/rooms/design");
    await act(async () => signedOut(true));
    expect(onCreated).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("stays on a page opened while signing out after the dialog's Save, should signing out then fail", async () => {
    serve({ created: { id: "design", name: "Design", kind: "open", icon: null } });
    const { user } = showPage();
    await user.type(await roomName(), " team");
    let signedOut = (_: boolean) => {};
    const signOut = vi.fn(() => new Promise<boolean>((resolve) => (signedOut = resolve)));
    act(() => leave(signOut));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledOnce());
    act(() => navigate("/account/edit"));
    await act(async () => signedOut(false));
    expect(location.pathname).toBe("/account/edit");
  });
});
