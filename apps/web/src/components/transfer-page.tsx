import { useEffect, useState } from "react";
import { ApiError, signInWithLink } from "@/lib/api";
import { loadPage } from "@/lib/page";
import { takeReturnPath } from "@/lib/return-path";

// The sign-in link page: an empty page whose form submits itself as soon as it's shown, signing the
// browser in as whoever the link was made for.

const MAX_RETRY_MS = 15_000;

/** The id in a sign-in link's fragment (`transferLink`), read as the setup page reads its link's token. */
const transferIdOf = (hash: string) => new URLSearchParams(hash.slice(1)).get("token") || null;

/**
 * Signs in with the sign-in link's id in the address's fragment as soon as it opens, then loads the page
 * this tab was sent to sign in from, or home. It clears the fragment first, as the setup page clears its
 * link's, so the id leaves the address bar and this tab's history. A link that doesn't work, or an
 * address without one, leaves the page blank, and a request that can't reach Ember, or that Ember fails,
 * is tried again, as the app's first one is.
 */
export function TransferPage() {
  // Opening another link over this page only changes the fragment, which loads no new page, so each
  // starts afresh here.
  const [opened, setOpened] = useState(0);
  useEffect(() => {
    const open = () => setOpened((count) => count + 1);
    addEventListener("hashchange", open);
    return () => removeEventListener("hashchange", open);
  }, []);
  return <LinkSignIn key={opened} />;
}

function LinkSignIn() {
  const [transferId] = useState(() => transferIdOf(location.hash));
  const [refused, setRefused] = useState(transferId === null);

  useEffect(() => {
    history.replaceState(history.state, "", location.pathname + location.search);
    if (transferId === null) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const signIn = (attempt: number) =>
      signInWithLink(transferId).then(
        // A new page, so nothing of any session this browser had stays in memory.
        () => !stopped && loadPage(takeReturnPath() ?? "/"),
        (error: unknown) => {
          if (stopped) return;
          if (error instanceof ApiError && error.status < 500) setRefused(true);
          else retry = setTimeout(() => void signIn(attempt + 1), Math.min(MAX_RETRY_MS, 1_000 * 2 ** attempt));
        },
      );
    void signIn(0);
    return () => {
      stopped = true;
      clearTimeout(retry);
    };
  }, [transferId]);

  return <main aria-busy={!refused} className="min-h-dvh bg-surface" />;
}
