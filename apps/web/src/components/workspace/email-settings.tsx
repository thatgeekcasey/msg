import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Account, EmailSettings as Email } from "@ember/protocol";
import { useMounted } from "@/hooks/use-mounted";
import { ApiError, changeAccount, isSignedOut, sendTestEmail } from "@/lib/api";
import { cn } from "@/lib/utils";

// The Email card in Membership, for administrators: what Ember sends email with, and from, and Send me a
// test email, which says where it went, or why it wasn't sent. Until Ember can send email, it says so,
// and Set up email opens the steps to it (`EmailSetup`), as Change does once it can, and Stop sending
// email takes its From address away, as saving the From field blank did before Set up email. Laid out as
// Custom domain's card is: what it says, then its buttons in a row.

/** What Stop sending email asks first, since what Ember emails stops until email is set up again. */
export const CONFIRM_STOP_EMAIL =
  "Are you sure you want Ember to stop sending email? It will forget its From address, and won't email invitations, the links people at your email domains join with, or codes to reset a forgotten password, until email is set up again.";

/** The card's buttons, as Custom domain's are. */
export const BUTTON = "inline-flex min-h-11 items-center justify-center rounded-[9px] border bg-background px-3.5 py-2.5 font-medium disabled:opacity-50";
const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** Whether Ember can send email: it has something to send it with, and a From address. */
export const sendsEmail = (email: Email) => email.provider !== null && email.from !== null;

/** What the card says Ember sends email with. */
function sentWith({ provider, resendKey }: Email): string {
  if (provider === "cloudflare") return "with Cloudflare Email Service";
  return resendKey === "secret" ? "with Resend, with the API key in RESEND_API_KEY" : "with Resend";
}

/** What came of Send me a test email: sending, sent to an address, or refused with why. */
type Tested = "sending" | { to: string } | { refusal: string };

interface Props {
  email: Email;
  /** As workspace settings asks for the workspace, which it says the server answers with. */
  askForAccount: () => (account: Account) => void;
  /** Opens Set up email. */
  onSetUp: () => void;
  /** Shows that Ember has no From address, once Stop sending email has taken it away. */
  onStopped: () => void;
  /** Says why sending or stopping failed, when it isn't the provider's or the setup's doing, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** How Ember sends email, for administrators: what with, and from, with a test email, or else that it can't yet. */
export function EmailSettings({ email, askForAccount, onSetUp, onStopped, onFailed }: Props) {
  const sends = sendsEmail(email);
  const [stopping, setStopping] = useState(false);
  const mounted = useMounted();

  const stop = () => {
    if (!confirm(CONFIRM_STOP_EMAIL)) return;
    setStopping(true);
    const answered = askForAccount();
    changeAccount({ emailFrom: null }).then(
      (account) => {
        answered(account);
        onStopped();
        if (mounted.current) setStopping(false);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setStopping(false);
        onFailed(error);
      },
    );
  };

  return (
    <section aria-labelledby="email-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div>
        <h2 id="email-heading" className="text-base font-semibold">
          Email
        </h2>
        <p className={NOTE}>
          {sends ? (
            <>
              Ember sends email from <span className="wrap-anywhere">{email.from}</span> {sentWith(email)}.
            </>
          ) : (
            "Ember can't send email yet, so it can't email invitations, the links people at your email domains join with, or codes to reset a forgotten password."
          )}
        </p>
      </div>
      {/* A test email says how it went with the From address it was sent from. */}
      {sends ? (
        <TestEmail key={email.from} onFailed={onFailed}>
          <button type="button" onClick={onSetUp} disabled={stopping} className={BUTTON}>
            Change
          </button>
          <button type="button" onClick={stop} disabled={stopping} className={BUTTON}>
            Stop sending email
          </button>
        </TestEmail>
      ) : (
        <div>
          <button type="button" onClick={onSetUp} className={BUTTON}>
            Set up email
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Send me a test email, from the From address as it's saved, with the buttons in `children` beside it,
 * then where it went, or why it wasn't sent, sending one `atOnce` as it's shown, as Set up email's last
 * step does.
 */
export function TestEmail({ onFailed, atOnce = false, children }: { onFailed: (error: unknown) => void; atOnce?: boolean; children?: ReactNode }) {
  const [test, setTest] = useState<Tested | null>(null);
  const mounted = useMounted();
  const sentAtOnce = useRef(false);

  const sendTest = () => {
    setTest("sending");
    sendTestEmail().then(
      (to) => {
        if (mounted.current) setTest({ to });
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        // The provider's refusal, or what setting up has left to do, which it says itself.
        if (error instanceof ApiError && [422, 502, 503].includes(error.status)) return setTest({ refusal: error.message });
        setTest(null);
        onFailed(error);
      },
    );
  };

  // Once, though development's strict mode runs effects twice.
  useEffect(() => {
    if (!atOnce || sentAtOnce.current) return;
    sentAtOnce.current = true;
    sendTest();
  }, [atOnce]);

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={sendTest} disabled={test === "sending"} className={BUTTON}>
          Send me a test email
        </button>
        {children}
      </div>
      <p
        role="status"
        className={cn("mt-2 wrap-anywhere empty:mt-0", test !== null && test !== "sending" && ("to" in test ? "text-positive" : "text-negative"))}
      >
        {test === "sending"
          ? "Sending a test email…"
          : test !== null && ("to" in test ? `Sent to ${test.to}. If it isn't in your inbox, look in spam.` : test.refusal)}
      </p>
    </div>
  );
}
