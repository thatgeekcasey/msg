import type { ImgHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import externalSliders from "./campfire/external/sliders.svg";

// The one Campfire icon Ember still draws, as the project's owner chose: the setup help's picture of Chrome's
// View site information button, which shows what Chrome itself draws there. It's copied byte for byte from
// once-campfire's app/assets/images/external/ and drawn as Campfire draws it, a black <img> inverted where
// the background is dark.

/** An icon is hidden from screen readers unless it has an `aria-label`, its `alt` text, as Iconoir's are. */
export type CampfireIconProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt">;

function CampfireIcon({ src, "aria-label": label, className, ...props }: CampfireIconProps & { src: string }) {
  return (
    <img
      src={src}
      alt={label ?? ""}
      aria-hidden={label === undefined || undefined}
      draggable={false}
      className={cn("select-none dark:invert", className)}
      {...props}
    />
  );
}

export function ExternalSliders(props: CampfireIconProps) {
  return <CampfireIcon src={externalSliders} {...props} />;
}
