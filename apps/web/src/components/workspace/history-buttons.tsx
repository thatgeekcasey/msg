import { ArrowLeft, ArrowRight } from "@/components/icons/iconoir";
import { useCanGoBack, useCanGoForward } from "@/hooks/use-route";
import { backShortcut, forwardShortcut } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { ShortcutTooltip } from "./shortcut-tooltip";

/**
 * One of the top bar's buttons for going back through pages: a 32px square in muted ink, 44px for
 * fingers, which a pointer highlights, as its menu does while open, faint while it has nowhere to go.
 */
export const HISTORY_BUTTON =
  "grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-hover data-[state=open]:text-foreground touch:size-11";

/**
 * Back and Forward, as Slack's top bar has them, each with the keys the browser takes for it in its
 * tooltip. They step through the pages the app has shown in this tab, as the browser's own buttons do,
 * but never out of Ember: Back is faint on the first page it showed, and Forward until Back is pressed.
 */
export function HistoryButtons({ className }: { className?: string }) {
  const back = useCanGoBack();
  const forward = useCanGoForward();
  return (
    <div className={cn("flex shrink-0 gap-1", className)}>
      <ShortcutTooltip label="Back" shortcut={backShortcut()}>
        <button type="button" aria-label="Back" disabled={!back} onClick={() => history.back()} className={HISTORY_BUTTON}>
          <ArrowLeft className="size-5" />
        </button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Forward" shortcut={forwardShortcut()}>
        <button type="button" aria-label="Forward" disabled={!forward} onClick={() => history.forward()} className={HISTORY_BUTTON}>
          <ArrowRight className="size-5" />
        </button>
      </ShortcutTooltip>
    </div>
  );
}
