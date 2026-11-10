import type { Involvement, Room } from "@ember/protocol";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvolvementButton } from "./involvement-button";

const general: Room = { id: "general", name: "general", kind: "open", icon: null };
const direct: Room = { id: "direct-1", kind: "direct", members: [{ id: "ada", name: "Ada" }, { id: "grace", name: "Grace" }], activeAt: "2026-10-16T12:00:00.000Z" };

function renderBell(involvement: Involvement, room = general) {
  const [answered, onFailed] = [vi.fn(), vi.fn()];
  const askForRoom = vi.fn(() => answered);
  const view = render(<InvolvementButton room={room} involvement={involvement} askForRoom={askForRoom} onFailed={onFailed} />);
  return { ...view, askForRoom, answered, onFailed, bell: screen.getByRole("checkbox") };
}

/** What gives room `roomId` level `involvement` in the sidebar's list. */
const involved = (roomId: string, involvement: Involvement) => ({ type: "involved", roomId, involvement });

/** The levels the bell has sent, in order. */
const sent = () => vi.mocked(fetch).mock.calls.map(([input, init]) => [String(input), init?.method, JSON.parse(String(init?.body))]);

/** Answers the bell with the level it asked for. */
const answerAsAsked = () => vi.mocked(fetch).mockImplementation(async (_, init) => Response.json(JSON.parse(String(init?.body))));

beforeEach(() => {
  vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

describe("Notification levels", () => {
  it.each([
    ["mentions", "Notifying about @ mentions", "iconoir-at-sign"],
    ["everything", "Notifying about all messages", "iconoir-bell-notification-solid"],
    ["nothing", "Notifications are off", "iconoir-bell-off"],
    ["invisible", "Notifications are off and room invisible in sidebar", "iconoir-eye-closed"],
  ] as const)("is a checked checkbox named for what %s does, with its icon", (involvement, label, icon) => {
    const { bell: button } = renderBell(involvement);
    expect(button).toHaveAccessibleName(label);
    expect(button).toBeChecked();
    expect(button).not.toHaveAttribute("title");
    expect(button.querySelector("svg")).toHaveClass(icon);
  });

  it("goes round a room's levels, @mentions, all messages, off, then hidden, saving the next", async () => {
    answerAsAsked();
    const { bell, askForRoom, answered, rerender } = renderBell("mentions");
    for (const [involvement, next] of [
      ["mentions", "everything"],
      ["everything", "nothing"],
      ["nothing", "invisible"],
      ["invisible", "mentions"],
    ] as const) {
      rerender(<InvolvementButton room={general} involvement={involvement} askForRoom={askForRoom} onFailed={vi.fn()} />);
      await userEvent.click(bell);
      expect(answered).toHaveBeenLastCalledWith(involved("general", next));
    }
    expect(sent().map(([url, method, body]) => [url, method, body.involvement])).toEqual([
      ["/api/rooms/general/involvement", "PUT", "everything"],
      ["/api/rooms/general/involvement", "PUT", "nothing"],
      ["/api/rooms/general/involvement", "PUT", "invisible"],
      ["/api/rooms/general/involvement", "PUT", "mentions"],
    ]);
  });

  it("goes between all messages and off in a DM, and to all messages from any other level", async () => {
    answerAsAsked();
    for (const [involvement, next] of [
      ["everything", "nothing"],
      ["nothing", "everything"],
      ["mentions", "everything"],
      ["invisible", "everything"],
    ] as const) {
      const { bell, answered, unmount } = renderBell(involvement, direct);
      await userEvent.click(bell);
      expect(answered).toHaveBeenCalledWith(involved("direct-1", next));
      unmount();
    }
  });

  it("hands on the level the server answers, rather than the one it asked for", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ involvement: "invisible" }));
    const { bell, answered } = renderBell("mentions");
    await userEvent.click(bell);
    expect(answered).toHaveBeenCalledWith(involved("general", "invisible"));
  });

  it("asks for the room's place in the list as it's pressed, so a level another tab saves before the answer comes can overtake it", async () => {
    let answer!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { bell, askForRoom, answered } = renderBell("mentions");
    await userEvent.click(bell);
    expect(askForRoom).toHaveBeenCalledOnce();
    expect(answered).not.toHaveBeenCalled();

    await act(async () => answer(Response.json({ involvement: "everything" })));
    expect(answered).toHaveBeenCalledExactlyOnceWith(involved("general", "everything"));
  });

  it("is dimmed while it saves, keeping the keyboard's focus and ignoring presses", async () => {
    let answer!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { bell, answered } = renderBell("mentions");
    const user = userEvent.setup();

    bell.focus();
    await user.keyboard(" ");
    expect(bell).toHaveAttribute("aria-disabled", "true");
    expect(bell).toHaveClass("aria-disabled:opacity-50", "aria-disabled:pointer-events-none");
    await user.keyboard(" ");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bell).toHaveFocus();

    await act(async () => answer(Response.json({ involvement: "everything" })));
    expect(answered).toHaveBeenCalledOnce();
    expect(bell).not.toHaveAttribute("aria-disabled");
  });

  it("says why a save failed, and once it's gone, only that the session has ended", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: "Room not found or inaccessible" }, { status: 404 }));
    const shown = renderBell("mentions");
    await userEvent.click(shown.bell);
    expect(shown.onFailed).toHaveBeenCalledOnce();
    expect(shown.answered).not.toHaveBeenCalled();
    expect(shown.bell).not.toHaveAttribute("aria-disabled");
    shown.unmount();

    for (const [status, told] of [
      [500, false],
      [401, true],
    ] as const) {
      let answer!: (response: Response) => void;
      vi.mocked(fetch).mockReturnValue(new Promise((resolve) => (answer = resolve)));
      const { bell, onFailed, unmount } = renderBell("mentions");
      await userEvent.click(bell);
      unmount();
      await act(async () => answer(Response.json({ error: "No" }, { status })));
      expect(onFailed).toHaveBeenCalledTimes(told ? 1 : 0);
    }
  });
});
