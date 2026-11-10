import { ASSISTANT_MODELS, isWorkersAiModel, modelNameOf, modelOf, type AssistantModel, type ModelFormat, type ModelPrice } from "@ember/protocol/assistant";
import type { Env } from "../env";
import { cloudflareApiOf, formatsFor, isObject, refusalOf, type GatewayRefusal } from "./gateway";

// Cloudflare's catalog of the models AI Gateway runs, Workers AI's and other companies', which Cloudflare
// keeps up to date, and which its docs' model catalog is made from, as Set up Ember AI and Add a model
// list its text models. Its API isn't in Cloudflare's API reference yet, but its docs and models.dev
// read it (`GET /accounts/{id}/ai/catalog/models`), and it takes the Workers AI Read permission that
// Ember's API token has, as every `/ai` endpoint does.

/** How many models Ember asks for on each page of the catalog, the most it gives, as Cloudflare's docs read it. */
const PER_PAGE = 100;

/** The most pages Ember reads: the catalog has a few hundred models of every kind. */
const MAX_PAGES = 10;

/** How long Ember waits for each page. */
const PAGE_TIMEOUT_MS = 15_000;

/** The catalog's task for the models that answer in text, the only ones @ember can answer with. */
const TEXT_GENERATION = "Text Generation";

/** The formats Ember asks in, as the catalog names them in a model's `request_formats`. */
const FORMATS: Record<string, ModelFormat> = { "anthropic-messages": "messages", responses: "responses", "chat-completions": "chat" };

export const CATALOG_UNANSWERED = "Cloudflare's model catalog didn't answer.";

/** What Ember reads the catalog with: a Cloudflare account, and an API token of its. */
export interface CatalogKeys {
  accountId: string;
  apiToken: string;
}

/**
 * The text models Cloudflare's catalog lists for the account `keys` names, Workers AI's first, then other
 * companies', each by name, or why the catalog couldn't be read: Cloudflare didn't take the API token,
 * or has no such account, or the catalog didn't answer with any.
 */
export async function catalogOf(env: Env, keys: CatalogKeys): Promise<AssistantModel[] | GatewayRefusal> {
  const first = await pageOf(env, keys, 1);
  if ("refusal" in first) return first;
  const rows = [...first.rows];
  const pages = Math.min(MAX_PAGES, Math.ceil(first.total / PER_PAGE));
  for (const page of await Promise.all(Array.from({ length: pages - 1 }, (_, index) => pageOf(env, keys, index + 2)))) {
    if ("refusal" in page) return page;
    rows.push(...page.rows);
  }
  const models = textModelsIn(rows);
  return models.length > 0 ? models : { status: 502, reason: "unanswered", refusal: CATALOG_UNANSWERED };
}

/** Page `page` of the catalog: its models, as rows, and how many it has in all, or why Cloudflare didn't answer with it. */
async function pageOf(env: Env, { accountId, apiToken }: CatalogKeys, page: number): Promise<{ rows: unknown[]; total: number } | GatewayRefusal> {
  let response: Response;
  try {
    response = await fetch(`${cloudflareApiOf(env)}/accounts/${accountId}/ai/catalog/models?page=${page}&per_page=${PER_PAGE}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("Reading Cloudflare's model catalog failed:", error instanceof Error ? error.name : "unknown error");
    return { status: 502, reason: "unanswered", refusal: CATALOG_UNANSWERED };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) return catalogRefusalOf(response.status, body);
  if (!isObject(body) || !Array.isArray(body.result)) return { status: 502, reason: "unanswered", refusal: CATALOG_UNANSWERED };
  const total = isObject(body.result_info) && typeof body.result_info.total_count === "number" ? body.result_info.total_count : body.result.length;
  return { rows: body.result, total };
}

/** Why Cloudflare refused to answer with the catalog: its API token or account, as AI Gateway says, or else that the catalog didn't answer. */
function catalogRefusalOf(status: number, body: unknown): GatewayRefusal {
  const refusal = refusalOf(status, body);
  return refusal.reason === "token" || refusal.reason === "account" ? refusal : { status: 502, reason: "unanswered", refusal: CATALOG_UNANSWERED };
}

/** The text models among the catalog's `rows`, once each, Workers AI's first, then by name. */
export function textModelsIn(rows: unknown[]): AssistantModel[] {
  const models = new Map<string, AssistantModel>();
  for (const row of rows) {
    const model = textModelIn(row);
    if (model && !models.has(model.id)) models.set(model.id, model);
  }
  const byName = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  return [...models.values()].sort((a, b) => Number(isWorkersAiModel(b.id)) - Number(isWorkersAiModel(a.id)) || byName.compare(a.name, b.name));
}

/**
 * The model the catalog's `row` lists, if it answers in text in a format Ember asks in: called by the
 * name Ember knows it by, or else the catalog's, or its ID, asked in the first of the formats the catalog
 * says it takes that Ember asks in, or the one Ember would try first when it doesn't say, and with what
 * it costs, if the catalog says.
 */
function textModelIn(row: unknown): AssistantModel | null {
  if (!isObject(row) || row.task !== TEXT_GENERATION || typeof row.model_id !== "string" || modelOf(row.model_id) !== row.model_id) return null;
  const id = row.model_id;
  const listed = Array.isArray(row.request_formats) ? row.request_formats.filter((format): format is string => typeof format === "string") : [];
  const formats = listed.flatMap((format) => FORMATS[format] ?? []);
  if (listed.length > 0 && formats.length === 0) return null;
  const name = ASSISTANT_MODELS.find((model) => model.id === id)?.name ?? modelNameOf(row.name) ?? id;
  const price = priceIn(row.provider_details);
  return { id, name, format: formats[0] ?? formatsFor(id)[0]!, ...(price && { price }) };
}

/**
 * What the catalog's `details` of a model's providers say it costs, in US dollars for each million tokens
 * it reads and writes, from its first provider, at the least of the prices it has for each, as a model
 * with tiers costs more past some length of conversation, or undefined if they don't say both.
 */
function priceIn(details: unknown): ModelPrice | undefined {
  const [first] = Array.isArray(details) ? details.filter(isObject) : [];
  const pricing = first && isObject(first.pricing) ? first.pricing : {};
  const least = (kind: "input" | "output") => {
    const prices = Object.entries(pricing).flatMap(([key, price]) =>
      typeof price === "number" && Number.isFinite(price) && price >= 0 && key.endsWith(`${kind}_tokens`) && !/cache/.test(key) ? [price] : [],
    );
    return prices.length > 0 ? Math.min(...prices) : undefined;
  };
  const input = least("input");
  const output = least("output");
  return input === undefined || output === undefined ? undefined : { input, output };
}
