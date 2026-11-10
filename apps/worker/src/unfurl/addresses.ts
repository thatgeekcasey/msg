// Which addresses a link preview may be fetched from: `Surfguard.blocked_address?` with its default
// policy (gem revision 59e278c), with the address parsing of Rust's `IpAddr::from_str`. An IPv4 address
// is a number, and an IPv6 address a bigint.

export type Address = number | bigint;

/** `text` as an IPv6 address when it has a colon, else as an IPv4 address, or null. */
export const parseAddress = (text: string): Address | null => (text.includes(":") ? parseIpv6(text) : parseIpv4(text));

/** Four decimal octets of at most three digits, without leading zeros, as Rust's `Ipv4Addr::from_str` reads them. */
export function parseIpv4(text: string): number | null {
  const octets = text.split(".");
  if (octets.length !== 4 || !octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)) return null;
  return octets.reduce((address, octet) => address * 256 + Number(octet), 0);
}

/**
 * Rust's `Ipv6Addr::from_str`: eight groups of 1 to 4 hex digits, with one "::" standing for at least
 * one group of zeros, and an optional dotted IPv4 address for the last two groups.
 */
export function parseIpv6(text: string): bigint | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? parseGroups(halves[1]!, true) : [];
  if (!head || !tail) return null;
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  return groups.reduce((address, group) => (address << 16n) | BigInt(group), 0n);
}

/** The 16-bit groups of one side of "::", or null. `last` says whether a dotted IPv4 address may end it. */
function parseGroups(text: string, last: boolean): number[] | null {
  if (text === "") return [];
  const parts = text.split(":");
  const groups: number[] = [];
  for (const [i, part] of parts.entries()) {
    const ipv4 = last && i === parts.length - 1 && part.includes(".") ? parseIpv4(part) : undefined;
    if (ipv4 === null) return null;
    if (ipv4 !== undefined) groups.push(ipv4 >>> 16, ipv4 & 0xffff);
    else if (/^[0-9A-Fa-f]{1,4}$/.test(part)) groups.push(parseInt(part, 16));
    else return null;
  }
  return groups;
}

type Ipv4Range = readonly [network: number, prefix: number];
type Ipv6Range = readonly [network: bigint, prefix: number];

const v4 = (a: number, b: number, c: number, d: number, prefix: number): Ipv4Range => [((a << 24) | (b << 16) | (c << 8) | d) >>> 0, prefix];
const v6 = (groups: readonly number[], prefix: number): Ipv6Range => [groups.reduce((address, group) => (address << 16n) | BigInt(group), 0n), prefix];

/** `Surfguard::DISALLOWED_IPV4` */
const DISALLOWED_IPV4 = [
  v4(0, 0, 0, 0, 8),
  v4(10, 0, 0, 0, 8),
  v4(100, 64, 0, 0, 10),
  v4(127, 0, 0, 0, 8),
  v4(168, 63, 129, 16, 32),
  v4(169, 254, 0, 0, 16),
  v4(172, 16, 0, 0, 12),
  v4(192, 0, 0, 0, 24),
  v4(192, 0, 2, 0, 24),
  v4(192, 88, 99, 0, 24),
  v4(192, 168, 0, 0, 16),
  v4(198, 18, 0, 0, 15),
  v4(198, 51, 100, 0, 24),
  v4(203, 0, 113, 0, 24),
  v4(224, 0, 0, 0, 4),
  v4(240, 0, 0, 0, 4),
];

/** `Surfguard::DISALLOWED_IPV6` */
const DISALLOWED_IPV6 = [
  v6([0, 0, 0, 0, 0, 0, 0, 0], 128),
  v6([0x100, 0, 0, 0, 0, 0, 0, 0], 64),
  v6([0x100, 0, 0, 1, 0, 0, 0, 0], 64),
  v6([0x2001, 0, 0, 0, 0, 0, 0, 0], 32),
  v6([0x2001, 2, 0, 0, 0, 0, 0, 0], 48),
  v6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32),
  v6([0x2002, 0, 0, 0, 0, 0, 0, 0], 16),
  v6([0x3fff, 0, 0, 0, 0, 0, 0, 0], 20),
  v6([0x5f00, 0, 0, 0, 0, 0, 0, 0], 16),
  v6([0xfec0, 0, 0, 0, 0, 0, 0, 0], 10),
  v6([0xff00, 0, 0, 0, 0, 0, 0, 0], 8),
];

/** `Surfguard::IANA_ALLOCATED_IPV6_UNICAST` */
const IANA_ALLOCATED_IPV6_UNICAST = [
  v6([0x2001, 0, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x200, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x400, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x600, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x800, 0, 0, 0, 0, 0, 0], 22),
  v6([0x2001, 0xc00, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0xe00, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x1200, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x1400, 0, 0, 0, 0, 0, 0], 22),
  v6([0x2001, 0x1800, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x1a00, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x1c00, 0, 0, 0, 0, 0, 0], 22),
  v6([0x2001, 0x2000, 0, 0, 0, 0, 0, 0], 19),
  v6([0x2001, 0x4000, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x4200, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x4400, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x4600, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x4800, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x4a00, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x4c00, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2001, 0x5000, 0, 0, 0, 0, 0, 0], 20),
  v6([0x2001, 0x8000, 0, 0, 0, 0, 0, 0], 19),
  v6([0x2001, 0xa000, 0, 0, 0, 0, 0, 0], 20),
  v6([0x2001, 0xb000, 0, 0, 0, 0, 0, 0], 20),
  v6([0x2002, 0, 0, 0, 0, 0, 0, 0], 16),
  v6([0x2003, 0, 0, 0, 0, 0, 0, 0], 18),
  v6([0x2400, 0, 0, 0, 0, 0, 0, 0], 12),
  v6([0x2410, 0, 0, 0, 0, 0, 0, 0], 12),
  v6([0x2600, 0, 0, 0, 0, 0, 0, 0], 12),
  v6([0x2610, 0, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2620, 0, 0, 0, 0, 0, 0, 0], 23),
  v6([0x2630, 0, 0, 0, 0, 0, 0, 0], 12),
  v6([0x2800, 0, 0, 0, 0, 0, 0, 0], 12),
  v6([0x2a00, 0, 0, 0, 0, 0, 0, 0], 12),
  v6([0x2a10, 0, 0, 0, 0, 0, 0, 0], 12),
  v6([0x2c00, 0, 0, 0, 0, 0, 0, 0], 12),
];

/** `Surfguard::GLOBALLY_REACHABLE_IETF_ASSIGNMENTS` */
const GLOBALLY_REACHABLE_IETF_ASSIGNMENTS = [v6([0x2001, 3, 0, 0, 0, 0, 0, 0], 32), v6([0x2001, 4, 0x112, 0, 0, 0, 0, 0], 48)];
const IETF_PROTOCOL_ASSIGNMENTS = v6([0x2001, 0, 0, 0, 0, 0, 0, 0], 23);
const NAT64_WELL_KNOWN = v6([0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96);
const NAT64_LOCAL_USE = v6([0x64, 0xff9b, 1, 0, 0, 0, 0, 0], 48);
const IPV4_MAPPED = v6([0, 0, 0, 0, 0, 0xffff, 0, 0], 96);
const IPV4_TRANSLATABLE = v6([0, 0, 0, 0, 0xffff, 0, 0, 0], 96);
const IPV4_COMPATIBLE = v6([0, 0, 0, 0, 0, 0, 0, 0], 96);
const UNIQUE_LOCAL = v6([0xfc00, 0, 0, 0, 0, 0, 0, 0], 7);
const LINK_LOCAL = v6([0xfe80, 0, 0, 0, 0, 0, 0, 0], 10);
const LOOPBACK = 1n;

const inIpv4Range = (address: number, [network, prefix]: Ipv4Range) => prefix === 0 || (address ^ network) >>> (32 - prefix) === 0;
const inIpv6Range = (address: bigint, [network, prefix]: Ipv6Range) => (address ^ network) >> BigInt(128 - prefix) === 0n;

/** `Surfguard.blocked_address?(ip)` */
export function isBlockedAddress(address: Address): boolean {
  if (typeof address === "number") return isDisallowedIpv4(address);
  if (inIpv6Range(address, IPV4_MAPPED) || inIpv6Range(address, IPV4_COMPATIBLE) || inIpv6Range(address, NAT64_LOCAL_USE)) return true;
  if (inIpv6Range(address, NAT64_WELL_KNOWN) || inIpv6Range(address, IPV4_TRANSLATABLE)) return isDisallowedIpv4(Number(address & 0xffffffffn));
  return isDisallowedIpv6(address);
}

/** `disallowed_ipv4?`: `private?`, `loopback?` and `link_local?` are all inside the list. */
const isDisallowedIpv4 = (address: number) => DISALLOWED_IPV4.some((range) => inIpv4Range(address, range));

function isDisallowedIpv6(address: bigint): boolean {
  if (GLOBALLY_REACHABLE_IETF_ASSIGNMENTS.some((range) => inIpv6Range(address, range))) return false;
  if (inIpv6Range(address, UNIQUE_LOCAL) || address === LOOPBACK || inIpv6Range(address, LINK_LOCAL) || inIpv6Range(address, IETF_PROTOCOL_ASSIGNMENTS)) return true;
  if (DISALLOWED_IPV6.some((range) => inIpv6Range(address, range))) return true;
  return !IANA_ALLOCATED_IPV6_UNICAST.some((range) => inIpv6Range(address, range));
}
