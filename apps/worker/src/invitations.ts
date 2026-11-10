import { EMAIL_LINK_GONE, parseInvitationRequest, type EmailLinkFor, type Invited, type ResentInvitation } from "@ember/protocol";
import { credentialsOf, newSessionToken, tokenDigest } from "./auth";
import { jsonBodyOf } from "./bodies";
import { originFor } from "./custom-domain";
import type { Env } from "./env";
import { workspace, type NewEmailLink } from "./workspace";

// Invitations to join by email: administrators invite addresses, which Membership sends
// `INVITATIONS_AT_ONCE` at a time, give an invitation a new link, or revoke it. Each link is a secret in
// the address's fragment, which only its digest is kept in place of, and looking one up spends nothing,
// as looking up one someone asked for with an address at the workspace's email domains spends nothing.

const problem = (status: number, message: string) => Response.json({ error: message }, { status });

const NOT_SIGNED_IN = "Not signed in";
const ADMINISTRATORS_ONLY = "Only administrators can invite people";

/** A link's secret: 32 random bytes in base64url, as a session token is. */
const EMAIL_LINK_TOKEN = /^[\w-]{43}$/;

/** A new link for Ember to email: a secret, as random as a session token, and its digest under SESSION_SECRET. */
export async function newEmailLink(env: Env): Promise<NewEmailLink> {
  const token = newSessionToken();
  return { token, digest: await tokenDigest(token, env.SESSION_SECRET) };
}

/** Ember's address, where links go: its custom domain, if it has one, or else the address the request came to. */
async function emberOrigin(request: Request, env: Env): Promise<string> {
  return originFor(request, (await workspace(env).account())?.customDomain ?? null);
}

/**
 * `POST /api/invitations`: invites each address given, as an administrator, answering what came of
 * each. As changing the workspace does, it checks who's asking before what they sent.
 */
export async function invite(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, NOT_SIGNED_IN);
  const emailAddresses = parseInvitationRequest(await jsonBodyOf(request));
  const given = typeof emailAddresses === "string" ? [] : emailAddresses;
  const invitations = await Promise.all(given.map(async (emailAddress) => ({ emailAddress, link: await newEmailLink(env) })));
  const invited = await workspace(env).invite(credentials, invitations, await emberOrigin(request, env));
  if (!invited) return problem(401, NOT_SIGNED_IN);
  if (invited === "forbidden") return problem(403, ADMINISTRATORS_ONLY);
  if (typeof emailAddresses === "string") return problem(422, emailAddresses);
  // The links Ember didn't email are secrets that no one else should keep.
  return Response.json(invited satisfies Invited, { headers: { "Cache-Control": "no-store" } });
}

/** `POST /api/invitations/<id>/resend`: gives the invitation a new link, in place of its old one, and emails it, as an administrator. */
export async function resendInvitation(request: Request, env: Env, id: string): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const resent = credentials && (await workspace(env).resendInvitation(credentials, id, await newEmailLink(env), await emberOrigin(request, env)));
  if (!resent) return problem(401, NOT_SIGNED_IN);
  if (resent === "forbidden") return problem(403, ADMINISTRATORS_ONLY);
  if (resent === "not found") return problem(404, "Not found");
  return Response.json(resent satisfies ResentInvitation, { headers: { "Cache-Control": "no-store" } });
}

/** `DELETE /api/invitations/<id>`: revokes the invitation, so that its link joins no more, as an administrator. */
export async function revokeInvitation(request: Request, env: Env, id: string): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const revoked = credentials && (await workspace(env).revokeInvitation(credentials, id));
  if (!revoked) return problem(401, NOT_SIGNED_IN);
  if (revoked === "forbidden") return problem(403, ADMINISTRATORS_ONLY);
  if (revoked === "not found") return problem(404, "Not found");
  return new Response(null, { status: 204 });
}

/** The digest of the link secret `token`, or null for anything that can't be one, which no link has. */
export async function emailLinkDigest(token: unknown, env: Env): Promise<string | null> {
  return typeof token === "string" && EMAIL_LINK_TOKEN.test(token) ? tokenDigest(token, env.SESSION_SECRET) : null;
}

/**
 * `POST /api/email_links/lookup`, with a link's secret, `{ token }`, as its page sends it: what the link
 * is and whom it's for, while it works, for anyone, signed in or not, which spends nothing, or 404.
 */
export async function lookUpEmailLink(request: Request, env: Env): Promise<Response> {
  const body = await jsonBodyOf(request);
  const digest = await emailLinkDigest(typeof body === "object" && body !== null ? (body as Record<string, unknown>).token : undefined, env);
  const link = digest && (await workspace(env).emailLinkFor(digest));
  if (!link) return problem(404, EMAIL_LINK_GONE);
  return Response.json(link satisfies EmailLinkFor, { headers: { "Cache-Control": "no-store" } });
}
