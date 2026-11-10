import type { RoomIconName } from "@ember/protocol";
import { cn } from "@/lib/utils";

// A room's icon, from the picker's catalog of Lucide and Iconoir icons in picker/. vite.config.ts serves
// each one as an SVG of its own, so a page fetches only the icons its rooms have.

/** Where icon `name` is served: a Lucide icon at /lucide/icons/<name>.svg, Iconoir's at /iconoir/icons/<variant>/<name>.svg. */
export const roomIconUrl = (name: RoomIconName) =>
  name.startsWith("iconoir:") ? `/iconoir/icons/${name.split(":").slice(1).join("/")}.svg` : `/lucide/icons/${name}.svg`;

interface Props {
  icon: RoomIconName | null;
  /** The icon's width and height in pixels. `#` takes the font size `className` gives. */
  size: number;
  className?: string;
}

/**
 * The room's icon in the color of the text around it, which an SVG drawn as a mask over that color
 * takes, or `#` for a room without one.
 */
export function RoomIcon({ icon, size, className }: Props) {
  return (
    <span aria-hidden="true" className={cn(icon && "inline-flex items-center justify-center", className)}>
      {icon ? (
        <span
          data-icon={icon}
          className="block shrink-0 bg-current mask-contain mask-center mask-no-repeat"
          style={{ width: size, height: size, maskImage: `url(${roomIconUrl(icon)})` }}
        />
      ) : (
        "#"
      )}
    </span>
  );
}
