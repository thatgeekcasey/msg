import { useEffect, useState } from "react";
import type { ReleaseCheck } from "@ember/protocol";
import { checkForRelease, checkForReleaseAfresh } from "@/lib/api";
import { whenIdle } from "@/lib/idle";

/**
 * For an administrator, the release this Ember is and the newest one GitHub names, which the Worker is
 * asked for once the page is `ready` and the browser is idle, and again for someone made an
 * administrator. Each time they open Admin (`inAdmin` on every page of community settings) it's asked
 * afresh, having the Worker ask GitHub again, as the project's owner asked (2026-11-05), though going on
 * to another of its pages, or leaving it, asks nothing. Null until it answers, and for anyone else, or
 * when asking fails, which nothing waits on.
 */
export function useReleaseCheck(administrator: boolean, ready: boolean, inAdmin: boolean): ReleaseCheck | null {
  const [check, setCheck] = useState<ReleaseCheck | null>(null);
  // How many times Admin has opened since the page loaded.
  const [admin, setAdmin] = useState({ open: inAdmin, openings: 0 });
  if (admin.open !== inAdmin) setAdmin({ open: inAdmin, openings: admin.openings + (inAdmin ? 1 : 0) });
  const asking = administrator && ready;
  // Not run for `inAdmin` itself, so that leaving Admin doesn't ask, but whenever this runs in Admin, it's
  // for opening it, or for the page becoming ready, or someone made an administrator, there.
  useEffect(() => {
    if (!asking) return;
    let current = true;
    const ask = inAdmin ? checkForReleaseAfresh : checkForRelease;
    const cancel = whenIdle(
      () =>
        void ask().then(
          (answer) => current && setCheck(answer),
          () => {},
        ),
    );
    return () => {
      current = false;
      cancel();
    };
  }, [asking, admin.openings]);
  return administrator ? check : null;
}
