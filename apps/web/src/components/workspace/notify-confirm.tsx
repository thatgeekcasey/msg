import { useEffect, useRef, useState } from "react";
import type { NotifiedCounts } from "@ember/protocol";
import { mentionsIn, SPECIAL_MENTIONS, type SpecialMention } from "@ember/richtext/dom";
import { AtSign, Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAccount } from "@/hooks/use-account";
import { useMounted } from "@/hooks/use-mounted";
import { fetchNotified } from "@/lib/api";
import type { AskToNotify } from "@/lib/slash-commands";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE, MAIN_ACTION, OTHER_ACTION } from "./unsaved-changes";

/** How many people a room holds, its writer too, from which a message notifying it asks first, as Slack asks in a channel of six or more. */
export const ASKS_FROM_MEMBERS = 6;

/** What the dialog says each special mention does, in room `room`. */
const DOES: Record<SpecialMention, (room: string) => string> = {
  here: (room) => `@here notifies everyone active in #${room}.`,
  channel: (room) => `@channel notifies everyone in #${room}.`,
  everyone: () => "@everyone notifies everyone in the workspace.",
};

/** The widest of a message's special mentions that would notify its room, and how many people it would. */
interface Notifying {
  mention: SpecialMention;
  people: number;
}

/**
 * What to ask before `body` goes to a room `counts` tells of: its widest special mention that would
 * notify the room, and how many people that would notify, in a room of six or more where anyone would
 * be notified. Otherwise it goes without asking.
 */
export function askingFor(body: string, counts: NotifiedCounts): Notifying | null {
  if (counts.members < ASKS_FROM_MEMBERS) return null;
  const made = mentionsIn(body).specialMentions;
  const mention = SPECIAL_MENTIONS.findLast((mention) => made.includes(mention) && counts.mentions[mention] !== undefined);
  const people = mention === undefined ? 0 : (counts.mentions[mention] ?? 0);
  return mention !== undefined && people > 0 ? { mention, people } : null;
}

/** "1 person" or "14 people". */
const peopleCount = (people: number) => (people === 1 ? "1 person" : `${people.toLocaleString("en-US")} people`);

/**
 * Asks, before a message whose @channel, @here or @everyone would notify a room of six or more goes,
 * whether to send it, as Slack asks, unless the workspace has that off, or `asks` is false for a composer
 * whose messages notify nobody, as a thread's and a DM's. `confirm` sends what's written by `send` at
 * once when there's nothing to ask, as when the room's counts don't come, or once Send is pressed; Cancel
 * leaves it written. The composer can still be written in as the counts come, so it's what `written`
 * reads then that's asked about, and `send` sends what's picked by then. A message being scheduled asks
 * the same, with Schedule for Send, as it notifies them once it's sent. `askToNotify` asks the same of a
 * message a command sends to a room, this one or another, from any composer. The composer shows `dialog`,
 * which gives focus back by `onClosed` as it closes.
 */
export function useNotifyConfirm(roomId: string, roomName: string, asks: boolean, onClosed: () => void) {
  const { warnBeforeNotifying } = useAccount();
  // What the dialog asks, of which room, kept as it closes so that it doesn't empty while it fades.
  const [asking, setAsking] = useState<(Notifying & { roomName: string; action: Action; send: () => void; cancel: () => void; open: boolean }) | null>(null);
  // While a room's counts are on their way, sending again waits for them.
  const checking = useRef(false);
  const mounted = useMounted();
  // What's done if the composer goes while the dialog asks, as for a message that isn't to go.
  const unanswered = useRef<() => void>(undefined);
  useEffect(() => () => unanswered.current?.(), []);

  // Sends what `written` reads to room `to` by `send`, asking first where it would notify six or more
  // there, or doesn't, by `cancel`, where its writer says not to, or the composer's gone meanwhile.
  const confirmFor = (to: { id: string; name: string }, written: () => string, send: () => void, cancel: () => void, action: Action = "Send") => {
    if (!warnBeforeNotifying || mentionsIn(written()).specialMentions.length === 0) return send();
    checking.current = true;
    void fetchNotified(to.id)
      .catch(() => null)
      .then((counts) => {
        checking.current = false;
        // Leaving the room meanwhile keeps the message as its draft.
        if (!mounted.current) return cancel();
        const notifying = counts && askingFor(written(), counts);
        if (!notifying) return send();
        unanswered.current = cancel;
        setAsking({ ...notifying, roomName: to.name, action, send, cancel, open: true });
      });
  };

  const confirm = (written: () => string, send: () => void, action?: Action) => {
    if (checking.current) return;
    if (!asks) return send();
    confirmFor({ id: roomId, name: roomName }, written, send, () => {}, action);
  };

  // While another message's counts are on their way, a command's doesn't go, and so is written again.
  const askToNotify: AskToNotify = (to, body) =>
    new Promise((resolve) => {
      if (checking.current) return resolve(false);
      confirmFor(to, () => body, () => resolve(true), () => resolve(false));
    });

  // Answered once, as the dialog can still be pressed as it fades.
  const answer = (sending: boolean) => {
    if (!asking?.open) return;
    unanswered.current = undefined;
    setAsking({ ...asking, open: false });
    if (sending) asking.send();
    else asking.cancel();
  };
  const dialog = asking && <NotifyConfirmDialog {...asking} onClosed={onClosed} onSend={() => answer(true)} onCancel={() => answer(false)} />;
  return { confirm, askToNotify, dialog };
}

/** What the dialog's main button does: sends the message, or schedules it, to notify them once it's sent. */
type Action = "Send" | "Schedule";

interface DialogProps extends Notifying {
  open: boolean;
  roomName: string;
  action: Action;
  onSend: () => void;
  onCancel: () => void;
  onClosed: () => void;
}

/**
 * "Notify 14 people?", with what the mention does, Cancel, and Send, or Schedule, which has focus, so that
 * Enter sends and Escape goes back to what's written, as the dialogs styled as Unsaved Changes look. Opened
 * by no button, it leaves focus to `onClosed` as it closes.
 */
function NotifyConfirmDialog({ mention, people, open, roomName, action, onSend, onCancel, onClosed }: DialogProps) {
  const sendButton = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={(open) => open || onCancel()}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={DIALOG_BACKDROP}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          sendButton.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
        className={DIALOG}
      >
        <button type="button" aria-label="Close" onClick={onCancel} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <div aria-hidden="true" className="mb-5 grid size-[46px] place-items-center rounded-xl border bg-surface">
          <AtSign className="size-[22px]" />
        </div>
        <DialogTitle className={DIALOG_TITLE}>Notify {peopleCount(people)}?</DialogTitle>
        <DialogDescription className="leading-[1.65]">{DOES[mention](roomName)}</DialogDescription>
        <div className="mt-[26px] flex justify-end gap-2.5">
          <button type="button" onClick={onCancel} className={OTHER_ACTION}>
            Cancel
          </button>
          <button ref={sendButton} type="button" onClick={onSend} className={MAIN_ACTION}>
            {action}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
