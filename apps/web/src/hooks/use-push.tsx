import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Platform } from "@ember/protocol";
import { movedFrom } from "@/lib/custom-domain";
import { isPushOn, savePushAgain, subscribeToPushEnding, turnOnPush, type PushNotice } from "@/lib/push";
import { useAccount } from "./use-account";

export interface Push {
  /** Whether this browser has notifications on. */
  on: boolean;
  /** Whether turning them on is under way. */
  turningOn: boolean;
  /**
   * Turns notifications on, from the click that asks, settling with what the Notification setup dialog
   * should say, or null when there's nothing to say: they're on, or turning them on was under way already.
   */
  turnOn: () => Promise<PushNotice | null>;
  /** The browser and system the setup help is for. */
  platform: Platform;
}

/** A browser the setup help has no steps for, such as one that sent no user agent. */
const UNKNOWN_PLATFORM: Platform = {
  ios: false,
  android: false,
  desktop: true,
  windows: false,
  chrome: false,
  firefox: false,
  safari: false,
  edge: false,
  browser: "",
  operatingSystem: "",
};

/** Outside a PushProvider, as in tests of a page on its own, notifications are off and the bell does nothing. */
export const PushContext = createContext<Push>({ on: false, turningOn: false, turnOn: async () => null, platform: UNKNOWN_PLATFORM });

export const usePush = () => useContext(PushContext);

interface Props {
  /** The key browsers subscribe with, or null while Web Push is off, as `/api/bootstrap` gives it. */
  vapidPublicKey: string | null;
  platform: Platform;
  children: ReactNode;
}

/**
 * Whether this browser has notifications on, for every page of the workspace, and turning them on. It's
 * checked as the workspace opens, rather than by the bell on each page, which would show the bell that
 * turns them on for a moment each time a room opens, and when they're on, this browser's subscription is
 * saved again, so the server keeps it (`savePushAgain`), but at an address Ember has moved from to its
 * custom domain, where the one this browser saved there replaced it (`replaceOnSave`), and saving it
 * again would have everything pushed to both.
 */
export function PushProvider({ vapidPublicKey, platform, children }: Props) {
  const [on, setOn] = useState(false);
  const [turningOn, setTurningOn] = useState(false);
  const turning = useRef(false);
  const savesAgain = !movedFrom(useAccount().customDomain);

  useEffect(() => {
    let stopped = false;
    void isPushOn(vapidPublicKey).then((on) => {
      if (!on || stopped) return;
      setOn(true);
      if (savesAgain) void savePushAgain();
    });
    return () => void (stopped = true);
  }, [vapidPublicKey, savesAgain]);
  // Logging out ends the subscription before it signs out, which may then fail and leave you here.
  useEffect(() => subscribeToPushEnding(() => setOn(false)), []);

  const turnOn = useCallback(async () => {
    // One at a time: the bell ignores presses while it's turning them on.
    if (turning.current) return null;
    turning.current = true;
    setTurningOn(true);
    try {
      const notice = await turnOnPush(vapidPublicKey);
      if (!notice) setOn(true);
      return notice;
    } finally {
      turning.current = false;
      setTurningOn(false);
    }
  }, [vapidPublicKey]);

  const push = useMemo(() => ({ on, turningOn, turnOn, platform }), [on, turningOn, turnOn, platform]);
  return <PushContext value={push}>{children}</PushContext>;
}
