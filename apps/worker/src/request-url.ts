// A request's URL, parsed once however many places read it. Every answer reads it several times,
// for its path, its host and whether it came over HTTPS, and profiles showed the parsing taking about
// a sixth of a health check's JavaScript in the Worker. It's kept on the request itself, not in
// a WeakMap: V8 traces a WeakMap's entries at every collection, and with one for each short-lived
// request, profiles showed a room open's garbage collection nearly doubling.

const PARSED = Symbol("parsed URL");

/** `request.url`, parsed. Every reader shares it, so it's read-only: make a new URL to change one. */
export function urlOf(request: Request): URL {
  return ((request as Request & { [PARSED]?: URL })[PARSED] ??= new URL(request.url));
}
