import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { CheckCircle, WarningTriangle } from "@/components/icons/iconoir";
import { takeFlashFromLastPage, type FlashMessage } from "@/lib/flash";
import { cn } from "@/lib/utils";

/** Flashes a message over the page, in place of any still showing. */
export type Flasher = (kind: FlashMessage["kind"], text: string) => void;

const FlashContext = createContext<Flasher | null>(null);

/**
 * Flashes messages over every page, signed in or not: one at a time, so a new one, or the same one
 * again, takes the place of any still showing and fades in afresh. Over the workspace, they're centered
 * on the page beside the rail and sidebar, where those show.
 */
export function FlashProvider({ workspace = false, children }: { workspace?: boolean; children: ReactNode }) {
  // Keyed, so the same message twice fades in again.
  const [shown, setShown] = useState<(FlashMessage & { key: number }) | null>(null);
  const flash = useCallback<Flasher>((kind, text) => setShown((current) => ({ kind, text, key: (current?.key ?? 0) + 1 })), []);

  // What the page before a full page load left to flash.
  useEffect(() => {
    const message = takeFlashFromLastPage();
    if (message) flash(message.kind, message.text);
  }, [flash]);

  return (
    <FlashContext value={flash}>
      {children}
      {shown && (
        <Flash
          key={shown.key}
          message={shown}
          workspace={workspace}
          // Unless another has taken its place meanwhile.
          onDone={() => setShown((current) => (current?.key === shown.key ? null : current))}
        />
      )}
    </FlashContext>
  );
}

/** Flashes messages over the page, from inside a `FlashProvider`. */
export function useFlash(): Flasher {
  const flash = useContext(FlashContext);
  if (!flash) throw new Error("useFlash needs a FlashProvider around it");
  return flash;
}

/**
 * The flash: a notice in white on green with a check, or an alert on red with a warning sign, 12px
 * below the header. A notice of just "✓" shows only the check, read as "Changes saved". It fades in after
 * 0.3s and out again by 3.3s (Campfire's flash.css), and then goes. It:
 * - shows at once under reduced motion, without fading, until the fade would have ended, where
 *   Campfire's reset cuts the animation to nothing, so its flash never shows;
 * - grows to fit its text, up to the screen's width less 24px, where Campfire's stops at half the
 *   screen's width, as its flash.css centers it from the middle, and so wraps early on a phone;
 * - keeps 12px below the header, and centered on the page, where they make room for a notch.
 */
function Flash({ message: { kind, text }, workspace, onDone }: { message: FlashMessage; workspace: boolean; onDone: () => void }) {
  const Sign = kind === "alert" ? WarningTriangle : CheckCircle;
  return (
    <div
      onAnimationEnd={onDone}
      // z-30: over the page, under menus and dialogs, and under the drawer on a phone, which is a modal
      // dialog here.
      className={cn(
        "pointer-events-none fixed top-[calc(var(--spacing-header)+12px)] left-1/2 max-md:top-[calc(56px+env(safe-area-inset-top)+12px)] z-30 flex w-max max-w-[calc(100dvw-24px)] -translate-x-1/2 justify-center",
        workspace &&
          "md:left-[calc((100%+env(safe-area-inset-left)+var(--spacing-rail)+var(--spacing-sidebar))/2)] md:max-w-[calc(100dvw-env(safe-area-inset-left)-var(--spacing-rail)-var(--spacing-sidebar)-24px)]",
      )}
    >
      <div
        role="alert"
        aria-atomic="true"
        className={cn(
          "flex min-h-12 min-w-12 animate-flash items-center justify-center gap-2.5 rounded-[10px] p-3 text-center text-white shadow-[0_8px_24px_#00000012] motion-reduce:animate-flash-still",
          kind === "alert" ? "bg-negative" : "bg-positive",
        )}
      >
        <Sign className="size-6 flex-none" />
        {text === "✓" ? <span className="sr-only">Changes saved</span> : <span>{text}</span>}
      </div>
    </div>
  );
}
