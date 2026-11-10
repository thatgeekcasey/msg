import { useEffect, useLayoutEffect, useRef } from "react";

// Cloudflare Turnstile's check on the open sign-up page, where someone asks for a link to join with their
// email address, and where someone asks for a code to reset their password, while Ember has a widget's
// keys: Turnstile's script, which only those pages' policy lets load, draws the check in a frame of its
// own and gives the page a token once it passes, which the form sends for the Worker to ask siteverify
// about (https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/). A token is good
// once, so the page draws the check afresh for each try.

/** Turnstile's script, from the one address it may come from, rendering only what the page asks for. */
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** The narrowest the check draws at its flexible size, below which it's drawn compact. */
export const FLEXIBLE_MIN_WIDTH = 300;

/** The part of Turnstile's API the page uses. */
export interface Turnstile {
  render(container: HTMLElement, options: TurnstileOptions): string | null | undefined;
  remove(widgetId: string): void;
}

interface TurnstileOptions {
  sitekey: string;
  theme: "light" | "dark";
  size: "flexible" | "compact";
  /** Whether Turnstile adds a field with the token to the form, which the page sends itself. */
  "response-field": boolean;
  callback: (token: string) => void;
  "expired-callback": () => void;
  "timeout-callback": () => void;
  "error-callback": () => void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | null = null;

/** Turnstile's API, loading its script the first time it's asked for, and again after it failed to. */
function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.addEventListener("load", () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile's script has no API"))));
    script.addEventListener("error", () => reject(new Error("Turnstile's script didn't load")));
    document.head.append(script);
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

interface Props {
  siteKey: string;
  /** Called with a token once the check passes, and with null once that token is no longer good, or the check fails. */
  onToken: (token: string | null) => void;
  /** Called if Turnstile's script doesn't load, when there's no check to pass. */
  onUnavailable: () => void;
}

/** Turnstile's check, in the page's appearance, as wide as the form, or compact where the form is narrower than it draws. */
export function TurnstileCheck({ siteKey, onToken, onUnavailable }: Props) {
  const container = useRef<HTMLDivElement>(null);
  // The callbacks as they are now, for the check, which keeps those it was drawn with.
  const callbacks = useRef({ onToken, onUnavailable });
  useLayoutEffect(() => {
    callbacks.current = { onToken, onUnavailable };
  });

  useEffect(() => {
    let stopped = false;
    let drawn: { turnstile: Turnstile; id: string } | null = null;
    loadTurnstile().then(
      (turnstile) => {
        const element = container.current;
        if (stopped || !element) return;
        const id = turnstile.render(element, {
          sitekey: siteKey,
          theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
          size: element.clientWidth >= FLEXIBLE_MIN_WIDTH ? "flexible" : "compact",
          "response-field": false,
          callback: (token) => callbacks.current.onToken(token),
          "expired-callback": () => callbacks.current.onToken(null),
          "timeout-callback": () => callbacks.current.onToken(null),
          "error-callback": () => callbacks.current.onToken(null),
        });
        if (id) drawn = { turnstile, id };
      },
      () => !stopped && callbacks.current.onUnavailable(),
    );
    return () => {
      stopped = true;
      if (drawn) drawn.turnstile.remove(drawn.id);
    };
  }, [siteKey]);

  // As tall as the check draws at its flexible size, so the form doesn't move as it appears.
  return <div ref={container} className="min-h-[65px]" />;
}
