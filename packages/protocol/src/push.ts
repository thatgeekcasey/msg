// Web Push subscriptions, as `/api/push-subscriptions` takes and lists them, and signing out forgets
// this browser's, as Campfire's `push_subscriptions` and `sessions#destroy` do, and pausing
// notifications, as Slack's Do Not Disturb does.

import type { DirectoryUser } from "./index.ts";

/** The longest endpoint saved. Push services' are a few hundred characters. */
export const MAX_PUSH_ENDPOINT_LENGTH = 2048;
/** The longest key saved. A browser's P-256 key is 87 characters of Base64, and its auth secret 22. */
export const MAX_PUSH_KEY_LENGTH = 256;
/**
 * How many browsers' subscriptions one person keeps: the ones they saved most recently. Keeping any
 * number, and pushing each message to every one, would let one person saving thousands have every
 * message that notifies them pushed thousands of times.
 */
export const MAX_PUSH_SUBSCRIPTIONS = 10;

/** A browser's push subscription, as `POST /api/push-subscriptions` takes it from `PushSubscription.toJSON()`. */
export interface PushSubscriptionKeys {
  endpoint: string;
  /** The browser's P-256 public key, which pushes are encrypted for, in URL-safe Base64. */
  p256dhKey: string;
  /** The browser's authentication secret, in URL-safe Base64. */
  authKey: string;
}

/**
 * What `POST /api/push-subscriptions` takes: a browser's push subscription, and the P-256 key of the one
 * the same browser had at the address its page moved from to Ember's custom domain, which this one
 * replaces.
 */
export interface PushSubscriptionSave extends PushSubscriptionKeys {
  replacing?: string;
}

/**
 * One of your saved subscriptions, as `GET /api/push-subscriptions` lists them, with the browser that
 * saved it: each name is "" where the agent gives none.
 */
export interface SavedPushSubscription {
  id: number;
  endpoint: string;
  browser: string;
  version: string;
  platform: string;
}

/** What `GET /api/push-subscriptions` answers: your subscriptions, oldest first. */
export interface PushSubscriptions {
  subscriptions: SavedPushSubscription[];
}

/** What `DELETE /api/session` may send: the endpoint of the push subscription this browser just ended. */
export interface SignOut {
  pushSubscriptionEndpoint?: string;
}

/**
 * Parses what `POST /api/push-subscriptions` takes. Returns why it's refused instead: the endpoint and
 * both keys are required and have to be text. A `replacing` that can't be a key is left out rather than
 * refused, so that whatever a page's address carried can't stop notifications being turned on.
 */
export function parsePushSubscription(data: unknown): PushSubscriptionSave | string {
  const { endpoint, p256dhKey, authKey, replacing } = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  if (typeof endpoint !== "string" || typeof p256dhKey !== "string" || typeof authKey !== "string") {
    return "A push subscription needs its endpoint and keys";
  }
  if (endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) return `Endpoint can't be longer than ${MAX_PUSH_ENDPOINT_LENGTH} characters`;
  if (p256dhKey.length > MAX_PUSH_KEY_LENGTH || authKey.length > MAX_PUSH_KEY_LENGTH) return `Keys can't be longer than ${MAX_PUSH_KEY_LENGTH} characters`;
  const replaces = typeof replacing === "string" && replacing !== "" && replacing.length <= MAX_PUSH_KEY_LENGTH;
  return { endpoint, p256dhKey, authKey, ...(replaces && { replacing }) };
}

/**
 * The endpoint a sign-out names, whose subscriptions of yours go with the session, or null when it
 * names none an endpoint could be.
 */
export function signOutEndpointOf(data: unknown): string | null {
  const { pushSubscriptionEndpoint: endpoint } = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  return typeof endpoint === "string" && endpoint !== "" && endpoint.length <= MAX_PUSH_ENDPOINT_LENGTH ? endpoint : null;
}

/**
 * The longest notifications can be paused for: a week. The rail offers until tomorrow at most, and
 * holding the end so close keeps a pause from being forgotten for good.
 */
export const LONGEST_PAUSE_MS = 7 * 24 * 60 * 60_000;

/**
 * What `PUT /api/users/me/notifications-pause` takes: when a pause of your notifications ends, as an ISO
 * time the browser works out in its own time zone, since Ember keeps nobody's, or null to resume them.
 */
export interface NotificationsPause {
  until: string | null;
}

/** What it answers: you as the people directory lists you now, `pausedUntil` saying until when, if you're paused. */
export interface NotificationsPaused {
  user: DirectoryUser;
}

/**
 * Parses what `PUT /api/users/me/notifications-pause` takes, as of `now`, in milliseconds since the
 * epoch: an end as `toISOString` writes one, after `now` and no more than `LONGEST_PAUSE_MS` after it,
 * or null. Returns why it's refused instead.
 */
export function parseNotificationsPause(data: unknown, now: number): NotificationsPause | string {
  const { until } = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  if (until === null) return { until };
  const end = typeof until === "string" ? Date.parse(until) : NaN;
  if (typeof until !== "string" || Number.isNaN(end) || new Date(end).toISOString() !== until) return "A pause needs the time it ends, or null to resume notifications";
  if (end <= now) return "A pause can't end in the past";
  if (end - now > LONGEST_PAUSE_MS) return "Notifications can be paused for a week at most";
  return { until };
}
