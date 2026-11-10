import { MAX_PUSH_KEY_LENGTH, WORKSPACE_SETTINGS_PATH } from "@ember/protocol";
import { loadPage } from "./page";
import { pushKey, replaceOnSave } from "./push";

// Ember's custom domain (`Account.customDomain`), which an administrator gives it in workspace settings:
// every page opened at any other address moves there, but workspace settings, which stays wherever it's
// opened, so an administrator can always stop using a domain that has stopped reaching Ember. A page
// that moves names this browser's push subscription at the address it leaves, so that the one this
// browser saves at the new address replaces it.

/** The query parameter a moving page names this browser's push subscription by, its P-256 key. */
const REPLACING_PUSH = "replacing_push";

/** A P-256 key in URL-safe Base64, as a browser's push subscription gives it. */
const PUSH_KEY = /^[\w-]+$/;

/**
 * This page at Ember's custom domain, `customDomain`, naming the push subscription with the P-256 key
 * `replacingPush`, if given, or null when it's there already or Ember has none.
 */
export function thisPageAt(customDomain: string | null, replacingPush: string | null = null): string | null {
  if (customDomain === null || customDomain === location.host) return null;
  const { search } = location;
  const named = replacingPush === null ? search : `${search}${search ? "&" : "?"}${REPLACING_PUSH}=${encodeURIComponent(replacingPush)}`;
  return `${location.protocol}//${customDomain}${location.pathname}${named}${location.hash}`;
}

/** Whether the page at `pathname` stays at whatever address it's opened at, as workspace settings does. */
export const staysAtAnyAddress = (pathname: string) => pathname === WORKSPACE_SETTINGS_PATH;

/** Whether Ember has moved from this page's address to its custom domain, `customDomain`. */
export const movedFrom = (customDomain: string | null) => thisPageAt(customDomain) !== null;

/** Whether this page moves to Ember's custom domain, `customDomain`, as it opens: it's elsewhere, and doesn't stay. */
export const movesTo = (customDomain: string | null) => !staysAtAnyAddress(location.pathname) && movedFrom(customDomain);

/** Loads this page at Ember's custom domain, `customDomain`, naming this browser's push subscription here. */
export async function moveTo(customDomain: string | null): Promise<void> {
  const there = thisPageAt(customDomain, await pushKey().catch(() => null));
  if (there !== null) loadPage(there);
}

/**
 * Takes the push subscription a page that moved here names out of its address, leaving the rest of the
 * address as it is, and keeps it for the one this browser saves here to replace.
 */
export function keepReplacingPush(): void {
  const params = location.search.slice(1).split("&");
  const named = params.find((param) => param.startsWith(`${REPLACING_PUSH}=`));
  if (named === undefined) return;
  const rest = params.filter((param) => param !== "" && !param.startsWith(`${REPLACING_PUSH}=`));
  history.replaceState(history.state, "", `${location.pathname}${rest.length > 0 ? `?${rest.join("&")}` : ""}${location.hash}`);
  const key = named.slice(REPLACING_PUSH.length + 1);
  if (PUSH_KEY.test(key) && key.length <= MAX_PUSH_KEY_LENGTH) replaceOnSave(key);
}
