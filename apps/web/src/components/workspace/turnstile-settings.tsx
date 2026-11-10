import { useState } from "react";
import type { WorkspaceSettings } from "@ember/protocol";
import { Switch } from "@/components/ui/switch";
import { useMounted } from "@/hooks/use-mounted";
import { forgetTurnstileKeys, isSignedOut } from "@/lib/api";
import { BUTTON } from "./email-settings";

// The Turnstile card in Membership, for administrators: whether Cloudflare Turnstile checks that whoever
// signs up, or asks Ember to email them, is a person, with the keys of the widget an administrator gave
// Ember, or the deployment's secrets, which nothing here changes. Its switch says whether it does, as
// the ways to join's switches say whether they let people in (Campfire's `.switch`), which the project's
// owner chose to show plainly that it's on, over a badge or a green edge (2026-10-30). Turning it on
// opens the steps to it (`TurnstileSetup`), as their switches open setup that's missing, as the owner
// asked (2026-10-26), and turning it off takes the keys away. Change keys opens the steps with the keys
// given.

/** What turning Turnstile off asks first, since the limits on each network stand in for its check then. */
export const CONFIRM_STOP_TURNSTILE =
  "Are you sure you want to turn off Turnstile? Ember will forget the widget's keys, and limits on each network will stand in for its check until Turnstile is set up again.";

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** Whom Turnstile's check is for. */
const CHECKED = "whoever signs up, or asks Ember to email them a link to join or a code to reset a password, is a person";

interface Props {
  turnstile: WorkspaceSettings["turnstile"];
  /** Opens Set up Turnstile. */
  onSetUp: () => void;
  /** Shows where Ember's Turnstile keys come from once turning it off has taken the ones given away. */
  onStopped: (turnstile: WorkspaceSettings["turnstile"]) => void;
  /** Says why turning it off failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Whether Turnstile checks people, for administrators, and with whose keys, or else that limits stand in for it. */
export function TurnstileSettings({ turnstile, onSetUp, onStopped, onFailed }: Props) {
  const [stopping, setStopping] = useState(false);
  const mounted = useMounted();
  // The deployment's secrets keep it on, whatever the switch is moved to.
  const secret = turnstile === "secret";

  const stop = () => {
    if (!confirm(CONFIRM_STOP_TURNSTILE)) return;
    setStopping(true);
    forgetTurnstileKeys().then(
      (turnstile) => {
        onStopped(turnstile);
        if (mounted.current) setStopping(false);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setStopping(false);
        onFailed(error);
      },
    );
  };

  return (
    <section aria-labelledby="turnstile-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div className="flex items-center gap-x-[1ch] gap-y-4">
        <div className="min-w-0 flex-1">
          <h2 id="turnstile-heading" className="text-base font-semibold">
            Turnstile
          </h2>
          <p id="turnstile-description" className={NOTE}>
            {turnstile === null
              ? `Cloudflare Turnstile can check that ${CHECKED}. Until it does, limits on each network stand in for its check.`
              : `Cloudflare Turnstile checks that ${CHECKED}${secret ? ", with the widget whose keys are in TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY" : ""}.`}
          </p>
        </div>
        {/* Off while it's turned off, and on, though it can't be moved, while the deployment's secrets keep it on. */}
        <Switch
          checked={turnstile !== null && !stopping}
          onCheckedChange={(on) => (on ? onSetUp() : stop())}
          disabled={secret || stopping}
          className={secret ? "disabled:bg-foreground" : undefined}
          aria-labelledby="turnstile-heading"
          aria-describedby="turnstile-description"
        />
      </div>
      {turnstile === "saved" && (
        <div>
          <button type="button" onClick={onSetUp} disabled={stopping} className={BUTTON}>
            Change keys
          </button>
        </div>
      )}
    </section>
  );
}

/** Set up Turnstile, which the ways to join whose limits stand in for its check have under them until Ember has a widget's keys. */
export function SetUpTurnstile({ onSetUp }: { onSetUp: () => void }) {
  return (
    <div>
      <button type="button" onClick={onSetUp} className={BUTTON}>
        Set up Turnstile
      </button>
    </div>
  );
}
