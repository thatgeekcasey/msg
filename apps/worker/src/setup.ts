import {
  isPasswordTooLong,
  isPasswordTooShort,
  parseSignUp,
  PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT,
  type NewWorkspace,
  type SetupAccess,
  type SetupPlaceholders,
} from "@ember/protocol";
import { clientOf, newSessionToken, sessionCookie, tokenDigest } from "./auth";
import { userFormOf, userFormPhoto } from "./avatars";
import type { Env } from "./env";
import { notFound } from "./error-pages";
import { isLoopbackHost } from "./headers";
import { appPage, empty, formAnswer, home, signUpRefusal } from "./pages";
import { passwordHasher } from "./passwords";
import { urlOf } from "./request-url";
import { bearerTokenOf, isSecretToken, isToken, secretOf } from "./secrets";
import { workspace } from "./workspace";

// First run, which creates the workspace and its first administrator, at Campfire's paths, except that
// the form posts to /api/first_run. Whoever deployed Ember sets it up, and nobody else. Deploy to
// Cloudflare's form asks them to make up a setup password, EMBER_SETUP_PASSWORD, which the Set up Ember
// page asks for. A deploy from a terminal makes EMBER_SETUP_TOKEN instead, for a Worker with neither, and
// prints the setup link that ends in it (apps/worker/scripts/deploy.ts), which the page reads off the
// address's fragment. The page sends either as the form's bearer token, so the first stranger to find a
// new deployment can't make themselves its administrator. A setup password of any length opens setup,
// since the deploy form can't ask for a longer one, and tries at one count against a limit for the whole
// deployment, so nobody can guess it quickly. There's no cookie, lock or expiry: setup closes once an
// administrator exists, which is all a setup password or link needs. Over loopback, where
// `wrangler dev` serves and nobody on the Internet can reach, a deployment with neither is open, as
// Campfire is.

/** What `POST /api/first_run` answers without the setup password, where the deployment has one. */
export const SETUP_PASSWORD_NEEDED = "Type the setup password you gave Ember when you deployed it";
/** What it answers to one that isn't the deployment's. */
export const SETUP_PASSWORD_REFUSED = "That isn't this Ember's setup password";
/** What it answers without the setup link's token, where the deployment has a token and no setup password. */
export const SETUP_LINK_NEEDED = "Open the setup link the deploy printed to set up Ember";
/** What it answers to a token that isn't this deployment's. */
export const SETUP_LINK_REFUSED = "This setup link isn't this deployment's. Open the one its latest deploy printed";
/** What it answers past the deployment's limit of tries at its setup password. */
export const SETUP_TRIES_LIMITED = "Too many tries at the setup password. Please wait a few minutes and try again.";
/** What it answers while the deployment has neither a setup password nor a setup token. */
export const NO_SETUP_PASSWORD = "This deployment has no setup password, so nobody can set it up until it's given one";
/** What setup answers once Ember is set up. */
const ALREADY_SET_UP = { error: "Ember is already set up", redirect: "/" };

/**
 * What the Set up Ember form suggests, as `/api/bootstrap` tells the app: the deployment's own name and
 * email address, else Kevin Rose's. A blank setting counts as unset.
 */
export const setupPlaceholdersOf = (env: Env): SetupPlaceholders => ({
  name: env.EMBER_SETUP_NAME_PLACEHOLDER?.trim() || "Kevin Rose",
  emailAddress: env.EMBER_SETUP_EMAIL_PLACEHOLDER?.trim() || "kevin@kevinrose.com",
});

/** What opens setup on a deployment: the setup passwords the page asks for, and the token a setup link carries. */
interface SetupSecrets {
  passwords: string[];
  token: string | null;
}

/**
 * What opens setup on this deployment. EMBER_SETUP_PASSWORD is a setup password, and so is
 * EMBER_SETUP_TOKEN set to a password of someone's own, as one typed into the dashboard may be, rather
 * than to a token as a deploy makes them.
 */
function setupSecretsOf(env: Env): SetupSecrets {
  const token = secretOf(env.EMBER_SETUP_TOKEN);
  return {
    passwords: [secretOf(env.EMBER_SETUP_PASSWORD), isSecretToken(token) ? undefined : token].filter((secret) => secret !== undefined),
    token: isSecretToken(token) ? token : null,
  };
}

/**
 * How setup can be reached from `request`, as `/api/bootstrap` tells the app: with the deployment's setup
 * password, with its setup link, open to whoever is here (over loopback, with neither set), or by nobody,
 * while it has neither.
 */
export function setupAccessOf(request: Request, env: Env): SetupAccess {
  const { passwords, token } = setupSecretsOf(env);
  if (passwords.length > 0) return "password";
  if (token !== null) return "link";
  return isLoopbackHost(request) ? "open" : "closed";
}

/**
 * The setup password or token `request` brings as its bearer token, each way it may mean it, or none
 * without one: decoded, as the page sends it percent-encoded, since a header can't hold every character a
 * password can, and as it came, from a client that doesn't encode it. The spaces around it count for no
 * more than those around the deployment's own.
 */
function setupSecretsGivenBy(request: Request): string[] {
  const given = bearerTokenOf(request).trim();
  if (!given) return [];
  let decoded = given;
  try {
    decoded = decodeURIComponent(given).trim();
  } catch {
    // Not encoded as the page encodes it, so only as it came.
  }
  return decoded === given ? [given] : [decoded, given];
}

/** Whether any of `given` is one of `secrets`, each compared in constant time. */
async function isOneOf(given: string[], secrets: string[]): Promise<boolean> {
  return (await Promise.all(given.flatMap((value) => secrets.map((secret) => isToken(value, secret))))).includes(true);
}

/**
 * Why `request` may not set Ember up, or null where it brings this deployment's setup token or password,
 * or setup is open to it. A token is too long to guess, so it opens setup whatever the tries at the
 * password, while each try at a password counts against the deployment's limit before it's checked, so
 * tries sent at once count as surely as tries sent one by one.
 */
async function setupRefusal(request: Request, env: Env): Promise<Response | null> {
  const { passwords, token } = setupSecretsOf(env);
  if (passwords.length === 0 && token === null) return isLoopbackHost(request) ? null : formAnswer({ error: NO_SETUP_PASSWORD }, 403);
  const given = setupSecretsGivenBy(request);
  if (given.length === 0) return formAnswer({ error: passwords.length > 0 ? SETUP_PASSWORD_NEEDED : SETUP_LINK_NEEDED }, 403);
  if (token !== null && (await isOneOf(given, [token]))) return null;
  if (passwords.length === 0) return formAnswer({ error: SETUP_LINK_REFUSED }, 403);
  if (!(await workspace(env).trySetupPassword())) return formAnswer({ error: SETUP_TRIES_LIMITED }, 429);
  if (await isOneOf(given, passwords)) return null;
  return formAnswer({ error: SETUP_PASSWORD_REFUSED }, 403);
}

const isSetUp = async (env: Env) => (await workspace(env).account()) !== null;

/** `/first_run`: the Set up Ember page, which is the app's own, until the workspace exists. */
async function setupForm(request: Request, env: Env, format: string | undefined): Promise<Response> {
  // Campfire's `prevent_repeats`: once the workspace exists, setup sends everyone home.
  if (await isSetUp(env)) return home(request);
  // The form is a page, which answers 406 for `/first_run.json`.
  if (format !== undefined) return empty(406);
  const page = await appPage(request, env, "/");
  page.headers.set("Cache-Control", "no-store");
  return page;
}

/** Whether `pathname` is one of setup's pages: /first_run, anything under /first_run/, or /first_run.<format>. */
export const isSetupPath = (pathname: string) => /^\/first_run(?:$|[/.])/.test(pathname);

/** Answers a request for one of setup's pages. */
export async function setupPage(request: Request, env: Env): Promise<Response> {
  const { pathname } = urlOf(request);
  const form = pathname.match(/^\/first_run(?:\.(.+))?$/);
  if (form && (request.method === "GET" || request.method === "HEAD")) return setupForm(request, env, form[1]);
  return notFound(request);
}

/**
 * `POST /api/first_run/check`: whether the request's bearer token opens setup, so the Set up Ember page
 * can say a setup password is wrong before the rest of its form is filled in. It answers 204 where it
 * does, or where setup is open to the request, and otherwise refuses it as `POST /api/first_run` would,
 * counting a try at the password against the same limit.
 */
export async function checkSetup(request: Request, env: Env): Promise<Response> {
  const refused = await setupRefusal(request, env);
  if (refused) return refused;
  if (await isSetUp(env)) return formAnswer(ALREADY_SET_UP, 409);
  return empty(204);
}

/**
 * `POST /api/first_run`: creates the workspace with the person the Set up Ember form describes as its
 * first administrator, with the photo it brings, and signs this browser in as them.
 */
export async function firstRun(request: Request, env: Env): Promise<Response> {
  // Before the form is read, let alone anything hashed or saved: only the setup password or link opens setup.
  const refused = await setupRefusal(request, env);
  if (refused) return refused;
  if (await isSetUp(env)) return formAnswer(ALREADY_SET_UP, 409);

  const sent = await userFormOf(request);
  if ("error" in sent) return formAnswer({ error: sent.error, field: "avatar" }, sent.status);
  const form = parseSignUp(sent.fields);
  if (typeof form === "string") return signUpRefusal(form);
  // Before anything is hashed or saved. Unlike bcrypt, which ignores all but a password's first 72
  // bytes, scrypt hashes every character, so the server takes no more than the form can send.
  if (isPasswordTooLong(form.password)) return formAnswer({ error: PASSWORD_TOO_LONG, field: "password" }, 422);
  if (isPasswordTooShort(form.password)) return formAnswer({ error: PASSWORD_TOO_SHORT, field: "password" }, 422);
  const avatar = await userFormPhoto(env, sent.photo);
  if (avatar && "error" in avatar) return formAnswer({ error: avatar.error, field: "avatar" }, avatar.status);

  const passwordDigest = await passwordHasher(env).hash(form.password);
  const token = newSessionToken();
  const administrator = { name: form.name, emailAddress: form.emailAddress, passwordDigest, avatar };
  const created = await workspace(env).createWorkspace(administrator, await tokenDigest(token, env.SESSION_SECRET), clientOf(request));
  // Another first run finished first, so this one goes home without signing in.
  if (!created) return formAnswer(ALREADY_SET_UP, 409);
  return formAnswer(created satisfies NewWorkspace, 201, sessionCookie(request, token));
}
