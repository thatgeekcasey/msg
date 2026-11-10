import {
  CANT_EMAIL_CODES,
  isPasswordTooLong,
  isPasswordTooShort,
  parsePasswordResetRequest,
  parsePasswordResetWithCode,
  PASSWORD_RESET_CODE_DIGITS,
  PASSWORD_RESET_CODE_WRONG,
  PASSWORD_RESET_LIMITED,
  PASSWORD_RESETS_LIMITED,
  PASSWORD_TOO_LONG,
  PASSWORD_TOO_SHORT,
  TURNSTILE_FAILED,
  type PasswordResetDone,
} from "@ember/protocol";
import { clientOf, newSessionToken, sessionCookie, tokenDigest } from "./auth";
import { jsonBodyOf } from "./bodies";
import type { Env } from "./env";
import { digits } from "./ids";
import { appPage, empty, formAnswer } from "./pages";
import { passwordHasher } from "./passwords";
import { passedTurnstile, turnstileKeysFor } from "./turnstile";
import { workspace, type NewResetCode } from "./workspace";

// Resetting a forgotten password with a code Ember emails: someone asks for a code with their email
// address, which Ember emails them if they have an account and a password, and gives the code back with
// a new password, which signs them in. Asking checks Turnstile while Ember has a widget's keys, and
// neither answer, nor how soon it comes, says who has an account. Like the sign-in page, the page and
// its forms are for anyone, signed in or not.

/**
 * `GET /passwords/new`: the app's page for resetting a password, which no cache keeps, since its policy
 * lets Turnstile's check load while Ember has a widget's keys.
 */
export async function passwordResetPage(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return empty(404);
  const page = await appPage(request, env, "/", { turnstile: (await turnstileKeysFor(env)) !== null });
  page.headers.set("Cache-Control", "no-store");
  return page;
}

/**
 * What the Workspace keeps in place of a code: its HMAC under SESSION_SECRET, as a session token's is
 * kept, of the code named as one, so that no other secret's digest can stand for it.
 */
const resetCodeDigest = (code: string, env: Env) => tokenDigest(`password reset code ${code}`, env.SESSION_SECRET);

/** A new code for Ember to email: `PASSWORD_RESET_CODE_DIGITS` random digits, and its digest. */
async function newResetCode(env: Env): Promise<NewResetCode> {
  const code = digits(PASSWORD_RESET_CODE_DIGITS);
  return { code, digest: await resetCodeDigest(code, env) };
}

/**
 * `POST /api/password_resets`, `{ emailAddress, turnstileToken? }`: emails a code to reset their password
 * to whoever has the address, if anyone, answering 202 before it's emailed, and whether or not anyone has
 * it. Turnstile's check comes first, while Ember has a widget's keys, and else the network's limit,
 * which stands in for it. It answers 503 while Ember can't send email.
 */
export async function askForPasswordReset(request: Request, env: Env): Promise<Response> {
  const asked = parsePasswordResetRequest(await jsonBodyOf(request));
  if (typeof asked === "string") return formAnswer({ error: asked, field: "emailAddress" }, 422);
  const client = clientOf(request);
  const turnstile = await turnstileKeysFor(env);
  if (turnstile && !(await passedTurnstile(env, turnstile.secretKey, asked.turnstileToken, client.ip))) {
    return formAnswer({ error: TURNSTILE_FAILED, field: "turnstile" }, 422);
  }
  // Turnstile's check stops the scripts the network's limit guards against, so it holds only without its keys.
  const outcome = await workspace(env).askForPasswordReset(client.ip ?? "unknown", asked.emailAddress, await newResetCode(env), turnstile === null);
  if (outcome === "unsendable") return formAnswer({ error: CANT_EMAIL_CODES }, 503);
  if (outcome === "limited") return formAnswer({ error: PASSWORD_RESETS_LIMITED }, 429);
  return formAnswer({}, 202);
}

/** What a new password with a code that doesn't work answers, whatever the reason. */
const codeWrong = () => formAnswer({ error: PASSWORD_RESET_CODE_WRONG, field: "code" }, 422);

/**
 * `PUT /api/password_resets`, `{ emailAddress, code, password }`: gives whoever has the address the new
 * password, with the code Ember emailed them, spending it, ending all their sessions, and signs this
 * browser in as them (201), unless they sign in themselves (200). The code is checked, counting against
 * sign-in's limit, before the password is hashed, and one that doesn't work answers 422 on its field,
 * the same whether or not anyone has the address.
 */
export async function resetPasswordWithCode(request: Request, env: Env): Promise<Response> {
  const reset = parsePasswordResetWithCode(await jsonBodyOf(request));
  if ("error" in reset) return formAnswer(reset, reset.field ? 422 : 400);
  if (isPasswordTooLong(reset.password)) return formAnswer({ error: PASSWORD_TOO_LONG, field: "password" }, 422);
  if (isPasswordTooShort(reset.password)) return formAnswer({ error: PASSWORD_TOO_SHORT, field: "password" }, 422);
  const client = clientOf(request);
  const codeDigest = await resetCodeDigest(reset.code, env);
  const checked = await workspace(env).beginPasswordReset(client.ip ?? "unknown", reset.emailAddress, codeDigest);
  if (checked === "limited") return formAnswer({ error: PASSWORD_RESET_LIMITED }, 429);
  if (checked === "wrong") return codeWrong();

  const token = newSessionToken();
  const passwordDigest = await passwordHasher(env).hash(reset.password);
  const user = await workspace(env).resetPasswordWithCode(reset.emailAddress, codeDigest, passwordDigest, await tokenDigest(token, env.SESSION_SECRET), client);
  if (user === "wrong") return codeWrong();
  if (user === null) return formAnswer({ user } satisfies PasswordResetDone, 200);
  return formAnswer({ user } satisfies PasswordResetDone, 201, sessionCookie(request, token));
}
