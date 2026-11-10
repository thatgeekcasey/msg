// Where reset-password.ts and check-deploy.ts may send the Worker's recovery token, which can take
// over any account, and seed.ts its setup token and everyone's password.

/** The Worker's address, if it's HTTPS, or plain HTTP on this machine, where `wrangler dev` serves. */
export function workerUrl(given: string): URL | null {
  if (!URL.canParse(given)) return null;
  const url = new URL(given);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "https:" || (url.protocol === "http:" && local) ? url : null;
}
