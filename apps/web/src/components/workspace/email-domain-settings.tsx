import { useRef, useState, type FormEvent } from "react";
import { domainsInWords, EMAILS_PER_ADDRESS, EMAIL_LINKS_PER_NETWORK, emailDomainOf, FREE_EMAIL_DOMAINS, MAX_EMAIL_DOMAINS, NO_EMAIL_DOMAINS } from "@ember/protocol";
import { FIELD_INPUT, Field } from "@/components/field";
import { Xmark } from "@/components/icons/iconoir";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ShareableLink } from "./invite-link";
import { EMAIL_SIGN_UP_LINK, emailSignUpUrl } from "./join-link";
import { SetUpTurnstile } from "./turnstile-settings";

// The Email domain card in Membership's ways to join: an administrator lists the domains whose email
// addresses can join, and people with one ask for a link at /join/email, which Ember emails them. Laid
// out as the other ways to join are, with its domains while it's on. It can't be on without one, so
// turning it on before there are any opens the list, and saving them turns it on. Nor can it be on
// before Ember can send email, so turning it on before then says so and opens Set up email, as the
// project's owner asked (2026-10-26), and goes on once Ember can.

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";
const BUTTON = "inline-flex min-h-11 items-center justify-center rounded-[9px] border bg-background px-3.5 py-2.5 font-medium disabled:opacity-50";
/** A domain listed, as New direct message lists the people picked, which removes it. */
const CHIP =
  "inline-flex min-h-9 max-w-full cursor-pointer items-center gap-1 rounded-[20px] border bg-background py-[7px] ps-3 pe-2.5 text-[13px] text-foreground wrap-anywhere disabled:cursor-default disabled:opacity-50 touch:min-h-11";

/** What a domain typed is refused for, naming it. */
const notADomain = (typed: string) => `${typed} isn't a domain, such as example.com.`;
const TOO_MANY_DOMAINS = `Email domain lets in at most ${MAX_EMAIL_DOMAINS} domains.`;

/** Whether `domains` lists the same domains as `kept`, in the same order. */
const sameDomains = (domains: readonly string[], kept: readonly string[]) => domains.length === kept.length && domains.every((domain, index) => domain === kept[index]);

interface Props {
  /** The domains it lets in, as kept, whether it's on or not. */
  domains: string[];
  /** Whether Ember can send email, which it takes to email people their links. */
  emails: boolean;
  /** Whether Ember has Turnstile's keys, whose check stands in for the limit on a network. */
  turnstile: boolean;
  /** Where its switch is: where it was moved to while that's saved, or else where the workspace has it. */
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
  /** Saves `domains` in place of those it has, turning it on with them if `turnOn`, then calls `settled` with whether it did. */
  saveDomains: (domains: string[], turnOn: boolean, settled: (saved: boolean) => void) => void;
  /** Opens Set up email, calling `then`, if given, once it closes with Ember able to send email. */
  onSetUpEmail: (then?: () => void) => void;
  /** Opens Set up Turnstile, whose check lifts the limit on a network. */
  onSetUpTurnstile: () => void;
  /** Why the switch can't be moved while another way to join overrides it, said in place of what it does, or null. */
  setAside: string | null;
}

/**
 * Email domain, for administrators: its switch, then while it's on, its domains, to add to and remove
 * from, then save, the link to its page, and how often Ember emails a link. Until Ember can send email
 * it says so, and turning it on sets that up first.
 */
export function EmailDomainSettings({ domains, emails, turnstile, checked, onCheckedChange, saveDomains, onSetUpEmail, onSetUpTurnstile, setAside }: Props) {
  // Turned on before it had a domain, which saving the first turns it on with.
  const [adding, setAdding] = useState(false);
  // The domains as changed, or null while they're as kept.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [typed, setTyped] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const listed = draft ?? domains;
  const on = checked || adding;
  const free = listed.filter((domain) => FREE_EMAIL_DOMAINS.includes(domain));

  const turnOn = () => (domains.length === 0 ? setAdding(true) : onCheckedChange(true));
  const switchTo = (on: boolean) => {
    if (on) return emails ? turnOn() : onSetUpEmail(turnOn);
    setAdding(false);
    if (!adding) onCheckedChange(false);
  };

  /** Lists each domain typed, apart by commas, semicolons or spaces, keeping in the field any that isn't one. */
  const add = (event: FormEvent) => {
    event.preventDefault();
    const words = typed.split(/[\s,;]+/).filter(Boolean);
    const refused = words.filter((word) => emailDomainOf(word) === null);
    const added = [...new Set([...listed, ...words.map(emailDomainOf).filter((domain) => domain !== null)])];
    if (added.length > MAX_EMAIL_DOMAINS) return setRefusal(TOO_MANY_DOMAINS);
    setDraft(sameDomains(added, domains) ? null : added);
    setTyped(refused.join(" "));
    setRefusal(refused.length > 0 ? notADomain(refused[0]!) : null);
    field.current?.focus();
  };

  const remove = (removed: string) => {
    const kept = listed.filter((domain) => domain !== removed);
    setDraft(sameDomains(kept, domains) ? null : kept);
  };

  const save = () => {
    const sent = listed;
    setSaving(true);
    saveDomains(sent, adding, (saved) => {
      setSaving(false);
      if (!saved) return;
      setAdding(false);
      // Unless they've been changed again since.
      setDraft((draft) => (draft === sent ? null : draft));
    });
  };

  return (
    <section aria-labelledby="email-domain-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div className="flex items-center gap-x-[1ch] gap-y-4">
        <div className="min-w-0 flex-1">
          <h3 id="email-domain-heading" className={cn("text-base font-semibold", setAside !== null && "text-muted-foreground")}>
            Email domain
          </h3>
          <p id="email-domain-description" className={cn(NOTE, checked && !emails && setAside === null && "text-negative")}>
            {setAside ??
              (emails
                ? "People with an email address at your domains join with a link Ember emails them."
                : checked
                  ? "It's on, but Ember can't send email, so nobody gets a link to join with until email is set up."
                  : "People with an email address at your domains join with a link Ember emails them. Ember can't send email yet, so turning this on sets that up first.")}
          </p>
        </div>
        <Switch
          checked={on}
          onCheckedChange={switchTo}
          disabled={setAside !== null || saving}
          aria-labelledby="email-domain-heading"
          aria-describedby="email-domain-description"
        />
      </div>
      {checked && !emails && setAside === null && (
        <div>
          <button type="button" onClick={() => onSetUpEmail()} className={BUTTON}>
            Set up email
          </button>
        </div>
      )}
      {on && setAside === null && (
        <>
          <form onSubmit={add} className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 basis-[16em]">
              <Field id="email_domain" label="Add a domain">
                <Input
                  ref={field}
                  id="email_domain"
                  autoFocus={adding}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="example.com"
                  value={typed}
                  aria-invalid={refusal !== null}
                  aria-describedby={refusal === null ? undefined : "email-domain-refusal"}
                  onChange={(event) => {
                    setTyped(event.target.value);
                    setRefusal(null);
                  }}
                  className={FIELD_INPUT}
                />
              </Field>
            </div>
            <button type="submit" disabled={typed.trim() === "" || saving} className={BUTTON}>
              Add
            </button>
          </form>
          {refusal !== null && (
            <p id="email-domain-refusal" role="alert" className={cn(NOTE, "text-negative")}>
              {refusal}
            </p>
          )}
          {listed.length > 0 ? (
            <ul aria-label="Domains that can join" className="flex flex-wrap gap-1.5">
              {listed.map((domain) => (
                <li key={domain} className="max-w-full">
                  <button type="button" aria-label={`Remove ${domain}`} disabled={saving} onClick={() => remove(domain)} className={CHIP}>
                    {domain}
                    <Xmark className="size-4 flex-none" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={NOTE}>{NO_EMAIL_DOMAINS}</p>
          )}
          {free.length > 0 && (
            <p className={cn(NOTE, "text-negative")}>
              Anyone can get an address at {domainsInWords(free)}, so listing {free.length === 1 ? "it" : "them"} lets almost anyone join.
            </p>
          )}
          {(adding || draft !== null) && (
            <div>
              <button type="button" onClick={save} disabled={saving || listed.length === 0} className={BUTTON}>
                {adding ? "Save and turn on" : "Save domains"}
              </button>
            </div>
          )}
          {checked && <ShareableLink id="email_sign_up" label="Share with people at your domains" url={emailSignUpUrl()} sharing={EMAIL_SIGN_UP_LINK} />}
          <p className={NOTE}>
            Ember emails an address at most {EMAILS_PER_ADDRESS} links an hour, whoever asks, so nobody can use it to fill someone's inbox.{" "}
            {turnstile ? (
              "Cloudflare Turnstile checks that whoever asks for a link is a person."
            ) : (
              `Until Cloudflare Turnstile checks that whoever asks is a person, ${EMAIL_LINKS_PER_NETWORK} links can be asked for from a network in an hour. Setting up Turnstile lifts that limit.`
            )}
          </p>
          {!turnstile && <SetUpTurnstile onSetUp={onSetUpTurnstile} />}
        </>
      )}
    </section>
  );
}
