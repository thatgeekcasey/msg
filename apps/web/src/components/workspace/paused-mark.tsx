import { HalfMoon } from "@/components/icons/iconoir";
import type { Presence } from "@/hooks/use-directory";
import { cn } from "@/lib/utils";

/**
 * The half-moon at the corner of the picture of someone who has paused their notifications, the mark the
 * project's owner chose for Slack's sleeping "z": on a circle in the color around it, its moon green while
 * they're active and muted while they're away, as their presence dot would be, or in ink where their
 * presence isn't shown. `className` places and sizes it, and edges it in the color around it.
 */
export function PausedMark({ presence = null, className }: { presence?: Presence | null; className?: string }) {
  return (
    <span aria-hidden="true" data-paused="" className={cn("absolute grid place-items-center rounded-full border bg-surface", className)}>
      <HalfMoon className={cn("size-[75%]", presence === "active" ? "text-positive" : presence === "away" ? "text-muted-foreground" : "text-foreground")} />
    </span>
  );
}
