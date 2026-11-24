import type { DirectoryUser, Room, RoomId, SharedRoom, User } from "@ember/protocol";
import { MENTION_CONTENT_TYPE, ROOM_MENTION_CONTENT_TYPE, writtenBody } from "@ember/richtext/dom";

// The commands a message can start with, after a /: Slack's own, those Ember has the means for, under
// Slack's names and in its words, with a room where Slack has a channel. Any message that starts with a
// / is a command, as Slack has it, so one that names none isn't sent.

export type CommandName = "darkmode" | "dm" | "huddle" | "invite" | "leave" | "msg" | "mute" | "remove" | "rename" | "search" | "shortcuts" | "shrug" | "snippet";

/** A command, as / lists it: its name, what follows the name, with what's optional in brackets as Slack writes it, and what it does. */
export interface SlashCommand {
  name: CommandName;
  usage: string;
  description: string;
}

/** Every command, by name, as Slack's list of its commands describes each. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "darkmode", usage: "", description: "Turn dark mode on or off" },
  { name: "dm", usage: "", description: "View your DMs" },
  { name: "huddle", usage: "", description: "Start a huddle" },
  { name: "invite", usage: "[@someone] [#room]", description: "Add someone to a room" },
  { name: "leave", usage: "", description: "Leave the current room" },
  { name: "msg", usage: "[@someone or #room] [your message]", description: "Send a DM, or a message to a room" },
  { name: "mute", usage: "[#room]", description: "Mute or unmute a conversation" },
  { name: "remove", usage: "@someone", description: "Remove someone from the current room" },
  { name: "rename", usage: "[new room name]", description: "Rename the current room" },
  { name: "search", usage: "[your search terms]", description: "Search messages" },
  { name: "shortcuts", usage: "", description: "View keyboard shortcuts" },
  { name: "shrug", usage: "[your message]", description: "Append ¯\\_(ツ)_/¯ to the end of your message" },
  { name: "snippet", usage: "", description: "Create a code or text snippet" },
];

/** Slack's other names for its commands. */
const ALIASES: Partial<Record<string, CommandName>> = { kick: "remove" };

/** What /shrug ends a message with. */
export const SHRUG = "¯\\_(ツ)_/¯";

/**
 * The commands / lists in `room`: all of them, but /huddle where the room has no huddles, those about who's
 * in a room only in a private room, as an open room has everyone in it, and /rename but in a DM, which is
 * named after its people.
 */
export function commandsIn(room: Room, huddles: boolean): SlashCommand[] {
  return SLASH_COMMANDS.filter(({ name }) => {
    if (name === "huddle") return huddles;
    if (name === "invite" || name === "remove" || name === "leave") return room.kind === "closed";
    if (name === "rename") return room.kind !== "direct";
    return true;
  });
}

/** The command a message's plain text starts with: the name typed after its /, which may be no command's, and what follows it. */
export interface TypedCommand {
  name: string;
  argument: string;
}

/** The command `plainText` starts with, as any message that starts with a / is one, or null. */
export function typedCommand(plainText: string): TypedCommand | null {
  const typed = /^\/(\S*)\s*/.exec(plainText);
  return typed ? { name: typed[1]!, argument: plainText.slice(typed[0].length).trimEnd() } : null;
}

/** The command named `name`, by any of Slack's names for it, in any case, or undefined. */
export function commandNamed(name: string): SlashCommand | undefined {
  const lower = name.toLowerCase();
  const named = ALIASES[lower] ?? lower;
  return SLASH_COMMANDS.find((command) => command.name === named);
}

/** A message written to run a command: the command, under the name typed, and what follows that, as plain text, and as written. */
export interface WrittenCommand {
  command: SlashCommand;
  typed: TypedCommand;
  markup: string;
  plainText: string;
  mentions: User[];
}

/**
 * Settles with whether a message `body`, which a command sends, is to go to the room `to`, which it does
 * at once, unless it would notify six or more there: then once its writer says to send it, as the
 * composer asks of a message written there.
 */
export type AskToNotify = (to: { id: RoomId; name: string }, body: string) => Promise<boolean>;

/** Runs a command written, settling with whether it ran: one that didn't is written again, to put right. */
export type CommandRunner = (written: WrittenCommand, askToNotify: AskToNotify) => Promise<boolean>;

/**
 * Whether `markup` starts with a /, as a command does: as the first character of its text, which a space
 * before the / makes a message instead.
 */
export const opensWithSlash = (markup: string) => /^(?:<[^>]*>)*\//.test(markup);

/**
 * The command `markup` starts with: the command it names, if it names one, under the name typed, and what
 * follows, or null for a message that doesn't start with a /.
 */
export function commandIn(markup: string): (Omit<WrittenCommand, "command"> & { command?: SlashCommand }) | null {
  if (!opensWithSlash(markup)) return null;
  const { plainText, mentions } = writtenBody(markup);
  const typed = typedCommand(plainText);
  return typed && { command: commandNamed(typed.name), typed, markup, plainText, mentions };
}

/** Whether a command's name has been written whole, as something comes after it. */
export const nameWritten = ({ plainText }: Pick<WrittenCommand, "plainText">) => /^\/\S+\s/.test(plainText);

/** Whether a body written has nothing in it but white space. */
export const isBlankBody = (markup: string) => writtenBody(markup).plainText.trim() === "" && !markup.includes("<action-text-attachment");

/** Someone or something a command names, and what follows its name, from the next word on. */
export interface Named<T> {
  named: T;
  rest: string;
}

/** Whether `text` starts with `name`, in any case, as a word: followed by white space, or nothing. */
function startsWithName(text: string, name: string): boolean {
  return name !== "" && text.slice(0, name.length).toLowerCase() === name.toLowerCase() && (text.length === name.length || /\s/.test(text.charAt(name.length)));
}

/** What follows the first `length` characters of `text`, from its next word on. */
const after = (text: string, length: number) => text.slice(length).trimStart();

const longestFirst = <T extends { name: string }>(named: Iterable<T>) => [...named].sort((a, b) => b.name.length - a.name.length);

/**
 * Whom `argument` starts by naming after an @: someone the message mentions, as the @ list writes them,
 * or else someone in `people`, by name, the longest names first. Null when it names nobody.
 */
export function personNamedIn(argument: string, mentions: User[], people: Iterable<DirectoryUser>): Named<User> | null {
  if (!argument.startsWith("@")) return null;
  const typed = argument.slice(1);
  const person = longestFirst(mentions).find(({ name }) => startsWithName(typed, name)) ?? longestFirst(people).find(({ name }) => startsWithName(typed, name));
  return person ? { named: person, rest: after(typed, person.name.length) } : null;
}

/**
 * The room `argument` starts by naming after a #: one of those the message mentions, as the # list writes
 * them, or else one of `rooms`, by name, the longest names first. Null when it names none.
 */
export function roomNamedIn<R extends SharedRoom>(argument: string, mentioned: R[], rooms: R[]): Named<R> | null {
  if (!argument.startsWith("#")) return null;
  const typed = argument.slice(1);
  const room = longestFirst(mentioned).find(({ name }) => startsWithName(typed, name)) ?? longestFirst(rooms).find(({ name }) => startsWithName(typed, name));
  return room ? { named: room, rest: after(typed, room.name.length) } : null;
}

/** What's taken off the start of a message that starts with a command: so many characters of its text, or the mention, of someone or a room, it starts with. */
export type Taken = number | "mention";

/**
 * `markup`, a message that starts with a command, without what `taken` takes off its start in turn, and
 * the white space after each: the command's / and name, and then whom or where it's for, a mention or
 * the name typed. A paragraph left empty goes too.
 */
export function bodyAfter(markup: string, ...taken: Taken[]): string {
  const template = parsed(markup);
  for (const take of taken) {
    if (take === "mention") {
      const first = firstContent(template.content);
      if (isMention(first) || isRoomMention(first)) remove(template.content, first);
      dropText(template.content, 0);
    } else dropText(template.content, take);
  }
  return template.innerHTML;
}

/** The id of whom the message `markup` mentions first thing after its first `length` characters, and the white space after them, or null. */
export function mentionAfter(markup: string, length: number): string | null {
  const first = firstAfter(markup, length);
  return isMention(first) ? first.getAttribute("sgid") : null;
}

/** The id of the room the message `markup` mentions first thing after its first `length` characters, and the white space after them, or null. */
export function roomMentionAfter(markup: string, length: number): string | null {
  const first = firstAfter(markup, length);
  return isRoomMention(first) ? first.getAttribute("sgid") : null;
}

/** What the message `markup` has first after its first `length` characters and the white space after them: text, a line break or an attachment. */
function firstAfter(markup: string, length: number): Node | null {
  const template = parsed(markup);
  dropText(template.content, length);
  return firstContent(template.content);
}

/** `markup` with ¯\_(ツ)_/¯ at the end of its last paragraph, after a space unless that's empty, or in a paragraph of its own after a list, quote or code. */
export function withShrug(markup: string): string {
  const template = parsed(markup);
  const last = template.content.lastElementChild;
  const paragraph = last?.localName === "p" ? last : template.content.appendChild(document.createElement("p"));
  // What ends the paragraph showing nothing, a line break or white space, would put the shrug apart.
  for (let end = paragraph.lastChild; end && (isLineBreak(end) || (end instanceof Text && end.data.trim() === "")); end = paragraph.lastChild) end.remove();
  if (paragraph.lastChild instanceof Text) paragraph.lastChild.data = paragraph.lastChild.data.trimEnd();
  paragraph.append(paragraph.hasChildNodes() ? ` ${SHRUG}` : SHRUG);
  return template.innerHTML;
}

function parsed(markup: string): HTMLTemplateElement {
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template;
}

const isMention = (node: Node | null): node is Element => node instanceof Element && node.getAttribute("content-type") === MENTION_CONTENT_TYPE;

const isRoomMention = (node: Node | null): node is Element => node instanceof Element && node.getAttribute("content-type") === ROOM_MENTION_CONTENT_TYPE;

const isAttachment = (node: Node) => node instanceof Element && node.localName === "action-text-attachment";

const isLineBreak = (node: Node) => node instanceof Element && node.localName === "br";

/**
 * Takes the first `length` characters of `root`'s text away, a line break read as one, and then the white
 * space, line breaks included, at the start of what's left, up to anything but text, as an attachment.
 */
function dropText(root: DocumentFragment, length: number) {
  let left = length;
  for (let node = firstContent(root); node && !isAttachment(node); node = firstContent(root)) {
    if (node instanceof Text) {
      const kept = node.data.slice(Math.min(left, node.data.length));
      left = Math.max(0, left - node.data.length);
      const trimmed = left > 0 ? kept : kept.trimStart();
      if (trimmed !== "") {
        node.data = trimmed;
        return;
      }
    } else left = Math.max(0, left - 1);
    remove(root, node);
  }
}

/** Takes `node` out of `root`, and the paragraph, or other element, it leaves empty. */
function remove(root: DocumentFragment, node: Node) {
  let parent = node.parentNode;
  node.parentNode?.removeChild(node);
  while (parent && parent !== root && !parent.hasChildNodes()) {
    const emptied = parent;
    parent = parent.parentNode;
    emptied.parentNode?.removeChild(emptied);
  }
}

/** The first text, line break or attachment in `root`, as it reads, or null. */
function firstContent(root: Node): Node | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    // Through the elements around text, to the text, or to an attachment, which is read as one.
    acceptNode: (node) => (node instanceof Text || isLineBreak(node) || isAttachment(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  return walker.nextNode();
}
