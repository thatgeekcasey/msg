import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AI_GATEWAY_ACCOUNT, AI_GATEWAY_PORT } from "../../projects/workspace-settings";

// Cloudflare's AI REST API for the Ember AI spec, at the address the second test server's AI_GATEWAY_URL
// names, as Ember asks it (apps/worker/src/assistant/gateway.ts and catalog.ts): it knows one account,
// `AI_GATEWAY_ACCOUNT`, and that account's API token, lists `CATALOG` as Cloudflare's model catalog, and
// answers a request in any of AI Gateway's three formats with `HELLO` in that format, or, given a tool
// for searching the web in Messages or Responses, with `FOUND`, citing `SOURCE`, as the model would once
// it had searched, refusing as Cloudflare does an account or a token it doesn't know. A spec can hold its
// answers, to see what shows while a model answers.

/** What every model says, whatever it's asked. */
export const HELLO = "Hello, team! Mention @ember whenever you'd like a hand.";

/** What a model that searched the web says, and the page it cites. */
export const FOUND = "AI Gateway is Cloudflare's proxy for requests to AI models.";
export const SOURCE = { url: "https://developers.cloudflare.com/ai-gateway/", title: "Overview · Cloudflare AI Gateway docs" };

/** Cloudflare's model catalog, as its API lists the models of every kind, on one page, with what some cost. */
export const CATALOG = [
  { model_id: "@cf/zai-org/glm-4.7-flash", provider_id: "zai-org", name: "glm-4.7-flash", task: "Text Generation", request_formats: ["chat-completions"], provider_details: null },
  { model_id: "@cf/google/gemma-4-26b-a4b-it", provider_id: "google", name: "gemma-4-26b-a4b-it", task: "Text Generation", request_formats: null, provider_details: null },
  { model_id: "@cf/black-forest-labs/flux-2-dev", provider_id: "black-forest-labs", name: "FLUX.2 [dev]", task: "Text-to-Image", request_formats: null, provider_details: null },
  {
    model_id: "anthropic/claude-sonnet-5.5",
    provider_id: "anthropic",
    name: "Claude Sonnet 5.5",
    task: "Text Generation",
    request_formats: ["anthropic-messages"],
    provider_details: [{ id: "anthropic", pricing: { input_tokens: 3, input_cached_tokens: 0.3, output_tokens: 15 } }],
  },
  {
    model_id: "openai/gpt-6.1-sol",
    provider_id: "openai",
    name: "GPT-6.1 Sol",
    task: "Text Generation",
    request_formats: ["responses", "chat-completions"],
    provider_details: [{ id: "openai", pricing: { input_tokens: 2, output_tokens: 10 } }],
  },
];

/** What Ember asked AI Gateway: where, with which token and gateway, and what. */
export interface GatewayAsked {
  path: string;
  authorization: string | undefined;
  gateway: string | undefined;
  body: Record<string, unknown>;
}

export interface FakeGateway {
  /** What it was asked, in order. */
  asked: GatewayAsked[];
  /** Holds back its answers until the function it returns is called, or it closes. */
  hold(): () => void;
  close(): Promise<void>;
}

/** Starts AI Gateway. */
export async function startFakeGateway(): Promise<FakeGateway> {
  const asked: GatewayAsked[] = [];
  let held = Promise.resolve();
  let release = () => {};
  const server = createServer((request, response) => {
    answer(request, response, asked, held).catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(AI_GATEWAY_PORT, "127.0.0.1", resolve));
  const hold = () => {
    held = new Promise<void>((resolve) => (release = resolve));
    return release;
  };
  // Closing answers what it holds, as a spec that fails while it holds answers never lets them go.
  const close = () => {
    release();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { asked, hold, close };
}

/** Each format's path under an account, with its answer saying `HELLO`. */
const ANSWERS: Record<string, unknown> = {
  "chat/completions": { object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: HELLO }, finish_reason: "stop" }] },
  messages: { type: "message", role: "assistant", content: [{ type: "text", text: HELLO }], stop_reason: "end_turn" },
  responses: { object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: HELLO }] }] },
};

/** The paths of the formats with a tool for searching the web, with the answer saying `FOUND` once the model has searched. */
const SEARCHED_ANSWERS: Record<string, unknown> = {
  messages: {
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "I'll look that up." },
      { type: "server_tool_use", id: "srvtoolu_e2e", name: "web_search", input: { query: "Cloudflare AI Gateway" } },
      { type: "web_search_tool_result", tool_use_id: "srvtoolu_e2e", content: [{ type: "web_search_result", ...SOURCE, encrypted_content: "e2e", page_age: null }] },
      { type: "text", text: FOUND, citations: [{ type: "web_search_result_location", ...SOURCE, encrypted_index: "e2e", cited_text: FOUND }] },
    ],
    stop_reason: "end_turn",
  },
  responses: {
    object: "response",
    output: [
      { type: "web_search_call", id: "ws_e2e", status: "completed", action: { type: "search", query: "Cloudflare AI Gateway" } },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: FOUND, annotations: [{ type: "url_citation", ...SOURCE, start_index: 0, end_index: FOUND.length }] }] },
    ],
  },
};

/** Whether `body` gives the model a tool for searching the web, as Anthropic's and OpenAI's are named. */
const searches = (body: Record<string, unknown>) =>
  Array.isArray(body.tools) && body.tools.some((tool: { type?: unknown }) => typeof tool.type === "string" && tool.type.startsWith("web_search"));

async function answer(request: IncomingMessage, response: ServerResponse, asked: GatewayAsked[], held: Promise<void>): Promise<void> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  await held;
  const path = request.url ?? "";
  const gateway = request.headers["cf-aig-gateway-id"] as string | undefined;
  const sent = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
  asked.push({ path, authorization: request.headers.authorization, gateway, body: sent });
  const [, account, endpoint] = path.match(/^\/accounts\/([^/]+)\/ai\/([^?]+)/) ?? [];
  const reply = (status: number, data: unknown) => void response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  if (account !== AI_GATEWAY_ACCOUNT.accountId) {
    return reply(400, { success: false, errors: [{ code: 7003, message: `Could not route to /client/v4${path}, perhaps your object identifier is invalid?` }] });
  }
  if (request.headers.authorization !== `Bearer ${AI_GATEWAY_ACCOUNT.apiToken}`) return reply(401, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
  if (request.method === "GET" && endpoint === "catalog/models") {
    return reply(200, { success: true, errors: [], result: CATALOG, result_info: { page: 1, per_page: 100, count: CATALOG.length, total_count: CATALOG.length } });
  }
  const format = endpoint?.startsWith("v1/") ? endpoint.slice("v1/".length) : undefined;
  const answered = format === undefined ? undefined : ((searches(sent) && SEARCHED_ANSWERS[format]) || ANSWERS[format]);
  if (answered === undefined) return reply(404, { success: false, errors: [{ code: 7000, message: "No route for that URI" }] });
  reply(200, answered);
}
