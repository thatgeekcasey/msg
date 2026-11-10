// Ember AI, which answers as @ember through Cloudflare's AI Gateway, as administrators set it up on the
// AI assistant tab of workspace settings through `/api/account/assistant`.

/**
 * The API formats AI Gateway's REST API takes a model's requests in, at `/ai/v1/messages`,
 * `/ai/v1/responses` and `/ai/v1/chat/completions`: Anthropic's models take only Messages, some of
 * OpenAI's only Responses, and most others Chat Completions.
 */
export const MODEL_FORMATS = ["messages", "responses", "chat"] as const;
export type ModelFormat = (typeof MODEL_FORMATS)[number];

/**
 * A model @ember can answer with, as Cloudflare's catalog lists it, or Ember does: its ID, what to call
 * it, the format AI Gateway takes its requests in, and what it costs, when the catalog says.
 */
export interface AssistantModel {
  id: string;
  name: string;
  format: ModelFormat;
  price?: ModelPrice;
}

/** What a model costs through AI Gateway, in US dollars for each million tokens it reads and writes. */
export interface ModelPrice {
  input: number;
  output: number;
}

/**
 * The models Ember knows without Cloudflare's catalog, which Set up Ember AI lists when it can't read
 * the catalog, Workers AI's first, which come with Cloudflare's free daily allowance, then other
 * companies', which AI Gateway's credits pay for. Their names are the ones Ember calls them by, wherever
 * they're listed.
 */
export const ASSISTANT_MODELS: readonly AssistantModel[] = [
  { id: "@cf/zai-org/glm-4.7-flash", name: "GLM-4.7 Flash", format: "chat" },
  { id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B", format: "chat" },
  { id: "@cf/openai/gpt-oss-120b", name: "gpt-oss-120b", format: "chat" },
  { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", format: "messages" },
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", format: "messages" },
  { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", format: "messages" },
  { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", format: "responses" },
  { id: "openai/gpt-6.1-terra", name: "GPT-6.1 Terra", format: "responses" },
  { id: "google/gemini-4-argon", name: "Gemini 4 Argon", format: "chat" },
  { id: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash", format: "chat" },
  { id: "moonshotai/kimi-k3", name: "Kimi K3", format: "chat" },
];

/** Whether `model` is one of Workers AI's, which Cloudflare runs itself, rather than another company's. */
export const isWorkersAiModel = (model: string) => model.startsWith("@cf/");

/** What to call `model`: its name in `models`, or else in the models Ember knows, or else its ID. */
export const modelName = (model: string, models: readonly AssistantModel[] = []) =>
  (models.find(({ id }) => id === model) ?? ASSISTANT_MODELS.find(({ id }) => id === model))?.name ?? model;

/** The most models administrators can let people pick from, the one @ember answers everyone else with among them. */
export const MAX_ASSISTANT_MODELS = 20;

/** The longest name Ember keeps for a model, where Cloudflare's are a few words. */
export const MAX_MODEL_NAME_LENGTH = 100;

/**
 * The model's name `text` gives, without the spaces around it, or null when it can't be one: one line of
 * text no longer than Ember keeps, without characters that show nothing or turn the text around.
 */
export function modelNameOf(text: unknown): string | null {
  const name = typeof text === "string" ? text.trim() : "";
  return name !== "" && name.length <= MAX_MODEL_NAME_LENGTH && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name) ? name : null;
}

/** How much @ember thinks before it answers: not at all, a little, more, or the most. */
export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * About how many tokens of thinking each level allows, which a model that takes an effort instead is
 * asked for as its low, medium or high effort.
 */
export const THINKING_TOKENS: Record<ThinkingLevel, number> = { off: 0, low: 4_000, medium: 16_000, high: 32_000 };

/** How long @ember's answers are: short, medium, or long. */
export const ANSWER_LENGTHS = ["short", "medium", "long"] as const;
export type AnswerLength = (typeof ANSWER_LENGTHS)[number];

/** About how many words each length's answers keep to, which @ember is told: a long one is nearly all one message holds. */
export const ANSWER_WORDS: Record<AnswerLength, number> = { short: 150, medium: 400, long: 1_500 };

/**
 * The most tokens each length's answer may take once its model has thought: several times its words, at
 * about 1.3 tokens each, as Markdown, code and tables take more, and a model writes past what it's asked.
 */
export const ANSWER_TOKENS: Record<AnswerLength, number> = { short: 1_000, medium: 2_000, long: 6_000 };

/** The tokens of thinking an answer may take when it's asked for none, as some models think a little all the same. */
export const UNTHINKING_TOKENS = 2_000;

/**
 * The most characters of a conversation @ember and the agents read: the newest messages that fit, so
 * that one long conversation costs no more than about 10,000 tokens.
 */
export const MAX_CONVERSATION_LENGTH = 40_000;

/** How much @ember thinks, and how long it answers. */
export interface AnswerLevels {
  thinking: ThinkingLevel;
  length: AnswerLength;
}

/** The most tokens an answer at `levels` may take: its thinking's, which counts toward them, and then its words'. */
export const maxTokensAt = ({ thinking, length }: AnswerLevels) => (thinking === "off" ? UNTHINKING_TOKENS : THINKING_TOKENS[thinking]) + ANSWER_TOKENS[length];

/** Each level, as its dial names it. */
export const LEVEL_NAMES: Record<ThinkingLevel | AnswerLength, string> = { off: "Off", low: "Low", medium: "Medium", high: "High", short: "Short", long: "Long" };

/** The levels of @ember's answers to someone who hasn't picked their own. */
export const DEFAULT_LEVELS: AnswerLevels = { thinking: "low", length: "medium" };

/** The most each dial goes to until an administrator sets less: the top, as Ember adds no limits of its own. */
export const TOP_LEVELS: AnswerLevels = { thinking: "high", length: "long" };

/** `levels`, each no higher than `most`'s. */
export function withinMost(levels: AnswerLevels, most: AnswerLevels): AnswerLevels {
  const lower = <T>(order: readonly T[], level: T, highest: T) => order[Math.min(order.indexOf(level), order.indexOf(highest))]!;
  return { thinking: lower(THINKING_LEVELS, levels.thinking, most.thinking), length: lower(ANSWER_LENGTHS, levels.length, most.length) };
}

/** A change to one of @ember's dials, or both: the most each goes to, or your own levels. */
export type AnswerLevelChanges = Partial<AnswerLevels>;

/**
 * What `PATCH /api/account/assistant` changes: the most one dial or both go to for anyone's questions,
 * which of the models people can pick @ember answers everyone else with, or the instructions Ember adds
 * to @ember's own, "" for none.
 */
export interface AssistantChanges extends AnswerLevelChanges {
  model?: string;
  instructions?: string;
}

/**
 * What `PATCH /api/users/me/assistant` changes of yours: one dial or both, or the model @ember answers
 * you with, which null leaves to administrators.
 */
export interface YourAssistantChanges extends AnswerLevelChanges {
  model?: string | null;
}

/** Why a change to the levels is refused before anything's saved. */
export const LEVELS_REFUSED = "Choose a level the dial has.";

/** Why a change to a model is refused: it isn't one of the models administrators let people pick. */
export const MODEL_NOT_LISTED = "Choose one of the models an administrator added.";

/**
 * The longest instructions Ember takes, for @ember to add to its own or for an agent: about 2,500 tokens,
 * a quarter of the longest conversation it reads.
 */
export const MAX_INSTRUCTIONS_LENGTH = 10_000;

/** Why instructions are refused before anything's saved. */
export const INSTRUCTIONS_TOO_LONG = `Instructions can be at most ${MAX_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters.`;

/**
 * The changes `data` gives, as the Ember AI card sends them, or why they can't be changes: they change
 * nothing, or give a level a dial doesn't have, a model that can't be one, or instructions that aren't
 * text or are longer than Ember takes. Instructions are saved without the spaces around them.
 */
export function parseAssistantChanges(data: unknown): AssistantChanges | { error: string } {
  const given = objectIn(data);
  const levels = levelChangesIn(given);
  if ("error" in levels) return levels;
  const { instructions } = given;
  if (instructions !== undefined && (typeof instructions !== "string" || instructions.trim().length > MAX_INSTRUCTIONS_LENGTH)) return { error: INSTRUCTIONS_TOO_LONG };
  const changes: AssistantChanges = { ...levels, ...(typeof instructions === "string" && { instructions: instructions.trim() }) };
  if (given.model === undefined) return Object.keys(changes).length > 0 ? changes : { error: LEVELS_REFUSED };
  const model = typeof given.model === "string" ? modelOf(given.model) : null;
  return model === null ? { error: MODEL_NOT_LISTED } : { ...changes, model };
}

/**
 * Your changes `data` gives, as your profile sends them, or why they can't be changes, as `parseAssistantChanges`
 * says, where a null model leaves yours to administrators. @ember's instructions aren't yours to change.
 */
export function parseYourAssistantChanges(data: unknown): YourAssistantChanges | { error: string } {
  const { instructions: _, ...given } = objectIn(data);
  if (given.model !== null) return parseAssistantChanges(given);
  const levels = levelChangesIn(given);
  return "error" in levels ? levels : { ...levels, model: null };
}

/** The levels `given` changes, or why they can't be changes: a level a dial doesn't have. */
function levelChangesIn(given: Record<string, unknown>): AnswerLevelChanges | { error: string } {
  const { thinking, length } = given;
  if (thinking !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(thinking)) return { error: LEVELS_REFUSED };
  if (length !== undefined && !(ANSWER_LENGTHS as readonly unknown[]).includes(length)) return { error: LEVELS_REFUSED };
  return { ...(thinking !== undefined && { thinking: thinking as ThinkingLevel }), ...(length !== undefined && { length: length as AnswerLength }) };
}

/** `data` as an object's fields, or none when it isn't one. */
const objectIn = (data: unknown): Record<string, unknown> => (typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {});

/**
 * What @ember may do on the web while Search the web is on: search it, and read pages, the ones people
 * link to and its searches find, where AI Gateway takes its model's tool for that too.
 */
export const WEB_TOOLS = ["search", "read"] as const;
export type WebTool = (typeof WEB_TOOLS)[number];

/** The most times @ember searches the web for one answer, as each of Anthropic's searches costs a cent. */
export const WEB_SEARCHES_PER_ANSWER = 5;

/** The most pages @ember reads for one answer, as what it reads is paid for as the conversation is. */
export const PAGES_READ_PER_ANSWER = 3;

/** What a model may do on the web in each format, with the tools AI Gateway passes on in it. */
export const WEB_TOOLS_IN: Record<ModelFormat, readonly WebTool[]> = { messages: ["search", "read"], responses: ["search"], chat: [] };

/**
 * The format `model` is likeliest to take: the one `models` list it with, or the models Ember knows, or
 * else Messages for Anthropic's, Responses for OpenAI's, and Chat Completions for anyone else's.
 */
export function formatOf(model: string, models: readonly AssistantModel[] = []): ModelFormat {
  const listed = (models.find(({ id }) => id === model) ?? ASSISTANT_MODELS.find(({ id }) => id === model))?.format;
  return listed ?? (model.startsWith("anthropic/") ? "messages" : model.startsWith("openai/") ? "responses" : "chat");
}

/**
 * Ember AI as the AI assistant tab shows it to administrators while it's on: the Cloudflare account it
 * asks through, the model it answers anyone with who hasn't picked another, the models people can pick
 * from, that one among them, in the order they were added, the most each dial goes to for anyone's
 * questions, and what @ember does on the web: what it may while Search the web is on, nothing while it's
 * off, or null when the model that answers everyone can't, as only Anthropic's and OpenAI's models have
 * tools for it that AI Gateway passes on. Then the instructions Ember adds to @ember's own, and @ember's
 * avatar.
 */
export interface AssistantSettings {
  accountId: string;
  model: string;
  models: AssistantModel[];
  most: AnswerLevels;
  webTools: WebTool[] | null;
  /** What Ember adds to @ember's own instructions, as administrators write them, or "" for nothing, which stays while Ember AI is off. */
  instructions: string;
  /** @ember's avatar, as the people directory gives it (`DirectoryUser.avatarUrl`): the picture an administrator uploaded, or Ember's flame. */
  avatarUrl: string;
  /** Whether an administrator uploaded @ember's avatar, which Use Ember's flame takes away, though one that can't be resized shows the flame. */
  avatar: boolean;
}

/**
 * What `PATCH /api/account/assistant` answers once it has saved a change, `DELETE /api/account/assistant/models`
 * a model's removal, and `PUT` and `DELETE /api/account/assistant/avatar` a change to @ember's avatar: Ember AI
 * as it is then.
 */
export interface AssistantChanged {
  assistant: AssistantSettings;
}

/**
 * @ember's answers to you while Ember AI is on, as your profile shows them: the levels of each dial,
 * yours, or where they start until you pick, no higher than the most administrators allow, which it
 * shows too, the model you picked, while it's one people can pick, even the one administrators chose
 * for everyone, or else null, when @ember answers you with whichever they choose, the one they chose,
 * and the models you can pick from, that one among them.
 */
export interface YourAssistant {
  levels: AnswerLevels;
  most: AnswerLevels;
  model: string | null;
  defaultModel: string;
  models: AssistantModel[];
}

/** What `PATCH /api/users/me/assistant` answers: your levels and model as they are then, or null while Ember AI is off. */
export interface YourAssistantChanged {
  assistant: YourAssistant | null;
}

/** What the AI assistant tab says when a change to the most each dial goes to comes while Ember AI is off. */
export const ASSISTANT_OFF = "Ember AI is off. Turn it on first.";

/** What `PUT /api/account/assistant/web_search` takes: whether @ember searches the web, as the Search the web switch says. */
export interface WebSearchChange {
  on: boolean;
}

/** The change `data` gives, as the switch sends it, or null when it doesn't say on or off. */
export function parseWebSearchChange(data: unknown): WebSearchChange | null {
  const on = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>).on : undefined;
  return typeof on === "boolean" ? { on } : null;
}

/**
 * What `PUT /api/account/assistant/web_search` answers once it has changed Search the web: Ember AI as
 * it is then, and, once it's turned on, what its model said when it searched, or else null.
 */
export interface WebSearchChanged {
  assistant: AssistantSettings;
  found: string | null;
}

/** Why a change to Search the web is refused before anything's asked. */
export const WEB_SEARCH_REFUSED = "Say whether @ember searches the web.";

/** Why Search the web can't turn on for the model called `name`, which has no tool for it that AI Gateway passes on. */
export const cannotSearchWith = (name: string) =>
  `${name} can't search the web through AI Gateway, but Anthropic's and OpenAI's models can. Choose one under Models or Change.`;

/** Why it didn't turn on once the model was asked: Ember AI was changed or turned off meanwhile, or Search the web was. */
export const WEB_SEARCH_CHANGED = "Ember AI changed while its model searched. Try again.";

/**
 * The Cloudflare account Ember AI asks through, as Set up Ember AI gives it: its ID, and an API token of
 * its with the Workers AI Read permission, which a change can leave out to keep the one Ember has.
 */
export interface AssistantKeys {
  accountId: string;
  apiToken?: string;
}

/**
 * What Set up Ember AI gives `PUT /api/account/assistant`: the account, and the ID of the model to answer
 * anyone with who hasn't picked another, with its name, as Cloudflare's catalog gives it, if it does.
 */
export interface AssistantSetup extends AssistantKeys {
  model: string;
  modelName?: string;
}

/**
 * What `POST /api/account/assistant/catalog` answers for an account: the text models Cloudflare's catalog
 * lists, Workers AI's first, by name, with what they cost, or else, when Ember can't read the catalog,
 * the models it knows, and why it can't.
 */
export interface AssistantCatalog {
  models: AssistantModel[];
  refusal: string | null;
}

/** What Add a model gives `POST /api/account/assistant/models`: the model's ID, and its name, as Cloudflare's catalog gives it, if it does. */
export interface NewAssistantModel {
  model: string;
  modelName?: string;
}

/**
 * What `PUT /api/account/assistant` answers once the model answered its test question, and `POST
 * /api/account/assistant/models` once the model it adds did: Ember AI as it is then, and what the model said.
 */
export interface AssistantSaved {
  assistant: AssistantSettings;
  greeting: string;
}

/** What `DELETE /api/account/assistant` answers: Ember AI is off. */
export interface AssistantForgotten {
  assistant: null;
}

/** A field of Set up Ember AI, which a refusal can be about. */
export type AssistantField = "accountId" | "apiToken" | "model";

/** The longest model ID Ember takes, where Cloudflare's are a few dozen characters. */
export const MAX_MODEL_LENGTH = 200;

/** The longest API token Ember takes, which goes in a header of each request to Cloudflare. */
const MAX_API_TOKEN_LENGTH = 200;

/** Why Set up Ember AI's fields are refused before Cloudflare is asked about them. */
export const ACCOUNT_ID_REFUSED = "An account ID is 32 letters and digits. Copy it from Workers AI's Use REST API in the Cloudflare dashboard.";
export const API_TOKEN_REFUSED = "Paste an API token from Account API tokens in the Cloudflare dashboard.";
export const MODEL_REFUSED = "A model's ID has a slash, such as anthropic/claude-sonnet-5.5. Copy it from Cloudflare's model catalog.";

/** The Cloudflare account ID `text` gives, without the spaces around it and in small letters, or null when it can't be one: 32 hexadecimal digits. */
export function accountIdOf(text: string): string | null {
  const accountId = text.trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(accountId) ? accountId : null;
}

/** The Cloudflare API token `text` gives, without the spaces around it, or null when it can't be one: tokens have no spaces, and are a few dozen characters. */
export function apiTokenOf(text: string): string | null {
  const apiToken = text.trim();
  return apiToken.length >= 20 && apiToken.length <= MAX_API_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(apiToken) ? apiToken : null;
}

/**
 * The model ID `text` gives, without the spaces around it, or null when it can't be one: Cloudflare's
 * name the company and then the model, as `company/model`, and Workers AI's start with `@cf/`.
 */
export function modelOf(text: string): string | null {
  const model = text.trim();
  return model.length <= MAX_MODEL_LENGTH && /^@?[\w.-]+(?:\/[\w.:@-]+)+$/.test(model) ? model : null;
}

/**
 * The account `POST /api/account/assistant/catalog` lists the models of, as Set up Ember AI sends it, or
 * why it can't be one, on the field it's about. A blank API token is left out, keeping the one Ember has.
 */
export function parseAssistantKeys(data: unknown): AssistantKeys | { error: string; field: AssistantField } {
  const given = objectIn(data);
  const accountId = typeof given.accountId === "string" ? accountIdOf(given.accountId) : null;
  if (accountId === null) return { error: ACCOUNT_ID_REFUSED, field: "accountId" };
  const { apiToken: typed } = given;
  if (typed !== undefined && typeof typed !== "string") return { error: API_TOKEN_REFUSED, field: "apiToken" };
  const apiToken = typed === undefined || typed.trim() === "" ? undefined : apiTokenOf(typed);
  if (apiToken === null) return { error: API_TOKEN_REFUSED, field: "apiToken" };
  return apiToken === undefined ? { accountId } : { accountId, apiToken };
}

/**
 * What `PUT /api/account/assistant` gives Ember, as Set up Ember AI sends it, or why it can't be one, on
 * the field it's about, as `parseAssistantKeys` reads the account. A name that can't be a model's is left out.
 */
export function parseAssistantSetup(data: unknown): AssistantSetup | { error: string; field: AssistantField } {
  const keys = parseAssistantKeys(data);
  if ("error" in keys) return keys;
  const model = parseNewAssistantModel(data);
  return "error" in model ? model : { ...keys, ...model };
}

/** The model `POST /api/account/assistant/models` adds, as Add a model sends it, or why it can't be one. A name that can't be a model's is left out. */
export function parseNewAssistantModel(data: unknown): NewAssistantModel | { error: string; field: "model" } {
  const given = objectIn(data);
  const model = typeof given.model === "string" ? modelOf(given.model) : null;
  if (model === null) return { error: MODEL_REFUSED, field: "model" };
  const name = modelNameOf(given.modelName);
  return name === null ? { model } : { model, modelName: name };
}

/** Why `DELETE /api/account/assistant/models` keeps a model: @ember answers everyone with it who hasn't picked another. */
export const DEFAULT_MODEL_KEPT = "@ember answers everyone with this model. Choose another for that first.";

/** Why `POST /api/account/assistant/models` adds no more. */
export const MODELS_FULL = `People can pick from at most ${MAX_ASSISTANT_MODELS} models. Remove one first.`;

/** What the AI assistant tab tells anyone but an administrator. */
export const ASSISTANT_FORBIDDEN = "Only administrators can set up Ember AI";
