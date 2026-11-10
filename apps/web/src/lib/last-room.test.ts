import type { Room } from "@ember/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lastRoomVisited, rememberLastRoom } from "./last-room";

const room = (id: string): Room => ({ id, kind: "open", name: id, icon: null });
const rooms = [room("r1"), room("r2")];

describe("Go back to the last room", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is the room shown last, while it's one of your rooms", () => {
    rememberLastRoom("r2");
    expect(lastRoomVisited(rooms)).toEqual(room("r2"));
  });

  it("is your oldest room when none was shown, or the last one isn't yours any more", () => {
    expect(lastRoomVisited(rooms)).toEqual(room("r1"));
    rememberLastRoom("r3");
    expect(lastRoomVisited(rooms)).toEqual(room("r1"));
  });

  it("is none when you have no rooms", () => {
    rememberLastRoom("r1");
    expect(lastRoomVisited([])).toBeNull();
  });

  it("is written only when it changes", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    rememberLastRoom("r1");
    rememberLastRoom("r1");
    rememberLastRoom("r2");
    expect(setItem.mock.calls).toEqual([
      ["ember:last-room", "r1"],
      ["ember:last-room", "r2"],
    ]);
  });

  it("is your oldest room when the browser refuses storage", () => {
    const refused = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(refused);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(refused);
    expect(() => rememberLastRoom("r2")).not.toThrow();
    expect(lastRoomVisited(rooms)).toEqual(room("r1"));
  });
});
