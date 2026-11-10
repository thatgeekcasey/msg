import { useId, useState, type ComponentType, type MouseEvent } from "react";
import type { Involvement, Room } from "@ember/protocol";
import { AtSign, BellNotificationSolid, BellOff, EyeClosed, type IconoirIconProps } from "@/components/icons/iconoir";
import { useMounted } from "@/hooks/use-mounted";
import { isSignedOut, setInvolvement } from "@/lib/api";
import { INVOLVEMENT_LABELS, nextInvolvement } from "@/lib/involvement";
import type { RoomAnswer } from "@/lib/room-list";
import { cn } from "@/lib/utils";

/** The icon for each level, where Campfire draws a bell for each (notification-bell-*.svg). */
const BELLS: Record<Involvement, ComponentType<IconoirIconProps>> = {
  mentions: AtSign,
  everything: BellNotificationSolid,
  nothing: BellOff,
  invisible: EyeClosed,
};

interface Props {
  room: Room;
  /** Your level in the room, as the sidebar's list says. */
  involvement: Involvement;
  /** Called as a press saves a level, with what gives the room the level the server answers. */
  askForRoom: () => (answer: RoomAnswer) => void;
  /** Says why a save failed, as the workspace's alerts do, and whether the keyboard pressed it. */
  onFailed: (error: unknown, keyboard: boolean) => void;
  /** Called once a press has saved a level, with the level the server answers and whether the keyboard pressed it. */
  onSaved?: (involvement: Involvement, keyboard: boolean) => void;
  /** Whether it takes focus as it shows, as it does from the bell that turned notifications on. */
  autoFocus?: boolean;
  className?: string;
}

/**
 * The notification bell: the icon for your level in a room, as a checkbox that's always checked, named
 * for what the level does, which a press moves on to the next level. It shows what the server answers
 * rather than what was asked, unless another tab saves a newer level before the answer comes. While it
 * saves it's dimmed and ignores presses, as the star does.
 */
export function InvolvementButton({ room, involvement, askForRoom, onFailed, onSaved, autoFocus, className }: Props) {
  const label = useId();
  const [saving, setSaving] = useState(false);
  const mounted = useMounted();
  const Bell = BELLS[involvement];

  const save = async (event: MouseEvent<HTMLButtonElement>) => {
    if (saving) return;
    setSaving(true);
    // A key's press clicks with no count of clicks.
    const keyboard = event.detail === 0;
    const answered = askForRoom();
    try {
      const saved = await setInvolvement(room.id, nextInvolvement(room, involvement));
      answered({ type: "involved", roomId: room.id, involvement: saved });
      if (mounted.current) onSaved?.(saved, keyboard);
    } catch (error) {
      if (mounted.current || isSignedOut(error)) onFailed(error, keyboard);
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked="true"
      aria-labelledby={label}
      aria-disabled={saving || undefined}
      autoFocus={autoFocus}
      onClick={save}
      className={cn("cursor-pointer aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-disabled:grayscale aria-disabled:contrast-50", className)}
    >
      <Bell className="size-[1.3em]" />
      <span id={label} className="sr-only">
        {INVOLVEMENT_LABELS[involvement]}
      </span>
    </button>
  );
}
