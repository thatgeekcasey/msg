// Huddles, in which people in a room talk to each other through Cloudflare's Realtime SFU, by an SFU app
// in the Cloudflare account of whoever runs Ember, whose keys administrators give it in Set up huddles,
// behind the Huddles card of workspace settings, through `/api/account/huddles`.

import type { User, UserId } from "./index.ts";

/** Huddles as the Huddles card shows them to administrators while they're on: the SFU app they run through, by its ID. */
export interface HuddlesSettings {
  appId: string;
}

/** What Set up huddles gives `PUT /api/account/huddles`: a Realtime SFU app's ID and its secret, as Cloudflare's dashboard shows them when the app is made. */
export interface HuddlesSetup {
  appId: string;
  appSecret: string;
}

/** What `PUT /api/account/huddles` answers once Cloudflare has taken the app's keys: huddles as they are then. */
export interface HuddlesSaved {
  huddles: HuddlesSettings;
}

/** What `DELETE /api/account/huddles` answers: huddles are off. */
export interface HuddlesForgotten {
  huddles: null;
}

/** A field of Set up huddles, which a refusal can be about. */
export type HuddlesField = "appId" | "appSecret";

/** How long an SFU app's ID is, and its secret, as Cloudflare's API gives them. */
const APP_ID_LENGTH = 32;
const APP_SECRET_LENGTH = 64;

/** Why Set up huddles' fields are refused before Cloudflare is asked about them. */
export const APP_ID_REFUSED = `An App ID is ${APP_ID_LENGTH} letters and digits. Copy it from your app under Realtime's Serverless SFU in the Cloudflare dashboard.`;
export const APP_SECRET_REFUSED = `An App Secret is ${APP_SECRET_LENGTH} letters and digits. Copy it from your app under Realtime's Serverless SFU in the Cloudflare dashboard.`;

/** Why they're refused once Cloudflare has been asked to start a session with them, or couldn't be. */
export const APP_ID_UNKNOWN = "Cloudflare doesn't know that App ID. Copy it again from your app, or try again in a minute if you've just made it.";
export const APP_SECRET_UNKNOWN = "Cloudflare didn't take that App Secret for this app. Copy both from the same app.";
export const HUDDLES_UNCHECKED = "Ember couldn't reach Cloudflare to check the app's keys. Try again.";

/** What the Huddles card tells anyone but an administrator. */
export const HUDDLES_FORBIDDEN = "Only administrators can set up huddles";

/** The SFU app ID `text` gives, without the spaces around it, or null when it can't be one: 32 letters and digits. */
export function appIdOf(text: string): string | null {
  const appId = text.trim();
  return appId.length === APP_ID_LENGTH && /^[0-9a-z]+$/i.test(appId) ? appId : null;
}

/** The SFU app secret `text` gives, without the spaces around it, or null when it can't be one: 64 letters and digits. */
export function appSecretOf(text: string): string | null {
  const appSecret = text.trim();
  return appSecret.length === APP_SECRET_LENGTH && /^[0-9a-z]+$/i.test(appSecret) ? appSecret : null;
}

/** What `PUT /api/account/huddles` gives Ember, as Set up huddles sends it, or why it can't be an app's keys, on the field it's about. */
export function parseHuddlesSetup(data: unknown): HuddlesSetup | { error: string; field: HuddlesField } {
  const given = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const appId = typeof given.appId === "string" ? appIdOf(given.appId) : null;
  if (appId === null) return { error: APP_ID_REFUSED, field: "appId" };
  const appSecret = typeof given.appSecret === "string" ? appSecretOf(given.appSecret) : null;
  if (appSecret === null) return { error: APP_SECRET_REFUSED, field: "appSecret" };
  return { appId, appSecret };
}

// A huddle's socket. Each tab in a huddle keeps one to the room, at `/api/rooms/:id/huddle`, besides the
// socket it keeps while it shows the room. What people say goes between their browsers and the SFU: the
// socket carries who's in the huddle, and the session descriptions (SDP) a browser and the SFU agree
// with on what's sent, which the room passes between them. A tab keeps two connections to the SFU, one
// it sends on and one it receives on, so that neither's changes wait on the other's.

/** The most people a huddle takes. */
export const MAX_HUDDLE_PEOPLE = 50;

/** What a huddle closes a socket with, besides the codes a room closes one with (`CloseCode`). None is one to connect again after. */
export const HuddleCloseCode = {
  /** The huddle has as many people as one takes. */
  Full: 4005,
  /** Huddles are off: they were never set up, or an administrator turned them off while this one went on. */
  Off: 4006,
  /** The person joined the huddle from another tab or device, which it moved to. */
  Moved: 4007,
} as const;
export type HuddleCloseCode = (typeof HuddleCloseCode)[keyof typeof HuddleCloseCode];

/** What a track in a huddle carries: for now, someone's microphone. */
export type HuddleTrackKind = "audio";

/** A track a tab publishes: the media section of its offer that carries it, by its `mid`, and what it carries. */
export interface HuddleTrack {
  mid: string;
  kind: HuddleTrackKind;
}

/** A track a tab is offered: the media section of the offer that carries it, and whose it is. */
export interface OfferedHuddleTrack extends HuddleTrack {
  userId: UserId;
}

/** Someone in a huddle, as everyone in it hears of them. */
export interface HuddlePerson {
  user: User;
  /** Whether they've muted their microphone, as their tab says. */
  muted: boolean;
  /** Whether they can be listened to: their tab has connected to the SFU with their microphone. */
  audio: boolean;
}

/**
 * A huddle going on in a room, as everyone in the room hears of it, in the huddle or not, in their
 * sidebar and on their workspace sockets: who's in it, by their ids in the order they joined, and when it
 * started. The room tells the Workspace as people join and leave, so it trails the huddle by a moment.
 */
export interface LiveHuddle {
  startedAt: string;
  userIds: UserId[];
}

/** What a tab sends on its huddle's socket. Leaving the huddle is closing the socket. */
export type HuddleClientFrame =
  /**
   * Publishes the tab's microphone, with the offer its sending connection makes for it, which
   * `huddle.published` answers. A tab whose sending connection has failed publishes again from a new
   * one, and only once the room has answered the last, so that each answer is to the offer it waits on.
   */
  | { type: "huddle.publish"; sdp: string; tracks: HuddleTrack[] }
  /** The tab's sending connection has connected, so the others can listen to what it publishes. */
  | { type: "huddle.connected" }
  /**
   * Asks to hear everyone the tab doesn't hear yet, which `huddle.offer` answers, or `huddle.listening`
   * when there's nobody new. `fresh` says the tab has no receiving connection: as it joins, and whenever
   * the one it had has failed. A tab asks again only once the room has answered.
   */
  | { type: "huddle.listen"; fresh?: true }
  /** The answer the tab's receiving connection makes to a `huddle.offer`. */
  | { type: "huddle.answer"; sdp: string }
  /** The person has muted their microphone, or unmuted it. */
  | { type: "huddle.mute"; muted: boolean }
  | { type: "ping" };

/** What a tab hears on its huddle's socket. */
export type HuddleServerFrame =
  /** The huddle as the tab joins it: everyone in it, the tab's person included, and when it started. */
  | { type: "huddle.welcome"; you: User; people: HuddlePerson[]; startedAt: string }
  | { type: "huddle.joined"; person: HuddlePerson }
  /**
   * Someone muted or unmuted, can be listened to now, or can't be for the moment: their tab is publishing
   * again, or they've joined from another one. A tab asks to hear whoever it can listen to and doesn't.
   */
  | { type: "huddle.changed"; person: HuddlePerson }
  | { type: "huddle.left"; userId: UserId }
  /** The SFU's answer to the offer the tab published with. */
  | { type: "huddle.published"; sdp: string }
  /**
   * The SFU's offer of the people the tab asked to hear, as `tracks`, which the tab's receiving
   * connection answers with `huddle.answer`. `tracks` names whoever publishes what the offer carries of
   * them as the room sends it, and not someone who left or began publishing anew while the SFU made it.
   * Someone can do either while the offer is on its way, too, or while the connection takes it, so a tab
   * plays only the tracks of people who have been in the huddle, and to be listened to, since it came.
   */
  | { type: "huddle.offer"; sdp: string; tracks: OfferedHuddleTrack[] }
  /**
   * The tab hears everyone it was offered: it may ask again, should there be someone new. The SFU can
   * take a moment to find what someone has just published, so a tab that still doesn't hear someone it
   * can listen to asks again in a while.
   */
  | { type: "huddle.listening" }
  /**
   * The SFU no longer has what the tab published, so nobody can listen to its person until the tab
   * publishes again, from a new sending connection. A tab waiting on the answer to an offer it has
   * published with already is.
   */
  | { type: "huddle.unpublished" }
  /**
   * The room couldn't do what the `failed` frame asked. After a failed `huddle.listen` or `huddle.answer`
   * the room has let go of the tab's receiving connection, so the tab starts a fresh one. After a failed
   * `huddle.publish` it publishes again, from a new sending connection.
   */
  | { type: "error"; message: string; failed?: HuddleClientFrame["type"] }
  | { type: "pong" };

/** What a huddle socket's address says of its tab: whether its person joins with their microphone muted. */
export interface HuddleSocketParams {
  muted: boolean;
}

/** The query a huddle socket's address ends with. */
export const huddleSocketQuery = ({ muted }: HuddleSocketParams) => (muted ? "?muted=1" : "");

/** What a huddle socket's address says of its tab, as `huddleSocketQuery` wrote it. A tab that doesn't say joins unmuted. */
export const parseHuddleSocketParams = (query: { get(name: string): string | null }): HuddleSocketParams => ({ muted: query.get("muted") === "1" });

/** Why the room couldn't do what a huddle's tab asked: the SFU refused, or couldn't be reached. */
export const HUDDLE_FAILED = "The huddle couldn't connect. Trying again.";

/** The most characters a session description can have: one for a tab hearing a full huddle is a fraction of this. */
export const MAX_SDP_LENGTH = 500_000;

const sdpOf = (value: unknown): string | null => (typeof value === "string" && value.length > 0 && value.length <= MAX_SDP_LENGTH ? value : null);

/** A media section's `mid` as browsers write them: a few letters and digits, and never the `#` the SFU reads a track's name after. */
const isMid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value);

/** The kinds of track a tab can publish, one of each at most. */
const TRACK_KINDS: readonly HuddleTrackKind[] = ["audio"];

/** The tracks a `huddle.publish` names, each of a kind and by a `mid` of its own, or null when they can't be that. */
function tracksOf(value: unknown): HuddleTrack[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > TRACK_KINDS.length) return null;
  const tracks: HuddleTrack[] = [];
  for (const track of value as unknown[]) {
    if (typeof track !== "object" || track === null) return null;
    const { mid, kind } = track as Record<string, unknown>;
    const known = TRACK_KINDS.find((known) => known === kind);
    if (!isMid(mid) || known === undefined || tracks.some((other) => other.mid === mid || other.kind === known)) return null;
    tracks.push({ mid, kind: known });
  }
  return tracks;
}

/** Parses an untrusted frame from a huddle's socket. Returns null for anything malformed. */
export function parseHuddleClientFrame(raw: string): HuddleClientFrame | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const frame = data as Record<string, unknown>;
  switch (frame.type) {
    case "huddle.publish": {
      const [sdp, tracks] = [sdpOf(frame.sdp), tracksOf(frame.tracks)];
      return sdp !== null && tracks !== null ? { type: "huddle.publish", sdp, tracks } : null;
    }
    case "huddle.connected":
      return { type: "huddle.connected" };
    case "huddle.listen":
      if (frame.fresh !== undefined && frame.fresh !== true) return null;
      return frame.fresh ? { type: "huddle.listen", fresh: true } : { type: "huddle.listen" };
    case "huddle.answer": {
      const sdp = sdpOf(frame.sdp);
      return sdp !== null ? { type: "huddle.answer", sdp } : null;
    }
    case "huddle.mute":
      return typeof frame.muted === "boolean" ? { type: "huddle.mute", muted: frame.muted } : null;
    case "ping":
      return { type: "ping" };
    default:
      return null;
  }
}
