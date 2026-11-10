import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOnHost, unfurl } from "../src/unfurl";
import { MAX_BODY_SIZE, USER_AGENT, type Network } from "../src/unfurl/fetch";
import { api, origin, signIn } from "./support";

const PAGE =
  '<meta property="og:url" content="https://example.com"><meta property="og:title" content="Hey!"><meta property="og:description" content="desc.."><meta property="og:image" content="http://example.com/image.png">';
const PREVIEW = { title: "Hey!", url: "https://example.com", image: "http://example.com/image.png", description: "desc.." };

const html = (body: BodyInit | null, headers: Record<string, string> = {}) => new Response(body, { headers: { "Content-Type": "text/html", ...headers } });
const image = () => new Response(null, { headers: { "Content-Type": "image/png" } });

/** A fake Internet where every name is at one public address and `answer` answers every request. */
function internetOf(answer: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const lookups: string[] = [];
  const network: Network = {
    resolve: async (host) => {
      lookups.push(host);
      return ["93.184.216.34"];
    },
    fetch: async (request) => {
      requests.push(request);
      return answer(request);
    },
  };
  return { network, requests, lookups };
}

/** PAGE at http://www.example.com/, then `rest` until the reader stops or the request is aborted. */
function streamedPage(request: Request, rest: (controller: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>) {
  const state = { sent: 0, stopped: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(PAGE));
      request.signal.addEventListener("abort", () => {
        state.stopped = true;
        controller.error(request.signal.reason);
      });
    },
    async pull(controller) {
      if (!state.stopped) await rest(controller);
    },
    cancel() {
      state.stopped = true;
    },
  });
  return { state, response: html(body) };
}

const unfurlRequest = (url: unknown, cookie: string) => api("/api/unfurl", { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ url }) });

describe("Link preview lookup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers a page's preview, read by a Durable Object over the Internet", async () => {
    const fetched: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      fetched.push(`${request.method} ${request.url}`);
      const url = new URL(request.url);
      if (url.hostname === "cloudflare-dns.com") {
        const answer = url.searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.216.34" }] : [];
        return Response.json({ Status: 0, Answer: answer });
      }
      if (request.url === "http://www.example.com/") return html(PAGE);
      if (request.url === "http://example.com/image.png") return image();
      return new Response("not found", { status: 404 });
    });
    const { cookie } = await signIn("Ada");
    const response = await unfurlRequest("http://www.example.com/", cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PREVIEW);
    expect(fetched).toEqual([
      "GET https://cloudflare-dns.com/dns-query?name=www.example.com&type=A",
      "GET https://cloudflare-dns.com/dns-query?name=www.example.com&type=AAAA",
      "GET http://www.example.com/",
      "GET https://cloudflare-dns.com/dns-query?name=example.com&type=A",
      "GET https://cloudflare-dns.com/dns-query?name=example.com&type=AAAA",
      "HEAD http://example.com/image.png",
    ]);
  });

  it("answers 204 for a private address, or this Ember's own pages, without fetching them", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const { cookie } = await signIn("Ada");
    for (const url of ["http://127.0.0.1/secret", "http://[::1]/", "http://2130706433/", `${origin}/rooms/1`, "HTTPS://EMBER.TEST./"]) {
      expect((await unfurlRequest(url, cookie)).status, url).toBe(204);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("knows a link on one of Ember's hosts, at any port, as @ember's answers leave its preview out", () => {
    const hosts = ["chat.example.com", "ember.example.workers.dev", "localhost:8787"];
    for (const url of ["https://chat.example.com/rooms/1", "HTTPS://Chat.Example.com.:8443/", "https://ember.example.workers.dev/", "http://localhost/x"]) {
      expect(isOnHost(url, hosts), url).toBe(true);
    }
    for (const url of ["https://example.com/", "https://chat.example.com.example.net/", "https://example.net/chat.example.com", "https://localhost.example/"]) {
      expect(isOnHost(url, hosts), url).toBe(false);
    }
  });

  it("needs a session", async () => {
    const response = await api("/api/unfurl", { method: "POST", body: JSON.stringify({ url: "http://www.example.com/" }) });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not signed in" });
  });

  it("refuses requests from other sites", async () => {
    const { cookie } = await signIn("Ada");
    const forged = await exports.default.fetch(`${origin}/api/unfurl`, {
      method: "POST",
      headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" },
      body: JSON.stringify({ url: "http://www.example.com/" }),
    });
    expect(forged.status).toBe(422);
  });

  it("answers 400 for a missing or blank url, as Rails' params.require does", async () => {
    const { cookie } = await signIn("Ada");
    const bodies = ["{}", '{"url":null}', '{"url":""}', '{"url":" \\u3000\\n"}', '{"url":[]}', '{"url":[null]}', '{"url":{}}', "[]", "null", "url=x"];
    for (const body of bodies) {
      const response = await api("/api/unfurl", { method: "POST", headers: { Cookie: cookie }, body });
      expect(response.status, body).toBe(400);
      expect(await response.json()).toEqual({ error: "param is missing or the value is empty: url" });
    }
  });

  it("answers 204 for a url that's sent but isn't a string, such as a hash or an array", async () => {
    const { cookie } = await signIn("Ada");
    for (const url of [{ a: "http://www.example.com/" }, ["http://www.example.com/"], false, 0]) {
      expect((await unfurlRequest(url, cookie)).status, JSON.stringify(url)).toBe(204);
    }
  });

  it("reads X and Twitter posts through fxtwitter.com, whatever the case of their host", async () => {
    for (const url of ["https://X.com/dhh/status/1", "https://WWW.Twitter.COM/dhh/status/1"]) {
      const { network, requests } = internetOf((request) => (request.method === "HEAD" ? image() : html(PAGE)));
      expect(await unfurl(url, network), url).toEqual(PREVIEW);
      expect(requests[0]!.url, url).toBe("https://fxtwitter.com/dhh/status/1");
    }
  });

  it("lets each person ask for 30 previews a minute", async () => {
    const [ada, bob] = await Promise.all([signIn("Ada"), signIn("Bob")]);
    for (let i = 0; i < 30; i++) expect((await unfurlRequest("http://127.0.0.1/", ada.cookie)).status).toBe(204);
    const limited = await unfurlRequest("http://127.0.0.1/", ada.cookie);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Too many link previews. Try again in a minute." });
    expect((await unfurlRequest("http://127.0.0.1/", bob.cookie)).status).toBe(204);
  });
});

describe("Link preview safety limits", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks for any type, as a bot, following redirects itself", async () => {
    const { network, requests } = internetOf((request) => (request.method === "HEAD" ? image() : html(PAGE)));
    expect(await unfurl("http://www.example.com/", network)).toEqual(PREVIEW);
    expect(USER_AGENT).toMatch(/bot/i);
    for (const request of requests) {
      expect([...request.headers]).toEqual([["accept", "*/*"], ["user-agent", USER_AGENT]]);
      expect(request.redirect).toBe("manual");
    }
  });

  it("doesn't read a page whose Content-Length is over 5 MiB", async () => {
    const page = (length: number) => internetOf((request) => (request.method === "HEAD" ? image() : html(PAGE, { "Content-Length": String(length) }))).network;
    expect(await unfurl("http://www.example.com/", page(MAX_BODY_SIZE + 1))).toBeNull();
    expect(await unfurl("http://www.example.com/", page(MAX_BODY_SIZE))).toEqual(PREVIEW);
  });

  it("reads a page's Content-Type in a moment, however long a run of spaces it holds", async () => {
    const spaces = " ".repeat(300_000);
    const page = (type: string) => internetOf((request) => (request.method === "HEAD" ? image() : html(PAGE, { "Content-Type": type }))).network;
    const started = Date.now();
    expect(await unfurl("http://www.example.com/", page(`text/ht${spaces}ml`))).toBeNull();
    expect(await unfurl("http://www.example.com/", page(`text/${spaces}html${spaces}`))).toEqual(PREVIEW);
    // A pattern for the spaces at a part's end would try to end each run inside it there: some 12 seconds for the first.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  // A gzip bomb: a Worker's fetch decompresses as it's read.
  it("stops reading a page once it's past 5 MiB", async () => {
    let page: ReturnType<typeof streamedPage> | undefined;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const { network } = internetOf((request) => {
      page = streamedPage(request, (controller) => {
        page!.state.sent += chunk.length;
        controller.enqueue(chunk);
      });
      return page.response;
    });
    expect(await unfurl("http://www.example.com/", network)).toBeNull();
    expect(page!.state.stopped).toBe(true);
    expect(page!.state.sent).toBeLessThan(MAX_BODY_SIZE + 2 * chunk.length);
  });

  // A byte every 50 ms never trips the 5-second wait for a read.
  it("gives up on a page that trickles in, and stops reading it", async () => {
    let page: ReturnType<typeof streamedPage> | undefined;
    const { network } = internetOf((request) => {
      page = streamedPage(request, async (controller) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        controller.enqueue(new Uint8Array([0x20]));
      });
      return page.response;
    });
    const started = Date.now();
    expect(await unfurl("http://www.example.com/", network, 500)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(page!.state.stopped).toBe(true);
  });

  it("gives up on a server that never answers", async () => {
    const { network } = internetOf((request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason))));
    const started = Date.now();
    expect(await unfurl("http://www.example.com/", network, 300)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("names a link it can't read in its logs by its host alone, as its path and query can hold what someone wrote", async () => {
    const logged = [vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
    const link = "http://www.example.com/plans/private?token=hunter2";
    expect(await unfurl(link, internetOf(() => Promise.reject(new Error("Network connection lost."))).network)).toBeNull();
    expect(await unfurl(link, internetOf((request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason)))).network, 300)).toBeNull();
    const lines = logged.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" ")));
    expect(lines).toContainEqual(expect.stringContaining("Failed to fetch from www.example.com (Network connection lost.)"));
    expect(lines).toContainEqual(expect.stringContaining("Gave up unfurling a link to www.example.com"));
    expect(lines.join("\n")).not.toMatch(/plans|private|hunter2/);
  });

  it("makes at most 45 subrequests, of the 50 a request gets on Workers Free", async () => {
    // Ten hosts redirect to the page, whose og:url is an eleventh, and whose image redirects through ten more.
    const { network, requests, lookups } = internetOf((request) => {
      const { hostname, pathname } = new URL(request.url);
      const [, kind, hop] = /^(page|image)(\d+)\./.exec(hostname)!;
      const next = Number(hop) + 1;
      if (kind === "page" && next < 10) return new Response(null, { status: 302, headers: { Location: `http://page${next}.example${pathname}` } });
      if (kind === "image" && next < 10) return new Response(null, { status: 302, headers: { Location: `http://image${next}.example/i.png` } });
      if (kind === "image") return image();
      return html('<meta property="og:title" content="Far"><meta property="og:description" content="d"><meta property="og:url" content="http://page10.example/"><meta property="og:image" content="http://image0.example/i.png">');
    });
    expect(await unfurl("http://page0.example/", network)).toEqual({ title: "Far", url: "http://page10.example/", image: null, description: "d" });
    // Each lookup is two subrequests: an A and an AAAA query.
    expect(requests.length + 2 * lookups.length).toBeLessThanOrEqual(45);
    expect(lookups).toContain("image3.example");
    expect(lookups).not.toContain("image4.example");
  });
});
