import { lookUp, type DnsFetch } from "../dns";
import { isBlockedAddress, parseAddress } from "./addresses";

// The private network guard, with two differences that come from a Worker's `fetch` connecting by name,
// so the address checked can't be pinned for the connection:
//
// - A name must resolve only to public addresses, since connecting to the first public one would here
//   let the connection pick a blocked one.
// - A host written as an address, in any of the notations `inet_aton` reads (`127.0.0.1`,
//   `2130706433`, `0x7f.1`, `[::1]`), is never fetched, public or not. Workers can't fetch one anyway.

export class GuardError extends Error {
  override name = "GuardError";
}

/** A host's IPv4 and IPv6 addresses, for `host` alone, without a port. */
export type Resolve = (host: string) => Promise<string[]>;

const MAX_HOST_LENGTH = 255;
/** Surfguard's limit: more answers than this is a host that can't be resolved. */
const MAX_ADDRESSES = 256;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** `legacy_ipv4_shape`: 1 to 4 decimal or 0x-hex numbers, empty parts ignored, which `inet_aton` might read as an address. */
function looksLikeIpv4(host: string): boolean {
  const parts = host.split(".").filter((part) => part !== "");
  return parts.length >= 1 && parts.length <= 4 && parts.every((part) => /^(?:0[xX][0-9A-Fa-f]+|\d+)$/.test(part));
}

/** Whether `host` is a name to look up: labels of letters, digits and hyphens, and not an address in any notation. */
export function isHostName(host: string): boolean {
  if (host.length > MAX_HOST_LENGTH || host.includes(":") || looksLikeIpv4(host)) return false;
  return (host.endsWith(".") ? host.slice(0, -1) : host).split(".").every((label) => LABEL.test(label));
}

/**
 * Checks that `host` is a name that resolves, and only to public addresses, throwing a GuardError when
 * it isn't.
 */
export async function checkHost(host: string, resolve: Resolve): Promise<void> {
  if (!isHostName(host)) throw new GuardError(`Attempt to access private IP via ${host}`);
  const answers = await resolve(host).catch(() => null);
  if (!answers || answers.length === 0 || answers.length > MAX_ADDRESSES) throw new GuardError("Host could not be resolved");
  for (const answer of answers) {
    const address = parseAddress(answer);
    if (address === null || isBlockedAddress(address)) throw new GuardError(`Attempt to access private IP via ${host}`);
  }
}

/** A name's A and AAAA records from Cloudflare's resolver, asked through `fetch`: two subrequests. */
export async function resolveOverHttps(host: string, fetch: DnsFetch): Promise<string[]> {
  return (await Promise.all([lookUp(host, "A", fetch), lookUp(host, "AAAA", fetch)])).flat();
}
