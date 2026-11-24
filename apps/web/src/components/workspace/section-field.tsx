import { useId, useRef } from "react";
import { MAX_SECTION_NAME_LENGTH, type SectionChoice, type SectionOption } from "@ember/protocol";
import { FIELD_INPUT } from "@/components/field";
import { NavArrowDown, Plus } from "@/components/icons/iconoir";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { roomCount } from "@/lib/room-list";
import { cn } from "@/lib/utils";

/** The menu's value for no section, which no section's id can be. */
const NONE = "";

export interface SectionFieldProps {
  /** Every section, in order, with how many of this person's rooms are in each. */
  sections: SectionOption[];
  /** The section chosen: a section's id, null for none, or the name of one to make. */
  value: SectionChoice;
  onChange: (value: SectionChoice) => void;
  /** Whether New section is offered, which only an administrator can make. */
  canMake: boolean;
  disabled: boolean;
}

/**
 * Sidebar section, under the room's icon on its settings and on New room: a menu of No section and
 * every section, with how many of this person's rooms are in it, and for an administrator, New section,
 * which asks for the name of one to make as the room is saved.
 */
export function SectionField({ sections, value, onChange, canMake, disabled }: SectionFieldProps) {
  const labelId = useId();
  const noteId = useId();
  // New section puts the cursor in the name it asks for, rather than back on the menu's button.
  const naming = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const making = value !== null && typeof value === "object";
  const chosen = typeof value === "string" ? sections.find((section) => section.id === value) : undefined;
  return (
    <div className="mt-[22px] flex min-w-0 flex-col gap-[7px] text-start">
      <span id={labelId} className="text-[13px] font-[550]">
        Sidebar section
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-labelledby={labelId}
            aria-describedby={noteId}
            className={cn(FIELD_INPUT, "flex w-full cursor-pointer items-center gap-2.5 border text-start disabled:cursor-default data-[state=open]:border-muted-foreground")}
          >
            <span className={cn("min-w-0 flex-1 truncate", !making && !chosen && "text-muted-foreground")}>{making ? "New section" : (chosen?.name ?? "No section")}</span>
            <NavArrowDown className="size-[18px] shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width) p-1.5"
          onCloseAutoFocus={(event) => {
            if (!naming.current) return;
            naming.current = false;
            event.preventDefault();
            nameInput.current?.focus();
          }}
        >
          <DropdownMenuRadioGroup value={making ? undefined : (chosen?.id ?? NONE)} onValueChange={(id) => onChange(id === NONE ? null : id)}>
            <DropdownMenuRadioItem value={NONE} className="min-h-9 text-sm touch:min-h-11">
              No section
            </DropdownMenuRadioItem>
            {sections.map((section) => (
              <DropdownMenuRadioItem key={section.id} value={section.id} className="min-h-9 gap-3 text-sm touch:min-h-11">
                <span className="min-w-0 truncate">{section.name}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{roomCount(section.rooms)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {canMake && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  naming.current = true;
                  if (!making) onChange({ name: "" });
                }}
                className="min-h-9 gap-2 text-sm touch:min-h-11"
              >
                <Plus className="size-4" />
                New section…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {making && (
        <Input
          ref={nameInput}
          required
          disabled={disabled}
          maxLength={MAX_SECTION_NAME_LENGTH}
          aria-label="New section’s name"
          placeholder="Such as Software engineering"
          value={value.name}
          onChange={(event) => onChange({ name: event.target.value })}
          className={FIELD_INPUT}
        />
      )}
      <p id={noteId} className="mt-1 text-xs text-muted-foreground">
        Everyone’s sidebar lists this room under the section’s name.
      </p>
    </div>
  );
}
