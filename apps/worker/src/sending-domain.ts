import { lookUp, type DnsFetch } from "./dns";

// A check that a domain is onboarded to Cloudflare Email Sending, as Set up email's From step asks once
// an address is typed there. Cloudflare's API says so only with an API token, which Ember never holds,
// but Onboard Domain adds public records that stay as long as the domain sends: MX records on its
// `cf-bounce` subdomain naming Cloudflare's mail servers, which take its bounces, and the DKIM key
// Cloudflare signs its email with, at `cf-bounce._domainkey`
// (https://developers.cloudflare.com/email-service/configuration/domains/). Whether Cloudflare sends
// from it, as it doesn't on Workers Free, only sending says, as the test email does.

/** How long Cloudflare's resolver has to answer each lookup. */
const LOOKUP_TIMEOUT_MS = 5_000;
/** The mail servers Email Sending's bounce MX records name, Cloudflare's own. */
const CLOUDFLARE_MAIL_SERVER = /\.mx\.cloudflare\.net\.?$/i;
/** A DKIM key record's public key: its `p=` tag with a key, as a revoked key's empty one has none. */
const DKIM_PUBLIC_KEY = /(?:^|;)\s*p=[A-Za-z0-9+/]/;

/** Cloudflare's resolver as the Worker reaches it, giving each lookup `LOOKUP_TIMEOUT_MS`. */
const resolver: DnsFetch = (request) => fetch(request, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });

/**
 * Whether `domain` is onboarded to Cloudflare Email Sending, as its public DNS says: true with both the
 * bounce MX records and the DKIM key, false without either, as for a domain onboarded only to Email
 * Routing, or not on Cloudflare at all, or null when Cloudflare's resolver doesn't answer, which is
 * logged. Two subrequests.
 */
export async function isOnboardedToEmailSending(domain: string, fetch: DnsFetch = resolver): Promise<boolean | null> {
  try {
    const [mailServers, keys] = await Promise.all([lookUp(`cf-bounce.${domain}`, "MX", fetch), lookUp(`cf-bounce._domainkey.${domain}`, "TXT", fetch)]);
    return mailServers.some((record) => CLOUDFLARE_MAIL_SERVER.test(record)) && keys.some((record) => DKIM_PUBLIC_KEY.test(textOf(record)));
  } catch (error) {
    console.error("Looking up a sending domain's records failed:", error instanceof Error ? error.message : "unknown error");
    return null;
  }
}

/** A TXT record's text, which DNS over HTTPS writes as the quoted strings that hold it, run together. */
const textOf = (data: string) => data.replace(/"\s*"/g, "").replace(/^"|"$/g, "");
