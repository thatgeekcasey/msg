import { useEffect, useState } from "react";
import { domainsInWords, EMAIL_LINK_GONE, MAX_EMAIL_ADDRESS_LENGTH, signInSaying, signsUpWithEmailDomain, type Me } from "@ember/protocol";
import { AuthAlternative } from "@/components/auth-alternative";
import { AUTH_FORM, AuthCard, AuthHeading, AuthPage, Problem, type SignedOutWorkspace } from "@/components/auth-page";
import { FIELD_INPUT, Field, SubmitButton } from "@/components/field";
import { JoinPage, TURNSTILE_UNAVAILABLE } from "@/components/join-page";
import { TurnstileCheck } from "@/components/turnstile-check";
import { Input } from "@/components/ui/input";
import { useEmailLink, useLinksOpened } from "@/hooks/use-email-link";
import { useTitle } from "@/hooks/use-title";
import { ApiError, askForEmailLink } from "@/lib/api";
import { loadPage } from "@/lib/page";

// The page for joining with an email address at the workspace's email domains: someone asks there for a
// link, which Ember emails them, and the link opens the page again, holding its secret in the fragment,
// to show the join form with the address it's for. Asking waits for Turnstile's check while Ember has a
// widget's keys, as open sign-up does.

interface Props {
  workspace: SignedOutWorkspace;
  onJoined: (me: Me) => void;
}

/** Where someone asks for a link to join with their email address, and the join page for the link, once it's looked up. */
export function EmailSignUpPage(props: Props) {
  return <EmailLinkLookup key={useLinksOpened()} {...props} />;
}

/**
 * Looks up the link whose secret is in the address's fragment, then shows its join form, or else asks
 * for one, saying first if the link doesn't work. Without a link it sends the browser to sign in,
 * which says why, while Email domain is off.
 */
function EmailLinkLookup({ workspace, onJoined }: Props) {
  const [link, gone] = useEmailLink("email_domain");
  const elsewhere = link === "none" && !signsUpWithEmailDomain(workspace.account);
  useEffect(() => {
    if (elsewhere) loadPage(signInSaying("email_off"));
  }, [elsewhere]);

  if (link === "looking" || elsewhere) return <main aria-busy="true" className="min-h-dvh bg-surface" />;
  if (typeof link === "object") return <JoinPage workspace={workspace} joinCode={null} emailLink={link} onGone={gone} onJoined={onJoined} />;
  return <LinkRequest workspace={workspace} gone={link === "gone"} />;
}

/**
 * The form asking Ember to email a link to join with an address at the workspace's email domains,
 * while Email domain is on, under why the link that opened the page doesn't work, if it's `gone`. Once
 * Ember has emailed the address, it says to look there. It draws Turnstile's check afresh for each ask.
 */
function LinkRequest({ workspace, gone }: { workspace: SignedOutWorkspace; gone: boolean }) {
  const { account, turnstileSiteKey: siteKey } = workspace;
  const [emailAddress, setEmailAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [emailed, setEmailed] = useState<string | null>(null);
  // The token of the check passed, which is good for one ask, and how many asks the check has been drawn for.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  useTitle("Sign up");

  async function submit() {
    setBusy(true);
    setProblem(null);
    try {
      await askForEmailLink(siteKey === null ? { emailAddress } : { emailAddress, turnstileToken: turnstileToken ?? "" });
      setEmailed(emailAddress.trim());
    } catch (error) {
      if (!(error instanceof ApiError)) setProblem("Couldn't reach Ember. Check your connection and try again.");
      // Email domain turned off meanwhile goes to sign in, which says so, and someone who signed in
      // elsewhere goes home.
      else if (error.redirect) loadPage(error.redirect);
      else setProblem(error.message);
    } finally {
      setBusy(false);
      if (siteKey !== null) {
        setTurnstileToken(null);
        setTries((tries) => tries + 1);
      }
    }
  }

  if (emailed !== null) {
    return (
      <AuthPage workspace={workspace}>
        <AuthCard>
          <AuthHeading title="Check your email" logo={account.logo}>
            Ember emailed {emailed}. Open the link in that email to go on. If it hasn't arrived in a few minutes, look in your spam folder.
          </AuthHeading>
          <AuthAlternative question="Didn't get it?" action="Ask again" onClick={() => setEmailed(null)} />
        </AuthCard>
      </AuthPage>
    );
  }

  const on = signsUpWithEmailDomain(account);
  return (
    <AuthPage workspace={workspace}>
      {problem && <Problem>{problem}</Problem>}
      <AuthCard>
        <AuthHeading title={`Join ${account.name}`} logo={account.logo}>
          {gone ? EMAIL_LINK_GONE : "Enter your email address, and Ember will email you a link to join with it."}
        </AuthHeading>
        {on && (
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
                autoComplete="email"
                placeholder="Email address"
                maxLength={MAX_EMAIL_ADDRESS_LENGTH}
                aria-describedby="email_address_description"
                value={emailAddress}
                onChange={(event) => setEmailAddress(event.target.value)}
                className={FIELD_INPUT}
              />
              <span id="email_address_description" className="text-[0.8rem] text-muted-foreground">
                Addresses at {domainsInWords(account.emailDomains)} can join.
              </span>
            </Field>
            {siteKey !== null && <TurnstileCheck key={tries} siteKey={siteKey} onToken={setTurnstileToken} onUnavailable={() => setProblem(TURNSTILE_UNAVAILABLE)} />}
            <SubmitButton disabled={busy || (siteKey !== null && turnstileToken === null)}>Email me a link</SubmitButton>
          </form>
        )}
        <AuthAlternative question="Already have an account?" action="Sign in" href="/session/new" />
      </AuthCard>
    </AuthPage>
  );
}
