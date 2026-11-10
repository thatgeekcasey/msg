import { toHex } from "./encoding";

// ETags as Rack::ETag makes them: weak, from the first 128 bits of the body's SHA-256 in hex. A request
// whose If-None-Match lists the ETag, or `*`, gets 304 Not Modified with no body instead, as `is_fresh`
// decides there.

const encoder = new TextEncoder();

/** The ETag of a body that reads `body`, or is its bytes. */
export async function etagOf(body: string | Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", typeof body === "string" ? encoder.encode(body) : body));
  return `W/"${toHex(digest.subarray(0, 16))}"`;
}

/** Whether the request's If-None-Match lists `etag`, so the copy it has is current. */
export function isFresh(request: Request, etag: string): boolean {
  const listed = request.headers.get("If-None-Match")?.split(",") ?? [];
  return listed.some((tag) => tag.trim() === etag || tag.trim() === "*");
}

/** `data` as JSON with its ETag, or 304 Not Modified when the request's If-None-Match lists it. */
export async function jsonWithETag(request: Request, data: unknown, headers: HeadersInit = {}): Promise<Response> {
  const text = JSON.stringify(data);
  const etag = await etagOf(text);
  const answer = new Headers(headers);
  answer.set("ETag", etag);
  if (isFresh(request, etag)) return new Response(null, { status: 304, headers: answer });
  answer.set("Content-Type", "application/json");
  return new Response(text, { headers: answer });
}
