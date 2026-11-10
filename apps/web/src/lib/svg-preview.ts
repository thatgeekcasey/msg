import { MAX_PREVIEW_SIZE } from "@ember/protocol";

// SVGs shown in messages. An SVG is markup that can run script and load from anywhere, but not as an
// image, so a message shows one from a data URL in an <img>, whose origin is opaque if it's opened by
// itself. Uploaded SVGs never go into the page as markup, an <object>, an <iframe> or a blob URL, which
// is this site's own origin.

/**
 * The data URL of the SVG at `url`, of up to 5 MiB, once it has decoded as a picture, or null for an
 * address on another site, a file the site doesn't answer with, a bigger one, or one that doesn't decode.
 */
export async function svgDataUrl(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const address = new URL(url, location.href);
    if (address.origin !== location.origin) return null;
    const response = await fetch(address, { signal, credentials: "same-origin" });
    if (!response.ok || !response.body || Number(response.headers.get("Content-Length")) > MAX_PREVIEW_SIZE) {
      await response.body?.cancel();
      return null;
    }
    const chunks = await readUpTo(response.body, MAX_PREVIEW_SIZE);
    if (!chunks) return null;
    const dataUrl = await asDataUrl(new Blob(chunks, { type: "image/svg+xml" }));
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    return dataUrl;
  } catch {
    return null;
  }
}

/** What `body` has, or null if it has more than `max` bytes, when it stops reading. */
async function readUpTo(body: ReadableStream<Uint8Array<ArrayBuffer>>, max: number): Promise<Uint8Array<ArrayBuffer>[] | null> {
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      length += read.value.byteLength;
      if (length > max) return null;
      chunks.push(read.value);
    }
    return chunks;
  } finally {
    await reader.cancel();
  }
}

const asDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
