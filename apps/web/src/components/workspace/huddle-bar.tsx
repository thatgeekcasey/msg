import type { Room, UserId } from "@ember/protocol";
import { Headset, Microphone, MicrophoneMute } from "@/components/icons/iconoir";
import { PageLink } from "@/components/page-link";
import { useNameOf } from "@/hooks/use-directory";
import { roomPath } from "@/hooks/use-route";
import { roomName } from "@/lib/directs";
import { inTheHuddle } from "@/lib/huddle-people";
import { leaveHuddle, muteHuddle, type JoinedHuddle } from "@/lib/huddle-store";
import { muteShortcut } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import { ShortcutTooltip } from "./shortcut-tooltip";
import { UserAvatar } from "./user-avatar";

/** How many of the huddle's faces the bar shows. */
const MAX_FACES = 4;

/** A huddle button: a 40px square, 44px for fingers, filled in ink while what it switches is on. */
const TOOL = "grid h-10 min-w-10 cursor-pointer place-items-center rounded-lg touch:h-11 touch:min-w-11 disabled:cursor-default disabled:opacity-50 [&_svg]:size-5";
const TOOL_OFF = "bg-hover text-foreground enabled:hover:bg-foreground/12";
const TOOL_ON = "bg-foreground text-background";

interface Props {
  huddle: JoinedHuddle;
  /** Its room, or null once the room isn't among this person's. */
  room: Room | null;
  meId: UserId;
}

/**
 * The huddle this tab is in, as a bar the whole width of the window, along its base, whatever page shows
 * above it, as Slack's is: the huddle's name and who's in it, which go to its room, their faces, the
 * microphone, and Leave, in red and in words, last.
 */
export function HuddleBar({ huddle, room, meId }: Props) {
  const nameOf = useNameOf();
  const name = room ? `Huddle in ${roomName(room, meId, nameOf)}` : "Huddle";
  const names = huddle.people.map(({ user }) => nameOf(user));
  const others = huddle.people.filter(({ user }) => user.id !== huddle.you?.id).map(({ user }) => nameOf(user));
  // The room hasn't let the tab in yet, or its connection to the room is down.
  const state = huddle.connected ? inTheHuddle(others) : huddle.you ? "Reconnecting…" : "Connecting…";
  const silent = huddle.muted || !huddle.microphone;
  const microphone = !huddle.microphone ? "No microphone" : huddle.muted ? "Unmute microphone" : "Mute microphone";
  return (
    <section
      aria-label={name}
      className="col-span-full row-start-4 flex min-h-[60px] items-center gap-3 border-t bg-background pt-2 pr-[max(16px,env(safe-area-inset-right))] pb-[max(8px,env(safe-area-inset-bottom))] pl-[max(16px,env(safe-area-inset-left))] max-md:gap-2 max-md:pr-[max(10px,env(safe-area-inset-right))] max-md:pl-[max(10px,env(safe-area-inset-left))]"
    >
      <PageLink href={roomPath(huddle.roomId)} title="Go to the huddle's room" className="flex min-w-0 items-center gap-2.5 rounded-lg py-1 pr-3 pl-1 hover:bg-hover">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-positive text-white">
          <Headset className="size-5" />
        </span>
        <span className="min-w-0">
          {/* The space parts the two lines for screen readers, which hear the link as one. */}
          <span className="block truncate text-[15px] leading-5 font-semibold">{name}</span>{" "}
          <span aria-live="polite" className="block truncate text-xs leading-4 text-muted-foreground">
            {state}
          </span>
        </span>
      </PageLink>
      <span aria-hidden title={names.join(", ")} className="flex shrink-0 -space-x-1.5 max-md:hidden">
        {huddle.people.slice(0, MAX_FACES).map(({ user }) => (
          <UserAvatar key={user.id} user={user} className="size-7 rounded-full ring-2 ring-background" />
        ))}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <ShortcutTooltip label={microphone} shortcut={muteShortcut()}>
          <button type="button" aria-label={microphone} disabled={!huddle.microphone} onClick={() => muteHuddle(!huddle.muted)} className={cn(TOOL, silent ? TOOL_OFF : TOOL_ON)}>
            {silent ? <MicrophoneMute /> : <Microphone />}
          </button>
        </ShortcutTooltip>
        <button
          type="button"
          onClick={leaveHuddle}
          className="inline-flex h-10 shrink-0 cursor-pointer items-center rounded-lg bg-negative-button px-4 text-[15px] font-semibold text-white hover:brightness-90 touch:h-11"
        >
          Leave
        </button>
      </div>
    </section>
  );
}
