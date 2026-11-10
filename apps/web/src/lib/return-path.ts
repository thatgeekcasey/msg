// Where to go once signed in: the page this tab was on when it was sent to sign in, as Campfire keeps
// `return_to_after_authenticating` in the session. The tab keeps it, so a sign-in in another tab doesn't
// take this one's.

const KEY = "ember:return-to";

/** Remembers the page this tab is on, to come back to once it's signed in. */
export function rememberThisPage(): void {
  try {
    sessionStorage.setItem(KEY, location.pathname + location.search + location.hash);
  } catch {
    // Storage can be refused, and then signing in goes home.
  }
}

/** The page to go to once this tab is signed in, which it keeps until it's taken or forgotten; null to go home. */
export function returnPath(): string | null {
  try {
    const path = sessionStorage.getItem(KEY);
    // Only a path on this site, which is all `rememberThisPage` stores.
    return path?.startsWith("/") && !path.startsWith("//") ? path : null;
  } catch {
    return null;
  }
}

/** The page to go to now that this tab is signed in, forgetting it; null to go home. */
export function takeReturnPath(): string | null {
  const path = returnPath();
  forgetReturnPath();
  return path;
}

/** Forgets the page to come back to, so signing in goes home. */
export function forgetReturnPath(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing was stored, then.
  }
}
