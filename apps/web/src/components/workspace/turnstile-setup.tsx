import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { TURNSTILE_CHECK_PATH, TURNSTILE_SECRET_KEY_REFUSED, TURNSTILE_SITE_KEY_REFUSED, turnstileKeyOf, type WorkspaceSettings } from "@ember/protocol";
import { FIELD_INPUT, Field } from "@/components/field";
import { Xmark } from "@/components/icons/iconoir";
import { FLEXIBLE_MIN_WIDTH } from "@/components/turnstile-check";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { ApiError, isSignedOut, saveTurnstileKeys } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE, MAIN_ACTION, OTHER_ACTION } from "./unsaved-changes";

// Set up Turnstile, for administrators: the steps to give Ember a Cloudflare Turnstile widget's keys, in
// a dialog that Membership's Turnstile card opens, as do the ways to join whose limits stand in for its
// check, as the project's owner asked (2026-10-30). First the widget, which Cloudflare's dashboard makes
// for Ember's hostname, and its keys; then its check, drawn with the site key by a page of Ember's own
// in a frame, since only that page's policy lets Turnstile load, which says what came of it. Once it
// passes, the Worker asks siteverify about its token with the secret key, which says that the keys are
// one widget's and that it checks people here, and keeps them. Styled as Set up email is.

/** Where Turnstile's widgets are made, in the Cloudflare dashboard. */
export const TURNSTILE_DASHBOARD = "https://dash.cloudflare.com/?to=/:account/turnstile";

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** Where it's at: the widget's keys, its check, or done. */
type Step = "keys" | "check" | "done";

const TITLES: Record<Step, string> = { keys: "Set up Turnstile", check: "Pass the widget's check", done: "Turnstile is set up" };

/** A key's field, which a refusal is about. */
type KeyField = "siteKey" | "secretKey";

/** What the check page tells the page that framed it of the check, as its script says (the Worker's turnstile.ts). */
type CheckSaid = { token: string } | { expired: true } | { error: string } | { unavailable: true };

function isCheckSaid(value: unknown): value is CheckSaid {
  if (typeof value !== "object" || value === null) return false;
  const said = value as Record<string, unknown>;
  return typeof said.token === "string" || said.expired === true || typeof said.error === "string" || said.unavailable === true;
}

/** Turnstile's error codes for a site key it doesn't know, or a widget that's turned off. */
const UNKNOWN_SITE_KEY_CODES = ["110100", "110110", "400020", "400070"];
const SITE_KEY_UNKNOWN = "Turnstile doesn't know that site key. Copy it again from your widget in Cloudflare Turnstile.";
/** Turnstile's error code for a page whose hostname the widget doesn't list. */
const UNLISTED_HOSTNAME_CODE = "110200";
const CHECK_UNAVAILABLE = "Turnstile's check didn't load. Make sure nothing in this browser blocks challenges.cloudflare.com, then try again.";

interface Props {
  turnstile: WorkspaceSettings["turnstile"];
  /** Shows where Ember's Turnstile keys come from once the ones given are saved. */
  onSaved: (turnstile: WorkspaceSettings["turnstile"]) => void;
  onClose: () => void;
  /** Says why saving failed, when it isn't the keys' or the check's doing, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Set up Turnstile: a widget's keys, then its check, which saves them once it passes. */
export function TurnstileSetup({ turnstile, onSaved, onClose, onFailed }: Props) {
  const [step, setStep] = useState<Step>("keys");
  const [typed, setTyped] = useState<Record<KeyField, string>>({ siteKey: "", secretKey: "" });
  // Why a key is refused, said on its field.
  const [refusal, setRefusal] = useState<{ field: KeyField; error: string } | null>(null);
  // Checking the keys with Cloudflare holds the dialog open until it's answered.
  const [saving, setSaving] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const shown = useRef(step);

  // Each step starts at its title, so that it's read first.
  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    title.current?.focus();
  }, [step]);

  const refuse = (field: KeyField, error: string) => {
    setRefusal({ field, error });
    setStep("keys");
  };

  const steps: Record<Step, ReactNode> = {
    keys: (
      <KeysStep
        turnstile={turnstile}
        typed={typed}
        onType={(field, text) => {
          setTyped((typed) => ({ ...typed, [field]: text }));
          if (refusal?.field === field) setRefusal(null);
        }}
        refusal={refusal}
        onRefuse={refuse}
        onContinue={() => setStep("check")}
        onCancel={onClose}
      />
    ),
    check: (
      <CheckStep
        // As typed, which the keys step found are keys.
        siteKey={turnstileKeyOf(typed.siteKey) ?? ""}
        secretKey={turnstileKeyOf(typed.secretKey) ?? ""}
        saving={saving}
        setSaving={setSaving}
        onSaved={onSaved}
        onContinue={() => setStep("done")}
        onRefused={refuse}
        onBack={() => setStep("keys")}
        onFailed={onFailed}
      />
    ),
    done: (
      <>
        <DialogDescription className="mb-4 leading-[1.65]">
          Turnstile now checks that whoever signs up, or asks Ember to email them a link to join or a code to reset a password, is a person, in place of the
          limits on each network.
        </DialogDescription>
        <Actions back={null} next={onClose} nextLabel="Done" />
      </>
    ),
  };

  return (
    <Dialog open onOpenChange={(open) => open || saving || onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-busy={saving || undefined}
        overlayClassName={DIALOG_BACKDROP}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        // The keys typed aren't lost to a click beside it.
        onInteractOutside={(event) => event.preventDefault()}
        className={cn(DIALOG, "w-[480px]")}
      >
        <button type="button" aria-label="Close" disabled={saving} onClick={onClose} className={DIALOG_CLOSE}>
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

/** The buttons at a step's foot, as Set up email's are: going back, or else cancelling, and going on. */
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
    <a href={href} target="_blank" rel="noopener" className="underline">
      {children}
    </a>
  );
}

/** The first step: making the widget for Ember's hostname, and its keys, which go on to its check once they can be a widget's. */
function KeysStep({
  turnstile,
  typed,
  onType,
  refusal,
  onRefuse,
  onContinue,
  onCancel,
}: {
  turnstile: WorkspaceSettings["turnstile"];
  typed: Record<KeyField, string>;
  onType: (field: KeyField, text: string) => void;
  refusal: { field: KeyField; error: string } | null;
  onRefuse: (field: KeyField, error: string) => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const next = (event: FormEvent) => {
    event.preventDefault();
    const [siteKey, secretKey] = [turnstileKeyOf(typed.siteKey), turnstileKeyOf(typed.secretKey)];
    if (siteKey === null) return onRefuse("siteKey", TURNSTILE_SITE_KEY_REFUSED);
    if (secretKey === null || secretKey === siteKey) return onRefuse("secretKey", TURNSTILE_SECRET_KEY_REFUSED);
    onContinue();
  };

  return (
    <form onSubmit={next}>
      <DialogDescription className="mb-4 leading-[1.65]">
        Cloudflare Turnstile checks that whoever signs up, or asks Ember to email them, is a person, mostly without asking them anything. It's free, and Ember
        keeps the widget's secret key encrypted.
      </DialogDescription>
      <ol aria-label="Steps to make a Turnstile widget" className="mb-4 flex list-decimal flex-col gap-2 ps-5">
        <li>
          In the Cloudflare dashboard, open <em>Turnstile</em> and choose <em>Add widget</em>. Name it, add <strong className="wrap-anywhere">{location.hostname}</strong>{" "}
          under <em>Hostname Management</em>, leave the mode <em>Managed</em>, and create it. <Out href={TURNSTILE_DASHBOARD}>Open Turnstile in the Cloudflare dashboard</Out>
        </li>
        <li>Copy the widget's site key and secret key here.</li>
      </ol>
      <div className="flex flex-col gap-4">
        <KeyInput field="siteKey" id="turnstile_site_key" label="Site key" typed={typed.siteKey} onType={onType} refusal={refusal} />
        <KeyInput field="secretKey" id="turnstile_secret_key" label="Secret key" typed={typed.secretKey} onType={onType} refusal={refusal} />
      </div>
      {turnstile === "saved" && <p className={cn(NOTE, "mt-2")}>Ember has a widget's keys already. Give another widget's to check people with it instead.</p>}
      <Actions back={onCancel} backLabel="Cancel" next={null} disabled={typed.siteKey.trim() === "" || typed.secretKey.trim() === ""} />
    </form>
  );
}

/** A key's field, with why it's refused under it, if it is. */
function KeyInput({
  field,
  id,
  label,
  typed,
  onType,
  refusal,
}: {
  field: KeyField;
  id: string;
  label: string;
  typed: string;
  onType: (field: KeyField, text: string) => void;
  refusal: { field: KeyField; error: string } | null;
}) {
  const refused = refusal?.field === field ? refusal.error : null;
  return (
    <div>
      <Field id={id} label={label}>
        <Input
          id={id}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="0x4AAAAAAA…"
          value={typed}
          aria-invalid={refused !== null}
          aria-describedby={refused !== null ? `${id}_refusal` : undefined}
          onChange={(event) => onType(field, event.target.value)}
          className={FIELD_INPUT}
        />
      </Field>
      {refused !== null && (
        <p id={`${id}_refusal`} role="alert" className={cn(NOTE, "mt-2 text-negative")}>
          {refused}
        </p>
      )}
    </div>
  );
}

/**
 * The widget's check, drawn with its site key, whose token, once it passes, Cloudflare is asked about with
 * the secret key, which saves the keys. A key Turnstile or Cloudflare refuses goes back to its field, and
 * any other trouble is said under the check, which Try again draws afresh.
 */
function CheckStep({
  siteKey,
  secretKey,
  saving,
  setSaving,
  onSaved,
  onContinue,
  onRefused,
  onBack,
  onFailed,
}: {
  siteKey: string;
  secretKey: string;
  saving: boolean;
  setSaving: (saving: boolean) => void;
  onSaved: (turnstile: WorkspaceSettings["turnstile"]) => void;
  onContinue: () => void;
  onRefused: (field: KeyField, error: string) => void;
  onBack: () => void;
  onFailed: (error: unknown) => void;
}) {
  // How many times the check has been drawn, which drawing it afresh counts, giving its frame a key of its own.
  const [drawn, setDrawn] = useState(0);
  // Whether the check has come to something that drawing it afresh tries again, and what's said of it.
  const [stuck, setStuck] = useState<{ problem: ReactNode } | null>(null);
  const mounted = useMounted();

  const drawAfresh = () => {
    setStuck(null);
    setDrawn((drawn) => drawn + 1);
  };

  const save = (turnstileToken: string) => {
    setStuck(null);
    setSaving(true);
    saveTurnstileKeys({ siteKey, secretKey, turnstileToken }).then(
      (turnstile) => {
        onSaved(turnstile);
        if (!mounted.current) return;
        setSaving(false);
        onContinue();
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        if (error instanceof ApiError && error.status === 422 && (error.field === "siteKey" || error.field === "secretKey")) return onRefused(error.field, error.message);
        // A check that expired, or Cloudflare out of reach, which a fresh check tries again.
        if (error instanceof ApiError && [422, 502].includes(error.status)) return setStuck({ problem: error.message });
        setStuck({ problem: null });
        onFailed(error);
      },
    );
  };

  const heard = (said: CheckSaid) => {
    // A check passed again while its last token is being asked about waits for that answer.
    if ("token" in said) return void (saving || save(said.token));
    if ("unavailable" in said) return setStuck({ problem: CHECK_UNAVAILABLE });
    // Turnstile checks again by itself once a token expires or a challenge times out, giving a new token.
    if ("expired" in said) return;
    if (UNKNOWN_SITE_KEY_CODES.includes(said.error)) return onRefused("siteKey", SITE_KEY_UNKNOWN);
    if (said.error === UNLISTED_HOSTNAME_CODE)
      return setStuck({
        problem: (
          <>
            This widget doesn't list {location.hostname}. Add it under <em>Hostname Management</em> in Cloudflare Turnstile, then try again.{" "}
            <Out href={TURNSTILE_DASHBOARD}>Open Turnstile in the Cloudflare dashboard</Out>
          </>
        ),
      });
    setStuck({ problem: `Turnstile's check didn't pass (error ${said.error}). Try again, or in another browser.` });
  };

  return (
    <>
      <DialogDescription className="mb-4 leading-[1.65]">
        Ember draws the widget's check with its site key. Once it passes, Ember asks Cloudflare whether the secret key is the same widget's, then keeps both.
      </DialogDescription>
      <CheckFrame key={drawn} siteKey={siteKey} onSaid={heard} />
      <p role="status" className={cn(NOTE, "mt-2 wrap-anywhere empty:mt-0", stuck?.problem && "text-negative")}>
        {saving ? "Checking the keys with Cloudflare…" : stuck?.problem}
      </p>
      <Actions
        back={onBack}
        next={drawAfresh}
        nextLabel={saving ? "Checking…" : stuck ? "Try again" : "Waiting for the check…"}
        disabled={stuck === null}
        saving={saving}
      />
    </>
  );
}

/**
 * The widget's check, which the check page draws with `siteKey` in a frame as wide as the step, in the
 * page's appearance, compact where the step is narrower than it draws, telling `onSaid` what came of it.
 */
function CheckFrame({ siteKey, onSaid }: { siteKey: string; onSaid: (said: CheckSaid) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  // Found before it's drawn, since the check keeps the size it's drawn at.
  const [size, setSize] = useState<"flexible" | "compact" | null>(null);
  // The callback as it is now, for what the frame says later.
  const heard = useRef(onSaid);
  useLayoutEffect(() => {
    heard.current = onSaid;
  });

  useLayoutEffect(() => setSize((box.current?.clientWidth ?? 0) >= FLEXIBLE_MIN_WIDTH ? "flexible" : "compact"), []);

  useEffect(() => {
    const listen = (event: MessageEvent) => {
      // Only the check page, in this frame, at Ember's own origin, says what came of the check.
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      const said: unknown = (event.data as { turnstileCheck?: unknown } | null)?.turnstileCheck;
      if (isCheckSaid(said)) heard.current(said);
    };
    addEventListener("message", listen);
    return () => removeEventListener("message", listen);
  }, []);

  const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
  // As tall as the check draws at its size, so that nothing moves as it appears.
  return (
    <div ref={box} className={size === "compact" ? "h-[140px]" : "h-[65px]"}>
      {size && (
        <iframe
          ref={frame}
          title="Turnstile's check"
          src={`${TURNSTILE_CHECK_PATH}#${new URLSearchParams({ site_key: siteKey, theme, size })}`}
          className="block size-full border-0"
        />
      )}
    </div>
  );
}
