import type { DirectoryUser, Room, SharedRoom } from "@ember/protocol";
import { mentionContent, roomMentionContent } from "@ember/richtext/dom";
import { describe, expect, it } from "vitest";
import { bodyAfter, commandNamed, commandsIn, mentionAfter, personNamedIn, roomMentionAfter, roomNamedIn, SHRUG, SLASH_COMMANDS, typedCommand, withShrug } from "./slash-commands";

const person = (id: string, name: string): DirectoryUser => ({ id, name, bio: null, role: "member", status: "active", avatarUrl: `/users/${id}/avatar` });
const ada = person("ada0000000000001", "Ada");
const adaLovelace = person("ada0000000000002", "Ada Lovelace");
const grace = person("grace00000000001", "Grace Hopper");
const people = [ada, adaLovelace, grace];

const room = (id: string, name: string, kind: SharedRoom["kind"] = "open"): SharedRoom => ({ id, kind, name, icon: null });
const general = room("r1", "general");
const design = room("r2", "design", "closed");
const designReviews = room("r3", "design reviews", "closed");

/** A mention of `person`, as the @ list writes it. */
const mention = ({ id, name, avatarUrl }: DirectoryUser) =>
  `<action-text-attachment sgid="${id}" content="${mentionContent({ id, name, avatarUrl }).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" content-type="application/vnd.campfire.mention"></action-text-attachment>`;

/** A mention of `mentioned`, as the # list writes it. */
const roomMention = (mentioned: SharedRoom) =>
  `<action-text-attachment sgid="${mentioned.id}" content="${roomMentionContent(mentioned).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" content-type="application/vnd.campfire.room"></action-text-attachment>`;

describe("/ commands", () => {
  it("lists Slack's commands Ember can do, by name, each with what it takes and does", () => {
    expect(SLASH_COMMANDS.map(({ name }) => name)).toEqual(["darkmode", "dm", "huddle", "invite", "leave", "msg", "mute", "remove", "rename", "search", "shortcuts", "shrug", "snippet"]);
    expect(commandNamed("invite")).toEqual({ name: "invite", usage: "[@someone] [#room]", description: "Add someone to a room" });
  });

  it("lists those about who's in a room only in a private room, /huddle only with huddles, and /rename but in a DM", () => {
    const names = (room: Room, huddles: boolean) => commandsIn(room, huddles).map(({ name }) => name);
    expect(names(design, true)).toEqual(SLASH_COMMANDS.map(({ name }) => name));
    expect(names(general, true)).toEqual(["darkmode", "dm", "huddle", "msg", "mute", "rename", "search", "shortcuts", "shrug", "snippet"]);
    expect(names({ id: "d1", kind: "direct", members: [ada], activeAt: "2026-11-17T12:00:00.000Z" }, false)).toEqual([
      "darkmode",
      "dm",
      "msg",
      "mute",
      "search",
      "shortcuts",
      "shrug",
      "snippet",
    ]);
  });

  it("reads any message that starts with a / as a command, by its name in any case, or Slack's other name for it", () => {
    expect(typedCommand("/invite  @Ada #design ")).toEqual({ name: "invite", argument: "@Ada #design" });
    expect(typedCommand("/shrug")).toEqual({ name: "shrug", argument: "" });
    expect(typedCommand("/")).toEqual({ name: "", argument: "" });
    expect(typedCommand("/r/programming is great")).toEqual({ name: "r/programming", argument: "is great" });
    expect(typedCommand(" /shrug")).toBeNull();
    expect(typedCommand("and/or")).toBeNull();
    expect(commandNamed("SHRUG")?.name).toBe("shrug");
    expect(commandNamed("kick")?.name).toBe("remove");
    expect(commandNamed("r/programming")).toBeUndefined();
    expect(commandNamed("")).toBeUndefined();
  });

  it("finds whom a command names after an @: someone mentioned, or anyone by name, the longest name first, in any case", () => {
    expect(personNamedIn("@Ada Lovelace hello", [], people)).toEqual({ named: adaLovelace, rest: "hello" });
    expect(personNamedIn("@ada  hello", [], people)).toEqual({ named: ada, rest: "hello" });
    expect(personNamedIn("@grace hopper", [], people)).toEqual({ named: grace, rest: "" });
    expect(personNamedIn("@Adam hello", [], people)).toBeNull();
    expect(personNamedIn("Ada hello", [], people)).toBeNull();
    // Mentioned, as the @ list writes them, even by a name the directory no longer has.
    expect(personNamedIn("@Ada L. hello", [{ id: adaLovelace.id, name: "Ada L." }], people)).toEqual({ named: { id: adaLovelace.id, name: "Ada L." }, rest: "hello" });
  });

  it("finds the room a command names after a #: one mentioned, or any by name, the longest name first, in any case", () => {
    const rooms = [general, design, designReviews];
    expect(roomNamedIn("#design reviews today", [], rooms)).toEqual({ named: designReviews, rest: "today" });
    expect(roomNamedIn("#Design today", [], rooms)).toEqual({ named: design, rest: "today" });
    expect(roomNamedIn("#designs", [], rooms)).toBeNull();
    expect(roomNamedIn("design", [], rooms)).toBeNull();
    // Mentioned, as the # list writes them, before any other room by name, of the same name or a longer one.
    const otherDesign = room("r4", "design", "closed");
    expect(roomNamedIn("#design today", [otherDesign], [...rooms, otherDesign])).toEqual({ named: otherDesign, rest: "today" });
    expect(roomNamedIn("#design reviews today", [otherDesign], [...rooms, otherDesign])).toEqual({ named: otherDesign, rest: "reviews today" });
  });
});

describe("What a command leaves of its message", () => {
  it("takes off the command's / and name and the white space after them, and a paragraph left empty", () => {
    expect(bodyAfter("<p>/shrug  hello <strong>there</strong></p>", 6)).toBe("<p>hello <strong>there</strong></p>");
    expect(bodyAfter("<p>/shrug</p><p>hello</p>", 6)).toBe("<p>hello</p>");
    expect(bodyAfter("<p>/shrug<br>hello</p>", 6)).toBe("<p>hello</p>");
    expect(bodyAfter("<p>/shrug</p>", 6)).toBe("");
  });

  it("takes off the mention or the name typed that follows, as whom the command's for", () => {
    const markup = `<p>/msg ${mention(ada)} hi ${mention(grace)}</p>`;
    expect(mentionAfter(markup, 4)).toBe(ada.id);
    expect(bodyAfter(markup, 4, "mention")).toBe(`<p>hi ${mention(grace)}</p>`);
    expect(mentionAfter("<p>/msg @Ada hi</p>", 4)).toBeNull();
    expect(bodyAfter("<p>/msg @Ada Lovelace hi</p>", 4, "@Ada Lovelace".length)).toBe("<p>hi</p>");
    expect(bodyAfter("<p>/msg #design</p><ul><li>one</li></ul>", 4, "#design".length)).toBe("<ul><li>one</li></ul>");
  });

  it("takes off the room mentioned that follows, as where the command's for", () => {
    const markup = `<p>/msg ${roomMention(design)} see ${roomMention(general)}</p>`;
    expect(roomMentionAfter(markup, 4)).toBe(design.id);
    expect(mentionAfter(markup, 4)).toBeNull();
    expect(roomMentionAfter(`<p>/msg ${mention(ada)} hi</p>`, 4)).toBeNull();
    expect(bodyAfter(markup, 4, "mention")).toBe(`<p>see ${roomMention(general)}</p>`);
    expect(bodyAfter(`<p>/msg ${roomMention(design)}</p>`, 4, "mention")).toBe("");
  });

  it("ends the last paragraph with ¯\\_(ツ)_/¯, after a space, or puts it in one of its own", () => {
    expect(SHRUG).toBe("¯\\_(ツ)_/¯");
    expect(withShrug("<p>hello </p>")).toBe(`<p>hello ${SHRUG}</p>`);
    expect(withShrug("<p>hello<br></p>")).toBe(`<p>hello ${SHRUG}</p>`);
    expect(withShrug(`<p>${mention(ada)}</p>`)).toBe(`<p>${mention(ada)} ${SHRUG}</p>`);
    expect(withShrug("<p><br></p>")).toBe(`<p>${SHRUG}</p>`);
    expect(withShrug("")).toBe(`<p>${SHRUG}</p>`);
    expect(withShrug("<ul><li>one</li></ul>")).toBe(`<ul><li>one</li></ul><p>${SHRUG}</p>`);
  });
});
