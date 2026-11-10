import { JOINING_PARAM, JOINING_PROBLEMS, joiningProblemOf } from "@ember/protocol";

// Why a way to join sent the browser to sign in, as the Worker names it in the address (`?joining=`):
// the join link while it's off, and open sign-up while it's closed. The sign-in page says so.

/** What the sign-in page says about why it was opened instead of a page to join, if its address says. */
export function joiningProblemOnArrival(): string | null {
  const problem = joiningProblemOf(new URLSearchParams(location.search).get(JOINING_PARAM));
  return problem && JOINING_PROBLEMS[problem];
}

/** Takes it out of this page's address, so that it's said once, not again on reload. */
export function forgetJoiningProblem(): void {
  const params = new URLSearchParams(location.search);
  if (!params.has(JOINING_PARAM)) return;
  params.delete(JOINING_PARAM);
  const search = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
}
