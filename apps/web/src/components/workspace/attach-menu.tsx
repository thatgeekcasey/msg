import { useRef, useState, type ComponentType } from "react";
import { CodeBrackets, Microphone, Plus, Upload, VideoCamera, Xmark, type IconoirIconProps } from "@/components/icons/iconoir";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ClipKind } from "@/lib/clips";
import { appleKeyboard, snippetShortcut, uploadShortcut, type Shortcut } from "@/lib/keyboard";
import { scheduleChoices, type ScheduleChoice } from "@/lib/schedule-times";
import { DraftsItems, listsDrafts, type Drafts, type DraftsShown } from "./drafts-menu";
import { ScheduleItems } from "./schedule-menu";
import { ShortcutTooltip } from "./shortcut-tooltip";

/** What the menu closed for, which says where focus goes as it does. */
type Choice = "upload" | "snippet" | "custom time" | ClipKind;

/** Schedule for later, as + offers it where the composer's row has no room for its chevron. */
export interface AttachedSchedule {
  /** Whether what's written can be scheduled. */
  schedulable: boolean;
  onSchedule: (at: Date) => void;
  /** Opens Custom time, once the menu's gone. */
  onCustomTime: () => void;
}

interface Props {
  disabled: boolean;
  className: string;
  /** Opens the browser's file picker, which it does only in the press itself. */
  onUpload: () => void;
  /** Opens Text snippet's dialog, once the menu's gone. */
  onSnippet: () => void;
  /** Starts recording a clip, once the menu's gone, where this browser can record one. */
  onRecordClip?: (kind: ClipKind) => void;
  /** Whether the composer's row shows the clips' own buttons, as the menu opens. */
  clipsInRow: () => boolean;
  /** The composer's drafts, where this browser can keep them. */
  drafts?: Drafts;
  /** Whether the composer's row shows Manage drafts, as the menu opens. */
  draftsInRow: () => boolean;
  /** Schedule for later's, where the room schedules messages. */
  schedule?: AttachedSchedule;
  /** Whether the composer's row shows Schedule for later's chevron, as the menu opens. */
  scheduleInRow: () => boolean;
  /** Puts focus back in the text once the menu's gone, but for a snippet. */
  onClosed: () => void;
}

/**
 * Slack's +, under the composer's text: a menu of Text snippet and Upload from your computer, Slack's two that
 * Ember has, each with its keys, and where the composer's row has no room for the clips' buttons, Record a
 * video clip and Record an audio clip, which Slack's apps have in their + too, for Manage drafts, the
 * drafts it lists, with Save as draft, and for Schedule for later's chevron, its times, once there's
 * something to schedule. The + is an × while it's open.
 */
export function AttachMenu({ disabled, className, onUpload, onSnippet, onRecordClip, clipsInRow, drafts, draftsInRow, schedule, scheduleInRow, onClosed }: Props) {
  const [open, setOpen] = useState(false);
  const [clips, setClips] = useState(false);
  const [draftsShown, setDraftsShown] = useState<DraftsShown | null>(null);
  const [scheduleShown, setScheduleShown] = useState<ScheduleChoice[] | null>(null);
  const chosen = useRef<Choice>(null);
  const openChanged = (opened: boolean) => {
    if (opened) {
      setClips(onRecordClip !== undefined && !clipsInRow());
      const shown = drafts && !draftsInRow() ? drafts.look() : null;
      setDraftsShown(shown && listsDrafts(shown) ? shown : null);
      // As Manage drafts shows only once something's written, as the times do in Slack's apps.
      setScheduleShown(schedule?.schedulable && !scheduleInRow() ? scheduleChoices() : null);
    }
    setOpen(opened);
  };
  return (
    <DropdownMenu open={open} onOpenChange={openChanged}>
      <ShortcutTooltip label="Attach" hidden={open}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Attach" disabled={disabled} className={className}>
            {open ? <Xmark className="size-[18px]" /> : <Plus className="size-[18px]" />}
          </button>
        </DropdownMenuTrigger>
      </ShortcutTooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        // The snippet's dialog and a clip's recorder open once the menu has closed, so the menu doesn't hand focus back over them.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const choice = chosen.current;
          chosen.current = null;
          if (choice === "snippet") onSnippet();
          else if (choice === "video" || choice === "audio") onRecordClip?.(choice);
          else if (choice === "custom time") schedule?.onCustomTime();
          else onClosed();
        }}
      >
        <Item icon={CodeBrackets} label="Text snippet" shortcut={snippetShortcut()} onSelect={() => (chosen.current = "snippet")} />
        <Item
          icon={Upload}
          label="Upload from your computer"
          shortcut={uploadShortcut()}
          onSelect={() => {
            chosen.current = "upload";
            onUpload();
          }}
        />
        {clips && (
          <>
            <Item icon={VideoCamera} label="Record a video clip" onSelect={() => (chosen.current = "video")} />
            <Item icon={Microphone} label="Record an audio clip" onSelect={() => (chosen.current = "audio")} />
          </>
        )}
        {drafts && draftsShown && (
          <>
            <DropdownMenuSeparator />
            <DraftsItems drafts={drafts} shown={draftsShown} />
          </>
        )}
        {schedule && scheduleShown && (
          <>
            <DropdownMenuSeparator />
            <ScheduleItems choices={scheduleShown} onSchedule={schedule.onSchedule} onCustomTime={() => (chosen.current = "custom time")} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ItemProps {
  icon: ComponentType<IconoirIconProps>;
  label: string;
  shortcut?: Shortcut;
  onSelect: () => void;
}

/** One of the menu's items, with its keys after it if it has any, as Slack's menu shows them. */
function Item({ icon: Icon, label, shortcut, onSelect }: ItemProps) {
  return (
    <DropdownMenuItem onSelect={onSelect} aria-keyshortcuts={shortcut?.aria} className="min-w-64 gap-2.5">
      <Icon className="size-[18px]" />
      {label}
      {shortcut && (
        <span aria-hidden className="ms-auto ps-6 text-xs text-muted-foreground">
          {shortcut.keys.join(appleKeyboard() ? "" : "+")}
        </span>
      )}
    </DropdownMenuItem>
  );
}
