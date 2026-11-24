import { useContext, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { THREAD_DELETED, type ScheduledMessage } from "@ember/protocol";
import { plainText, PRIVATE_ROOM_NAME, userIdFromSgid, writtenBody } from "@ember/richtext/dom";
import { Clock, Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PeopleContext } from "@/hooks/use-directory";
import type { Scheduling } from "@/hooks/use-room";
import { RoomsContext } from "@/hooks/use-rooms";
import { scheduleChoices, sendAtLabel, type ScheduleChoice } from "@/lib/schedule-times";
import { cn } from "@/lib/utils";
import { MessageEditor } from "./message-editor";
import { CustomTimeDialog, ScheduleItems } from "./schedule-menu";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE } from "./unsaved-changes";

/** "1 scheduled message", or "3 scheduled messages". */
const countOf = (count: number) => (count === 1 ? "1 scheduled message" : `${count} scheduled messages`);

/**
 * The line over the composer once you have messages scheduled where it writes, with Slack's clock: "1
 * scheduled message in #launch", which lists them. `place` is where, as "in" goes on. It has a line of
 * its own, of which only the words are the button.
 */
export function ScheduledLine({ count, place, onOpen }: { count: number; place: string; onOpen: () => void }) {
  return (
    <div className="flex w-full min-w-0 px-3">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 text-start text-[13px] leading-normal text-muted-foreground hover:text-message-ink hover:underline touch:min-h-11"
      >
        <Clock className="size-4 shrink-0" />
        <span className="truncate">
          {countOf(count)} {place}
        </span>
      </button>
    </div>
  );
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The messages scheduled where the composer writes, soonest first. */
  messages: ScheduledMessage[];
  roomId: string;
  /** Where they are, as "in" goes on. */
  place: string;
  scheduling: Scheduling;
  /** Puts focus back in the composer's text once the dialog's gone. */
  onClosed: () => void;
}

/**
 * What you have scheduled where the composer writes, soonest first, as Slack's Scheduled lists it: when
 * each is to be sent, its text, and why it couldn't be, if it couldn't, with Edit, which edits it in its
 * place, Reschedule, which offers the schedule menu's times, Send now and Delete. A reply whose thread's
 * message has been deleted can't be sent, so it has only Edit and Delete.
 */
export function ScheduledDialog({ open, onOpenChange, messages, roomId, place, scheduling, onClosed }: DialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={DIALOG_BACKDROP}
        // Escape in the message being edited, the list's only form, closes its editor, or the list of people
        // to mention it has open, as in the timeline, rather than the list.
        onEscapeKeyDown={(event) => {
          if (event.target instanceof Element && event.target.closest("form")) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
        // Wide enough for the editor's formatting row on one line.
        className={cn(DIALOG, "w-[600px]")}
      >
        {open && <ScheduledList messages={messages} roomId={roomId} place={place} scheduling={scheduling} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

interface ListProps {
  messages: ScheduledMessage[];
  roomId: string;
  place: string;
  scheduling: Scheduling;
  onClose: () => void;
}

function ScheduledList({ messages, roomId, place, scheduling, onClose }: ListProps) {
  const [editing, setEditing] = useState<string | null>(null);
  // Why the last change couldn't go, as when the room is away.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [now] = useState(() => new Date());
  return (
    <>
      <button type="button" aria-label="Close" onClick={onClose} className={DIALOG_CLOSE}>
        <Xmark className="size-[18px]" />
      </button>
      <DialogTitle className={DIALOG_TITLE}>Scheduled messages</DialogTitle>
      <DialogDescription className="text-sm text-muted-foreground">
        {messages.length === 0
          ? `You have nothing scheduled ${place}.`
          : `${countOf(messages.length)} ${place}, sent as yours when ${messages.length === 1 ? "it's" : "they're"} due.`}
      </DialogDescription>
      {refusal && (
        <p role="alert" className="mt-3 text-sm text-negative">
          {refusal}
        </p>
      )}
      {messages.length > 0 && (
        <ul className="mt-3 divide-y">
          {messages.map((message) => (
            <ScheduledItem
              key={message.id}
              message={message}
              roomId={roomId}
              now={now}
              editing={editing === message.id}
              onEdit={(edit) => setEditing(edit ? message.id : null)}
              scheduling={scheduling}
              onDone={setRefusal}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** A scheduled message's buttons, smaller than a dialog's own. */
const ACTION = "inline-flex min-h-7 cursor-pointer items-center justify-center rounded-[7px] border px-2.5 text-[13px] font-medium hover:bg-hover touch:min-h-11 touch:min-w-11";

interface ItemProps {
  message: ScheduledMessage;
  roomId: string;
  /** When the list opened, as its times are said as of. */
  now: Date;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  scheduling: Scheduling;
  /** Hears whether a change went: why not, or null once it did. */
  onDone: (refusal: string | null) => void;
}

/**
 * What the scheduled message `body` says, as its list shows it: its plain text, naming the people and rooms
 * it mentions as they are now, since the room keeps a mention by its id alone, and a room you're no longer
 * in as a private room, as a message shows it.
 */
function useShownText(body: string): string {
  const people = useContext(PeopleContext);
  const rooms = useContext(RoomsContext);
  return plainText(
    body,
    (sgid) => {
      const person = people.get(userIdFromSgid(sgid) ?? "");
      return person && { id: person.id, name: person.name };
    },
    (id) => rooms?.get(id) ?? { id, name: PRIVATE_ROOM_NAME },
  );
}

function ScheduledItem({ message, roomId, now, editing, onEdit, scheduling, onDone }: ItemProps) {
  const [choices, setChoices] = useState<ScheduleChoice[]>([]);
  const [customTime, setCustomTime] = useState(false);
  const customTimePicked = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const { id, body } = message;
  const text = useShownText(body);
  const sendable = message.failure !== THREAD_DELETED;
  const reschedule = (at: Date) => onDone(scheduling.reschedule(id, at));
  // Focus goes back to Edit as the editor closes, as it's saved or put away, rather than to the list.
  const closeEditor = () => {
    flushSync(() => onEdit(false));
    editButton.current?.focus();
  };
  return (
    <li className="py-3">
      <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <Clock className="size-3.5 shrink-0" />
        Scheduled for {sendAtLabel(new Date(message.sendAt), now)}
      </p>
      {editing ? (
        <MessageEditor
          message={{ body, mentions: writtenBody(body).mentions, roomId }}
          // The editor stays until the room has the edit, so what's written isn't lost where it's refused.
          onSave={(edited) =>
            scheduling.edit(id, edited).then((refusal) => {
              onDone(refusal);
              return refusal === null;
            })
          }
          onDelete={() => onDone(scheduling.remove(id))}
          onClose={closeEditor}
        />
      ) : (
        <p className="mt-1 line-clamp-3 text-sm whitespace-pre-line text-message-ink wrap-anywhere">{text.trim() || "Message"}</p>
      )}
      {message.failure && <p className="mt-1 text-[13px] text-negative">{message.failure}</p>}
      {!editing && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button ref={editButton} type="button" onClick={() => onEdit(true)} className={ACTION}>
            Edit
          </button>
          {sendable && (
            <>
              <DropdownMenu onOpenChange={(opened) => opened && setChoices(scheduleChoices())}>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={ACTION}>
                    Reschedule
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  // Custom time opens once the menu has handed focus back to Reschedule, which it gives focus back to as it closes.
                  onCloseAutoFocus={() => {
                    if (!customTimePicked.current) return;
                    customTimePicked.current = false;
                    setCustomTime(true);
                  }}
                >
                  <ScheduleItems choices={choices} onSchedule={reschedule} onCustomTime={() => (customTimePicked.current = true)} />
                </DropdownMenuContent>
              </DropdownMenu>
              <button type="button" onClick={() => onDone(scheduling.sendNow(id))} className={ACTION}>
                Send now
              </button>
            </>
          )}
          <button type="button" onClick={() => confirm("Are you sure you want to delete this scheduled message?") && onDone(scheduling.remove(id))} className={cn(ACTION, "text-negative")}>
            Delete
          </button>
        </div>
      )}
      <CustomTimeDialog open={customTime} onOpenChange={setCustomTime} rescheduling onPick={reschedule} />
    </li>
  );
}
