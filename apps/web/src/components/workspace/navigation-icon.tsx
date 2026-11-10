import type { ComponentType } from "react";
import type { NavigationSlot, RoomIconName } from "@ember/protocol";
import { Bell, Box, Computer, HalfMoon, Home, MultiBubble, Search, SunLight } from "@/components/icons/iconoir";
import { RoomIcon } from "@/components/icons/room-icon";
import { useAccount } from "@/hooks/use-account";

/** Each slot's own icon, drawn in the page, as `DEFAULT_NAVIGATION_ICONS` names them in the catalog. */
const OWN_ICONS: Record<NavigationSlot, ComponentType<{ className?: string }>> = {
  home: Home,
  dms: MultiBubble,
  activity: Bell,
  search: Search,
  admin: Box,
  light: SunLight,
  dark: HalfMoon,
  system: Computer,
};

interface Props {
  slot: NavigationSlot;
  /** The icon's width and height in pixels. */
  size: number;
  className?: string;
}

/** `icon` as one of the rail's buttons or an appearance mode draws it, or `slot`'s own for null. */
export function SlotIcon({ slot, icon, size, className }: Props & { icon: RoomIconName | null }) {
  const Own = OWN_ICONS[slot];
  return icon ? <RoomIcon icon={icon} size={size} className={className} /> : <Own className={className} />;
}

/**
 * The icon an administrator chose in Community settings for one of the rail's buttons or an appearance
 * mode, or the slot's own.
 */
export function NavigationIcon(props: Props) {
  return <SlotIcon icon={useAccount().navigationIcons[props.slot] ?? null} {...props} />;
}
