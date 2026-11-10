import type { DirectoryUser, Room, User } from "@ember/protocol";
import type { HuddlePerson } from "@ember/protocol/huddles";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleContext } from "@/hooks/use-directory";
import { showHuddle, type JoinedHuddle } from "@/lib/huddle-store";
import { HuddleBar } from "./huddle-bar";

const ada: User = { id: "ada", name: "Ada Lovelace" };
const sam: User = { id: "sam", name: "Sam Rivera" };
const priya: User = { id: "priya", name: "Priya Patel" };
const general: Room = { id: "general", name: "general", kind: "open", icon: null };
const inHuddle = (user: User, muted = false): HuddlePerson => ({ user, muted, audio: true });
const huddle = (changes: Partial<JoinedHuddle> = {}): JoinedHuddle => ({
  roomId: "general",
  connected: true,
  you: ada,
  people: [inHuddle(sam), inHuddle(ada)],
  muted: false,
  microphone: true,
  ...changes,
});

/** The bar of the huddle this tab is in, whose controls are `leave` and `setMuted`. */
function renderBar(joined: JoinedHuddle = huddle(), room: Room | null = general) {
  const leave = vi.fn();
  const setMuted = vi.fn();
  act(() => showHuddle(joined, { leave, setMuted }));
  const user = userEvent.setup();
  const view = render(<HuddleBar huddle={joined} room={room} meId="ada" />);
  return { leave, setMuted, user, ...view };
}

const bar = () => screen.getByRole("region");
const state = () => bar().querySelector("[aria-live]");

afterEach(() => {
  act(() => showHuddle(null));
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("The huddle bar", () => {
  it("names the huddle's room and who's in it, on a link to the room", async () => {
    const { user } = renderBar();
    expect(bar()).toHaveAccessibleName("Huddle in general");
    expect(state()).toHaveTextContent("Sam and you are in the huddle");
    const link = screen.getByRole("link", { name: "Huddle in general Sam and you are in the huddle" });
    expect(link).toHaveAttribute("href", "/rooms/general");
    await user.click(link);
    expect(location.pathname).toBe("/rooms/general");
  });

  it("says when nobody else is in it, and counts past three others", () => {
    const { rerender } = renderBar(huddle({ people: [inHuddle(ada)] }));
    expect(state()).toHaveTextContent("Just you in the huddle");
    const crowd = Array.from({ length: 5 }, (_, index) => inHuddle({ id: `u${index}`, name: `Person${index} Smith` }));
    rerender(<HuddleBar huddle={huddle({ people: [...crowd, inHuddle(ada)] })} room={general} meId="ada" />);
    expect(state()).toHaveTextContent("Person0, Person1, Person2, and 2 others are in the huddle");
  });

  it("says that it's connecting until the room lets the tab in, and reconnecting while its connection is down", () => {
    const { rerender } = renderBar(huddle({ connected: false, you: null, people: [] }));
    expect(state()).toHaveTextContent("Connecting…");
    rerender(<HuddleBar huddle={huddle({ connected: false })} room={general} meId="ada" />);
    expect(state()).toHaveTextContent("Reconnecting…");
    expect(state()).toHaveAttribute("aria-live", "polite");
  });

  it("is just Huddle once its room isn't among this person's", () => {
    renderBar(huddle(), null);
    expect(bar()).toHaveAccessibleName("Huddle");
  });

  it("names a DM by the others in it", () => {
    renderBar(huddle(), { id: "direct-1", kind: "direct", members: [ada, priya], activeAt: "2026-11-10T09:00:00.000Z" });
    expect(bar()).toHaveAccessibleName("Huddle in Priya Patel");
  });

  it("shows the first four faces, named as the directory has them now", () => {
    const renamed: DirectoryUser = { id: "sam", name: "Samuel Rivera", bio: null, role: "member", status: "active", avatarUrl: "/users/sam/avatar" };
    const crowd = Array.from({ length: 4 }, (_, index) => inHuddle({ id: `u${index}`, name: `Person ${index}` }));
    act(() => showHuddle(null));
    render(
      <PeopleContext value={new Map([[renamed.id, renamed]])}>
        <HuddleBar huddle={huddle({ people: [inHuddle(sam), ...crowd, inHuddle(ada)] })} room={general} meId="ada" />
      </PeopleContext>,
    );
    const faces = screen.getByTitle("Samuel Rivera, Person 0, Person 1, Person 2, Person 3, Ada Lovelace");
    expect(faces.querySelectorAll("img")).toHaveLength(4);
    expect(faces).toHaveAttribute("aria-hidden", "true");
    expect(state()).toHaveTextContent("Samuel, Person, Person, and 2 others are in the huddle");
  });
});

describe("The huddle bar's microphone", () => {
  it("mutes the microphone, filled in ink while it's on", async () => {
    const { setMuted, user } = renderBar();
    const mute = screen.getByRole("button", { name: "Mute microphone" });
    expect(mute).toHaveClass("bg-foreground", "text-background");
    await user.click(mute);
    expect(setMuted).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("unmutes it once it's muted", async () => {
    const { setMuted, user } = renderBar(huddle({ muted: true }));
    const unmute = screen.getByRole("button", { name: "Unmute microphone" });
    expect(unmute).toHaveClass("bg-hover");
    await user.click(unmute);
    expect(setMuted).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("has nothing to switch for someone listening only", () => {
    renderBar(huddle({ muted: true, microphone: false }));
    expect(screen.getByRole("button", { name: "No microphone" })).toBeDisabled();
  });

  it("names what it does and the keys that do it in a tooltip, and the keys for screen readers", async () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });
    const { user } = renderBar();
    const mute = screen.getByRole("button", { name: "Mute microphone" });
    expect(mute).toHaveAttribute("aria-keyshortcuts", "Meta+Shift+Space");
    await user.hover(mute);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Mute microphone⌘⇧Space");
  });
});

describe("Leaving a huddle from its bar", () => {
  it("leaves on Leave, the last of its buttons", async () => {
    const { leave, user } = renderBar();
    const buttons = screen.getAllByRole("button");
    expect(buttons.at(-1)).toHaveAccessibleName("Leave");
    await user.click(buttons.at(-1)!);
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
