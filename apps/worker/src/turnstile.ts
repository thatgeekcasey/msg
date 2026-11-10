import { TURNSTILE_CHECK_EXPIRED, TURNSTILE_KEYS_UNCHECKED, TURNSTILE_KEYS_UNMATCHED, TURNSTILE_SECRET_KEY_UNKNOWN } from "@ember/protocol";
import { contentSecurityPolicy, inlineScriptHashes } from "./csp";
import type { Env } from "./env";
import { isLoopback } from "./loopback";
import { workspace } from "./workspace";

// Cloudflare Turnstile, on the open sign-up form and the forms that ask Ember to email a link to join or
// a code to reset a password, while Ember has a widget's keys: the deployment's secrets, or else those
// an administrator gave it in Set up Turnstile. The page shows Turnstile's check, which gives it a
// token, and the Worker asks Cloudflare's siteverify whether the token is from a check that passed
// before it does anything else with the form
// (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/). A token is good
// once, for 5 minutes. Siteverify's answers are logged by their error codes alone.

/** Where Cloudflare says whether a check passed. */
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** How long siteverify has to answer. */
const TURNSTILE_TIMEOUT_MS = 10_000;

/** The keys of a Turnstile widget. */
export interface TurnstileKeys {
  /** The public one, which pages show the check with. */
  siteKey: string;
  secretKey: string;
}

/** The deployment's Turnstile keys, or null unless it has both. */
export function turnstileKeysOf(env: Env): TurnstileKeys | null {
  const [siteKey, secretKey] = [env.TURNSTILE_SITE_KEY?.trim(), env.TURNSTILE_SECRET_KEY?.trim()];
  return siteKey && secretKey ? { siteKey, secretKey } : null;
}

/** The keys Ember checks people with: the deployment's, which take the place of any others, or else those an administrator gave it, or null while it has neither. */
export async function turnstileKeysFor(env: Env): Promise<TurnstileKeys | null> {
  return turnstileKeysOf(env) ?? (await workspace(env).savedTurnstileKeys());
}

/** Where siteverify is: the browser tests' stand-in, which `TURNSTILE_SITEVERIFY_URL` names at a loopback address, or Cloudflare's own. */
function siteverifyOf(env: Env): string {
  const standIn = URL.parse(env.TURNSTILE_SITEVERIFY_URL?.trim() ?? "");
  return standIn && isLoopback(standIn) ? standIn.href : SITEVERIFY;
}

/** What siteverify answers, as far as the Worker reads it. */
interface Outcome {
  success?: unknown;
  "error-codes"?: unknown;
}

const isOutcome = (value: unknown): value is Outcome => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What Cloudflare says of `token` from the check of the widget whose secret key is `secretKey`, done from
 * `ip` if that's known: whether it passed, and if not, its error codes, or null when siteverify doesn't
 * answer as it should.
 */
async function siteverify(env: Env, secretKey: string, token: string, ip: string | null): Promise<{ passed: boolean; codes: string[] } | null> {
  try {
    const answer = await fetch(siteverifyOf(env), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: secretKey, response: token, ...(ip && { remoteip: ip }) }),
      redirect: "manual",
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    const outcome: unknown = answer.ok ? await answer.json() : null;
    if (!isOutcome(outcome)) {
      console.warn("Turnstile's siteverify didn't answer as it should:", answer.status);
      return null;
    }
    const codes = Array.isArray(outcome["error-codes"]) ? outcome["error-codes"].filter((code): code is string => typeof code === "string") : [];
    if (outcome.success !== true) console.warn("Turnstile's check didn't pass:", answer.status, codes);
    return { passed: outcome.success === true, codes };
  } catch (error) {
    console.error("Asking Turnstile whether a check passed failed:", error instanceof Error ? error.name : "unknown error");
    return null;
  }
}

/**
 * Whether Cloudflare says `token` is from a check that passed on the widget whose secret key is
 * `secretKey`, done from `ip` if that's known. No token, or siteverify not answering as it should,
 * counts as a check that didn't pass.
 */
export async function passedTurnstile(env: Env, secretKey: string, token: string | undefined, ip: string | null): Promise<boolean> {
  if (!token) return false;
  return (await siteverify(env, secretKey, token, ip))?.passed === true;
}

/**
 * Why Set up Turnstile's keys aren't kept, as siteverify answers the token the dialog's check gave it with
 * the site key, asked with the secret key: the field it's about and the status it's refused with, or null
 * once the check passed, which says the keys are one widget's, and that the widget checks people here.
 */
export async function refusalOfTurnstileKeys(
  env: Env,
  secretKey: string,
  token: string,
  ip: string | null,
): Promise<{ error: string; field?: "secretKey" | "turnstile"; status: number } | null> {
  const outcome = await siteverify(env, secretKey, token, ip);
  if (outcome?.passed) return null;
  const codes = outcome?.codes ?? [];
  if (codes.includes("invalid-input-secret")) return { error: TURNSTILE_SECRET_KEY_UNKNOWN, field: "secretKey", status: 422 };
  if (codes.includes("timeout-or-duplicate")) return { error: TURNSTILE_CHECK_EXPIRED, field: "turnstile", status: 422 };
  // A token from another widget's check, as one drawn with another site key gives.
  if (codes.includes("invalid-input-response")) return { error: TURNSTILE_KEYS_UNMATCHED, field: "secretKey", status: 422 };
  return { error: TURNSTILE_KEYS_UNCHECKED, status: 502 };
}

/**
 * What Set up Turnstile's check page runs: Turnstile's script, from the one address it may come from,
 * draws the check for the site key the fragment names, in the theme and size it names, then tells the
 * page that framed it, at this origin alone, what came of it: `{ token }` once it passes, `{ expired:
 * true }` once that token is no longer good, `{ error }` with Turnstile's error code, or `{ unavailable:
 * true }` when its script doesn't load.
 */
const CHECK_SCRIPT = `{
  const given = new URLSearchParams(location.hash.slice(1));
  const tell = (said) => parent.postMessage({ turnstileCheck: said }, location.origin);
  const theme = given.get("theme") === "dark" ? "dark" : "light";
  document.documentElement.style.colorScheme = theme;
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  script.onload = () => {
    try {
      turnstile.render("#check", {
        sitekey: given.get("site_key") ?? "",
        theme,
        size: given.get("size") === "compact" ? "compact" : "flexible",
        "response-field": false,
        callback: (token) => tell({ token }),
        "expired-callback": () => tell({ expired: true }),
        "timeout-callback": () => tell({ expired: true }),
        "error-callback": (code) => {
          tell({ error: String(code) });
          return true;
        },
      });
    } catch {
      tell({ error: "render" });
    }
  };
  script.onerror = () => tell({ unavailable: true });
  document.head.append(script);
}`;

/** Set up Turnstile's check page, which shows nothing but the check, on whatever the frame around it shows. */
const CHECK_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>Turnstile's check</title>
    <style>html, body { margin: 0; overflow: hidden; background: transparent; }</style>
  </head>
  <body>
    <div id="check"></div>
    <script>${CHECK_SCRIPT}</script>
  </body>
</html>
`;

/** The hash of the page's script, which its policy names, worked out the first time it's asked for. */
let checkScriptHashes: Promise<string[]> | undefined;

/**
 * `GET /account/turnstile_check`: the page Set up Turnstile frames to draw a widget's check, whose policy,
 * unlike the app's pages but those that show the check, lets Turnstile's script and frame load. It holds
 * nothing of the workspace, so it's the same for anyone.
 */
export async function turnstileCheckPage(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const policy = contentSecurityPolicy(request, await (checkScriptHashes ??= inlineScriptHashes(CHECK_PAGE)), true);
  return new Response(request.method === "HEAD" ? null : CHECK_PAGE, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": policy, "Cache-Control": "no-cache" },
  });
}
