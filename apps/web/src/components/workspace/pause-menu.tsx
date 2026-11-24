import type { DirectoryUser, UserId } from "@ember/protocol";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { usePausedUntil } from "@/hooks/use-directory";
import { pauseNotifications } from "@/lib/api";
import { PAUSE_CHOICES, pauseEnd, pauseEndLabel } from "@/lib/notifications-pause";
import { NavigationIcon } from "./navigation-icon";

interface Props {
  meId: UserId;
  /** Called as a pause, or resuming, is saved, with what lists you in the people directory as the server answers. */
  askForPause: () => (me: DirectoryUser) => void;
  onFailed: (error: unknown) => void;
}

/**
 * When your pause of your notifications ends, as "tomorrow at 9:00 AM", or null while they aren't paused,
 * and what pauses them until a time, or resumes them with null, wherever you're signed in.
 */
export function usePauseOf({ meId, askForPause, onFailed }: Props) {
  const pausedUntil = usePausedUntil(meId);
  const until = pausedUntil && pauseEndLabel(new Date(pausedUntil));
  const pause = async (end: Date | null) => {
    const paused = askForPause();
    try {
      paused(await pauseNotifications(end?.toISOString() ?? null));
    } catch (error) {
      onFailed(error);
    }
  };
  return { until, pause };
}

/**
 * The rail's Pause notifications, as Slack's: a menu of how long to pause them for, 30 minutes, 1 hour,
 * 2 hours or until tomorrow, and while they're paused, until when, with Resume notifications. A pause
 * holds wherever you're signed in: nothing is pushed to you and no invitation into a huddle rings until
 * it ends, and a half-moon on your picture says so to everyone. Its icon is the one an administrator
 * chose in Community settings, or Iconoir's bell with a line through it, which the project's owner chose.
 */
export function PauseMenu(props: Props) {
  const { until, pause } = usePauseOf(props);
  const label = until ? `Notifications paused until ${until}` : "Pause notifications";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        title={label}
        data-paused={until ? "" : undefined}
        className="mt-auto flex size-9 shrink-0 items-center justify-center rounded-full border text-muted-foreground hover:bg-hover hover:text-foreground data-paused:bg-hover data-paused:text-foreground data-[state=open]:bg-hover data-[state=open]:text-foreground touch:size-11"
      >
        <NavigationIcon slot="pause" size={18} className="size-[18px]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" sideOffset={8} className="min-w-[200px]">
        <DropdownMenuLabel className="text-xs font-semibold text-muted-foreground">{until ? `Paused until ${until}` : "Pause notifications"}</DropdownMenuLabel>
        {until && (
          <>
            <DropdownMenuItem onSelect={() => void pause(null)}>Resume notifications</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {PAUSE_CHOICES.map((choice) => (
          <DropdownMenuItem key={choice.label} onSelect={() => void pause(pauseEnd(choice))}>
            {choice.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
