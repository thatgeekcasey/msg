import { useEffect, useState, type ReactNode } from "react";
import type { SavedPushSubscription } from "@ember/protocol";
import { BellNotificationSolid, Minus } from "@/components/icons/iconoir";
import { useMounted } from "@/hooks/use-mounted";
import { useTitle } from "@/hooks/use-title";
import { deletePushSubscription, fetchPushSubscriptions, isSignedOut, sendTestNotification } from "@/lib/api";
import { endPushSubscriptionAt, savedAgain } from "@/lib/push";
import { cn } from "@/lib/utils";
import { Panel, SettingsPage } from "./settings-page";

interface Props {
  /** Where Go Back goes: the last room visited. */
  back: string;
  /** Says why loading the list, a test notification or a deletion failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * The push subscriptions page, which nothing links to: each browser that turned notifications on for
 * you, oldest first, with Send test notification, which pushes "Ember Test" to it at once, and Delete
 * subscription.
 */
export function PushSubscriptionsPage({ back, onFailed }: Props) {
  const [subscriptions, setSubscriptions] = useState<SavedPushSubscription[] | null>(null);
  useTitle("Push notification subscriptions");

  useEffect(() => {
    let stopped = false;
    fetchPushSubscriptions().then(
      (subscriptions) => !stopped && setSubscriptions(subscriptions),
      (error: unknown) => {
        if (stopped && !isSignedOut(error)) return;
        onFailed(error);
      },
    );
    return () => void (stopped = true);
  }, [onFailed]);

  const forget = (id: number) => setSubscriptions((subscriptions) => subscriptions && subscriptions.filter((subscription) => subscription.id !== id));

  return (
    <SettingsPage back={back}>
      {/* `.panel--wide`: 900px. */}
      <Panel aria-busy={subscriptions === null} className="flex w-[900px] flex-col gap-x-[1ch] gap-y-4">
        <h1 id="push-subscriptions-heading" className="text-center text-[23px] font-bold">
          Push Notification Subscriptions
        </h1>
        <div className="rounded-[10px] border bg-surface px-[1ch]">
          <menu aria-labelledby="push-subscriptions-heading" className="m-0 flex flex-col gap-x-[1ch] gap-y-4 px-[1ch] py-4">
            {subscriptions?.map((subscription) => (
              <SubscriptionRow key={subscription.id} subscription={subscription} onDeleted={() => forget(subscription.id)} onFailed={onFailed} />
            ))}
          </menu>
        </div>
      </Panel>
    </SettingsPage>
  );
}

interface RowProps {
  subscription: SavedPushSubscription;
  onDeleted: () => void;
  onFailed: (error: unknown) => void;
}

/**
 * A subscription: the browser in bold, cut short with an ellipsis, then its endpoint in small text
 * beside its buttons. The endpoint breaks anywhere, so it doesn't run out of the panel on a phone.
 * Deleting this browser's own subscription ends it here too, so the bell can turn notifications on
 * again.
 */
function SubscriptionRow({ subscription: { id, browser, version, platform, endpoint }, onDeleted, onFailed }: RowProps) {
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mounted = useMounted();

  // After the save of this browser's subscription as the workspace opened, which would otherwise bring it back.
  const remove = (id: number) =>
    savedAgain()
      .then(() => deletePushSubscription(id))
      .then(() => endPushSubscriptionAt(endpoint));

  // Each button is its own form there, which Turbo disables until its answer comes.
  const send = (request: (id: number) => Promise<void>, setSending: (sending: boolean) => void, sent?: () => void) => {
    setSending(true);
    request(id)
      .then(
        () => {
          if (mounted.current) sent?.();
        },
        (error: unknown) => {
          if (mounted.current || isSignedOut(error)) onFailed(error);
        },
      )
      .finally(() => mounted.current && setSending(false));
  };

  return (
    <li className="flex flex-col">
      <span className="truncate">
        <strong>
          {browser} {version} on {platform}
        </strong>
      </span>
      <span className="flex items-start gap-x-[1ch] gap-y-4 text-[0.8rem]">
        <span className="min-w-0 wrap-anywhere">{endpoint}</span>
        <span className="flex items-center gap-x-[1ch] gap-y-4">
          <RoundButton label="Send test notification" disabled={testing} onClick={() => send(sendTestNotification, setTesting)} className="bg-primary text-primary-foreground">
            <BellNotificationSolid className="size-[1.3em]" />
          </RoundButton>
          <RoundButton label="Delete subscription" disabled={deleting} onClick={() => send(remove, setDeleting, onDeleted)} className="bg-negative-button text-white">
            <Minus className="size-[1.3em]" />
          </RoundButton>
        </span>
      </span>
    </li>
  );
}

/**
 * Campfire's round `.btn` around an icon, in a panel: 36px, or 44px for fingers. `.btn--reversed` and
 * `.btn--negative` darken under a mouse (buttons.css).
 */
function RoundButton({ label, disabled, onClick, className, children }: { label: string; disabled: boolean; onClick: () => void; className: string; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border border-transparent touch:size-11 hover:not-active:brightness-70 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}
