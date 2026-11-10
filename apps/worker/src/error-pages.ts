import notFoundPage from "../../web/public/404.html";
import failedPage from "../../web/public/500.html";

// Campfire's error pages, from the web app's public/, which serves them as static files too. Campfire's
// have no viewport, so a phone shrinks them to fit a 980px layout and Go back is too small to tap; these
// add one, and a language. HEAD gets no body.

const page = (request: Request, status: number, html: string) =>
  new Response(request.method === "HEAD" ? null : html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

/** "We can’t find that (404)", for a path or method nothing answers. */
export const notFound = (request: Request) => page(request, 404, notFoundPage);

/** "Something went wrong (500)", for an exception. */
export const failed = (request: Request) => page(request, 500, failedPage);
