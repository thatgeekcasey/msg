import { LOGO_BOXES } from "@ember/protocol";
import type { Env } from "./env";
import { notFound } from "./error-pages";
import { etagOf, isFresh } from "./etag";
import { logoOf, newLogoKey, storePicture, variantKey, type PictureRefusal, type StoredPicture } from "./files/pictures";
import { hasBody } from "./files/serving";
import { urlOf } from "./request-url";
import { workspace } from "./workspace";

// The workspace's logo, as Campfire's Accounts::LogosController serves it: a PNG anyone may fetch, so it
// can be a push's icon and the installed app's: a variant of the logo an administrator uploaded, or
// Ember's stock app icon, from the built app's files.

/** `expires_in 5.minutes, public: true, stale_while_revalidate: 1.week` */
const CACHE_CONTROL = "max-age=300, public, stale-while-revalidate=604800";

/** Whether `pathname` is the logo's. */
export const isAccountLogoPath = (pathname: string) => /^\/account\/logo(?:\.[^/.]+)?$/.test(pathname);

/**
 * `GET /account/logo`: the variant within 512×512 of the logo an administrator uploaded, or the one
 * within 192×192 with `?size=small`, or the stock app icon or its 192-pixel one when there's no logo, or
 * none Campfire could resize. A 304 says how long to keep the copy too, as avatars' do.
 */
export async function showAccountLogo(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return notFound(request);
  const small = urlOf(request).searchParams.get("size") === "small";
  // Without R2 there's no logo to serve, and no need to ask the Workspace.
  const logo = env.FILES ? await workspace(env).logo() : null;
  const uploaded = logo?.variant ? await variant(request, env, logo, small ? LOGO_BOXES.small : LOGO_BOXES.large) : null;
  return uploaded ?? stockIcon(request, env, small);
}

/**
 * The variant of the uploaded logo that fits within `box`, or null if R2 hasn't got it, when the stock
 * icon stands in. A logo's variants never change, so each one's ETag is its key's.
 */
async function variant(request: Request, env: Env, { key, variant }: StoredPicture, box: number): Promise<Response | null> {
  const files = env.FILES;
  if (!files || !variant) return null;
  const etag = await etagOf(variantKey(key, box));
  const headers = new Headers({ ETag: etag, "Cache-Control": CACHE_CONTROL });
  if (isFresh(request, etag)) return new Response(null, { status: 304, headers });
  const object = request.method === "HEAD" ? await files.head(variantKey(key, box)) : await files.get(variantKey(key, box));
  if (!object) return null;
  headers.set("Content-Type", variant);
  headers.set("Content-Length", String(object.size));
  return new Response(hasBody(object) ? object.body : null, { headers });
}

/** The stock app icon, or its 192-pixel one when `small`. */
async function stockIcon(request: Request, env: Env, small: boolean): Promise<Response> {
  const file = small ? "app-icon-192.png" : "app-icon.png";
  const icon = await env.ASSETS.fetch(new URL(`/logos/${file}`, request.url));
  if (!icon.ok) throw new Error(`The stock icon ${file} answered ${icon.status}`);
  const bytes = new Uint8Array(await icon.arrayBuffer());
  const etag = await etagOf(bytes);
  const headers = new Headers({ ETag: etag, "Cache-Control": CACHE_CONTROL });
  if (isFresh(request, etag)) return new Response(null, { status: 304, headers });
  headers.set("Content-Type", "image/png");
  headers.set("Content-Disposition", `inline; filename="${file}"; filename*=UTF-8''${file}`);
  return new Response(request.method === "HEAD" ? null : bytes, { headers });
}

/**
 * The logo `form` brings, which R2 has stored, with its variants, under a key the Workspace reserved for
 * it, or why it's refused (`logoOf`). Giving the workspace the logo takes the reservation, and R2 deletes
 * it once the reservation runs out if nothing has, however the request ends.
 */
export async function storeLogo(env: Env, files: R2Bucket, form: FormData): Promise<StoredPicture | PictureRefusal> {
  const upload = await logoOf(form);
  if ("error" in upload) return upload;
  const key = newLogoKey();
  await workspace(env).reservePicture(key);
  return storePicture(files, key, upload);
}
