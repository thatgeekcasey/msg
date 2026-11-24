import { useId, useMemo, useRef, useState, type Ref } from "react";
import { NavArrowDown } from "@/components/icons/iconoir";
import { FIELD_INPUT } from "@/components/field";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { timeLabel } from "@/lib/messages";
import { customTimeStart, sameDay, sameTimeOf, scheduleChoices, scheduleDayLabel, scheduleDays, scheduleTimes, timeZoneLabel, type ScheduleChoice } from "@/lib/schedule-times";
import { cn } from "@/lib/utils";
import { ShortcutTooltip } from "./shortcut-tooltip";
import { DIALOG, DIALOG_BACKDROP, DIALOG_TITLE, MAIN_ACTION, OTHER_ACTION } from "./unsaved-changes";

interface MenuProps {
  disabled: boolean;
  className: string;
  /** Schedules what's written for `at`. */
  onSchedule: (at: Date) => void;
  /** Opens Custom time, once the menu's gone. */
  onCustomTime: () => void;
  /** Puts focus back in the text once the menu's gone, but for Custom time. */
  onClosed: () => void;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Slack's Schedule for later, the chevron joined to Send: a menu headed Schedule message, of later today,
 * and tomorrow and Monday mornings, as Slack offers them, then Custom time, which picks a day and a time.
 */
export function ScheduleMenu({ disabled, className, onSchedule, onCustomTime, onClosed, ref }: MenuProps) {
  const [open, setOpen] = useState(false);
  // The times as of when it opened, kept as it closes, so they don't change while it fades.
  const [choices, setChoices] = useState<ScheduleChoice[]>([]);
  const custom = useRef(false);
  const openChanged = (opened: boolean) => {
    if (opened) setChoices(scheduleChoices());
    setOpen(opened);
  };
  return (
    <DropdownMenu open={open} onOpenChange={openChanged}>
      <ShortcutTooltip label="Schedule for later" hidden={open}>
        <DropdownMenuTrigger asChild>
          <button ref={ref} type="button" aria-label="Schedule for later" disabled={disabled} className={className}>
            <NavArrowDown className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
      </ShortcutTooltip>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={8}
        // Custom time's dialog opens once the menu has closed, so the menu doesn't hand focus back over it.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!custom.current) return onClosed();
          custom.current = false;
          onCustomTime();
        }}
      >
        <ScheduleItems choices={choices} onSchedule={onSchedule} onCustomTime={() => (custom.current = true)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ItemsProps {
  /** The times offered, as `scheduleChoices` has them as the menu opens. */
  choices: ScheduleChoice[];
  onSchedule: (at: Date) => void;
  /** Picks Custom time, which opens once the menu's gone. */
  onCustomTime: () => void;
}

/** The menu's items, which + lists too where the composer's row has no room for the chevron, and Reschedule. */
export function ScheduleItems({ choices, onSchedule, onCustomTime }: ItemsProps) {
  return (
    <>
      <DropdownMenuLabel>Schedule message</DropdownMenuLabel>
      {choices.map((choice) => (
        <DropdownMenuItem key={choice.label} onSelect={() => onSchedule(choice.at)}>
          {choice.label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onCustomTime}>
        Custom time
      </DropdownMenuItem>
    </>
  );
}

interface CustomTimeProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Schedules for the time picked. */
  onPick: (at: Date) => void;
  /** Puts focus back where it was once the dialog's gone. */
  onClosed?: () => void;
  /** Whether it moves a message scheduled already, rather than scheduling what's written. */
  rescheduling?: boolean;
}

const SELECT = cn("w-full min-w-0 border outline-none dark:bg-input/30", FIELD_INPUT);

/**
 * Slack's Custom time: the time zone the times are in, a day, today through 120 days on, and a time, each
 * half hour of it still to come, starting at the first at least half an hour on, then Cancel and Schedule
 * Message. A time picked stays as the day changes, where the day has it.
 */
export function CustomTimeDialog({ open, onOpenChange, onPick, onClosed, rescheduling = false }: CustomTimeProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={DIALOG_BACKDROP}
        onCloseAutoFocus={(event) => {
          if (!onClosed) return;
          event.preventDefault();
          onClosed();
        }}
        className={cn(DIALOG, "w-[480px]")}
      >
        {/* As of when it opens, each time it does. */}
        {open && (
          <CustomTimeForm
            rescheduling={rescheduling}
            onPick={(at) => {
              onPick(at);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CustomTimeForm({ rescheduling, onPick, onCancel }: { rescheduling: boolean; onPick: (at: Date) => void; onCancel: () => void }) {
  const [now] = useState(() => new Date());
  const days = useMemo(() => scheduleDays(now), [now]);
  const [picked, setPicked] = useState(() => customTimeStart(now));
  const day = Math.max(0, days.findIndex((day) => sameDay(day, picked)));
  const times = useMemo(() => scheduleTimes(days[day]!, now), [days, day, now]);
  const time = times.find((at) => at.getTime() === picked.getTime()) ?? times[0]!;
  const id = useId();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onPick(time);
      }}
    >
      <DialogTitle className={DIALOG_TITLE}>{rescheduling ? "Reschedule message" : "Schedule message"}</DialogTitle>
      <DialogDescription className="text-sm text-muted-foreground">Time zone: {timeZoneLabel(now)}</DialogDescription>
      <div className="mt-4 flex gap-2.5 upto-480px:flex-col">
        <select
          id={`${id}-day`}
          aria-label="Date"
          value={day}
          onChange={(event) => {
            const next = days[Number(event.target.value)]!;
            setPicked(sameTimeOf(scheduleTimes(next, now), time) ?? next);
          }}
          className={SELECT}
        >
          {days.map((day, index) => (
            <option key={day.getTime()} value={index}>
              {scheduleDayLabel(day, now)}
            </option>
          ))}
        </select>
        <select id={`${id}-time`} aria-label="Time" value={time.getTime()} onChange={(event) => setPicked(new Date(Number(event.target.value)))} className={cn(SELECT, "w-40 flex-none upto-480px:w-full")}>
          {times.map((at) => (
            <option key={at.getTime()} value={at.getTime()}>
              {timeLabel(at)}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-end gap-2.5">
        <button type="button" onClick={onCancel} className={OTHER_ACTION}>
          Cancel
        </button>
        <button type="submit" className={MAIN_ACTION}>
          {rescheduling ? "Reschedule Message" : "Schedule Message"}
        </button>
      </div>
    </form>
  );
}
