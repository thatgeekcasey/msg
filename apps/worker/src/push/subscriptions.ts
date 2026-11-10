import { parsePushSubscription, PUSH_SUBSCRIPTIONS_PATH, type PushSubscriptions } from "@ember/protocol";
import { credentialsOf } from "../auth";
import { jsonBodyOf } from "../bodies";
import type { Env } from "../env";
import { browserNamesOf } from "../user-agent";
import { workspace } from "../workspace";
import { sendTestPush } from "./delivery";
import { endpointErrors } from "./endpoints";

// Your browsers' push subscriptions, and the test pushes its `test_notifications` controller sends them.

const problem = (status: number, message: string) => Response.json({ error: message }, { status });

const NOT_SIGNED_IN = "Not signed in";

/**
 * `GET /api/push-subscriptions`: yours, oldest first, each with the browser that saved it as its user
 * agent names it.
 */
export async function listPushSubscriptions(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const saved = credentials && (await workspace(env).pushSubscriptions(credentials));
  if (!saved) return problem(401, NOT_SIGNED_IN);
  const subscriptions = saved.map(({ id, endpoint, userAgent }) => ({ id, endpoint, ...browserNamesOf(userAgent) }));
  return Response.json({ subscriptions } satisfies PushSubscriptions, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `POST /api/push-subscriptions`, `{ endpoint, p256dhKey, authKey }`: saves a browser's subscription for
 * you, with its user agent, or, when you've saved one at that endpoint before, records that it was saved
 * again with the keys it has now, answering 204. You keep the `MAX_PUSH_SUBSCRIPTIONS` you saved most
 * recently, and one can replace the one its browser had at the address it moved from to Ember's custom
 * domain (`replacing`). An endpoint pushes may not go to is refused (422) with Campfire's errors, which
 * it leaves out of its answer.
 */
export async function savePushSubscription(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, NOT_SIGNED_IN);
  const subscription = parsePushSubscription(await jsonBodyOf(request));
  const refused = typeof subscription === "string" ? subscription : refusal(endpointErrors(subscription.endpoint));
  // Asked even for a subscription that's refused, so that someone signed out hears that first.
  const saved = await workspace(env).savePushSubscription(credentials, typeof subscription === "string" || refused ? null : subscription);
  if (!saved) return problem(401, NOT_SIGNED_IN);
  return refused ? problem(422, refused) : new Response(null, { status: 204 });
}

/** What an endpoint's errors refuse it with, as Rails writes them out: "Endpoint can't be blank and is not a valid URL". */
const refusal = (errors: string[]) => (errors.length > 0 ? `Endpoint ${errors.join(" and ")}` : null);

/**
 * `DELETE /api/push-subscriptions/:id`: deletes your subscription `id`, and does nothing if it's someone
 * else's or there's no such subscription, answering 204 either way where Campfire redirects to the list.
 */
export async function deletePushSubscription(request: Request, env: Env, id: string): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  // An id that isn't a number names no subscription.
  const deleted = credentials && (await workspace(env).deletePushSubscription(credentials, /^\d{1,15}$/.test(id) ? Number(id) : null));
  if (!deleted) return problem(401, NOT_SIGNED_IN);
  return new Response(null, { status: 204 });
}

/**
 * `POST /api/push-subscriptions/:id/test-notifications`: pushes "Ember Test" to your subscription `id`
 * at once, with a random text, your unread count as its badge, and this page to open, answering 204
 * where Campfire redirects to the list. Someone else's subscription is 404, and Web Push being off, or
 * the push failing, is 500, without forgetting a subscription whose push service says it's gone.
 */
export async function sendTestNotification(request: Request, env: Env, id: string): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const delivery = credentials && (await workspace(env).testPushDelivery(credentials, /^\d{1,15}$/.test(id) ? Number(id) : null));
  if (!delivery) return problem(401, NOT_SIGNED_IN);
  if (delivery === "missing") return problem(404, "Push subscription not found");
  const path = new URL(PUSH_SUBSCRIPTIONS_PATH, request.url).href;
  await sendTestPush(env, { title: "Ember Test", body: crypto.randomUUID(), path }, delivery);
  return new Response(null, { status: 204 });
}
