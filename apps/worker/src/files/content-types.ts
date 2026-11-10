import { BINARY } from "./marcel";

// How a file's type decides the way it's served, as Active Storage's `content_types_allowed_inline` and
// `content_types_to_serve_as_binary` do under Rails 8.2's defaults.

/** `content_types_allowed_inline`: the only types a browser is ever asked to show rather than download. */
const ALLOWED_INLINE = new Set([
  "image/webp",
  "image/avif",
  "image/png",
  "image/gif",
  "image/jpeg",
  "image/tiff",
  "image/bmp",
  "image/vnd.adobe.photoshop",
  "image/vnd.microsoft.icon",
  "application/pdf",
]);

/** `content_types_to_serve_as_binary`: types a browser could run script in, which go as the binary type. */
const SERVE_AS_BINARY = new Set([
  "text/html",
  "image/svg+xml",
  "application/postscript",
  "application/x-shockwave-flash",
  "text/xml",
  "application/xml",
  "application/xhtml+xml",
  "application/mathml+xml",
  "text/cache-manifest",
]);

/** `content_type_for_serving`. */
export const typeForServing = (contentType: string) => (SERVE_AS_BINARY.has(contentType) ? BINARY : contentType);

/** `forced_disposition_for_serving`: "attachment" for a type served as binary or not allowed inline, which no link can show. */
export const forcedDisposition = (contentType: string) =>
  SERVE_AS_BINARY.has(contentType) || !ALLOWED_INLINE.has(contentType) ? "attachment" : null;
