// A flash message, shown at the top of a page: a notice, or an alert when something went wrong. One
// meant for the page after a full page load waits in this tab's storage, as Rails keeps a flash in the
// session for the request after a redirect.

export interface FlashMessage {
  kind: "notice" | "alert";
  text: string;
}

const KEY = "ember:flash";

/** Keeps `message` for the next page this tab loads to flash. */
export function flashOnNextPage(message: FlashMessage): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(message));
  } catch {
    // Storage can be refused, and then the next page shows no flash.
  }
}

/** The message the page before this one kept to flash, forgetting it; null when there's none. */
export function takeFlashFromLastPage(): FlashMessage | null {
  try {
    const stored = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return stored === null ? null : asFlashMessage(JSON.parse(stored));
  } catch {
    return null;
  }
}

/** `value` if it's a flash message, as `flashOnNextPage` stores one, or else null. */
function asFlashMessage(value: unknown): FlashMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, text } = value as Partial<FlashMessage>;
  return (kind === "notice" || kind === "alert") && typeof text === "string" ? { kind, text } : null;
}
