import { useEffect, useRef, useState, type RefObject } from "react";
import { Edit, Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useMounted } from "@/hooks/use-mounted";
import { guardLeaving } from "@/hooks/use-route";
import { cn } from "@/lib/utils";

// The guard for room forms and its dialog, which guard workspace settings' room order too. Where the
// app's other dialogs are native ones, this is a Radix dialog, so it can open over the drawer, a Radix
// dialog itself, which would keep the pointer and focus from a native one.

/** What the dialog says about a room's form. */
const ROOM_CHANGES = "You’ve made changes to this room. Save them before you leave, or discard them to keep things as they were.";

/** The dialog's buttons: Campfire's `.btn`, 42px tall, 44px for fingers, and sharing a phone's width. */
const ACTION = "inline-flex min-h-[42px] cursor-pointer items-center justify-center rounded-[9px] border px-[22px] py-[0.5em] font-semibold touch:min-h-11 disabled:cursor-default upto-480px:flex-1";
/** Save, the dialog's main action, in ink, and Discard, the other, which dialogs styled as this one share. */
export const MAIN_ACTION = cn(ACTION, "border-transparent bg-foreground text-background hover:not-active:brightness-70");
export const OTHER_ACTION = cn(ACTION, "bg-background text-foreground");

/** The dialog: 420px wide, within the screen and its safe areas, scrolling what doesn't fit them. */
export const DIALOG = cn(
  "block w-[420px] max-w-[calc(100dvw-32px-env(safe-area-inset-left)-env(safe-area-inset-right))] sm:max-w-[calc(100dvw-32px-env(safe-area-inset-left)-env(safe-area-inset-right))]",
  "max-h-[calc(100dvh-32px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] overflow-auto rounded-[18px] p-7 text-foreground upto-480px:p-6",
  "shadow-[0_24px_80px_var(--color-dialog-shadow),0_4px_16px_var(--color-dialog-shadow-faint)]",
);
/** What's laid over the page behind the dialog. */
export const DIALOG_BACKDROP = "bg-dialog-backdrop backdrop-blur-[3px]";
export const DIALOG_TITLE = "mb-2.5 text-[22px] leading-[1.25] font-bold";
/** The button in the dialog's corner that closes it. */
export const DIALOG_CLOSE = "absolute end-3 top-3 inline-flex cursor-pointer items-center justify-center rounded-[9px] px-[1.1em] py-[0.5em] touch:min-h-11 disabled:cursor-default";

interface Props<T> {
  /** Whether the page holds changes that leaving would lose. */
  changed: boolean;
  /** Whether going to `path` keeps the changes, as the Everyone switch's move to the other form does. */
  stays: (path: string) => boolean;
  /**
   * Saves the changes, settling with what's saved once the server has it, after which the page compares
   * its form with that, in case it stays: when signing out fails, say.
   */
  onSave: () => Promise<T>;
  /** What the page does instead when it stays after Save, with what was saved: New room shows the room it made. */
  onStayAfterSave?: (saved: T) => void;
  /** The form holding the changes, if a form does, whose fields Save checks first. */
  form?: RefObject<HTMLFormElement | null>;
  /** What the dialog says the changes are, a room's form's unless it says otherwise. */
  description?: string;
}

/**
 * While the page holds changes, a room's form's or the room order's, leaving it, by a link, Back or
 * Forward, or signing out, first asks whether to save or discard them, and reloading or closing the tab
 * has the browser ask.
 */
export function UnsavedChanges<T>({ changed, stays, onSave, onStayAfterSave, form, description = ROOM_CHANGES }: Props<T>) {
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // How to go where the person was going, once they decide to.
  const proceed = useRef<(() => unknown) | null>(null);
  // Once Discard or Save lets the page go, nothing asks again, unless it doesn't go after all.
  const released = useRef(false);
  // Save found a field the form won't accept, which the browser points at once the dialog has closed.
  const invalid = useRef(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const mounted = useMounted();

  useEffect(() => {
    if (!changed) return;
    return guardLeaving((path, go) => {
      if (released.current || (path !== null && stays(path))) return false;
      // While Save is under way, leaving waits for it.
      if (saving) return true;
      proceed.current = go;
      setFailed(false);
      // The page's own dialogs, such as its icon pickers, are native ones, which would stay above this
      // one and keep it from being answered. They close first.
      for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) dialog.close();
      setAsking(true);
      return true;
    });
  }, [changed, stays, saving]);

  // Listening only while there's something to lose keeps the page eligible for the browser's
  // back/forward cache.
  useEffect(() => {
    if (!changed) return;
    const unload = (event: BeforeUnloadEvent) => {
      if (!released.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [changed]);

  const keepEditing = () => {
    if (saving) return;
    proceed.current = null;
    setAsking(false);
  };

  /** Goes where the person was going, or, should the page stay after all, does what `stayed` says. */
  const go = async (stayed?: () => void) => {
    const next = proceed.current;
    released.current = true;
    proceed.current = null;
    setAsking(false);
    if ((await next?.()) !== false) return;
    // Nor did it stay if it was left meanwhile, by a link followed while signing out was under way.
    if (!mounted.current) return;
    // Anywhere `stayed` goes, it goes without asking.
    stayed?.();
    // A sign-out that fails leaves the page as it was, so the form is guarded again.
    released.current = false;
  };

  const save = async () => {
    if (form && !form.current?.checkValidity()) {
      invalid.current = true;
      return keepEditing();
    }
    setSaving(true);
    setFailed(false);
    let saved: T;
    try {
      saved = await onSave();
    } catch {
      // Anything but a confirmed save failed, whatever went wrong.
      setFailed(true);
      return;
    } finally {
      setSaving(false);
    }
    await go(onStayAfterSave && (() => onStayAfterSave(saved)));
  };

  return (
    <Dialog open={asking} onOpenChange={(open) => open || keepEditing()}>
      <DialogContent
        showCloseButton={false}
        aria-busy={saving || undefined}
        overlayClassName={DIALOG_BACKDROP}
        // Focused on Save, and staying open when the page behind it is clicked.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          saveButton.current?.focus();
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          if (!invalid.current) return;
          invalid.current = false;
          event.preventDefault();
          form?.current?.reportValidity();
        }}
        className={DIALOG}
      >
        <button
          type="button"
          aria-label="Keep editing"
          disabled={saving}
          onClick={keepEditing}
          className={DIALOG_CLOSE}
        >
          <Xmark className="size-[18px]" />
        </button>
        <div aria-hidden="true" className="mb-5 grid size-[46px] place-items-center rounded-xl border bg-surface">
          <Edit className="size-[22px]" />
        </div>
        <DialogTitle className={DIALOG_TITLE}>Unsaved Changes</DialogTitle>
        <DialogDescription className="leading-[1.65]">{description}</DialogDescription>
        {failed && (
          <p role="alert" className="mt-4 text-sm leading-[1.65] text-negative">
            Your changes couldn’t be saved. Please try again, or keep editing.
          </p>
        )}
        <div className="mt-[26px] flex justify-end gap-2.5">
          <button type="button" disabled={saving} onClick={() => void go()} className={OTHER_ACTION}>
            Discard
          </button>
          <button
            ref={saveButton}
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className={MAIN_ACTION}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
