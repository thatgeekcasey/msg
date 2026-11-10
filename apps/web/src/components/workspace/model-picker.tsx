import type { ReactNode } from "react";
import {
  ASSISTANT_MODELS,
  MAX_MODEL_LENGTH,
  isWorkersAiModel,
  type AssistantField,
  type AssistantModel,
  type AssistantSettings,
  type ModelPrice,
} from "@ember/protocol/assistant";
import { FIELD_INPUT, Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// The menu of the models @ember can answer with, which Set up Ember AI and Add a model share: Workers AI's
// models, then other companies', as Cloudflare's catalog lists them, with what they cost, or else the
// ones Ember knows, and any other model by its ID. Under it, who pays for the model chosen, and why the
// catalog couldn't be read, if it couldn't.

export const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";
export const SELECT = cn("w-full min-w-0 border outline-none dark:bg-input/30", FIELD_INPUT);

/**
 * The page at `path` in the Cloudflare dashboard, in the account `accountId` names, or else in the one
 * the dashboard picks, asking someone with several accounts which.
 */
export const dashboard = (accountId: string | null, path: string) =>
  accountId === null ? `https://dash.cloudflare.com/?to=/:account/${path}` : `https://dash.cloudflare.com/${accountId}/${path}`;

/** Where AI Gateway's credits are topped up, under Credits Available, in the Cloudflare dashboard. */
const aiGatewayDashboard = (accountId: string | null) => dashboard(accountId, "ai/ai-gateway");

/** Cloudflare's catalog of the models AI Gateway takes. */
export const MODEL_CATALOG = "https://developers.cloudflare.com/ai/models/";

/** What the menu says under it when Cloudflare's catalog couldn't be read. */
export const CATALOG_UNREAD = "Ember couldn't read Cloudflare's model catalog, so these are the models it knows.";

/** The menu's choice for a model it doesn't list, whose ID is typed. */
export const ANOTHER_MODEL = "";

/** The menu as it's set: a listed model's ID, or `ANOTHER_MODEL`, with the ID typed for that. */
export interface ModelChoice {
  chosen: string;
  typed: string;
}

/** Why a field is refused, said on it, or else, with no field, under the step's. */
export interface Refusal {
  field: AssistantField | null;
  error: string;
}

/** The ID `choice` gives, the model chosen, or as typed, which may not be one yet. */
export const idOf = (choice: ModelChoice) => (choice.chosen === ANOTHER_MODEL ? choice.typed.trim() : choice.chosen);

/** What the menu starts as: Ember AI's model, under Another model if `models` don't list it, or while it's off, the first model Ember knows, or else the first listed. */
export function modelChoiceOf(assistant: AssistantSettings | null, models: readonly AssistantModel[]): ModelChoice {
  const listed = (id: string) => models.some((model) => model.id === id);
  if (assistant !== null) return listed(assistant.model) ? { chosen: assistant.model, typed: "" } : { chosen: ANOTHER_MODEL, typed: assistant.model };
  return { chosen: [ASSISTANT_MODELS[0]!.id, models[0]?.id].find((id) => id !== undefined && listed(id)) ?? ANOTHER_MODEL, typed: "" };
}

/** `amount` in US dollars, with cents, or fractions of a cent, when it has them. */
export const dollars = (amount: number) =>
  amount.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 3 });

/** What `price` says, as a model's menu entry shows it: what a million tokens read costs, then a million written. */
const shortPrice = ({ input, output }: ModelPrice) => `${dollars(input)} / ${dollars(output)}`;

/** A link out, which opens in a new tab. */
export function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener" className="underline">
      {children}
    </a>
  );
}

/** Why `field` is refused, under it, if it is. */
export function FieldRefusal({ id, field, refusal }: { id: string; field: AssistantField; refusal: Refusal | null }) {
  if (refusal?.field !== field) return null;
  return (
    <p id={id} role="alert" className={cn(NOTE, "mt-2 wrap-anywhere text-negative")}>
      {refusal.error}
    </p>
  );
}

interface Props {
  /** The models to list: Cloudflare's catalog's, or else the ones Ember knows. */
  models: readonly AssistantModel[];
  /** Why the catalog couldn't be read, when it couldn't. */
  unread: string | null;
  choice: ModelChoice;
  onChoose: (choice: ModelChoice) => void;
  refusal: Refusal | null;
  disabled: boolean;
  /** The Cloudflare account whose AI Gateway's credits pay for other companies' models. */
  accountId: string | null;
}

/** The menu of `models`, with Another model, whose ID is typed, and under it who pays for the one chosen. */
export function ModelPicker({ models, unread, choice, onChoose, refusal, disabled, accountId }: Props) {
  const another = choice.chosen === ANOTHER_MODEL;
  const id = idOf(choice);
  const chosen = models.find((model) => model.id === id);
  const modelRefused = refusal?.field === "model";
  const described = (...ids: Array<string | false>) => ids.filter(Boolean).join(" ") || undefined;
  const groups = [
    { label: "Workers AI, with a free daily allowance", models: models.filter((model) => isWorkersAiModel(model.id)) },
    { label: "Other companies', paid for with AI Gateway's credits", models: models.filter((model) => !isWorkersAiModel(model.id)) },
  ];

  return (
    <>
      <div className="flex flex-col gap-4">
        <div>
          <Field id="assistant_model" label="Model">
            <select
              id="assistant_model"
              value={choice.chosen}
              disabled={disabled}
              aria-invalid={modelRefused && !another}
              aria-describedby={described(modelRefused && !another ? "assistant-model-refusal" : id !== "" && "assistant-model-cost", unread !== null && "assistant-model-catalog")}
              onChange={(event) => onChoose({ ...choice, chosen: event.target.value })}
              className={SELECT}
            >
              {groups.map(
                (group) =>
                  group.models.length > 0 && (
                    <optgroup key={group.label} label={group.label}>
                      {group.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.price && !isWorkersAiModel(model.id) ? `${model.name} · ${shortPrice(model.price)}` : model.name}
                        </option>
                      ))}
                    </optgroup>
                  ),
              )}
              <option value={ANOTHER_MODEL}>Another model…</option>
            </select>
          </Field>
          {!another && <FieldRefusal id="assistant-model-refusal" field="model" refusal={refusal} />}
        </div>
        {another && (
          <div>
            <Field id="assistant_model_id" label="Model ID">
              <Input
                id="assistant_model_id"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={MAX_MODEL_LENGTH}
                placeholder="company/model"
                value={choice.typed}
                disabled={disabled}
                aria-invalid={modelRefused}
                aria-describedby={modelRefused ? "assistant-model-refusal" : "assistant-model-id-description"}
                onChange={(event) => onChoose({ ...choice, typed: event.target.value })}
                className={FIELD_INPUT}
              />
            </Field>
            {modelRefused ? (
              <FieldRefusal id="assistant-model-refusal" field="model" refusal={refusal} />
            ) : (
              <p id="assistant-model-id-description" className={cn(NOTE, "mt-2")}>
                Copy a model's ID from Cloudflare's catalog, such as anthropic/claude-sonnet-5.5. <Out href={MODEL_CATALOG}>Open the model catalog</Out>
              </p>
            )}
          </div>
        )}
      </div>
      {id !== "" && (
        <p id="assistant-model-cost" className={cn(NOTE, "mt-2")}>
          {isWorkersAiModel(id) ? (
            "Workers AI's models run on Cloudflare, free up to a daily allowance, and beyond it on Workers Paid."
          ) : (
            <>
              AI Gateway's credits pay for this model
              {chosen?.price
                ? `, ${dollars(chosen.price.input)} for each million tokens it reads, and ${dollars(chosen.price.output)} for each million it writes`
                : ""}
              . Top them up under <em>Credits Available</em> in AI Gateway. <Out href={aiGatewayDashboard(accountId)}>Open AI Gateway in the Cloudflare dashboard</Out>
            </>
          )}
        </p>
      )}
      {unread !== null && (
        <p id="assistant-model-catalog" className={cn(NOTE, "mt-2 wrap-anywhere")}>
          {CATALOG_UNREAD} {unread}
        </p>
      )}
    </>
  );
}
