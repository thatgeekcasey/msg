import type { LinkPreview } from "@ember/protocol";
import { describe, expect, it } from "vitest";
import { unfurl } from "../src/unfurl";
import type { Network } from "../src/unfurl/fetch";
import recorded from "./fixtures/opengraph_cases.json";
import answers from "./fixtures/opengraph_expected.json";

// Replays the link previews recorded from Campfire (fixtures/README.md) on a fake Internet: each host's
// DNS answers, and a server at the public ones that answers the recorded routes and 404s anything else.
// Each preview, and the requests the server saw, must match the recording, except where Ember differs on
// purpose (`DIFFERENCES`). DNS lookups aren't compared: this looks each host up once per preview, where
// Campfire looks it up for every request.

interface Route {
  method: string;
  host: string;
  path: string;
  status: number;
  headers: [string, string][];
  body?: string;
  body_b64?: string;
  body_repeat?: [string, number];
  pad_to?: number;
  chunked?: boolean;
  gzip?: boolean;
}

interface Answer {
  name: string;
  url: string;
  response: { status: number; body?: string; error?: string };
  /** Each request's method, Host, target, Accept, Accept-Encoding and User-Agent. */
  requests: (string | null)[][];
}

const routes = recorded.routes as Route[];
const hosts = recorded.hosts as Record<string, string[][]>;

/** The X post's tags, which Campfire reads without a meta charset and so drops their non-ASCII characters from. */
const POST = { title: "DHH 😀 “quoted”", description: "tweet é" };

const DIFFERENCES: Record<string, { why: string; preview: Partial<LinkPreview> | null; requests?: [] }> = {
  "entities are escaped": {
    why: "Titles and descriptions are plain text rather than HTML, and keep their non-ASCII characters without a meta charset.",
    preview: { title: "Tom & Jerry <3 \u00a0x", description: "a > b " },
  },
  "non-ascii stripped without meta charset": {
    why: "Pages keep their non-ASCII characters without a meta charset.",
    preview: { title: "Café 😀 ok", description: "naïve é é x" },
  },
  twitter: { why: "As above.", preview: POST },
  "x.com": { why: "As above.", preview: POST },
  "www.x.com": { why: "As above.", preview: POST },
  "mixed dns answers use the public one": {
    why: "A Worker's fetch connects by name, so it can't be pinned to the public answer: a host must resolve only to public addresses.",
    preview: null,
    requests: [],
  },
  "mailto raises": { why: "Where Campfire fails with 500, there's no preview.", preview: null },
  "fxtwitter failure raises": { why: "As above.", preview: null },
};
// "dns rebinding is pinned" and "dns rebinding after redirect is pinned" pass because the second,
// private answer is never asked for: each host is looked up once per preview. A Worker's fetch looks
// the name up again for itself, so in production they show only that.

/** The recorded Internet, recording the method, Host, target and Accept of each request its server answers. */
class RecordedInternet implements Network {
  readonly requests: (string | null)[][] = [];
  /** A host with several answer lists gives the next one each time it's looked up, then keeps giving the last. */
  private readonly answers = new Map(Object.entries(hosts).map(([host, lists]) => [host, [...lists]]));

  async resolve(host: string): Promise<string[]> {
    const lists = this.answers.get(host);
    if (!lists) throw new Error(`No address for ${host}`);
    return lists.length > 1 ? lists.shift()! : lists[0]!;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target = `${url.pathname}${url.search}`;
    this.requests.push([request.method, url.host, target, request.headers.get("Accept")]);
    const route = routes.find((r) => r.method === request.method && (r.host === url.hostname || r.host === "*") && r.path === target);
    if (!route) return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
    return respond(route, request.method);
  }
}

/** A route's response, as a Worker's fetch would give it: a gzipped body comes decompressed, with the Content-Length that was sent. */
async function respond(route: Route, method: string): Promise<Response> {
  const body = bodyOf(route);
  const headers = new Headers(route.headers);
  if (route.gzip) headers.set("Content-Encoding", "gzip");
  if (!route.chunked && !headers.has("Content-Length")) headers.set("Content-Length", String((route.gzip ? await gzip(body) : body).length));
  const bodyless = method === "HEAD" || route.status === 204 || route.status === 304;
  return new Response(bodyless ? null : body, { status: route.status, headers });
}

function bodyOf(route: Route): Uint8Array {
  const body =
    route.body_b64 !== undefined
      ? Uint8Array.from(atob(route.body_b64), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(route.body_repeat ? route.body_repeat[0].repeat(route.body_repeat[1]) : (route.body ?? ""));
  if (route.pad_to === undefined) return body;
  // Padded with spaces, or cut, to exactly `pad_to` bytes.
  const padded = new Uint8Array(route.pad_to).fill(0x20);
  padded.set(body.subarray(0, route.pad_to));
  return padded;
}

const gzip = async (body: Uint8Array) => new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

/** The preview Campfire answered: a 200's JSON without Rails' validation fields, else none. */
function recordedPreview(answer: Answer): LinkPreview | null {
  if (answer.response.status !== 200) return null;
  const { title, url, image, description } = JSON.parse(answer.response.body!) as LinkPreview;
  return { title, url, image, description };
}

describe("Link preview lookup", () => {
  it("replays every recorded case", () => {
    expect(recorded.cases.map((c) => c.name)).toEqual((answers as Answer[]).map((a) => a.name));
    expect(recorded.cases).toHaveLength(90);
    for (const name of Object.keys(DIFFERENCES)) expect(recorded.cases.map((c) => c.name)).toContain(name);
  });

  it.each(answers as Answer[])("$name", async (answer) => {
    const internet = new RecordedInternet();
    const difference = DIFFERENCES[answer.name];
    const expected = difference ? difference.preview && { ...recordedPreview(answer)!, ...difference.preview } : recordedPreview(answer);

    expect(await unfurl(answer.url, internet)).toEqual(expected);
    expect(internet.requests).toEqual(difference?.requests ?? answer.requests.map((request) => request.slice(0, 4)));
  });
});
