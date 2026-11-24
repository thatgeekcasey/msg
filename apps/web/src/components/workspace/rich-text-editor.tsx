import {
  $isCustomActionTextAttachmentNode,
  configure,
  CustomActionTextAttachmentNode,
  Extension,
  Lexical,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
} from "@37signals/lexxy";
import { MENTION_CONTENT_TYPE, OPENGRAPH_EMBED_CONTENT_TYPE, ROOM_MENTION_CONTENT_TYPE, roomMentionContent } from "@ember/richtext/dom";
import { useEffect, useEffectEvent, useImperativeHandle, useRef, type Ref } from "react";
import { roomIconUrl } from "@/components/icons/room-icon";
import type { RoomCard, Rooms } from "@/hooks/use-rooms";
import { sameFormat, type FormattingCommand, type LinkDraft, type TextFormat } from "@/lib/formatting";
import type { SlashCommand } from "@/lib/slash-commands";
import { registerLineStyles } from "./line-styles";
import { $applyFormatting, $formatOf, $linkDraft, $unlink, linkText, startNewBlock, type FormattedEditor } from "./text-formatting";
import "./rich-text-editor.css";

// The editor, Lexxy 0.9.24, set up as Campfire sets it up. This is a chunk of its own, loaded as the
// first editor shows (editor.ts), since it's bigger than the rest of the app.

/** Campfire's CiteNode (app/javascript/lib/rich_text/cite_node.js): the `<cite>` naming whom a reply quotes. */
class CiteNode extends Lexical.ElementNode {
  static getType() {
    return "cite";
  }

  static clone(node: CiteNode) {
    return new CiteNode(node.__key);
  }

  static importJSON(serialized: Record<string, unknown>) {
    return new CiteNode().updateFromJSON(serialized);
  }

  static importDOM() {
    return { cite: () => ({ conversion: () => ({ node: new CiteNode() }), priority: 1 }) };
  }

  exportJSON() {
    return { ...super.exportJSON(), type: "cite" };
  }

  createDOM() {
    return document.createElement("cite");
  }

  updateDOM() {
    return false;
  }

  exportDOM() {
    return { element: document.createElement("cite") };
  }
}

/**
 * Campfire's CampfireRichTextExtension (app/javascript/lib/rich_text/campfire_extension.js):
 * what Campfire's messages hold beyond what Lexxy writes, which the editor keeps rather than strips.
 */
class CampfireRichTextExtension extends Extension {
  get allowedElements() {
    return [
      "cite",
      "figure",
      "figcaption",
      "actiontext-opengraph-embed",
      { tag: "div", attributes: ["sgid"] },
      { tag: "span", attributes: ["sgid"] },
      { tag: "img", attributes: ["alt"] },
      { tag: "a", attributes: ["rel", "target"] },
    ];
  }

  get lexicalExtension() {
    return this.defineExtension({ name: "campfire/rich-text", nodes: [CiteNode], register: registerLineStyles });
  }
}

// Campfire's settings (app/javascript/initializers/rich_text.js), which have to come before Lexxy
// defines its elements, on the tick after it loads. Mentions keep the content type Campfire has always
// given them, application/vnd.campfire.mention. The formatting row is Ember's own, Slack's
// (formatting-toolbar.tsx), in place of Lexxy's toolbar, with Slack's three sizes of heading.
configure({
  global: { attachmentContentTypeNamespace: "campfire", extensions: [CampfireRichTextExtension] },
  default: { toolbar: false, headings: ["h1", "h2", "h3"] },
});

/** A `<lexxy-prompt>`, as far as this uses it. */
type LexxyPrompt = HTMLElement & {
  /** Its list, from when it first opens. */
  readonly popoverElement?: HTMLElement | null;
  /**
   * Where it finds what it lists, while it's connected: for a prompt of `<lexxy-prompt-item>`s, such as the #
   * prompt, the items it held as it connected, and for one that asks its `src`, as the @ prompt does, that
   * address as it was then, which Lexxy reads only then.
   */
  readonly source?: { inlinePromptItemElements?: Element[]; baseURL?: string } | null;
};

/**
 * The @ prompt: typing @ lists the people `src` answers with as prompt items, those whose names hold
 * what follows the @, which Lexxy adds as `filter`. Lexxy opens the list under the cursor where it fits
 * the window, or else above it, or always above it with `above`.
 */
function mentionPrompt(src: string, above: boolean): LexxyPrompt {
  return lexxyPrompt({ trigger: "@", name: "mention", src, "remote-filtering": "true", "empty-results": "No matches" }, above);
}

/**
 * Has the @ prompt ask `src` for the people it lists, above the text with `above`, from the next time it
 * opens its list or narrows it. Lexxy reads where a prompt asks only as it connects, so once it has, it's
 * given to what it asks with.
 */
function askFrom(prompt: LexxyPrompt, src: string, above: boolean) {
  prompt.setAttribute("src", src);
  if (prompt.source) prompt.source.baseURL = src;
  if (above) prompt.setAttribute("vertical-direction", "top");
  else prompt.removeAttribute("vertical-direction");
}

/**
 * The # prompt: typing # lists the rooms `offerRooms` gives it whose names have a word starting with what
 * follows the #, spaces and all, since a room's name can have them, as Slack's # lists channels. Picking one
 * writes a mention of it, which Lexxy gives the `room` prompt's content type, ROOM_MENTION_CONTENT_TYPE. Its
 * list opens where the @ prompt's does, and closes once it lists nothing (`closeListOnNoMatch`).
 */
function roomPrompt(above: boolean): LexxyPrompt {
  return lexxyPrompt({ trigger: "#", name: "room", "supports-space-in-searches": "", "empty-results": "No matches" }, above);
}

/**
 * The / prompt, Slack's shortcuts: a / that starts the message lists `commands`, those whose names start
 * a word with what follows the /, each with what it takes and what it does, above the text, as Slack's
 * list is. Picking one, with Enter, Tab or a click, writes its name after the /, and a space, while a
 * space typed ends the name as it's written.
 */
function commandPrompt(commands: readonly SlashCommand[]): LexxyPrompt {
  const prompt = lexxyPrompt({ trigger: "/", name: "command", "only-at": "^", "insert-editable-text": "", "empty-results": "No matching commands" }, true);
  offerCommands(prompt, commands);
  return prompt;
}

/** Has the / prompt list `commands` from the next time it opens its list or narrows it, as `offerRooms` has the # prompt list rooms. */
function offerCommands(prompt: LexxyPrompt, commands: readonly SlashCommand[]) {
  const items = commands.map(commandItem);
  prompt.replaceChildren(...items);
  if (prompt.source) prompt.source.inlinePromptItemElements = items;
}

/** A `<lexxy-prompt>` of `attributes`, whose list shows above the text, even where there's room below it, with `above`. */
function lexxyPrompt(attributes: Record<string, string>, above: boolean): LexxyPrompt {
  const element = document.createElement("lexxy-prompt");
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  if (above) element.setAttribute("vertical-direction", "top");
  return element;
}

/**
 * Has the # prompt list `rooms`, in their order, from the next time it opens its list or narrows it.
 * Lexxy reads a prompt's items only as it connects, so once it has, they're given to what it lists from.
 */
function offerRooms(prompt: LexxyPrompt, rooms: Rooms | null) {
  const items = [...(rooms?.values() ?? [])].map(roomPromptItem);
  prompt.replaceChildren(...items);
  if (prompt.source) prompt.source.inlinePromptItemElements = items;
}

/**
 * A room as the # prompt lists it, where the @ prompt lists someone's avatar and name: its icon, or a #, as
 * the sidebar shows it, then its name, and the mention picking it writes.
 */
function roomPromptItem(room: RoomCard): HTMLElement {
  const icon = Object.assign(document.createElement("span"), { className: "autocompletable__room" });
  icon.setAttribute("aria-hidden", "true");
  if (room.icon) {
    icon.classList.add("autocompletable__room--icon");
    icon.style.setProperty("--room-icon", `url("${roomIconUrl(room.icon)}")`);
  } else {
    icon.textContent = "#";
  }
  const name = Object.assign(document.createElement("span"), { className: "autocompletable__name", textContent: room.name });
  const row = Object.assign(document.createElement("span"), { className: "autocomplete__item" });
  row.append(icon, name);
  const item = document.createElement("lexxy-prompt-item");
  item.setAttribute("search", room.name);
  item.setAttribute("sgid", room.id);
  item.append(template("menu", row), template("editor", roomMentionContent(room)));
  return item;
}

/** A command as the / prompt lists it: its name and what it takes, over what it does. */
function commandItem({ name, usage, description }: SlashCommand): HTMLElement {
  const row = document.createElement("span");
  row.className = "command";
  row.dataset.command = name;
  const title = document.createElement("span");
  title.className = "command__title";
  const named = document.createElement("strong");
  named.textContent = `/${name}`;
  title.append(named);
  if (usage) title.append(" ", Object.assign(document.createElement("span"), { className: "command__usage", textContent: usage }));
  // The space reads between them, though the grid shows none.
  row.append(title, " ", Object.assign(document.createElement("span"), { className: "command__description", textContent: description }));
  const item = document.createElement("lexxy-prompt-item");
  item.setAttribute("search", name);
  item.append(template("menu", row), template("editor", document.createTextNode(`/${name}`)));
  return item;
}

/** A prompt item's `<template>` of `type`, holding `content`, a node or markup. */
function template(type: "menu" | "editor", content: Node | string): HTMLTemplateElement {
  const element = document.createElement("template");
  element.setAttribute("type", type);
  if (typeof content === "string") element.innerHTML = content;
  else element.content.append(content);
  return element;
}

/** The class Lexxy gives a prompt's list while it shows. */
const LIST_SHOWN = "lexxy-prompt-menu--visible";

/** The class Lexxy gives a prompt's list while it says it found nothing, its `empty-results`. */
const LIST_EMPTY = "lexxy-prompt-menu--empty";

/**
 * Calls `heard` with each record of a change to the class or `data-anchored` of a list `lexxy`'s prompts
 * add to it, which each does as it first opens its list, and with the record of its adding.
 */
function followLists(lexxy: LexxyEditor, heard: (record: MutationRecord, list: Element) => void): MutationObserver {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") heard(record, record.target as Element);
      for (const added of record.addedNodes) {
        if (!(added instanceof Element) || !added.classList.contains("lexxy-prompt-menu")) continue;
        heard(record, added);
        observer.observe(added, { attributeFilter: ["class", "data-anchored"], attributeOldValue: true });
      }
    }
  });
  observer.observe(lexxy, { childList: true });
  return observer;
}

/** Marks the `lexxy:change` that has a prompt look again at what's typed, which changes nothing written. */
const LOOK_AGAIN = Symbol("look again");

/**
 * Has `lexxy`'s prompt `prompt` list what it finds for what's typed after its trigger as the list shows,
 * when that's changed since the prompt read it. Lexxy (0.9.24, and still 1.0.1) hears what's typed only
 * once the list shows, a frame or a fetch after it reads what's typed, so a quick "@ka" would list
 * everyone, and a quick "#ra" every room, until the next key. Lexxy reads what's typed as it adds the
 * list to the editor, and as it unpins the list (`data-anchored`) to open it again. Until the list shows,
 * the prompt hasn't said which list is its own, so what's typed is kept for each. Where `ended` says
 * what's typed by then has ended what the list is for, the list closes as it shows instead, as the
 * commands' list, which shows a frame after the /, does where a space or another / typed before then, as
 * quick typing or a busy page has it, has ended the name, as it would have for that key had it shown,
 * rather than staying open until the next key.
 */
function lookAgainAsListShows(lexxy: LexxyEditor, prompt: LexxyPrompt, ended = () => false): MutationObserver {
  const trigger = prompt.getAttribute("trigger")!;
  const typed = () => lexxy.contents.textBackUntil(trigger);
  const asked = new WeakMap<Element, string>();
  return followLists(lexxy, ({ type, attributeName, oldValue }, list) => {
    if (type === "childList" || (attributeName === "data-anchored" && !list.hasAttribute("data-anchored"))) {
      asked.set(list, typed());
    } else if (attributeName === "class" && list === prompt.popoverElement && list.classList.contains(LIST_SHOWN) && !oldValue?.includes(LIST_SHOWN)) {
      if (ended()) closePrompt(lexxy);
      else if (typed() !== asked.get(list)) lexxy.dispatchEvent(new CustomEvent("lexxy:change", { detail: LOOK_AGAIN }));
    }
  });
}

/**
 * Closes the list of `lexxy`'s prompt `prompt` once it finds nothing for what's typed, as Slack's # list
 * does, while it's the only list open and the text has focus, rather than leaving it to take the next Enter
 * or Tab, as Lexxy does, so a # before anything but a room, as in "#1", is only text. The list closes as Tab
 * closes one that lists nothing: Lexxy (0.9.24) closes its lists only as a key is pressed for them.
 */
function closeListOnNoMatch(lexxy: LexxyEditor, prompt: LexxyPrompt): MutationObserver {
  return followLists(lexxy, (_, list) => {
    const open = lexxy.querySelectorAll(`.lexxy-prompt-menu.${LIST_SHOWN}`);
    if (list !== prompt.popoverElement || !list.classList.contains(LIST_EMPTY) || open.length !== 1 || open[0] !== list || !hasFocus(lexxy)) return;
    lexxy.editor.dispatchCommand(Lexical.KEY_TAB_COMMAND, new KeyboardEvent("keydown", { key: "Tab" }));
  });
}

/** The editors whose room mentions `showRoomsAsTheyAre` is changing, which changes nobody's writing. */
const showingRooms = new WeakSet<HTMLElement>();

/**
 * Shows each room `lexxy`'s text mentions as `rooms` has it now: by its name as it is, or as a private
 * room once it's left, rather than as it was when it was picked, or when the draft it's in was kept. What's
 * sent names the rooms as they are anyway, so this tells nobody of a change, as the room would hear you
 * typing, and leaves undo and the cursor as they were.
 */
function showRoomsAsTheyAre(lexxy: LexxyEditor, rooms: Rooms) {
  const shown = (mention: CustomActionTextAttachmentNode) => roomMentionContent(rooms.get(mention.sgid));
  const stale = lexxy.editor.getEditorState().read(() => $roomMentions().filter((mention) => mention.innerHtml !== shown(mention)).map((mention) => mention.getKey()));
  if (stale.length === 0) return;
  // Lexical puts the page's selection where its own is after a change, which would take focus to the text.
  const tags = hasFocus(lexxy) ? [Lexical.HISTORY_MERGE_TAG] : [Lexical.HISTORY_MERGE_TAG, Lexical.SKIP_DOM_SELECTION_TAG];
  showingRooms.add(lexxy);
  try {
    // Lexxy draws an attachment once, so each is shown again as a new one in its place.
    lexxy.editor.update(
      () => {
        for (const mention of stale.map((key) => Lexical.$getNodeByKey(key))) {
          if (!$isCustomActionTextAttachmentNode(mention)) continue;
          const { tagName, sgid, contentType } = mention;
          mention.replace(new CustomActionTextAttachmentNode({ tagName, sgid, contentType, innerHtml: shown(mention) }));
        }
      },
      { discrete: true, tag: tags },
    );
  } finally {
    showingRooms.delete(lexxy);
  }
}

/** The mentions of rooms in the editor's text, in order, in a read or an update of it. */
function $roomMentions(): CustomActionTextAttachmentNode[] {
  const found: CustomActionTextAttachmentNode[] = [];
  const visit = (node: LexicalNode) => {
    if ($isCustomActionTextAttachmentNode(node)) {
      if (node.contentType === ROOM_MENTION_CONTENT_TYPE) found.push(node);
    } else if (Lexical.$isElementNode(node)) node.getChildren().forEach(visit);
  };
  visit(Lexical.$getRoot());
  return found;
}

/** What's written between the / that starts the message and the cursor, where nothing's selected. */
function commandNameWritten(lexxy: LexxyEditor): string {
  return lexxy.editor.getEditorState().read(() => {
    const selection = Lexical.$getSelection();
    if (!Lexical.$isRangeSelection(selection) || !selection.isCollapsed()) return "";
    const text = selection.anchor.getNode();
    const before = Lexical.$isTextNode(text) ? text.getTextContent().slice(0, selection.anchor.offset) : "";
    return before.slice(before.indexOf("/") + 1);
  });
}

/** The / prompt's list while it shows. */
function shownCommands(lexxy: LexxyEditor): HTMLElement | null {
  const list = lexxy.querySelector<LexxyPrompt>('lexxy-prompt[name="command"]')?.popoverElement;
  return list?.classList.contains(LIST_SHOWN) ? list : null;
}

/** Whether `typed` can't be part of a command's name, which is letters alone, as a space ends it. */
const endsCommandName = (typed: string) => /[^a-z]/i.test(typed);

/** Closes the prompt's list that shows, as Escape does, which is the only way Lexxy has. */
const closePrompt = (lexxy: LexxyEditor) => lexxy.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

/**
 * Has Enter or Tab pick the command for what's written after the / while `list` shows. Lexxy picks the
 * one the list has selected where its name starts with what's written, but the list catches up with typing
 * only once it pauses, so a quick "/dm" and Enter would pick the first command of all. Otherwise this picks
 * the first whose name starts with what's written, as the list would show, or, where none does, closes the
 * list, for Enter to send what's written, which says it isn't a command. Answers whether it picked one.
 */
function pickWritten(lexxy: LexxyEditor, list: HTMLElement): boolean {
  const written = lexxy.contents.textBackUntil("/");
  const sought = written.toLowerCase();
  if (list.querySelector("[aria-selected] [data-command]")?.getAttribute("data-command")?.startsWith(sought)) return false;
  closePrompt(lexxy);
  const names = Array.from(lexxy.querySelectorAll('lexxy-prompt[name="command"] > lexxy-prompt-item'), (item) => item.getAttribute("search") ?? "");
  const name = names.find((name) => name.startsWith(sought));
  if (name === undefined) return false;
  // As Lexxy writes the command it picks, with a space after it where nothing follows.
  changeText(lexxy, () => lexxy.contents.replaceTextBackUntil(`/${written}`, [Lexical.$createTextNode(`/${name}`)]));
  return true;
}

/** A `<lexxy-editor>`, as far as this uses it. */
type LexxyEditor = HTMLElement &
  FormattedEditor & {
    value: string;
    readonly isBlank: boolean;
    readonly hasOpenPrompt: boolean;
    /** Its contenteditable, which Lexxy names after it once it's connected. */
    readonly editorContentElement?: HTMLElement;
    /**
     * What's written, as Lexxy reads it: `textBackUntil` is what follows the last `text` before the cursor, to
     * the end of its word, which `replaceTextBackUntil` replaces, from `text` on, with `nodes`, and a space
     * where nothing follows, putting the cursor after them.
     */
    readonly contents: FormattedEditor["contents"] & { textBackUntil(text: string): string; replaceTextBackUntil(text: string, nodes: LexicalNode[]): void };
    readonly selection: FormattedEditor["selection"] & { placeCursorAtTheEnd(): void };
    /** Its Lexical editor. */
    readonly editor: LexicalEditor;
  };

/** Whether the cursor is in the text with nothing selected. */
function nothingSelected(lexxy: LexxyEditor): boolean {
  return lexxy.editor.getEditorState().read(() => {
    const selection = Lexical.$getSelection();
    return Lexical.$isRangeSelection(selection) && selection.isCollapsed();
  });
}

/** Whether focus is in the text, where the page's selection is the text's. */
const hasFocus = (lexxy: LexxyEditor) => lexxy.editorContentElement?.contains(document.activeElement) ?? false;

/**
 * Has the editor take what's selected on the page, where that's moved since the page last told it. The
 * page tells it a moment after the selection moves, as Shift and an arrow move it, and a key pressed in
 * that moment would otherwise format what was selected before, and put that back on the page.
 */
function catchUpWithThePage(lexxy: LexxyEditor) {
  if (hasFocus(lexxy)) lexxy.editor.update(() => $catchUpWithThePage(lexxy.editor), { discrete: true });
}

/** Has the editor's selection be what's selected on the page, where that's in the text and has moved since the page last told it. */
function $catchUpWithThePage(editor: LexicalEditor) {
  const selection = Lexical.$getSelection();
  const onPage = Lexical.$createRangeSelectionFromDom(Lexical.getDOMSelection(window), editor);
  if (!Lexical.$isRangeSelection(selection) || !onPage || (onPage.anchor.is(selection.anchor) && onPage.focus.is(selection.focus))) return;
  selection.anchor.set(onPage.anchor.key, onPage.anchor.offset, onPage.anchor.type);
  selection.focus.set(onPage.focus.key, onPage.focus.offset, onPage.focus.type);
  // What's typed next takes the format of the text the cursor's moved to, as it would once the page told the editor.
  const text = selection.anchor.getNode();
  if (selection.isCollapsed() && Lexical.$isTextNode(text)) {
    selection.setFormat(text.getFormat());
    selection.setStyle(text.getStyle());
  }
}

/**
 * Makes a change to the text from outside it, as the formatting row and Link's dialog do. Where focus is
 * elsewhere, as on a button of the row, Lexical would put the page's selection back in the text, and so
 * focus, which is left where it is: putting focus back in the text puts the selection there too.
 */
function changeText(lexxy: LexxyEditor, change: () => void, tag?: string) {
  const focused = hasFocus(lexxy);
  const tags = [...(tag ? [tag] : []), ...(focused ? [] : [Lexical.SKIP_DOM_SELECTION_TAG])];
  lexxy.editor.update(change, { tag: tags });
}

/**
 * Keeps the editor's selection while focus is outside the text, as on the formatting row, where the page's
 * selection moves only as the editor redraws what's under it: Bold, pressed from the keyboard, redraws
 * what's selected and leaves the page's selection collapsed before it, which the editor would take once the
 * page told it, so the row's next button would format nothing. As Tab is pressed, and as focus leaves, the
 * editor takes what's selected on the page, which the page may not have told it of yet, as when Tab comes
 * straight after Home: Safari lets go of the page's selection as Tab takes focus to a button, before the
 * text hears that focus has gone.
 */
function keepSelectionWhileAway(lexxy: LexxyEditor) {
  const { editor } = lexxy;
  // Left off the page, where it would put focus back in the text.
  const leavingThePage = () => Lexical.$addUpdateTag(Lexical.SKIP_DOM_SELECTION_TAG);
  return Lexical.mergeRegister(
    editor.registerCommand(
      Lexical.KEY_TAB_COMMAND,
      () => {
        $catchUpWithThePage(editor);
        return false;
      },
      Lexical.COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerCommand(
      Lexical.BLUR_COMMAND,
      () => {
        $catchUpWithThePage(editor);
        leavingThePage();
        return false;
      },
      Lexical.COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerCommand(
      Lexical.SELECTION_CHANGE_COMMAND,
      () => {
        const kept = Lexical.$getPreviousSelection();
        if (hasFocus(lexxy) || !Lexical.$isRangeSelection(kept) || !Lexical.$isRangeSelection(Lexical.$getSelection())) return false;
        Lexical.$setSelection(kept.clone());
        leavingThePage();
        return false;
      },
      Lexical.COMMAND_PRIORITY_CRITICAL,
    ),
    // Lexical keeps the tags of a change that moved only the selection, as formatting what's typed next does,
    // for the change after it, which would leave the page's selection, and focus, where they are as it puts
    // focus back in the text, as Escape on the row does. The tags heard here are the ones it keeps.
    editor.registerUpdateListener(({ tags }) => {
      tags.delete(Lexical.SKIP_DOM_SELECTION_TAG);
    }),
  );
}

/** Where what's written from outside the text goes: in place of what's selected, or at the cursor, or before the text has had one, at its end. */
function $writingPlace(): RangeSelection {
  const selection = Lexical.$getSelection();
  return Lexical.$isRangeSelection(selection) ? selection : Lexical.$getRoot().selectEnd();
}

/** Whether what's written at `selection` would follow a word, which an @ would then be part of rather than start a mention. */
function $followsWord(selection: RangeSelection): boolean {
  const start = selection.isBackward() ? selection.focus : selection.anchor;
  const node = start.getNode();
  if (Lexical.$isTextNode(node) && start.offset > 0) return /\S/.test(node.getTextContent().charAt(start.offset - 1));
  const before = Lexical.$isTextNode(node) ? node.getPreviousSibling() : start.offset > 0 ? (node as ElementNode).getChildAtIndex(start.offset - 1) : null;
  // A line break's text is a newline.
  return before !== null && /\S$/.test(before.getTextContent());
}

/** A link pasted in the editor, as Lexxy tells of it with `lexxy:insert-link`. */
export interface PastedLink {
  url: string;
  /** Adds an attachment of `contentType`, `html` its content, after the paragraph the link is in, if it's still there. */
  insertBelowLink(html: string, options: { attachment: { contentType: string } }): void;
}

export interface RichTextEditorHandle {
  /** What's written, as Lexxy's markup. */
  value(): string;
  /** Empties it, leaving no formatting on for what's typed next. */
  clear(): void;
  /** Whether nothing but white space is written. */
  isBlank(): boolean;
  /** Whether a list it offers, such as the people to mention, is open, which takes Enter for itself. */
  hasOpenPrompt(): boolean;
  focus(): void;
  /** Writes `markup` in place of what's written, then takes focus with the cursor at the end, as Quote does. */
  replace(markup: string): void;
  /** Formats what's selected, or what's typed next, as a button of the formatting row does. */
  apply(command: FormattingCommand): void;
  /** What Link's dialog opens with: the link the cursor is in, or what's selected to link. */
  linkDraft(): LinkDraft;
  /** Links `text` to `url`, in place of what's selected or the link the cursor is in. */
  link(draft: LinkDraft): void;
  /** Takes off the link the cursor is in, keeping its text. */
  unlink(): void;
  /** Writes `text` in place of what's selected, or at the cursor, or at the end before the text has had focus, as an emoji picked is. */
  insertText(text: string): void;
  /**
   * Types @ where the cursor is, after a space if it follows a word, and takes focus, so the people to
   * mention are listed, as Slack's Mention someone does.
   */
  startMention(): void;
  /**
   * Types / at the start of what's written, and takes focus, so the commands are listed, as Slack's Run
   * shortcut does: before anything written, with a space after it, so what's written stays apart.
   */
  startCommand(): void;
  /**
   * In a list, starts its next item, or ends it on an empty one, and in a heading, starts a paragraph
   * after it, as Enter does where it doesn't send. Answers whether it did: elsewhere, it's left to the
   * editor, whose Shift+Enter breaks the line.
   */
  startNewBlock(): boolean;
  /**
   * Has it take what's selected on the page, where that's moved since the page last told it, as a key
   * pressed in the text can come first.
   */
  catchUp(): void;
}

interface Props {
  /** What screen readers call it. */
  label: string;
  placeholder?: string;
  /** How many lines it has room for while empty. */
  rows: number;
  /** What's written in it as it opens, as Lexxy's markup. */
  initialValue?: string;
  /** Where its @ prompt asks for the people it offers (`mentionPromptSrc`), which it follows as it changes. Without it, as it opens, @ is just @. */
  mentionsFrom?: string;
  /**
   * The rooms its # prompt offers, which it follows as they change: those whoever's writing is in, or null
   * while they're loading, when it offers none. Without them, as it opens, # is just #.
   */
  rooms?: Rooms | null;
  /** Whether the people @ lists, and the rooms # does, show above the text even where there's room below it; # reads it as it opens. */
  mentionsAbove?: boolean;
  /** The commands a message can start with, which a / at its start lists, following them as they change. Without them, as it opens, / is just /. */
  commands?: readonly SlashCommand[];
  /**
   * Whether it takes focus once it's ready, with the cursor after what's written. A function is asked
   * then, since it may be ready only after you've moved on.
   */
  autoFocus?: boolean | (() => boolean);
  /** Called when what's written changes, other than as it opens. */
  onChange?: () => void;
  /** Called with the formatting where the cursor is when it changes, as it moves or as formatting goes on or off. */
  onFormatChange?: (format: TextFormat) => void;
  /** Called for each key pressed in its text before the editor sees it, which stopping the event's propagation keeps from the editor. */
  onKeyDown?: (event: KeyboardEvent) => void;
  /** Called when an address is pasted as a link. */
  onLinkPasted?: (link: PastedLink) => void;
  /** Called once it's ready to be written in, a moment after it shows. */
  onReady?: () => void;
  ref?: Ref<RichTextEditorHandle>;
}

/**
 * A `<lexxy-editor>`. React would set its attributes as properties, and some of Lexxy's can only be
 * read or throw before it's connected, so it's built here, in a `<div>` React leaves alone.
 */
export default function RichTextEditor({
  label,
  placeholder,
  rows,
  initialValue,
  mentionsFrom,
  rooms,
  mentionsAbove = false,
  commands,
  autoFocus = false,
  onChange,
  onFormatChange,
  onKeyDown,
  onLinkPasted,
  onReady,
  ref,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<LexxyEditor>(null);
  // Whether the editor's ready, from when Lexxy has read what it opens with until it goes.
  const initialized = useRef(false);
  const mentionsPrompt = useRef<LexxyPrompt>(null);
  const roomsPrompt = useRef<LexxyPrompt>(null);
  const commandsPrompt = useRef<LexxyPrompt>(null);

  useImperativeHandle(ref, () => ({
    value: () => editor.current?.value ?? "",
    clear: () => {
      const lexxy = editor.current;
      if (!lexxy) return;
      lexxy.value = "";
      // Lexxy keeps the format the cursor had, so a message sent all in bold would leave the next one bold
      // too.
      lexxy.editor.update(
        () => {
          const selection = Lexical.$getSelection();
          if (!Lexical.$isRangeSelection(selection)) return;
          selection.setFormat(0);
          selection.setStyle("");
        },
        { discrete: true },
      );
    },
    isBlank: () => editor.current?.isBlank ?? true,
    hasOpenPrompt: () => editor.current?.hasOpenPrompt ?? false,
    focus: () => editor.current?.focus(),
    // Campfire's composer_controller.js#replaceMessageContent, for what Quote writes, and a draft opened, whose
    // rooms show as they are now, as those of the draft the editor opens with do.
    replace: (markup) => {
      const lexxy = editor.current;
      if (!lexxy) return;
      lexxy.value = markup;
      if (rooms) showRoomsAsTheyAre(lexxy, rooms);
      lexxy.focus();
      lexxy.selection.placeCursorAtTheEnd();
    },
    apply: (command) => {
      const lexxy = editor.current;
      if (!lexxy) return;
      // Code with nothing selected is for what's typed next, which Lexxy takes off again after a change it
      // doesn't take as history, as this one is tagged, as it takes off code left over from code that's
      // deleted. Lexical then puts the page's selection back, so it keeps the code, or no code, through the
      // selection change that can still be on its way from the change before, as from a new list item.
      const togglesCode = command === "code" && nothingSelected(lexxy);
      changeText(lexxy, () => $applyFormatting(lexxy, command), togglesCode ? Lexical.HISTORY_MERGE_TAG : undefined);
    },
    linkDraft: () => editor.current?.editor.getEditorState().read($linkDraft) ?? { text: "", url: "" },
    link: (draft) => {
      const lexxy = editor.current;
      if (!lexxy) return;
      linkText(lexxy, draft);
      // Lexxy links text in changes of its own, outside any other, so it's this empty change after them,
      // which Lexical draws with them as one, that leaves focus in Link's dialog until it's closed.
      changeText(lexxy, () => {});
    },
    unlink: () => {
      if (editor.current) changeText(editor.current, $unlink);
    },
    insertText: (text) => {
      if (editor.current) changeText(editor.current, () => $writingPlace().insertText(text));
    },
    startMention: () => {
      const lexxy = editor.current;
      if (!lexxy) return;
      // Lexxy lists the people as an @ is typed in the text with focus, after a space or at a line's start.
      lexxy.focus();
      changeText(lexxy, () => {
        const place = $writingPlace();
        place.insertText($followsWord(place) ? " @" : "@");
      });
    },
    startCommand: () => {
      const lexxy = editor.current;
      if (!lexxy) return;
      // Lexxy lists the commands as a / is typed at the start of the text with focus.
      lexxy.focus();
      changeText(lexxy, () => {
        const root = Lexical.$getRoot();
        const blank = root.getTextContent().trim() === "";
        const start = root.selectStart();
        start.setFormat(0);
        start.setStyle("");
        start.insertText(blank ? "/" : "/ ");
        // Back between the / and the space, for the commands to be listed.
        const typed = Lexical.$getSelection();
        if (blank || !Lexical.$isRangeSelection(typed)) return;
        const text = typed.anchor.getNode();
        if (Lexical.$isTextNode(text)) text.select(typed.anchor.offset - 1, typed.anchor.offset - 1);
      });
    },
    startNewBlock: () => (editor.current ? startNewBlock(editor.current) : false),
    catchUp: () => {
      if (editor.current) catchUpWithThePage(editor.current);
    },
  }));

  const changed = useEffectEvent(() => onChange?.());
  const formatChanged = useEffectEvent((format: TextFormat) => onFormatChange?.(format));
  const keyPressed = useEffectEvent((event: KeyboardEvent) => onKeyDown?.(event));
  const linkPasted = useEffectEvent((link: PastedLink) => onLinkPasted?.(link));
  const ready = useEffectEvent((lexxy: LexxyEditor) => {
    if (rooms) showRoomsAsTheyAre(lexxy, rooms);
    onReady?.();
    if (!(typeof autoFocus === "function" ? autoFocus() : autoFocus)) return;
    lexxy.focus();
    lexxy.selection.placeCursorAtTheEnd();
  });

  /** Tells of the formatting where the cursor is as it changes, from when the editor's ready until it goes. */
  const followFormat = (lexxy: LexxyEditor) => {
    let last: TextFormat | undefined;
    return lexxy.editor.registerUpdateListener(({ editorState }) => {
      const format = editorState.read(() => $formatOf(lexxy));
      if (last && sameFormat(last, format)) return;
      last = format;
      formatChanged(format);
    });
  };

  // Built once, as it opens.
  useEffect(() => {
    const lexxy = document.createElement("lexxy-editor") as LexxyEditor;
    lexxy.className = "lexxy-content";
    lexxy.setAttribute("rows", String(rows));
    // Mentions of people and rooms, and link previews, which only the composer adds, but every editor keeps.
    lexxy.setAttribute("permitted-attachment-types", `${MENTION_CONTENT_TYPE} ${ROOM_MENTION_CONTENT_TYPE} ${OPENGRAPH_EMBED_CONTENT_TYPE}`);
    // Read as the editor connects, without telling anyone it changed.
    if (initialValue) lexxy.setAttribute("value", initialValue);
    lexxy.addEventListener("lexxy:change", (event) => {
      if ((event as CustomEvent).detail !== LOOK_AGAIN && !showingRooms.has(lexxy)) changed();
    });
    let unfollow: (() => void) | undefined;
    let unkeep: (() => void) | undefined;
    lexxy.addEventListener(
      "lexxy:initialize",
      () => {
        unfollow = followFormat(lexxy);
        unkeep = keepSelectionWhileAway(lexxy);
        initialized.current = true;
        ready(lexxy);
      },
      { once: true },
    );
    lexxy.addEventListener("lexxy:insert-link", (event) => linkPasted((event as CustomEvent<PastedLink>).detail));
    // Before Lexical's own handlers, which are on the contenteditable inside, and only for the text's keys.
    const keyDown = (event: KeyboardEvent) => {
      if (!lexxy.editorContentElement?.contains(event.target as Node)) return;
      const commands = shownCommands(lexxy);
      // What can't be in a command's name closes the commands' list before Lexical hears it, so it's typed,
      // rather than picking a command, as Space would with Lexxy.
      if (commands && event.key.length === 1 && endsCommandName(event.key) && !event.ctrlKey && !event.metaKey) closePrompt(lexxy);
      else if (commands && (event.key === "Enter" || event.key === "Tab") && !event.isComposing && pickWritten(lexxy, commands)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      keyPressed(event);
    };
    lexxy.addEventListener("keydown", keyDown, { capture: true });
    // A phone's keyboard tells of no key as it types, only of what it types.
    lexxy.addEventListener(
      "beforeinput",
      (event) => {
        if (event.data && endsCommandName(event.data) && shownCommands(lexxy)) closePrompt(lexxy);
      },
      { capture: true },
    );
    // Inside the editor, which finds them there as it connects. They stay for as long as it does, and are
    // told of what they offer as it changes, since Lexxy looks again a frame after a list closes, or once
    // its fetch answers, and throws if the prompt has been taken out by then.
    const following: MutationObserver[] = [];
    if (mentionsFrom) {
      mentionsPrompt.current = mentionPrompt(mentionsFrom, mentionsAbove);
      lexxy.append(mentionsPrompt.current);
      following.push(lookAgainAsListShows(lexxy, mentionsPrompt.current));
    }
    if (rooms !== undefined) {
      roomsPrompt.current = roomPrompt(mentionsAbove);
      lexxy.append(roomsPrompt.current);
      following.push(lookAgainAsListShows(lexxy, roomsPrompt.current), closeListOnNoMatch(lexxy, roomsPrompt.current));
    }
    if (commands?.length) {
      commandsPrompt.current = commandPrompt(commands);
      lexxy.append(commandsPrompt.current);
      following.push(lookAgainAsListShows(lexxy, commandsPrompt.current, () => endsCommandName(commandNameWritten(lexxy))));
    }
    editor.current = lexxy;
    host.current!.append(lexxy);
    return () => {
      for (const observer of following) observer.disconnect();
      unfollow?.();
      unkeep?.();
      lexxy.remove();
      editor.current = null;
      initialized.current = false;
      mentionsPrompt.current = null;
      roomsPrompt.current = null;
      commandsPrompt.current = null;
    };
  }, []);

  // /invite and /msg have @ offer everyone.
  useEffect(() => {
    if (mentionsPrompt.current && mentionsFrom) askFrom(mentionsPrompt.current, mentionsFrom, mentionsAbove);
  }, [mentionsFrom, mentionsAbove]);

  useEffect(() => {
    if (roomsPrompt.current) offerRooms(roomsPrompt.current, rooms ?? null);
    if (rooms && initialized.current) showRoomsAsTheyAre(editor.current!, rooms);
  }, [rooms]);

  // The / prompt lists the commands there are now, as their names tell.
  const commandNames = commands?.map(({ name }) => name).join(" ") ?? "";
  useEffect(() => {
    if (commandsPrompt.current && commands?.length) offerCommands(commandsPrompt.current, commands);
  }, [commandNames]);

  // Lexxy copies its label and placeholder to its contenteditable only as it connects.
  useEffect(() => {
    const lexxy = editor.current!;
    for (const element of [lexxy, lexxy.editorContentElement]) {
      element?.setAttribute("aria-label", label);
      if (placeholder === undefined) element?.removeAttribute("placeholder");
      else element?.setAttribute("placeholder", placeholder);
    }
  }, [label, placeholder]);

  return <div ref={host} className="contents" />;
}
