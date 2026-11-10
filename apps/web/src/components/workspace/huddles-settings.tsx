import { useState } from "react";
import type { WorkspaceSettings } from "@ember/protocol";
import { Switch } from "@/components/ui/switch";
import { useMounted } from "@/hooks/use-mounted";
import { forgetHuddles, isSignedOut } from "@/lib/api";
import { BUTTON } from "./email-settings";

// The Huddles card in Rooms and permissions, for administrators: whether Ember has what huddles run
// through, which is Cloudflare's Realtime SFU, by an SFU app in the Cloudflare account of whoever runs
// Ember, whose keys an administrator gives it. Its switch says whether it has, as Turnstile's does.
// Turning it on opens Set up huddles (`HuddlesSetup`), as switches open setup that's missing, as the
// project's owner asked (2026-10-26), and turning it off forgets the app's keys, which ends any huddle
// going on once its room next checks, within half a minute. Change keys opens the setup with the app's
// ID as it is.

/** What the card says of huddles while they're off. */
export const HUDDLES_EXPLAINED =
  "Huddles let people in a room talk to each other. They run through Cloudflare's Realtime SFU, with an app in your Cloudflare account.";

/** What turning huddles off asks first. */
export const CONFIRM_STOP_HUDDLES = "Are you sure you want to turn off huddles? Any huddle going on will end, and Ember will forget the SFU app's keys.";

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

interface Props {
  huddles: WorkspaceSettings["huddles"];
  /** Opens Set up huddles. */
  onSetUp: () => void;
  /** Shows that huddles are off, once turning them off has forgotten the app's keys. */
  onStopped: () => void;
  /** Says why turning them off failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Whether huddles are on, for administrators, and through which SFU app they run, or else what huddles would add. */
export function HuddlesSettings({ huddles, onSetUp, onStopped, onFailed }: Props) {
  const [stopping, setStopping] = useState(false);
  const mounted = useMounted();

  const stop = () => {
    if (!confirm(CONFIRM_STOP_HUDDLES)) return;
    setStopping(true);
    forgetHuddles().then(
      () => {
        onStopped();
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
    <section aria-labelledby="huddles-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div className="flex items-center gap-x-[1ch] gap-y-4">
        <div className="min-w-0 flex-1">
          <h3 id="huddles-heading" className="text-base font-semibold">
            Huddles
          </h3>
          <p id="huddles-description" className={NOTE}>
            {huddles === null ? (
              HUDDLES_EXPLAINED
            ) : (
              <>
                Huddles run through the Realtime SFU app <strong className="font-semibold wrap-anywhere">{huddles.appId}</strong> in your Cloudflare account.
              </>
            )}
          </p>
        </div>
        <Switch
          checked={huddles !== null && !stopping}
          onCheckedChange={(on) => (on ? onSetUp() : stop())}
          disabled={stopping}
          aria-labelledby="huddles-heading"
          aria-describedby="huddles-description"
        />
      </div>
      {huddles !== null && (
        <div>
          <button type="button" onClick={onSetUp} disabled={stopping} className={BUTTON}>
            Change keys
          </button>
        </div>
      )}
    </section>
  );
}
