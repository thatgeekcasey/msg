import type { TranslationKey } from "@ember/protocol";
import type { ReactNode } from "react";
import { TranslationButton } from "@/components/translation-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Form pieces, which the sign-in and join cards and the settings panels share.

/** Campfire's `.input`, with 16px text, so phones don't zoom in. */
export const FIELD_INPUT =
  "h-auto min-h-[42px] touch:min-h-11 rounded-[9px] border-border bg-background px-[11px] py-[9px] text-base md:text-base shadow-none focus:border-muted-foreground focus-visible:border-muted-foreground focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-solid focus-visible:outline-foreground";

/**
 * A field: a 13px label over its input, and beside the label the translation button for what the field
 * asks, if it has one.
 */
export function Field({ id, label, translation, children }: { id: string; label: string; translation?: TranslationKey; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-[7px] text-start">
      <div className="flex items-center gap-2 text-[13px] font-[550]">
        <label htmlFor={id}>{label}</label>
        {translation && <TranslationButton translations={translation} />}
      </div>
      {children}
    </div>
  );
}

/** The primary button, as a `Button`'s classes: a full-width button in ink. */
export const PRIMARY_BUTTON = "h-auto min-h-[42px] w-full rounded-[9px] border border-primary px-4 py-2.5 text-sm font-[550] touch:min-h-11";

/** The primary button, which sends its form. */
export function SubmitButton({ disabled, className, children }: { disabled: boolean; className?: string; children: ReactNode }) {
  return (
    <Button type="submit" disabled={disabled} className={cn(PRIMARY_BUTTON, className)}>
      {children}
    </Button>
  );
}
