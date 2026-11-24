import { lazy, Suspense, useContext, useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { flushSync } from "react-dom";
import { MAX_FILE_SIZE, THREAD_DELETED, type LinkPreview, type ScheduledMessage } from "@ember/protocol";
import { hasPreview, linkedUrls, OPENGRAPH_EMBED_CONTENT_TYPE, previewContent, writtenBody } from "@ember/richtext/dom";
import { AtSign, Microphone, Page, Send, SlashSquare, TextSquare, VideoCamera, XmarkCircle } from "@/components/icons/iconoir";
import { useNameOf } from "@/hooks/use-directory";
import type { Scheduling } from "@/hooks/use-room";
import { RoomsContext } from "@/hooks/use-rooms";
import { fetchLinkPreview, mentionPromptSrc } from "@/lib/api";
import { recordsClips, type ClipKind } from "@/lib/clips";
import { previewOf } from "@/lib/previews";
import { dropTarget } from "@/lib/drop-target";
import { keepSavedDrafts, keepsDrafts, readSavedDrafts, savedDraft, type SavedDraft } from "@/lib/saved-drafts";
import { breaksLine, hasTouchKeyboard, pressedAlone, sendsMessage, uploadsFiles, writesSnippet } from "@/lib/keyboard";
import type { Typist } from "@/lib/room-state";
import { bodyAfter, commandIn, isBlankBody, nameWritten, withShrug, type CommandRunner, type SlashCommand } from "@/lib/slash-commands";
import { tooLargeToAttach } from "@/lib/uploads";
import { cn } from "@/lib/utils";
import { AttachMenu } from "./attach-menu";
import { DraftsMenu, type Drafts } from "./drafts-menu";
import { RichTextEditor, editorLoaded, type PastedLink, type RichTextEditorHandle } from "./editor";
import { EmojiButton } from "./emoji-button";
import { Divider, FormattingToolbar, LinkDialog, useFormatting } from "./formatting-toolbar";
import { useNotifyConfirm } from "./notify-confirm";
import { CustomTimeDialog, ScheduleMenu } from "./schedule-menu";
import { ScheduledDialog, ScheduledLine } from "./scheduled-messages";
import { ShortcutTooltip } from "./shortcut-tooltip";
import { SnippetDialog } from "./snippet-dialog";

// The clips' recorders, which load with the pages few visits need (pages.ts), whose huddles' cameras they share.
const VideoClipDialog = lazy(() => import("./pages").then((pages) => ({ default: pages.VideoClipDialog })));
const AudioClipRecorder = lazy(() => import("./pages").then((pages) => ({ default: pages.AudioClipRecorder })));

/**
 * The typing indicator (Campfire's typing_tracker.js and composer.css): the names of whoever is typing,
 * sorted and comma-separated after a three-dot spinner, fading in above the composer, each followed by
 * what it's doing meanwhile, if an answerer said, as in "Ember is using Digg: digg_get_feed". It isn't a
 * live region: announced on every change, a bare list of names would mean nothing out of context. Names
 * that don't fit end in an ellipsis, rather than wrapping down over the message box.
 */
function TypingIndicator({ typists }: { typists: Typist[] }) {
  const nameOf = useNameOf();
  const names = typists
    .map(({ user, doing }) => (doing === undefined ? nameOf(user) : `${nameOf(user)} ${doing}`))
    .sort()
    .join(", ");
  return (
    <div
      className={cn(
        "absolute -top-[19px] left-0 inline-flex max-w-full items-center text-[11px] transition-opacity duration-300 motion-reduce:transition-none max-md:-top-[15px]",
        !names && "opacity-0",
      )}
    >
      <div className={cn("spinner min-w-0 ps-[1.5em] leading-none", !names && "hidden")}>
        {/* The names clip, and the spinner beside them mustn't; the padding keeps descenders. */}
        <span className="-my-[0.25em] block truncate py-[0.25em]">{names}</span>
      </div>
    </div>
  );
}

/** The composer's place below the messages, which keeps clear of a phone's home bar. */
const FOOTER = "bg-background px-[22px] pt-2.5 pb-[max(12px,env(safe-area-inset-bottom))] narrow:px-4 max-md:px-2.5 max-md:pt-2 max-md:pb-[max(10px,env(safe-area-inset-bottom))]";

/**
 * The buttons under the text, which darken on hover as Campfire's do (composer.css, buttons.css). A
 * disconnected room disables them, though only Send looks it.
 */
const BUTTON = "flex size-8 shrink-0 cursor-pointer items-center justify-center touch:size-11";

/** A button under the text but Send and Slack's +, square, and lit on hover. */
const TOOL = cn(BUTTON, "rounded-[7px] hover:not-active:brightness-85 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-hover aria-expanded:bg-hover");

/**
 * Record video clip and Record audio clip, and the line before them, which give way on touch screens, and in a
 * card narrower than the row's eight buttons and its two lines, 292px, or where there's no Run shortcut, as in
 * a huddle's thread, seven buttons and a line: 247px. A line, as the formatting row's, takes 11px, and isn't
 * drawn for fingers, whose row keeps to its buttons, as Slack's apps' does.
 */
const CLIP_BUTTON = "touch:hidden @max-[18.25rem]:hidden";
const CLIP_BUTTON_WITHOUT_SHORTCUT = "touch:hidden @max-[15.4375rem]:hidden";

/**
 * Manage drafts, which gives way in a card narrower than the row's nine buttons with it and its two lines,
 * 326px, or for fingers, seven, 320px, and where there's no Run shortcut, one button and one line fewer:
 * 281px, or for fingers, 274px. The wider widths are kept from fingers, whose row has no lines, by `md:` and
 * `not-pointer-coarse:`, which together are where `touch:` isn't.
 */
const DRAFTS_BUTTON = "md:not-pointer-coarse:@max-[20.375rem]:hidden touch:@max-[20rem]:hidden";
const DRAFTS_BUTTON_WITHOUT_SHORTCUT = "md:not-pointer-coarse:@max-[17.5625rem]:hidden touch:@max-[17.125rem]:hidden";

/**
 * Schedule for later's chevron, joined to Send, as Slack's is, and Send beside it: it gives way on touch
 * screens, and in a card narrower than the row's nine buttons, its two lines and it, 346px, or where there's no
 * Run shortcut, 301px, where + has what it does.
 */
const SCHEDULE_BUTTON = "flex h-8 w-5 shrink-0 cursor-pointer items-center justify-center rounded-e-full border-s border-background/25 disabled:pointer-events-none";
const SCHEDULE_BUTTON_SHOWN = "touch:hidden @max-[21.625rem]:hidden";
const SCHEDULE_BUTTON_SHOWN_WITHOUT_SHORTCUT = "touch:hidden @max-[18.8125rem]:hidden";
const SEND_BESIDE_SCHEDULE = "rounded-e-none touch:rounded-e-full @max-[21.625rem]:rounded-e-full";
const SEND_BESIDE_SCHEDULE_WITHOUT_SHORTCUT = "rounded-e-none touch:rounded-e-full @max-[18.8125rem]:rounded-e-full";

/** What's said of a / that names no command, which isn't sent. */
const isntACommand = (name: string) => `/${name} isn't a command. To send a message that starts with /, put a space before it.`;

/** Whether `button` is in the row under the text, rather than given way, where + has what it does. */
const shownInRow = (button: HTMLButtonElement | null) => !!button && getComputedStyle(button).display !== "none";

/**
 * Where what someone has written in a room, or in one of its threads, and not yet sent is kept in this
 * browser, for each person apart, so whoever signs in here next doesn't see it.
 */
const draftKey = (userId: string, roomId: string, threadId?: string) => `composer-draft-${userId}-${roomId}` + (threadId === undefined ? "" : `/threads/${threadId}`);

// Storage can be unavailable, as in some private windows, which only means drafts aren't kept.
function readDraft(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Keeps `body` as the draft under `key`, or none once it's null, and answers whether it could. */
function keepDraft(key: string, body: string | null): boolean {
  try {
    if (body === null) localStorage.removeItem(key);
    else localStorage.setItem(key, body);
    return true;
  } catch {
    // Not kept, then.
    return false;
  }
}

/**
 * The composers showing each draft, by its key, as what has each look again at what's kept of it. A
 * thread's draft shows twice where its room's huddle is opened over the thread: beside the room, and in
 * the huddle, which alone can be written in while it covers the other.
 */
const showing = new Map<string, Set<() => void>>();

/**
 * Counts a composer among those showing the draft kept under `key`, until what this answers is called,
 * as the composer goes. The others then look again at what's kept, which the one that went may have
 * left other than they have it.
 */
function showDraft(key: string, lookAgain: () => void): () => void {
  const composers = showing.get(key) ?? new Set();
  showing.set(key, composers.add(lookAgain));
  return () => {
    composers.delete(lookAgain);
    if (composers.size === 0) showing.delete(key);
    for (const other of composers) other();
  };
}

/**
 * Keeps `body` as the draft under `key` where there's none, as a command that didn't run is kept once its
 * composer has gone, and has the composers showing it look again.
 */
function restoreDraft(key: string, body: string): void {
  if (readDraft(key) !== undefined || !keepDraft(key, body)) return;
  for (const lookAgain of showing.get(key) ?? []) lookAgain();
}

/**
 * Forgets `body` as the draft kept as `key`, as it's gone to the room, unless something else has been
 * written there since, telling the composers of it showing, which then show what's written as they open.
 */
function forgetDraft(key: string, body: string): void {
  if (readDraft(key) !== body || !keepDraft(key, null)) return;
  for (const lookAgain of showing.get(key) ?? []) lookAgain();
}

/** The command `body` starts with, once its name is written, as / no longer lists the commands, whose usage shows over the card. */
function commandNamedIn(body: string | null): SlashCommand | null {
  const written = body === null ? null : commandIn(body);
  return written?.command && nameWritten(written) ? written.command : null;
}

/**
 * How tall the editor will be (rich-text-editor.css: 40px, or 30px below 900px wide, and the 4px under the
 * text, and under the formatting row, the 6px over it), which the composer keeps for it while it loads and
 * until it's drawn its text, so the composer doesn't move meanwhile.
 */
const editorHeight = (belowFormatting: boolean) => (belowFormatting ? "min-h-[50px] max-md:min-h-10" : "min-h-11 max-md:min-h-[34px]");

/** What the composer shows while the editor loads: its placeholder, where Lexxy draws it. */
function LoadingEditor({ placeholder, belowFormatting }: { placeholder: string; belowFormatting: boolean }) {
  return (
    <p aria-hidden="true" className={cn("text-[14px] opacity-66 touch:text-[16px]", belowFormatting && "pt-1.5")}>
      {placeholder}
    </p>
  );
}

/** Where whether the formatting row shows over the composer's text is kept in this browser. */
const FORMATTING_SHOWN = "composer-formatting";

/**
 * Whether the formatting row shows over the composer's text, as Slack's Show formatting has it: as it was
 * last left in this browser, and to begin with, everywhere but touch screens, whose keyboard leaves the
 * composer little room.
 */
function useFormattingShown(): [boolean, (shown: boolean) => void] {
  const [shown, setShown] = useState(() => {
    try {
      const kept = localStorage.getItem(FORMATTING_SHOWN);
      if (kept !== null) return kept === "shown";
    } catch {
      // Storage can be unavailable, as in some private windows, which only means it isn't kept.
    }
    return !hasTouchKeyboard();
  });
  const show = (shown: boolean) => {
    setShown(shown);
    try {
      localStorage.setItem(FORMATTING_SHOWN, shown ? "shown" : "hidden");
    } catch {
      // Not kept, then.
    }
  };
  return [shown, show];
}

/**
 * Whether the editor shows: at once if its code has loaded, or else once `deferred` is over and the
 * browser has painted what came with it, which loading the code would hold up.
 */
function useEditorShown(deferred: boolean): boolean {
  const [shown, setShown] = useState(() => !deferred || editorLoaded());
  useEffect(() => {
    if (deferred || shown) return;
    // A timeout set in the next frame runs once that frame is painted.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => (timeout = setTimeout(() => setShown(true))));
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
    };
  }, [deferred, shown]);
  return shown;
}

/** Adds the preview of a link in a message that has gone, which came after it did. */
export type AddPreview = (preview: LinkPreview) => void;

/** The preview asked for of a pasted link: the link, and how to stop asking for it. */
interface Asking {
  /** The link's address, as `linkedUrls` finds it in what's written. */
  url: string;
  request: AbortController;
  preview: Promise<LinkPreview | null>;
  /** Set once the message with the link has gone, which the preview goes after, rather than below the link. */
  sent?: boolean;
}

/** What the composer knows of the previews of what's written. */
interface DraftPreviews {
  /** The preview asked for of the link pasted last. */
  asking: Asking | null;
  /** The links whose previews it has asked for, as `linkedUrls` finds them. */
  asked: Set<string>;
  /** Whether it has added a preview, so that one taken out of what's written stays out. */
  added: boolean;
}

const noPreviews = (): DraftPreviews => ({ asking: null, asked: new Set(), added: false });

/**
 * A link pasted in the composer gets the preview of the page it goes to below its paragraph, when the
 * page has one, unless another link is pasted first, or the editor it was pasted in goes: with the
 * composer, or as the editor opens again, which `opening` counts. Previews that can't be had are left
 * out without a word. As Slack adds a link's preview a moment after its message, the preview of a pasted
 * link still on its way as the message goes is added to the message once it comes, if the link went
 * with it as pasted, or else that of its first link whose preview wasn't asked for, as one typed rather
 * than pasted, unless a preview was added to what was written, or taken out of it.
 */
function useLinkPreviews(opening: number) {
  const draft = useRef(noPreviews());
  /** Forgets the draft's previews: as its editor goes or opens again, and as what's written goes otherwise than as a message, as a command's does. */
  const dropped = () => {
    draft.current.asking?.request.abort();
    draft.current = noPreviews();
  };
  useEffect(() => dropped, [opening]);

  const pasted = async ({ url, insertBelowLink }: PastedLink) => {
    const previews = draft.current;
    previews.asking?.request.abort();
    const request = new AbortController();
    const asking: Asking = { url: linkedUrls(url)[0] ?? url, request, preview: fetchLinkPreview(url, request.signal).catch(() => null) };
    previews.asking = asking;
    previews.asked.add(asking.url);
    const preview = await asking.preview;
    if (!preview || request.signal.aborted || asking.sent) return;
    previews.added = true;
    const content = previewContent({ href: preview.url, url: preview.image ?? undefined, filename: preview.title, description: preview.description });
    insertBelowLink(content, { attachment: { contentType: OPENGRAPH_EMBED_CONTENT_TYPE } });
  };

  /** Has `addPreview` add the preview that's to go after the message `body`, which has just gone, once it comes. */
  const sent = (body: string, addPreview: AddPreview) => {
    const { asking, asked, added } = draft.current;
    draft.current = noPreviews();
    // Whole addresses, so that a link changed after it was pasted doesn't take the preview of the one pasted.
    const links = added || hasPreview(body) ? null : linkedUrls(writtenBody(body).plainText);
    if (asking && links?.includes(asking.url)) asking.sent = true;
    else asking?.request.abort();
    if (!links) return;
    const pastedPreview = asking?.sent ? asking.preview : Promise.resolve(null);
    void pastedPreview.then((found) => found ?? typedLinkPreview(links, asked)).then((found) => found && addPreview(found));
  };

  return { pasted, sent, dropped };
}

/** The preview of the first of a message's `links` to a web page whose preview wasn't `asked` for as it was pasted. */
async function typedLinkPreview(links: string[], asked: Set<string>): Promise<LinkPreview | null> {
  const typed = links.find((url) => /^https?:\/\//i.test(url) && !asked.has(url));
  return typed === undefined ? null : fetchLinkPreview(typed).catch(() => null);
}

/** A file picked to send, keyed, since two can share a name. */
interface PickedFile {
  key: number;
  file: File;
}

/**
 * The files picked to send with the next message: in order of their names, leaving out any over 250 MB,
 * which it says until more are picked.
 */
function usePickedFiles() {
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const lastKey = useRef(0);
  // Reads the files as they're given: a field's, a paste's or a drop's are gone once its event is over.
  const add = (picked: Iterable<File>) => {
    const fitting: PickedFile[] = [];
    const refused: string[] = [];
    for (const file of picked) {
      if (file.size > MAX_FILE_SIZE) refused.push(tooLargeToAttach(file.name));
      else fitting.push({ key: ++lastKey.current, file });
    }
    setErrors(refused);
    if (fitting.length > 0) setFiles((files) => [...files, ...fitting].sort((a, b) => a.file.name.localeCompare(b.file.name)));
  };
  const remove = (key: number) => setFiles((files) => files.filter((picked) => picked.key !== key));
  return { files, errors, add, remove, clear: () => setFiles([]) };
}

/**
 * A file's name as its chip shows it: what runs to an ellipsis, up to its last dot, and its extension,
 * which doesn't. A name with no dot shows whole.
 */
function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? [name, ""] : [name.slice(0, dot + 1), name.slice(dot + 1)];
}

/**
 * The address of a picture's thumbnail, or of a video's poster once it's taken, the one its message will show, as
 * a clip's is from where its thumbnail was chosen. It's let go once its chip goes.
 */
function useThumbnail(file: File): string | undefined {
  const [thumbnail, setThumbnail] = useState<string>();
  useLayoutEffect(() => {
    let url: string | undefined;
    let gone = false;
    const show = (picture: Blob) => {
      if (!gone) setThumbnail((url = URL.createObjectURL(picture)));
    };
    if (file.type.startsWith("image/")) show(file);
    else if (file.type.startsWith("video/")) void previewOf(file).then((poster) => poster && show(poster));
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);
  return thumbnail;
}

/**
 * A file picked to send, styled by Campfire's composer.css: a picture's thumbnail, or a video's poster, as
 * Slack shows a clip, or a file icon, over its name and a circled ×. Pressing it takes the file back out,
 * which it says to screen readers too.
 */
function FileChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const thumbnail = useThumbnail(file);
  const [name, extension] = splitName(file.name);
  const tile = "aspect-[5/4] w-full shrink-0 rounded-[1em] border border-muted-foreground";
  return (
    <button type="button" aria-label={`Remove ${file.name}`} onClick={onRemove} className="flex w-[100px] cursor-pointer flex-col items-center rounded-[1em]">
      {thumbnail ? (
        <img src={thumbnail} alt="" className={cn(tile, "object-cover")} />
      ) : (
        <span className={cn(tile, "flex items-center justify-center")}>
          <Page className="h-auto w-[55%]" />
        </span>
      )}
      <span className="flex max-w-full items-center px-[1ch] text-[0.8rem]">
        <span className="truncate">{name}</span>
        <span className="shrink-0">{extension}</span>
        <XmarkCircle className="ms-[0.5em] -me-[0.5em] size-[1.3em] shrink-0" />
      </span>
    </button>
  );
}

/** The command being written, over the composer's card, as Slack shows it: its name, what it takes, and what it does. */
function CommandUsage({ command: { name, usage, description } }: { command: SlashCommand }) {
  return (
    <p className="w-full px-3 text-[13px] leading-normal text-muted-foreground wrap-anywhere">
      <strong className="font-semibold text-message-ink">/{name}</strong>
      {usage && ` ${usage}`} <span className="ms-[1ch]">{description}</span>
    </p>
  );
}

/** Whether `target` is the page itself, as when nothing has focus, rather than anything on it. */
function isPage(target: EventTarget | null): boolean {
  return target === document.body || target === document.getElementById("main-content");
}

/** Whether focus is still on `element`, or on nothing, as when what had it went away. */
function focusStayedOn(element: Element | null): boolean {
  const focused = document.activeElement;
  return !focused || focused === element || focused === document.body;
}

interface Props {
  roomId: string;
  /** The room's name as the writer reads it, which a DM's names the others in it. */
  roomName: string;
  /** Whether the room is a DM, whose name goes without a `#`. */
  direct?: boolean;
  /** Who's writing, whose drafts are their own. */
  userId: string;
  /** Who's typing here, but whoever's writing, and what each is doing meanwhile, if an answerer said. */
  typing: Typist[];
  disabled: boolean;
  /**
   * Holds back the editor's code while the room's first messages are on their way, and until they're
   * painted, since loading it then would hold them up. Once it's loaded, as for a room opened before,
   * the editor shows anyway.
   */
  deferEditor?: boolean;
  /**
   * The message whose thread the composer writes replies in, which can be sent to the room too: Also send
   * to the room is ticked for that, until they've gone.
   */
  threadId?: string;
  /**
   * Sends a message, its body markup, answering how to add the preview of a link in it that comes once
   * it has gone, or null when it didn't go: then it stays to be changed.
   */
  onSend: (body: string, alsoSend: boolean) => AddPreview | null;
  /** Sends files, each as a message of its own, before the message written with them. */
  onSendFiles: (files: File[], alsoSend: boolean) => void;
  onTyping: (active: boolean) => void;
  /** Opens the editor on your newest message, for Up Arrow. */
  onEditLastMessage?: () => void;
  /** The commands / lists, Slack's that Ember can do in the room. */
  commands?: readonly SlashCommand[];
  /**
   * Runs a command written, but /shrug and /snippet, which the composer runs itself, settling with
   * whether it ran, which empties the composer: one that didn't stays to be put right. A message it sends
   * to a room asks first, by the composer, where it would notify six or more there. Without it, a message
   * that starts with a / is sent as it is.
   */
  onCommand?: CommandRunner;
  /**
   * Schedule for later, where the room schedules messages: what schedules what's written, and what you
   * have scheduled in the room, of which the line over the card counts those where the composer writes.
   */
  scheduling?: ComposerScheduling;
  /** Whether the editor takes focus as it shows, except on touch screens, as it does unless something else is to have it. */
  autoFocus?: boolean;
  /** Whether the people @ lists show above the text with a mouse too, as on touch screens: for a composer with something under it that would cut the list off. */
  mentionsAbove?: boolean;
  ref?: Ref<ComposerHandle>;
}

export interface ComposerScheduling extends Scheduling {
  /** Every message you have scheduled in the room, soonest first. */
  scheduled: ScheduledMessage[];
  /** Says, as the page does, when the message just scheduled will be sent. */
  onScheduled: (at: Date) => void;
}

export interface ComposerHandle {
  focus(): void;
  /** Writes `markup` in place of what's written, as Quote does, taking focus. */
  replace(markup: string): void;
  /** Adds files to send with the next message, as dropping them on the room's messages does. */
  addFiles(files: Iterable<File>): void;
  /**
   * Writes `markup` back, a message the room wouldn't take for what it says, with `why` above the card,
   * and Also send to the room ticked again if `alsoSend`, unless something's been written since. Answers
   * whether it did.
   */
  giveBack(markup: string, why: string, alsoSend: boolean): boolean;
}

/**
 * The composer: a card with Slack's formatting row on top, then the editor, and below it Slack's buttons:
 * + (Text snippet, Upload from your computer), Show formatting, which shows or hides the row, Emoji,
 * Mention someone, Record video clip and Record audio clip, which are in + where the row has no room for
 * them, as on touch screens, as in Slack's apps, Run shortcut, which types / for the commands, Manage
 * drafts, once there are drafts to list, and a round Send button, grey until there's something to send, with
 * Schedule for later's chevron joined to it, where the room schedules messages, over which a line counts
 * those you have scheduled where the composer writes, and lists them. @ offers the room's people to
 * mention, # the rooms you're in, and a / that starts the message Slack's commands Ember can do, a message
 * that starts with one running it. Files picked, pasted or dropped, snippets and clips wait above the card
 * to go with the next message. What's written is kept as a draft until it's sent, or put aside for another
 * with Manage drafts' Save as draft, which lists it to open again. A thread's has Also send to the room
 * before Manage drafts and Send. A message the room won't take for what it says, as one with a word
 * Blocked words keeps out, comes back to be changed, saying why above the card. One whose @channel, @here
 * or @everyone would notify a room of six or more asks first, as Slack's does.
 */
export function Composer({
  roomId,
  roomName,
  direct = false,
  userId,
  typing,
  disabled,
  deferEditor = false,
  threadId,
  onSend,
  onSendFiles,
  onTyping,
  onEditLastMessage,
  commands,
  onCommand,
  scheduling,
  autoFocus = true,
  mentionsAbove = false,
  ref,
}: Props) {
  const editor = useRef<RichTextEditorHandle>(null);
  const form = useRef<HTMLFormElement>(null);
  const formatting = useFormatting(editor);
  const rooms = useContext(RoomsContext);
  const [formattingShown, showFormatting] = useFormattingShown();
  const [alsoSend, setAlsoSend] = useState(false);
  const key = draftKey(userId, roomId, threadId);
  const [draft, setDraft] = useState(() => readDraft(key));
  // What's kept of the draft as far as this composer knows: what it read as it opened, or has kept since.
  const kept = useRef(draft ?? null);
  // How many times the editor has opened again, with what another composer of its draft left of it.
  const [reopened, setReopened] = useState(0);
  // Touch screens bring up their keyboard on focus, so there it waits for a tap.
  const [focusOnOpen] = useState(() => !hasTouchKeyboard());
  // Where focus was as the room opened. The editor can be ready a moment later, by when you may have put
  // focus elsewhere, where it's left.
  const [focusAtOpen] = useState(() => document.activeElement);
  const editorShown = useEditorShown(deferEditor);
  const linkPreviews = useLinkPreviews(reopened);
  const picked = usePickedFiles();
  // Whether nothing's written, which, with no files picked, leaves Send grey, as Slack's is.
  const [blank, setBlank] = useState(!draft);
  const [writingSnippet, setWritingSnippet] = useState(false);
  // The clip being recorded: a video clip in its dialog, or an audio clip over the card. Where the browser can't record one, there are no buttons for them.
  const [recordingClip, setRecordingClip] = useState<ClipKind | null>(null);
  const [clips] = useState(recordsClips);
  const clipButton = onCommand ? CLIP_BUTTON : CLIP_BUTTON_WITHOUT_SHORTCUT;
  // The drafts put aside here, which Manage drafts lists, and whether they couldn't be kept, which leaves
  // what's written as it was. Where this browser can't keep them at all, there's no Manage drafts.
  const [keepsSaved] = useState(keepsDrafts);
  const [saved, setSaved] = useState(() => readSavedDrafts(key));
  const [notSaved, setNotSaved] = useState(false);
  const draftsButton = useRef<HTMLButtonElement>(null);
  // Why the room refused to schedule what's written, Custom time's dialog, and the list of what's scheduled here.
  const [notScheduled, setNotScheduled] = useState<string | null>(null);
  // Whether what's written is being scheduled, as the room's answer comes, which Send and Schedule for later
  // wait for, so it doesn't go twice.
  const beingScheduled = useRef(false);
  const [scheduleAwaited, setScheduleAwaited] = useState(false);
  const [pickingTime, setPickingTime] = useState(false);
  const [listingScheduled, setListingScheduled] = useState(false);
  const scheduleButton = useRef<HTMLButtonElement>(null);
  // Whether the editor can be written in, which Emoji and Mention someone wait for, since what they wrote before
  // would be lost.
  const [editorReady, setEditorReady] = useState(false);
  const fileField = useRef<HTMLInputElement>(null);
  const videoClipButton = useRef<HTMLButtonElement>(null);
  // Whether the editor was blank when it last changed, so emptying it tells the room you've stopped once.
  const wasBlank = useRef(!draft);
  // Whether Quote wrote what the editor opens with, before it showed, so it takes focus as Quote has it do.
  const replied = useRef(false);
  // The command being written, whose usage shows over the card, as it does for a draft that opens with
  // one, and what's said of one that isn't a command.
  const [usage, setUsage] = useState(() => (onCommand ? commandNamedIn(draft ?? null) : null));
  const [notACommand, setNotACommand] = useState<string | null>(null);
  // Whether a command is running, which another waits for.
  const running = useRef(false);
  // Why the room wouldn't take what's written here, which went back to be changed, until something's sent.
  const [refusal, setRefusal] = useState<{ key: string; why: string } | null>(null);
  const placeholder = threadId !== undefined ? "Reply…" : `Message ${direct ? "" : "#"}${roomName}`;
  // Only a message to a room's timeline notifies it, so only its composer asks first.
  const notifyConfirm = useNotifyConfirm(roomId, roomName, !direct && threadId === undefined, () => editor.current?.focus());

  // Keeps `body` as what's written, answering whether it could.
  const keep = (body: string | null) => {
    const keeps = keepDraft(key, body);
    if (keeps) kept.current = body;
    return keeps;
  };

  // What's written changed, to `body`, or to nothing: the room hears whether you're typing, and it's kept.
  const wrote = (body: string | null) => {
    if (body !== null) onTyping(true);
    else if (!wasBlank.current) onTyping(false);
    wasBlank.current = body === null;
    setBlank(body === null);
    keep(body);
  };

  // Another composer of this draft has gone, as a thread's in its huddle goes from over the thread's own,
  // beside its room. Where it left the draft other than this one has it, what it left is what's written
  // here: the editor opens again with it, as it opened with the draft it found. It may have put drafts
  // aside, or opened them, too.
  const lookAgain = useEffectEvent(() => {
    setSaved(readSavedDrafts(key));
    const left = readDraft(key) ?? null;
    if (left === kept.current) return;
    kept.current = left;
    wasBlank.current = left === null;
    setBlank(left === null);
    setDraft(left ?? undefined);
    setUsage(onCommand ? commandNamedIn(left) : null);
    setEditorReady(false);
    setReopened((times) => times + 1);
  });
  useEffect(() => showDraft(key, () => lookAgain()), [key]);

  useImperativeHandle(ref, () => ({
    focus: () => editor.current?.focus(),
    replace: (markup) => {
      if (editor.current) return editor.current.replace(markup);
      // Before the editor shows, as its code loads, the reply is what it opens with.
      replied.current = true;
      setDraft(markup);
      wrote(markup);
    },
    addFiles: picked.add,
    giveBack: (markup, why, alsoSend) => {
      const written = editor.current;
      if (!written?.isBlank()) return false;
      written.replace(markup);
      setRefusal({ key, why });
      if (alsoSend) setAlsoSend(true);
      return true;
    },
  }));

  // Up Arrow, with nothing written, edits your newest message. It's taken only from the composer or the
  // page itself, not from other fields or the editor of another message.
  const editLastMessage = useEffectEvent((event: KeyboardEvent) => {
    if (!onEditLastMessage || event.defaultPrevented || !pressedAlone(event, "ArrowUp")) return;
    const fromText = form.current?.querySelector(".lexxy-editor__content")?.contains(event.target as Node) ?? false;
    // Before the editor shows, what's written is the draft it will show.
    const blank = editor.current ? editor.current.isBlank() : !draft;
    if (!(fromText || isPage(event.target)) || !blank) return;
    event.preventDefault();
    onEditLastMessage();
  });
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => editLastMessage(event);
    document.addEventListener("keydown", keyDown);
    return () => document.removeEventListener("keydown", keyDown);
  }, []);

  const changed = () => {
    const body = editor.current!.isBlank() ? null : editor.current!.value();
    wrote(body);
    setNotACommand(null);
    setNotSaved(false);
    setNotScheduled(null);
    setUsage(onCommand ? commandNamedIn(body) : null);
  };

  // What's written, unless it's blank.
  const whatsWritten = () => (editor.current && !editor.current.isBlank() ? editor.current.value() : null);

  // This sends nothing while the room is disconnected, and otherwise sends the files picked, then `body`,
  // what's written unless it's blank, and focuses the editor, on touch screens too. Before the editor
  // shows, as its code loads, only the files go. Also send to the room is unticked once anything's gone,
  // as Slack unticks it.
  const send = (body = whatsWritten()) => {
    if (disabled || beingScheduled.current) return;
    setRefusal(null);
    if (picked.files.length > 0) {
      onSendFiles(picked.files.map(({ file }) => file), alsoSend);
      picked.clear();
      setAlsoSend(false);
    }
    const written = editor.current;
    if (!written) return;
    if (body !== null) {
      // One the room won't take, as when it's too long, stays to be cut down.
      const addPreview = onSend(body, alsoSend);
      if (!addPreview) return;
      linkPreviews.sent(body, addPreview);
      // Everyone else stops showing you as typing when your message arrives.
      wasBlank.current = true;
      written.clear();
      keep(null);
      setAlsoSend(false);
    }
    written.focus();
  };

  // This render's send, for a message that waits on its room's counts or its writer's say, so that the
  // files picked by then go with it.
  const sendNow = useRef(send);
  useLayoutEffect(() => {
    sendNow.current = send;
  });

  // What's written is done with, as a command that's run is: the room hears you've stopped typing, and a
  // link's preview, asked for or added, goes with it, leaving the next message's links their own.
  const doneWith = (written: RichTextEditorHandle) => {
    written.clear();
    wrote(null);
    setUsage(null);
    setRefusal(null);
    linkPreviews.dropped();
  };

  // What's written, as it's to go: with ¯\_(ツ)_/¯ at its end while it's /shrug, and as it is while it's no
  // command; or undefined, to send nothing, once it's become another command, which runs only as it's
  // submitted, since the composer can still be written in while the room's counts come.
  const toSend = () => {
    const body = whatsWritten();
    const typedIn = body !== null && onCommand ? commandIn(body) : null;
    if (!typedIn) return body;
    return typedIn.command?.name === "shrug" ? withShrug(bodyAfter(typedIn.markup, 1 + typedIn.typed.name.length)) : undefined;
  };

  // Sends what's written, and the files picked, asking first if it would notify a room of six or more,
  // of what it says then: what goes is what's written once the counts come, or Send is pressed.
  const sendWritten = () =>
    notifyConfirm.confirm(
      () => toSend() ?? "",
      () => {
        const body = toSend();
        if (body !== undefined) sendNow.current(body);
      },
    );

  // Keeps `drafts` as those put aside here, and lists them, answering whether they could be kept.
  const keepSaved = (drafts: SavedDraft[]) => {
    const keeps = keepSavedDrafts(key, drafts);
    if (keeps) setSaved(drafts);
    else setNotSaved(true);
    return keeps;
  };

  // Save as draft: what's written is put aside, newest of the drafts listed, and the composer empties for another.
  const putAside = () => {
    const written = editor.current;
    if (written && !written.isBlank() && keepSaved([savedDraft(written.value()), ...readSavedDrafts(key)])) doneWith(written);
  };

  // The draft put aside as `id` is written in the composer, and what's written put aside in its place, with
  // the previews asked for of its links forgotten, as it's no longer what's written. One that another
  // composer of this draft has opened meanwhile has gone from the list. The draft opened is kept as what's
  // written before it shows, so it isn't lost as the page goes: where there's no room for it, the drafts are
  // put back as they were, and what's written stays.
  const openDraft = (id: string) => {
    const written = editor.current;
    const drafts = readSavedDrafts(key);
    const opened = drafts.find((draft) => draft.id === id);
    if (!written || !opened) return setSaved(drafts);
    const others = drafts.filter((draft) => draft !== opened);
    if (!keepSaved(written.isBlank() ? others : [savedDraft(written.value()), ...others])) return;
    if (!keep(opened.body)) {
      keepSaved(drafts);
      return setNotSaved(true);
    }
    written.replace(opened.body);
    linkPreviews.dropped();
  };

  const drafts: Drafts | undefined = keepsSaved
    ? {
        place: threadId !== undefined ? "thread" : direct ? "conversation" : "room",
        look: () => {
          const written = editor.current;
          const listed = readSavedDrafts(key);
          setSaved(listed);
          return { written: written && !written.isBlank() ? written.value() : null, saved: listed };
        },
        onPutAside: putAside,
        onOpen: openDraft,
      }
    : undefined;

  // Where the composer writes, as "in" goes on, and what you have scheduled there: replies in its thread, or
  // the room's own messages, with the replies whose thread's message has been deleted, which have no thread
  // to be listed in.
  const place = threadId !== undefined ? "in this thread" : direct ? "in this conversation" : `in #${roomName}`;
  const scheduledHere =
    scheduling?.scheduled.filter((message) => (threadId === undefined ? message.parentId === undefined || message.failure === THREAD_DELETED : message.parentId === threadId)) ?? [];
  // Something written can be scheduled, but not files, which go as they're sent, nor a command, nor what's
  // being scheduled already.
  const schedulable = editorReady && !blank && picked.files.length === 0 && usage === null && !scheduleAwaited;

  // Schedules what's written for `at`, as a reply sent to the room too while Also send to the room is
  // ticked, asking first, as Send does, if it would notify a room of six or more once it's sent. A command
  // isn't scheduled.
  const scheduleWritten = (at: Date) => {
    const written = editor.current;
    if (!scheduling || !written || written.isBlank() || beingScheduled.current) return;
    const typedIn = onCommand ? commandIn(written.value()) : null;
    if (typedIn) return setNotACommand(typedIn.command ? `/${typedIn.command.name} can't be scheduled.` : isntACommand(typedIn.typed.name));
    notifyConfirm.confirm(() => whatsWritten() ?? "", () => void scheduleNow(scheduling, at), "Schedule");
  };

  // Schedules what's written by now, unless it's been emptied, or become a command, while the room's counts
  // came. Once the room has it, the composer empties, as Send empties it, unless something else has been
  // written meanwhile, and where the composer has gone meanwhile, its draft is forgotten, as it's scheduled.
  // One the room refuses stays, with why over the card.
  const scheduleNow = async (scheduling: ComposerScheduling, at: Date) => {
    const body = whatsWritten();
    if (body === null || (onCommand && commandIn(body)) || beingScheduled.current) return;
    beingScheduled.current = true;
    setScheduleAwaited(true);
    const refusal = await scheduling.schedule(body, at, threadId === undefined ? undefined : { parentId: threadId, alsoSend });
    beingScheduled.current = false;
    setScheduleAwaited(false);
    if (refusal !== null) return setNotScheduled(refusal);
    const stillWritten = editor.current;
    if (!stillWritten) forgetDraft(key, body);
    else if (!stillWritten.isBlank() && stillWritten.value() === body) {
      doneWith(stillWritten);
      setAlsoSend(false);
    }
    scheduling.onScheduled(at);
  };

  // A command that didn't run is written again, to put right, unless something else has been written
  // meanwhile: in the editor, or, where the composer has gone, as when its room was left meanwhile, as its
  // draft, which it opens with.
  const writeAgain = (markup: string) => {
    const written = editor.current;
    if (!written) restoreDraft(key, markup);
    else if (written.isBlank()) written.replace(markup);
  };

  // Runs the command written, as Slack does: /shrug sends the message with ¯\_(ツ)_/¯ at its end, and the
  // files picked, asking first as any message does if it would notify a room of six or more; /snippet
  // opens Text snippet, leaving what follows it written; and the room runs the rest, one at a time, which
  // empties the composer as it starts, as it may leave the room. One that doesn't run is written again. A
  // / that names no command says so, and sends nothing.
  const run = (written: RichTextEditorHandle, typedIn: NonNullable<ReturnType<typeof commandIn>>) => {
    const { command, typed, markup } = typedIn;
    if (!command) return setNotACommand(isntACommand(typed.name));
    if (command.name === "shrug") return sendWritten();
    if (command.name === "snippet") {
      const left = bodyAfter(markup, 1 + typed.name.length);
      if (isBlankBody(left)) doneWith(written);
      else written.replace(left);
      return setWritingSnippet(true);
    }
    if (running.current) return;
    running.current = true;
    doneWith(written);
    void onCommand!({ ...typedIn, command }, notifyConfirm.askToNotify)
      .catch(() => false)
      .then((ran) => {
        running.current = false;
        if (!ran) writeAgain(markup);
      });
  };

  // This sends nothing while the room is disconnected, and otherwise runs the command written, or sends
  // the files picked, then what's written unless it's blank: what would notify a room of six or more
  // waits, with the files picked, until its writer says to send it.
  const submit = () => {
    if (disabled || beingScheduled.current) return;
    const written = editor.current;
    const command = written && onCommand && !written.isBlank() ? commandIn(written.value()) : null;
    if (command) return run(written!, command);
    if (written && !written.isBlank()) sendWritten();
    else send();
  };

  // Puts focus back in the text as the clip's recorder goes, once the recorder, which kept the text from it, has gone.
  const closeClip = () => {
    flushSync(() => setRecordingClip(null));
    editor.current?.focus();
  };

  const keyDown = (event: KeyboardEvent) => {
    if (formatting.keyDown(event)) return;
    // Slack's keys for the + menu's two: Cmd or Ctrl+O picks files, and with Shift, Enter writes a snippet.
    if (uploadsFiles(event) || writesSnippet(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (uploadsFiles(event)) fileField.current?.click();
      else setWritingSnippet(true);
      return;
    }
    // Enter picks from an open list, such as the people to mention.
    if (editor.current?.hasOpenPrompt()) return;
    if (breaksLine(event) && editor.current?.startNewBlock()) {
      // Where Enter sends, Shift+Enter starts a list's next item, or ends the list, and ends a heading.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!sendsMessage(event)) return;
    event.preventDefault();
    event.stopPropagation();
    submit();
  };

  return (
    // A thread's panel is narrower than its room, and its composer keeps closer to its sides.
    <footer className={cn(FOOTER, threadId !== undefined && "px-4")}>
      <form
        ref={form}
        className="composer relative min-w-0 [contain:inline-size]"
        data-formatting={formattingShown || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        // Pasted files are picked rather than written, which Lexxy leaves them out of, and any paste clears
        // what was said about files too large.
        onPaste={(event) => {
          if (event.clipboardData.files.length > 0) event.preventDefault();
          picked.add(event.clipboardData.files);
        }}
        {...dropTarget(picked.add)}
      >
        <TypingIndicator typists={typing} />
        {/* What's scheduled here, the files picked, those too large to send, and the command being written, or a / that names none, or drafts that couldn't be saved, or what couldn't be scheduled. */}
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-[1ch] gap-y-2",
            (scheduledHere.length > 0 || picked.files.length > 0 || picked.errors.length > 0 || usage || notACommand || notSaved || notScheduled) && "pb-2",
          )}
        >
          {scheduledHere.length > 0 && <ScheduledLine count={scheduledHere.length} place={place} onOpen={() => setListingScheduled(true)} />}
          {picked.files.map(({ key, file }) => (
            <FileChip key={key} file={file} onRemove={() => picked.remove(key)} />
          ))}
          {picked.errors.length > 0 && (
            <p role="alert" className="w-full px-3 py-2.5 text-[13px] leading-normal text-negative wrap-anywhere">
              {picked.errors.join(" ")}
            </p>
          )}
          {notACommand && (
            <p role="alert" className="w-full px-3 py-2.5 text-[13px] leading-normal text-negative wrap-anywhere">
              {notACommand}
            </p>
          )}
          {notSaved && (
            <p role="alert" className="w-full px-3 py-2.5 text-[13px] leading-normal text-negative wrap-anywhere">
              Your drafts couldn't be saved, as this browser has no room left for them.
            </p>
          )}
          {notScheduled && (
            <p role="alert" className="w-full px-3 py-2.5 text-[13px] leading-normal text-negative wrap-anywhere">
              {notScheduled}
            </p>
          )}
          {usage && <CommandUsage command={usage} />}
        </div>
        {refusal?.key === key && (
          <p role="alert" className="px-3 pb-2 text-[13px] leading-normal text-negative wrap-anywhere">
            {refusal.why}
          </p>
        )}
        <div
          className={cn(
            "@container relative flex min-h-[108px] min-w-0 flex-col rounded-[12px] border bg-surface p-3 max-md:min-h-[100px] max-md:p-2.5",
            // An audio clip being recorded takes the card's place, keeping what's under it, out of sight and reach.
            recordingClip === "audio" && "[&>:not([data-clip-recorder])]:invisible",
          )}
        >
          {recordingClip === "audio" && (
            <Suspense fallback={null}>
              <AudioClipRecorder onRecorded={(clip) => picked.add([clip])} onClose={closeClip} />
            </Suspense>
          )}
          {formattingShown && (
            <FormattingToolbar
              formatting={formatting}
              // Close to the card's corner, as Slack's, and faint while the composer hasn't focus. On touch
              // screens, it scrolls rather than wrapping its fingertip-sized buttons.
              className="-mx-1.5 -mt-1.5 transition-opacity duration-150 motion-reduce:transition-none [.composer:not(:focus-within)_&]:opacity-55 touch:flex-nowrap touch:overflow-x-auto touch:[scrollbar-width:none]"
            />
          )}
          {/* The editor takes the card's padding and fills this, all the card above the buttons, and below the
              formatting row (rich-text-editor.css). */}
          <div className={cn("flex min-w-0 flex-1 flex-col", editorHeight(formattingShown))}>
            <Suspense fallback={<LoadingEditor placeholder={placeholder} belowFormatting={formattingShown} />}>
              {editorShown ? (
                <RichTextEditor
                  key={reopened}
                  ref={editor}
                  label={threadId !== undefined ? "Write a reply" : "Write a message"}
                  placeholder={placeholder}
                  rows={2}
                  initialValue={draft}
                  // /invite and /msg are for people the room may not have, so @ offers everyone after them. A
                  // room's composer offers @here, @channel and, in an open room, @everyone too, which notify
                  // nobody from a thread or a DM.
                  mentionsFrom={
                    usage?.name === "invite" || usage?.name === "msg" ? mentionPromptSrc(null) : mentionPromptSrc(roomId, threadId === undefined && !direct)
                  }
                  rooms={rooms}
                  commands={onCommand && commands}
                  // Under the text on touch screens are the keyboard and the home indicator.
                  mentionsAbove={mentionsAbove || hasTouchKeyboard()}
                  // Opened again, it leaves focus where it is, with whatever is in front of it now.
                  autoFocus={() => reopened === 0 && (replied.current || (autoFocus && focusOnOpen && focusStayedOn(focusAtOpen)))}
                  onChange={changed}
                  onFormatChange={formatting.setFormat}
                  onKeyDown={keyDown}
                  onLinkPasted={linkPreviews.pasted}
                  onReady={() => setEditorReady(true)}
                />
              ) : (
                <LoadingEditor placeholder={placeholder} belowFormatting={formattingShown} />
              )}
            </Suspense>
          </div>
          <div className="flex flex-none items-center gap-0.5 @max-[34.625rem]:flex-wrap">
            {/* Upload from your computer's, and Cmd or Ctrl+O's, file picker. */}
            <input
              ref={fileField}
              type="file"
              multiple
              hidden
              disabled={disabled}
              onChange={(event) => {
                picked.add(event.target.files ?? []);
                // So picking the same file again is a change.
                event.target.value = "";
              }}
            />
            <AttachMenu
              disabled={disabled}
              onUpload={() => fileField.current?.click()}
              onSnippet={() => setWritingSnippet(true)}
              onRecordClip={clips ? setRecordingClip : undefined}
              clipsInRow={() => shownInRow(videoClipButton.current)}
              drafts={drafts}
              draftsInRow={() => shownInRow(draftsButton.current)}
              schedule={scheduling && { schedulable, onSchedule: scheduleWritten, onCustomTime: () => setPickingTime(true) }}
              scheduleInRow={() => shownInRow(scheduleButton.current)}
              onClosed={() => editor.current?.focus()}
              // Slack's + sits in a circle of its own.
              className={cn(BUTTON, "rounded-full bg-hover hover:not-active:brightness-95 aria-expanded:brightness-95")}
            />
            <ShortcutTooltip label={formattingShown ? "Hide formatting" : "Show formatting"}>
              <button
                type="button"
                disabled={disabled}
                aria-label="Show formatting"
                aria-pressed={formattingShown}
                // Keep focus in the editor, so a phone's keyboard stays up, as Send does.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  showFormatting(!formattingShown);
                  editor.current?.focus();
                }}
                className={TOOL}
              >
                <TextSquare className="size-[18px] opacity-70" />
              </button>
            </ShortcutTooltip>
            <EmojiButton
              disabled={disabled || !editorReady}
              onPick={(emoji) => editor.current?.insertText(emoji)}
              onClosed={() => editor.current?.focus()}
              className={TOOL}
            />
            <ShortcutTooltip label="Mention someone">
              <button
                type="button"
                disabled={disabled || !editorReady}
                aria-label="Mention someone"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => editor.current?.startMention()}
                className={TOOL}
              >
                <AtSign className="size-[18px] opacity-70" />
              </button>
            </ShortcutTooltip>
            {/* The row has no room for these on touch screens, nor in a composer too narrow for its eight buttons,
                where + has them, as Slack's apps' + does. A line parts each group of the row's buttons from the
                one before, as in Slack's. */}
            {clips && (
              <>
                <Divider className={clipButton} />
                <ShortcutTooltip label="Record video clip">
                  <button
                    ref={videoClipButton}
                    type="button"
                    disabled={disabled}
                    aria-label="Record video clip"
                    onClick={() => setRecordingClip("video")}
                    className={cn(TOOL, clipButton)}
                  >
                    <VideoCamera className="size-[18px] opacity-70" />
                  </button>
                </ShortcutTooltip>
                <ShortcutTooltip label="Record audio clip">
                  <button type="button" disabled={disabled} aria-label="Record audio clip" onClick={() => setRecordingClip("audio")} className={cn(TOOL, clipButton)}>
                    <Microphone className="size-[18px] opacity-70" />
                  </button>
                </ShortcutTooltip>
              </>
            )}
            {onCommand && <Divider className="touch:hidden" />}
            {onCommand && (
              <ShortcutTooltip label="Run shortcut">
                <button
                  type="button"
                  disabled={disabled || !editorReady}
                  aria-label="Run shortcut"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => editor.current?.startCommand()}
                  className={TOOL}
                >
                  <SlashSquare className="size-[18px] opacity-70" />
                </button>
              </ShortcutTooltip>
            )}
            {/* For fingers, the box sits far enough into its label for a fingertip on it to land on the label. Where
                the buttons would leave the label too little room, it takes a line of its own above them, with its
                box over the middle of +: under 34.625rem, with the clips' two more, the lines and Schedule for
                later's chevron, as in a thread beside its room, and a huddle's, which leaves room for fingers'
                bigger buttons too, as on a phone held upright. A button added to the row takes room from the
                label, so this grows with it, as for Manage drafts, whose room is kept while it isn't there, so the
                label doesn't move as it comes. */}
            {threadId !== undefined && (
              <label className="mr-2 ml-2.5 flex min-w-0 cursor-pointer items-center gap-[7px] text-[13px] leading-[18px] text-message-muted @max-[34.625rem]:order-first @max-[34.625rem]:mr-0 @max-[34.625rem]:ml-2 @max-[34.625rem]:min-h-7 @max-[34.625rem]:basis-full touch:ml-0 touch:min-h-11 touch:pl-3.5 touch:text-sm">
                <input
                  type="checkbox"
                  checked={alsoSend}
                  disabled={disabled}
                  onChange={(event) => setAlsoSend(event.target.checked)}
                  className="m-0 size-4 flex-none cursor-pointer accent-foreground"
                />
                <span className="truncate">
                  {direct ? (
                    "Also send as direct message"
                  ) : (
                    <>
                      Also send to <strong className="font-semibold text-message-ink">#{roomName}</strong>
                    </>
                  )}
                </span>
              </label>
            )}
            <div className="ml-auto flex items-center gap-0.5">
              {/* Once there's something written, or put aside, to list, as Slack's shows once something's written. */}
              {drafts && (!blank || saved.length > 0) && (
                <DraftsMenu
                  ref={draftsButton}
                  drafts={drafts}
                  disabled={disabled || !editorReady}
                  onClosed={() => editor.current?.focus()}
                  className={cn(TOOL, onCommand ? DRAFTS_BUTTON : DRAFTS_BUTTON_WITHOUT_SHORTCUT)}
                />
              )}
              <div className="flex items-center">
                <ShortcutTooltip label="Send message">
                  <button
                    type="submit"
                    disabled={disabled || scheduleAwaited}
                    data-empty={(blank && picked.files.length === 0) || undefined}
                    // Keep focus in the editor, so a phone's keyboard stays up between messages.
                    onMouseDown={(event) => event.preventDefault()}
                    className={cn(
                      BUTTON,
                      "rounded-full bg-foreground text-background hover:not-active:brightness-70",
                      // Slack's paper plane is grey, with nothing behind it, until there's something to send.
                      "data-empty:bg-transparent data-empty:text-muted-foreground data-empty:hover:not-active:brightness-100",
                      "disabled:pointer-events-none disabled:opacity-50 disabled:grayscale disabled:contrast-50",
                      scheduling && (onCommand ? SEND_BESIDE_SCHEDULE : SEND_BESIDE_SCHEDULE_WITHOUT_SHORTCUT),
                    )}
                  >
                    <Send className="size-[18px]" />
                    <span className="sr-only">Send Message</span>
                  </button>
                </ShortcutTooltip>
                {scheduling && (
                  <ScheduleMenu
                    ref={scheduleButton}
                    disabled={disabled || !schedulable}
                    onSchedule={scheduleWritten}
                    onCustomTime={() => setPickingTime(true)}
                    onClosed={() => editor.current?.focus()}
                    className={cn(
                      SCHEDULE_BUTTON,
                      onCommand ? SCHEDULE_BUTTON_SHOWN : SCHEDULE_BUTTON_SHOWN_WITHOUT_SHORTCUT,
                      // Grey as Send is while there's nothing to schedule, and faded as it is while the room's away.
                      schedulable ? "bg-foreground text-background hover:not-active:brightness-70" : "border-muted-foreground/25 bg-transparent text-muted-foreground",
                      disabled && "opacity-50 grayscale contrast-50",
                    )}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </form>
      {/* Outside the form, so what's typed in them is kept from the composer's own handlers. */}
      <LinkDialog formatting={formatting} />
      <SnippetDialog open={writingSnippet} onOpenChange={setWritingSnippet} onCreate={(file) => picked.add([file])} onClosed={() => editor.current?.focus()} />
      {notifyConfirm.dialog}
      {scheduling && (
        <>
          <CustomTimeDialog open={pickingTime} onOpenChange={setPickingTime} onPick={scheduleWritten} onClosed={() => editor.current?.focus()} />
          <ScheduledDialog
            open={listingScheduled}
            onOpenChange={setListingScheduled}
            messages={scheduledHere}
            roomId={roomId}
            place={place}
            scheduling={scheduling}
            onClosed={() => editor.current?.focus()}
          />
        </>
      )}
      {recordingClip === "video" && (
        <Suspense fallback={null}>
          <VideoClipDialog onRecorded={(clip) => picked.add([clip])} onClose={closeClip} />
        </Suspense>
      )}
    </footer>
  );
}

/**
 * What stands in the composer's place in a room that's gone: deleted, or no longer this person's. Its
 * span is inline, so its width, centering and shake don't take; this has them, as its classes mean.
 */
export function RoomDeleted() {
  return (
    <footer className={FOOTER}>
      <p role="alert" className="rounded-lg border border-negative px-[0.8em] py-[0.5em] text-center text-base text-negative motion-safe:animate-shake">
        This room was deleted.
      </p>
    </footer>
  );
}
