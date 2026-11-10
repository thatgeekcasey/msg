/**
 * Where the Worker draws `url` as a QR code: `/qr_code/` and the URL's UTF-8 as padded URL-safe base64,
 * as Campfire's `link_to_zoom_qr_code` writes it.
 */
export function qrCodePath(url: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(url)) binary += String.fromCharCode(byte);
  return `/qr_code/${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_")}`;
}

/**
 * `url`'s QR code drawn in the page, as the Worker draws it, for a link whose address mustn't reach the
 * Worker, as a sign-in link's mustn't. What draws it loads the first time one's drawn. Fails for text
 * too long for any QR code, which no link of Ember's is.
 */
export async function drawnQrCode(url: string): Promise<Blob> {
  const { qrCodeSvg } = await import("@ember/protocol/qr-code");
  const svg = qrCodeSvg(new TextEncoder().encode(url));
  if (svg === null) throw new RangeError("Too long for a QR code");
  // The Worker's type, so Share names it as it does the Worker's.
  return new Blob([svg], { type: "image/svg+xml; charset=utf-8" });
}
