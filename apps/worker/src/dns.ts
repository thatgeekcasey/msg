// Looking names up with Cloudflare's DNS over HTTPS, in its JSON form
// (https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/), as
// unfurling resolves a link's host, Set up email checks a domain Cloudflare Email Service sends from, and
// the Custom domain card finds where a domain's DNS is.

/** Cloudflare's DNS over HTTPS, which `node:dns` also uses in a Worker. */
const DNS_OVER_HTTPS = "https://cloudflare-dns.com/dns-query";
/** The types of record Ember looks up, by the numbers its answers give them. */
const RECORD_TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28 } as const;
const NOERROR = 0;
const NXDOMAIN = 3;
/** The most names `zoneOf` asks about, going up past names that are aliases. */
const MAX_ZONE_LOOKUPS = 3;

/** A type of record Ember looks up. */
export type RecordType = keyof typeof RECORD_TYPES;

/** What asks Cloudflare's resolver: the Worker's own `fetch`, with a signal, or a test's stand-in. */
export type DnsFetch = (request: Request) => Promise<Response>;

interface DnsRecord {
  name: string;
  type: number;
  data: string;
}

interface DnsJson {
  Status: number;
  Answer?: DnsRecord[];
  /** The SOA record of the zone that says a name has no records of the type asked for, or doesn't exist. */
  Authority?: DnsRecord[];
}

/**
 * What the resolver says of `name`'s records of `type`, asked through `fetch`: one subrequest. An error
 * is thrown when the resolver doesn't answer, or fails to look the name up.
 */
async function ask(name: string, type: RecordType, fetch: DnsFetch): Promise<DnsJson> {
  const query = `${DNS_OVER_HTTPS}?name=${encodeURIComponent(name)}&type=${type}`;
  const response = await fetch(new Request(query, { headers: { Accept: "application/dns-json" } }));
  if (!response.ok) throw new Error(`DNS over HTTPS answered ${response.status}`);
  const answer = await response.json<DnsJson>();
  if (answer.Status !== NOERROR && answer.Status !== NXDOMAIN) throw new Error(`DNS over HTTPS answered rcode ${answer.Status}`);
  return answer;
}

/**
 * The data of `name`'s records of `type`, as the resolver writes them, asked through `fetch`: one
 * subrequest. None for a name that doesn't exist, and an error thrown when the resolver doesn't answer.
 */
export async function lookUp(name: string, type: RecordType, fetch: DnsFetch): Promise<string[]> {
  const { Status, Answer = [] } = await ask(name, type, fetch);
  if (Status === NXDOMAIN) return [];
  return Answer.filter((record) => record.type === RECORD_TYPES[type]).map((record) => record.data);
}

/**
 * The zone `name` is in, as the SOA record the resolver gives with its answer names it, asked through
 * `fetch`: one subrequest, and one more for each alias (CNAME) it goes up past, as an alias's answer
 * holds its target's SOA, up to `MAX_ZONE_LOOKUPS`. Null for a name a top-level domain's own zone
 * holds, as one nobody registered is, and an error thrown when the resolver doesn't answer.
 */
export async function zoneOf(name: string, fetch: DnsFetch): Promise<string | null> {
  let asked = name;
  for (let lookups = 0; lookups < MAX_ZONE_LOOKUPS && asked.includes("."); lookups++) {
    const { Answer = [], Authority = [] } = await ask(asked, "SOA", fetch);
    if (Answer.some((record) => record.type === RECORD_TYPES.CNAME)) {
      asked = asked.slice(asked.indexOf(".") + 1);
      continue;
    }
    const zone = [...Answer, ...Authority].find((record) => record.type === RECORD_TYPES.SOA)?.name.replace(/\.$/, "").toLowerCase();
    return zone?.includes(".") ? zone : null;
  }
  return null;
}
