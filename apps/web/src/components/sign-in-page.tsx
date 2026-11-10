import { useEffect, useRef, useState } from "react";
import {
  domainsInWords,
  EMAIL_SIGN_UP_PATH,
  MAX_PASSWORD_LENGTH,
  MEMBERFUL_CONNECTED,
  MEMBERFUL_SIGN_IN_PROBLEMS,
  memberfulSignInPath,
  PASSWORD_RESET_PATH,
  SIGN_IN_LIMITED,
  SIGN_IN_REJECTED,
  SIGN_UP_PATH,
  signsUpOpenly,
  signsUpWithEmailDomain,
  withEmailAddress,
  type Me,
} from "@ember/protocol";
import { AuthAlternative } from "@/components/auth-alternative";
import { AUTH_FORM, AuthCard, AuthHeading, AuthPage, Problem, type SignedOutWorkspace } from "@/components/auth-page";
import { FIELD_INPUT, Field, PRIMARY_BUTTON, SubmitButton } from "@/components/field";
import { GuestSignIn } from "@/components/guest-sign-in";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTitle } from "@/hooks/use-title";
import { ApiError, signIn } from "@/lib/api";
import { forgetJoiningProblem, joiningProblemOnArrival } from "@/lib/joining";
import { forgetMemberfulOutcome, memberfulOutcomeOnArrival } from "@/lib/memberful";
import { returnPath } from "@/lib/return-path";

// The sign-in page. A refused sign-in shakes the card and says why at the top of the form, in place of a
// flash, keeping the email address and emptying the password. While Memberful is members only, the card
// offers signing in with Memberful instead, and the email and password form to those who ask for it:
// administrators, and members with an account from before, whose password then asks them to connect
// their Memberful account. Otherwise, while Memberful's members sign in with it, the card links to that
// under the form. While anyone may sign up, it links to the page for that, and it says why a way to join
// that's off sent someone here. While Ember can send email, the form links to resetting a forgotten
// password with a code Ember emails.

/** What a Memberful sign-in that came back here says went wrong, as this page's address names it, if it does. */
function memberfulProblemOnArrival() {
  const outcome = memberfulOutcomeOnArrival();
  return outcome === MEMBERFUL_CONNECTED ? null : outcome;
}

/**
 * Signs in with an email address and password, or with Memberful while its members sign in with it, or
 * with just a name when the workspace allows it, or, while Memberful is members only, with Memberful, or
 * a password for administrators, which asks anyone else to connect their Memberful account until they
 * have.
 */
export function SignInPage({ workspace, onSignedIn }: { workspace: SignedOutWorkspace; onSignedIn: (me: Me) => void }) {
  const { memberfulSignIn: membersOnly } = workspace.account;
  const [arrival] = useState(memberfulProblemOnArrival);
  const [asGuest, setAsGuest] = useState(false);
  // Someone whose Memberful email address is someone's here is asked for that someone's password.
  const [withPassword, setWithPassword] = useState(!membersOnly || arrival === "taken");
  const [emailAddress, setEmailAddress] = useState(() => new URLSearchParams(location.search).get("email_address") ?? "");
  const [busy, setBusy] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(() => (arrival ? MEMBERFUL_SIGN_IN_PROBLEMS[arrival] : joiningProblemOnArrival()));
  /** Why the last sign-in was refused, said at the top of the form. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Where to connect your Memberful account, once your password has checked out but you have yet to connect one. */
  const [connection, setConnection] = useState<string | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);

  useTitle("Sign in");
  useEffect(() => {
    forgetMemberfulOutcome();
    forgetJoiningProblem();
  }, []);

  async function submit() {
    setBusy(true);
    setProblem(null);
    setRefusal(null);
    try {
      // Connecting Memberful comes back to the page this tab was sent here from, signed in.
      const answer = await signIn({ emailAddress, password: passwordInput.current?.value ?? "", returnTo: returnPath() ?? undefined });
      if (!("memberfulConnection" in answer)) return onSignedIn(answer);
      setBusy(false);
      setConnection(answer.memberfulConnection);
    } catch (error) {
      setBusy(false);
      if (!(error instanceof ApiError)) return setProblem("Couldn't reach Ember. Check your connection and try again.");
      if (passwordInput.current) passwordInput.current.value = "";
      // A member whose password is right, and who has connected Memberful, hears that they sign in with it.
      setRefusal(error.status === 403 ? error.message : error.status === 429 ? SIGN_IN_LIMITED : SIGN_IN_REJECTED);
      setShaking(true);
      passwordInput.current?.focus();
    }
  }

  return (
    <AuthPage workspace={workspace}>
      {problem && <Problem>{problem}</Problem>}
      <AuthCard onAnimationEnd={(event) => event.target === event.currentTarget && setShaking(false)} className={shaking ? "motion-safe:animate-shake" : undefined}>
        {connection !== null ? (
          <>
            <AuthHeading title={`Sign in to ${workspace.account.name}`} logo={workspace.account.logo}>
              Members sign in with Memberful now. Connect your Memberful account to keep signing in as yourself.
            </AuthHeading>
            <Button asChild className={PRIMARY_BUTTON}>
              <a href={connection}>Connect Memberful</a>
            </Button>
          </>
        ) : asGuest ? (
          <GuestSignIn logo={workspace.account.logo} onSignedIn={onSignedIn} onUsePassword={() => setAsGuest(false)} />
        ) : (
          <>
            <AuthHeading title={`Sign in to ${workspace.account.name}`} logo={workspace.account.logo}>Welcome back. Pick up the conversation.</AuthHeading>
            {withPassword ? (
              <form
                className={AUTH_FORM}
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                {refusal && (
                  <p id="sign-in-error" role="alert" className="rounded-[8px] border border-auth-error-border bg-auth-error-background px-3.5 py-3 text-[14px] leading-normal text-auth-error">
                    {refusal}
                  </p>
                )}
                <Field id="email_address" label="Email address" translation="email_address">
                  <Input
                    id="email_address"
                    type="email"
                    required
                    autoFocus
                    autoComplete="username"
                    placeholder="Enter your email address"
                    value={emailAddress}
                    onChange={(event) => setEmailAddress(event.target.value)}
                    className={FIELD_INPUT}
                  />
                </Field>
                <Field id="password" label="Password" translation="password">
                  {/* Uncontrolled, so what's typed never reaches its `value` attribute, where custom CSS could read it. */}
                  <Input
                    ref={passwordInput}
                    id="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    maxLength={MAX_PASSWORD_LENGTH}
                    className={FIELD_INPUT}
                  />
                </Field>
                <SubmitButton disabled={busy}>Sign in</SubmitButton>
              </form>
            ) : (
              <Button asChild className={PRIMARY_BUTTON}>
                {/* The Worker opens the page this tab was sent here from once it's signed in. The tab keeps it too, for a try that fails. */}
                <a href={memberfulSignInPath(returnPath())}>Sign in with Memberful</a>
              </Button>
            )}
            {withPassword && workspace.passwordResetCodes && (
              <AuthAlternative question="Forgot your password?" action="Reset it" href={withEmailAddress(PASSWORD_RESET_PATH, emailAddress)} />
            )}
            {membersOnly ? (
              withPassword ? (
                <AuthAlternative question="Member?" action="Sign in with Memberful" onClick={() => setWithPassword(false)} disabled={busy} />
              ) : (
                <AuthAlternative question="Have a password?" action="Sign in with a password" onClick={() => setWithPassword(true)} />
              )
            ) : (
              workspace.signInWithMemberful && <AuthAlternative question="Member?" action="Sign in with Memberful" href={memberfulSignInPath(returnPath())} />
            )}
            {signsUpOpenly(workspace.account) ? (
              <AuthAlternative question="New here?" action="Create an account" href={SIGN_UP_PATH} />
            ) : (
              // Open lets anyone in, addresses at the email domains too, so this is for when it's off.
              signsUpWithEmailDomain(workspace.account) && (
                <AuthAlternative question={`Have an address at ${domainsInWords(workspace.account.emailDomains)}?`} action="Join with it" href={EMAIL_SIGN_UP_PATH} />
              )
            )}
            {workspace.guestSignIn && <AuthAlternative question="No account?" action="Join with just a name" onClick={() => setAsGuest(true)} disabled={busy} />}
          </>
        )}
      </AuthCard>
    </AuthPage>
  );
}
