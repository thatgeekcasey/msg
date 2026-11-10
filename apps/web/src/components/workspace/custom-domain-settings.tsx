import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  canBeCustomDomain,
  CUSTOM_DOMAIN_NOT_A_HOST,
  DNS_PROVIDERS,
  isHost,
  NOT_A_CUSTOM_DOMAIN,
  othersAfterMove,
  type Account,
  type CustomDomainLookup,
  type CustomDomainReach,
  type DnsProvider,
  type EmberAddresses,
} from "@ember/protocol";
import { FIELD_INPUT, Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { useAccount } from "@/hooks/use-account";
import { useMounted } from "@/hooks/use-mounted";
import { ApiError, changeAccount, checkCustomDomain, fetchWorkspaceSettings, isSignedOut, lookUpCustomDomain } from "@/lib/api";
import { moveTo } from "@/lib/custom-domain";
import { cn } from "@/lib/utils";
import { CopyButton, ROUND_BUTTON } from "./link-buttons";
import { workspaceSectionPath } from "./settings-navigation";

// The Custom domain section of workspace settings. Ember holds no Cloudflare token, so the administrator
// adds the domain in Cloudflare's dashboard, which the section opens with what to paste there copied: to
// the Worker, where the domain's DNS is on Cloudflare or moves there from the provider public DNS says
// has it, or, to keep the DNS at that provider, as a custom hostname of another domain already on
// Cloudflare (Cloudflare for SaaS), with the one record to add at the provider. Use then makes the
// domain Ember's address, once a check finds it reaches Ember, and goes there. A domain that already
// reaches Ember, as one added to the Worker before does, gets no steps, only Save. Going back makes the
// Worker's workers.dev address Ember's again. A domain Ember moves away from keeps reaching it, sending
// people on, until it's removed in Cloudflare, so the section names it until a check finds it gone.
// Styled as the Rooms section is.

/** Where the Cloudflare dashboard lists an account's Workers, whichever account the person picks. */
export const WORKERS_DASHBOARD = "https://dash.cloudflare.com/?to=/:account/workers-and-pages";

/** Where the Cloudflare dashboard shows the Domains tab of the Worker named `worker`, whose Add Domain adds a custom domain. */
export const workerDomains = (worker: string) => `https://dash.cloudflare.com/?to=/:account/workers/services/view/${worker}/production/domains`;

/** Where the Cloudflare dashboard lists an account's domains, whose Onboard a domain moves a domain's DNS to Cloudflare. */
export const CLOUDFLARE_DOMAINS = "https://dash.cloudflare.com/?to=/:account/domains/overview";

/** Where the Cloudflare dashboard lists the DNS records of a domain the person picks. */
export const CLOUDFLARE_DNS_RECORDS = "https://dash.cloudflare.com/?to=/:account/:zone/dns/records";

/** Where the Cloudflare dashboard shows the Custom Hostnames, Cloudflare for SaaS's page, of a domain the person picks. */
export const CLOUDFLARE_CUSTOM_HOSTNAMES = "https://dash.cloudflare.com/?to=/:account/:zone/ssl-tls/custom-hostnames";

/**
 * The name of the record a domain on Cloudflare takes other domains to Ember by, as Cloudflare for SaaS's
 * fallback origin: an AAAA record for 100::, which goes nowhere, as Cloudflare's guide to a Worker as the
 * fallback origin has it, and as docs/self-hosting.md names it.
 */
const SAAS_ORIGIN = "ember-saas";

/** A workers.dev address, `<worker>.<subdomain>.workers.dev`: the Worker's name, then its account's subdomain. */
const WORKERS_DEV = /^([a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/;

/** The name of the Worker at `host`, a workers.dev address, which a deploy gives Ember, or null at any other. */
const workerAt = (host: string) => WORKERS_DEV.exec(host.toLowerCase())?.[1] ?? null;

/** The section's buttons, as its New room is. */
const BUTTON = "inline-flex min-h-11 max-w-full items-center justify-center rounded-[9px] border bg-background px-3.5 py-2.5 font-medium wrap-anywhere disabled:opacity-50";
const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";
/** The DNS provider menu, drawn as the Domain field is, with the browser's own arrow. */
const SELECT = cn("w-full min-w-0 border outline-none dark:bg-input/30", FIELD_INPUT);

/** What the DNS provider menu calls each provider. */
const PROVIDER_NAMES: Record<DnsProvider, string> = {
  cloudflare: "Cloudflare",
  godaddy: "GoDaddy",
  namecheap: "Namecheap",
  squarespace: "Squarespace",
  porkbun: "Porkbun",
  route53: "Amazon Route 53",
  hover: "Hover",
  ionos: "IONOS",
  other: "Another provider",
};

/**
 * Where each provider but Cloudflare takes the nameservers Cloudflare gives `zone` once it's onboarded,
 * which moves its DNS to Cloudflare, in the words of the provider's own help.
 */
const NAMESERVERS_AT: Record<Exclude<DnsProvider, "cloudflare">, (zone: ReactNode) => ReactNode> = {
  godaddy: (zone) => (
    <>
      At GoDaddy, open <em>Domain Portfolio</em>, choose {zone}, then <em>DNS &gt; Nameservers</em>. Choose <em>I'll use my own nameservers</em> and enter Cloudflare's
      two nameservers.
    </>
  ),
  namecheap: (zone) => (
    <>
      At Namecheap, open <em>Domain List</em> and choose <em>Manage</em> beside {zone}. Under <em>Nameservers</em>, choose <em>Custom DNS</em>, enter Cloudflare's two
      nameservers, and save with the check mark.
    </>
  ),
  squarespace: (zone) => (
    <>
      At Squarespace, open <em>Domains</em>, choose {zone}, then <em>DNS &gt; Domain Nameservers &gt; Use Custom Nameservers</em>, and enter Cloudflare's two
      nameservers.
    </>
  ),
  porkbun: (zone) => (
    <>
      At Porkbun, open <em>Domain Management</em>, then <em>Details</em> beside {zone}, and edit <em>Nameservers</em>. Replace them with Cloudflare's two.
    </>
  ),
  // Route 53 serves the DNS of many domains registered elsewhere, whose nameservers change there.
  route53: (zone) => (
    <>
      Where you registered {zone}, replace its nameservers with Cloudflare's two. If that's Route 53, open <em>Registered domains</em> in its console, choose {zone}, then{" "}
      <em>Actions &gt; Edit name servers</em>.
    </>
  ),
  hover: (zone) => (
    <>
      At Hover, choose {zone}, then <em>Edit</em> beside <em>Nameservers</em>, and enter Cloudflare's two nameservers.
    </>
  ),
  ionos: (zone) => (
    <>
      At IONOS, choose the gear beside {zone} under <em>Actions</em>, then <em>Name Server &gt; Use Custom Name Servers</em>, and enter Cloudflare's two nameservers.
    </>
  ),
  other: (zone) => <>Where you registered {zone}, replace its nameservers with Cloudflare's two.</>,
};

/** Where each provider but Cloudflare adds a record to `zone`, in the words of the provider's own help. */
const RECORD_AT: Record<Exclude<DnsProvider, "cloudflare">, (zone: ReactNode) => ReactNode> = {
  godaddy: (zone) => (
    <>
      At GoDaddy, open <em>Domain Portfolio</em>, choose {zone}, then <em>DNS &gt; Add New Record</em>:
    </>
  ),
  namecheap: (zone) => (
    <>
      At Namecheap, open <em>Domain List</em> and choose <em>Manage</em> beside {zone}. Under <em>Advanced DNS</em>, choose <em>Add New Record</em>:
    </>
  ),
  squarespace: (zone) => (
    <>
      At Squarespace, open <em>Domains</em>, choose {zone}, then <em>DNS Settings</em>, and under <em>Custom records</em>, <em>Add record</em>:
    </>
  ),
  porkbun: (zone) => (
    <>
      At Porkbun, open <em>Domain Management</em>, then <em>DNS</em> beside {zone}, and add:
    </>
  ),
  route53: (zone) => (
    <>
      In Route 53's console, open <em>Hosted zones</em>, choose {zone}, then <em>Create record</em>:
    </>
  ),
  hover: (zone) => (
    <>
      At Hover, choose {zone}, then <em>DNS &gt; Add a record</em>:
    </>
  ),
  ionos: (zone) => (
    <>
      At IONOS, choose the gear beside {zone} under <em>Actions</em>, then <em>DNS &gt; Add record</em>:
    </>
  ),
  other: (zone) => <>Where {zone}'s DNS is, add:</>,
};

/** How a change, or a check, changes the addresses Ember knows reach it. */
type AddressesChange = (addresses: EmberAddresses) => EmberAddresses;

interface Props {
  /** The addresses Ember knows reach it besides its own, as workspace settings has them. */
  addresses: EmberAddresses;
  /** Shows the addresses as a change, or a check, changes them, which only workspace settings shows. */
  showAddresses: (change: AddressesChange) => void;
  /** As workspace settings asks for the workspace, which it says the server answers with. */
  askForAccount: () => (account: Account) => void;
  /** Called once a change is saved. */
  onSaved: () => void;
  /** Says why saving failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * The host typed in, with or without its scheme and path, as `location.host` would write it at that
 * address, or why it can't be Ember's custom domain.
 */
function domainTyped(text: string): { domain: string } | { refusal: string } {
  const typed = text.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    return { refusal: CUSTOM_DOMAIN_NOT_A_HOST };
  }
  if (!isHost(url.host)) return { refusal: CUSTOM_DOMAIN_NOT_A_HOST };
  return canBeCustomDomain(url.hostname) ? { domain: url.host } : { refusal: NOT_A_CUSTOM_DOMAIN };
}

/** The host name of `host`, without its port, as Cloudflare takes a domain. */
const hostnameOf = (host: string) => host.replace(/:\d+$/, "");

/** The second-level labels a country's domains are commonly registered under, as example.co.uk is. */
const COUNTRY_SECOND_LEVELS = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);

/**
 * The domain `hostname` was most likely registered as, where DNS didn't say: its last two labels, or
 * three under a country's common second level, as example.co.uk.
 */
function registeredGuess(hostname: string): string {
  const labels = hostname.split(".");
  const [secondLevel, topLevel] = labels.slice(-2);
  const kept = labels.length > 2 && topLevel!.length === 2 && COUNTRY_SECOND_LEVELS.has(secondLevel!) ? 3 : 2;
  return labels.slice(-kept).join(".");
}

/**
 * Ember's address for administrators. Where a deploy puts it, while that's its address or it has none,
 * the steps to give it a custom domain, which Move to another domain shows anywhere else. At an address
 * that could be a custom domain, Use, which makes it Ember's, and while it has one, Go back to where a
 * deploy puts it, or Stop using it until Ember knows where that is. The domains Ember moved away from,
 * each with a check.
 */
export function CustomDomainSettings({ addresses, showAddresses, askForAccount, onSaved, onFailed }: Props) {
  const { customDomain } = useAccount();
  const [changing, setChanging] = useState(false);
  // Whether Move to another domain has shown the steps.
  const [moving, setMoving] = useState(false);
  const mounted = useMounted();
  const here = location.host;
  const hereCanBe = isHost(here) && canBeCustomDomain(location.hostname);
  // This page's address is where a deploy puts Ember before a page there has told it so.
  const deployed = addresses.deployed ?? (isHost(here) && !hereCanBe ? here : null);
  const worker = workerAt(deployed ?? here);
  // The page's own address, while it's a custom domain Ember has moved away from, which reaches Ember as surely as the page does.
  const left = hereCanBe && customDomain !== null && customDomain !== here ? here : null;
  const others = addresses.others.filter((address) => address !== here && address !== customDomain);
  // Where a deploy puts Ember, the steps to a custom domain are what it offers.
  const settingUpHere = !hereCanBe && (customDomain === null || customDomain === here);
  // Ember's address when the addresses were last shown. Another tab moving Ember changes them too, as only
  // the server can say, so they're asked for again then.
  const shownFor = useRef(customDomain);
  // While they're asked for, what's changed them here since, which the answer may have been read before,
  // so it's made to the answer too. Only the latest ask's answer shows.
  const asking = useRef<AddressesChange[] | null>(null);
  const changeAddresses = (change: AddressesChange) => {
    asking.current?.push(change);
    showAddresses(change);
  };
  useEffect(() => {
    if (customDomain === shownFor.current) return;
    shownFor.current = customDomain;
    const since: AddressesChange[] = [];
    asking.current = since;
    fetchWorkspaceSettings().then(
      ({ addresses }) => {
        if (asking.current !== since) return;
        asking.current = null;
        showAddresses(() => since.reduce((shown, change) => change(shown), addresses));
      },
      (error: unknown) => {
        if (asking.current === since) asking.current = null;
        if (mounted.current || isSignedOut(error)) onFailed(error);
      },
    );
  }, [customDomain, showAddresses, mounted, onFailed]);

  /** Makes `address` Ember's, then does `then`, or says why the server refused it to `refused`, where given, rather than as the workspace's alerts do. */
  const change = (address: string | null, then?: () => void, refused?: (refusal: string) => void) => {
    setChanging(true);
    const answered = askForAccount();
    changeAccount({ customDomain: address }).then(
      (account) => {
        shownFor.current = account.customDomain;
        answered(account);
        if (account.customDomain !== customDomain) changeAddresses((known) => ({ ...known, others: othersAfterMove(known.others, [customDomain, here], account.customDomain) }));
        if (!mounted.current) return;
        setChanging(false);
        setMoving(false);
        onSaved();
        then?.();
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setChanging(false);
        if (refused && error instanceof ApiError && error.status === 422) return refused(error.message);
        onFailed(error);
      },
    );
  };
  // Workspace settings stay wherever they're opened, so moving Ember from another address takes them along.
  const use = (address: string, refused?: (refusal: string) => void) => change(address, address === here ? undefined : () => void moveTo(address), refused);
  const forget = (address: string) => changeAddresses((known) => ({ ...known, others: known.others.filter((other) => other !== address) }));
  // Ember's address, or where a deploy puts it while it has none, as people open it there.
  const address = customDomain ?? (here === deployed ? here : null);
  const actions = [
    hereCanBe && customDomain !== here && (
      <button key="use" type="button" onClick={() => use(here)} disabled={changing} className={BUTTON}>
        Use {here}
      </button>
    ),
    // Where a deploy puts Ember, with no address of its own, the steps are all it offers.
    deployed !== null && customDomain !== deployed && !(customDomain === null && settingUpHere) && (
      <button key="back" type="button" onClick={() => use(deployed)} disabled={changing} className={BUTTON}>
        Go back to {deployed}
      </button>
    ),
    deployed === null && customDomain !== null && (
      <button key="stop" type="button" onClick={() => change(null)} disabled={changing} className={BUTTON}>
        Stop using it
      </button>
    ),
    !settingUpHere && !moving && (
      <button key="move" type="button" onClick={() => setMoving(true)} className={BUTTON}>
        Move to another domain
      </button>
    ),
  ].filter(Boolean);

  return (
    <section aria-labelledby="custom-domain-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <h2 id="custom-domain-heading" className="text-base font-semibold">
        Custom domain
      </h2>
      {address !== null && (
        <p>
          Ember's address is <strong className="wrap-anywhere">{address}</strong>.
        </p>
      )}
      <OtherAddresses
        left={left}
        others={others}
        sendsPeople={customDomain === null ? null : customDomain === here ? "here" : customDomain}
        worker={worker}
        onGone={forget}
        onFailed={onFailed}
      />
      {actions.length > 0 && <div className="flex flex-wrap gap-3">{actions}</div>}
      {(settingUpHere || moving) && <SetUp autoFocus={moving} worker={worker} changing={changing} use={use} onFailed={onFailed} />}
      {customDomain !== null && deployed !== null && customDomain !== deployed && (
        <p className={cn(NOTE, "wrap-anywhere")}>
          If {customDomain} stops working, open Domain settings at{" "}
          <a href={`${location.protocol}//${deployed}${workspaceSectionPath("domain-settings")}`} className="underline">
            {deployed}
          </a>{" "}
          and go back.
        </p>
      )}
    </section>
  );
}

/** A link to the Domains tab of the Worker named `worker` in Cloudflare's dashboard, or to the list of Workers where its name isn't known. */
function DomainsLink({ worker }: { worker: string | null }) {
  return (
    <a href={worker === null ? WORKERS_DASHBOARD : workerDomains(worker)} target="_blank" rel="noopener" className="wrap-anywhere underline">
      {worker === null ? "Open the Cloudflare dashboard" : `Open ${worker}'s domains`}
    </a>
  );
}

/** What checking `address`, a custom domain Ember moved away from, found there. */
const checkedNote = (address: string, reaches: CustomDomainReach) => (reaches === "ember" ? `${address} still reaches Ember.` : `${address} no longer reaches Ember.`);

/**
 * The custom domains that reach Ember besides its own, until they're removed from the Worker named
 * `worker`, forwarding people to `sendsPeople`, "here" or an address, or showing Ember while it has none,
 * null: `left`, the page's own, if it's one, and `others`, those Ember moved away from, each with a check,
 * after which one that no longer reaches Ember is gone.
 */
function OtherAddresses({
  left,
  others,
  sendsPeople,
  worker,
  onGone,
  onFailed,
}: {
  left: string | null;
  others: string[];
  sendsPeople: string | null;
  worker: string | null;
  onGone: (address: string) => void;
  onFailed: Props["onFailed"];
}) {
  // What the latest check found, or "checking" while it asks.
  const [checked, setChecked] = useState<{ address: string; reaches: CustomDomainReach | "checking" } | null>(null);
  const mounted = useMounted();
  const listed = left === null ? others : [left, ...others];

  const check = (address: string) => {
    setChecked({ address, reaches: "checking" });
    checkCustomDomain(address).then(
      (reaches) => {
        if (reaches !== "ember") onGone(address);
        if (mounted.current) setChecked({ address, reaches });
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setChecked(null);
        onFailed(error);
      },
    );
  };

  if (listed.length === 0 && checked === null) return null;
  return (
    <div className="flex flex-col gap-2">
      {listed.length > 0 && (
        <>
          <ul aria-label="Other addresses that reach Ember" className="flex flex-col gap-2">
            {listed.map((address) => (
              <li key={address} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <p className="min-w-0 flex-1 basis-[16em]">
                  <strong className="wrap-anywhere">{address}</strong> still{" "}
                  {sendsPeople === null ? "reaches Ember" : sendsPeople === "here" ? "forwards here" : <span className="wrap-anywhere">forwards to {sendsPeople}</span>}.
                </p>
                {/* The page's own address needs no check: it reaches Ember, or the page couldn't ask. */}
                {address !== left && (
                  <button type="button" aria-label={`Check ${address}`} onClick={() => check(address)} disabled={checked?.reaches === "checking"} className={BUTTON}>
                    Check
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p>
            To turn one off, remove it from <strong className="wrap-anywhere">{worker ?? "the Worker"}</strong> in Cloudflare. <DomainsLink worker={worker} />
          </p>
        </>
      )}
      <p role="status" className={cn("wrap-anywhere", checked?.reaches === "ember" && "text-negative", checked !== null && checked.reaches !== "ember" && checked.reaches !== "checking" && "text-positive")}>
        {checked !== null && (checked.reaches === "checking" ? `Checking ${checked.address}…` : checkedNote(checked.address, checked.reaches))}
      </p>
    </div>
  );
}

/** Makes a domain Ember's address and goes there, saying why the server refused it to `refused`. */
type Use = (domain: string, refused: (refusal: string) => void) => void;

/** Answers `otherwise` for any failure but being signed out, which it passes on. */
const unlessSignedOut =
  <T,>(otherwise: T) =>
  (error: unknown): T => {
    if (isSignedOut(error)) throw error;
    return otherwise;
  };

/**
 * The domain to give Ember, and then, once Set up has checked it, Save, if it already reaches Ember, or
 * where its DNS is and the steps from there: its field takes the focus at once when `autoFocus` says, as
 * when Move to another domain shows it. `worker` names the Worker that runs Ember, where that's known, and
 * `changing` says a change is saving.
 */
function SetUp({ autoFocus, worker, changing, use, onFailed }: { autoFocus: boolean; worker: string | null; changing: boolean; use: Use; onFailed: Props["onFailed"] }) {
  const [typed, setTyped] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  // The latest check, until it's answered or the field changes, which only its own answer shows.
  const asked = useRef<object | null>(null);
  // The domain being checked.
  const [checking, setChecking] = useState<string | null>(null);
  // What Set up found of the domain: whether it reaches Ember already, and where its DNS is for the steps if not.
  const [found, setFound] = useState<(CustomDomainLookup & { domain: string; reaches: CustomDomainReach }) | null>(null);
  const mounted = useMounted();

  const setUp = (event: FormEvent) => {
    event.preventDefault();
    const checked = domainTyped(typed);
    setFound(null);
    if ("refusal" in checked) return setRefusal(checked.refusal);
    const { domain } = checked;
    setRefusal(null);
    setChecking(domain);
    const check = {};
    asked.current = check;
    // Failing to find either says no more than nothing answering there yet, and DNS not saying where it is.
    Promise.all([
      checkCustomDomain(domain).catch(unlessSignedOut<CustomDomainReach>("nothing")),
      lookUpCustomDomain(domain).catch(unlessSignedOut<CustomDomainLookup>({ zone: null, provider: null })),
    ]).then(
      ([reaches, lookup]) => {
        if (!mounted.current || asked.current !== check) return;
        asked.current = null;
        setChecking(null);
        setFound({ domain, reaches, ...lookup });
      },
      (error: unknown) => {
        asked.current = null;
        setChecking(null);
        onFailed(error);
      },
    );
  };

  return (
    <>
      <form onSubmit={setUp} className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-[16em]">
          <Field id="custom_domain" label="Domain">
            <Input
              id="custom_domain"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus={autoFocus}
              placeholder="chat.example.com"
              value={typed}
              aria-invalid={refusal !== null}
              aria-describedby={refusal === null ? undefined : "custom-domain-refusal"}
              onChange={(event) => {
                setTyped(event.target.value);
                asked.current = null;
                setChecking(null);
                setFound(null);
              }}
              className={FIELD_INPUT}
            />
          </Field>
        </div>
        <button type="submit" disabled={checking !== null} className={BUTTON}>
          Set up
        </button>
      </form>
      {refusal !== null && (
        <p id="custom-domain-refusal" role="alert" className={cn(NOTE, "text-negative")}>
          {refusal}
        </p>
      )}
      {checking !== null && (
        <p role="status" className={cn(NOTE, "wrap-anywhere")}>
          Checking {checking}…
        </p>
      )}
      {found !== null &&
        (found.reaches === "ember" ? <Reaches domain={found.domain} changing={changing} use={use} /> : <Steps {...found} worker={worker} changing={changing} use={use} />)}
    </>
  );
}

/** What Set up shows for a domain that already reaches Ember, as one added to the Worker before does: no steps, only Save, which makes it Ember's address. */
function Reaches({ domain, changing, use }: { domain: string; changing: boolean; use: Use }) {
  return (
    <>
      <p className="wrap-anywhere">
        <strong>{domain}</strong> already reaches Ember.
      </p>
      <div>
        <UseButton label="Save" domain={domain} changing={changing} use={use} />
      </div>
    </>
  );
}

/** What the steps to make a domain Ember's address need, besides the provider they're for. */
interface StepsFor {
  /** The domain, as Use takes it, with any port. */
  domain: string;
  /** Its host name, as Cloudflare and DNS take it. */
  hostname: string;
  /** The zone it's in, as DNS said, or the domain it was most likely registered as. */
  zone: string;
  /** The name of the Worker that runs Ember, where that's known. */
  worker: string | null;
  changing: boolean;
  use: Use;
}

/**
 * The DNS provider menu, starting at the one public DNS says serves `zone`, the zone `domain` is in, or
 * Cloudflare where it didn't say, and the steps from there to make `domain` Ember's address: at Cloudflare,
 * adding the domain to the Worker, after moving the zone's DNS there from the provider DNS found, if any,
 * and at any other provider, keeping the DNS there through another domain on Cloudflare.
 */
function Steps({ domain, zone, provider: found, worker, changing, use }: CustomDomainLookup & { domain: string; worker: string | null; changing: boolean; use: Use }) {
  const [provider, setProvider] = useState<DnsProvider>(found ?? "cloudflare");
  const hostname = hostnameOf(domain);
  const steps: StepsFor = { domain, hostname, zone: zone ?? registeredGuess(hostname), worker, changing, use };

  return (
    <>
      <div className="max-w-[20em]">
        <Field id="dns_provider" label="DNS provider">
          <select id="dns_provider" value={provider} onChange={(event) => setProvider(event.target.value as DnsProvider)} className={SELECT}>
            {DNS_PROVIDERS.map((option) => (
              <option key={option} value={option}>
                {PROVIDER_NAMES[option]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {provider === "cloudflare" ? <OnCloudflare {...steps} from={found === "cloudflare" ? null : found} /> : <KeepingDns {...steps} provider={provider} />}
    </>
  );
}

/**
 * The steps to add the domain to the Worker, where that's known, after moving its zone's DNS to Cloudflare
 * from `from`, the provider public DNS says has it, if any: onboarding the zone, and giving it Cloudflare's
 * nameservers at that provider. Then Use.
 */
function OnCloudflare({ domain, hostname, zone, worker, changing, use, from }: StepsFor & { from: Exclude<DnsProvider, "cloudflare"> | null }) {
  return (
    <>
      {from !== null && (
        <p className={cn(NOTE, "wrap-anywhere")}>This moves {zone}'s DNS to Cloudflare, which copies its records.</p>
      )}
      <ol aria-label={`Steps to make ${domain} Ember's address`} className="flex list-decimal flex-col gap-3 ps-5">
        {from !== null && (
          <>
            <li>
              Open Cloudflare, choose <em>Onboard a domain</em>, and paste <strong className="wrap-anywhere">{zone}</strong>.
              <OpenCloudflare href={CLOUDFLARE_DOMAINS} copying={zone} />
            </li>
            <li>{NAMESERVERS_AT[from](<strong className="wrap-anywhere">{zone}</strong>)}</li>
          </>
        )}
        <li>
          {from !== null ? (
            <>
              Once Cloudflare says <strong className="wrap-anywhere">{zone}</strong> is active, open Cloudflare
            </>
          ) : (
            "Open Cloudflare"
          )}
          {worker === null ? (
            <>
              , choose the Worker that runs Ember, then <em>Domains &gt; Add Domain</em>
            </>
          ) : (
            <>
              , choose <em>Add Domain</em>
            </>
          )}
          , and paste <strong className="wrap-anywhere">{hostname}</strong>.
          <OpenCloudflare href={worker === null ? WORKERS_DASHBOARD : workerDomains(worker)} copying={hostname} />
        </li>
        <UseStep domain={domain} changing={changing} use={use} />
      </ol>
    </>
  );
}

/**
 * What giving Ember the domain while its DNS stays at `provider` takes: another domain already on
 * Cloudflare, which the person names, for Cloudflare for SaaS. The record at the provider is a CNAME,
 * which a zone's own name can't be, so the domain must be a name under its zone.
 */
function KeepingDns({ hostname, zone, provider, ...steps }: StepsFor & { provider: Exclude<DnsProvider, "cloudflare"> }) {
  const [typed, setTyped] = useState("");
  const keeping = `Keeping DNS ${provider === "other" ? "where it is" : `at ${PROVIDER_NAMES[provider]}`}`;
  if (hostname === zone) {
    return (
      <p className="wrap-anywhere">
        {keeping} takes a name under {zone}, such as chat.{zone}. Or choose Cloudflare above to move {zone}'s DNS there instead.
      </p>
    );
  }
  const named = hostnameTyped(typed);
  // The domain's own zone, or a name in it, can't send it on, its DNS being elsewhere.
  const onCloudflare = named === null || named === zone || named.endsWith(`.${zone}`) ? null : named;

  return (
    <>
      <p className="wrap-anywhere">{keeping} takes another domain that's already on Cloudflare.</p>
      <div className="max-w-[20em]">
        <Field id="saas_domain" label="Domain on Cloudflare">
          <Input
            id="saas_domain"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="example.net"
            value={typed}
            aria-describedby={onCloudflare === null ? "saas-domain-note" : undefined}
            onChange={(event) => setTyped(event.target.value)}
            className={FIELD_INPUT}
          />
        </Field>
      </div>
      {onCloudflare === null ? (
        <p id="saas-domain-note" className={cn(NOTE, "wrap-anywhere")}>
          {named === null ? `No domain on Cloudflare? Choose Cloudflare above to move ${zone}'s DNS there instead.` : `Give a domain other than ${zone}.`}
        </p>
      ) : (
        <SaasSteps {...steps} hostname={hostname} zone={zone} provider={provider} onCloudflare={onCloudflare} />
      )}
    </>
  );
}

/**
 * The steps to give Ember the domain through Cloudflare for SaaS on `onCloudflare`, another domain already
 * there: the record and fallback origin it takes, the domain as a custom hostname, and the Worker's
 * routes; then the one record to add at `provider`, and Use. A fallback origin the domain has already
 * stays, as replacing it would send its other custom hostnames to Ember's record, and the Worker's route
 * takes this one to Ember whatever it is. Cloudflare answers the certificate authority itself at
 * `/.well-known/`, so no Worker runs there.
 */
function SaasSteps({ domain, hostname, zone, worker, changing, use, provider, onCloudflare }: StepsFor & { provider: Exclude<DnsProvider, "cloudflare">; onCloudflare: string }) {
  const origin = `${SAAS_ORIGIN}.${onCloudflare}`;
  return (
    <ol aria-label={`Steps to make ${domain} Ember's address`} className="flex list-decimal flex-col gap-3 ps-5">
      <li>
        In Cloudflare, add this record to <strong className="wrap-anywhere">{onCloudflare}</strong>, proxied:
        <RecordToAdd type="AAAA" name={SAAS_ORIGIN} value="100::" />
        <OpenCloudflare href={CLOUDFLARE_DNS_RECORDS} />
      </li>
      <li>
        Under <em>Custom Hostnames</em>, enable Cloudflare for SaaS (it asks for a card, but 100 domains are free), and make{" "}
        <strong className="wrap-anywhere">{origin}</strong> the fallback origin unless it has one. Then add <strong className="wrap-anywhere">{hostname}</strong> with HTTP
        validation.
        <OpenCloudflare href={CLOUDFLARE_CUSTOM_HOSTNAMES} copying={origin} />
      </li>
      <li>
        Under <em>Workers Routes</em>, route <strong className="wrap-anywhere">{hostname}/*</strong> to{" "}
        {worker === null ? "the Worker that runs Ember" : <strong className="wrap-anywhere">{worker}</strong>}, and <strong className="wrap-anywhere">{hostname}/.well-known/*</strong> to{" "}
        <em>None</em>, so Cloudflare can get it a certificate.
      </li>
      <li>
        {RECORD_AT[provider](<strong className="wrap-anywhere">{zone}</strong>)}
        <RecordToAdd type="CNAME" name={hostname.slice(0, -zone.length - 1)} value={origin} />
      </li>
      <UseStep domain={domain} changing={changing} use={use} />
    </ol>
  );
}

/**
 * The host name typed, as the steps name a domain on Cloudflare, or null while it isn't one. It's taken as
 * typed, since the domains people register under a country's second level are too many to guess from.
 */
function hostnameTyped(text: string): string | null {
  const checked = domainTyped(text);
  if ("refusal" in checked) return null;
  const hostname = hostnameOf(checked.domain);
  return hostname.includes(".") ? hostname : null;
}

/** The last step: Use `domain`, which makes it Ember's address and goes there, or says under it why not. */
function UseStep({ domain, changing, use }: { domain: string; changing: boolean; use: Use }) {
  return (
    <li>
      <UseButton label={`Use ${domain}`} domain={domain} changing={changing} use={use} />
    </li>
  );
}

/** A button saying `label` that makes `domain` Ember's address and goes there, or says under it why not. */
function UseButton({ label, domain, changing, use }: { label: string; domain: string; changing: boolean; use: Use }) {
  const [refusal, setRefusal] = useState<string | null>(null);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={() => {
            setRefusal(null);
            use(domain, setRefusal);
          }}
          disabled={changing}
          className={BUTTON}
        >
          {label}
        </button>
        <p className={cn(NOTE, "min-w-0 flex-1 basis-[12em]")}>Everyone signs in again there.</p>
      </div>
      {refusal !== null && (
        <p role="alert" className={cn(NOTE, "mt-2 text-negative wrap-anywhere")}>
          {refusal}
        </p>
      )}
    </>
  );
}

/** A DNS record to add, part by part, as DNS forms ask for them, with buttons that copy its name and value. */
function RecordToAdd({ type, name, value }: { type: string; name: string; value: string }) {
  const parts = [
    ["Type", type],
    ["Name", name],
    ["Value", value],
  ] as const;
  return (
    <dl className="mt-2 flex flex-col gap-1 rounded-[9px] border bg-background px-3 py-1.5">
      {parts.map(([label, part]) => (
        <div key={label} className="flex min-h-9 items-center gap-3 touch:min-h-11">
          <dt className={cn(NOTE, "w-[3.5em] flex-none")}>{label}</dt>
          <dd className="flex min-w-0 flex-1 items-center gap-3">
            <code className="min-w-0 flex-1 text-[0.9em] wrap-anywhere">{part}</code>
            {label !== "Type" && <CopyButton text={part} label={`Copy ${part}`} className={ROUND_BUTTON} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A link that opens Cloudflare's dashboard at `href` in a new tab, copying `copying`, where given, for the
 * person to paste there, and says it's copied while `copying` is still what it copied, since a domain
 * typed into the steps can change it. A clipboard that refuses, as on a page that isn't served securely,
 * says nothing, and the step names what to paste anyway.
 */
function OpenCloudflare({ href, copying }: { href: string; copying?: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const mounted = useMounted();
  const copy = () => {
    if (copying === undefined) return;
    navigator.clipboard?.writeText(copying).then(
      () => mounted.current && setCopied(copying),
      () => {},
    );
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
      <a href={href} target="_blank" rel="noopener" onClick={copy} className={BUTTON}>
        Open Cloudflare
      </a>
      {copying !== undefined && (
        <p role="status" className={cn(NOTE, "min-w-0 flex-1 basis-[12em] wrap-anywhere")}>
          {copied === copying && `Copied ${copying}.`}
        </p>
      )}
    </div>
  );
}
