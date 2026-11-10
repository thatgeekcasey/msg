import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  domainOfEmailAddress,
  EMAIL_FROM_REFUSED,
  mailboxOf,
  mailboxText,
  RESEND_API_KEY_REFUSED,
  resendApiKeyOf,
  type Account,
  type EmailProvider,
  type EmailSettings as Email,
} from "@ember/protocol";
import { FIELD_INPUT, Field } from "@/components/field";
import { Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { ApiError, changeAccount, checkSendingDomain, forgetResendApiKey, isSignedOut, saveResendApiKey } from "@/lib/api";
import { cn } from "@/lib/utils";
import { sendsEmail, TestEmail } from "./email-settings";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE, MAIN_ACTION, OTHER_ACTION } from "./unsaved-changes";

// Set up email, for administrators: the steps to have Ember send email, one at a time, in a dialog that
// Membership's Email card opens, as Invite by email does, and as turning on Email domain does before
// Ember can send email, as the project's owner asked (2026-10-26). First, what sends it: Resend, with an
// API key Ember checks with Resend and keeps, or Cloudflare Email Service, which delivers beyond the
// account's own addresses only on Workers Paid. Then the From address, whose domain it checks for the
// records Cloudflare's Onboard Domain adds, and then a test email, which it sends as it gets there, so
// that setting up checks itself. While the deployment has the secret RESEND_API_KEY, Resend sends with
// it, so it starts at the From address. Each step saves as it goes on. Styled as Unsaved Changes is.

/** Where Resend verifies the domains it sends from. */
const RESEND_DOMAINS = "https://resend.com/domains";
/** Where Resend makes API keys. */
const RESEND_API_KEYS = "https://resend.com/api-keys";
/** Where the Cloudflare dashboard onboards a domain to Email Sending. */
export const EMAIL_SENDING_DASHBOARD = "https://dash.cloudflare.com/?to=/:account/email-service/sending";
/** Where the Cloudflare dashboard changes the account's Workers plan. */
export const WORKERS_PLANS = "https://dash.cloudflare.com/?to=/:account/workers/plans";

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";
const LINK = "underline";
/** How long the From step waits once typing stops before it checks the address's domain. */
const CHECK_DELAY_MS = 500;

/** Where it's at: choosing what sends email, setting that up, the From address, or the test email. */
type Step = "provider" | EmailProvider | "from" | "test";

const TITLES: Record<Step, string> = {
  provider: "Set up email",
  resend: "Send with Resend",
  cloudflare: "Send with Cloudflare Email Service",
  from: "Choose the From address",
  test: "Send a test email",
};

/** The From address `text` gives, as it's kept, or null when it can't be one, as blank can't. */
function fromTyped(text: string): string | null {
  const mailbox = mailboxOf(text);
  return mailbox && mailboxText(mailbox);
}

/** The domain of the From address `text` gives, or null when it can't be one. */
function domainTyped(text: string): string | null {
  const mailbox = mailboxOf(text);
  return mailbox && domainOfEmailAddress(mailbox.address);
}

/** What checking a domain for Cloudflare Email Sending has found: that it's checking still, whether it's onboarded, or null when DNS didn't say. */
type Onboarding = "checking" | boolean | null;

/**
 * Whether `domain` is onboarded to Cloudflare Email Sending, checked once typing has stopped for
 * `CHECK_DELAY_MS`, and once for each domain: undefined until then, or while there's none to check.
 */
function useOnboarding(domain: string | null): Onboarding | undefined {
  // What it found of each domain it asked about, "checking" until that's answered, so that it asks once.
  const [found, setFound] = useState<ReadonlyMap<string, Onboarding>>(new Map());
  const mounted = useMounted();

  useEffect(() => {
    if (domain === null || found.has(domain)) return;
    const wait = setTimeout(() => {
      const remember = (onboarding: Onboarding) => mounted.current && setFound((found) => new Map(found).set(domain, onboarding));
      remember("checking");
      // Failing to check says no more than DNS not answering.
      checkSendingDomain(domain).then(remember, () => remember(null));
    }, CHECK_DELAY_MS);
    return () => clearTimeout(wait);
  }, [domain, found, mounted]);

  return domain === null ? undefined : found.get(domain);
}

/** What the From step says it found of its address's domain, for Cloudflare Email Sending. */
function OnboardingNote({ domain, onboarding }: { domain: string; onboarding: Onboarding }) {
  if (onboarding === "checking") return <>Checking that {domain} is onboarded to Cloudflare Email Sending…</>;
  if (onboarding === true) return <>{domain} is onboarded to Cloudflare Email Sending.</>;
  if (onboarding === null) return <>Ember couldn't look up {domain} just now. The test email will say whether Cloudflare sends from it.</>;
  return (
    <>
      {domain} isn't onboarded to Cloudflare Email Sending yet, as its DNS doesn't have the records Onboard Domain adds.{" "}
      <Out href={EMAIL_SENDING_DASHBOARD}>Open Email Sending in the Cloudflare dashboard</Out>
    </>
  );
}

interface Props {
  email: Email;
  /** As workspace settings asks for the workspace, which it says the server answers with. */
  askForAccount: () => (account: Account) => void;
  /** Shows how Ember sends email as the server answers once Resend's API key is saved or forgotten. */
  onEmailChanged: (email: Email) => void;
  /** Shows the From address once it's saved. */
  onFromSaved: (from: string) => void;
  /** Called as it closes, with whether Ember can send email then. */
  onClose: (sends: boolean) => void;
  /** Says why saving failed, when it isn't Resend's or the form's doing, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Set up email: what sends it, the From address, and a test email, a step at a time. */
export function EmailSetup({ email, askForAccount, onEmailChanged, onFromSaved, onClose, onFailed }: Props) {
  const [step, setStep] = useState<Step>(email.resendKey === "secret" ? "from" : "provider");
  // What it was set up to send with, which its own steps follow.
  const [provider, setProvider] = useState<EmailProvider | null>(email.resendKey === "saved" ? "resend" : sendsEmail(email) ? email.provider : null);
  // A step that's saving holds the dialog open until it's answered.
  const [saving, setSaving] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const shown = useRef(step);
  const close = () => onClose(sendsEmail(email));

  // Each step starts at its title, so that it's read first.
  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    title.current?.focus();
  }, [step]);

  const steps: Record<Step, ReactNode> = {
    provider: <ChooseProvider email={email} chosen={provider} onChoose={setProvider} onContinue={() => provider && setStep(provider)} onCancel={close} />,
    resend: (
      <ResendStep
        email={email}
        saving={saving}
        setSaving={setSaving}
        onEmailChanged={onEmailChanged}
        onContinue={() => setStep("from")}
        onBack={() => setStep("provider")}
        onFailed={onFailed}
      />
    ),
    cloudflare: (
      <CloudflareStep
        email={email}
        saving={saving}
        setSaving={setSaving}
        onEmailChanged={onEmailChanged}
        onContinue={() => setStep("from")}
        onBack={() => setStep("provider")}
        onFailed={onFailed}
      />
    ),
    from: (
      <FromStep
        email={email}
        saving={saving}
        setSaving={setSaving}
        askForAccount={askForAccount}
        onFromSaved={onFromSaved}
        onContinue={() => setStep("test")}
        // The deployment's secret leaves nothing to choose before it.
        onBack={email.resendKey === "secret" ? null : () => setStep(email.provider ?? "provider")}
        onFailed={onFailed}
      />
    ),
    test: <TestStep onBack={() => setStep("from")} onDone={close} onFailed={onFailed} />,
  };

  return (
    <Dialog open onOpenChange={(open) => open || saving || close()}>
      <DialogContent
        showCloseButton={false}
        aria-busy={saving || undefined}
        overlayClassName={DIALOG_BACKDROP}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        // A step's typing isn't lost to a click beside it.
        onInteractOutside={(event) => event.preventDefault()}
        className={cn(DIALOG, "w-[480px]")}
      >
        <button type="button" aria-label="Close" disabled={saving} onClick={close} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle ref={title} tabIndex={-1} className={cn(DIALOG_TITLE, "pe-10 outline-none")}>
          {TITLES[step]}
        </DialogTitle>
        {steps[step]}
      </DialogContent>
    </Dialog>
  );
}

/** What each step that saves something is given. */
interface Saving {
  saving: boolean;
  setSaving: (saving: boolean) => void;
  onFailed: (error: unknown) => void;
}

/** The buttons at a step's foot: going back, or else cancelling, and going on. */
function Actions({
  back,
  backLabel = "Back",
  next,
  nextLabel = "Continue",
  disabled = false,
  saving = false,
}: {
  back: (() => void) | null;
  backLabel?: string;
  /** Goes on, or null when the step's form does, as its submit button. */
  next: (() => void) | null;
  nextLabel?: string;
  disabled?: boolean;
  saving?: boolean;
}) {
  return (
    <div className="mt-[26px] flex justify-end gap-2.5">
      {back && (
        <button type="button" disabled={saving} onClick={back} className={OTHER_ACTION}>
          {backLabel}
        </button>
      )}
      <button type={next ? "button" : "submit"} disabled={disabled || saving} onClick={next ?? undefined} className={MAIN_ACTION}>
        {nextLabel}
      </button>
    </div>
  );
}

/** A link out, which opens in a new tab. */
function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener" className={LINK}>
      {children}
    </a>
  );
}

/** The first step: what sends Ember's email, Resend or Cloudflare Email Service, which the Worker sends with only while it has the EMAIL binding. */
function ChooseProvider({
  email,
  chosen,
  onChoose,
  onContinue,
  onCancel,
}: {
  email: Email;
  chosen: EmailProvider | null;
  onChoose: (provider: EmailProvider) => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <DialogDescription className="mb-4 leading-[1.65]">
        Ember emails invitations, the links people at your email domains join with, and codes to reset a forgotten password. Choose what sends them.
      </DialogDescription>
      <fieldset className="flex flex-col gap-2.5">
        <legend className="sr-only">Send email with</legend>
        <ProviderChoice provider="resend" title="Resend" chosen={chosen} onChoose={onChoose}>
          Free for up to 100 emails a day, and 3,000 a month, whatever your Cloudflare plan. It takes a Resend account, and a domain to send from.
        </ProviderChoice>
        <ProviderChoice provider="cloudflare" title="Cloudflare Email Service" chosen={chosen} onChoose={onChoose} disabled={!email.cloudflare}>
          {email.cloudflare
            ? "Needs the Workers Paid plan ($5 a month) on the Cloudflare account that runs Ember."
            : "This Worker has no EMAIL binding, which Cloudflare Email Service sends with."}
        </ProviderChoice>
      </fieldset>
      <Actions back={onCancel} backLabel="Cancel" next={onContinue} disabled={chosen === null} />
    </>
  );
}

function ProviderChoice({
  provider,
  title,
  chosen,
  onChoose,
  disabled = false,
  children,
}: {
  provider: EmailProvider;
  title: string;
  chosen: EmailProvider | null;
  onChoose: (provider: EmailProvider) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-[10px] border bg-surface p-3.5 has-checked:border-foreground has-disabled:cursor-default has-disabled:opacity-60">
      <input
        type="radio"
        name="email-provider"
        value={provider}
        checked={chosen === provider}
        disabled={disabled}
        onChange={() => onChoose(provider)}
        aria-labelledby={`email-provider-${provider}`}
        aria-describedby={`email-provider-${provider}-description`}
        className="mt-1 size-4 flex-none accent-foreground"
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span id={`email-provider-${provider}`} className="font-semibold">
          {title}
        </span>
        <span id={`email-provider-${provider}-description`} className={NOTE}>
          {children}
        </span>
      </span>
    </label>
  );
}

/** Resend's steps: a domain verified in Resend, and an API key from it, which Ember checks with Resend and keeps, or the one it has. */
function ResendStep({
  email,
  saving,
  setSaving,
  onEmailChanged,
  onContinue,
  onBack,
  onFailed,
}: Saving & { email: Email; onEmailChanged: (email: Email) => void; onContinue: () => void; onBack: () => void }) {
  const [typed, setTyped] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const mounted = useMounted();
  const hasKey = email.resendKey === "saved";

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (typed.trim() === "" && hasKey) return onContinue();
    const apiKey = resendApiKeyOf(typed);
    if (apiKey === null) return setRefusal(RESEND_API_KEY_REFUSED);
    setSaving(true);
    saveResendApiKey(apiKey).then(
      (changed) => {
        onEmailChanged(changed);
        if (!mounted.current) return;
        setSaving(false);
        onContinue();
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        // What Resend said of the key, or that it didn't answer, which the step says itself.
        if (error instanceof ApiError && [422, 502].includes(error.status)) return setRefusal(error.message);
        onFailed(error);
      },
    );
  };

  return (
    <form onSubmit={save}>
      <DialogDescription className="mb-4 leading-[1.65]">
        Ember sends email with an API key from your Resend account, which it keeps encrypted.
      </DialogDescription>
      <ol aria-label="Steps to send email with Resend" className="mb-4 flex list-decimal flex-col gap-2 ps-5">
        <li>
          In Resend, add the domain to send from under <em>Domains</em>, then add the DNS records it gives you where your domain's DNS is, until Resend says
          it's verified. <Out href={RESEND_DOMAINS}>Open Resend's domains</Out>
        </li>
        <li>
          Under <em>API Keys</em>, create a key with <em>Sending access</em>, and paste it here. <Out href={RESEND_API_KEYS}>Open Resend's API keys</Out>
        </li>
      </ol>
      <Field id="resend_api_key" label="API key">
        <Input
          id="resend_api_key"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="re_…"
          value={typed}
          disabled={saving}
          aria-invalid={refusal !== null}
          aria-describedby={refusal !== null ? "resend-api-key-refusal" : hasKey ? "resend-api-key-description" : undefined}
          onChange={(event) => {
            setTyped(event.target.value);
            setRefusal(null);
          }}
          className={FIELD_INPUT}
        />
      </Field>
      {refusal !== null ? (
        <p id="resend-api-key-refusal" role="alert" className={cn(NOTE, "mt-2 text-negative")}>
          {refusal}
        </p>
      ) : (
        hasKey && (
          <p id="resend-api-key-description" className={cn(NOTE, "mt-2")}>
            Ember has a Resend API key already. Paste another to send with it instead.
          </p>
        )
      )}
      <Actions back={onBack} next={null} nextLabel={saving ? "Checking…" : "Continue"} disabled={typed.trim() === "" && !hasKey} saving={saving} />
    </form>
  );
}

/** Cloudflare Email Service's steps: Workers Paid, and a domain onboarded to Email Sending, after which Ember forgets any Resend API key it has. */
function CloudflareStep({
  email,
  saving,
  setSaving,
  onEmailChanged,
  onContinue,
  onBack,
  onFailed,
}: Saving & { email: Email; onEmailChanged: (email: Email) => void; onContinue: () => void; onBack: () => void }) {
  const mounted = useMounted();
  const hasKey = email.resendKey === "saved";

  const next = () => {
    if (!hasKey) return onContinue();
    setSaving(true);
    forgetResendApiKey().then(
      (changed) => {
        onEmailChanged(changed);
        if (!mounted.current) return;
        setSaving(false);
        onContinue();
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        onFailed(error);
      },
    );
  };

  return (
    <>
      <DialogDescription className="mb-4 leading-[1.65]">Ember sends email from your Cloudflare account, with this Worker's EMAIL binding.</DialogDescription>
      <ol aria-label="Steps to send email with Cloudflare" className="flex list-decimal flex-col gap-2 ps-5">
        <li>
          Put the Cloudflare account that runs Ember on the <em>Workers Paid</em> plan. <Out href={WORKERS_PLANS}>Open Workers plans</Out>
        </li>
        <li>
          In the Cloudflare dashboard, open <em>Email Service</em>, <em>Email Sending</em>, choose <em>Onboard Domain</em>, and pick a domain on Cloudflare
          DNS. Cloudflare adds the records sending takes. <Out href={EMAIL_SENDING_DASHBOARD}>Open Email Sending in the Cloudflare dashboard</Out>
        </li>
      </ol>
      {hasKey && <p className={cn(NOTE, "mt-4")}>Ember will stop sending with Resend, and forget its API key.</p>}
      <Actions back={onBack} next={next} saving={saving} />
    </>
  );
}

/** The From address, on the domain the provider sends from, which it saves unless it's as saved. */
function FromStep({
  email,
  saving,
  setSaving,
  askForAccount,
  onFromSaved,
  onContinue,
  onBack,
  onFailed,
}: Saving & {
  email: Email;
  askForAccount: () => (account: Account) => void;
  onFromSaved: (from: string) => void;
  onContinue: () => void;
  onBack: (() => void) | null;
}) {
  const [typed, setTyped] = useState(email.from ?? "");
  const [refusal, setRefusal] = useState<string | null>(null);
  const mounted = useMounted();
  const domain = email.provider === "cloudflare" ? domainTyped(typed) : null;
  const onboarding = useOnboarding(domain);
  // What it says of the address's domain once it's found something, unless the address is refused.
  const note = refusal === null && domain !== null && onboarding !== undefined ? { domain, onboarding } : null;

  const save = (event: FormEvent) => {
    event.preventDefault();
    const emailFrom = fromTyped(typed);
    if (emailFrom === null) return setRefusal(EMAIL_FROM_REFUSED);
    if (emailFrom === email.from) return onContinue();
    setSaving(true);
    const answered = askForAccount();
    changeAccount({ emailFrom }).then(
      (account) => {
        answered(account);
        onFromSaved(emailFrom);
        if (!mounted.current) return;
        setSaving(false);
        onContinue();
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        onFailed(error);
      },
    );
  };

  return (
    <form onSubmit={save}>
      <DialogDescription className="mb-4 leading-[1.65]">
        The address Ember's email comes from, on the domain {email.provider === "cloudflare" ? "you onboarded to Email Sending" : "you verified in Resend"}.
        Email comes under the community's name, unless you put another name before the address.
      </DialogDescription>
      <Field id="email_from" label="From">
        <Input
          id="email_from"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Ember <ember@example.com>"
          value={typed}
          disabled={saving}
          aria-invalid={refusal !== null}
          aria-describedby={refusal !== null ? "email-from-refusal" : note ? "email-from-domain" : undefined}
          onChange={(event) => {
            setTyped(event.target.value);
            setRefusal(null);
          }}
          className={FIELD_INPUT}
        />
      </Field>
      {refusal !== null && (
        <p id="email-from-refusal" role="alert" className={cn(NOTE, "mt-2 text-negative")}>
          {refusal}
        </p>
      )}
      {/* Said as it's found, though going on never waits for it: only sending says whether Cloudflare sends. */}
      {email.provider === "cloudflare" && (
        <p
          id="email-from-domain"
          role="status"
          className={cn(NOTE, "mt-2 wrap-anywhere empty:mt-0", note?.onboarding === true && "text-positive", note?.onboarding === false && "text-negative")}
        >
          {note && <OnboardingNote {...note} />}
        </p>
      )}
      <Actions back={onBack} next={null} nextLabel={saving ? "Saving…" : "Continue"} disabled={typed.trim() === ""} saving={saving} />
    </form>
  );
}

/** The last step: a test email, from the From address, to the administrator, sent as it opens, and Done. */
function TestStep({ onBack, onDone, onFailed }: { onBack: () => void; onDone: () => void; onFailed: (error: unknown) => void }) {
  return (
    <>
      <DialogDescription className="mb-4 leading-[1.65]">
        Ember is set up to send email, and sends you a test email to check that it arrives. If it doesn't, go back and change what sends it.
      </DialogDescription>
      <TestEmail onFailed={onFailed} atOnce />
      <Actions back={onBack} next={onDone} nextLabel="Done" />
    </>
  );
}
