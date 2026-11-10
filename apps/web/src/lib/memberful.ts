import {
  MEMBERFUL_CONNECTED,
  MEMBERFUL_CONNECTED_NOTICE,
  MEMBERFUL_PROBLEM_PARAM,
  MEMBERFUL_SIGN_IN_PROBLEMS,
  memberfulProblemOf,
  type MemberfulSignInProblem,
} from "@ember/protocol";
import type { FlashMessage } from "./flash";

// What signing in with Memberful, or connecting a Memberful account, came to, as the Worker's callback
// names it in the address it sends the browser back to (`?memberful=`): the sign-in page says what went
// wrong, and a page of the workspace flashes it, or that your Memberful account is connected.

/** What a Memberful sign-in or connection that came back to this page came to, as its address names it, if it does. */
export function memberfulOutcomeOnArrival(): MemberfulSignInProblem | typeof MEMBERFUL_CONNECTED | null {
  const value = new URLSearchParams(location.search).get(MEMBERFUL_PROBLEM_PARAM);
  return value === MEMBERFUL_CONNECTED ? value : memberfulProblemOf(value);
}

/** Takes it out of this page's address, so that it's said once, not again on reload. */
export function forgetMemberfulOutcome(): void {
  const params = new URLSearchParams(location.search);
  if (!params.has(MEMBERFUL_PROBLEM_PARAM)) return;
  params.delete(MEMBERFUL_PROBLEM_PARAM);
  const search = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
}

/** What a page of the workspace flashes for what this page's address says a Memberful connection came to, taking it out of the address. */
export function takeMemberfulFlash(): FlashMessage | null {
  const outcome = memberfulOutcomeOnArrival();
  forgetMemberfulOutcome();
  if (outcome === null) return null;
  return outcome === MEMBERFUL_CONNECTED ? { kind: "notice", text: MEMBERFUL_CONNECTED_NOTICE } : { kind: "alert", text: MEMBERFUL_SIGN_IN_PROBLEMS[outcome] };
}
