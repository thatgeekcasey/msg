import type { RoomIconName } from "@ember/protocol";
import { ROOM_LABELS } from "./room-labels";

// What the icon pickers call an icon, without the picker's catalog, which only the open picker loads.

/** What the picker offers an icon for: a room's purpose, or one of the rail's buttons. */
export type IconContext = "room" | "navigation";

/** Whether `name` is one of Iconoir's icons, which the catalog names `iconoir:<variant>:<name>`. */
export const isIconoir = (name: RoomIconName) => name.startsWith("iconoir:");

/** The catalog's label for an icon: its name's words capitalized, such as "Gamepad 2", or "Heart (Solid)" for Iconoir's solid heart. */
export function pickerIconLabel(name: RoomIconName): string {
  const [variant, base] = isIconoir(name) ? name.split(":").slice(1) : ["regular", name];
  const words = base!
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return variant === "solid" ? `${words} (Solid)` : words;
}

/** What the picker shows under an icon: for a room, the purpose it's suggested for where it is one, such as "Engineering" for code-xml. */
export function displayIconLabel(name: RoomIconName, context: IconContext): string {
  return (context === "room" && ROOM_LABELS[name]) || pickerIconLabel(name);
}

/** The icon's label with Iconoir's credited, as `channel_icon_label` and the picker's footer name an icon. */
export function iconLabel(name: RoomIconName, context: IconContext): string {
  const label = displayIconLabel(name, context);
  return isIconoir(name) ? `${label} · Iconoir` : label;
}

/** What a room's icon is called, as `channel_icon_label` calls it, or "Default hashtag" for `#`. */
export function roomIconLabel(name: RoomIconName | null): string {
  return name ? iconLabel(name, "room") : "Default hashtag";
}
