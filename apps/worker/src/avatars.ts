import { ASSISTANT_ID, avatarSvg } from "@ember/protocol";
import { credentialsOf } from "./auth";
import { avatarTokenUser } from "./avatar-tokens";
import { jsonBodyOf } from "./bodies";
import { DEFAULT_BOT_AVATAR } from "./default-bot-avatar";
import type { Env } from "./env";
import { notFound } from "./error-pages";
import { etagOf, isFresh } from "./etag";
import { avatarOf, newAvatarKey, pictureFormOf, storePicture, variantKey, type PictureRefusal, type StoredPicture } from "./files/pictures";
import { hasBody } from "./files/serving";
import { NO_STORAGE } from "./files/uploads";
import { empty, signInFirst } from "./pages";
import { workspace } from "./workspace";

// People's avatars, as Campfire's Users::AvatarsController serves them: an image at the address
// avatar-tokens.ts makes, for people signed in: the variant of the picture they uploaded, or their
// initials, or the bot picture for a bot, or Ember's flame for @ember.

/** `expires_in 30.minutes, public: true, stale_while_revalidate: 1.week` */
const CACHE_CONTROL = "max-age=1800, public, stale-while-revalidate=604800";

/** Where the built app has @ember's picture: Ember's flame in white on the app icon's sunset. */
const FLAME = "/assistant-avatar.svg";

/** Rails' `/users/:user_id/avatar`, which takes the token as the id. */
const ROUTE = /^\/users\/([^/]+)\/avatar$/;

/** The token in an avatar's path, or null if `pathname` isn't one. */
export function avatarTokenOf(pathname: string): string | null {
  const segment = pathname.match(ROUTE)?.[1];
  if (segment === undefined) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding can't be a token.
    return "";
  }
}

/**
 * `GET /users/<token>/avatar`: someone's avatar, for people signed in, whatever the person's status.
 * Signed out, the browser is sent to sign in, before the token is looked at; a token this Worker
 * didn't sign, or one for nobody, is an empty 404.
 */
export async function showAvatar(request: Request, env: Env, token: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return notFound(request);
  const credentials = await credentialsOf(request, env);
  if (!credentials) return signInFirst(request);
  const userId = await avatarTokenUser(token, env.SESSION_SECRET);
  if (userId === null) return (await workspace(env).authenticate(credentials)) ? empty(404) : signInFirst(request);
  const owner = await workspace(env).avatarOwner(credentials, userId);
  if (owner === null) return signInFirst(request);
  if (owner === "not found") return empty(404);
  const uploaded = owner.avatar?.variant ? await variant(request, env, owner.avatar) : null;
  if (uploaded) return uploaded;
  if (userId === ASSISTANT_ID) return flame(request, env);
  return owner.bot ? image(request, DEFAULT_BOT_AVATAR, true) : image(request, avatarSvg(userId, owner.name), false);
}

/** @ember's picture: Ember's flame, from the built app's files. */
async function flame(request: Request, env: Env): Promise<Response> {
  const icon = await env.ASSETS.fetch(new URL(FLAME, request.url));
  if (!icon.ok) throw new Error(`Ember's flame answered ${icon.status}`);
  const bytes = new Uint8Array(await icon.arrayBuffer());
  const etag = await etagOf(bytes);
  const headers = new Headers({ ETag: etag, "Cache-Control": CACHE_CONTROL });
  if (isFresh(request, etag)) return new Response(null, { status: 304, headers });
  headers.set("Content-Type", "image/svg+xml");
  return new Response(request.method === "HEAD" ? null : bytes, { headers });
}

/**
 * The variant of the picture someone uploaded, or null if R2 hasn't got it, when their initials stand
 * in. A picture's variant never changes, so its ETag is its key's.
 */
async function variant(request: Request, env: Env, { key, variant }: StoredPicture): Promise<Response | null> {
  const files = env.FILES;
  if (!files || !variant) return null;
  const etag = await etagOf(key);
  const headers = new Headers({ ETag: etag, "Cache-Control": CACHE_CONTROL });
  if (isFresh(request, etag)) return new Response(null, { status: 304, headers });
  const object = request.method === "HEAD" ? await files.head(variantKey(key)) : await files.get(variantKey(key));
  if (!object) return null;
  headers.set("Content-Type", variant);
  headers.set("Content-Length", String(object.size));
  return new Response(hasBody(object) ? object.body : null, { headers });
}

/**
 * An avatar's answer: `send_file` for the bot picture, `render` for initials. A 304 says how long to
 * keep the copy too, and a browser that takes a 304's Cache-Control for its copy would then check it
 * every time.
 */
async function image(request: Request, svg: string, bot: boolean): Promise<Response> {
  const etag = await etagOf(svg);
  const headers = new Headers({ ETag: etag, "Cache-Control": CACHE_CONTROL });
  if (isFresh(request, etag)) return new Response(null, { status: 304, headers });
  headers.set("Content-Type", bot ? "image/svg+xml" : "image/svg+xml; charset=utf-8");
  if (bot) headers.set("Content-Disposition", `inline; filename="default-bot-avatar.svg"; filename*=UTF-8''default-bot-avatar.svg`);
  return new Response(request.method === "HEAD" ? null : svg, { headers });
}

/**
 * The avatar `form` brings, which R2 has stored, with its variant, under a key the Workspace reserved for
 * it, or why it's refused (`avatarOf`). Whatever gives someone the avatar takes the reservation, and R2
 * deletes it once the reservation runs out if nothing has, however the request ends.
 */
export async function storeAvatar(env: Env, files: R2Bucket, form: FormData): Promise<StoredPicture | PictureRefusal> {
  const upload = await avatarOf(form);
  if ("error" in upload) return upload;
  const key = newAvatarKey();
  await workspace(env).reservePicture(key);
  return storePicture(files, key, upload);
}

/** What a form of someone's fields sends: the fields, and the form its photo came in, when one was chosen. */
export interface UserForm {
  fields: unknown;
  photo: FormData | null;
}

/**
 * What a request with someone's fields sends, as the setup, join and bot forms send it: JSON, or with a
 * photo, a form whose `user` part is that JSON and whose `avatar` and `variant` parts are the photo.
 */
export async function userFormOf(request: Request): Promise<UserForm | PictureRefusal> {
  if (!request.headers.get("Content-Type")?.startsWith("multipart/form-data")) {
    return { fields: await jsonBodyOf(request), photo: null };
  }
  const form = await pictureFormOf(request);
  if (!(form instanceof FormData)) return form;
  const user = form.get("user");
  return { fields: typeof user === "string" ? parseJson(user) : null, photo: form };
}

/** The photo `photo` brings, stored for whoever is given it, null when there's none, or why it's refused. */
export async function userFormPhoto(env: Env, photo: FormData | null): Promise<StoredPicture | PictureRefusal | null> {
  if (photo?.get("avatar") == null) return null;
  if (!env.FILES) return { status: 503, error: NO_STORAGE };
  return storeAvatar(env, env.FILES, photo);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
