import { useState, type Ref } from "react";
import { writtenBody } from "@ember/richtext/dom";
import { EditPencil } from "@/components/icons/iconoir";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SavedDraft } from "@/lib/saved-drafts";
import { ShortcutTooltip } from "./shortcut-tooltip";

/** What Manage drafts lists as it opens: what's written now, if anything, and the drafts put aside, newest first. */
export interface DraftsShown {
  written: string | null;
  saved: SavedDraft[];
}

/** A composer's drafts, as Manage drafts lists them and acts on them. */
export interface Drafts {
  /** Where they are, which the menu's heading names. */
  place: "room" | "conversation" | "thread";
  /** What's written and put aside now, read as a menu of them opens. */
  look: () => DraftsShown;
  /** Puts what's written aside, emptying the composer for another. */
  onPutAside: () => void;
  /** Opens the draft put aside as `id` in the composer, putting what's written aside in its place. */
  onOpen: (id: string) => void;
}

/** Whether there's anything for a menu of drafts to list. */
export const listsDrafts = ({ written, saved }: DraftsShown) => written !== null || saved.length > 0;

/** What's written now, among the drafts, which the menu ticks. */
const WRITTEN = "written";

/**
 * Slack's Manage drafts, the pencil beside Send: a menu headed with where the drafts are, then the drafts, what's
 * written now ticked, any of which it opens, and Save as draft.
 */
export function DraftsMenu({ drafts, disabled, className, onClosed, ref }: { drafts: Drafts; disabled: boolean; className: string; onClosed: () => void; ref?: Ref<HTMLButtonElement> }) {
  const [open, setOpen] = useState(false);
  // Kept as the menu closes, so it doesn't empty while it fades.
  const [shown, setShown] = useState<DraftsShown>({ written: null, saved: [] });
  const openChanged = (opened: boolean) => {
    if (opened) setShown(drafts.look());
    setOpen(opened);
  };
  return (
    <DropdownMenu open={open} onOpenChange={openChanged}>
      <ShortcutTooltip label="Manage drafts" hidden={open}>
        <DropdownMenuTrigger asChild>
          <button ref={ref} type="button" aria-label="Manage drafts" disabled={disabled} className={className}>
            <EditPencil className="size-[18px] opacity-70" />
          </button>
        </DropdownMenuTrigger>
      </ShortcutTooltip>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={8}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        <DraftsItems drafts={drafts} shown={shown} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The menu's items, which + lists too where the composer's row has no room for the pencil. */
export function DraftsItems({ drafts, shown }: { drafts: Drafts; shown: DraftsShown }) {
  const heading = `Drafts in this ${drafts.place}`;
  return (
    <>
      <DropdownMenuLabel>{heading}</DropdownMenuLabel>
      <DropdownMenuRadioGroup aria-label={heading} value={shown.written === null ? "" : WRITTEN}>
        {shown.written !== null && <DraftItem value={WRITTEN} body={shown.written} />}
        {shown.saved.map((draft) => (
          <DraftItem key={draft.id} value={draft.id} body={draft.body} onSelect={() => drafts.onOpen(draft.id)} />
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={shown.written === null} onSelect={drafts.onPutAside}>
        Save as draft
      </DropdownMenuItem>
    </>
  );
}

/** A draft, by the first line of its text, cut short to fit. */
function DraftItem({ value, body, onSelect }: { value: string; body: string; onSelect?: () => void }) {
  return (
    <DropdownMenuRadioItem value={value} onSelect={onSelect}>
      <span className="max-w-56 min-w-0 truncate">{firstLineOf(body)}</span>
    </DropdownMenuRadioItem>
  );
}

/** The first line of `body`'s text, or "Draft" for one with none, as one with only a divider has. */
function firstLineOf(body: string): string {
  return (
    writtenBody(body)
      .plainText.split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? "Draft"
  );
}
