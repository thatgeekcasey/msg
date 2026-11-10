import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

// shadcn/ui's switch, restyled as Campfire's `.switch` (app/assets/stylesheets/inputs.css), drawn at
// 14px: a 3em by 1.75em track, ink when on and muted when off, with a 1.35em knob in the canvas color,
// dimmed while the pointer is over it.

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-[1.75em] w-[3em] shrink-0 cursor-pointer rounded-[2em] bg-muted-foreground text-[14px] transition duration-150 ease-in-out data-[state=checked]:bg-foreground disabled:cursor-not-allowed disabled:bg-muted-foreground [@media(any-hover:hover)]:[&:not(:active):hover]:brightness-[0.7]",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none absolute bottom-[0.2em] left-[0.2em] block size-[1.35em] rounded-full bg-background transition duration-150 ease-in-out data-[state=checked]:translate-x-[1.2em]"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
