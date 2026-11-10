import { useRef, useState } from "react";
import {
  CANT_EMAIL_CODES,
  MAX_EMAIL_ADDRESS_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RESET_CODE_DIGITS,
  PASSWORD_RESET_CODE_MINUTES,
  PASSWORD_RESET_DONE,
  PASSWORD_RESET_SIGN_IN,
  withEmailAddress,
} from "@ember/protocol";
import { AuthAlternative } from "@/components/auth-alternative";
import { AUTH_FORM, AuthCard, AuthHeading, AuthPage, Problem, type SignedOutWorkspace } from "@/components/auth-page";
import { FIELD_INPUT, Field, SubmitButton } from "@/components/field";
import { TURNSTILE_UNAVAILABLE } from "@/components/join-page";
import { TurnstileCheck } from "@/components/turnstile-check";
import { Input } from "@/components/ui/input";
import { useTitle } from "@/hooks/use-title";
import { ApiError, askForPasswordResetCode, resetPasswordWithCode } from "@/lib/api";
import { loadPage } from "@/lib/page";
import { takeReturnPath } from "@/lib/return-path";

// The page for resetting a forgotten password: someone gives their email address, Ember emails them a
// code if it has an account with a password, and they give the code back here with a new password, which
// signs them in. Asking waits for Turnstile's check while Ember has a widget's keys, as asking for a
// link to join does, and nothing the page says tells who has an account.

const SIGN_IN_PATH = "/session/new";
const NO_CONNECTION = "Couldn't reach Ember. Check your connection and try again.";

/**
 * The address the page asked Ember to email a code to, which it keeps in its history entry, so that it
 * asks for the code still when the browser loads it again, as a phone's may once someone has been to
 * their email, while a new visit asks for an address afresh.
 */
function askedOnArrival(): string | null {
  const asked: unknown = (history.state as { passwordResetAsked?: unknown } | null)?.passwordResetAsked;
  return typeof asked === "string" ? asked : null;
}

/** Keeps the address the page asked Ember to email a code to in its history entry, or forgets it for null (`askedOnArrival`). */
const keepAsked = (emailAddress: string | null) => history.replaceState({ ...(history.state as object | null), passwordResetAsked: emailAddress }, "");

/** Where someone who forgot their password asks for a code, then gives it with a new password, while Ember can send email. */
export function PasswordResetPage({ workspace }: { workspace: SignedOutWorkspace }) {
  const [arrival] = useState(askedOnArrival);
  const [emailAddress, setEmailAddress] = useState(() => arrival ?? new URLSearchParams(location.search).get("email_address") ?? "");
  /** The address Ember was asked to email a code to, which the page then asks for, or null to ask for one. */
  const [asked, setAsked] = useState(arrival);

  useTitle("Reset your password");

  function changeAsked(address: string | null) {
    keepAsked(address);
    setAsked(address);
  }

  if (!workspace.passwordResetCodes) {
    return (
      <AuthPage workspace={workspace}>
        <AuthCard>
          <AuthHeading title="Reset your password" logo={workspace.account.logo}>
            {CANT_EMAIL_CODES}
          </AuthHeading>
          <AuthAlternative question="Remembered it?" action="Sign in" href={withEmailAddress(SIGN_IN_PATH, emailAddress)} />
        </AuthCard>
      </AuthPage>
    );
  }
  if (asked !== null) return <NewPassword workspace={workspace} emailAddress={asked} onAskAgain={() => changeAsked(null)} />;
  return <CodeRequest workspace={workspace} emailAddress={emailAddress} onChange={setEmailAddress} onAsked={changeAsked} />;
}

interface CodeRequestProps {
  workspace: SignedOutWorkspace;
  emailAddress: string;
  onChange: (emailAddress: string) => void;
  /** What happens once Ember has been asked to email a code to `emailAddress`, the address the form sent, whatever the field says by then. */
  onAsked: (emailAddress: string) => void;
}

/** The form asking Ember to email a code to `emailAddress`, which draws Turnstile's check afresh for each ask. */
function CodeRequest({ workspace, emailAddress, onChange, onAsked }: CodeRequestProps) {
  const { account, turnstileSiteKey: siteKey } = workspace;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The token of the check passed, which is good for one ask, and how many asks the check has been drawn for.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  async function submit() {
    setBusy(true);
    setProblem(null);
    try {
      await askForPasswordResetCode(siteKey === null ? { emailAddress } : { emailAddress, turnstileToken: turnstileToken ?? "" });
      onAsked(emailAddress);
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : NO_CONNECTION);
    } finally {
      setBusy(false);
      if (siteKey !== null) {
        setTurnstileToken(null);
        setTries((tries) => tries + 1);
      }
    }
  }

  return (
    <AuthPage workspace={workspace}>
      {problem && <Problem>{problem}</Problem>}
      <AuthCard>
        <AuthHeading title="Reset your password" logo={account.logo}>
          Enter your email address, and Ember will email you a code to choose a new password with.
        </AuthHeading>
        <form
          className={AUTH_FORM}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field id="email_address" label="Email address" translation="email_address">
            <Input
              id="email_address"
              type="email"
              required
              autoFocus
              autoComplete="username"
              placeholder="Enter your email address"
              maxLength={MAX_EMAIL_ADDRESS_LENGTH}
              value={emailAddress}
              onChange={(event) => onChange(event.target.value)}
              className={FIELD_INPUT}
            />
          </Field>
          {siteKey !== null && <TurnstileCheck key={tries} siteKey={siteKey} onToken={setTurnstileToken} onUnavailable={() => setProblem(TURNSTILE_UNAVAILABLE)} />}
          <SubmitButton disabled={busy || (siteKey !== null && turnstileToken === null)}>Email me a code</SubmitButton>
        </form>
        <AuthAlternative question="Remembered it?" action="Sign in" href={withEmailAddress(SIGN_IN_PATH, emailAddress)} />
      </AuthCard>
    </AuthPage>
  );
}

interface NewPasswordProps {
  workspace: SignedOutWorkspace;
  emailAddress: string;
  onAskAgain: () => void;
}

/**
 * The form giving the code Ember emailed to `emailAddress` with a new password, which signs in with it and
 * opens the page this tab was sent to sign in from, or else goes to sign in, as Memberful's members do
 * while it's members only. A code that doesn't work, or a password Ember won't take, is said at the top
 * of the form, as sign-in's refusals are, keeping what was typed.
 */
function NewPassword({ workspace, emailAddress, onAskAgain }: NewPasswordProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** Why the last try was refused, said at the top of the form. */
  const [refusal, setRefusal] = useState<string | null>(null);
  // Uncontrolled, as passwords are, so the code never reaches a `value` attribute either.
  const codeInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);

  async function submit() {
    setBusy(true);
    setProblem(null);
    setRefusal(null);
    try {
      const user = await resetPasswordWithCode({ emailAddress, code: codeInput.current?.value ?? "", password: passwordInput.current?.value ?? "" });
      // A new page, as signing in afresh is, keeping nothing of the session this browser may have had.
      if (user) loadPage(takeReturnPath() ?? "/", { kind: "notice", text: PASSWORD_RESET_DONE });
      else loadPage(withEmailAddress(SIGN_IN_PATH, emailAddress), { kind: "notice", text: PASSWORD_RESET_SIGN_IN });
    } catch (error) {
      setBusy(false);
      if (!(error instanceof ApiError)) return setProblem(NO_CONNECTION);
      setRefusal(error.message);
      const field = error.field === "password" ? passwordInput.current : codeInput.current;
      field?.focus();
      field?.select();
    }
  }

  return (
    <AuthPage workspace={workspace}>
      {problem && <Problem>{problem}</Problem>}
      <AuthCard>
        <AuthHeading title="Check your email" logo={workspace.account.logo}>
          If {emailAddress} has an account here, Ember emailed it a code that works for {PASSWORD_RESET_CODE_MINUTES} minutes. If it hasn't arrived soon, look in your
          spam folder.
        </AuthHeading>
        <form
          className={AUTH_FORM}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {refusal && (
            // The error, as sign-in shows it.
            <p role="alert" className="rounded-[8px] border border-auth-error-border bg-auth-error-background px-3.5 py-3 text-[14px] leading-normal text-auth-error">
              {refusal}
            </p>
          )}
          {/* So that a password manager saves the new password for this address. */}
          <input type="email" autoComplete="username" value={emailAddress} readOnly hidden />
          <Field id="code" label="Code">
            <Input
              ref={codeInput}
              id="code"
              required
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder={`${PASSWORD_RESET_CODE_DIGITS}-digit code`}
              className={FIELD_INPUT}
            />
          </Field>
          <Field id="password" label="New password" translation="password">
            <Input
              ref={passwordInput}
              id="password"
              type="password"
              required
              autoComplete="new-password"
              placeholder="New password"
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              className={FIELD_INPUT}
            />
          </Field>
          <SubmitButton disabled={busy}>Reset password</SubmitButton>
        </form>
        <AuthAlternative question="Didn't get it?" action="Send another code" onClick={onAskAgain} disabled={busy} />
      </AuthCard>
    </AuthPage>
  );
}
