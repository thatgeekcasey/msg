import { useCallback, useEffect, useRef, useState, type ComponentProps, type MouseEvent } from "react";
import type { Involvement } from "@ember/protocol";
import { Bell, BellOff, Xmark } from "@/components/icons/iconoir";
import { usePush } from "@/hooks/use-push";
import { isSignedOut } from "@/lib/api";
import { INVOLVEMENT_LABELS } from "@/lib/involvement";
import type { PushNotice } from "@/lib/push";
import { cn } from "@/lib/utils";
import { InvolvementButton } from "./involvement-button";
import { NotificationHelp } from "./notification-help";
import { HEADER_BUTTON } from "./page-header";

/** A notice the dialog shows, numbered, so the same one again opens the help afresh. */
interface Shown {
  notice: PushNotice;
  count: number;
}

/** What the bell says under itself when a press couldn't save a level. */
export const INVOLVEMENT_NOT_SAVED = "Couldn’t update notifications. Try again.";
/** How long it says what a press did. */
export const FEEDBACK_MS = 3200;

/** What the bell said last, numbered, so screen readers hear the same thing again. */
interface Feedback {
  message: string;
  /** Whether it shows at once, as for a key's press, rather than sliding in. */
  instant: boolean;
  visible: boolean;
  count: number;
}

/**
 * The bell in a room's header: your level in the room once this browser has notifications on, and until
 * then Enable notifications, which turns them on, or says why it can't in the Notification setup dialog.
 * While it's turning them on it's dimmed, as Campfire dims what's disabled (base.css), and ignores
 * presses, keeping focus, and the level's bell takes focus from it once they're on. It confirms each
 * level a press saves, or says it couldn't, under itself for a few seconds (`useFeedback`).
 */
export function NotificationBell({ className, onFailed, ...props }: ComponentProps<typeof InvolvementButton>) {
  const { on, turningOn, turnOn } = usePush();
  const [shown, setShown] = useState<Shown | null>(null);
  // Whether this bell had focus as it turned notifications on.
  const [handingOver, setHandingOver] = useState(false);
  const { feedback, show } = useFeedback();

  const saved = (involvement: Involvement, keyboard: boolean) => show(INVOLVEMENT_LABELS[involvement], keyboard);
  // An ended session still goes to sign in.
  const failed = (error: unknown, keyboard: boolean) => (isSignedOut(error) ? onFailed(error, keyboard) : show(INVOLVEMENT_NOT_SAVED, keyboard));

  const enable = async (event: MouseEvent<HTMLButtonElement>) => {
    if (turningOn) return;
    setHandingOver(document.activeElement === event.currentTarget);
    const notice = await turnOn();
    if (!notice) return;
    setHandingOver(false);
    setShown((shown) => ({ notice, count: (shown?.count ?? 0) + 1 }));
  };

  return (
    <span className="relative inline-flex">
      {on ? (
        <InvolvementButton {...props} onSaved={saved} onFailed={failed} autoFocus={handingOver} className={className} />
      ) : (
        <>
          <button
            type="button"
            title="Enable notifications"
            aria-disabled={turningOn || undefined}
            aria-busy={turningOn || undefined}
            onClick={enable}
            className={cn("cursor-pointer [&[aria-disabled=true]:not(:hover,:active)]:brightness-75", className)}
          >
            <Bell className="size-5" />
            <span className="sr-only">Enable notifications</span>
          </button>
          <NotificationSetup shown={shown} />
        </>
      )}
      {/* The tooltip, for the eye only, as the status says the same. */}
      <span
        data-notification-tooltip
        aria-hidden="true"
        className={cn(
          "pointer-events-none invisible absolute top-[calc(100%+10px)] right-0 z-30 w-max max-w-[min(280px,calc(100vw-80px))] -translate-y-[3px] rounded-[8px] bg-foreground px-3 py-[9px] text-start text-[12px] leading-[1.45] font-medium text-pretty text-background opacity-0 shadow-[0_4px_14px_var(--color-tooltip-shadow)] transition-[opacity,translate,visibility] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] before:absolute before:-top-[3px] before:right-[14px] before:size-1.5 before:rotate-45 before:bg-inherit motion-reduce:translate-none motion-reduce:transition-none",
          feedback?.visible && "visible translate-y-0 opacity-100",
          feedback?.instant && "transition-none",
        )}
      >
        {feedback?.message}
      </span>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {feedback && <span key={feedback.count}>{feedback.message}</span>}
      </span>
    </span>
  );
}

/**
 * What the bell says it did, for 3.2 seconds or until Escape, at once when a key pressed it, and sliding
 * in otherwise.
 */
function useFeedback() {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  const dismiss = useCallback(() => {
    clearTimeout(timeout.current);
    setFeedback((feedback) => (feedback?.visible ? { ...feedback, visible: false } : feedback));
  }, []);
  const show = useCallback(
    (message: string, instant: boolean) => {
      clearTimeout(timeout.current);
      setFeedback((feedback) => ({ message, instant, visible: true, count: (feedback?.count ?? 0) + 1 }));
      timeout.current = setTimeout(dismiss, FEEDBACK_MS);
    },
    [dismiss],
  );

  const visible = feedback?.visible ?? false;
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, dismiss]);
  useEffect(() => () => clearTimeout(timeout.current), []);

  return { feedback, show };
}

/**
 * The Notification setup dialog, which says why notifications aren't on, with the help for this browser
 * when the notice calls for it. It's Campfire's `.dialog`, over its gradient, with buttons styled as the
 * header's.
 */
function NotificationSetup({ shown }: { shown: Shown | null }) {
  const { platform } = usePush();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!shown) return;
    if (!dialog.current?.open) dialog.current?.showModal();
    // As Close's `autofocus` does as the dialog opens, which React would only do as it first renders.
    close.current?.focus();
  }, [shown]);

  return (
    <dialog
      ref={dialog}
      aria-label="Notification setup"
      className="m-auto w-[50ch] max-w-[calc(100dvw-2rem)] rounded-[1em] border bg-background p-4 text-foreground shadow-[0_8px_24px_var(--color-menu-shadow)] [--inline-space:1rem] backdrop:bg-(image:--setup-backdrop) backdrop:opacity-75"
    >
      <div className="flex flex-col text-center">
        <span className="mx-auto">
          <BellOff className="size-12" />
          <span className="sr-only">Notifications alert</span>
        </span>
        <section>
          <h1 className="m-0 text-[1.4rem] font-bold">{shown?.notice.title ?? "Enable notifications"}</h1>
          <p role="status" className="my-[1em]">
            {shown?.notice.message}
          </p>
          <div hidden={!shown?.notice.help} className="mt-4 text-start">
            <NotificationHelp key={shown?.count} platform={platform} />
          </div>
        </section>
        <button ref={close} type="button" onClick={() => dialog.current?.close()} className={cn(HEADER_BUTTON, "absolute top-6 right-4 cursor-pointer")}>
          <span className="sr-only">Close</span>
          <Xmark className="size-[1.3em]" />
        </button>
      </div>
    </dialog>
  );
}
