// What a bot's reply is, by its content type, as Campfire's `Webhook#deliver` reads it with Net::HTTP
// and Rails' `Mime::Type.lookup`.

import { strip } from "@ember/richtext";

/** A file a bot replies with: its name and type, as Campfire uploads it. */
export interface ReplyFile {
  /** `"attachment.#{mime_type.symbol}"`: "attachment." for a type Rails hasn't registered. */
  filename: string;
  /** `mime_type.to_s`: the registered type, which for a synonym isn't the one sent. */
  contentType: string;
}

/**
 * `Net::HTTPHeader#content_type`: the media type a `Content-Type` header names, without its parameters,
 * as typed, or null without one.
 */
export function contentTypeOf(header: string | null): string | null {
  if (header === null) return null;
  const [main = "", sub] = header.split(";")[0]!.split("/");
  return sub === undefined ? strip(main) : `${strip(main)}/${strip(sub)}`;
}

/**
 * The file a reply of media type `type` becomes, as Rails' `Mime::Type.lookup` names it: a registered
 * type, by itself or a synonym, else a new one, which must be a valid media type, or null when it isn't,
 * where Rails raises `Mime::Type::InvalidMimeType`.
 */
export function replyFileOf(type: string): ReplyFile | null {
  const registered = MIME_LOOKUP.get(type);
  if (registered) return { filename: `attachment.${registered.symbol}`, contentType: registered.type };
  return MIME_REGEXP.test(type) ? { filename: "attachment.", contentType: type } : null;
}

/** `Mime::Type::MIME_REGEXP`. */
const MIME_NAME = String.raw`[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]{0,126}`;
const MIME_PARAMETER = String.raw` *; *${MIME_NAME}(?:=(?:${MIME_NAME}|"[^"\r\\]*"))?`;
const MIME_REGEXP = new RegExp(String.raw`^(?:\*\/\*|${MIME_NAME}\/(?:\*|${MIME_NAME})(?:${MIME_PARAMETER})*[ \t\n\v\f\r]*)$`);

/**
 * `Mime::LOOKUP` in Campfire: Action Dispatch's registrations and turbo-rails', each type or synonym
 * with its symbol and the type it's registered as.
 */
const MIME_LOOKUP = new Map(
  (
    [
      ["text/html", "html", "text/html"],
      ["application/xhtml+xml", "html", "text/html"],
      ["text/plain", "text", "text/plain"],
      ["text/javascript", "js", "text/javascript"],
      ["application/javascript", "js", "text/javascript"],
      ["application/x-javascript", "js", "text/javascript"],
      ["text/css", "css", "text/css"],
      ["text/calendar", "ics", "text/calendar"],
      ["text/csv", "csv", "text/csv"],
      ["text/vcard", "vcf", "text/vcard"],
      ["text/vtt", "vtt", "text/vtt"],
      ["vtt", "vtt", "text/vtt"],
      ["text/markdown", "md", "text/markdown"],
      ["image/png", "png", "image/png"],
      ["image/jpeg", "jpeg", "image/jpeg"],
      ["image/gif", "gif", "image/gif"],
      ["image/bmp", "bmp", "image/bmp"],
      ["image/tiff", "tiff", "image/tiff"],
      ["image/svg+xml", "svg", "image/svg+xml"],
      ["image/webp", "webp", "image/webp"],
      ["video/mpeg", "mpeg", "video/mpeg"],
      ["audio/mpeg", "mp3", "audio/mpeg"],
      ["audio/ogg", "ogg", "audio/ogg"],
      ["audio/aac", "m4a", "audio/aac"],
      ["audio/mp4", "m4a", "audio/aac"],
      ["video/webm", "webm", "video/webm"],
      ["video/mp4", "mp4", "video/mp4"],
      ["font/otf", "otf", "font/otf"],
      ["font/ttf", "ttf", "font/ttf"],
      ["font/woff", "woff", "font/woff"],
      ["font/woff2", "woff2", "font/woff2"],
      ["application/xml", "xml", "application/xml"],
      ["text/xml", "xml", "application/xml"],
      ["application/x-xml", "xml", "application/xml"],
      ["application/rss+xml", "rss", "application/rss+xml"],
      ["application/atom+xml", "atom", "application/atom+xml"],
      ["application/x-yaml", "yaml", "application/x-yaml"],
      ["text/yaml", "yaml", "application/x-yaml"],
      ["multipart/form-data", "multipart_form", "multipart/form-data"],
      ["application/x-www-form-urlencoded", "url_encoded_form", "application/x-www-form-urlencoded"],
      ["application/json", "json", "application/json"],
      ["text/x-json", "json", "application/json"],
      ["application/jsonrequest", "json", "application/json"],
      ["application/problem+json", "json", "application/json"],
      ["application/pdf", "pdf", "application/pdf"],
      ["application/zip", "zip", "application/zip"],
      ["application/gzip", "gzip", "application/gzip"],
      ["application/x-gzip", "gzip", "application/gzip"],
      ["text/vnd.turbo-stream.html", "turbo_stream", "text/vnd.turbo-stream.html"],
    ] as const
  ).map(([string, symbol, type]) => [string as string, { symbol, type }]),
);
