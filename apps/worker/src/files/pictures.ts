import { AVATAR_BOX, AVATAR_TOO_LARGE, isVariable, LOGO_BOXES, LOGO_TOO_LARGE, MAX_AVATAR_SIZE, MAX_LOGO_SIZE } from "@ember/protocol";
import { base36 } from "../ids";
import { sanitizedFilename } from "./filename";
import { imageSize } from "./images";
import { byMagic, identify } from "./marcel";

// Pictures people upload: avatars, from the profile, setup and sign-up forms, and the workspace's logo,
// from workspace settings. R2 keeps the file as it came, whatever it is, under a key of its own, and
// beside it the variants that are served, which the uploader's browser makes: an avatar's within 512×512
// and a logo's within 512×512 and 192×192, keeping its proportions, as `resize_to_limit` scales it. A
// file Campfire doesn't resize keeps no variants, and its owner's initials or Ember's stock icon are
// served.

/**
 * The types an avatar's variant can be, by its bytes: WebP, or where the browser can't encode WebP, as
 * Safari can't, a PNG, or a JPEG for a picture that can't be see-through, as previews are made.
 */
const AVATAR_VARIANT_TYPES = new Set(["image/webp", "image/png", "image/jpeg"]);

/** The type a logo's variants are. */
const LOGO_VARIANT_TYPES = new Set(["image/png"]);

/** How many bytes a request with a picture may bring: the largest picture, its variants and the rest of its form. */
export const MAX_PICTURE_REQUEST = Math.max(MAX_AVATAR_SIZE, MAX_LOGO_SIZE) + 2 * 1024 * 1024;

/** How much of a file is read to tell what it is: more than Marcel's magic looks at, which is the first 64 KiB. */
const SNIFFED_BYTES = 128 * 1024;

/** A picture as R2 keeps it: the key of its file, and its variants' type, or null when there are none. */
export interface StoredPicture {
  key: string;
  variant: string | null;
}

/** A variant of a picture, which fits within `box`. */
interface Variant {
  box: number;
  bytes: Uint8Array;
  contentType: string;
}

/** A picture as a form brings it: its file, the type its bytes say it is, and the variants to keep of it, of one type. */
export interface PictureUpload {
  file: File;
  contentType: string;
  variants: Variant[];
}

/** Why a picture is refused, and the status that says so. */
export interface PictureRefusal {
  status: number;
  error: string;
}

/**
 * The form a request brings a picture in, or why it's refused: without the request's length, past the
 * most a request with a picture may bring, when `tooLarge` says why, or anything but a form.
 */
export async function pictureFormOf(request: Request, tooLarge = AVATAR_TOO_LARGE): Promise<FormData | PictureRefusal> {
  const length = Number(request.headers.get("Content-Length") ?? Number.NaN);
  if (!Number.isSafeInteger(length)) return { status: 411, error: "A picture needs its Content-Length" };
  if (length > MAX_PICTURE_REQUEST) return { status: 413, error: tooLarge };
  return (await request.formData().catch(() => null)) ?? { status: 400, error: "Expected a form" };
}

/** A new key for an avatar, as Active Storage gives a blob a key. */
export const newAvatarKey = () => `avatars/${base36(28)}`;

/** A new key for a logo. */
export const newLogoKey = () => `logos/${base36(28)}`;

/** Where R2 keeps the variant of the picture at `key` that fits within `box`: an avatar's, or either of a logo's. */
export const variantKey = (key: string, box: number = AVATAR_BOX) => `${key}/${box}`;

/** Everything R2 keeps for the picture at `key`, which deleting it deletes: the file and whichever variants it has. */
export const pictureObjects = (key: string) => [key, variantKey(key, LOGO_BOXES.large), variantKey(key, LOGO_BOXES.small)];

/**
 * The avatar a form brings as its `avatar` and `variant` parts, or why it's refused: any file up to 16
 * MB, and a WebP, PNG or JPEG within 512×512 as its variant. The variant is kept only for a file
 * Campfire resizes, by what its bytes say it is, so a picture of a type Campfire doesn't resize, such as
 * an SVG or a BMP, is served as its owner's initials.
 */
export async function avatarOf(form: FormData): Promise<PictureUpload | PictureRefusal> {
  const file = form.get("avatar");
  if (!(file instanceof File)) return { status: 400, error: "Choose a picture" };
  if (file.size > MAX_AVATAR_SIZE) return { status: 413, error: AVATAR_TOO_LARGE };
  const contentType = await typeOf(file);
  const variant = await variantOf(form.get("variant"), AVATAR_BOX, AVATAR_VARIANT_TYPES, "A variant is a WebP, PNG or JPEG image");
  if (variant && "error" in variant) return variant;
  return { file, contentType, variants: variant && isVariable(contentType) ? [variant] : [] };
}

/**
 * The logo a form brings as its `logo`, `large` and `small` parts, or why it's refused: any file up to
 * 16 MB, and PNGs within 512×512 and 192×192 as its variants. They're kept only for a file Campfire
 * resizes, as an avatar's variant is, and only both of them, so a logo of a type Campfire doesn't
 * resize, such as an SVG or an ICO, is served as Ember's stock icon.
 */
export async function logoOf(form: FormData): Promise<PictureUpload | PictureRefusal> {
  const file = form.get("logo");
  if (!(file instanceof File)) return { status: 400, error: "Choose a logo" };
  if (file.size > MAX_LOGO_SIZE) return { status: 413, error: LOGO_TOO_LARGE };
  const contentType = await typeOf(file);
  const large = await variantOf(form.get("large"), LOGO_BOXES.large, LOGO_VARIANT_TYPES, "A logo's variants are PNG images");
  if (large && "error" in large) return large;
  const small = await variantOf(form.get("small"), LOGO_BOXES.small, LOGO_VARIANT_TYPES, "A logo's variants are PNG images");
  if (small && "error" in small) return small;
  return { file, contentType, variants: large && small && isVariable(contentType) ? [large, small] : [] };
}

/** The type `file`'s bytes say it is, as Marcel reads them, with its name and declared type to go by too. */
async function typeOf(file: File): Promise<string> {
  const sniffed = new Uint8Array(await file.slice(0, SNIFFED_BYTES).arrayBuffer());
  return identify(sniffed, sanitizedFilename(file.name), file.type);
}

/**
 * The variant a form's part `sent` brings, which is to fit within `box` and be one of `types` by its
 * bytes, null when it brings none, or why it's refused, `wrongType` when its bytes aren't one of them.
 */
async function variantOf(sent: ReturnType<FormData["get"]>, box: number, types: Set<string>, wrongType: string): Promise<Variant | PictureRefusal | null> {
  if (sent === null) return null;
  if (!(sent instanceof File)) return { status: 400, error: "A variant is a picture" };
  const bytes = new Uint8Array(await sent.arrayBuffer());
  const contentType = byMagic(bytes) ?? "";
  const size = types.has(contentType) ? imageSize(bytes, contentType) : null;
  if (!size) return { status: 415, error: wrongType };
  if (size.width > box || size.height > box) return { status: 422, error: `A variant fits within ${box}×${box}` };
  return { box, bytes, contentType };
}

/** Has R2 keep `picture` at `key`, its variants beside it, answering it as stored. */
export async function storePicture(files: R2Bucket, key: string, { file, contentType, variants }: PictureUpload): Promise<StoredPicture> {
  await Promise.all([
    files.put(key, file, { httpMetadata: { contentType } }),
    ...variants.map(({ box, bytes, contentType }) => files.put(variantKey(key, box), bytes, { httpMetadata: { contentType } })),
  ]);
  return { key, variant: variants[0]?.contentType ?? null };
}
