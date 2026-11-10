import { describe, expect, it } from "vitest";
import { isBlockedAddress, parseAddress } from "../src/unfurl/addresses";
import { checkHost, GuardError, resolveOverHttps } from "../src/unfurl/guard";

/** Addresses a preview never fetches. */
const BLOCKED = [
  "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "168.63.129.16", "169.254.169.254", "172.16.0.0", "172.31.255.255",
  "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1",
  "255.255.255.255", "::", "::1", "::ffff:192.168.1.1", "::ffff:8.8.8.8", "::8.8.8.8", "64:ff9b::a00:1", "64:ff9b:1::1",
  "::ffff:0:a00:1", "fc00::1", "fd00::1", "fe80::1", "fec0::1", "ff02::1", "2001::1", "2001:db8::1", "2002::1", "3fff::1",
  "5f00::1", "100::1", "2001:2::1", "4000::1", "2001:10::1",
];
const PUBLIC = [
  "8.8.8.8", "1.1.1.1", "93.184.216.34", "142.250.185.206", "172.32.0.1", "100.128.0.1", "192.0.1.1",
  "2606:2800:220:1:248:1893:25c8:1946", "2a00:1450:4001:82a::200e", "2001:3::1", "2001:4:112::1", "64:ff9b::808:808",
  "::ffff:0:808:808", "2c0f:ffff::1",
];

/** A resolver with fixed answers that records what it's asked. */
function resolverOf(answers: Record<string, string[]>) {
  const lookups: string[] = [];
  const resolve = async (host: string) => {
    lookups.push(host);
    const found = answers[host];
    if (!found) throw new Error(`No address for ${host}`);
    return found;
  };
  return { lookups, resolve };
}

describe("Link preview safety limits", () => {
  it("classifies addresses as Surfguard does", () => {
    for (const ip of BLOCKED) expect(isBlockedAddress(parseAddress(ip)!), ip).toBe(true);
    for (const ip of PUBLIC) expect(isBlockedAddress(parseAddress(ip)!), ip).toBe(false);
  });

  it("reads addresses as Rust's parsers do", () => {
    expect(parseAddress("93.184.216.34")).toBe(0x5db8d822);
    expect(parseAddress("::ffff:10.0.0.1")).toBe(0xffff0a000001n);
    expect(parseAddress("2001:db8::8:800:200c:417a")).toBe(0x20010db8_00000000_00080800_200c417an);
    for (const text of ["", "1.2.3", "01.2.3.4", "256.0.0.1", "1.2.3.4.5", ":::1", "1::2::3", "1:2:3:4:5:6:7:8:9", "::1.2.3", "1.2.3.4::", "::g", "[::1]"]) {
      expect(parseAddress(text), text).toBeNull();
    }
  });

  it("looks up plain names, and refuses addresses and malformed names without asking", async () => {
    const { lookups, resolve } = resolverOf({
      "www.example.com": ["93.184.216.34"],
      "WWW.Example.COM.": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
      "private.example": ["192.168.1.10"],
      "mapped.example": ["::ffff:10.0.0.1"],
    });
    await expect(checkHost("www.example.com", resolve)).resolves.toBeUndefined();
    await expect(checkHost("WWW.Example.COM.", resolve)).resolves.toBeUndefined();
    await expect(checkHost("private.example", resolve)).rejects.toThrow(new GuardError("Attempt to access private IP via private.example"));
    await expect(checkHost("mapped.example", resolve)).rejects.toThrow(new GuardError("Attempt to access private IP via mapped.example"));
    await expect(checkHost("nowhere.example", resolve)).rejects.toThrow(new GuardError("Host could not be resolved"));
    // A Worker can't fetch an address, so a host written as one is refused, even a public one such as 8.8.8.8.
    const addresses = ["8.8.8.8", "[2606:2800:220:1:248:1893:25c8:1946]", "127.0.0.1", "[::1]", "::1", "[fd00::1]", "[v1.x]"];
    // Every shape `inet_aton` might read as an address, valid or not.
    const numeric = ["0x7f.1", "2130706433", "127.1", "0177.0.0.01", "10.0.258", "09.1.1.1", "256.1.1.1", "1.2.3.4.", "01.2.3.4."];
    const malformed = ["under_score.example", "", "a..b", "host%eth0", "exämple.com", "-lead.example", "trail-.example", `${"a".repeat(64)}.example`];
    for (const host of [...addresses, ...numeric, ...malformed]) {
      await expect(checkHost(host, resolve), host).rejects.toThrow(new GuardError(`Attempt to access private IP via ${host}`));
    }
    expect(lookups).toEqual(["www.example.com", "WWW.Example.COM.", "private.example", "mapped.example", "nowhere.example"]);
  });

  it("refuses a name with any private answer, since a Worker's fetch can't be pinned to a public one", async () => {
    const { resolve } = resolverOf({ "mixed.example": ["93.184.216.39", "2606:2800:220:1:248:1893:25c8:1946", "10.0.0.1"] });
    await expect(checkHost("mixed.example", resolve)).rejects.toThrow(new GuardError("Attempt to access private IP via mixed.example"));
  });

  it("takes names of up to 255 characters and up to 256 answers", async () => {
    const longest = [..."abcd"].map((letter) => letter.repeat(63)).join(".");
    const many = Array.from({ length: 256 }, (_, i) => `93.184.${i >> 8}.${i & 0xff}`);
    const { resolve } = resolverOf({ [longest]: ["93.184.216.34"], "many.example": many, "more.example": [...many, "93.184.216.34"], "none.example": [] });
    expect(longest).toHaveLength(255);
    await expect(checkHost(longest, resolve)).resolves.toBeUndefined();
    await expect(checkHost(`${longest}.`, resolve)).rejects.toThrow(GuardError);
    await expect(checkHost("many.example", resolve)).resolves.toBeUndefined();
    await expect(checkHost("more.example", resolve)).rejects.toThrow(new GuardError("Host could not be resolved"));
    await expect(checkHost("none.example", resolve)).rejects.toThrow(new GuardError("Host could not be resolved"));
  });

  it("asks Cloudflare's DNS over HTTPS for a name's A and AAAA records", async () => {
    const asked: string[] = [];
    const answer = (type: string | null) =>
      type === "A" ? [{ type: 5, data: "alias.example." }, { type: 1, data: "93.184.216.34" }] : [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }];
    const doh = async (request: Request) => {
      asked.push(`${request.url} ${request.headers.get("Accept")}`);
      return Response.json({ Status: 0, Answer: answer(new URL(request.url).searchParams.get("type")) });
    };
    expect(await resolveOverHttps("www.example.com", doh)).toEqual(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
    expect(asked).toEqual([
      "https://cloudflare-dns.com/dns-query?name=www.example.com&type=A application/dns-json",
      "https://cloudflare-dns.com/dns-query?name=www.example.com&type=AAAA application/dns-json",
    ]);
  });

  it("finds no addresses for a name that doesn't exist, and fails when the resolver does", async () => {
    const answering = (status: number, body: unknown) => async () => Response.json(body, { status });
    expect(await resolveOverHttps("nowhere.example", answering(200, { Status: 3 }))).toEqual([]);
    expect(await resolveOverHttps("empty.example", answering(200, { Status: 0 }))).toEqual([]);
    await expect(resolveOverHttps("broken.example", answering(200, { Status: 2 }))).rejects.toThrow("rcode 2");
    await expect(resolveOverHttps("down.example", answering(503, {}))).rejects.toThrow("503");
  });
});
