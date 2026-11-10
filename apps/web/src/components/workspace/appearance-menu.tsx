import { useRef, useState } from "react";
import { CheckCircle } from "@/components/icons/iconoir";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { chooseAppearance, useAppearance } from "@/lib/appearance";
import { NavigationIcon } from "./navigation-icon";

const OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

/**
 * The rail's appearance button: it's named for the choice shown and opens a small dialog of Light, Dark
 * and System radio buttons. A choice applies at once and leaves the dialog open, which Escape or a click
 * elsewhere closes. Its icons are those an administrator chose in Community settings, or, like the
 * rail's, Iconoir's.
 */
export function AppearanceMenu() {
  const appearance = useAppearance();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const choices = useRef<HTMLFieldSetElement>(null);
  const { label } = OPTIONS.find((option) => option.value === appearance)!;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={button}
        className="mt-auto flex size-9 shrink-0 items-center justify-center rounded-full border text-muted-foreground hover:bg-hover hover:text-foreground data-[state=open]:bg-hover data-[state=open]:text-foreground touch:size-11"
        aria-label={`Appearance: ${label}`}
        title={`Appearance: ${label}`}
      >
        <NavigationIcon slot={appearance} size={18} className="size-[18px]" />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Appearance"
        side="right"
        align="end"
        sideOffset={8}
        className="w-[190px] rounded-[12px] bg-background p-2 shadow-[0_8px_24px_#0002]"
        // Opening focuses the current choice, and Tab closes the dialog and goes on from its button.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          choices.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          button.current?.focus();
          setOpen(false);
        }}
      >
        <fieldset ref={choices}>
          <legend className="px-2 pt-1 pb-2 text-xs font-semibold text-muted-foreground">Appearance</legend>
          {OPTIONS.map(({ value, label }) => (
            <label
              key={value}
              className="relative flex min-h-10 cursor-pointer items-center gap-2.5 rounded-[7px] p-2 hover:bg-hover has-checked:bg-hover has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-foreground touch:min-h-11"
            >
              <input
                type="radio"
                name="appearance"
                value={value}
                checked={appearance === value}
                onChange={() => chooseAppearance(value)}
                className="peer absolute size-px opacity-0 [clip-path:inset(50%)]"
              />
              <NavigationIcon slot={value} size={18} className="size-[18px] shrink-0" />
              <span>{label}</span>
              <CheckCircle className="invisible ml-auto size-[18px] shrink-0 peer-checked:visible" />
            </label>
          ))}
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}
