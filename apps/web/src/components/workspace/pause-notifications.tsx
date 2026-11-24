import type { DirectoryUser, UserId } from "@ember/protocol";
import { PAUSE_CHOICES, pauseEnd } from "@/lib/notifications-pause";
import { BUTTON } from "./email-settings";
import { usePauseOf } from "./pause-menu";

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

interface Props {
  meId: UserId;
  /** Called as a pause, or resuming, is saved, with what lists you in the people directory as the server answers. */
  askForPause: () => (me: DirectoryUser) => void;
  onFailed: (error: unknown) => void;
}

/**
 * Pause notifications on your profile, as the rail's menu has it: how long to pause them for, and while
 * they're paused, until when, with Resume notifications.
 */
export function PauseNotifications(props: Props) {
  const { until, pause } = usePauseOf(props);
  return (
    <section aria-labelledby="pause-notifications-heading" className="flex flex-col gap-4 rounded-[10px] border bg-surface px-[2ch] py-4 max-md:px-3">
      <div>
        <h2 id="pause-notifications-heading" className="text-base font-semibold">
          Pause notifications
        </h2>
        <p className={NOTE}>
          {until
            ? `Paused until ${until}. Nothing is pushed to you and huddle invitations don't ring until then.`
            : "Stop pushes and huddle rings for a while, everywhere you're signed in. Others see a half-moon on your picture until it ends."}
        </p>
      </div>
      <div role="group" aria-labelledby="pause-notifications-heading" className="flex flex-wrap gap-2">
        {until && (
          <button type="button" onClick={() => void pause(null)} className={BUTTON}>
            Resume notifications
          </button>
        )}
        {PAUSE_CHOICES.map((choice) => (
          <button key={choice.label} type="button" onClick={() => void pause(pauseEnd(choice))} className={BUTTON}>
            {choice.label}
          </button>
        ))}
      </div>
    </section>
  );
}
