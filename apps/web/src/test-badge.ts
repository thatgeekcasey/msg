import { onTestFinished } from "vitest";

/** A badge set on the app's icon, or "cleared" for one taken off. */
export type Badge = number | "cleared";

/**
 * Gives jsdom's navigator the Badging API for the test, as an installed app's has, and answers the
 * badges the page sets on the app's icon from then on, in order. `refuse` has the browser refuse each.
 */
export function badgeTheApp({ refuse = false } = {}): Badge[] {
  const badges: Badge[] = [];
  const answer = (badge: Badge) => {
    badges.push(badge);
    return refuse ? Promise.reject(new DOMException("The app's icon can't be badged.", "NotAllowedError")) : Promise.resolve();
  };
  Object.defineProperties(navigator, {
    setAppBadge: { value: (count = 0) => answer(count), configurable: true },
    clearAppBadge: { value: () => answer("cleared"), configurable: true },
  });
  onTestFinished(() => {
    delete (navigator as Partial<Navigator>).setAppBadge;
    delete (navigator as Partial<Navigator>).clearAppBadge;
  });
  return badges;
}
