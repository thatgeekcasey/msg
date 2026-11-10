import { qrCodeSvg } from "@ember/protocol/qr-code";
import { authenticate } from "./auth";
import { urlsafeDecode64 } from "./encoding";
import type { Env } from "./env";
import { notFound } from "./error-pages";
import { signInFirst } from "./pages";
import { urlOf } from "./request-url";

// Campfire's QR codes, drawn as rqrcode draws them (packages/protocol/src/qr-code.ts).

/** Campfire's `expires_in 1.year`, for the browser alone, since only someone signed in gets one. */
const CACHE_CONTROL = "private, max-age=31556952";

/** Rails' `/qr_code/:id(.:format)`, whose id can't hold "/", "." or "?". */
const ROUTE = /^\/qr_code\/([^/.?]+)(?:\.[^/.?]+)?$/;

/**
 * `GET /qr_code/<id>`: the QR code of whatever text the id holds as URL-safe base64, for anyone signed
 * in. Campfire draws one for anyone at all, but a deployment shouldn't draw a stranger's text, a
 * phishing link say, under its own address, and the app shows QR codes only on signed-in pages; someone
 * signed out is sent to sign in, as they are for an avatar. Malformed base64 answers 400, since the
 * mistake is the client's, and text that doesn't fit the largest QR code answers 422, as there.
 */
export async function showQrCode(request: Request, env: Env): Promise<Response> {
  const id = urlOf(request).pathname.match(ROUTE)?.[1];
  if (!id || (request.method !== "GET" && request.method !== "HEAD")) return notFound(request);
  if (!(await authenticate(request, env))) return signInFirst(request);
  const segment = percentDecoded(id);
  const text = segment === null ? null : urlsafeDecode64(segment);
  if (!text) return new Response(null, { status: 400 });
  const svg = qrCodeSvg(text);
  if (svg === null) return new Response(null, { status: 422 });
  return new Response(request.method === "HEAD" ? null : svg, {
    headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": CACHE_CONTROL },
  });
}

/** A path segment as Rails reads it, or null if its percent-encoding is malformed. */
function percentDecoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
