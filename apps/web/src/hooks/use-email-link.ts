import { useEffect, useState } from "react";
import type { EmailLinkKind } from "@ember/protocol";
import { ApiError, lookUpEmailLink } from "@/lib/api";

// The pages a link Ember emails opens hold its secret in the fragment (`invitationLink`,
// `emailSignUpLink`): they take it out of the address, as the sign-in link's page does, and ask what
// the link is and whom it's for, which spends nothing.

const MAX_RETRY_MS = 15_000;

/** A link Ember emailed someone to join with: what it is, its secret, and the address it's for. */
export interface EmailLink {
  kind: EmailLinkKind;
  token: string;
  emailAddress: string;
}

/** The secret in the fragment of a link Ember emails. */
const tokenOf = (hash: string) => new URLSearchParams(hash.slice(1)).get("token") || null;

/**
 * How many links have opened over the page since it loaded, which only change its fragment, loading no
 * new page, so that a page keyed by it starts afresh for each.
 */
export function useLinksOpened(): number {
  const [opened, setOpened] = useState(0);
  useEffect(() => {
    const open = () => setOpened((count) => count + 1);
    addEventListener("hashchange", open);
    return () => removeEventListener("hashchange", open);
  }, []);
  return opened;
}

/**
 * The link of `kind` whose secret was in the address's fragment as the page opened, once it's looked up:
 * "none" without one, "looking" until Ember answers, and "gone" for one that doesn't work, or is another
 * kind. It clears the fragment first, so the secret leaves the address bar and this tab's history. A
 * request that can't reach Ember, or that Ember fails, is tried again, as the app's first one is. With
 * it comes what to call once the link stops working while it's shown, which makes it "gone".
 */
export function useEmailLink(kind: EmailLinkKind): [EmailLink | "none" | "looking" | "gone", () => void] {
  const [token] = useState(() => tokenOf(location.hash));
  const [link, setLink] = useState<EmailLink | "none" | "looking" | "gone">(token === null ? "none" : "looking");

  useEffect(() => {
    history.replaceState(history.state, "", location.pathname + location.search);
    if (token === null) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const lookUp = (attempt: number) =>
      lookUpEmailLink(token).then(
        (found) => !stopped && setLink(found.kind === kind ? { kind, token, emailAddress: found.emailAddress } : "gone"),
        (error: unknown) => {
          if (stopped) return;
          if (error instanceof ApiError && error.status < 500) setLink("gone");
          else retry = setTimeout(() => void lookUp(attempt + 1), Math.min(MAX_RETRY_MS, 1_000 * 2 ** attempt));
        },
      );
    void lookUp(0);
    return () => {
      stopped = true;
      clearTimeout(retry);
    };
  }, [token, kind]);

  return [link, () => setLink("gone")];
}
