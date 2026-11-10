import {
  formatOf,
  MODEL_FORMATS,
  PAGES_READ_PER_ANSWER,
  WEB_SEARCHES_PER_ANSWER,
  WEB_TOOLS_IN,
  type AssistantField,
  type ModelFormat,
  type ThinkingLevel,
  type WebTool,
} from "@ember/protocol/assistant";
import type { Env } from "../env";
import { isLoopback } from "../loopback";

// Asking a model through Cloudflare's AI Gateway, with the AI REST API on api.cloudflare.com, in
// whichever of its three formats the model takes (https://developers.cloudflare.com/ai-gateway/usage/rest-api/).
// Every request goes through the account's default gateway, whose logs, caching, rate limits and spend
// limits apply, and which Cloudflare makes on the account's first request. A model that may use the web
// is given its provider's own tools for it, which AI Gateway passes on and the provider runs
// (https://developers.cloudflare.com/ai-gateway/usage/web-search/): Anthropic's web search and web fetch
// in Messages, and OpenAI's web search in Responses. Chat Completions has none.

/** Where Cloudflare's API is. */
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** The gateway Ember's requests go through. Workers AI's models need it named; other companies' go through it anyway. */
const GATEWAY_ID = "default";

/** Where each format's requests go, under the account's `ai/v1`. */
const PATHS: Record<ModelFormat, string> = { messages: "messages", responses: "responses", chat: "chat/completions" };

/** The most of Cloudflare's own words about a refusal that Ember passes on. */
const MAX_QUOTED_LENGTH = 200;

/** The most of a page a model reads, in tokens, about as many as the longest conversation @ember reads. */
const PAGE_TOKENS = 10_000;

/** How many times Ember lets Anthropic's model carry on a turn it paused while it searched, before taking what it said. */
const MAX_CONTINUATIONS = 2;

/** The most pages an answer names as its sources. */
export const MAX_SOURCES = 10;

/** What Ember asks AI Gateway with: a Cloudflare account, an API token of its, a model and the format the model takes. */
export interface Gateway {
  accountId: string;
  apiToken: string;
  model: string;
  format: ModelFormat;
}

/** One turn of a conversation for a model to go on with: what someone wrote, or one of the model's own answers. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/**
 * What to ask a model: how it should answer, the conversation, oldest first, ending with what it's asked,
 * the most tokens its answer may take, its thinking among them, how much to think first, if it's told,
 * who asked, if someone did, and who answers, @ember or an agent, if either does, whom AI Gateway's logs
 * and spend limits then know each request by (custom metadata's `user_id` and `agent_id`), and what it
 * may do on the web, of what its format has tools for: nothing, unless it's told.
 */
export interface Question {
  instructions: string;
  /** How it should answer when it's asked again only searching, as AI Gateway didn't take the tool for reading pages, if that's not as `instructions` says. */
  instructionsWithoutReading?: string;
  /** How it should answer when it's asked again without the web, whose tools AI Gateway didn't take, if that's not as `instructions` says. */
  instructionsWithoutWeb?: string;
  turns: Turn[];
  maxTokens: number;
  thinking?: ThinkingLevel;
  askerId?: string;
  agentId?: string;
  webTools?: readonly WebTool[];
}

/**
 * What went wrong asking a model: Cloudflare didn't take the API token, or found no such account, AI
 * Gateway's credits ran out, the model wasn't taken, AI Gateway turned the request away, the conversation
 * was longer than the model reads, AI Gateway didn't answer, the model answered with nothing, or it took
 * every token it could before it answered anything. Or the gateway's Guardrails or Data Loss Prevention,
 * which administrators turn on in AI Gateway, blocked the question, with what it read, or the answer.
 */
export type RefusalReason =
  | "token"
  | "account"
  | "credits"
  | "model"
  | "busy"
  | "too long"
  | "unanswered"
  | "nothing"
  | "out of room"
  | "guardrails"
  | "guardrails answer"
  | "dlp"
  | "dlp answer";

/**
 * Why a model didn't answer, in words an administrator can act on, with what went wrong, the status to
 * answer them with and the field of Set up Ember AI it's about, if one is: `wrongFormat` when the model
 * was refused in a way another format might not be, with Cloudflare's own word on that, if it gave one,
 * which the refusal ends with, in `cloudflareSays`.
 */
export interface GatewayRefusal {
  status: number;
  reason: RefusalReason;
  refusal: string;
  field?: AssistantField;
  wrongFormat?: boolean;
  cloudflareSays?: string;
}

export const GATEWAY_UNANSWERED = "AI Gateway didn't answer. Try again in a moment.";
export const NOTHING_ANSWERED = "The model answered with nothing. Try again, or choose another model.";
export const OUT_OF_ROOM = "The model took every token it could before it answered. Try again, or choose another model.";

/** A page a model's answer came from: its address, and its title, or "" without one. */
export interface Source {
  url: string;
  title: string;
}

/**
 * A model's answer: its text, whether it was cut short, as it took every token it could, and the pages
 * it came from, when it used the web: those it cites, then those it read.
 */
export interface Answered {
  text: string;
  cut?: true;
  sources?: Source[];
}

/**
 * What the model `gateway` names answers `question` in its format, or why it didn't, waiting at most
 * `timeoutMs` for it all. A model that doesn't take being told how much to think is asked again without
 * that, and then, as Search the web tries the web's tools when it's turned on, without the one for
 * reading pages, which AI Gateway may not have for every model, and then without them, told it can't
 * use them.
 */
export async function ask(env: Env, gateway: Gateway, question: Question, timeoutMs: number): Promise<Answered | GatewayRefusal> {
  const signal = AbortSignal.timeout(timeoutMs);
  let asked = question;
  let answered = await askOnce(env, gateway, asked, signal);
  if (isWrongFormat(answered) && asked.thinking !== undefined) {
    console.error(`Asking ${gateway.model} again without a thinking level, which it didn't take: ${answered.refusal}`);
    const { thinking: _, ...unthinking } = asked;
    asked = unthinking;
    answered = await askOnce(env, gateway, asked, signal);
  }
  const searching = asked.webTools?.filter((tool) => tool !== "read") ?? [];
  if (isWrongFormat(answered) && asked.webTools?.includes("read") && toolsFor(gateway.format, searching).length > 0) {
    console.error(`Asking ${gateway.model} to search again without reading pages, as AI Gateway didn't take that: ${answered.refusal}`);
    asked = { ...asked, instructions: asked.instructionsWithoutReading ?? asked.instructions, webTools: searching };
    answered = await askOnce(env, gateway, asked, signal);
  }
  if (!isWrongFormat(answered) || toolsFor(gateway.format, asked.webTools).length === 0) return answered;
  console.error(`Asking ${gateway.model} again without the web, whose tools AI Gateway didn't take: ${answered.refusal}`);
  return askOnce(env, gateway, { ...asked, instructions: asked.instructionsWithoutWeb ?? asked.instructions, webTools: [] }, signal);
}

/**
 * What the model `gateway` names answers in the first of `formats` it takes the question in, as
 * `questionIn` asks it in each, waiting at most `timeoutMs` in each (`ask`), with the format it took it
 * in, or why it didn't answer: the first format's refusal, unless another's says more, as one that isn't
 * about the format does.
 */
export async function askInTurn(
  env: Env,
  gateway: Omit<Gateway, "format">,
  formats: readonly ModelFormat[],
  questionIn: (format: ModelFormat) => Question,
  timeoutMs: number,
): Promise<(Answered & { format: ModelFormat }) | GatewayRefusal> {
  let first: GatewayRefusal | null = null;
  for (const format of formats) {
    const answered = await ask(env, { ...gateway, format }, questionIn(format), timeoutMs);
    if (!("refusal" in answered)) return { ...answered, format };
    if (!answered.wrongFormat) return answered;
    first ??= answered;
  }
  return first!;
}

/**
 * What the model `gateway` names answers `question`, asked as it is, until `signal` says it's waited long
 * enough: once, but for a turn Anthropic's model paused while it searched, which it carries on while the
 * turn has tokens left. One that paused with none left took every token it could.
 */
export async function askOnce(env: Env, gateway: Gateway, question: Question, signal: AbortSignal): Promise<Answered | GatewayRefusal> {
  const request = requestOf(gateway, question);
  let said: unknown[] = [];
  let tokensLeft = question.maxTokens;
  for (let continued = 0; ; continued++) {
    const answered = await send(env, gateway, question, continued === 0 ? request : carryingOn(request, said, tokensLeft), signal);
    if ("refusal" in answered) return answered;
    if (gateway.format !== "messages" || !isObject(answered.body)) return answeredIn(gateway.format, answered.body);
    // Each part of a turn says what's new since the last, which is sent back as it is to carry on.
    said = [...said, ...(Array.isArray(answered.body.content) ? answered.body.content : [])];
    tokensLeft -= writtenIn(answered.body);
    const paused = answered.body.stop_reason === "pause_turn";
    if (paused && tokensLeft < 1) return answeredIn(gateway.format, { ...answered.body, content: said, stop_reason: "max_tokens" });
    if (!paused || continued === MAX_CONTINUATIONS) return answeredIn(gateway.format, { ...answered.body, content: said });
  }
}

/**
 * `request`, to Messages, carrying on the turn its model paused once it had `said` what it did, which goes
 * back as it is. Each request may write as many tokens as its `max_tokens`, and use a tool as many times
 * as its `max_uses`, so they're lowered to what the turn has left, `tokensLeft` of its tokens, and once it
 * has used a tool up, which stays among the tools as the turn used it, the model is told to use none and
 * answer with what it found.
 */
function carryingOn(request: Record<string, unknown>, said: unknown[], tokensLeft: number): Record<string, unknown> {
  const usesOf = (name: unknown) => said.filter((block) => isObject(block) && block.type === "server_tool_use" && block.name === name).length;
  const tools = (Array.isArray(request.tools) ? request.tools : []).filter(isObject).map((tool) => ({ tool, left: Number(tool.max_uses) - usesOf(tool.name) }));
  return {
    ...request,
    max_tokens: tokensLeft,
    messages: [...(request.messages as unknown[]), { role: "assistant", content: said }],
    ...(tools.length > 0 && { tools: tools.map(({ tool, left }) => ({ ...tool, max_uses: Math.max(1, left) })) }),
    ...(tools.some(({ left }) => left < 1) && { tool_choice: { type: "none" } }),
  };
}

/** How many tokens Messages' answer `body` says its model wrote, thinking among them. */
const writtenIn = (body: Record<string, unknown>) => (isObject(body.usage) && typeof body.usage.output_tokens === "number" ? body.usage.output_tokens : 0);

/** Whether `answered` is a refusal that a model asked another way might not give. */
const isWrongFormat = (answered: Answered | GatewayRefusal): answered is GatewayRefusal => "refusal" in answered && answered.wrongFormat === true;

/** What AI Gateway answers `request`, which asks `question` of the model `gateway` names, or why it refused, by `signal`. */
async function send(env: Env, gateway: Gateway, question: Question, request: Record<string, unknown>, signal: AbortSignal): Promise<{ body: unknown } | GatewayRefusal> {
  let response: Response;
  try {
    response = await fetch(`${cloudflareApiOf(env)}/accounts/${gateway.accountId}/ai/v1/${PATHS[gateway.format]}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gateway.apiToken}`,
        "Content-Type": "application/json",
        "cf-aig-gateway-id": GATEWAY_ID,
        ...metadataOf(question),
      },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    console.error("Asking AI Gateway failed:", error instanceof Error ? error.name : "unknown error");
    return { status: 502, reason: "unanswered", refusal: GATEWAY_UNANSWERED };
  }
  const body: unknown = await response.json().catch(() => null);
  return response.ok ? { body } : refusalOf(response.status, body);
}

/** The custom metadata AI Gateway keeps of a request asking `question`: who asked and who answers, of those it names, if it names either. */
function metadataOf({ askerId, agentId }: Question): Record<string, string> {
  const metadata = { ...(askerId !== undefined && { user_id: askerId }), ...(agentId !== undefined && { agent_id: agentId }) };
  return Object.keys(metadata).length > 0 ? { "cf-aig-metadata": JSON.stringify(metadata) } : {};
}

/** The answer `body` gives in `format`, or why it's none: the model said nothing, or took every token it could first. */
function answeredIn(format: ModelFormat, body: unknown): Answered | GatewayRefusal {
  const text = answerIn(format, body)?.trim();
  const cut = ranOutIn(format, body);
  const sources = sourcesIn(format, body);
  if (text) return { text, ...(cut && { cut: true as const }), ...(sources.length > 0 && { sources }) };
  return cut ? { status: 502, reason: "out of room", refusal: OUT_OF_ROOM, field: "model" } : { status: 502, reason: "nothing", refusal: NOTHING_ANSWERED, field: "model" };
}

/**
 * The formats to ask `model` in, the one it's likeliest to take first (`formatOf`): a listed model's,
 * else Messages for Anthropic's, which take nothing else, Responses for OpenAI's, some of which take only
 * that, and Chat Completions for the rest.
 */
export function formatsFor(model: string): ModelFormat[] {
  const first = formatOf(model);
  return [first, ...MODEL_FORMATS.filter((format) => format !== first)];
}

/** Where Cloudflare's API is: the browser tests' stand-in, which `AI_GATEWAY_URL` names at a loopback address, or Cloudflare's own. */
export function cloudflareApiOf(env: Env): string {
  const standIn = URL.parse(env.AI_GATEWAY_URL?.trim() ?? "");
  return standIn && isLoopback(standIn) ? standIn.origin : CLOUDFLARE_API;
}

/**
 * The body of a request asking `question` in `gateway`'s format, telling the model how much to think as
 * the format does: Anthropic's adaptive thinking at an effort, whose lowest is as little as their models
 * think, OpenAI's reasoning effort, or Chat Completions' `reasoning_effort`, "none" for no thinking. A
 * model that may use the web is given the format's tools for what it may do there.
 */
function requestOf({ model, format }: Gateway, { instructions, turns, maxTokens, thinking, webTools }: Question): Record<string, unknown> {
  const effort = thinking === "off" ? "none" : thinking;
  const tools = toolsFor(format, webTools);
  const withTools = tools.length > 0 && { tools };
  if (format === "messages") {
    const messages = alternating(turns).map(({ role, text }) => ({ role, content: text }));
    const thinks = effort && { thinking: { type: "adaptive" }, output_config: { effort: effort === "none" ? "low" : effort } };
    return { model, max_tokens: maxTokens, system: instructions, messages, ...thinks, ...withTools };
  }
  if (format === "responses") {
    // Its web search is its only built-in tool, so its calls of built-in tools are its searches.
    const searches = tools.length > 0 && { max_tool_calls: WEB_SEARCHES_PER_ANSWER };
    return { model, max_output_tokens: maxTokens, instructions, input: turns.map(({ role, text }) => ({ role, content: text })), ...(effort && { reasoning: { effort } }), ...withTools, ...searches };
  }
  return {
    model,
    max_completion_tokens: maxTokens,
    messages: [{ role: "system", content: instructions }, ...turns.map(({ role, text }) => ({ role, content: text }))],
    ...(effort && { reasoning_effort: effort }),
  };
}

/**
 * The tools that let a model in `format` do on the web what `webTools` says it may, of what the format
 * has tools for: Anthropic's basic web search and web fetch, which every Claude model takes, each used no
 * more than an answer allows, or OpenAI's web search.
 */
export function toolsFor(format: ModelFormat, webTools: readonly WebTool[] = []): Record<string, unknown>[] {
  const may = (tool: WebTool) => webTools.includes(tool) && WEB_TOOLS_IN[format].includes(tool);
  if (format !== "messages") return may("search") ? [{ type: "web_search" }] : [];
  return [
    ...(may("search") ? [{ type: "web_search_20250305", name: "web_search", max_uses: WEB_SEARCHES_PER_ANSWER }] : []),
    ...(may("read") ? [{ type: "web_fetch_20250910", name: "web_fetch", max_uses: PAGES_READ_PER_ANSWER, max_content_tokens: PAGE_TOKENS }] : []),
  ];
}

/**
 * `turns` as Anthropic's Messages takes them: starting with someone's, and taking turns, so that what
 * several people wrote in a row is one turn, a blank line apart.
 */
export function alternating(turns: Turn[]): Turn[] {
  const merged: Turn[] = [];
  for (const turn of turns) {
    const last = merged.at(-1);
    if (last?.role === turn.role) last.text = `${last.text}\n\n${turn.text}`;
    else if (last || turn.role === "user") merged.push({ ...turn });
  }
  return merged;
}

/**
 * The text of a model's answer in `format`, leaving out its thinking, and what it said before it last
 * used a tool, which says what it'll look for, or null without any.
 */
function answerIn(format: ModelFormat, body: unknown): string | null {
  if (!isObject(body)) return null;
  if (format === "messages") return textOf(answeringBlocks(body.content), "text");
  if (format === "responses") {
    const messages = answeringMessages(body.output);
    return messages.map((message) => textOf(message.content, "output_text") ?? "").join("") || (typeof body.output_text === "string" ? body.output_text : null);
  }
  const [choice] = Array.isArray(body.choices) ? body.choices : [];
  const content = isObject(choice) && isObject(choice.message) ? choice.message.content : null;
  return typeof content === "string" ? content : textOf(content, "text");
}

/** Whether a model's answer in `format` stopped where it did because it took every token it could. */
function ranOutIn(format: ModelFormat, body: unknown): boolean {
  if (!isObject(body)) return false;
  if (format === "messages") return body.stop_reason === "max_tokens";
  if (format === "responses") return body.status === "incomplete" && isObject(body.incomplete_details) && body.incomplete_details.reason === "max_output_tokens";
  const [choice] = Array.isArray(body.choices) ? body.choices : [];
  return isObject(choice) && choice.finish_reason === "length";
}

/** The text of the parts of `content` whose type is `type`, joined, or null without any. */
function textOf(content: unknown, type: string): string | null {
  if (!Array.isArray(content)) return null;
  const texts = content.filter((part) => isObject(part) && part.type === type && typeof part.text === "string").map((part) => part.text as string);
  return texts.length > 0 ? texts.join("") : null;
}

/** The blocks of a Messages answer's `content` after its last use of a tool, and what came of it, or all of them without one. */
function answeringBlocks(content: unknown): Record<string, unknown>[] {
  const blocks = Array.isArray(content) ? content.filter(isObject) : [];
  const lastTool = blocks.findLastIndex(({ type }) => typeof type === "string" && /tool_(?:use|result)$/.test(type));
  return blocks.slice(lastTool + 1);
}

/** The messages of a Responses answer's `output` after its last call of a tool, or all of them without one. */
function answeringMessages(output: unknown): Record<string, unknown>[] {
  const items = Array.isArray(output) ? output.filter(isObject) : [];
  const lastCall = items.findLastIndex(({ type }) => typeof type === "string" && type.endsWith("_call"));
  return items.slice(lastCall + 1).filter(({ type }) => type === "message");
}

/**
 * The pages a model's answer in `format` came from, each once, in the order it came to them, no more
 * than an answer names: the search results its words cite, then the pages it read, as Anthropic's
 * Messages has them, or the pages its words cite in OpenAI's Responses.
 */
function sourcesIn(format: ModelFormat, body: unknown): Source[] {
  if (!isObject(body)) return [];
  const sources = format === "messages" ? messagesSources(body.content) : format === "responses" ? responsesSources(body.output) : [];
  const named = new Set<string>();
  const unnamed = ({ url }: Source) => {
    if (named.has(url)) return false;
    named.add(url);
    return true;
  };
  return sources.filter(unnamed).slice(0, MAX_SOURCES);
}

/** The search results the answer in a Messages `content` cites, then the pages its model read. */
function messagesSources(content: unknown): Source[] {
  const blocks = Array.isArray(content) ? content.filter(isObject) : [];
  const cited = answeringBlocks(blocks)
    .flatMap(({ citations }) => (Array.isArray(citations) ? citations.filter(isObject) : []))
    .map(({ url, title }) => sourceOf(url, title));
  const read = blocks.map((block) => {
    const result = block.type === "web_fetch_tool_result" && isObject(block.content) ? block.content : null;
    return result?.type === "web_fetch_result" ? sourceOf(result.url, isObject(result.content) ? result.content.title : null) : null;
  });
  return [...cited, ...read].filter((source) => source !== null);
}

/** The pages the answer in a Responses `output` cites. */
function responsesSources(output: unknown): Source[] {
  return answeringMessages(output)
    .flatMap(({ content }) => (Array.isArray(content) ? content.filter(isObject) : []))
    .flatMap(({ annotations }) => (Array.isArray(annotations) ? annotations.filter(isObject) : []))
    .map((annotation) => (annotation.type === "url_citation" ? sourceOf(annotation.url, annotation.title) : null))
    .filter((source) => source !== null);
}

/** A source at `url` titled `title`, or null when `url` isn't an address. */
const sourceOf = (url: unknown, title: unknown): Source | null =>
  typeof url === "string" && url.trim() !== "" ? { url: url.trim(), title: typeof title === "string" ? title.trim() : "" } : null;

/**
 * Why AI Gateway refused a request with `status`, from its `body`, which is Cloudflare's, with errors and
 * their codes, or the format's own, with an error, and says in words what to do, with Cloudflare's own.
 */
export function refusalOf(status: number, body: unknown): GatewayRefusal {
  const { codes, message } = errorIn(body);
  const said = (lead: string) => (message ? `${lead} Cloudflare says: ${quoted(message)}` : lead);
  if (status === 401 || (status === 403 && codes.includes(10000))) {
    const refusal = said("Cloudflare didn't take that API token for this account. Check the account ID, and that the token has the Workers AI Read permission.");
    return { status: 422, reason: "token", field: "apiToken", refusal };
  }
  // "Could not route to /client/v4/accounts/…, perhaps your object identifier is invalid?"
  if (codes.includes(7003) || codes.includes(7000)) {
    return { status: 422, reason: "account", field: "accountId", refusal: said("Cloudflare has no account with that ID that the token can reach.") };
  }
  const blocked = BLOCKS.find(({ code }) => codes.includes(code));
  if (blocked) return { status: 422, reason: blocked.reason, refusal: said(blocked.refusal) };
  if (status === 402) {
    const refusal = said("This model is paid for with AI Gateway's credits, and there aren't enough. Top them up under Credits Available in AI Gateway, or choose a Workers AI model.");
    return { status: 422, reason: "credits", refusal };
  }
  if (status === 403) return { status: 422, reason: "model", field: "model", refusal: said("Cloudflare won't run that model for this account.") };
  if (status === 413) return { status: 422, reason: "too long", refusal: said("The model can't read that much at once.") };
  if (status === 400 || status === 404 || status === 422) {
    return { status: 422, reason: "model", field: "model", refusal: said("AI Gateway didn't take that model."), wrongFormat: true, ...(message && { cloudflareSays: quoted(message) }) };
  }
  if (status === 429) return { status: 429, reason: "busy", refusal: said("AI Gateway is turning requests away for now, or a spend limit was reached. Try again later.") };
  return { status: 502, reason: "unanswered", refusal: said(GATEWAY_UNANSWERED) };
}

/**
 * What the gateway's Guardrails and Data Loss Prevention block, by the code of the error AI Gateway
 * answers with, which Guardrails send with a 424: the request, which holds the conversation the model was
 * to read as well as the question, or the model's answer. Asking again, or in another format, would be
 * blocked the same, so nothing is.
 */
const BLOCKS: ReadonlyArray<{ code: number; reason: RefusalReason; refusal: string }> = [
  { code: 2016, reason: "guardrails", refusal: "AI Gateway's Guardrails blocked the question. Change what they block in AI Gateway." },
  { code: 2017, reason: "guardrails answer", refusal: "AI Gateway's Guardrails blocked the model's answer. Change what they block in AI Gateway." },
  { code: 2029, reason: "dlp", refusal: "AI Gateway's Data Loss Prevention blocked the question. Change its policies in AI Gateway." },
  { code: 2030, reason: "dlp answer", refusal: "AI Gateway's Data Loss Prevention blocked the model's answer. Change its policies in AI Gateway." },
];

/** The codes and the first message of the errors in a refusal's body, in any of the shapes AI Gateway answers with. */
function errorIn(body: unknown): { codes: number[]; message: string | null } {
  if (!isObject(body)) return { codes: [], message: null };
  const errors = Array.isArray(body.errors) ? body.errors.filter(isObject) : [];
  const codes = errors.map(({ code }) => code).filter((code): code is number => typeof code === "number");
  const error = isObject(body.error) ? body.error.message : body.error;
  const message = [errors[0]?.message, error, body.message].find((text): text is string => typeof text === "string" && text.trim() !== "");
  return { codes, message: message?.trim() ?? null };
}

/** `message` cut to what Ember passes on. */
const quoted = (message: string) => (message.length > MAX_QUOTED_LENGTH ? `${message.slice(0, MAX_QUOTED_LENGTH - 1).trimEnd()}…` : message);

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
