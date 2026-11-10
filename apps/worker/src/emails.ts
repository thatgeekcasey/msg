import { INVITATION_DAYS, PASSWORD_RESET_CODE_MINUTES } from "@ember/protocol";
import { escapeHtml } from "./encoding";
import type { Email } from "./mail";

// The emails Ember sends, each as plain text and as simple HTML, with nothing that tracks whether it was
// opened. All an administrator wrote in them is the workspace's name, and in an invitation their own.

/** `text` on one line, as a subject must be: line breaks and other control characters become spaces. */
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

/** An email's HTML: its paragraphs, each given as HTML, in Ember's sans-serif. */
const htmlOf = (paragraphs: string[]) =>
  `<!doctype html><html><body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 16px; line-height: 1.5;">${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}</body></html>`;

/** The email Send me a test email sends an administrator, at `to`, from the workspace named `workspace`, whose Ember is at `origin`. */
export function testEmail(to: string, workspace: string, origin: string): Email {
  const name = oneLine(workspace) || "Ember";
  return {
    to,
    subject: `Test email from ${name}`,
    text: `This is a test email from ${name}, at ${origin}.\n\nIt reached you, so Ember can send email.\n`,
    html: htmlOf([`This is a test email from ${escapeHtml(name)}, at <a href="${escapeHtml(origin)}">${escapeHtml(origin)}</a>.`, "It reached you, so Ember can send email."]),
  };
}

/**
 * The email inviting `to` to join the workspace named `workspace`, from the administrator named
 * `inviter`, with `link`, the invitation's, which joins with that address once, for `INVITATION_DAYS` days.
 */
export function invitationEmail(to: string, workspace: string, inviter: string, link: string): Email {
  const name = oneLine(workspace) || "Ember";
  const who = oneLine(inviter) || "An administrator";
  const terms = (address: string) => `The link works once, for ${INVITATION_DAYS} days, and joins with ${address}. If you weren't expecting this, you can ignore it.`;
  return {
    to,
    subject: `${who} invited you to ${name}`,
    text: `${who} invited you to join ${name}.\n\nJoin here: ${link}\n\n${terms(to)}\n`,
    html: htmlOf([`${escapeHtml(who)} invited you to join ${escapeHtml(name)}.`, `<a href="${escapeHtml(link)}">Join ${escapeHtml(name)}</a>`, terms(escapeHtml(to))]),
  };
}

/**
 * The email with a link to join the workspace named `workspace` with `to`, an address at its email
 * domains, which someone asked for at `/join/email`: `link`, which joins with that address once, for an
 * hour.
 */
export function emailDomainLinkEmail(to: string, workspace: string, link: string): Email {
  const name = oneLine(workspace) || "Ember";
  const terms = (address: string) => `The link works once, for an hour, and joins with ${address}. If you didn't ask for it, you can ignore this email: nobody joins without the link.`;
  return {
    to,
    subject: `Your link to join ${name}`,
    text: `Someone asked to join ${name} with this email address.\n\nJoin here: ${link}\n\n${terms(to)}\n`,
    html: htmlOf([`Someone asked to join ${escapeHtml(name)} with this email address.`, `<a href="${escapeHtml(link)}">Join ${escapeHtml(name)}</a>`, terms(escapeHtml(to))]),
  };
}

/**
 * The email with `code`, which someone who forgot their password at the workspace named `workspace` asked
 * for with `to`, their email address there: it chooses a new password, with that address, for
 * `PASSWORD_RESET_CODE_MINUTES` minutes. The code is in the body alone, not the subject, which a locked
 * phone shows anyone.
 */
export function passwordResetCodeEmail(to: string, workspace: string, code: string): Email {
  const name = oneLine(workspace) || "Ember";
  const asked = (workspaceName: string) => `Someone asked to reset the password for this email address at ${workspaceName}.`;
  const use = `Enter it within ${PASSWORD_RESET_CODE_MINUTES} minutes, with a new password, where you asked for it. Don't give it to anyone.`;
  const ignore = "If you didn't ask, you can ignore this email: your password stays as it is.";
  return {
    to,
    subject: `Reset your password at ${name}`,
    text: `${asked(name)}\n\nYour code: ${code}\n\n${use}\n\n${ignore}\n`,
    html: htmlOf([asked(escapeHtml(name)), `Your code: <strong style="font-size: 24px; letter-spacing: 0.08em;">${code}</strong>`, use, ignore]),
  };
}

/**
 * The email someone asking to join the workspace named `workspace` with `to` gets in place of a link,
 * since the address has an account there already: `signIn`, where it signs in, so that `/join/email`
 * says the same whoever has an account.
 */
export function alreadyAMemberEmail(to: string, workspace: string, signIn: string): Email {
  const name = oneLine(workspace) || "Ember";
  const asked = (workspaceName: string) => `Someone asked to join ${workspaceName} with this email address, which has an account there already.`;
  return {
    to,
    subject: `You already have an account at ${name}`,
    text: `${asked(name)}\n\nSign in here: ${signIn}\n\nIf you didn't ask, you can ignore this email.\n`,
    html: htmlOf([asked(escapeHtml(name)), `<a href="${escapeHtml(signIn)}">Sign in to ${escapeHtml(name)}</a>`, "If you didn't ask, you can ignore this email."]),
  };
}
