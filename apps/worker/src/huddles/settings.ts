import { HUDDLES_FORBIDDEN, parseHuddlesSetup, type HuddlesForgotten, type HuddlesSaved, type HuddlesSettings } from "@ember/protocol/huddles";
import { credentialsOf } from "../auth";
import { jsonBodyOf } from "../bodies";
import type { Env } from "../env";
import { formAnswer } from "../pages";
import { workspace } from "../workspace";
import { refusalOfApp } from "./sfu";

// Huddles' setup, as administrators turn huddles on, change the Realtime SFU app they run through and turn
// them off on the Huddles card of workspace settings' Rooms and permissions. They answer JSON for the card
// and its dialog.

const problem = (status: number, message: string) => Response.json({ error: message }, { status });

const NOT_SIGNED_IN = "Not signed in";
/** What's said of huddles' setup is for administrators, which no cache should keep. */
const PRIVATE = { "Cache-Control": "no-store" };

/**
 * `PUT /api/account/huddles`, `{ appId, appSecret }`: turns huddles on, or changes the SFU app they run
 * through, once Cloudflare's Realtime SFU has started a session with the app's keys, answering huddles as
 * they are then. Someone who isn't an administrator hears so before anything they sent is read. A key
 * that can't be one, or that the SFU refuses, is refused on its field.
 */
export async function saveHuddles(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const administrator = credentials && (await workspace(env).canAdminister(credentials));
  if (!credentials || administrator === null) return problem(401, NOT_SIGNED_IN);
  if (!administrator) return problem(403, HUDDLES_FORBIDDEN);
  const app = parseHuddlesSetup(await jsonBodyOf(request));
  if ("error" in app) return formAnswer(app, 422);
  const refusal = await refusalOfApp(env, app);
  if (refusal) return formAnswer({ error: refusal.error, ...(refusal.field && { field: refusal.field }) }, refusal.status);
  return huddlesAnswer(await workspace(env).changeHuddles(credentials, app));
}

/** `DELETE /api/account/huddles`: turns huddles off, as the Huddles card's switch does, which forgets the SFU app's keys. */
export async function forgetHuddles(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return huddlesAnswer(credentials && (await workspace(env).changeHuddles(credentials, null)));
}

/** The answer to changing huddles: huddles as they are then, or who can't change them. */
function huddlesAnswer(changed: { huddles: HuddlesSettings | null } | "forbidden" | null): Response {
  if (!changed) return problem(401, NOT_SIGNED_IN);
  if (changed === "forbidden") return problem(403, HUDDLES_FORBIDDEN);
  return Response.json(changed satisfies HuddlesSaved | HuddlesForgotten, { headers: PRIVATE });
}
