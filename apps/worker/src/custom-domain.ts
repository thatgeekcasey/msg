import { canBeCustomDomain, isCustomDomainHost, isHost, type CustomDomainLookup, type CustomDomainReach, type DnsProvider } from "@ember/protocol";
import { lookUp, zoneOf, type DnsFetch } from "./dns";
import { toBase64url } from "./encoding";
import type { Env } from "./env";
import { urlOf } from "./request-url";
import { workspace, type Credentials } from "./workspace";

// Ember's address, which an administrator gives it in Workspace settings (`Account.customDomain`): a
// custom domain, or where a deploy puts Ember once they go back there, the address the app moves to from
// any other Ember answers at, and the one the bot API's links name.

/** Why an address is refused as Ember's when it isn't the one the request came to, a custom domain, nor where a deploy puts Ember. */
export const NOT_THIS_ADDRESS = "Open Ember at that address to make it Ember's";

/** Why Ember can't go back to `address`, where a deploy puts it, when a check finds it doesn't reach Ember there, as when its workers.dev address is off. */
export const cantGoBackTo = (address: string) =>
  `Ember doesn't answer at ${address} now, so it can't go back there. In Cloudflare, check that the Worker's workers.dev address is on, under Domains & Routes.`;

/** Why `address`, a custom domain, can't be Ember's when a check finds it `reaches` something else, or nothing yet. */
export const cantUse = (address: string, reaches: Exclude<CustomDomainReach, "ember">) =>
  reaches === "elsewhere" ? `Something else answers at ${address}, not Ember.` : `Nothing answers at ${address} yet. Cloudflare can take a minute to add it, so try again soon.`;

/** Where a domain answers a check's probe, `/api/custom_domain_probes/<probe>`, if it reaches this Ember. */
const PROBE_PREFIX = "/api/custom_domain_probes/";
const PROBE_PATH = /^\/api\/custom_domain_probes\/([\w-]{32})$/;
/** The header a probe's answer comes in. */
export const PROBE_ANSWER_HEADER = "X-Ember-Probe";
/** How long a check waits for the domain to answer. */
const CHECK_DEADLINE_MS = 10_000;

/**
 * Why `request` can't make `address` Ember's, or null when it can, so that Ember never sends people to a
 * host that doesn't reach this Worker: it can be the address the request came to, the one the page
 * asking is open at, or, once a probe finds Ember answers there, which only an administrator's request,
 * as `credentials` signs one in, sends, a custom domain or where a deploy puts Ember, as a page there
 * told the Workspace. Null, for none, always can.
 */
export async function addressRefusal(address: string | null | undefined, request: Request, env: Env, credentials: Credentials): Promise<string | null> {
  if (address === undefined || address === null || address === urlOf(request).host) return null;
  const ember = workspace(env);
  const [deployed, administrator] = await Promise.all([ember.deployedAddress(), ember.canAdminister(credentials)]);
  if (!administrator || (address !== deployed && !isCustomDomainHost(address))) return NOT_THIS_ADDRESS;
  const reaches = await reachOf(request, env, address);
  if (reaches === "ember") return null;
  return address === deployed ? cantGoBackTo(address) : cantUse(address, reaches);
}

/** The address `request` came to, if it's where a deploy or `wrangler dev` puts Ember: its workers.dev address, or a local one. */
export function deployedAddressOf(request: Request): string | null {
  const { host, hostname } = urlOf(request);
  return isHost(host) && !canBeCustomDomain(hostname) ? host : null;
}

/** The origin of Ember's address: its custom domain, by the scheme `request` came by, or the request's own origin while it has none. */
export function originFor(request: Request, customDomain: string | null): string {
  const url = urlOf(request);
  return customDomain === null ? url.origin : `${url.protocol}//${customDomain}`;
}

/** A probe, or its answer: 24 random bytes, as 32 base64url characters. */
const probeToken = () => toBase64url(crypto.getRandomValues(new Uint8Array(24)));

/**
 * Whether `status` is Cloudflare's own answer for an origin it can't reach (520 to 527), or for a host
 * it can't resolve (530, as its error 1016), rather than the domain's.
 */
const isUnreached = (status: number) => (status >= 520 && status <= 527) || status === 530;

/**
 * What `domain` reaches, asked by the scheme `request` came by, as Workspace settings' checks ask before
 * an administrator makes it Ember's address. The Workspace waits for a probe only this check knows, so
 * an answer to it comes from this Ember: "ember". No answer in time, or only Cloudflare's for an origin
 * it can't reach, is "nothing", and any other, a redirect included, "elsewhere". Nothing is sent but the
 * probe, and nothing of the answer is read but its header.
 */
export async function reachOf(request: Request, env: Env, domain: string): Promise<CustomDomainReach> {
  const [probe, answer] = [probeToken(), probeToken()];
  await workspace(env).expectProbe(probe, answer);
  const { protocol } = urlOf(request);
  let response: Response;
  try {
    response = await fetch(`${protocol}//${domain}${PROBE_PREFIX}${probe}`, { redirect: "manual", signal: AbortSignal.timeout(CHECK_DEADLINE_MS) });
  } catch {
    return "nothing";
  }
  void response.body?.cancel().catch(() => {});
  if (response.headers.get(PROBE_ANSWER_HEADER) === answer) return "ember";
  return isUnreached(response.status) ? "nothing" : "elsewhere";
}

/** The probe `pathname` asks for, if it's a probe's address. */
export const probeOf = (pathname: string) => PROBE_PATH.exec(pathname)?.[1] ?? null;

/** Answers a check's `probe`, once, if the Workspace waits for it, which only this Ember's does. */
export async function answerProbe(env: Env, probe: string): Promise<Response> {
  const answer = await workspace(env).takeProbe(probe);
  if (answer === null) return Response.json({ error: "Not found" }, { status: 404 });
  return new Response(null, { status: 204, headers: { [PROBE_ANSWER_HEADER]: answer, "Cache-Control": "no-store" } });
}

/** How long Cloudflare's resolver has to answer each lookup. */
const LOOKUP_TIMEOUT_MS = 5_000;

/** Cloudflare's resolver as the Worker reaches it, giving each lookup `LOOKUP_TIMEOUT_MS`. */
const resolver: DnsFetch = (request) => fetch(request, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });

/**
 * The DNS providers the Custom domain card knows by their nameservers' names. Squarespace's are NS1's,
 * which serve others' domains too, so it's only ever chosen, and only Namecheap's BasicDNS names it:
 * its FreeDNS and PremiumDNS also serve domains registered elsewhere.
 */
const PROVIDER_NAMESERVERS: ReadonlyArray<readonly [DnsProvider, RegExp]> = [
  ["cloudflare", /\.ns\.cloudflare\.com$/],
  ["godaddy", /\.domaincontrol\.com$/],
  ["namecheap", /^dns\d+\.registrar-servers\.com$/],
  ["porkbun", /\.ns\.porkbun\.com$/],
  ["route53", /\.awsdns-\d+\.(?:com|net|org|co\.uk)$/],
  ["hover", /^ns\d+\.hover\.com$/],
  ["ionos", /\.ui-dns\.(?:com|de|org|biz)$/],
];

/** Whose `nameservers` are, as an NS lookup writes them: a provider the card knows, "other", or null for none. */
function providerOf(nameservers: string[]): DnsProvider | null {
  if (nameservers.length === 0) return null;
  const names = nameservers.map((nameserver) => nameserver.toLowerCase().replace(/\.$/, ""));
  return PROVIDER_NAMESERVERS.find(([, pattern]) => names.some((name) => pattern.test(name)))?.[0] ?? "other";
}

/**
 * Where the DNS of `domain`, a custom domain's host, is, as Set up in Workspace settings asks for its
 * steps: the zone it's in, and the provider whose nameservers serve that zone, asked of Cloudflare's
 * resolver through `fetch`, in two subrequests, or one more for each alias it goes up past (`zoneOf`).
 * A name under localhost, which never reaches DNS, asks nothing. What the resolver doesn't answer is
 * null, and logged.
 */
export async function lookUpDns(domain: string, fetch: DnsFetch = resolver): Promise<CustomDomainLookup> {
  const hostname = domain.replace(/:\d+$/, "");
  if (hostname.endsWith(".localhost")) return { zone: null, provider: null };
  let zone: string | null = null;
  try {
    zone = await zoneOf(hostname, fetch);
    return { zone, provider: zone === null ? null : providerOf(await lookUp(zone, "NS", fetch)) };
  } catch (error) {
    console.error("Looking up a custom domain's DNS failed:", error instanceof Error ? error.message : "unknown error");
    return { zone, provider: null };
  }
}
