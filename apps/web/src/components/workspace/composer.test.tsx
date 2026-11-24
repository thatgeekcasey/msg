import { MAX_FILE_SIZE, SCHEDULE_TIME_REFUSED, THREAD_DELETED, type LinkPreview, type NotifiedCounts, type ScheduledMessage } from "@ember/protocol";
import { MENTION_CONTENT_TYPE, OPENGRAPH_EMBED_CONTENT_TYPE, previewContent, ROOM_MENTION_CONTENT_TYPE, type SpecialMention } from "@ember/richtext/dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { RoomsContext, type Rooms } from "@/hooks/use-rooms";
import { previewOf } from "@/lib/previews";
import type { Typist } from "@/lib/room-state";
import { SHRUG, SLASH_COMMANDS, type CommandRunner, type WrittenCommand } from "@/lib/slash-commands";
import { installRecording, lastRecorder } from "@/test-recording";
import { createRef, type ReactNode } from "react";
import { Composer, RoomDeleted, type AddPreview, type ComposerHandle, type ComposerScheduling } from "./composer";
import { editorLoaded } from "./editor";

// The editor here is test-setup.ts's stand-in for Lexxy, a text box whose lines are one paragraph,
// and every test starts before its code has loaded.
vi.mock("./editor", async (importOriginal) => ({ ...(await importOriginal<typeof import("./editor")>()), editorLoaded: vi.fn(() => false) }));

// Of the pages few visits need, the clips' recorders, which are all the composer loads of them, without the rest,
// which take a while to load here.
vi.mock("./pages", () => import("./clip-recorders"));

// A video's poster, which jsdom can't decode one to take: none, unless a test makes one.
vi.mock("@/lib/previews", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/previews")>()), previewOf: vi.fn(async () => null) }));

// The emoji picker, without Emojibase's data, which isn't served here: one emoji to pick.
vi.mock("./emoji-panel", () => ({
  default: ({ onPick }: { onPick: (emoji: string) => void }) => (
    <button type="button" onClick={() => onPick("🎉")}>
      🎉
    </button>
  ),
}));

/** What `onSend` answers for a message that went, where nothing's to come after it. */
const went: AddPreview = () => {};

/** The workspace as the app has it, but whether it warns before a message notifies a room of six or more. */
function Warning({ on, children }: { on: boolean; children: ReactNode }) {
  return <AccountContext value={{ ...useAccount(), warnBeforeNotifying: on }}>{children}</AccountContext>;
}

async function showComposer({
  typing = [] as Typist[],
  disabled = false,
  roomId = "r1",
  threadId = undefined as string | undefined,
  direct = false,
  autoFocus = true,
  mentionsAbove = false,
  warns = true,
  onCommand = undefined as CommandRunner | undefined,
  rooms = null as Rooms | null,
  people = new Map() as People,
  scheduling = undefined as ComposerScheduling | undefined,
} = {}) {
  // Hears a link's preview that comes once the message has gone.
  const addPreview = vi.fn((_preview: LinkPreview) => {});
  const onSend = vi.fn((_body: string, _alsoSend: boolean): AddPreview | null => addPreview);
  const onSendFiles = vi.fn((_files: File[], _alsoSend: boolean) => {});
  const onTyping = vi.fn();
  const composer = createRef<ComposerHandle>();
  const view = render(
    <Warning on={warns}>
      <PeopleContext value={people}>
        <RoomsContext value={rooms}>
          <Composer
            ref={composer}
            roomId={roomId}
            roomName="general"
            direct={direct}
            userId="u1"
            typing={typing}
            disabled={disabled}
            threadId={threadId}
            onSend={onSend}
            onSendFiles={onSendFiles}
            onTyping={onTyping}
            autoFocus={autoFocus}
            mentionsAbove={mentionsAbove}
            commands={onCommand && SLASH_COMMANDS}
            onCommand={onCommand}
            scheduling={scheduling}
          />
        </RoomsContext>
      </PeopleContext>
    </Warning>,
  );
  // The editor loads as the first composer shows.
  const input = await within(view.container).findByRole("textbox", { name: threadId === undefined ? "Write a message" : "Write a reply" });
  return { onSend, addPreview, onSendFiles, onTyping, composer, view, user: userEvent.setup(), input };
}

function touchScreen() {
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: media === "(pointer: coarse)", media, addEventListener() {}, removeEventListener() {} }));
}

const sendButton = () => screen.getByRole("button", { name: "Send Message" });
const showFormatting = () => screen.getByRole("button", { name: "Show formatting" });
const formattingRow = () => screen.queryByRole("toolbar", { name: "Formatting" });
const tool = (name: string) => within(formattingRow()!).getByRole("button", { name });
/** The file picker that Upload from your computer and Cmd or Ctrl+O open. */
const fileField = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(editorLoaded).mockReturnValue(false);
  vi.mocked(previewOf).mockReset();
});

describe("Composer", () => {
  it("has the formatting row over the text box, and Slack's buttons below it in Slack's order", async () => {
    const { input, view } = await showComposer();
    expect(formattingRow()).toBeInTheDocument();
    expect(input).toHaveAttribute("placeholder", "Message #general");
    const below = [...view.container.querySelectorAll("form button")].filter((button) => !button.closest("[role=toolbar]"));
    expect(below.map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Attach", "Show formatting", "Emoji", "Mention someone", "Send Message"]);
    expect(fileField()).toHaveAttribute("multiple");
    expect(fileField()).not.toBeVisible();
  });

  it("focuses the text box as the room opens", async () => {
    const { input } = await showComposer();
    expect(input).toHaveFocus();
  });

  it("waits for a tap on touch screens, whose keyboard would cover the room", async () => {
    touchScreen();
    const { input } = await showComposer();
    expect(input).not.toHaveFocus();
  });

  it("lists the people @ finds above the text on touch screens, whose keyboard is under it", async () => {
    touchScreen();
    expect((await showComposer()).input).toHaveAttribute("data-mentions-above");
  });

  it("offers @here and @channel from @ in a room's own composer, but not a thread's or a DM's, where they'd notify nobody", async () => {
    const asked = [];
    for (const props of [{}, { threadId: "m1" }, { direct: true }]) {
      const { input, view } = await showComposer(props);
      asked.push(input.getAttribute("data-mentions-from"));
      view.unmount();
    }
    expect(asked).toEqual(["/api/autocompletable/users?room_id=r1&special_mentions=1", "/api/autocompletable/users?room_id=r1", "/api/autocompletable/users?room_id=r1"]);
  });

  it("offers the rooms you're in from #, in a room's composer, a thread's and a DM's, and none until they've loaded", async () => {
    const rooms: Rooms = new Map([
      ["r1", { id: "r1", kind: "open", name: "general", icon: null }],
      ["r2", { id: "r2", kind: "closed", name: "Plans", icon: "rocket" }],
    ]);
    for (const props of [{}, { threadId: "m1" }, { direct: true }]) {
      const { input, view } = await showComposer({ ...props, rooms });
      expect(input).toHaveAttribute("data-rooms", "r1 r2");
      view.unmount();
    }
    expect((await showComposer()).input).toHaveAttribute("data-rooms", "");
  });

  it("lists them above the text with a mouse only where it's asked to, as where something under the composer would cut the list off", async () => {
    const { input, view } = await showComposer();
    expect(input).not.toHaveAttribute("data-mentions-above");
    view.unmount();
    expect((await showComposer({ mentionsAbove: true })).input).toHaveAttribute("data-mentions-above");
  });

  const room = { roomId: "r1", roomName: "general", userId: "u1", typing: [], disabled: false, onSend: () => went, onSendFiles: () => {}, onTyping: () => {} };

  it("holds the editor back while the room's first messages are on their way, which loading it would delay", async () => {
    // React has the editor's code from an earlier composer, so it would show at once if it weren't held back.
    (await showComposer()).view.unmount();
    const view = render(<Composer {...room} deferEditor />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Message #general")).toBeInTheDocument();

    view.rerender(<Composer {...room} deferEditor={false} />);
    expect(await screen.findByRole("textbox", { name: "Write a message" })).toHaveFocus();
  });

  it("shows the editor at once when it has loaded for a room before", async () => {
    vi.mocked(editorLoaded).mockReturnValue(true);
    render(<Composer {...room} deferEditor />);
    expect(await screen.findByRole("textbox", { name: "Write a message" })).toHaveFocus();
  });

  it("leaves focus where it's been put while the editor was held back", async () => {
    (await showComposer()).view.unmount();
    const page = (deferEditor: boolean) => (
      <>
        <button type="button">Elsewhere</button>
        <Composer {...room} deferEditor={deferEditor} />
      </>
    );
    const view = render(page(true));
    screen.getByRole("button", { name: "Elsewhere" }).focus();

    view.rerender(page(false));
    expect(await screen.findByRole("textbox", { name: "Write a message" })).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  });

  it("takes focus from the last room's composer, which goes as this one opens", async () => {
    const { view } = await showComposer();
    view.rerender(<Composer key="r2" {...room} roomId="r2" />);
    expect(await screen.findByRole("textbox", { name: "Write a message" })).toHaveFocus();
  });
});

describe("Group DMs and DM names", () => {
  it("asks for a message to the others in a DM by name, without the #", async () => {
    render(<Composer roomId="d1" roomName="Grace and Linus" direct userId="u1" typing={[]} disabled={false} onSend={() => went} onSendFiles={() => {}} onTyping={() => {}} />);
    expect(await screen.findByRole("textbox", { name: "Write a message" })).toHaveAttribute("placeholder", "Message Grace and Linus");
  });
});

describe("Formatting row", () => {
  it("hides the row while Show formatting is let go, keeping focus in the text, as this browser remembers", async () => {
    const { input, user, view } = await showComposer();
    const form = view.container.querySelector("form")!;
    expect(showFormatting()).toHaveAttribute("aria-pressed", "true");
    expect(form).toHaveAttribute("data-formatting");

    await user.click(showFormatting());
    expect(showFormatting()).toHaveAttribute("aria-pressed", "false");
    expect(formattingRow()).not.toBeInTheDocument();
    expect(form).not.toHaveAttribute("data-formatting");
    expect(input).toHaveFocus();

    view.unmount();
    await showComposer();
    expect(formattingRow()).not.toBeInTheDocument();
    await user.click(showFormatting());
    expect(formattingRow()).toBeInTheDocument();
  });

  it("starts hidden on touch screens, whose keyboard leaves the composer little room", async () => {
    touchScreen();
    await showComposer();
    expect(formattingRow()).not.toBeInTheDocument();
    expect(showFormatting()).toHaveAttribute("aria-pressed", "false");
  });

  it("has Slack's buttons in Slack's order, each named with its keys", async () => {
    await showComposer();
    expect(within(formattingRow()!).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Bold",
      "Italic",
      "Underline",
      "Strikethrough",
      "Paragraph",
      "Link",
      "Ordered list",
      "Bulleted list",
      "Blockquote",
      "Code",
      "Code block",
      "Divider",
    ]);
    expect(tool("Strikethrough")).toHaveAttribute("aria-keyshortcuts", "Control+Shift+X");
    expect(tool("Link")).toHaveAttribute("aria-keyshortcuts", "Control+Shift+U");
    expect(tool("Divider")).not.toHaveAttribute("aria-keyshortcuts");
  });

  it("lights a button while its formatting is on where the cursor is, keeping focus in the text", async () => {
    const { input, user } = await showComposer();
    await user.click(tool("Bold"));
    await user.click(tool("Bulleted list"));
    expect(tool("Bold")).toHaveAttribute("aria-pressed", "true");
    expect(tool("Bulleted list")).toHaveAttribute("aria-pressed", "true");
    expect(tool("Ordered list")).toHaveAttribute("aria-pressed", "false");
    expect(input).toHaveFocus();

    await user.click(tool("Ordered list"));
    expect(tool("Bulleted list")).toHaveAttribute("aria-pressed", "false");
    expect(tool("Ordered list")).toHaveAttribute("aria-pressed", "true");
  });

  it("formats from Slack's keys, with the row hidden too, leaving Cmd or Ctrl+B, I and U to the editor", async () => {
    const { input, user } = await showComposer();
    await user.type(input, "struck");
    await user.keyboard("{Control>}{Shift>}X{/Shift}{/Control}");
    expect(tool("Strikethrough")).toHaveAttribute("aria-pressed", "true");

    await user.click(showFormatting());
    await user.keyboard("{Control>}{Shift>}({/Shift}{/Control}");
    await user.click(showFormatting());
    expect(tool("Blockquote")).toHaveAttribute("aria-pressed", "true");

    await user.keyboard("{Control>}b{/Control}");
    expect(tool("Bold")).toHaveAttribute("aria-pressed", "false");
  });

  it("styles the line from the Paragraph menu, its style ticked, and puts focus back in the text", async () => {
    const { input, user } = await showComposer();
    await user.click(tool("Paragraph"));
    expect(screen.getByRole("menuitemradio", { name: "Paragraph" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Paragraph", "Big headingH1", "Medium headingH2", "Small headingH3"]);

    await user.click(screen.getByRole("menuitemradio", { name: /Medium heading/ }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());

    await user.click(tool("Paragraph"));
    expect(screen.getByRole("menuitemradio", { name: /Medium heading/ })).toHaveAttribute("aria-checked", "true");
  });

  it("greys out what a code block has no use for, and its keys", async () => {
    const { input, user } = await showComposer();
    await user.click(tool("Code block"));
    expect(tool("Code block")).toHaveAttribute("aria-pressed", "true");
    for (const name of ["Bold", "Italic", "Underline", "Strikethrough", "Link", "Code", "Divider"]) expect(tool(name), name).toBeDisabled();
    for (const name of ["Paragraph", "Ordered list", "Bulleted list", "Blockquote", "Code block"]) expect(tool(name), name).toBeEnabled();

    input.focus();
    await user.keyboard("{Control>}{Shift>}X{/Shift}{/Control}");
    await user.click(tool("Code block"));
    expect(tool("Strikethrough")).toBeEnabled();
    expect(tool("Strikethrough")).toHaveAttribute("aria-pressed", "false");
  });

  it("is one stop in the tab order, whose arrow keys move along it, and Escape goes back to the text", async () => {
    const { input, user } = await showComposer();
    await user.tab({ shift: true });
    expect(tool("Bold")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(tool("Italic")).toHaveFocus();
    await user.keyboard("{End}");
    expect(tool("Divider")).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(tool("Bold")).toHaveFocus();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(tool("Code block")).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(input).toHaveFocus();
    await user.tab({ shift: true });
    expect(tool("Code block")).toHaveFocus();
  });

  it("formats from the keyboard, leaving focus on the button for the next", async () => {
    const { user } = await showComposer();
    await user.tab({ shift: true });
    await user.keyboard("{Enter}");
    expect(tool("Bold")).toHaveAttribute("aria-pressed", "true");
    expect(tool("Bold")).toHaveFocus();
    await user.keyboard("{ArrowRight} ");
    expect(tool("Italic")).toHaveAttribute("aria-pressed", "true");
    expect(tool("Italic")).toHaveFocus();
  });
});

describe("Link", () => {
  /** The composer, `text` written in it, and `selected` selected, or else the cursor after the text. */
  async function written(text: string, selected = "") {
    const shown = await showComposer();
    await shown.user.type(shown.input, text);
    if (selected) {
      const start = text.indexOf(selected);
      (shown.input as HTMLTextAreaElement).setSelectionRange(start, start + selected.length);
    }
    return shown;
  }

  it("links what's selected through Link's dialog, taking an address without a scheme as a web address", async () => {
    const { input, user } = await written("Read the docs", "the docs");
    await user.click(tool("Link"));
    const dialog = screen.getByRole("dialog", { name: "Add link" });
    expect(within(dialog).getByLabelText("Text")).toHaveValue("the docs");
    expect(within(dialog).getByLabelText("Link")).toHaveFocus();
    expect(within(dialog).queryByRole("button", { name: "Remove link" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Link"), "example.com/docs{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveAttribute("data-linked", "https://example.com/docs"));
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Read the docs");
    expect(tool("Link")).toHaveAttribute("aria-pressed", "true");
  });

  it("opens from Cmd or Ctrl+Shift+U and Cmd or Ctrl+K, with the row hidden too, starting at the text with nothing selected", async () => {
    const { input, user } = await written("See ");
    await user.click(showFormatting());
    await user.keyboard("{Control>}{Shift>}U{/Shift}{/Control}");
    const dialog = screen.getByRole("dialog", { name: "Add link" });
    expect(within(dialog).getByLabelText("Text")).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("dialog", { name: "Add link" })).toBeInTheDocument();
  });

  it("writes the address as the text when the text's left blank, and leaves the text as it was on Cancel", async () => {
    const { input, user } = await written("See ");
    await user.click(tool("Link"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue("See ");

    await user.click(tool("Link"));
    await user.type(within(screen.getByRole("dialog")).getByLabelText("Link"), "https://example.com{Enter}");
    await waitFor(() => expect(input).toHaveValue("See https://example.com"));
  });

  it("edits the link the cursor is in, or takes it off, keeping its text", async () => {
    const { input, user } = await written("Read the docs", "the docs");
    await user.click(tool("Link"));
    await user.type(within(screen.getByRole("dialog")).getByLabelText("Link"), "example.com{Enter}");
    await waitFor(() => expect(input).toHaveAttribute("data-linked"));

    await user.click(tool("Link"));
    const dialog = screen.getByRole("dialog", { name: "Edit link" });
    expect(within(dialog).getByLabelText("Link")).toHaveValue("https://example.com");
    await user.click(within(dialog).getByRole("button", { name: "Remove link" }));
    await waitFor(() => expect(input).not.toHaveAttribute("data-linked"));
    expect(input).toHaveValue("Read the docs");
    expect(tool("Link")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("Send from the keyboard", () => {
  it("sends what's written on Enter, then empties the box and keeps focus", async () => {
    const { onSend, input, user } = await showComposer();
    await user.type(input, "Hello there{Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith("<p>Hello there</p>", false);
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
  });

  it("starts a new line on Shift+Enter instead of sending", async () => {
    const { onSend, input, user } = await showComposer();
    await user.type(input, "line one{Shift>}{Enter}{/Shift}line two");
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("line one\nline two");

    await user.click(sendButton());
    expect(onSend).toHaveBeenCalledWith("<p>line one<br>line two</p>", false);
  });

  it("sends on Enter with the formatting row showing, as Slack's does, and keeps the row", async () => {
    const { onSend, input, user } = await showComposer();
    await user.type(input, "one{Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith("<p>one</p>", false);
    expect(formattingRow()).toBeInTheDocument();
  });

  it("sends only from the Send button on touch screens", async () => {
    touchScreen();
    const { onSend, input, user } = await showComposer();
    await user.type(input, "Hi{Enter}");
    expect(onSend).not.toHaveBeenCalled();

    await user.click(sendButton());
    expect(onSend).toHaveBeenCalledOnce();
    expect(input).toHaveFocus();
  });

  it("won't send a blank message, though Send stays enabled", async () => {
    const { onSend, input, user } = await showComposer();
    expect(sendButton()).toBeEnabled();
    await user.type(input, "   {Enter}");
    await user.click(sendButton());
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
  });

  it("keeps what's written when the room won't take it, as when it's too long", async () => {
    const { onSend, input, user } = await showComposer();
    onSend.mockReturnValue(null);
    await user.type(input, "Too much{Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith("<p>Too much</p>", false);
    expect(input).toHaveValue("Too much");
    expect(input).toHaveFocus();
    expect(localStorage.getItem("composer-draft-u1-r1")).toBe("<p>Too much</p>");
  });

  it("holds on to the text while the room is disconnected", async () => {
    const { onSend, input, user } = await showComposer({ disabled: true });
    await user.type(input, "Are you there?{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("Are you there?");
    expect(sendButton()).toBeDisabled();
  });
});

describe("Ask before notifying a room", () => {
  /** Answers the composer's ask for whom the room's special mentions notify with `answer`, or fails it. */
  function counts(answer: NotifiedCounts | Error) {
    const fetch = vi.fn(async (_path: string) => {
      if (answer instanceof Error) throw answer;
      return Response.json(answer);
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  /** A room of six, from which @here would notify two and @channel the other five. */
  const six: NotifiedCounts = { members: 6, mentions: { here: 2, channel: 5 } };
  /** How the composer writes the special mention `name`, picked from @'s list. */
  const special = (name: SpecialMention) => `<action-text-attachment sgid="${name}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;
  const asking = () => screen.queryByRole("dialog");

  it("asks before @channel notifies a room of six or more, as Slack asks, sending on Send, which Enter presses", async () => {
    const fetch = counts(six);
    const { onSend, input, user } = await showComposer();
    await user.type(input, "@channel Standup{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Notify 5 people?" });
    expect(dialog).toHaveAccessibleDescription("@channel notifies everyone in #general.");
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/rooms/r1/notified"]);
    expect(onSend).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Send" })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith(`<p>${special("channel")} Standup</p>`, false);
    await waitFor(() => expect(asking()).not.toBeInTheDocument());
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
  });

  it("goes back to what's written on Cancel or Escape, with focus", async () => {
    counts(six);
    const { onSend, input, user } = await showComposer();
    await user.type(input, "@here Lunch?{Enter}");
    expect(await screen.findByRole("dialog", { name: "Notify 2 people?" })).toHaveAccessibleDescription("@here notifies everyone active in #general.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(asking()).not.toBeInTheDocument());
    expect(input).toHaveValue("@here Lunch?");
    expect(input).toHaveFocus();

    await user.click(sendButton());
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(asking()).not.toBeInTheDocument());
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("@here Lunch?");
  });

  it("counts the widest special mention the message makes that would notify the room, as @everyone in an open room", async () => {
    counts({ members: 40, mentions: { here: 3, channel: 39, everyone: 39 } });
    const { input, user } = await showComposer();
    await user.type(input, "@here @everyone Party at 5{Enter}");
    expect(await screen.findByRole("dialog", { name: "Notify 39 people?" })).toHaveAccessibleDescription("@everyone notifies everyone in the workspace.");
  });

  it("sends at once in a room of five, or where the mention would notify nobody from its writer, nor anyone at all", async () => {
    const { onSend, input, user } = await showComposer();
    counts({ members: 5, mentions: { here: 4, channel: 4 } });
    await user.type(input, "@channel Standup{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    // Those of @everyone count, which only an open room's has.
    counts({ members: 30, mentions: { here: 6, channel: 29 } });
    await user.type(input, "@everyone Party{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    counts({ members: 30, mentions: { here: 0, channel: 29 } });
    await user.type(input, "@here Anyone?{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(3));
    expect(asking()).not.toBeInTheDocument();
  });

  it("sends at once when the room's counts don't come, as it did before it asked", async () => {
    counts(new TypeError("Failed to fetch"));
    const { onSend, input, user } = await showComposer();
    await user.type(input, "@channel Standup{Enter}");
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(input).toHaveValue("");
  });

  it("asks nothing where the workspace has the warning off, nor in a thread's composer or a DM's, whose messages notify nobody, nor of a message without one", async () => {
    const fetch = counts(six);
    for (const props of [{ warns: false }, { threadId: "m1" }, { direct: true }]) {
      const { onSend, input, user, view } = await showComposer(props);
      await user.type(input, "@channel Standup{Enter}");
      expect(onSend).toHaveBeenCalledOnce();
      view.unmount();
    }
    const { onSend, input, user } = await showComposer();
    await user.type(input, "Standup at 10{Enter}");
    expect(onSend).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks once however often Send is pressed while the room's counts are on their way, and sends the files picked only with the message", async () => {
    let answer!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal("fetch", fetch);
    const { onSend, onSendFiles, input, user } = await showComposer();
    await user.upload(fileField(), fileOf("agenda.txt"));
    await user.type(input, "@channel Agenda{Enter}");
    await user.click(sendButton());
    expect(fetch).toHaveBeenCalledOnce();
    expect(onSendFiles).not.toHaveBeenCalled();

    answer(Response.json(six));
    const dialog = await screen.findByRole("dialog");
    expect(screen.getAllByRole("dialog")).toEqual([dialog]);
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(onSendFiles).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ name: "agenda.txt" })], false);
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("asks of what's written as the room's counts come, written over while they were on their way, and sends that", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
    const { onSend, input, user } = await showComposer();
    await user.type(input, "@here Lunch?{Enter}");
    await user.clear(input);
    await user.type(input, "@channel Lunch?");
    answer(Response.json(six));
    const dialog = await screen.findByRole("dialog", { name: "Notify 5 people?" });
    expect(dialog).toHaveAccessibleDescription("@channel notifies everyone in #general.");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(`<p>${special("channel")} Lunch?</p>`, false);

    // Without its mention by then, it goes without asking.
    await user.type(input, "@channel Standup{Enter}");
    await user.clear(input);
    await user.type(input, "Standup");
    answer(Response.json(six));
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("<p>Standup</p>", false));
    expect(asking()).not.toBeInTheDocument();
  });

  it("sends the files picked as it goes, though some were picked or removed while the room's counts were on their way", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
    const { onSendFiles, input, user } = await showComposer();
    await user.upload(fileField(), [fileOf("agenda.txt"), fileOf("notes.txt")]);
    await user.type(input, "@channel Agenda{Enter}");
    await user.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    await user.upload(fileField(), fileOf("slides.pdf"));
    answer(Response.json(six));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Send" }));
    expect(onSendFiles).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ name: "agenda.txt" }), expect.objectContaining({ name: "slides.pdf" })], false);
    expect(chips()).toEqual([]);
  });

  it("asks of /shrug's message as what's written reads when the room's counts come, written over while they were on their way, and sends that", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))));
    const { onSend, input, user } = await showComposer({ onCommand: vi.fn(async () => true) });
    await user.type(input, "/shrug @here Lunch?{Enter}");
    await user.clear(input);
    await user.type(input, "/shrug @channel Lunch?");
    answer(Response.json(six));
    const dialog = await screen.findByRole("dialog", { name: "Notify 5 people?" });
    await user.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(`<p>${special("channel")} Lunch? ${SHRUG}</p>`, false);
    expect(input).toHaveValue("");

    // Written over as a message by then, it goes as one, without asking where it's lost its mention.
    await user.type(input, "/shrug @channel Standup{Enter}");
    await user.clear(input);
    await user.type(input, "Standup");
    answer(Response.json(six));
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("<p>Standup</p>", false));
    expect(asking()).not.toBeInTheDocument();
  });

  it("sends nothing where what's written has become a command while the room's counts were on their way, which runs once it's sent again", async () => {
    let answer!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal("fetch", fetch);
    const onCommand = vi.fn<CommandRunner>(async () => true);
    const { onSend, input, user } = await showComposer({ onCommand });
    for (const first of ["/shrug @here hello", "@here hello"]) {
      await user.type(input, `${first}{Enter}`);
      await user.clear(input);
      await user.type(input, "/msg @Ada private text");
      answer(Response.json(six));
      await act(async () => {});
      expect(onSend).not.toHaveBeenCalled();
      expect(asking()).not.toBeInTheDocument();
      expect(input).toHaveValue("/msg @Ada private text");
      await user.clear(input);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onCommand).not.toHaveBeenCalled();

    await user.type(input, "/msg @Ada private text{Enter}");
    expect(onCommand).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  /** Runs a command as /msg does, sending `body` to #design, which it says whether to send. */
  function sendsToDesign(body: string) {
    const asked: Promise<boolean>[] = [];
    const onCommand = vi.fn<CommandRunner>((_written, askToNotify) => asked[asked.push(askToNotify({ id: "r2", name: "design" }, body)) - 1]!);
    return { onCommand, asked };
  }

  it("asks of a message a command sends to a room, of that room, settling with whether it's to go: one that's not is written again", async () => {
    const fetch = counts(six);
    const { onCommand, asked } = sendsToDesign(`<p>${special("channel")} See the brief</p>`);
    const { input, user } = await showComposer({ onCommand });
    await user.type(input, "/msg #design @channel See the brief{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Notify 5 people?" });
    expect(dialog).toHaveAccessibleDescription("@channel notifies everyone in #design.");
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/rooms/r2/notified"]);
    expect(input).toHaveValue("");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(await asked[0]).toBe(false);
    await waitFor(() => expect(input).toHaveValue("/msg #design @channel See the brief"));
    await waitFor(() => expect(asking()).not.toBeInTheDocument());
    expect(input).toHaveFocus();

    await user.type(input, "{Enter}");
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Send" }));
    expect(await asked[1]).toBe(true);
    expect(input).toHaveValue("");
  });

  it("keeps a command's message as its draft where the composer goes as it asks, as when its room's been left", async () => {
    counts(six);
    const { onCommand, asked } = sendsToDesign(`<p>${special("channel")} See the brief</p>`);
    const { input, user, view } = await showComposer({ onCommand });
    await user.type(input, "/msg #design @channel See the brief{Enter}");
    await screen.findByRole("dialog", { name: "Notify 5 people?" });
    view.unmount();
    expect(await asked[0]).toBe(false);
    await waitFor(() => expect(localStorage.getItem("composer-draft-u1-r1")).toBe(`<p>/msg #design ${special("channel")} See the brief</p>`));
  });
});

/** A file named `name` of `size` bytes, as the browser gives it, which says it's that size without holding them. */
function fileOf(name: string, { type = "text/plain", size = 3 } = {}) {
  const file = new File(["abc"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

/** What's pasted: `files`, and no text. */
const clipboard = (...files: File[]) => ({ files, getData: () => "" });

/** The files waiting to be sent, by their chips' names. */
const chips = () => screen.queryAllByRole("button", { name: /^Remove / }).map((chip) => chip.getAttribute("aria-label"));

/** Makes the thumbnails' addresses `blob:<name>`, answering those made and those let go. */
function thumbnails() {
  const made: string[] = [];
  const revoked: string[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((file) => {
    made.push(`blob:${(file as File).name}`);
    return made.at(-1)!;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => revoked.push(url));
  return { made, revoked };
}

describe("Attach files", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waits to send the files picked with Attach files, in order of their names, however often they're picked", async () => {
    const { user } = await showComposer();
    await user.upload(fileField(), [fileOf("b.txt"), fileOf("A.pdf"), fileOf("a.txt")]);
    expect(chips()).toEqual(["Remove A.pdf", "Remove a.txt", "Remove b.txt"]);

    await user.upload(fileField(), fileOf("a.txt"));
    expect(chips()).toEqual(["Remove A.pdf", "Remove a.txt", "Remove a.txt", "Remove b.txt"]);
    expect(fileField()).toHaveValue("");
  });

  it("shows a picture's thumbnail, and a file icon for anything else, over its name up to its last dot and its extension", async () => {
    const { made } = thumbnails();
    const { user } = await showComposer();
    await user.upload(fileField(), [fileOf("moon.jpg", { type: "image/jpeg" }), fileOf("archive.tar.gz", { type: "application/gzip" }), fileOf("README")]);

    const moon = screen.getByRole("button", { name: "Remove moon.jpg" });
    expect(made).toEqual(["blob:moon.jpg"]);
    expect(moon.querySelector("img")).toHaveAttribute("src", "blob:moon.jpg");
    const archive = screen.getByRole("button", { name: "Remove archive.tar.gz" });
    expect(archive.querySelector("img")).toBeNull();
    expect(archive.querySelector("svg")).toHaveClass("iconoir-page");
    // The name runs to an ellipsis, and the extension doesn't.
    expect(within(archive).getByText("archive.tar.")).toHaveClass("truncate");
    expect(within(archive).getByText("gz")).toHaveClass("shrink-0");
    // A name with no dot shows whole.
    expect(within(screen.getByRole("button", { name: "Remove README" })).getByText("README")).toHaveClass("truncate");
  });

  it("shows a video's poster once it's taken, the one its message will show, as Slack shows a clip, and a file icon until then", async () => {
    const { revoked } = thumbnails();
    let take!: (poster: Blob) => void;
    vi.mocked(previewOf).mockReturnValueOnce(new Promise((resolve) => (take = resolve)));
    const { user } = await showComposer();
    const tour = fileOf("tour.mp4", { type: "video/mp4" });
    await user.upload(fileField(), tour);
    const chip = screen.getByRole("button", { name: "Remove tour.mp4" });
    expect(previewOf).toHaveBeenCalledExactlyOnceWith(tour);
    expect(chip.querySelector("img")).toBeNull();
    expect(chip.querySelector("svg")).toHaveClass("iconoir-page");

    await act(async () => take(new File(["poster"], "tour poster.jpg", { type: "image/jpeg" })));
    expect(chip.querySelector("img")).toHaveAttribute("src", "blob:tour poster.jpg");
    expect(chip.querySelector("svg.iconoir-page")).toBeNull();
    await user.click(chip);
    expect(revoked).toEqual(["blob:tour poster.jpg"]);
  });

  it("takes a file back out when its chip is pressed, letting go of its thumbnail", async () => {
    const { revoked } = thumbnails();
    const { user, onSendFiles } = await showComposer();
    await user.upload(fileField(), [fileOf("moon.jpg", { type: "image/jpeg" }), fileOf("notes.txt")]);
    await user.click(screen.getByRole("button", { name: "Remove moon.jpg" }));
    expect(chips()).toEqual(["Remove notes.txt"]);
    expect(revoked).toEqual(["blob:moon.jpg"]);

    await user.click(sendButton());
    expect(onSendFiles).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ name: "notes.txt" })], false);
  });

  it("sends the files, each as a message of its own, before what's written, and empties the list", async () => {
    const { onSend, onSendFiles, input, user } = await showComposer();
    const [b, a] = [fileOf("b.txt"), fileOf("a.txt")];
    await user.upload(fileField(), [b, a]);
    await user.type(input, "Here they are{Enter}");
    expect(onSendFiles).toHaveBeenCalledExactlyOnceWith([a, b], false);
    expect(onSend).toHaveBeenCalledExactlyOnceWith("<p>Here they are</p>", false);
    expect(onSendFiles.mock.invocationCallOrder[0]).toBeLessThan(onSend.mock.invocationCallOrder[0]!);
    expect(chips()).toEqual([]);
    expect(input).toHaveFocus();
  });

  it("sends the files picked before the editor shows, as its code loads, which what's written waits for", async () => {
    (await showComposer()).view.unmount();
    const onSendFiles = vi.fn();
    const user = userEvent.setup();
    render(<Composer roomId="r1" roomName="general" userId="u1" typing={[]} disabled={false} deferEditor onSend={() => went} onSendFiles={onSendFiles} onTyping={() => {}} />);
    await user.upload(fileField(), fileOf("a.txt"));
    await user.click(sendButton());
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(onSendFiles).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ name: "a.txt" })], false);
    expect(chips()).toEqual([]);
  });

  it("sends files with nothing written", async () => {
    const { onSend, onSendFiles, user } = await showComposer();
    await user.upload(fileField(), fileOf("a.txt"));
    await user.click(sendButton());
    expect(onSendFiles).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();

    // Nor anything at all with nothing picked.
    await user.click(sendButton());
    expect(onSendFiles).toHaveBeenCalledOnce();
  });

  it("holds on to the files while the room is disconnected, when files can't be picked", async () => {
    const { onSendFiles, composer, input, user } = await showComposer({ disabled: true });
    expect(fileField()).toBeDisabled();
    act(() => composer.current!.addFiles([fileOf("a.txt")]));
    await user.type(input, "{Enter}");
    expect(onSendFiles).not.toHaveBeenCalled();
    expect(chips()).toEqual(["Remove a.txt"]);
  });

  it("waits to send the files dropped on the composer, the text box included, as a copy", async () => {
    const { input, view } = await showComposer();
    const form = view.container.querySelector("form")!;
    const dataTransfer = { files: [fileOf("dropped.txt")], dropEffect: "none" };
    // Each is cancelled, so the browser doesn't open the file in place of the page.
    expect(fireEvent.dragEnter(form, { dataTransfer })).toBe(false);
    expect(fireEvent.dragOver(form, { dataTransfer })).toBe(false);
    expect(dataTransfer.dropEffect).toBe("copy");
    expect(fireEvent.drop(form, { dataTransfer })).toBe(false);
    expect(chips()).toEqual(["Remove dropped.txt"]);

    expect(fireEvent.drop(input, { dataTransfer: { files: [fileOf("on the text.txt")] } })).toBe(false);
    expect(chips()).toEqual(["Remove dropped.txt", "Remove on the text.txt"]);
    expect(input).toHaveValue("");
  });

  it("waits to send the files dropped on the room's messages, which the room hands over", async () => {
    const { composer } = await showComposer();
    act(() => composer.current!.addFiles([fileOf("b.txt"), fileOf("a.txt")]));
    expect(chips()).toEqual(["Remove a.txt", "Remove b.txt"]);
  });
});

describe("The buttons under the text", () => {
  afterEach(() => vi.restoreAllMocks());

  // Hidden from screen readers, as everything but the menu is, while the menu's open.
  const attach = () => screen.getByRole("button", { name: "Attach", hidden: true });

  it("greys Send out until something's written or a file's picked, as Slack's is", async () => {
    const { input, user } = await showComposer();
    expect(sendButton()).toHaveAttribute("data-empty");
    await user.type(input, "Hi");
    expect(sendButton()).not.toHaveAttribute("data-empty");

    await user.type(input, "{Enter}");
    expect(sendButton()).toHaveAttribute("data-empty");
    await user.upload(fileField(), fileOf("a.txt"));
    expect(sendButton()).not.toHaveAttribute("data-empty");
  });

  it("offers Text snippet and Upload from your computer from +, an × while they show, which opens the file picker", async () => {
    const { input, user } = await showComposer();
    const picking = vi.spyOn(fileField(), "click").mockImplementation(() => {});
    expect(attach().querySelector("svg")).toHaveClass("iconoir-plus");
    await user.click(attach());
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Text snippetCtrl+Shift+Enter", "Upload from your computerCtrl+O"]);
    expect(screen.getByRole("menuitem", { name: /Upload/ })).toHaveAttribute("aria-keyshortcuts", "Control+O");
    expect(attach().querySelector("svg")).toHaveClass("iconoir-xmark");

    await user.click(screen.getByRole("menuitem", { name: /Upload from your computer/ }));
    expect(picking).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(attach().querySelector("svg")).toHaveClass("iconoir-plus");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("opens the file picker on Cmd or Ctrl+O, and Text snippet on Cmd or Ctrl+Shift+Enter, which doesn't send", async () => {
    const { input, onSend, user } = await showComposer();
    const picking = vi.spyOn(fileField(), "click").mockImplementation(() => {});
    await user.type(input, "Hello");
    await user.keyboard("{Control>}o{/Control}");
    expect(picking).toHaveBeenCalledOnce();

    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    expect(onSend).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog", { name: "Create a text snippet" })).toBeInTheDocument();
  });

  it("adds a text snippet as a text file named after its title, to send with the next message", async () => {
    const { input, onSendFiles, user } = await showComposer();
    await user.click(attach());
    await user.click(screen.getByRole("menuitem", { name: /Text snippet/ }));
    const dialog = await screen.findByRole("dialog", { name: "Create a text snippet" });
    const create = within(dialog).getByRole("button", { name: "Create snippet" });
    await waitFor(() => expect(within(dialog).getByLabelText("Content")).toHaveFocus());
    expect(create).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Content"), "echo hi");
    await user.type(within(dialog).getByLabelText("Title (optional)"), "deploy.sh");
    await user.click(create);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(chips()).toEqual(["Remove deploy.sh"]);
    await waitFor(() => expect(input).toHaveFocus());

    await user.click(sendButton());
    const [snippet] = onSendFiles.mock.calls[0]![0];
    expect(snippet!.type).toBe("text/plain");
    expect(await snippet!.text()).toBe("echo hi");
  });

  it("names an untitled snippet Untitled.txt, and creates it on Cmd or Ctrl+Enter", async () => {
    const { user } = await showComposer();
    await user.keyboard("{Control>}{Shift>}{Enter}{/Shift}{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Create a text snippet" });
    await user.type(within(dialog).getByLabelText("Content"), "First line{Enter}Second line{Control>}{Enter}{/Control}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(chips()).toEqual(["Remove Untitled.txt"]);
  });

  it("writes the emoji picked where the cursor is, and puts focus back in the text", async () => {
    const { input, user } = await showComposer();
    await user.type(input, "Party ");
    await user.click(screen.getByRole("button", { name: "Emoji" }));
    await user.click(await screen.findByRole("button", { name: "🎉" }));
    expect(input).toHaveValue("Party 🎉");
    expect(screen.queryByRole("dialog", { name: "Emoji" })).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("types @ for the people to mention, after a space where the cursor follows a word, keeping focus in the text", async () => {
    const { input, user } = await showComposer();
    await user.click(screen.getByRole("button", { name: "Mention someone" }));
    expect(input).toHaveValue("@");
    expect(input).toHaveFocus();

    await user.type(input, "{Backspace}Thanks");
    await user.click(screen.getByRole("button", { name: "Mention someone" }));
    expect(input).toHaveValue("Thanks @");
  });
});

describe("/ commands", () => {
  const ran = () => vi.fn((_written: WrittenCommand) => Promise.resolve(true));

  it("has Run shortcut after Mention someone, which types / for the commands, before what's written", async () => {
    const { input, view, user } = await showComposer({ onCommand: ran() });
    const below = [...view.container.querySelectorAll("form button")].filter((button) => !button.closest("[role=toolbar]"));
    expect(below.map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Attach", "Show formatting", "Emoji", "Mention someone", "Run shortcut", "Send Message"]);
    expect(input).toHaveAttribute("data-commands", SLASH_COMMANDS.map(({ name }) => name).join(" "));

    await user.click(screen.getByRole("button", { name: "Run shortcut" }));
    expect(input).toHaveValue("/");
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "hello");
    await user.click(screen.getByRole("button", { name: "Run shortcut" }));
    expect(input).toHaveValue("/ hello");
    expect(input).toHaveProperty("selectionStart", 1);
  });

  it("runs the command written rather than sending it, emptying the composer as it starts", async () => {
    const onCommand = ran();
    const { input, onSend, onTyping, user } = await showComposer({ onCommand });
    await user.type(input, "/MUTE  #design{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(onCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ command: SLASH_COMMANDS.find(({ name }) => name === "mute"), typed: { name: "MUTE", argument: "#design" } }), expect.any(Function));
    expect(input).toHaveValue("");
    expect(onTyping).toHaveBeenLastCalledWith(false);
    expect(localStorage.getItem("composer-draft-u1-r1")).toBeNull();
  });

  it("writes a command that didn't run back, to put right", async () => {
    const onCommand = vi.fn(() => Promise.resolve(false));
    const { input, user } = await showComposer({ onCommand });
    await user.type(input, "/mute #nowhere{Enter}");
    await waitFor(() => expect(input).toHaveValue("/mute #nowhere"));
  });

  it("keeps a command that didn't run as its draft where the composer has gone meanwhile, as when its room was left, unless something else is written there", async () => {
    let answer!: (ran: boolean) => void;
    const onCommand = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const first = await showComposer({ onCommand });
    await first.user.type(first.input, "/mute #nowhere{Enter}");
    expect(localStorage.getItem("composer-draft-u1-r1")).toBeNull();
    first.view.unmount();
    await act(async () => answer(false));
    expect(localStorage.getItem("composer-draft-u1-r1")).toBe("<p>/mute #nowhere</p>");

    // The composer, open again, takes it up.
    localStorage.clear();
    const second = await showComposer({ onCommand });
    await second.user.type(second.input, "/mute #nowhere{Enter}");
    second.view.unmount();
    const third = await showComposer({ onCommand });
    await act(async () => answer(false));
    await waitFor(() => expect(within(third.view.container).getByRole("textbox", { name: "Write a message" })).toHaveValue("/mute #nowhere"));
    expect(within(third.view.container).getByText("Mute or unmute a conversation")).toBeInTheDocument();
    third.view.unmount();

    // Though not over what's been written there since.
    localStorage.clear();
    const fourth = await showComposer({ onCommand });
    await fourth.user.type(fourth.input, "/mute #nowhere{Enter}");
    fourth.view.unmount();
    localStorage.setItem("composer-draft-u1-r1", "<p>Something else</p>");
    await act(async () => answer(false));
    expect(localStorage.getItem("composer-draft-u1-r1")).toBe("<p>Something else</p>");
  });

  it("says a / that names no command isn't one, as Slack does, sending nothing until it's changed", async () => {
    const onCommand = ran();
    const { input, onSend, user } = await showComposer({ onCommand });
    await user.type(input, "/r/programming is great{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("/r/programming isn't a command. To send a message that starts with /, put a space before it.");
    expect(onSend).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled();
    expect(input).toHaveValue("/r/programming is great");

    await user.type(input, "{Home} ");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.type(input, "{Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith("<p> /r/programming is great</p>", false);
  });

  it("sends /shrug's message with ¯\\_(ツ)_/¯ at its end, after the files picked", async () => {
    const { input, onSend, onSendFiles, user } = await showComposer({ onCommand: ran() });
    await user.upload(fileField(), fileOf("a.txt"));
    await user.type(input, "/shrug it works{Enter}");
    expect(onSendFiles).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledExactlyOnceWith(`<p>it works ${SHRUG}</p>`, false);
    expect(input).toHaveValue("");
  });

  it("opens Text snippet for /snippet, leaving what follows it written", async () => {
    const { input, user } = await showComposer({ onCommand: ran() });
    await user.type(input, "/snippet{Enter}");
    expect(await screen.findByRole("dialog", { name: "Create a text snippet" })).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("shows a command's usage over the card once its name is written", async () => {
    const { input, user } = await showComposer({ onCommand: ran() });
    await user.type(input, "/invite");
    expect(screen.queryByText("Add someone to a room")).not.toBeInTheDocument();
    await user.type(input, " ");
    expect(screen.getByText("Add someone to a room").parentElement).toHaveTextContent("/invite [@someone] [#room] Add someone to a room");
    await user.clear(input);
    expect(screen.queryByText("Add someone to a room")).not.toBeInTheDocument();
  });

  it("shows the usage of the command a draft opens with", async () => {
    localStorage.setItem("composer-draft-u1-r1", "<p>/invite #design</p>");
    await showComposer({ onCommand: ran() });
    expect(screen.getByText("Add someone to a room").parentElement).toHaveTextContent("/invite [@someone] [#room] Add someone to a room");
  });

  it("sends a message that starts with a / as it is where there are no commands", async () => {
    const { input, onSend, user } = await showComposer();
    expect(screen.queryByRole("button", { name: "Run shortcut" })).not.toBeInTheDocument();
    await user.type(input, "/shrug{Enter}");
    expect(onSend).toHaveBeenCalledExactlyOnceWith("<p>/shrug</p>", false);
  });
});

describe("Clips", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
    vi.restoreAllMocks();
  });

  /** A browser that records clips, and plays nothing. */
  function recordingBrowser() {
    installRecording();
    thumbnails();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  }

  it("has Record video clip and Record audio clip after Mention someone where the browser records, before Run shortcut, as Slack's row has them", async () => {
    recordingBrowser();
    const { view } = await showComposer({ onCommand: vi.fn((_written: WrittenCommand) => Promise.resolve(true)) });
    const below = [...view.container.querySelectorAll("form button")].filter((button) => !button.closest("[role=toolbar]"));
    expect(below.map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
      "Attach",
      "Show formatting",
      "Emoji",
      "Mention someone",
      "Record video clip",
      "Record audio clip",
      "Run shortcut",
      "Send Message",
    ]);
  });

  it("records an audio clip in the card's place, keeping what's written, then waits to send it with the files, and puts focus back in the text", async () => {
    recordingBrowser();
    const { input, onSend, onSendFiles, user } = await showComposer();
    await user.type(input, "Listen to this");
    await user.click(screen.getByRole("button", { name: "Record audio clip" }));
    // It records once the browser lets Ember use the microphone.
    const recording = await screen.findByRole("group", { name: "Record audio clip" });
    const done = await within(recording).findByRole("button", { name: "Done" });
    await waitFor(() => expect(done).toHaveFocus());

    await user.click(done);
    await lastRecorder().end();
    expect(screen.queryByRole("group", { name: "Record audio clip" })).not.toBeInTheDocument();
    expect(chips()).toEqual([expect.stringMatching(/^Remove Audio clip .+\.m4a$/)]);
    expect(input).toHaveValue("Listen to this");
    await waitFor(() => expect(input).toHaveFocus());

    await user.click(sendButton());
    expect(onSendFiles.mock.calls[0]![0].map((file) => file.type)).toEqual(["audio/mp4"]);
    expect(onSend).toHaveBeenCalledExactlyOnceWith("<p>Listen to this</p>", false);
  });

  it("goes back to the text when the audio clip's discarded", async () => {
    recordingBrowser();
    const { input, user } = await showComposer();
    await user.click(screen.getByRole("button", { name: "Record audio clip" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Done" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Record audio clip" })).not.toBeInTheDocument();
    expect(chips()).toEqual([]);
    expect(input).toHaveFocus();
  });

  it("records a video clip in its dialog, which waits to send it with the files, and puts focus back in the text", async () => {
    recordingBrowser();
    const { input, user } = await showComposer();
    await user.click(screen.getByRole("button", { name: "Record video clip" }));
    const dialog = await screen.findByRole("dialog", { name: "Record video clip" });
    const record = within(dialog).getByRole("button", { name: "Record" });
    await waitFor(() => expect(record).toBeEnabled());

    await user.click(record);
    await user.click(within(dialog).getByRole("button", { name: "Stop recording" }));
    await lastRecorder().end();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(chips()).toEqual([expect.stringMatching(/^Remove Video clip .+\.mp4$/)]);
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("offers the clips from + where the row has no room for their buttons, as on touch screens, as Slack's apps do", async () => {
    recordingBrowser();
    const { user } = await showComposer();
    await user.click(screen.getByRole("button", { name: "Attach" }));
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
    await user.keyboard("{Escape}");

    // As the row's styles hide them, which jsdom has none of.
    for (const name of ["Record video clip", "Record audio clip"]) screen.getByRole("button", { name }).style.display = "none";
    await user.click(screen.getByRole("button", { name: "Attach" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Text snippetCtrl+Shift+Enter", "Upload from your computerCtrl+O", "Record a video clip", "Record an audio clip"]);
    expect(screen.getByRole("menuitem", { name: "Record a video clip" })).not.toHaveAttribute("aria-keyshortcuts");

    await user.click(screen.getByRole("menuitem", { name: "Record an audio clip" }));
    const recording = await screen.findByRole("group", { name: "Record audio clip" });
    await waitFor(() => expect(within(recording).getByRole("button", { name: "Done" })).toHaveFocus());
  });

  it("offers no clips where the browser can't record them, as over plain HTTP", async () => {
    const { user } = await showComposer();
    expect(screen.queryByRole("button", { name: /clip/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Attach" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Text snippetCtrl+Shift+Enter", "Upload from your computerCtrl+O"]);
  });
});

describe("Schedule for later", () => {
  // Tuesday, November 17, 2026, at 10:30 AM, when Slack's menu was read.
  const TUESDAY = new Date(2026, 10, 17, 10, 30);
  const scheduleButton = () => screen.getByRole("button", { name: "Schedule for later" });
  const choices = () => screen.getAllByRole("menuitem").map((item) => item.textContent);
  const scheduledAs = (id: string, overrides: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
    id,
    clientMessageId: id,
    body: `<p>${id}</p>`,
    sendAt: new Date(2026, 10, 18, 9).toISOString(),
    ...overrides,
  });

  /** Schedule for later, with what's scheduled in the room, answering each message scheduled with `answer`. */
  function schedulingWith({ scheduled = [] as ScheduledMessage[], answer = null as string | null } = {}) {
    return {
      scheduled,
      schedule: vi.fn(async (_body: string, _at: Date, _reply?: { parentId: string; alsoSend: boolean }) => answer),
      edit: vi.fn(async (_id: string, _body: string) => null as string | null),
      reschedule: vi.fn((_id: string, _at: Date) => null as string | null),
      sendNow: vi.fn((_id: string) => null as string | null),
      remove: vi.fn((_id: string) => null as string | null),
      onScheduled: vi.fn((_at: Date) => {}),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TUESDAY);
  });
  afterEach(() => vi.useRealTimers());

  it("joins its chevron to Send, as Slack does, which waits for something written to schedule", async () => {
    const { input, user, view } = await showComposer({ scheduling: schedulingWith() });
    const below = [...view.container.querySelectorAll("form button")].filter((button) => !button.closest("[role=toolbar]"));
    expect(below.map((button) => button.getAttribute("aria-label") ?? button.textContent).slice(-2)).toEqual(["Send Message", "Schedule for later"]);
    expect(scheduleButton()).toBeDisabled();
    await user.type(input, "Hello");
    expect(scheduleButton()).toBeEnabled();
  });

  it("offers Slack's times, and schedules what's written for the one picked, emptying the composer once the room has it", async () => {
    const scheduling = schedulingWith();
    const { input, onTyping, user } = await showComposer({ scheduling });
    await user.type(input, "Hello");
    await user.click(scheduleButton());
    expect(screen.getByText("Schedule message")).toBeInTheDocument();
    expect(choices()).toEqual(["Later today at 1:00 PM", "Tomorrow at 9:00 AM", "Monday at 9:00 AM", "Custom time"]);

    await user.click(screen.getByRole("menuitem", { name: "Tomorrow at 9:00 AM" }));
    expect(scheduling.schedule).toHaveBeenCalledExactlyOnceWith("<p>Hello</p>", new Date(2026, 10, 18, 9), undefined);
    await waitFor(() => expect(input).toHaveValue(""));
    expect(scheduling.onScheduled).toHaveBeenCalledExactlyOnceWith(new Date(2026, 10, 18, 9));
    expect(onTyping).toHaveBeenLastCalledWith(false);
    expect(localStorage.getItem("composer-draft-u1-r1")).toBeNull();
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("asks first, as Send does, before scheduling what would notify a room of six or more once it's sent, keeping it on Cancel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ members: 6, mentions: { here: 2, channel: 5 } })));
    const scheduling = schedulingWith();
    const { input, user } = await showComposer({ scheduling });
    await user.type(input, "@channel Standup");
    await user.click(scheduleButton());
    await user.click(screen.getByRole("menuitem", { name: "Tomorrow at 9:00 AM" }));
    const asked = await screen.findByRole("dialog", { name: "Notify 5 people?" });
    expect(scheduling.schedule).not.toHaveBeenCalled();
    await user.click(within(asked).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(input).toHaveValue("@channel Standup");

    await user.click(scheduleButton());
    await user.click(screen.getByRole("menuitem", { name: "Tomorrow at 9:00 AM" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Notify 5 people?" })).getByRole("button", { name: "Schedule" }));
    const channel = `<action-text-attachment sgid="channel" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;
    expect(scheduling.schedule).toHaveBeenCalledExactlyOnceWith(`<p>${channel} Standup</p>`, new Date(2026, 10, 18, 9), undefined);
    await waitFor(() => expect(input).toHaveValue(""));
    expect(scheduling.onScheduled).toHaveBeenCalledOnce();
  });

  /** Has `scheduling` wait to answer the next message scheduled until what this answers is called with the answer. */
  function answerLater(scheduling: ReturnType<typeof schedulingWith>) {
    let answer: (refusal: string | null) => void = () => {};
    scheduling.schedule.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    return (refusal: string | null) => act(async () => answer(refusal));
  }

  it("neither sends what's being scheduled nor schedules it again while the room's answer comes", async () => {
    const scheduling = schedulingWith();
    const answer = answerLater(scheduling);
    const { input, onSend, user } = await showComposer({ scheduling });
    await user.type(input, "Hello");
    await user.click(scheduleButton());
    await user.click(screen.getByRole("menuitem", { name: "Tomorrow at 9:00 AM" }));
    expect(scheduleButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send Message" })).toBeDisabled();
    await user.type(input, "{Enter}");
    expect(onSend).not.toHaveBeenCalled();

    await answer(null);
    await waitFor(() => expect(input).toHaveValue(""));
    expect(scheduling.schedule).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send Message" })).toBeEnabled();
  });

  it("forgets the draft of a reply scheduled as its thread closes, once the room has it", async () => {
    const scheduling = schedulingWith();
    const answer = answerLater(scheduling);
    const { input, user, view } = await showComposer({ threadId: "m1", scheduling });
    await user.type(input, "Later");
    await user.click(scheduleButton());
    await user.click(screen.getByRole("menuitem", { name: "Monday at 9:00 AM" }));
    view.unmount();
    expect(localStorage.getItem("composer-draft-u1-r1/threads/m1")).toBe("<p>Later</p>");
    await answer(null);
    expect(localStorage.getItem("composer-draft-u1-r1/threads/m1")).toBeNull();
    expect(scheduling.onScheduled).toHaveBeenCalledOnce();
  });

  it("schedules a thread's reply, sent to the room too while Also send is ticked, which it unticks", async () => {
    const scheduling = schedulingWith();
    const { input, user } = await showComposer({ threadId: "m1", scheduling });
    await user.type(input, "Later");
    await user.click(screen.getByRole("checkbox", { name: "Also send to #general" }));
    await user.click(scheduleButton());
    await user.click(screen.getByRole("menuitem", { name: "Monday at 9:00 AM" }));
    expect(scheduling.schedule).toHaveBeenCalledExactlyOnceWith("<p>Later</p>", new Date(2026, 10, 23, 9), { parentId: "m1", alsoSend: true });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.getByRole("checkbox", { name: "Also send to #general" })).not.toBeChecked();
  });

  it("keeps what's written where the room refuses it, saying why until it's changed", async () => {
    const scheduling = schedulingWith({ answer: SCHEDULE_TIME_REFUSED });
    const { input, user } = await showComposer({ scheduling });
    await user.type(input, "Hello");
    await user.click(scheduleButton());
    await user.click(screen.getByRole("menuitem", { name: "Later today at 1:00 PM" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(SCHEDULE_TIME_REFUSED);
    expect(input).toHaveValue("Hello");
    expect(scheduling.onScheduled).not.toHaveBeenCalled();
    await user.type(input, "!");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("picks a custom time: a day, and a time that stays as the day changes", async () => {
    const scheduling = schedulingWith();
    const { input, user } = await showComposer({ scheduling });
    await user.type(input, "Hello");
    await user.click(scheduleButton());
    await user.click(screen.getByRole("menuitem", { name: "Custom time" }));
    const dialog = await screen.findByRole("dialog", { name: "Schedule message" });
    expect(dialog).toHaveTextContent(/Time zone: \S/);
    const day = within(dialog).getByRole("combobox", { name: "Date" });
    const time = within(dialog).getByRole("combobox", { name: "Time" });
    expect([day, time].map((select) => (select as HTMLSelectElement).selectedOptions[0]!.textContent)).toEqual(["Today", "11:00 AM"]);

    await user.selectOptions(day, "Tomorrow");
    expect((time as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("11:00 AM");
    await user.click(within(dialog).getByRole("button", { name: "Schedule Message" }));
    expect(scheduling.schedule).toHaveBeenCalledExactlyOnceWith("<p>Hello</p>", new Date(2026, 10, 18, 11), undefined);
    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("schedules no files, which go as they're sent, nor commands", async () => {
    const scheduling = schedulingWith();
    const { input, user } = await showComposer({ scheduling, onCommand: vi.fn((_written: WrittenCommand) => Promise.resolve(true)) });
    await user.type(input, "Hello");
    await user.upload(fileField(), fileOf("notes.txt"));
    expect(scheduleButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    await user.clear(input);
    await user.type(input, "/shrug ok");
    expect(scheduleButton()).toBeDisabled();
    await user.clear(input);
    await user.type(input, "/nope later");
    await user.click(scheduleButton());
    await user.click(screen.getByRole("menuitem", { name: "Tomorrow at 9:00 AM" }));
    expect(screen.getByRole("alert")).toHaveTextContent("/nope isn't a command.");
    expect(scheduling.schedule).not.toHaveBeenCalled();
  });

  it("isn't there where the room doesn't schedule, as in a huddle's thread", async () => {
    await showComposer({ threadId: "m1" });
    expect(screen.queryByRole("button", { name: "Schedule for later" })).not.toBeInTheDocument();
  });

  it("counts what's scheduled where it writes over the card: in the room, a DM, or a thread", async () => {
    const scheduled = [scheduledAs("s1"), scheduledAs("s2", { parentId: "m1" }), scheduledAs("s3", { parentId: "m1" }), scheduledAs("s4", { parentId: "m2" })];
    for (const [shown, line] of [
      [{}, "1 scheduled message in #general"],
      [{ direct: true }, "1 scheduled message in this conversation"],
      [{ threadId: "m1" }, "2 scheduled messages in this thread"],
    ] as const) {
      const { view } = await showComposer({ ...shown, scheduling: schedulingWith({ scheduled }) });
      expect(screen.getByRole("button", { name: line })).toBeInTheDocument();
      view.unmount();
    }
    await showComposer({ threadId: "m3", scheduling: schedulingWith({ scheduled }) });
    expect(screen.queryByRole("button", { name: /scheduled message/ })).not.toBeInTheDocument();
  });

  it("lists them, soonest first, to edit, reschedule, send now or delete, saying why a change couldn't go", async () => {
    const blocked = "This community doesn't allow one of these words.";
    const scheduled = [scheduledAs("s1", { body: "<p>First</p>" }), scheduledAs("s2", { body: "<p>Second</p>", sendAt: new Date(2026, 10, 26, 9).toISOString(), failure: blocked })];
    const scheduling = schedulingWith({ scheduled });
    const { input, user } = await showComposer({ scheduling });
    await user.click(screen.getByRole("button", { name: "2 scheduled messages in #general" }));
    const dialog = await screen.findByRole("dialog", { name: "Scheduled messages" });
    const [first, second] = within(dialog).getAllByRole("listitem");
    expect(first).toHaveTextContent("Scheduled for tomorrow at 9:00 AMFirst");
    expect(second).toHaveTextContent(`Scheduled for Thursday, November 26 at 9:00 AMSecond${blocked}`);

    await user.click(within(first!).getByRole("button", { name: "Send now" }));
    expect(scheduling.sendNow).toHaveBeenCalledExactlyOnceWith("s1");
    await user.click(within(second!).getByRole("button", { name: "Reschedule" }));
    await user.click(screen.getByRole("menuitem", { name: "Monday at 9:00 AM" }));
    expect(scheduling.reschedule).toHaveBeenCalledExactlyOnceWith("s2", new Date(2026, 10, 23, 9));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await user.click(within(second!).getByRole("button", { name: "Delete" }));
    await user.click(within(second!).getByRole("button", { name: "Delete" }));
    expect(confirm).toHaveBeenCalledWith("Are you sure you want to delete this scheduled message?");
    expect(scheduling.remove).toHaveBeenCalledExactlyOnceWith("s2");

    await user.click(within(first!).getByRole("button", { name: "Edit" }));
    const editor = await within(first!).findByRole("textbox", { name: "Edit message" });
    await user.type(editor, " and more");
    scheduling.edit.mockResolvedValueOnce(blocked);
    await user.click(within(first!).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(blocked);
    // Kept to try again.
    expect(within(first!).getByRole("textbox", { name: "Edit message" })).toHaveValue("First and more");
    await user.click(within(first!).getByRole("button", { name: "Save changes" }));
    expect(scheduling.edit).toHaveBeenLastCalledWith("s1", "<p>First and more</p>");
    await waitFor(() => expect(within(first!).queryByRole("textbox", { name: "Edit message" })).not.toBeInTheDocument());
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(first!).getByRole("button", { name: "Edit" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("lists the replies whose thread's message has been deleted with the room's, to edit or delete, as there's no thread to send them in", async () => {
    const scheduled = [scheduledAs("s1", { body: "<p>Orphaned</p>", parentId: "m1", failure: THREAD_DELETED }), scheduledAs("s2", { parentId: "m2" })];
    const { user } = await showComposer({ scheduling: schedulingWith({ scheduled }) });
    await user.click(screen.getByRole("button", { name: "1 scheduled message in #general" }));
    const dialog = await screen.findByRole("dialog", { name: "Scheduled messages" });
    const item = within(dialog).getByRole("listitem");
    expect(item).toHaveTextContent(`Orphaned${THREAD_DELETED}`);
    expect(within(item).getAllByRole("button").map((button) => button.textContent)).toEqual(["Edit", "Delete"]);
  });

  it("waits for the room to have an edit, keeping what's written since, and closes no other editor as it comes", async () => {
    const scheduled = [scheduledAs("s1", { body: "<p>First</p>" }), scheduledAs("s2", { body: "<p>Second</p>" })];
    const scheduling = schedulingWith({ scheduled });
    const answers: Array<(refusal: string | null) => void> = [];
    scheduling.edit.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    const answer = (refusal: string | null) => act(async () => answers.shift()!(refusal));
    const { user } = await showComposer({ scheduling });
    await user.click(screen.getByRole("button", { name: "2 scheduled messages in #general" }));
    const dialog = await screen.findByRole("dialog", { name: "Scheduled messages" });
    const [first, second] = within(dialog).getAllByRole("listitem");
    const editorIn = (item: HTMLElement) => within(item).queryByRole("textbox", { name: "Edit message" });

    await user.click(within(first!).getByRole("button", { name: "Edit" }));
    await user.type((await within(first!).findByRole("textbox", { name: "Edit message" })), " and more");
    await user.click(within(first!).getByRole("button", { name: "Save changes" }));
    // Saved once while the room's answer comes.
    await user.click(within(first!).getByRole("button", { name: "Save changes" }));
    expect(scheduling.edit).toHaveBeenCalledExactlyOnceWith("s1", "<p>First and more</p>");
    await user.type(editorIn(first!)!, " still");
    await answer(null);
    expect(editorIn(first!)).toHaveValue("First and more still");

    await user.click(within(first!).getByRole("button", { name: "Save changes" }));
    await user.keyboard("{Escape}");
    await user.click(within(second!).getByRole("button", { name: "Edit" }));
    await user.type((await within(second!).findByRole("textbox", { name: "Edit message" })), " too");
    await answer(null);
    expect(editorIn(second!)).toHaveValue("Second too");
  });

  it("names the people and rooms a scheduled message mentions as they are now, as the room keeps only their ids", async () => {
    const grace = { id: "grace00000000001", name: "Grace Hopper", bio: null, role: "member", status: "active", avatarUrl: "/users/grace00000000001/avatar" } as const;
    const stored = (contentType: string, sgid: string) => `<action-text-attachment content-type="${contentType}" sgid="${sgid}"></action-text-attachment>`;
    const body = `<p>Ask ${stored(MENTION_CONTENT_TYPE, grace.id)} in ${stored(ROOM_MENTION_CONTENT_TYPE, "design")}, not ${stored(ROOM_MENTION_CONTENT_TYPE, "left")}</p>`;
    const scheduling = schedulingWith({ scheduled: [scheduledAs("s1", { body })] });
    const rooms: Rooms = new Map([["design", { id: "design", kind: "closed", name: "design", icon: null }]]);
    const { user } = await showComposer({ scheduling, rooms, people: new Map([[grace.id, grace]]) });
    await user.click(screen.getByRole("button", { name: "1 scheduled message in #general" }));
    const dialog = await screen.findByRole("dialog", { name: "Scheduled messages" });
    expect(within(dialog).getByRole("listitem")).toHaveTextContent("Ask @Grace Hopper in #design, not #private room");
  });

  it("takes Escape in a message being edited to close its editor, and only then the list", async () => {
    const scheduling = schedulingWith({ scheduled: [scheduledAs("s1", { body: "<p>First</p>" })] });
    const { input, user } = await showComposer({ scheduling });
    await user.click(screen.getByRole("button", { name: "1 scheduled message in #general" }));
    const dialog = await screen.findByRole("dialog", { name: "Scheduled messages" });
    await user.click(within(dialog).getByRole("button", { name: "Edit" }));
    await user.type(await within(dialog).findByRole("textbox", { name: "Edit message" }), " and more");
    await user.keyboard("{Escape}");
    expect(within(dialog).queryByRole("textbox", { name: "Edit message" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Scheduled messages" })).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: "Edit" })).toHaveFocus();
    expect(scheduling.edit).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Scheduled messages" })).not.toBeInTheDocument());
    await waitFor(() => expect(input).toHaveFocus());
  });
});

describe("Pasting into the composer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("waits to send pasted files rather than writing them, and leaves pasted text to the editor", async () => {
    thumbnails();
    const { input } = await showComposer();
    expect(fireEvent.paste(input, { clipboardData: clipboard(fileOf("pasted.png", { type: "image/png" })) })).toBe(false);
    expect(chips()).toEqual(["Remove pasted.png"]);
    expect(input).toHaveValue("");

    expect(fireEvent.paste(input, { clipboardData: clipboard() })).toBe(true);
    expect(chips()).toEqual(["Remove pasted.png"]);
  });
});

describe("250 MB file limit", () => {
  const tooLarge = (name: string) => `${name} is too large. Choose a file that’s 250 MB or smaller.`;

  it("leaves out files over 250 MB, saying so under the others until more are picked, dropped or pasted", async () => {
    const { input, user, view, onSendFiles } = await showComposer();
    await user.upload(fileField(), [
      fileOf("huge.mov", { size: MAX_FILE_SIZE + 1 }),
      fileOf("fits.mov", { size: MAX_FILE_SIZE }),
      fileOf("vast.iso", { size: MAX_FILE_SIZE + 1 }),
    ]);
    expect(chips()).toEqual(["Remove fits.mov"]);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(`${tooLarge("huge.mov")} ${tooLarge("vast.iso")}`, { normalizeWhitespace: false });
    expect(alert).toHaveClass("w-full", "text-negative");

    // It stays through sending and removing files.
    await user.click(sendButton());
    expect(onSendFiles).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ name: "fits.mov" })], false);
    expect(screen.getByRole("alert")).toBe(alert);

    // Picking more says only what's wrong with them.
    await user.upload(fileField(), fileOf("enormous.zip", { size: MAX_FILE_SIZE + 1 }));
    expect(screen.getByRole("alert")).toHaveTextContent(tooLarge("enormous.zip"), { normalizeWhitespace: false });
    fireEvent.drop(view.container.querySelector("form")!, { dataTransfer: { files: [fileOf("small.txt")] } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Pasting anything clears it, even text.
    await user.upload(fileField(), fileOf("enormous.zip", { size: MAX_FILE_SIZE + 1 }));
    fireEvent.paste(input, { clipboardData: clipboard() });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Keep drafts", () => {
  const draft = (roomId = "r1") => localStorage.getItem(`composer-draft-u1-${roomId}`);

  it("keeps what's written in this browser until it's sent", async () => {
    const { input, user } = await showComposer();
    await user.type(input, "Hello");
    expect(draft()).toBe("<p>Hello</p>");

    await user.keyboard("{Enter}");
    expect(draft()).toBeNull();
  });

  it("forgets it once the box is emptied", async () => {
    const { input, user } = await showComposer();
    await user.type(input, "Hello");
    await user.clear(input);
    expect(draft()).toBeNull();
  });

  it("brings it back, with the cursor at the end, when the room opens again", async () => {
    localStorage.setItem("composer-draft-u1-r1", "<p>Where was I</p>");
    const { input } = await showComposer();
    expect(input).toHaveValue("Where was I");
    expect(input).toHaveFocus();
    expect((input as HTMLTextAreaElement).selectionStart).toBe("Where was I".length);
  });

  it("keeps each room's apart", async () => {
    localStorage.setItem("composer-draft-u1-r2", "<p>For the other room</p>");
    const { input } = await showComposer({ roomId: "r1" });
    expect(input).toHaveValue("");
  });

  it("keeps each person's apart, so whoever signs in on this browser next doesn't see it", async () => {
    localStorage.setItem("composer-draft-u2-r1", "<p>Grace's own</p>");
    const { input } = await showComposer({ roomId: "r1" });
    expect(input).toHaveValue("");
  });
});

describe("Manage drafts", () => {
  afterEach(() => vi.restoreAllMocks());

  const manageDrafts = () => screen.queryByRole("button", { name: "Manage drafts" });
  const listed = (place = "room") => within(screen.getByRole("group", { name: `Drafts in this ${place}` })).getAllByRole("menuitemradio");
  const ticked = (place = "room") => listed(place).map((item) => [item.textContent, item.getAttribute("aria-checked")]);
  /** The drafts put aside in room r1, or in one of its threads, as this browser keeps them, newest first. */
  const putAside = (threadId?: string) =>
    (JSON.parse(localStorage.getItem(`composer-draft-u1-r1${threadId ? `/threads/${threadId}` : ""}/saved`) ?? "[]") as { body: string }[]).map((draft) => draft.body);
  const keepAside = (...bodies: string[]) =>
    localStorage.setItem("composer-draft-u1-r1/saved", JSON.stringify(bodies.map((body, index) => ({ id: `d${index}`, body, savedAt: bodies.length - index }))));

  it("shows before Send once something's written, as Slack's does, and goes once it's emptied with nothing put aside", async () => {
    const { input, user, view } = await showComposer({ onCommand: vi.fn((_written: WrittenCommand) => Promise.resolve(true)) });
    expect(manageDrafts()).not.toBeInTheDocument();
    await user.type(input, "Hello");
    const below = [...view.container.querySelectorAll("form button")].filter((button) => !button.closest("[role=toolbar]"));
    expect(below.map((button) => button.getAttribute("aria-label") ?? button.textContent).slice(-3)).toEqual(["Run shortcut", "Manage drafts", "Send Message"]);

    await user.clear(input);
    expect(manageDrafts()).not.toBeInTheDocument();
  });

  it("puts what's written aside with Save as draft, emptying the composer for another, and lists it, unticked once it's no longer written", async () => {
    const { input, onTyping, user } = await showComposer();
    await user.type(input, "First idea{Shift>}{Enter}{/Shift}with a second line");
    await user.click(manageDrafts()!);
    expect(screen.getByText("Drafts in this room")).toBeInTheDocument();
    // Each by its first line.
    expect(ticked()).toEqual([["First idea", "true"]]);

    await user.click(screen.getByRole("menuitem", { name: "Save as draft" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(input).toHaveValue("");
    await waitFor(() => expect(input).toHaveFocus());
    expect(sendButton()).toHaveAttribute("data-empty");
    expect(onTyping).toHaveBeenLastCalledWith(false);
    expect(localStorage.getItem("composer-draft-u1-r1")).toBeNull();
    expect(putAside()).toEqual(["<p>First idea<br>with a second line</p>"]);

    // It stays, for the draft put aside, which Save as draft can't put aside again.
    await user.click(manageDrafts()!);
    expect(ticked()).toEqual([["First idea", "false"]]);
    expect(screen.getByRole("menuitem", { name: "Save as draft" })).toHaveAttribute("aria-disabled", "true");
  });

  it("opens a draft put aside in the composer, putting what's written aside in its place, newest first", async () => {
    keepAside("<p>Newer</p>", "<p>Older</p>");
    const { input, user } = await showComposer();
    expect(manageDrafts()).toBeInTheDocument();
    await user.type(input, "Now");
    await user.click(manageDrafts()!);
    expect(ticked()).toEqual([
      ["Now", "true"],
      ["Newer", "false"],
      ["Older", "false"],
    ]);

    await user.click(screen.getByRole("menuitemradio", { name: "Older" }));
    expect(input).toHaveValue("Older");
    await waitFor(() => expect(input).toHaveFocus());
    expect(localStorage.getItem("composer-draft-u1-r1")).toBe("<p>Older</p>");
    expect(putAside()).toEqual(["<p>Now</p>", "<p>Newer</p>"]);

    // With nothing written, nothing's put aside for the one opened.
    await user.clear(input);
    await user.click(manageDrafts()!);
    await user.click(screen.getByRole("menuitemradio", { name: "Newer" }));
    expect(input).toHaveValue("Newer");
    expect(putAside()).toEqual(["<p>Now</p>"]);
  });

  it("names where the drafts are: a room, a DM, or a thread", async () => {
    keepAside("<p>Aside</p>");
    localStorage.setItem("composer-draft-u1-r1/threads/m1/saved", localStorage.getItem("composer-draft-u1-r1/saved")!);
    for (const [shown, place] of [[{}, "room"], [{ direct: true }, "conversation"], [{ threadId: "m1" }, "thread"]] as const) {
      const { user, view } = await showComposer(shown);
      await user.click(manageDrafts()!);
      expect(ticked(place)).toEqual([["Aside", "false"]]);
      await user.keyboard("{Escape}");
      view.unmount();
    }
  });

  it("keeps a thread's drafts apart from its room's", async () => {
    keepAside("<p>For the room</p>");
    const { input, user } = await showComposer({ threadId: "m1" });
    expect(manageDrafts()).not.toBeInTheDocument();
    await user.type(input, "For the thread");
    await user.click(manageDrafts()!);
    await user.click(screen.getByRole("menuitem", { name: "Save as draft" }));
    expect(putAside("m1")).toEqual(["<p>For the thread</p>"]);
    expect(putAside()).toEqual(["<p>For the room</p>"]);
  });

  it("lists the drafts in + where the row has no room for Manage drafts", async () => {
    keepAside("<p>Aside</p>");
    const { input, user } = await showComposer();
    await user.type(input, "Hello");
    await user.click(screen.getByRole("button", { name: "Attach" }));
    expect(screen.queryByRole("group", { name: "Drafts in this room" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    // As the row's styles hide it, which jsdom has none of.
    manageDrafts()!.style.display = "none";
    await user.click(screen.getByRole("button", { name: "Attach" }));
    expect(ticked()).toEqual([
      ["Hello", "true"],
      ["Aside", "false"],
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Save as draft" }));
    expect(input).toHaveValue("");
    await waitFor(() => expect(input).toHaveFocus());
    expect(putAside()).toEqual(["<p>Hello</p>", "<p>Aside</p>"]);
  });

  it("says so, leaving what's written, where the drafts can't be kept, until it's changed", async () => {
    const { input, user } = await showComposer();
    await user.type(input, "Hello");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.endsWith("/saved")) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      localStorage[key] = value;
    });
    await user.click(manageDrafts()!);
    await user.click(screen.getByRole("menuitem", { name: "Save as draft" }));
    expect(input).toHaveValue("Hello");
    expect(screen.getByRole("alert")).toHaveTextContent("Your drafts couldn't be saved, as this browser has no room left for them.");

    await user.type(input, "!");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("leaves a draft put aside, and what's written, as they were, saying so, where there's no room to keep the draft opened", async () => {
    keepAside("<p>Aside</p>");
    const { input, user } = await showComposer();
    await user.type(input, "Now");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === "composer-draft-u1-r1") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      localStorage[key] = value;
    });
    await user.click(manageDrafts()!);
    await user.click(screen.getByRole("menuitemradio", { name: "Aside" }));
    expect(input).toHaveValue("Now");
    expect(screen.getByRole("alert")).toHaveTextContent("Your drafts couldn't be saved, as this browser has no room left for them.");
    expect(localStorage.getItem("composer-draft-u1-r1")).toBe("<p>Now</p>");
    expect(putAside()).toEqual(["<p>Aside</p>"]);
  });

  it("isn't there where this browser can't keep drafts", async () => {
    const refuse = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: refuse, setItem: refuse, removeItem: refuse });
    const { input, user } = await showComposer();
    await user.type(input, "Hello");
    expect(manageDrafts()).not.toBeInTheDocument();
  });

  it("is there where storage is full, which still holds the drafts put aside", async () => {
    keepAside("<p>Aside</p>");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
    await showComposer();
    expect(manageDrafts()).toBeInTheDocument();
  });

  it("lists beside the room what a thread's composer in the huddle over it put aside, once that's gone", async () => {
    const beside = await showComposer({ threadId: "m1" });
    const huddle = await showComposer({ threadId: "m1", autoFocus: false });
    await huddle.user.type(huddle.input, "From the huddle");
    await huddle.user.click(within(huddle.view.container).getByRole("button", { name: "Manage drafts" }));
    await huddle.user.click(screen.getByRole("menuitem", { name: "Save as draft" }));
    huddle.view.unmount();

    expect(beside.input).toHaveValue("");
    await beside.user.click(manageDrafts()!);
    expect(ticked("thread")).toEqual([["From the huddle", "false"]]);
  });
});

describe("Reply in a thread", () => {
  const alsoSend = () => screen.getByRole("checkbox", { name: "Also send to #general" });

  it("asks for a reply, with Also send to the room, unticked, before Send", async () => {
    const { input } = await showComposer({ threadId: "m1" });
    expect(input).toHaveAttribute("placeholder", "Reply…");
    expect(alsoSend()).not.toBeChecked();
    expect(alsoSend().compareDocumentPosition(sendButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers to send it as a direct message too in a DM", async () => {
    await showComposer({ threadId: "m1", direct: true });
    expect(screen.getByRole("checkbox", { name: "Also send as direct message" })).not.toBeChecked();
  });

  it("sends a reply to the thread alone, or to the room too while Also send is ticked, which sending unticks", async () => {
    const { onSend, input, user } = await showComposer({ threadId: "m1" });
    await user.type(input, "Just here{Enter}");
    expect(onSend).toHaveBeenLastCalledWith("<p>Just here</p>", false);

    await user.click(alsoSend());
    await user.type(input, "Everywhere{Enter}");
    expect(onSend).toHaveBeenLastCalledWith("<p>Everywhere</p>", true);
    expect(alsoSend()).not.toBeChecked();
  });

  it("sends files to the room too while Also send is ticked", async () => {
    const { onSendFiles, user } = await showComposer({ threadId: "m1" });
    await user.upload(fileField(), new File(["hi"], "notes.txt", { type: "text/plain" }));
    await user.click(alsoSend());
    await user.click(sendButton());
    expect(onSendFiles).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ name: "notes.txt" })], true);
    expect(alsoSend()).not.toBeChecked();
  });

  it("keeps a thread's draft apart from its room's", async () => {
    localStorage.setItem("composer-draft-u1-r1", "<p>For the room</p>");
    const { input, user } = await showComposer({ threadId: "m1" });
    expect(input).toHaveValue("");
    await user.type(input, "For the thread");
    expect(localStorage.getItem("composer-draft-u1-r1/threads/m1")).toBe("<p>For the thread</p>");
    expect(localStorage.getItem("composer-draft-u1-r1")).toBe("<p>For the room</p>");
  });

  it("leaves focus be as the room opens with a thread beside it, which takes it", async () => {
    const { input } = await showComposer({ autoFocus: false });
    expect(input).not.toHaveFocus();
  });
});

describe("A thread's draft, beside its room and in the room's huddle over it", () => {
  const draft = () => localStorage.getItem("composer-draft-u1-r1/threads/m1");

  /** The thread's composer beside its room, with its text box as it is now: another, once the editor has opened again. */
  async function showBeside() {
    const shown = await showComposer({ threadId: "m1" });
    const own = within(shown.view.container);
    return { ...shown, box: () => own.getByRole("textbox", { name: "Write a reply" }), send: () => own.getByRole("button", { name: "Send Message" }) };
  }

  /** The same thread's composer in its room's huddle, which opens over the one beside the room and leaves focus where it is. */
  const showInHuddle = () => showComposer({ threadId: "m1", autoFocus: false });

  it("opens the huddle's with what was begun beside the room, which shows what the huddle's left of it once that's gone, leaving focus where it is", async () => {
    const beside = await showBeside();
    await beside.user.upload(fileField(), new File(["hi"], "notes.txt", { type: "text/plain" }));
    await beside.user.click(screen.getByRole("checkbox", { name: "Also send to #general" }));
    await beside.user.type(beside.input, "Shipping on");
    const huddle = await showInHuddle();
    expect(huddle.input).toHaveValue("Shipping on");

    // Only the one in front can be written in, so the other has it once it's in front again.
    await huddle.user.type(huddle.input, " Friday");
    expect(beside.box()).toBe(beside.input);
    expect(beside.box()).toHaveValue("Shipping on");
    beside.onTyping.mockClear();
    huddle.view.unmount();
    expect(beside.box()).toHaveValue("Shipping on Friday");
    expect(beside.box()).not.toHaveFocus();
    expect(draft()).toBe("<p>Shipping on Friday</p>");
    // It wasn't typed here, so the room hears of no typing, and what waits to go with the reply still does.
    expect(beside.onTyping).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove notes.txt" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Also send to #general" })).toBeChecked();

    // A huddle's that leaves it as it found it leaves the editor as it is.
    const reopened = beside.box();
    (await showInHuddle()).view.unmount();
    expect(beside.box()).toBe(reopened);
    await beside.user.type(beside.box(), "{Enter}");
    expect(beside.onSend).toHaveBeenCalledExactlyOnceWith("<p>Shipping on Friday</p>", true);
  });

  it("has nothing left written beside the room once the reply's been sent from the huddle, so it can't be sent twice", async () => {
    const beside = await showBeside();
    await beside.user.type(beside.input, "Shipping on Friday");
    const huddle = await showInHuddle();
    await huddle.user.type(huddle.input, "{Enter}");
    expect(huddle.onSend).toHaveBeenCalledExactlyOnceWith("<p>Shipping on Friday</p>", false);
    huddle.view.unmount();

    expect(beside.box()).toHaveValue("");
    expect(beside.send()).toHaveAttribute("data-empty");
    await beside.user.type(beside.box(), "{Enter}");
    expect(beside.onSend).not.toHaveBeenCalled();
  });

  it("takes up what was begun in the huddle as a draft it opens with: Send lights, and emptying it tells the room its writer has stopped", async () => {
    const beside = await showBeside();
    const huddle = await showInHuddle();
    await huddle.user.type(huddle.input, "Hello");
    huddle.view.unmount();

    expect(beside.box()).toHaveValue("Hello");
    expect(beside.send()).not.toHaveAttribute("data-empty");
    expect(beside.onTyping).not.toHaveBeenCalled();
    await beside.user.clear(beside.box());
    expect(beside.onTyping).toHaveBeenCalledExactlyOnceWith(false);
    expect(draft()).toBeNull();
  });

  it("leaves what's written, and focus, as they are where the huddle's left the draft as it found it", async () => {
    const beside = await showBeside();
    await beside.user.type(beside.input, "Hello");
    (await showInHuddle()).view.unmount();
    expect(beside.box()).toBe(beside.input);
    expect(beside.input).toHaveValue("Hello");
    expect(beside.input).toHaveFocus();
  });

  it("leaves the huddle's as it is when the one under it goes, which was written in before it, whether the huddle's has been written in or not", async () => {
    const huddlesBox = () => within(huddle.view.container).getByRole("textbox", { name: "Write a reply" });
    const beside = await showBeside();
    await beside.user.type(beside.input, "Hello");
    const huddle = await showInHuddle();
    beside.view.unmount();
    expect(huddlesBox()).toBe(huddle.input);
    expect(huddle.input).toHaveValue("Hello");

    const besideAgain = await showBeside();
    await huddle.user.type(huddle.input, " there");
    besideAgain.view.unmount();
    expect(huddlesBox()).toBe(huddle.input);
    expect(huddle.input).toHaveValue("Hello there");
    expect(huddle.input).toHaveFocus();
  });

  it("leaves each with what's written in it where this browser keeps no drafts, so neither has the other's to show", async () => {
    const refuse = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: refuse, setItem: refuse, removeItem: refuse });
    const beside = await showBeside();
    await beside.user.type(beside.input, "Hello");
    const huddle = await showInHuddle();
    expect(huddle.input).toHaveValue("");
    await huddle.user.type(huddle.input, "Hi{Enter}");
    huddle.view.unmount();
    expect(beside.box()).toBe(beside.input);
    expect(beside.input).toHaveValue("Hello");
  });
});

describe("A message the room won't take for what it says", () => {
  const WHY = "This community doesn't allow one of these words.";

  it("comes back to be changed, keeping it as the draft, with why above the card, until something's sent", async () => {
    const { composer, input, user, onSend } = await showComposer();
    await user.type(input, "Oh fudge");
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("");

    let taken = false;
    act(() => void (taken = composer.current!.giveBack("<p>Oh fudge</p>", WHY, false)));
    expect(taken).toBe(true);
    expect(input).toHaveValue("Oh fudge");
    expect(input).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent(WHY);
    expect(localStorage.getItem("composer-draft-u1-r1")).toBe("<p>Oh fudge</p>");

    await user.clear(input);
    await user.type(input, "Oh fiddlesticks");
    expect(screen.getByRole("alert")).toHaveTextContent(WHY);
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenLastCalledWith("<p>Oh fiddlesticks</p>", false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays out of the composer once something else is written there", async () => {
    const { composer, input, user } = await showComposer();
    await user.type(input, "Never mind");

    let taken = true;
    act(() => void (taken = composer.current!.giveBack("<p>Oh fudge</p>", WHY, false)));
    expect(taken).toBe(false);
    expect(input).toHaveValue("Never mind");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("comes back to a thread's composer with Also send to the room ticked again, as it went", async () => {
    const { composer, input } = await showComposer({ threadId: "m1" });
    act(() => void composer.current!.giveBack("<p>Oh fudge</p>", WHY, true));
    expect(input).toHaveValue("Oh fudge");
    expect(screen.getByRole("checkbox", { name: "Also send to #general" })).toBeChecked();
  });

  it("says why only in the room it came back in", async () => {
    const { composer, view } = await showComposer();
    act(() => void composer.current!.giveBack("<p>Oh fudge</p>", WHY, false));
    view.rerender(<Composer ref={composer} roomId="r2" roomName="random" userId="u1" typing={[]} disabled={false} onSend={() => went} onSendFiles={() => {}} onTyping={() => {}} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Reply with a quote", () => {
  it("writes a reply in place of what's written, with the cursor at its end, keeping it as the draft", async () => {
    const composer = createRef<ComposerHandle>();
    const onTyping = vi.fn();
    render(
      <Composer ref={composer} roomId="r1" roomName="general" userId="u1" typing={[]} disabled={false} onSend={() => went} onSendFiles={() => {}} onTyping={onTyping} />,
    );
    const input = await screen.findByRole("textbox", { name: "Write a message" });
    await userEvent.setup().type(input, "Unsent");
    act(() => (input as HTMLTextAreaElement).blur());

    // The stand-in holds a quote as Action Text's plain text, in quotation marks.
    act(() => composer.current!.replace("<blockquote><p>Third time's a charm.</p></blockquote><cite>Ada</cite><p><br></p>"));
    const written = "“Third time's a charm.”\n\nAda";
    expect(input).toHaveValue(written);
    expect(input).toHaveFocus();
    expect((input as HTMLTextAreaElement).selectionStart).toBe(written.length);
    expect(localStorage.getItem("composer-draft-u1-r1")).toBe("<p>“Third time's a charm.”<br><br>Ada</p>");
    expect(onTyping).toHaveBeenLastCalledWith(true);
  });

  it("opens the editor with a reply written while its code loaded, taking focus, even on touch screens", async () => {
    (await showComposer()).view.unmount();
    touchScreen();
    const composer = createRef<ComposerHandle>();
    const onTyping = vi.fn();
    const page = (deferEditor: boolean) => (
      <Composer
        ref={composer}
        roomId="r1"
        roomName="general"
        userId="u1"
        typing={[]}
        disabled={false}
        deferEditor={deferEditor}
        onSend={() => went}
        onSendFiles={() => {}}
        onTyping={onTyping}
      />
    );
    const view = render(page(true));
    const quote = "<blockquote><p>Third time's a charm.</p></blockquote><cite>Ada</cite><p><br></p>";
    act(() => composer.current!.replace(quote));
    expect(localStorage.getItem("composer-draft-u1-r1")).toBe(quote);
    expect(onTyping).toHaveBeenLastCalledWith(true);

    view.rerender(page(false));
    const input = await screen.findByRole("textbox", { name: "Write a message" });
    expect(input).toHaveValue("“Third time's a charm.”\n\nAda");
    expect(input).toHaveFocus();
  });
});

describe("Link previews while writing", () => {
  const basecamp: LinkPreview = { title: "Basecamp", url: "https://basecamp.com/", image: "https://basecamp.com/og.png", description: "Calm & organized" };

  /** Answers each ask for a link's preview with what `answer` gives for its address. */
  function previews(answer: (url: string) => Response | Promise<Response>) {
    const fetch = vi.fn(async (_path: string, init: RequestInit) => answer(JSON.parse(init.body as string).url));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  /** The link previews the composer shows. */
  const shownPreviews = (view: ReturnType<typeof render>) => view.container.querySelectorAll(`action-text-attachment[content-type="${OPENGRAPH_EMBED_CONTENT_TYPE}"]`);

  it("adds the preview of a pasted link's page below it, which goes with the message", async () => {
    const fetch = previews(() => Response.json(basecamp));
    const { onSend, user } = await showComposer();
    await user.paste("https://basecamp.com");
    expect(await screen.findByRole("link", { name: "Basecamp" })).toHaveAttribute("href", "https://basecamp.com/");
    expect(fetch).toHaveBeenCalledWith("/api/unfurl", expect.objectContaining({ method: "POST", body: JSON.stringify({ url: "https://basecamp.com" }) }));

    await user.keyboard("{Enter}");
    const sent = new DOMParser().parseFromString(onSend.mock.calls[0]![0], "text/html").body;
    expect(sent.querySelector("p")!.textContent).toBe("https://basecamp.com");
    const attachment = sent.querySelector("action-text-attachment")!;
    expect(attachment.getAttribute("content-type")).toBe(OPENGRAPH_EMBED_CONTENT_TYPE);
    expect(attachment.getAttribute("content")).toBe(
      previewContent({ href: "https://basecamp.com/", url: "https://basecamp.com/og.png", filename: "Basecamp", description: "Calm & organized" }),
    );
  });

  it("adds nothing for a page without a preview, or a preview that can't be had", async () => {
    const answers: Record<string, Response> = {
      "https://example.com/none": new Response(null, { status: 204 }),
      "https://example.com/limited": Response.json({ error: "Too many link previews. Try again in a minute." }, { status: 429 }),
      "https://example.com/untitled": Response.json({ ...basecamp, title: "" }),
    };
    const fetch = previews((url) => answers[url]!);
    const { user, view } = await showComposer();
    for (const url of Object.keys(answers)) await user.paste(url);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(shownPreviews(view)).toHaveLength(0);
  });

  it("forgets the preview of a link once another is pasted, or the composer goes", async () => {
    let answerFirst!: () => void;
    const firstAnswered = new Promise<void>((resolve) => (answerFirst = resolve));
    const fetch = previews(async (url) => {
      if (url.endsWith("first")) await firstAnswered;
      return Response.json({ ...basecamp, title: url });
    });
    const { user, view } = await showComposer();
    await user.paste("https://example.com/first");
    await user.paste("https://example.com/second");
    expect(await screen.findByRole("link", { name: "https://example.com/second" })).toBeInTheDocument();
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
    await act(async () => answerFirst());
    expect(shownPreviews(view)).toHaveLength(1);

    await user.paste("https://example.com/third");
    view.unmount();
    expect(fetch.mock.calls[2]![1].signal!.aborted).toBe(true);
  });

  it("forgets it too once the editor it was pasted in opens again, with what another composer left of its draft", async () => {
    const fetch = previews(() => new Promise<Response>(() => {}));
    const { user } = await showComposer({ threadId: "m1" });
    await user.paste("https://example.com/slow");
    const over = await showComposer({ threadId: "m1", autoFocus: false });
    await over.user.type(over.input, " is slow");
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(false);
    over.view.unmount();
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
  });

  describe("once the message has gone", () => {
    /** Answers each ask for a link's preview with `preview` once `answer` is called. */
    function slowPreviews(preview: LinkPreview) {
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => (answer = resolve));
      const fetch = previews(async () => {
        await answered;
        return Response.json(preview);
      });
      return { fetch, answer: () => act(async () => answer()) };
    }

    it("adds a pasted link's preview that comes after the message went to the message, rather than below the link", async () => {
      const { fetch, answer } = slowPreviews(basecamp);
      const { onSend, addPreview, user, view } = await showComposer();
      await user.paste("https://basecamp.com");
      await user.keyboard("{Enter}");
      expect(onSend).toHaveBeenCalledExactlyOnceWith("<p>https://basecamp.com</p>", false);
      view.unmount();
      expect(addPreview).not.toHaveBeenCalled();

      await answer();
      expect(addPreview).toHaveBeenCalledExactlyOnceWith(basecamp);
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(false);
      expect(shownPreviews(view)).toHaveLength(0);
    });

    it("asks for the preview of the first link to a web page typed in the message as it goes, as Slack does", async () => {
      const fetch = previews(() => Response.json(basecamp));
      const { addPreview, input, user } = await showComposer({ threadId: "m1" });
      await user.type(input, "Mail ada@example.com, or see www.basecamp.com and https://example.com{Enter}");
      await vi.waitFor(() => expect(addPreview).toHaveBeenCalledExactlyOnceWith(basecamp));
      expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/unfurl", expect.objectContaining({ body: JSON.stringify({ url: "http://www.basecamp.com" }) }));
    });

    it("asks for the preview of a link typed in the message after a command that took a pasted link's preview, and puts nothing more in the command's place", async () => {
      const { fetch, answer } = slowPreviews(basecamp);
      const onCommand = vi.fn<CommandRunner>(async () => true);
      const { onSend, addPreview, input, user, view } = await showComposer({ onCommand });
      await user.type(input, "/search ");
      await user.paste("https://basecamp.com");
      await user.keyboard("{Enter}");
      expect(onCommand).toHaveBeenCalledOnce();
      await answer();
      expect(shownPreviews(view)).toHaveLength(0);

      await user.type(input, "See http://www.basecamp.com{Enter}");
      expect(onSend).toHaveBeenLastCalledWith("<p>See http://www.basecamp.com</p>", false);
      await answer();
      await vi.waitFor(() => expect(addPreview).toHaveBeenCalledExactlyOnceWith(basecamp));
      expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string).url)).toEqual(["https://basecamp.com", "http://www.basecamp.com"]);
      expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
    });

    it("asks for the preview of a link typed in a draft opened in place of what took a pasted link's preview, as it goes", async () => {
      localStorage.setItem("composer-draft-u1-r1/saved", JSON.stringify([{ id: "d0", body: "<p>See http://www.basecamp.com</p>", savedAt: 1 }]));
      const fetch = previews(() => Response.json(basecamp));
      const { onSend, addPreview, input, user } = await showComposer();
      await user.paste("https://basecamp.com");
      await screen.findByRole("link", { name: "Basecamp" });
      await user.click(screen.getByRole("button", { name: "Manage drafts" }));
      await user.click(screen.getByRole("menuitemradio", { name: "See http://www.basecamp.com" }));
      await waitFor(() => expect(input).toHaveFocus());

      await user.keyboard("{Enter}");
      expect(onSend).toHaveBeenCalledExactlyOnceWith("<p>See http://www.basecamp.com</p>", false);
      await vi.waitFor(() => expect(addPreview).toHaveBeenCalledExactlyOnceWith(basecamp));
      expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string).url)).toEqual(["https://basecamp.com", "http://www.basecamp.com"]);
    });

    it("adds none to a message that took a preview as it was written, even one taken out of it", async () => {
      const fetch = previews(() => Response.json(basecamp));
      const { onSend, addPreview, input, user, view } = await showComposer();
      await user.paste("https://basecamp.com");
      await screen.findByRole("link", { name: "Basecamp" });
      await user.keyboard("{Enter}");
      expect(onSend.mock.calls[0]![0]).toContain(OPENGRAPH_EMBED_CONTENT_TYPE);

      await user.paste("https://basecamp.com");
      await screen.findByRole("link", { name: "Basecamp" });
      await user.click(screen.getByRole("button", { name: "Remove" }));
      expect(shownPreviews(view)).toHaveLength(0);
      await user.type(input, " is calm{Enter}");
      expect(onSend).toHaveBeenLastCalledWith("<p>https://basecamp.com is calm</p>", false);

      await act(async () => {});
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(addPreview).not.toHaveBeenCalled();
    });

    it("asks for a pasted link changed before the message went as it went, rather than add the pasted one's preview", async () => {
      let answerPasted!: () => void;
      const pastedAnswered = new Promise<void>((resolve) => (answerPasted = resolve));
      const fetch = previews(async (url) => {
        if (url.endsWith("/story")) await pastedAnswered;
        return Response.json({ ...basecamp, title: url });
      });
      const { addPreview, input, user } = await showComposer();
      await user.paste("https://example.com/story");
      await user.type(input, "/other{Enter}");
      await vi.waitFor(() => expect(addPreview).toHaveBeenCalledExactlyOnceWith({ ...basecamp, title: "https://example.com/story/other" }));
      expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);

      await act(async () => answerPasted());
      expect(addPreview).toHaveBeenCalledOnce();
    });

    it("asks once for a pasted link's page that has none, then for a link typed after it, and forgets a preview whose link has gone", async () => {
      const answers: Record<string, Response> = { "https://example.com/none": new Response(null, { status: 204 }), "https://example.com/some": Response.json(basecamp) };
      const fetch = previews((url) => answers[url]!);
      const { addPreview, input, user } = await showComposer();
      await user.paste("https://example.com/none");
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await user.type(input, " has none{Enter}");
      await act(async () => {});
      expect(fetch).toHaveBeenCalledOnce();

      await user.paste("https://example.com/none");
      await user.type(input, " has none, but https://example.com/some does{Enter}");
      await vi.waitFor(() => expect(addPreview).toHaveBeenCalledExactlyOnceWith(basecamp));
      expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string).url)).toEqual(["https://example.com/none", "https://example.com/none", "https://example.com/some"]);

      addPreview.mockClear();
      const { answer } = slowPreviews(basecamp);
      await user.paste("https://basecamp.com");
      await user.clear(input);
      await user.type(input, "Never mind{Enter}");
      await answer();
      expect(addPreview).not.toHaveBeenCalled();
    });
  });
});

describe("Typing indicator", () => {
  it("reports typing while there's text, and stops when it's cleared, but not when the box loses focus", async () => {
    const { onTyping, input, user } = await showComposer();
    await user.type(input, "Hi");
    expect(onTyping).toHaveBeenLastCalledWith(true);
    await user.clear(input);
    expect(onTyping).toHaveBeenLastCalledWith(false);
    await user.type(input, "Hi");
    onTyping.mockClear();
    await user.tab();
    expect(onTyping).not.toHaveBeenCalled();
  });

  it("leaves it to the message, whose arrival stops the others showing you typing", async () => {
    const { onTyping, input, user } = await showComposer();
    await user.type(input, "Hi{Enter}");
    expect(onTyping).not.toHaveBeenCalledWith(false);
  });

  const typist = (name: string, i: number): Typist => ({ user: { id: `u${i}`, name } });

  it.each([
    [["Ada"], "Ada"],
    [["Grace", "Ada"], "Ada, Grace"],
    [["Linus", "Grace", "Ada", "Ken"], "Ada, Grace, Ken, Linus"],
    // Sorted by code unit, as JavaScript sorts strings, so capitals come first.
    [["ada", "Bob"], "Bob, ada"],
  ])("names whoever is typing after a spinner, sorted and comma-separated: %j", async (names, line) => {
    const { view } = await showComposer({ typing: names.map(typist) });
    const indicator = view.container.querySelector(".spinner")!;
    expect(indicator).toHaveTextContent(line, { normalizeWhitespace: false });
    expect(indicator).not.toHaveClass("hidden");
    expect(indicator.parentElement).not.toHaveClass("opacity-0");
    expect(indicator.closest("[aria-live]")).toBeNull();
  });

  it("names them as the people directory lists them now, which follows a rename since the room heard them", async () => {
    const grace = { id: "u2", name: "Grace Hopper", bio: null, role: "member", status: "active", avatarUrl: "/users/u2/avatar" } as const;
    const { container } = render(
      <PeopleContext value={new Map([[grace.id, grace]])}>
        <Composer
          roomId="r1"
          roomName="general"
          userId="u1"
          typing={[typist("Linus", 1), typist("Grace", 2)]}
          disabled={false}
          onSend={vi.fn(() => went)}
          onSendFiles={vi.fn()}
          onTyping={vi.fn()}
        />
      </PeopleContext>,
    );
    await screen.findByRole("textbox", { name: "Write a message" });
    expect(container.querySelector(".spinner")).toHaveTextContent("Grace Hopper, Linus", { normalizeWhitespace: false });
  });

  it("follows an answerer's name with what it's doing meanwhile, when it says, among the others typing", async () => {
    const digg = { user: { id: "u9", name: "digg" }, doing: "is using Digg: digg_get_post" };
    const { view } = await showComposer({ typing: [typist("Grace", 2), digg, typist("Ada", 1)] });
    expect(view.container.querySelector(".spinner")).toHaveTextContent("Ada, Grace, digg is using Digg: digg_get_post", { normalizeWhitespace: false });

    view.rerender(<Composer roomId="r1" roomName="general" userId="u1" typing={[{ user: digg.user }]} disabled={false} onSend={() => went} onSendFiles={() => {}} onTyping={() => {}} />);
    expect(view.container.querySelector(".spinner")).toHaveTextContent(/^digg$/, { normalizeWhitespace: false });
  });

  it("shows nothing while nobody is typing, and fades in when someone starts", async () => {
    const { view } = await showComposer();
    const indicator = view.container.querySelector(".spinner")!;
    expect(indicator).toHaveTextContent("");
    expect(indicator).toHaveClass("hidden");
    expect(indicator.parentElement).toHaveClass("opacity-0", "transition-opacity", "duration-300");
  });
});

describe("Only members see a room", () => {
  it("says a room that's gone was deleted, in red, shaking once where motion is welcome", () => {
    render(<RoomDeleted />);
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("This room was deleted.");
    expect(notice).toHaveClass("text-negative", "border-negative", "motion-safe:animate-shake");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
