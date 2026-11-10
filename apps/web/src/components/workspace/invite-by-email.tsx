import { useState, type FormEvent } from "react";
import { emailAddressesIn, INVITATION_DAYS, INVITATIONS_AT_ONCE, NO_EMAIL_ADDRESSES, type EmailInvitation, type InvitationOutcome } from "@ember/protocol";
import { FIELD_INPUT, Field } from "@/components/field";
import { useMounted } from "@/hooks/use-mounted";
import { ApiError, inviteByEmail, isSignedOut, resendInvitation, revokeInvitation } from "@/lib/api";
import { dateLabel } from "@/lib/messages";
import { cn } from "@/lib/utils";
import { CopyButton, ROUND_BUTTON } from "./link-buttons";

// The Invite by email card in Membership, for administrators, whichever ways to join are on: email
// addresses to invite, which it sends `INVITATIONS_AT_ONCE` at a time, and the invitations no one has
// accepted yet, each to send again or revoke. While Ember can't email them, it holds each new link for
// the administrator to copy, since the server keeps only their digests. Laid out as the Email card is.

/** What revoking an invitation asks first. */
export const CONFIRM_REVOKE = "Are you sure you want to revoke this invitation? Its link will stop working.";

/** The card's buttons, as the Email card's are. */
const BUTTON = "inline-flex min-h-11 items-center justify-center rounded-[9px] border bg-background px-3.5 py-2.5 font-medium disabled:opacity-50";
const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** What came of the last invitations sent: sending, or each address's outcome, or what wasn't an address. */
type Sent = "sending" | { outcomes: InvitationOutcome[] } | { refused: string[] };

interface Props {
  invitations: EmailInvitation[];
  /** Whether Ember emails invitations, as it does while it can send email and has a From address. */
  emails: boolean;
  /** Opens Set up email. */
  onSetUpEmail: () => void;
  /** Changes the invitations workspace settings holds as `change` says. */
  onInvitationsChanged: (change: (invitations: EmailInvitation[]) => EmailInvitation[]) => void;
  /** Says why sending, sending again or revoking failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Newest first, as the server lists them: by when their links were made, then by their sortable ids. */
const newestFirst = (a: EmailInvitation, b: EmailInvitation) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1);

/** `invitations` with each of `saved` in place of what it was, newest first. */
const withSaved = (invitations: EmailInvitation[], saved: EmailInvitation[]) => {
  const ids = new Set(saved.map(({ id }) => id));
  return [...saved, ...invitations.filter(({ id }) => !ids.has(id))].sort(newestFirst);
};

/** `count` of `thing`, with an s for more than one. */
const counted = (count: number, thing: string) => `${count} ${thing}${count === 1 ? "" : "s"}`;

/** Invitations by email, for administrators: addresses to invite, and the invitations waiting to be accepted. */
export function InviteByEmail({ invitations, emails, onSetUpEmail, onInvitationsChanged, onFailed }: Props) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState<Sent | null>(null);
  // The links of the invitations Ember didn't email, by their ids, since only now are they known.
  const [links, setLinks] = useState<Record<string, string>>({});
  const mounted = useMounted();
  // While it sends, the addresses and each invitation's buttons wait, since its answer would undo what was typed or done meanwhile.
  const sending = sent === "sending";

  /** Keeps what came of `invitation`'s newest link: the link itself, if Ember didn't email it, or nothing. */
  const keepLink = (links: Record<string, string>, invitation: EmailInvitation, link: string | null) => {
    const { [invitation.id]: _, ...others } = links;
    return link === null ? others : { ...others, [invitation.id]: link };
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const { emailAddresses, refused } = emailAddressesIn(text);
    if (refused.length > 0 || emailAddresses.length === 0) return setSent({ refused });
    setSent("sending");
    const outcomes: InvitationOutcome[] = [];
    try {
      for (let start = 0; start < emailAddresses.length; start += INVITATIONS_AT_ONCE) {
        const answered = await inviteByEmail(emailAddresses.slice(start, start + INVITATIONS_AT_ONCE));
        outcomes.push(...answered);
        const invited = answered.flatMap((outcome) => ("invitation" in outcome ? [outcome] : []));
        onInvitationsChanged((invitations) => withSaved(invitations, invited.map(({ invitation }) => invitation)));
        if (mounted.current) setLinks((links) => invited.reduce((links, { invitation, link }) => keepLink(links, invitation, link), links));
      }
      if (!mounted.current) return;
      setText("");
      setSent({ outcomes });
    } catch (error) {
      if (!mounted.current && !isSignedOut(error)) return;
      // What was invited before it failed stays, with the rest left in the box to send again.
      setText(emailAddresses.filter((address) => !outcomes.some((outcome) => outcome.emailAddress === address)).join("\n"));
      setSent(outcomes.length > 0 ? { outcomes } : null);
      onFailed(error);
    }
  };

  const sentAgain = (invitation: EmailInvitation, link: string | null) => {
    onInvitationsChanged((invitations) => withSaved(invitations, [invitation]));
    setLinks((links) => keepLink(links, invitation, link));
  };
  const gone = (id: string) => {
    onInvitationsChanged((invitations) => invitations.filter((invitation) => invitation.id !== id));
    setLinks(({ [id]: _, ...others }) => others);
  };

  return (
    <section aria-labelledby="invite-by-email-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div>
        <h2 id="invite-by-email-heading" className="text-base font-semibold">
          Invite by email
        </h2>
        <p className={NOTE}>
          {emails ? (
            `Ember emails each person a link to join with their address, whichever ways to join are on. A link works once, for ${INVITATION_DAYS} days.`
          ) : (
            <>
              Ember can't send email yet, so you'll get each person's link to send them yourself. A link works once, for {INVITATION_DAYS} days.{" "}
              <button type="button" onClick={onSetUpEmail} className="cursor-pointer underline">
                Set up email
              </button>{" "}
              to have Ember send them.
            </>
          )}
        </p>
      </div>
      <form onSubmit={(event) => void send(event)} className="flex flex-col items-start gap-3">
        <div className="w-full">
          <Field id="invitation_email_addresses" label="Email addresses">
            {/* As the profile's bio is: three rows, which can be made taller. */}
            <textarea
              id="invitation_email_addresses"
              rows={3}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="ann@example.com, bob@example.com"
              value={text}
              disabled={sending}
              aria-invalid={sent !== null && !sending && "refused" in sent}
              aria-describedby="invitation-outcome"
              onChange={(event) => setText(event.target.value)}
              className={cn("w-full border placeholder:text-muted-foreground", FIELD_INPUT, "resize-y")}
            />
          </Field>
        </div>
        <button type="submit" disabled={sending} className={BUTTON}>
          {emails ? "Send invitations" : "Create invite links"}
        </button>
      </form>
      <Outcome id="invitation-outcome" sent={sent} emails={emails} />
      {invitations.length > 0 && (
        <section aria-labelledby="pending-invitations-heading" className="flex flex-col">
          <h3 id="pending-invitations-heading" className="border-b pb-2 font-semibold">
            Pending invitations
          </h3>
          <ul>
            {invitations.map((invitation) => (
              <PendingInvitation
                key={invitation.id}
                invitation={invitation}
                link={links[invitation.id] ?? null}
                emails={emails}
                sending={sending}
                onSentAgain={sentAgain}
                onGone={gone}
                onFailed={onFailed}
              />
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

/** What came of the last invitations sent, or why they weren't, said as it's known. */
function Outcome({ id, sent, emails }: { id: string; sent: Sent | null; emails: boolean }) {
  const negative = sent !== null && sent !== "sending" && "refused" in sent;
  return (
    <p id={id} role="status" className={cn("wrap-anywhere", negative && "text-negative")}>
      {sent === "sending" ? (emails ? "Sending invitations…" : "Making invite links…") : sent !== null && ("refused" in sent ? refusalOf(sent.refused) : summaryOf(sent.outcomes))}
    </p>
  );
}

/** Why nothing was sent: the words that weren't email addresses, or that there were none. */
function refusalOf(refused: string[]): string {
  if (refused.length === 0) return `${NO_EMAIL_ADDRESSES}.`;
  return `${refused.length === 1 ? "This isn't an email address" : "These aren't email addresses"}: ${refused.join(", ")}. Fix or remove ${refused.length === 1 ? "it" : "them"}, then send again.`;
}

/** What came of each address invited, in a sentence or three. */
function summaryOf(outcomes: InvitationOutcome[]): string {
  const invited = outcomes.flatMap((outcome) => ("invitation" in outcome ? [outcome] : []));
  const emailed = invited.filter(({ invitation }) => invitation.delivery === "sent").length;
  const notEmailed = invited.filter(({ invitation }) => invitation.delivery !== "sent");
  const members = outcomes.flatMap((outcome) => ("member" in outcome ? [outcome.emailAddress] : []));
  return [
    emailed > 0 && `Sent ${counted(emailed, "invitation")}.`,
    notEmailed.length > 0 &&
      (notEmailed.some(({ invitation }) => invitation.delivery !== null)
        ? `${counted(notEmailed.length, "invitation")} couldn't be emailed. Copy ${notEmailed.length === 1 ? "its link" : "their links"} below to send yourself.`
        : `Made ${counted(notEmailed.length, "invite link")}. Copy each below and send it yourself.`),
    members.length > 0 && `${members.join(", ")} ${members.length === 1 ? "has an account" : "have accounts"} already.`,
  ]
    .filter(Boolean)
    .join(" ");
}

interface PendingProps {
  invitation: EmailInvitation;
  /** Its newest link, while Ember didn't email it and the page knows it, or null. */
  link: string | null;
  emails: boolean;
  /** Whether the card is sending invitations, so its buttons wait. */
  sending: boolean;
  onSentAgain: (invitation: EmailInvitation, link: string | null) => void;
  /** Called once it's been revoked, or found accepted or revoked already. */
  onGone: (id: string) => void;
  onFailed: (error: unknown) => void;
}

/** An invitation no one has accepted: whom it's for, who sent it, whether it was emailed, when it stops working, and its buttons. */
function PendingInvitation({ invitation, link, emails, sending, onSentAgain, onGone, onFailed }: PendingProps) {
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();
  const { id, emailAddress, invitedBy, expiresAt, delivery } = invitation;
  const expired = Date.parse(expiresAt) <= Date.now();

  /** Asks the server to `act` on the invitation, then calls `done` with its answer, or `onGone` once it's gone. */
  const ask = <T,>(act: () => Promise<T>, done: (answer: T) => void) => {
    setBusy(true);
    act().then(
      (answer) => {
        done(answer);
        if (mounted.current) setBusy(false);
      },
      (error: unknown) => {
        if (mounted.current) setBusy(false);
        if (error instanceof ApiError && error.status === 404) return onGone(id);
        if (mounted.current || isSignedOut(error)) onFailed(error);
      },
    );
  };

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b py-3 last:border-b-0">
      <div className="min-w-0 flex-1 basis-[16em]">
        <strong className="wrap-anywhere">{emailAddress}</strong>
        <p className={NOTE}>
          {delivery === "sent" ? "Emailed" : delivery === null ? "Not emailed" : <span className="text-negative">Not emailed: {delivery.refusal}</span>}
          {` · Invited by ${invitedBy} · ${expired ? "Expired" : "Expires"} ${dateLabel(new Date(expiresAt))}`}
        </p>
      </div>
      <div className="flex items-center gap-[1ch]">
        {link !== null && <CopyButton text={link} label={`Copy the invite link for ${emailAddress}`} className={ROUND_BUTTON} />}
        <button
          type="button"
          disabled={busy || sending}
          onClick={() => ask(() => resendInvitation(id), ({ invitation, link }) => onSentAgain(invitation, link))}
          aria-label={`${emails ? "Send again" : "New link"} for ${emailAddress}`}
          className={BUTTON}
        >
          {emails ? "Send again" : "New link"}
        </button>
        <button
          type="button"
          disabled={busy || sending}
          onClick={() => confirm(CONFIRM_REVOKE) && ask(() => revokeInvitation(id), () => onGone(id))}
          aria-label={`Revoke the invitation for ${emailAddress}`}
          className={BUTTON}
        >
          Revoke
        </button>
      </div>
    </li>
  );
}
