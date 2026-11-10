// The rich text corpus (corpus/README.md), and how to read it as Rails did: which users its SGIDs name,
// what Campfire's mention partial renders, and how Ember's rendering deliberately differs from what
// Rails rendered.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { MentionUser } from "../attachments";
import { userIdFromSgid } from "../mentions";
import { htmlEscape } from "../ruby";
import { testUserId } from "./users";

export type Outcome<T> = { ok: T } | { error: string; message: string };

/** A corpus user, with the id Ember would know them by, and the id Rails knew them by. */
export interface CorpusUser extends MentionUser {
  railsId: number;
  key: string;
  title: string;
  attachable_sgid: string;
  user_path: string;
  avatar_path: string;
}

export interface CorpusCase {
  name: string;
  host: string;
  body: string;
  presentation: Outcome<string>;
  presentation_raised: string | null;
  presentation_raised_message: string | null;
  plain_text: Outcome<string>;
  mentioned: Outcome<number[]>;
  filtered: Outcome<string>;
}

interface Corpus {
  users: (Omit<CorpusUser, "id" | "railsId"> & { id: number })[];
  rooms: number[];
  signed: { sgid: string; model: string; id: number; exists: boolean }[];
  cases: CorpusCase[];
}

export const corpus = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../corpus/expected.json"), "utf8")) as Corpus;

const users = new Map(corpus.users.map((user): [number, CorpusUser] => [user.id, { ...user, id: testUserId(user.id), railsId: user.id }]));
const usersByEmberId = new Map([...users.values()].map((user) => [user.id, user]));

/** Something Rails raised, which `message_presentation` rescues to show nothing. */
export class RailsError extends Error {}

/** Raised with a message that isn't UTF-8, so logging the rescue raises again: unrenderable. */
export class UnloggableRailsError extends RailsError {}

/** `GlobalID::Locator.locate_signed(sgid, for: "attachable")`: the SGIDs Rails minted, by exact match. */
export function verifiedUser(sgid: string): CorpusUser | undefined {
  const signed = corpus.signed.find((record) => record.sgid === sgid);
  return signed?.exists && signed.model === "User" ? users.get(signed.id) : undefined;
}

/**
 * How Campfire's `ActionText::Attachment.from_node` finds a user: from a possibly expired or
 * tampered SGID first (raising as Ruby does on what it can't decode), then a verified one.
 */
export function railsUser(sgid: string): CorpusUser | undefined {
  return userFromPossiblyExpiredSgid(sgid) ?? verifiedUser(sgid);
}

/** Campfire's `attachable_from_possibly_expired_sgid` (lib/rails_ext/action_text_attachables.rb) */
function userFromPossiblyExpiredSgid(sgid: string): CorpusUser | undefined {
  // `sgid.split("--").first`: Ruby drops trailing empty fields, so "" and "--" have no first
  const fields = sgid.split("--");
  while (fields.at(-1) === "") fields.pop();
  if (fields[0] === undefined) return undefined;
  const json = rubyJsonParse(decodeBase64(fields[0]));
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new RailsError("NoMethodError: dig");
  const rails = (json as Record<string, unknown>)._rails;
  if (rails === undefined || rails === null) return undefined;
  if (typeof rails !== "object" || Array.isArray(rails)) throw new RailsError("TypeError: dig");
  const { data, message } = rails as Record<string, unknown>;
  const truthy = (value: unknown) => value !== undefined && value !== null && value !== false;
  let gid: string | undefined;
  if (truthy(data)) {
    gid = typeof data === "string" ? data : undefined;
  } else if (truthy(message)) {
    // Rails 7 Marshal-dumped the GID, which is matched out of the dump's bytes
    if (typeof message !== "string") throw new RailsError("NoMethodError: unpack1");
    gid = /gid:\/\/campfire\/[^/]+\/[0-9]+/.exec(Buffer.from(decodeBase64(message)).toString("latin1"))?.[0];
  }
  return gid === undefined ? undefined : findGid(gid);
}

/** `GlobalID.find(gid)`, whose default locator ignores the app name. */
function findGid(gid: string): CorpusUser | undefined {
  if (!gid.startsWith("gid://") || !/^[\x00-\x7f]*$/.test(gid)) return undefined;
  const rest = gid.slice("gid://".length);
  const path = rest.slice(rest.indexOf("/") + 1).split("?")[0]!;
  if (!rest.includes("/") || !path.includes("/")) return undefined;
  const model = path.slice(0, path.indexOf("/"));
  const id = path.slice(path.indexOf("/") + 1);
  if (!/^[+-]?[0-9]+$/.test(id)) return undefined;
  return model === "User" ? users.get(Number(id)) : undefined;
}

/** `Base64.strict_decode64(message) rescue Base64.urlsafe_decode64(message)` */
function decodeBase64(message: string): Uint8Array {
  const decoded = strictDecode64(message) ?? urlsafeDecode64(message);
  if (!decoded) throw new RailsError("ArgumentError: invalid base64");
  return decoded;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Padded, in the standard alphabet, and with no stray bits in the last character. */
function strictDecode64(encoded: string): Uint8Array | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const last = BASE64_ALPHABET.indexOf(encoded[encoded.length - padding - 1] ?? "A");
  if (padding === 2 && (last & 0x0f) !== 0) return undefined;
  if (padding === 1 && (last & 0x03) !== 0) return undefined;
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

/** Pads a short unpadded string and reads either alphabet. */
function urlsafeDecode64(encoded: string): Uint8Array | undefined {
  let translated = encoded.replaceAll("-", "+").replaceAll("_", "/");
  if (!encoded.endsWith("=") && encoded.length % 4 !== 0) translated = translated.padEnd(Math.ceil(translated.length / 4) * 4, "=");
  return strictDecode64(translated);
}

/** Ruby's `JSON.parse` of bytes, which also skips comments and doesn't check UTF-8 inside strings. */
function rubyJsonParse(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  try {
    return JSON.parse(withoutJsonComments(text) ?? "");
  } catch {
    // The parser error quotes the input, and logging a message that isn't UTF-8 raises in turn
    let valid = true;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      valid = false;
    }
    throw valid ? new RailsError("JSON::ParserError") : new UnloggableRailsError("JSON::ParserError");
  }
}

function withoutJsonComments(text: string): string | undefined {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") {
        if (i + 1 >= text.length) return undefined;
        out += text[++i];
      } else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return undefined;
      i = end + 1;
      out += " ";
    } else if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i + 2);
      i = end < 0 ? text.length : end;
      out += " ";
    } else {
      out += c;
    }
  }
  return out;
}

/** Campfire's app/views/users/_mention.html.erb, with `avatar_tag`, for the user `mention` names. */
export function railsMentionPartial(mention: MentionUser): string {
  const user = usersByEmberId.get(mention.id)!;
  return (
    `<span class="mention" sgid="${htmlEscape(user.attachable_sgid)}"><a title="${htmlEscape(user.title)}" class="btn avatar" ` +
    `data-turbo-frame="_top" href="${htmlEscape(user.user_path)}"><img aria-hidden="true" src="${htmlEscape(user.avatar_path)}" ` +
    `width="48" height="48" /></a> ${htmlEscape(user.name)}</span>\n`
  );
}

/** Ember's mentions name users by their ids: the corpus's users, as Ember would know them. */
export function emberUser(sgid: string): CorpusUser | undefined {
  const id = userIdFromSgid(sgid);
  return id === undefined ? undefined : usersByEmberId.get(id);
}

/** A user named as a corpus body names them (`railsUser`), or as the form Ember stores it in does. */
export function corpusUser(sgid: string): CorpusUser | undefined {
  return emberUser(sgid) ?? railsUser(sgid);
}

/** The Ember ids of the users Rails found a body to mention, by their Rails ids. */
export const emberUserIds = (railsIds: number[]): string[] => railsIds.map((id) => users.get(id)!.id);

const INSERTED_LINK = '<a target="_blank" href="';

/**
 * Rails' presentation as Ember renders it on purpose: `<` and `>` are escaped in attribute values, the
 * links rails_autolink inserted inside an attribute value (a stored XSS) are left as the text they
 * replaced, and `name` attributes are dropped.
 */
export function withPortDivergences(rails: string): string {
  let out = "";
  let state: "text" | "tag" | "value" = "text";
  let i = 0;
  while (i < rails.length) {
    if (state === "value" && rails.startsWith(INSERTED_LINK, i)) {
      const textStart = rails.indexOf('">', i) + 2;
      const textEnd = rails.indexOf("</a>", textStart);
      out += rails.slice(textStart, textEnd).replaceAll(">", "&gt;");
      i = textEnd + "</a>".length;
      continue;
    }
    if (state === "tag" && rails.startsWith(' name="', i)) {
      i = rails.indexOf('"', i + ' name="'.length) + 1;
      continue;
    }
    const c = rails[i]!;
    if (state === "text" && c === "<") state = "tag";
    else if (state === "tag" && c === ">") state = "text";
    else if (state === "tag" && c === '"') state = "value";
    else if (state === "value" && c === '"') state = "tag";
    out += state === "value" && c === "<" ? "&lt;" : state === "value" && c === ">" ? "&gt;" : c;
    i++;
  }
  return out;
}
