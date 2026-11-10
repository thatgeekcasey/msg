import type { DirectoryUser, DirectRoom, User } from "@ember/protocol";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "@/components/ui/sheet";
import { PeopleContext, type People } from "@/hooks/use-directory";
import type { RoomAnswer } from "@/lib/room-list";
import { CONFIRM_DELETE_DIRECT, DirectSettingsPage } from "./direct-settings-page";

const ada = { id: "u1", name: "Ada Lovelace" };
const grace = { id: "u2", name: "Grace Hopper" };
const linus = { id: "u3", name: "Linus Torvalds" };
const activeAt = "2026-10-15T12:00:00.000Z";
const withGraceAndLinus: DirectRoom = { id: "d1", kind: "direct", members: [ada, grace, linus], activeAt };
const alone: DirectRoom = { id: "d2", kind: "direct", members: [ada], activeAt };

/** The page for `room` as Ada, at its address, with general the last room she visited. */
function showPage(room: DirectRoom, people: People = new Map()) {
  const [onLeft, onMissing, onFailed] = [vi.fn(), vi.fn(), vi.fn()];
  const askForRoom = () => (answer: RoomAnswer) => answer.type === "gone" && onLeft(answer.roomId);
  history.replaceState(null, "", `/rooms/directs/${room.id}/edit`);
  const { unmount } = render(
    <PeopleContext value={people}>
      <Sheet>
        <DirectSettingsPage room={room} me={ada} back="/rooms/general" askForRoom={askForRoom} onMissing={onMissing} onFailed={onFailed} />
      </Sheet>
    </PeopleContext>,
  );
  return { onLeft, onMissing, onFailed, unmount, user: userEvent.setup() };
}

/** The names on the cards, in order. */
const cards = () => [...document.querySelectorAll("main strong")].map((name) => name.textContent);

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("Group DMs and DM names", () => {
  it("shows a card for each of the others in the DM, titled for them, with Go Back to the last room visited", () => {
    showPage(withGraceAndLinus);
    expect(cards()).toEqual(["Grace Hopper", "Linus Torvalds"]);
    expect(document.title).toBe("Edit settings for Grace Hopper and Linus Torvalds");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Edit settings for Grace Hopper and Linus Torvalds");
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/rooms/general");
  });

  it("shows you alone in your DM with yourself", () => {
    showPage(alone);
    expect(cards()).toEqual(["Ada Lovelace"]);
    expect(document.title).toBe("Edit settings for Ada Lovelace");
  });

  it("names people as the people directory lists them now", () => {
    const renamed: DirectoryUser = { ...grace, name: "Grace Brewster Hopper", bio: null, role: "member", status: "active", avatarUrl: "/users/u2/avatar" };
    showPage(withGraceAndLinus, new Map([[grace.id, renamed]]));
    expect(cards()).toEqual(["Grace Brewster Hopper", "Linus Torvalds"]);
    expect(document.title).toBe("Edit settings for Grace Brewster Hopper and Linus Torvalds");
  });
});

describe("Delete a direct message", () => {
  const deleteButton = () => screen.getByRole("button", { name: "Delete Ping" });
  const confirmed = (answer: boolean) => vi.spyOn(window, "confirm").mockReturnValue(answer);
  const deleted = () => new Response(null, { status: 204 });

  /** Holds the deletion until the returned function answers it. */
  function holdDelete() {
    let answer = (_: Response) => {};
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    return (response: Response) => act(async () => answer(response));
  }

  it("offers Delete Ping with the trash can, to anyone in it", () => {
    showPage(withGraceAndLinus);
    const button = deleteButton();
    expect(button).toHaveTextContent(/^Ping$/);
    expect(button.querySelector("svg")).toHaveClass("iconoir-trash");
  });

  it("deletes the DM once you confirm, taking it out of the sidebar and going home", async () => {
    const confirm = confirmed(true);
    const answer = holdDelete();
    const { onLeft, onMissing, user } = showPage(withGraceAndLinus);
    await user.click(deleteButton());
    expect(confirm).toHaveBeenCalledExactlyOnceWith(CONFIRM_DELETE_DIRECT);
    expect(vi.mocked(fetch).mock.calls).toEqual([["/api/rooms/d1", expect.objectContaining({ method: "DELETE" })]]);
    // It can't be pressed again until it answers.
    expect(deleteButton()).toBeDisabled();

    await answer(deleted());
    expect(onLeft).toHaveBeenCalledExactlyOnceWith("d1");
    expect(location.pathname).toBe("/");
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("deletes nothing unless you confirm", async () => {
    confirmed(false);
    vi.spyOn(globalThis, "fetch");
    const { onLeft, user } = showPage(withGraceAndLinus);
    await user.click(deleteButton());
    expect(fetch).not.toHaveBeenCalled();
    expect(onLeft).not.toHaveBeenCalled();
    expect(deleteButton()).toBeEnabled();
  });

  it("goes home with the alert when the DM's already gone", async () => {
    confirmed(true);
    const answer = holdDelete();
    const { onLeft, onMissing, onFailed, user } = showPage(withGraceAndLinus);
    await user.click(deleteButton());
    await answer(Response.json({ error: "Room not found or inaccessible" }, { status: 404 }));
    expect(onMissing).toHaveBeenCalledOnce();
    expect(onFailed).not.toHaveBeenCalled();
    expect(onLeft).not.toHaveBeenCalled();
  });

  it("says why the DM wasn't deleted, and lets you try again", async () => {
    confirmed(true);
    const answer = holdDelete();
    const { onFailed, onLeft, user } = showPage(withGraceAndLinus);
    await user.click(deleteButton());
    await answer(Response.json({ error: "Service unavailable" }, { status: 503 }));
    expect(onFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 503 }));
    expect(onLeft).not.toHaveBeenCalled();
    expect(deleteButton()).toBeEnabled();
    expect(location.pathname).toBe("/rooms/directs/d1/edit");
  });

  it("takes the DM out of the sidebar when the answer comes after the page was left, staying where you are", async () => {
    confirmed(true);
    const answer = holdDelete();
    const { onLeft, user, unmount } = showPage(withGraceAndLinus);
    await user.click(deleteButton());
    unmount();
    history.replaceState(null, "", "/rooms/random");
    await answer(deleted());
    expect(onLeft).toHaveBeenCalledWith("d1");
    expect(location.pathname).toBe("/rooms/random");
  });

  it("reports only a session that's ended when a failure answers after the page was left", async () => {
    confirmed(true);
    const first = holdDelete();
    const left = showPage(withGraceAndLinus);
    await left.user.click(deleteButton());
    left.unmount();
    await first(Response.json({ error: "Room not found or inaccessible" }, { status: 404 }));
    expect(left.onMissing).not.toHaveBeenCalled();
    expect(left.onFailed).not.toHaveBeenCalled();

    const second = holdDelete();
    const signedOut = showPage(withGraceAndLinus);
    await signedOut.user.click(deleteButton());
    signedOut.unmount();
    await second(Response.json({ error: "Sign in to continue" }, { status: 401 }));
    expect(signedOut.onFailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 401 }));
  });
});

describe("Avatars open people's pages", () => {
  it("links each card's avatar to the person's page, titled with their name and bio, and goes there in place", async () => {
    const listed: DirectoryUser = { ...grace, bio: "Wrote the first compiler", role: "member", status: "active", avatarUrl: "/users/u2/avatar" };
    const { user } = showPage(withGraceAndLinus, new Map([[grace.id, listed]]));
    const link = screen.getByRole("link", { name: "Grace Hopper – Wrote the first compiler" });
    expect(link).toHaveAttribute("href", "/users/u2");
    expect(link.querySelector("img")).toHaveAttribute("loading", "lazy");
    expect(screen.getByRole("link", { name: "Linus Torvalds" })).toHaveAttribute("href", "/users/u3");
    await user.click(link);
    expect(location.pathname).toBe("/users/u2");
  });
});
