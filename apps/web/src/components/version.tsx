import { cn } from "@/lib/utils";

/**
 * "Ember version" and this deployment's version in Campfire's `.version-badge` (base.css), shown under
 * the sign-in and join cards.
 */
export function Version({ version, className }: { version: string; className?: string }) {
  return (
    <div className={cn("text-muted-foreground", className)}>
      Ember version <span className="rounded-[0.3em] border border-muted-foreground px-[0.5ch] py-[0.1em]">{version}</span>
    </div>
  );
}
