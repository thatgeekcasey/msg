import type { DirectRoom, User } from "@ember/protocol";
import { describe, expect, it } from "vitest";
import { membersShown, roomName, toSentence } from "./directs";

const [ada, grace, linus, alan]: User[] = ["Ada", "Grace", "Linus", "Alan"].map((name, i) => ({ id: `u${i + 1}`, name }));
const direct = (...members: User[]): DirectRoom => ({ id: "d1", kind: "direct", members, activeAt: "2026-10-15T12:00:00.000Z" });
const nameOf = (user: User) => user.name;

describe("Group DMs and DM names", () => {
  it("joins names as Rails' to_sentence does", () => {
    expect(toSentence([])).toBe("");
    expect(toSentence(["Ada"])).toBe("Ada");
    expect(toSentence(["Ada", "Grace"])).toBe("Ada and Grace");
    expect(toSentence(["Ada", "Grace", "Linus"])).toBe("Ada, Grace, and Linus");
    expect(toSentence(["Ada", "Grace", "Linus", "Alan"])).toBe("Ada, Grace, Linus, and Alan");
  });

  it("names a DM after the others in it, in the order it lists them, or after you when it's only you", () => {
    expect(roomName(direct(ada!, grace!), ada!.id, nameOf)).toBe("Grace");
    expect(roomName(direct(ada!, grace!, linus!, alan!), grace!.id, nameOf)).toBe("Ada, Linus, and Alan");
    expect(roomName(direct(ada!), ada!.id, nameOf)).toBe("Ada");
    expect(roomName(direct(ada!, grace!), ada!.id, (user) => (user.id === grace!.id ? "Grace Hopper" : user.name))).toBe("Grace Hopper");
  });

  it("names any other room by its own name", () => {
    expect(roomName({ id: "r1", kind: "open", name: "general", icon: null }, ada!.id, nameOf)).toBe("general");
  });

  it("shows the others in a DM, or you alone in your DM with yourself", () => {
    expect(membersShown(direct(ada!, grace!, linus!), grace!.id)).toEqual([ada, linus]);
    expect(membersShown(direct(ada!), ada!.id)).toEqual([ada]);
  });
});
