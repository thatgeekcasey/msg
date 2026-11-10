import type { LinkPreview } from "@ember/protocol";
import { DurableObject } from "cloudflare:workers";
import { credentialsOf } from "../auth";
import { jsonBodyOf } from "../bodies";
import type { Env } from "../env";
import { urlOf } from "../request-url";
import { workspace } from "../workspace";
import { hostOf, Outbound, type Network } from "./fetch";
import { resolveOverHttps } from "./guard";
import { isBlank, linkPreview } from "./metadata";
import { parseHttpUri } from "./uri";

/** The most one unfurl may take, redirects and the image check included. */
export const UNFURL_DEADLINE_MS = 10_000;

/** The Internet as a Worker reaches it, with names resolved by Cloudflare's DNS over HTTPS. */
const internet: Network = {
  fetch: (request) => fetch(request),
  resolve: (host, signal) => resolveOverHttps(host, (request) => fetch(request, { signal })),
};

const problem = (status: number, message: string) => Response.json({ error: message }, { status });
const noContent = () => new Response(null, { status: 204 });

/**
 * `POST /api/unfurl` with JSON `{url}`: the preview the composer shows for a pasted link, with a limit
 * on how many each person asks for. 204 when the link has no preview.
 */
export async function unfurlLink(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const verdict = credentials && (await workspace(env).beginUnfurl(credentials));
  if (!verdict) return problem(401, "Not signed in");
  if (verdict === "limited") return problem(429, "Too many link previews. Try again in a minute.");

  const url = requiredUrl(await jsonBodyOf(request));
  if (url === undefined) return problem(400, "param is missing or the value is empty: url");
  // A hash, an array or a number gets past `require`, but isn't a URL.
  if (typeof url !== "string" || isOwnHost(url, request)) return noContent();
  const preview = await unfurler(env).unfurl(url);
  return preview ? Response.json(preview) : noContent();
}

/**
 * Unfurls links where there's CPU time for it: reading a page of up to 5 MiB, once it's decompressed,
 * takes tens of milliseconds, and on Workers Free a Worker's request gets 10 ms where a Durable
 * Object's gets 30 seconds. It keeps nothing, so each unfurl runs in a new object of its own.
 */
export class Unfurler extends DurableObject<Env> {
  unfurl(url: string): Promise<LinkPreview | null> {
    return unfurl(url, internet);
  }
}

/** A new object to unfurl a link in, near this request, or near the room whose message has the link. */
export const unfurler = (env: Env) => env.UNFURLER.get(env.UNFURLER.newUniqueId());

/** The preview of `url`, or null when it has none or making it takes longer than `deadlineMs`. */
export async function unfurl(url: string, network: Network, deadlineMs = UNFURL_DEADLINE_MS): Promise<LinkPreview | null> {
  const deadline = AbortSignal.timeout(deadlineMs);
  const gaveUp = new Promise<null>((resolve) => deadline.addEventListener("abort", () => resolve(null), { once: true }));
  try {
    const preview = await Promise.race([linkPreview(new Outbound(network, deadline), url), gaveUp]);
    if (!deadline.aborted) return preview;
    console.warn(`Gave up unfurling a link to ${hostOf(url)} after ${deadlineMs / 1000}s`);
  } catch (error) {
    console.error(`Failed to unfurl a link to ${hostOf(url)}`, error);
  }
  return null;
}

/**
 * `params.require(:url)`: undefined when the body has no `url`, or a blank one (null, whitespace, or an
 * empty array or object, where Rails drops nulls from arrays), else whatever it sent. False counts as sent.
 */
function requiredUrl(body: unknown): unknown {
  const url = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).url : undefined;
  if (url === undefined || url === null) return undefined;
  if (typeof url === "string") return isBlank(url) ? undefined : url;
  if (Array.isArray(url)) return url.every((item) => item === null) ? undefined : url;
  if (typeof url === "object") return Object.keys(url).length === 0 ? undefined : url;
  return url;
}

/** Whether `url` is on this Ember's own host, which the app never shows a preview of. */
function isOwnHost(url: string, request: Request): boolean {
  return isOnHost(url, [urlOf(request).host]);
}

/** Whether `url` is on one of `hosts`, as `location.host` writes them, at any port. */
export function isOnHost(url: string, hosts: readonly string[]): boolean {
  const host = parseHttpUri(url)?.host.toLowerCase().replace(/\.$/, "");
  return host !== undefined && hosts.some((own) => own.replace(/:\d+$/, "") === host);
}
