import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ACCOUNT_ID_REFUSED,
  API_TOKEN_REFUSED,
  ASSISTANT_MODELS,
  MODEL_REFUSED,
  accountIdOf,
  apiTokenOf,
  modelName,
  modelOf,
  type AssistantField,
  type AssistantKeys,
  type AssistantModel,
  type AssistantSettings,
  type WebTool,
} from "@ember/protocol/assistant";
import { FIELD_INPUT, Field } from "@/components/field";
import { Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { ApiError, isSignedOut, listAssistantModels, saveAssistant } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ANOTHER_MODEL, dashboard, FieldRefusal, idOf, ModelPicker, modelChoiceOf, NOTE, Out, type ModelChoice, type Refusal } from "./model-picker";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE, MAIN_ACTION, OTHER_ACTION } from "./unsaved-changes";

// Set up Ember AI, for administrators: the steps to give @ember a model through Cloudflare AI Gateway, in
// a dialog that the AI assistant tab's Ember AI card opens. First the Cloudflare account's ID, filled in
// with the account Ember is deployed to when the deploy gave it, and an API token of its, which Workers
// AI's Use REST API makes, and with which the Worker lists the text models in Cloudflare's catalog. Then
// the model, which the Worker asks a test question through AI Gateway before keeping all three, saying on
// the field it's about why it didn't answer, if it didn't, and which answers everyone who hasn't picked
// another. Then what the model said, and that Search the web is off, when a change of model turned it
// off. Styled as Set up Turnstile is.

/** Where Workers AI's Use REST API makes an API token and shows the account's ID, in the Cloudflare dashboard. */
const workersAiDashboard = (accountId: string | null) => dashboard(accountId, "ai/workers-ai");

/**
 * What the last step says once a change of model, or of the Cloudflare account it's asked through, has
 * turned Search the web off, leaving @ember doing `webTools` on the web: that it can try it again, or that
 * the model can't search.
 */
export const searchTurnedOff = (webTools: WebTool[] | null, changed: "model" | "account" = "model") =>
  webTools === null ? "Search the web is off, as this model can't search the web through AI Gateway." : `Search the web is off for the new ${changed}. Turn it on again to try it.`;

/** What Set up Ember AI changed of `before` in saving `after`, which turns Search the web off: the account, if only that. */
const changeOf = (before: AssistantSettings, after: AssistantSettings) => (before.accountId !== after.accountId && before.model === after.model ? "account" : "model");

/** Where it's at: the account and its API token, the model, or done. */
type Step = "keys" | "model" | "done";

const TITLES: Record<Step, string> = { keys: "Set up Ember AI", model: "Choose a model", done: "Ember AI is set up" };

/** The models Cloudflare's catalog listed for the account and API token `keys` names, as `JSON.stringify` writes them, and why it couldn't be read, if it couldn't. */
interface Listed {
  keys: string;
  models: AssistantModel[];
  unread: string | null;
}

/** The fields of the first step. */
type KeyField = Exclude<AssistantField, "model">;

interface Props {
  assistant: AssistantSettings | null;
  /** The Cloudflare account Ember is deployed to, which the account's ID starts as while Ember AI is off, if the deploy gave it. */
  deployedAccountId: string | null;
  /** Shows Ember AI as it's saved. */
  onSaved: (assistant: AssistantSettings) => void;
  onClose: () => void;
  /** Says why saving failed, when it isn't the setup's or AI Gateway's doing, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Set up Ember AI: the account and its API token, then the model, which saves them once it answers a test question. */
export function AssistantSetup({ assistant, deployedAccountId, onSaved, onClose, onFailed }: Props) {
  const [step, setStep] = useState<Step>("keys");
  // The account's ID as Ember AI has it, or else as the deploy gave it, which the steps then needn't say where to copy from.
  const [filledIn] = useState(() => assistant?.accountId ?? deployedAccountId);
  const [typed, setTyped] = useState<Record<KeyField, string>>({ accountId: filledIn ?? "", apiToken: "" });
  const [listed, setListed] = useState<Listed | null>(null);
  const [listing, setListing] = useState(false);
  const [model, setModel] = useState(() => modelChoiceOf(assistant, ASSISTANT_MODELS));
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Asking the model a test question holds the dialog open until it's answered.
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ assistant: AssistantSettings; greeting: string } | null>(null);
  // Ember AI as it was when the dialog opened, which saving it replaces: whether @ember searched the web then,
  // which another model or account may not do with the same tools, and so doesn't until it's tried.
  const [opened] = useState(assistant);
  const title = useRef<HTMLHeadingElement>(null);
  const shown = useRef(step);
  const mounted = useMounted();

  // Each step starts at its title, so that it's read first.
  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    title.current?.focus();
  }, [step]);

  const refuse = (field: AssistantField | null, error: string) => {
    setRefusal({ field, error });
    if (field === "accountId" || field === "apiToken") setStep("keys");
  };

  /** The account and API token as typed, a blank token keeping the one Ember has. */
  const keys = (): AssistantKeys => {
    const apiToken = apiTokenOf(typed.apiToken);
    return { accountId: accountIdOf(typed.accountId) ?? "", ...(apiToken && { apiToken }) };
  };

  /** Goes on to the model, once Cloudflare's catalog has listed the account's models, as it has already for the same keys. */
  const listModels = () => {
    const listedFor = JSON.stringify(keys());
    if (listed?.keys === listedFor) return setStep("model");
    setRefusal(null);
    setListing(true);
    listAssistantModels(keys()).then(
      ({ models, refusal: unread }) => {
        if (!mounted.current) return;
        setListing(false);
        setListed({ keys: listedFor, models, unread });
        // The choice stays while the catalog lists it.
        setModel((choice) => (choice.chosen === ANOTHER_MODEL || models.some(({ id }) => id === choice.chosen) ? choice : modelChoiceOf(assistant, models)));
        setStep("model");
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setListing(false);
        if (error instanceof ApiError && error.status === 422) return refuse(fieldOf(error.field), error.message);
        onFailed(error);
      },
    );
  };

  const save = (chosen: string) => {
    setRefusal(null);
    setSaving(true);
    const name = listed?.models.find(({ id }) => id === chosen)?.name;
    saveAssistant({ ...keys(), model: chosen, ...(name && { modelName: name }) }).then(
      (answer) => {
        onSaved(answer.assistant);
        if (!mounted.current) return;
        setSaving(false);
        setSaved(answer);
        setStep("done");
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        // What AI Gateway or the Worker said of the setup, or that AI Gateway didn't answer, which the step says itself.
        if (error instanceof ApiError && [422, 429, 502].includes(error.status)) return refuse(fieldOf(error.field), error.message);
        onFailed(error);
      },
    );
  };

  const steps: Record<Step, ReactNode> = {
    keys: (
      <KeysStep
        hasToken={assistant !== null}
        filledIn={filledIn !== null}
        deployedAccountId={deployedAccountId}
        typed={typed}
        onType={(field, text) => {
          setTyped((typed) => ({ ...typed, [field]: text }));
          if (refusal?.field === field) setRefusal(null);
        }}
        refusal={refusal}
        onRefuse={refuse}
        listing={listing}
        onContinue={listModels}
        onCancel={onClose}
      />
    ),
    model: (
      <ModelStep
        accountId={accountIdOf(typed.accountId)}
        models={listed?.models ?? ASSISTANT_MODELS}
        unread={listed?.unread ?? null}
        model={model}
        onChoose={(model) => {
          setModel(model);
          if (refusal?.field === "model" || refusal?.field === null) setRefusal(null);
        }}
        refusal={refusal}
        onRefuse={refuse}
        saving={saving}
        onSave={save}
        onBack={() => setStep("keys")}
      />
    ),
    done: saved && (
      <>
        <DialogDescription className="mb-4 leading-[1.65]">
          @ember is in every room open to everyone, running on <span className="wrap-anywhere">{modelName(saved.assistant.model, saved.assistant.models)}</span>.
          Asked to say hello, it said:
        </DialogDescription>
        <blockquote className="border-s-2 ps-3 whitespace-pre-wrap wrap-anywhere">{saved.greeting}</blockquote>
        {opened?.webTools?.includes("search") && !saved.assistant.webTools?.includes("search") && (
          <p className={cn(NOTE, "mt-4")}>{searchTurnedOff(saved.assistant.webTools, changeOf(opened, saved.assistant))}</p>
        )}
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
        // What's typed isn't lost to a click beside it.
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

/** The field of Set up Ember AI a refusal names, if it names one. */
function fieldOf(field: string | undefined): AssistantField | null {
  return field === "accountId" || field === "apiToken" || field === "model" ? field : null;
}

/** The buttons at a step's foot, as Set up Turnstile's are: going back, or else cancelling, and going on. */
export function Actions({
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

/**
 * The first step: the Cloudflare account's ID and an API token of its, from Workers AI's Use REST API,
 * which go on to the model once they can be an account's, a token left blank keeping the one Ember has,
 * and Cloudflare's catalog has listed the account's models. The dashboard opens at the account typed,
 * once it can be one.
 */
function KeysStep({
  hasToken,
  filledIn,
  deployedAccountId,
  typed,
  onType,
  refusal,
  onRefuse,
  listing,
  onContinue,
  onCancel,
}: {
  hasToken: boolean;
  /** Whether the account's ID was filled in, so that the steps needn't say where to copy it from. */
  filledIn: boolean;
  deployedAccountId: string | null;
  typed: Record<KeyField, string>;
  onType: (field: KeyField, text: string) => void;
  refusal: Refusal | null;
  onRefuse: (field: KeyField, error: string) => void;
  /** Whether Cloudflare's catalog is listing the account's models, which holds the step until it has. */
  listing: boolean;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const next = (event: FormEvent) => {
    event.preventDefault();
    if (accountIdOf(typed.accountId) === null) return onRefuse("accountId", ACCOUNT_ID_REFUSED);
    if (typed.apiToken.trim() !== "" && apiTokenOf(typed.apiToken) === null) return onRefuse("apiToken", API_TOKEN_REFUSED);
    onContinue();
  };
  const accountId = accountIdOf(typed.accountId);
  const accountRefused = refusal?.field === "accountId";
  const deployedTo = !accountRefused && deployedAccountId !== null && accountId === deployedAccountId;
  const tokenRefused = refusal?.field === "apiToken";

  return (
    <form onSubmit={next}>
      <DialogDescription className="mb-4 leading-[1.65]">
        Ember AI asks a model through your Cloudflare account's AI Gateway. Workers AI's models come with a free daily allowance, and other companies' are paid
        for with AI Gateway's credits. Ember keeps the API token encrypted.
      </DialogDescription>
      <ol aria-label="Steps to make a Workers AI API token" className="mb-4 flex list-decimal flex-col gap-2 ps-5">
        <li>
          In the Cloudflare dashboard, open <em>Workers AI</em> and choose <em>Use REST API</em>. <Out href={workersAiDashboard(accountId)}>Open Workers AI in the Cloudflare dashboard</Out>
        </li>
        <li>
          Choose <em>Create a Workers AI API Token</em>, then <em>Create API Token</em>, and copy the token here.
        </li>
        {!filledIn && (
          <li>
            Copy the <em>Account ID</em> shown there too.
          </li>
        )}
      </ol>
      <div className="flex flex-col gap-4">
        <div>
          <Field id="assistant_account_id" label="Account ID">
            <Input
              id="assistant_account_id"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={typed.accountId}
              disabled={listing}
              aria-invalid={accountRefused}
              aria-describedby={accountRefused ? "assistant-account-id-refusal" : deployedTo ? "assistant-account-id-description" : undefined}
              onChange={(event) => onType("accountId", event.target.value)}
              className={FIELD_INPUT}
            />
          </Field>
          {accountRefused ? (
            <FieldRefusal id="assistant-account-id-refusal" field="accountId" refusal={refusal} />
          ) : (
            deployedTo && (
              <p id="assistant-account-id-description" className={cn(NOTE, "mt-2")}>
                Ember is deployed to this account. To ask through another, paste that account's ID.
              </p>
            )
          )}
        </div>
        <div>
          <Field id="assistant_api_token" label="API token">
            <Input
              id="assistant_api_token"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={typed.apiToken}
              disabled={listing}
              aria-invalid={tokenRefused}
              aria-describedby={tokenRefused ? "assistant-api-token-refusal" : hasToken ? "assistant-api-token-description" : undefined}
              onChange={(event) => onType("apiToken", event.target.value)}
              className={FIELD_INPUT}
            />
          </Field>
          {tokenRefused ? (
            <FieldRefusal id="assistant-api-token-refusal" field="apiToken" refusal={refusal} />
          ) : (
            hasToken && (
              <p id="assistant-api-token-description" className={cn(NOTE, "mt-2")}>
                Ember has an API token already. Leave this blank to keep it, or paste another to ask with it instead.
              </p>
            )
          )}
        </div>
      </div>
      <p role="status" className={cn(NOTE, "mt-4 empty:mt-0")}>
        {listing ? "Listing the models in Cloudflare's catalog…" : null}
      </p>
      <Actions
        back={onCancel}
        backLabel="Cancel"
        next={null}
        nextLabel={listing ? "Listing models…" : "Continue"}
        disabled={typed.accountId.trim() === "" || (!hasToken && typed.apiToken.trim() === "")}
        saving={listing}
      />
    </form>
  );
}

/**
 * The second step: the model @ember runs on, of those Cloudflare's catalog lists for the account, or Ember
 * knows, or any other in the catalog, by its ID, which Save asks a test question. AI Gateway's credits are
 * topped up in the account given, `accountId`.
 */
function ModelStep({
  accountId,
  models,
  unread,
  model,
  onChoose,
  refusal,
  onRefuse,
  saving,
  onSave,
  onBack,
}: {
  accountId: string | null;
  models: readonly AssistantModel[];
  unread: string | null;
  model: ModelChoice;
  onChoose: (model: ModelChoice) => void;
  refusal: Refusal | null;
  onRefuse: (field: AssistantField, error: string) => void;
  saving: boolean;
  onSave: (model: string) => void;
  onBack: () => void;
}) {
  const id = idOf(model);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const chosen = modelOf(id);
    if (chosen === null) return onRefuse("model", MODEL_REFUSED);
    onSave(chosen);
  };

  return (
    <form onSubmit={save}>
      <DialogDescription className="mb-4 leading-[1.65]">
        Choose the model @ember answers everyone with. Ember asks it a test question through AI Gateway before keeping it. You can let people pick other models
        later.
      </DialogDescription>
      <ModelPicker models={models} unread={unread} choice={model} onChoose={onChoose} refusal={refusal} disabled={saving} accountId={accountId} />
      <p role="status" className={cn(NOTE, "mt-2 wrap-anywhere empty:mt-0", !saving && "text-negative")}>
        {saving ? `Asking ${modelName(id, models)} a test question…` : refusal?.field === null ? refusal.error : null}
      </p>
      <Actions back={onBack} next={null} nextLabel={saving ? "Asking…" : "Save"} disabled={id === ""} saving={saving} />
    </form>
  );
}
