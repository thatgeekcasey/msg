import { credentialsOf } from "./auth";
import type { Env } from "./env";
import { webPush } from "./push/keys";
import { carriesRecoveryToken } from "./recovery";
import { urlOf } from "./request-url";
import { workspace } from "./workspace";

// Campfire's /up, which says the Worker is answering, and /api/health, which checks its storage too.

/** `/up(.:format)`. */
const UP_PATH = /^\/up(?:\.([^/.]+))?$/;
/** Rails' health page, byte for byte. */
const UP_PAGE = '<!DOCTYPE html><html><body style="background-color: green"></body></html>';
/** Rails' `BROWSER_LIKE_ACCEPTS`: a browser lists the catch-all type beside others, and Rails ignores its Accept. */
const BROWSER_ACCEPT = /,\s*\*\/\*|\*\/\*\s*,/;
/** The room object /api/health reads from. No room can have this name, since room ids can't hold "_". */
const HEALTH_ROOM = "_health";

type Format = "html" | "json";

export const isUpPath = (pathname: string) => UP_PATH.test(pathname);

/**
 * The format Rails' `respond_to` picks for /up from the request's Accept header: HTML for none, or a
 * browser's, else whichever of HTML and JSON the header ranks first by quality, the catch-all type
 * counting as HTML, or null if it names neither.
 */
function acceptedFormat(accept: string): Format | null {
  if (!accept || BROWSER_ACCEPT.test(accept)) return "html";
  const ranges = accept.split(",").map((range) => {
    const [type = "", ...parameters] = range.split(";").map((part) => part.trim().toLowerCase());
    const quality = Number(parameters.find((parameter) => parameter.startsWith("q="))?.slice(2) ?? 1);
    return { type, quality: Number.isNaN(quality) ? 0 : quality };
  });
  for (const { type } of ranges.sort((a, b) => b.quality - a.quality)) {
    if (type === "application/json") return "json";
    if (type === "text/html" || type === "*/*") return "html";
  }
  return null;
}

/**
 * Answers GET /up with Rails' green page, or with `{"status":"up","timestamp":…}` for /up.json or an
 * Accept header that wants JSON, and 406 for any other format, as Rails does.
 */
export function up(request: Request): Response {
  const extension = UP_PATH.exec(urlOf(request).pathname)?.[1];
  const accept = request.headers.get("Accept")?.trim() ?? "";
  const format = extension === undefined ? acceptedFormat(accept) : extension === "html" || extension === "json" ? extension : null;
  if (!format) return new Response(null, { status: 406 });

  const headers = new Headers();
  // Rails says the answer depends on Accept whenever Accept chose it.
  if (extension === undefined && accept && !BROWSER_ACCEPT.test(accept)) headers.set("Vary", "Accept");
  if (format === "html") {
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(UP_PAGE, { headers });
  }
  headers.set("Content-Type", "application/json; charset=utf-8");
  // To the second, as jiff writes it: 2026-10-14T03:04:05Z.
  const timestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return new Response(JSON.stringify({ status: "up", timestamp }), { headers });
}

/**
 * Answers 200 once the Worker can sign people in and the Workspace and a room's object both read their
 * storage, so a deploy can be checked without signing in. To an administrator, or a request carrying
 * EMBER_RECOVERY_TOKEN as the deploy check can, it says which storage that is, whether push
 * notifications are on, and why not, and whether there's a bucket for files, though neither decides
 * whether it's healthy, and why it isn't when it isn't. Anyone else hears only whether it's up, so a
 * deployment doesn't describe itself to strangers; what's wrong is logged for whoever runs it.
 */
export async function health(request: Request, env: Env): Promise<Response> {
  // Who's asking is read from the storage being checked, so while that's down the check says so below.
  const detailed = await mayReadDetail(request, env).catch(() => false);
  const storage = env.STORAGE_BACKEND;
  const failed = (error: string, cause?: unknown) => {
    console.error(`Health check failed: ${error}`, ...(cause === undefined ? [] : [cause]));
    return Response.json(detailed ? { ok: false, storage, error } : { ok: false }, { status: 503 });
  };
  if (!env.SESSION_SECRET) return failed("SESSION_SECRET isn't set");
  try {
    await Promise.all([workspace(env).health(), env.CHAT_ROOM.getByName(HEALTH_ROOM).health(HEALTH_ROOM)]);
  } catch (error) {
    return failed("Storage isn't answering", error);
  }
  if (!detailed) return Response.json({ ok: true });
  const push = await webPush(env);
  return Response.json({ ok: true, storage, push: push.on ? { on: true } : { on: false, reason: push.reason }, files: { on: env.FILES !== undefined } });
}

/** Whether the request is an administrator's, or carries the recovery token, which needs no session. */
async function mayReadDetail(request: Request, env: Env): Promise<boolean> {
  if (await carriesRecoveryToken(request, env)) return true;
  // Without SESSION_SECRET there's no session to check, which the answer is about to say.
  if (!env.SESSION_SECRET) return false;
  const credentials = await credentialsOf(request, env);
  const me = credentials && (await workspace(env).me(credentials));
  return me?.administrator === true;
}
