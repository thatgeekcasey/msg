import { ASSISTANT_ID, HISTORY_PAGE_SIZE, type Me, type Message, type NewWorkspace, type RoomId, type User } from "@ember/protocol";
import type { AgentAnswer, AgentSettings, NewAgent } from "@ember/protocol/agents";
import { maxTokensAt, DEFAULT_LEVELS, type ModelFormat } from "@ember/protocol/assistant";
import { MENTION_CONTENT_TYPE, mentionSgid } from "@ember/richtext";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTES, ROOM_MESSAGES_READ } from "../src/assistant/answers";
import { ask as askModel, askOnce, askWaiting, goOn, type Asking, type Gateway, type PausedAnswer, type Question } from "../src/assistant/gateway";
import { MAX_FOUND_LENGTH, MAX_READ_LENGTH, MESSAGES_FOUND, READ_ENOUGH, roomTools, type RoomRead, type RoomReader } from "../src/assistant/room-tools";
import { CALL_DECLINED, CALLS_MADE, decided, goingOn, NO_CALLS_LEFT, resultsOf, TOOL_CALLS_PER_ANSWER, toolCallsIn, toolsIn, ToolError, withRoom, type EmberTool, type Unlogged } from "../src/assistant/tool-calls";
import type { Env } from "../src/env";
import { answerWithKeptModel, api, connect, cookieOf, createRoom, freshDeploy, post, roomSql, shown, workspaceSql, type Client, type Session } from "./support";

// The tools Ember runs for @ember and the agents: a model that calls one is asked again with what the
// call came to, in its format, for as many calls as an answer may make. The first read the room: its
// search, its pages, and its threads.

const bindings = env as unknown as Env;
const EMBER = { id: ASSISTANT_ID };
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "an-api-token-with-ai-gateway-run_0123456";
const [CLAUDE, GPT, GROK, GLM] = ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol", "xai/grok-4.7", "@cf/zai-org/glm-4.7-flash"];

/** A request the fake AI Gateway was sent, and what it told the gateway's logs of keeping what it carried, if anything. */
interface Asked {
  url: string;
  body: Record<string, unknown> & { tools?: unknown[]; messages?: unknown[]; input?: unknown[] };
  logsKeep: string | null;
}

/** A call a model makes: of the room's search for some words, or of a tool by its name, with what it's called with. */
type Call = string | { name: string; input: Record<string, unknown> };

/** What a model does in a turn: makes each of `calls`, or answers `text`. */
type Turn = { calls: Call[]; written?: number } | { text: string };

/** `call` by its tool's name, with what it's called with. */
const toolCallOf = (call: Call) => (typeof call === "string" ? { name: "search_messages", input: { words: call } } : call);

/** The format of the API at `url`, as its answers come. */
const shapeOf = (url: string) => (url.endsWith("/messages") ? "messages" : url.endsWith("/responses") ? "responses" : "chat");

/** What a model sends back for `turn`, the `nth` of an answer, in the format of the API at `url`: its thinking, then its calls, or its answer. */
function turnIn(url: string, turn: Turn, nth: number): Response {
  const shape = shapeOf(url);
  const calls = "calls" in turn ? turn.calls.map((call, index) => ({ id: `call_${nth}_${index}`, ...toolCallOf(call) })) : [];
  const written = "calls" in turn ? (turn.written ?? 50) : 50;
  if (shape === "messages") {
    const content = "text" in turn ? [{ type: "text", text: turn.text }] : [THOUGHT, { type: "text", text: "I'll look." }, ...calls.map(({ id, name, input }) => ({ type: "tool_use", id, name, input }))];
    return Response.json({ type: "message", role: "assistant", content, stop_reason: "text" in turn ? "end_turn" : "tool_use", usage: { input_tokens: 1_000, output_tokens: written } });
  }
  if (shape === "responses") {
    const output =
      "text" in turn
        ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: turn.text }] }]
        : [REASONED, ...calls.map(({ id, name, input }) => ({ type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(input), status: "completed" }))];
    return Response.json({ object: "response", status: "completed", output, usage: { input_tokens: 1_000, output_tokens: written } });
  }
  const message =
    "text" in turn
      ? { role: "assistant", content: turn.text }
      : { role: "assistant", content: null, tool_calls: calls.map(({ id, name, input }) => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } })) };
  return Response.json({ object: "chat.completion", choices: [{ index: 0, message, finish_reason: "text" in turn ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1_000, completion_tokens: written } });
}

/** Anthropic's model's thinking, and OpenAI's, which each asks to have back as it was. */
const THOUGHT = { type: "thinking", thinking: "The launch was set earlier.", signature: "sig" };
const REASONED = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "sealed" };

let asked: Asked[];
/** What the model does in each turn of its answers to questions with Ember's tools, in order, and then says hello. */
let script: Turn[];
/** What the fake AI Gateway answers a request, in place of the script, if anything. */
let refusing: (asked: Asked) => Response | null;

beforeEach(async () => {
  await freshDeploy();
  asked = [];
  script = [];
  refusing = () => null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const sent = { url: request.url, body: (await request.json()) as Asked["body"], logsKeep: request.headers.get("cf-aig-collect-log-payload") };
    asked.push(sent);
    const refused = refusing(sent);
    if (refused) return refused;
    const turn = sent.body.tools ? script.shift() : undefined;
    return turnIn(sent.url, turn ?? { text: "Hello, team!" }, asked.length);
  });
});

afterEach(() => vi.restoreAllMocks());

const as = (session: Session) => ({ Cookie: session.cookie });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sets Ember up with Ada as its administrator and Ember AI answering with `model`, answering her session, the general room, and her there. */
async function setUp(model: string): Promise<{ ada: Session; general: RoomId; inGeneral: Client }> {
  const response = await api("/api/first_run", { method: "POST", body: JSON.stringify({ name: "Ada Lovelace", emailAddress: "ada@example.com", password: "analytical engine" }) });
  expect(response.status).toBe(201);
  const ada = { user: shown(((await response.json()) as NewWorkspace).user), cookie: cookieOf(response) };
  const [{ id: general }] = (await workspaceSql("SELECT id FROM rooms WHERE name = 'general'")) as [{ id: RoomId }];
  const set = await api("/api/account/assistant", { method: "PUT", headers: as(ada), body: JSON.stringify({ accountId: ACCOUNT_ID, apiToken: API_TOKEN, model }) });
  expect(set.status, await set.clone().text()).toBe(200);
  asked.length = 0;
  return { ada, general, inGeneral: await connect(general, ada) };
}

/** Waits until room `room` has nothing left in its log for the search index. */
async function caughtUp(room: RoomId): Promise<void> {
  while ((await roomSql(room, "SELECT seq FROM unindexed_messages WHERE room_id = ?", room)).length > 0) await sleep(5);
}

/** Writes enough in the room `client` is in that what was written there before isn't read with a question asked next. */
async function moveOn(client: Client): Promise<void> {
  for (let n = 1; n < ROOM_MESSAGES_READ; n++) await post(client, `<p>Onwards ${n}</p>`);
}

/** Writes `body` in the room `client` is in, in the thread under `parent`, answering the reply. */
async function replyTo(client: Client, parent: Message, body: string): Promise<Message> {
  const clientMessageId = crypto.randomUUID();
  client.send({ type: "message.create", clientMessageId, body, parentId: parent.id });
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.clientMessageId === clientMessageId) return message;
  }
}

/**
 * Asks `bot` `question` in the room `client` is in, or in the thread under `under`, once the search index
 * has what was written there, answering the question and what the bot said.
 */
async function ask(client: Client, room: RoomId, bot: Pick<User, "id">, question = "when is the launch?", under?: Message): Promise<{ question: Message; answer: Message }> {
  await caughtUp(room);
  const mention = `<action-text-attachment sgid="${mentionSgid(bot.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;
  const body = `<p>${mention} ${question}</p>`;
  const sent = under ? await replyTo(client, under, body) : await post(client, body);
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.creator.id === bot.id) return { question: sent, answer: message };
  }
}

/** The requests that asked a model a question in a room, which give it Ember's tools, or would. */
const answers = () => asked.filter(({ body }) => JSON.stringify(body).includes("when is the launch?"));

/** What a tool `takes`, each of whose properties is a string. */
const strings = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((name) => [name, { type: "string", description: expect.any(String) as string }])), additionalProperties: false });

/** The room's tools, as a model is told of them, with what each takes. */
const ROOM_TOOLS = [
  { name: "search_messages", description: expect.stringContaining("Searches the messages of the room you're asked in") as string, takes: strings("words", "from") },
  { name: "read_room", description: expect.stringContaining("Reads the messages of the room you're asked in") as string, takes: strings("before", "after") },
  { name: "read_thread", description: expect.stringContaining("Reads a thread in the room you're asked in") as string, takes: strings("message_id", "before") },
];
const ROOM_TOOL_NAMES = ROOM_TOOLS.map(({ name }) => name);

/** When `message` was written, as the room's tools say it. */
const whenOf = ({ createdAt }: Pick<Message, "createdAt">) => `${createdAt.slice(0, 10)} ${createdAt.slice(11, 16)} UTC`;

describe("A tool Ember runs", () => {
  it("is called by Claude, which is asked again with what it said, its thinking too, and what the room's search found", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    const said = await post(inGeneral, "<p>The launch moved to March 3.</p>");
    await moveOn(inGeneral);
    script = [{ calls: ["launch"], written: 300 }, { text: "The launch is on March 3." }];

    const { answer } = await ask(inGeneral, general, EMBER);
    expect(answer.plainText).toBe("The launch is on March 3.");

    const [first, second] = answers();
    expect(answers()).toHaveLength(2);
    expect(first!.url).toMatch(/\/anthropic\/v1\/messages$/);
    expect(first!.body.tools).toEqual(ROOM_TOOLS.map(({ takes, ...tool }) => ({ ...tool, input_schema: takes })));
    expect(first!.body).not.toHaveProperty("tool_choice");
    expect(second!.body.messages).toEqual([
      ...first!.body.messages!,
      { role: "assistant", content: [THOUGHT, { type: "text", text: "I'll look." }, { type: "tool_use", id: "call_1_0", name: "search_messages", input: { words: "launch" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1_0", content: `The only message with those words:\n\n[${whenOf(said)}, id ${said.id}] Ada Lovelace: The launch moved to March 3.` }] },
    ]);
    // The answer's turns share its tokens.
    expect(second!.body).toMatchObject({ max_tokens: maxTokensAt(DEFAULT_LEVELS) - 300, tools: first!.body.tools });
    expect(second!.body).not.toHaveProperty("tool_choice");
  });

  it("is called by GPT in Responses, whose thinking Ember asks for in a form it can send back with the call's result", async () => {
    const { general, inGeneral } = await setUp(GPT);
    await post(inGeneral, "<p>The launch moved to March 3.</p>");
    await moveOn(inGeneral);
    script = [{ calls: ["launch"], written: 300 }, { text: "The launch is on March 3." }];

    const { answer } = await ask(inGeneral, general, EMBER);
    expect(answer.plainText).toBe("The launch is on March 3.");

    const [first, second] = answers();
    expect(answers()).toHaveLength(2);
    expect(first!.url).toMatch(/\/openai\/responses$/);
    expect(first!.body).toMatchObject({ tools: ROOM_TOOLS.map(({ takes, ...tool }) => ({ type: "function", ...tool, parameters: takes })), store: false, include: ["reasoning.encrypted_content"] });
    expect(second!.body.input).toEqual([
      ...first!.body.input!,
      REASONED,
      { type: "function_call", id: "fc_call_1_0", call_id: "call_1_0", name: "search_messages", arguments: '{"words":"launch"}', status: "completed" },
      { type: "function_call_output", call_id: "call_1_0", output: expect.stringContaining("Ada Lovelace: The launch moved to March 3.") as string },
    ]);
    expect(second!.body).toMatchObject({ max_output_tokens: maxTokensAt(DEFAULT_LEVELS) - 300, store: false });
  });

  it("is called by Grok in Chat Completions, through Cloudflare's REST API", async () => {
    const { general, inGeneral } = await setUp(GROK);
    await post(inGeneral, "<p>The launch moved to March 3.</p>");
    await moveOn(inGeneral);
    script = [{ calls: ["launch"], written: 300 }, { text: "The launch is on March 3." }];

    const { answer } = await ask(inGeneral, general, EMBER);
    expect(answer.plainText).toBe("The launch is on March 3.");

    const [first, second] = answers();
    expect(answers()).toHaveLength(2);
    expect(first!.url).toMatch(/\/ai\/v1\/chat\/completions$/);
    expect(first!.body.tools).toEqual(ROOM_TOOLS.map(({ takes, ...tool }) => ({ type: "function", function: { ...tool, parameters: takes } })));
    expect(second!.body.messages).toEqual([
      ...first!.body.messages!,
      { role: "assistant", content: null, tool_calls: [{ id: "call_1_0", type: "function", function: { name: "search_messages", arguments: '{"words":"launch"}' } }] },
      { role: "tool", tool_call_id: "call_1_0", content: expect.stringContaining("Ada Lovelace: The launch moved to March 3.") as string },
    ]);
    expect(second!.body).toMatchObject({ max_completion_tokens: maxTokensAt(DEFAULT_LEVELS) - 300 });
  });

  it("runs as many calls as an answer may make, tells the model of the rest that it has none left, and then has it answer", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    // All but two of the calls an answer may make search in its first round, and of the three in its next, the last is one too many.
    const searches = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`);
    script = [{ calls: searches(TOOL_CALLS_PER_ANSWER - 2) }, { calls: searches(3) }, { text: "I found nothing." }];

    const { answer } = await ask(inGeneral, general, EMBER);
    expect(answer.plainText).toBe("I found nothing.");

    expect(TOOL_CALLS_PER_ANSWER).toBe(20);
    const [, second, third] = answers();
    expect(answers()).toHaveLength(3);
    expect(second!.body).not.toHaveProperty("tool_choice");
    expect(third!.body).toMatchObject({ tool_choice: { type: "none" } });
    const results = (third!.body.messages!.at(-1) as { content: Array<{ content: string; is_error?: boolean }> }).content;
    expect(results.map(({ content, is_error }) => [content, is_error])).toEqual([
      ["No message in this room has those words.", undefined],
      ["No message in this room has those words.", undefined],
      [NO_CALLS_LEFT, true],
    ]);
  });

  describe("called by a model that searches the web too", () => {
    const tool: EmberTool = { name: "search_messages", description: "Searches the room.", takes: { type: "object" }, run: async () => "Nothing." };
    const question: Question = { instructions: "Answer.", turns: [{ role: "user", text: "when is the launch?" }], maxTokens: 1_000, webTools: ["search", "read"], tools: [tool] };
    const gatewayFor = (model: string, format: ModelFormat): Gateway => ({ accountId: ACCOUNT_ID, apiToken: API_TOKEN, model, format });
    /** What the fake AI Gateway answers each request in turn, as JSON. */
    const answering = (bodies: unknown[]) => {
      refusing = () => Response.json(bodies.shift());
    };

    it("leaves Claude the searches and pages its earlier turns didn't use, and has it answer once it has used one up", async () => {
      const searched = (id: string) => [{ type: "server_tool_use", id, name: "web_search", input: { query: "launch" } }, { type: "web_search_tool_result", tool_use_id: id, content: [] }];
      const calling = (id: string) => ({ type: "tool_use", id, name: "search_messages", input: { words: "launch" } });
      const turn = (content: unknown[], stop_reason = "tool_use") => ({ type: "message", role: "assistant", content, stop_reason, usage: { input_tokens: 1_000, output_tokens: 50 } });
      answering([
        turn([...searched("srv_1"), ...searched("srv_2"), calling("call_1")]),
        turn([...searched("srv_3"), ...searched("srv_4"), ...searched("srv_5"), calling("call_2")]),
        turn([{ type: "text", text: "Nobody said." }], "end_turn"),
      ]);

      const answered = await askOnce(bindings, gatewayFor(CLAUDE, "anthropic"), question, AbortSignal.timeout(5_000));
      expect(answered).toMatchObject({ text: "Nobody said." });

      const usesOf = ({ body }: Asked) => (body.tools as Array<{ name: string; max_uses?: number }>).map(({ name, max_uses }) => [name, max_uses]);
      expect(asked.map(usesOf)).toEqual([
        [["web_search", 5], ["web_fetch", 3], ["search_messages", undefined]],
        [["web_search", 3], ["web_fetch", 3], ["search_messages", undefined]],
        [["web_search", 1], ["web_fetch", 3], ["search_messages", undefined]],
      ]);
      expect(asked.map(({ body }) => body.tool_choice)).toEqual([undefined, undefined, { type: "none" }]);
    });

    it("leaves GPT, and Grok at xAI's endpoint, the searches their earlier turns didn't make", async () => {
      const search = { type: "web_search_call", id: "ws_1", status: "completed" };
      const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "search_messages", arguments: "{}", status: "completed" };
      const turn = (output: unknown[]) => ({ object: "response", status: "completed", output, usage: { input_tokens: 1_000, output_tokens: 50 } });
      const said = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Nobody said." }] };

      answering([turn([search, search, call]), turn([search, search, search, call]), turn([said])]);
      expect(await askOnce(bindings, gatewayFor(GPT, "openai"), question, AbortSignal.timeout(5_000))).toMatchObject({ text: "Nobody said." });
      expect(asked.map(({ body }) => [body.max_tool_calls, body.tool_choice])).toEqual([[5, undefined], [3, undefined], [1, "none"]]);

      asked.length = 0;
      answering([turn([search, call]), turn([said])]);
      expect(await askOnce(bindings, gatewayFor(GROK, "xai"), question, AbortSignal.timeout(5_000))).toMatchObject({ text: "Nobody said." });
      expect(asked.map(({ body }) => [body.max_turns, body.tool_choice])).toEqual([[5, undefined], [4, undefined]]);
    });

    it("runs Grok's searches of the web in Chat Completions with the room's, through Cloudflare's Web Search API, and lists the pages it cites of those they found", async () => {
      const page = { url: "https://example.com/launch", title: "Launch day", description: "The launch is on March 3." };
      const call = (id: string, name: string, args: Record<string, string>) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
      const turn = (message: Record<string, unknown>) => ({ object: "chat.completion", choices: [{ index: 0, message, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" }], usage: { completion_tokens: 50 } });
      const answers = [
        turn({ role: "assistant", content: null, tool_calls: [call("call_1", "web_search", { query: "launch date" }), call("call_2", "search_messages", { words: "launch" })] }),
        turn({ role: "assistant", content: "It's on March 3 [1]." }),
      ];
      refusing = ({ url }) => Response.json(url.endsWith("/ai/websearch/") ? { success: true, result: { items: [page] } } : answers.shift());

      const answered = await askOnce(bindings, gatewayFor(GROK, "chat"), question, AbortSignal.timeout(5_000));
      expect(answered).toMatchObject({ text: "It's on March 3.", sources: [{ url: page.url, title: page.title }] });
      expect(asked.map(({ url }) => new URL(url).pathname)).toEqual([
        `/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`,
        `/client/v4/accounts/${ACCOUNT_ID}/ai/websearch/`,
        `/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`,
      ]);
      // Only Ember's tool for searching the web is given, as Chat Completions has no tool for reading pages.
      expect((asked[0]!.body.tools as Array<{ function: { name: string } }>).map(({ function: { name } }) => name)).toEqual(["web_search", "search_messages"]);
      expect(asked[1]!.body).toMatchObject({ query: "launch date", options: { gateway: { id: "default" } } });
      expect(asked[2]!.body.messages!.slice(-2)).toEqual([
        { role: "tool", tool_call_id: "call_1", content: `[1] Launch day\n${page.url}\nThe launch is on March 3.\n\nCite a page you use by its number in brackets, such as [1], after what you take from it.` },
        { role: "tool", tool_call_id: "call_2", content: "Nothing." },
      ]);
    });

    it("asks Grok once more without Ember's tool for searching the web too, when it's refused going on from a call, listing what it cites of what its searches found before", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const page = { url: "https://example.com/launch", title: "Launch day", description: "The launch is on March 3." };
      const searching = { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"launch"}' } }] };
      const turn = (message: Record<string, unknown>) => Response.json({ object: "chat.completion", choices: [{ index: 0, message, finish_reason: "stop" }], usage: { completion_tokens: 50 } });
      const answers = [
        () => turn(searching),
        () => Response.json({ success: false, errors: [{ code: 7001, message: "Unexpected tool message" }] }, { status: 400 }),
        () => turn({ role: "assistant", content: "It's on March 3. [1]" }),
      ];
      refusing = ({ url }) => (url.endsWith("/ai/websearch/") ? Response.json({ success: true, result: { items: [page] } }) : answers.shift()!());

      const answered = await askOnce(bindings, gatewayFor(GROK, "chat"), question, AbortSignal.timeout(5_000));
      expect(answered).toMatchObject({ text: "It's on March 3.", sources: [{ url: page.url, title: page.title }] });
      expect(asked).toHaveLength(4);
      const last = asked.at(-1)!.body;
      expect(last).not.toHaveProperty("tools");
      expect(last).toMatchObject({ max_completion_tokens: question.maxTokens - 50 });
      // What its search found comes after the conversation, as it can't search now.
      expect(last.messages).toEqual([
        ...asked[0]!.body.messages!,
        { role: "user", content: `${CALLS_MADE}\n\nCall 1: web_search with {"query":"launch"}\n[1] Launch day\n${page.url}\nThe launch is on March 3.\n\nCite a page you use by its number in brackets, such as [1], after what you take from it.` },
      ]);
    });

    it("leaves a model refused going on from a call the searches and tokens its turns didn't use, as it's asked again without Ember's tools", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const refusal = () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "messages.2: unexpected `tool_result`" } }, { status: 400 });
      const searched = (id: string) => [{ type: "server_tool_use", id, name: "web_search", input: { query: "launch" } }, { type: "web_search_tool_result", tool_use_id: id, content: [] }];
      const calling = { type: "tool_use", id: "call_1", name: "search_messages", input: { words: "launch" } };
      const turn = (content: unknown[], stop_reason: string, written: number) => ({ type: "message", role: "assistant", content, stop_reason, usage: { input_tokens: 1_000, output_tokens: written } });
      // Claude searches the web twice and calls the room's search, pauses going on, and is refused carrying that on.
      const answers = [
        () => Response.json(turn([...searched("srv_1"), ...searched("srv_2"), calling], "tool_use", 50)),
        () => Response.json(turn([{ type: "text", text: "Let me see." }], "pause_turn", 40)),
        refusal,
        () => Response.json(turn([{ type: "text", text: "Nobody said." }], "end_turn", 10)),
      ];
      refusing = () => answers.shift()!();

      expect(await askOnce(bindings, gatewayFor(CLAUDE, "anthropic"), question, AbortSignal.timeout(5_000))).toMatchObject({ text: "Nobody said." });
      const last = asked.at(-1)!.body;
      expect(asked).toHaveLength(4);
      expect((last.tools as Array<{ name: string; max_uses?: number }>).map(({ name, max_uses }) => [name, max_uses])).toEqual([["web_search", 3], ["web_fetch", 3]]);
      expect(last).toMatchObject({ max_tokens: question.maxTokens - 90 });
      expect(last.messages).toEqual([{ role: "user", content: `when is the launch?\n\n${CALLS_MADE}\n\nCall 1: search_messages with {"words":"launch"}\nNothing.` }]);
      expect(last).not.toHaveProperty("tool_choice");

      // GPT, whose searches are capped by the request, is left those it didn't make.
      asked.length = 0;
      const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "search_messages", arguments: "{}", status: "completed" };
      const search = { type: "web_search_call", id: "ws_1", status: "completed" };
      const said = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Nobody said." }] };
      const responded = (output: unknown[]) => () => Response.json({ object: "response", status: "completed", output, usage: { input_tokens: 1_000, output_tokens: 50 } });
      answers.push(responded([search, search, call]), () => Response.json({ error: { type: "invalid_request_error", message: "Unknown parameter: input[3]" } }, { status: 400 }), responded([said]));
      expect(await askOnce(bindings, gatewayFor(GPT, "openai"), question, AbortSignal.timeout(5_000))).toMatchObject({ text: "Nobody said." });
      expect(asked.map(({ body }) => [body.max_tool_calls, (body.tools as unknown[]).length, body.max_output_tokens])).toEqual([
        [5, 2, question.maxTokens],
        [3, 2, question.maxTokens - 50],
        [3, 1, question.maxTokens - 50],
      ]);
    });
  });

  it("says it couldn't answer when the model calls a tool with too few of the answer's tokens left to go on", async () => {
    const { general, inGeneral } = await setUp(GPT);
    script = [{ calls: ["launch"], written: maxTokensAt(DEFAULT_LEVELS) - 10 }];
    const { answer } = await ask(inGeneral, general, EMBER);
    expect(answer.plainText).toBe(NOTES["out of room"]);
    expect(answers()).toHaveLength(1);
  });

  it("is left out when the model's request is refused with it, after everything else that might have been refused", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    vi.spyOn(console, "error").mockImplementation(() => {});
    refusing = ({ body }) => (body.tools ? Response.json({ type: "error", error: { type: "invalid_request_error", message: "tools.0: Extra inputs are not permitted" } }, { status: 400 }) : null);

    const { answer } = await ask(inGeneral, general, EMBER);
    expect(answer.plainText).toBe("Hello, team!");
    expect(answers().map(({ body }) => [body.tools !== undefined, "thinking" in body])).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
  });

  it("is left out for the rest of an answer whose model is refused going on from a call, which is asked once more, as it was but for what the call came to, in the tokens the answer has left", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const goesOn = ({ body }: Asked) => JSON.stringify(body.messages).includes("tool_result");
    refusing = (sent) => (goesOn(sent) ? Response.json({ type: "error", error: { type: "invalid_request_error", message: "messages.2: unexpected `tool_result`" } }, { status: 400 }) : null);
    script = [{ calls: ["launch"], written: 300 }];

    const { answer } = await ask(inGeneral, general, EMBER);
    expect(answer.plainText).toBe("Hello, team!");
    expect(answers().map(({ body }) => [body.tools !== undefined, "thinking" in body, body.max_tokens])).toEqual([
      [true, true, maxTokensAt(DEFAULT_LEVELS)],
      [true, true, maxTokensAt(DEFAULT_LEVELS) - 300],
      [false, true, maxTokensAt(DEFAULT_LEVELS) - 300],
    ]);
    // ...with what its call came to after the conversation.
    const [first, refused, again] = answers().map(({ body }) => body.messages as Array<{ role: string; content: unknown }>);
    const [{ content: found }] = refused!.at(-1)!.content as [{ content: string }];
    const lastTurn = first!.at(-1) as { role: string; content: string };
    expect(again).toEqual([...first!.slice(0, -1), { ...lastTurn, content: `${lastTurn.content}\n\n${CALLS_MADE}\n\nCall 1: search_messages with {"words":"launch"}\n${found}` }]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("again without Ember's tools, as it was refused going on from a call of one"));

    // Refused without them too, it isn't asked another way.
    asked.length = 0;
    script = [{ calls: ["launch"] }];
    refusing = (sent) => (goesOn(sent) || !sent.body.tools ? Response.json({ type: "error", error: { type: "invalid_request_error", message: "messages: unexpected" } }, { status: 400 }) : null);
    const { answer: note } = await ask(inGeneral, general, EMBER);
    expect(note.plainText).not.toBe("Hello, team!");
    expect(answers()).toHaveLength(3);
  });

  it("isn't given to a model kept from before Ember offered only its own, or to an agent someone tries", async () => {
    const { ada, general, inGeneral } = await setUp(CLAUDE);
    await answerWithKeptModel({ id: GLM, name: "GLM-4.7 Flash", format: "chat", thinkingLevels: ["off"] });
    await ask(inGeneral, general, EMBER);
    expect(answers().map(({ body }) => body.tools)).toEqual([undefined]);

    asked.length = 0;
    const trial = { name: "Scout", instructions: "Help out.", model: CLAUDE, thinking: "off", length: "short", webSearch: false, question: "when is the launch?" };
    const tried = await api("/api/account/agents/trials", { method: "POST", headers: as(ada), body: JSON.stringify(trial) });
    expect(tried.status, await tried.clone().text()).toBe(200);
    expect(answers().map(({ body }) => body.tools)).toEqual([undefined]);
  });

  it("is given to an agent asked in a room", async () => {
    const { ada, general, inGeneral } = await setUp(CLAUDE);
    const agent: NewAgent = { name: "Scout", description: "Helps out", instructions: "Help out.", model: GPT, thinking: "off", length: "short", webSearch: false, rooms: null };
    const made = await api("/api/account/agents", { method: "POST", headers: as(ada), body: JSON.stringify(agent) });
    expect(made.status, await made.clone().text()).toBe(201);
    const scout = ((await made.json()) as AgentAnswer).agent as AgentSettings;
    asked.length = 0;
    script = [{ calls: ["launch"] }, { text: "Nobody said." }];

    const { answer } = await ask(inGeneral, general, { id: scout.id });
    expect(answer.plainText).toBe("Nobody said.");
    expect(answers().map(({ body }) => (body.tools as Array<{ name: string }>).map(({ name }) => name))).toEqual([ROOM_TOOL_NAMES, ROOM_TOOL_NAMES]);
  });
});

describe("An answer that waits at a call", () => {
  const gatewayFor = (model: string, format: ModelFormat): Gateway => ({ accountId: ACCOUNT_ID, apiToken: API_TOKEN, model, format });
  /** What the fake AI Gateway answers each request in turn, as JSON. */
  const answering = (bodies: unknown[]) => {
    refusing = () => Response.json(bodies.shift());
  };
  let sent: unknown[];
  let tools: EmberTool[];
  let question: Question;
  beforeEach(() => {
    sent = [];
    tools = [
      { name: "look", description: "Looks it up.", takes: { type: "object" }, run: async () => "Launch is Friday." },
      { name: "send", description: "Sends it.", takes: { type: "object" }, asksFirst: true, run: async (input) => `Sent ${sent.push(input)}` },
    ];
    question = { instructions: "Answer.", turns: [{ role: "user", text: "tell ada when the launch is" }], maxTokens: 1_000, thinking: "low", askerId: "ada", agentId: ASSISTANT_ID, tools };
  });
  const waitingIn = (answered: unknown): Asking => {
    expect(answered).toHaveProperty("asks");
    return answered as Asking;
  };
  /** `paused`, as its room keeps it and reads it again. */
  const kept = (paused: PausedAnswer) => JSON.parse(JSON.stringify(paused)) as PausedAnswer;

  it("stops Claude's answer at the call, keeps it as JSON, and goes on with what the call came to once it's allowed, to the next", async () => {
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
    const turn = (content: unknown[], stop_reason = "tool_use") => ({ type: "message", role: "assistant", content, stop_reason, usage: { input_tokens: 1_000, output_tokens: 100 } });
    // A page the model read before the call, which the answer still came from once it has waited.
    const read = { type: "web_fetch_tool_result", tool_use_id: "srv_1", content: { type: "web_fetch_result", url: "https://example.com/launch", content: { title: "Launch" } } };
    answering([
      turn([THOUGHT, read, use("call_1", "look", {}), use("call_2", "send", { to: "ada" }), use("call_3", "send", { to: "grace" })]),
      turn([{ type: "text", text: "Ada knows now. Grace wasn't told." }], "end_turn"),
    ]);
    const gateway = gatewayFor(CLAUDE, "anthropic");

    const first = waitingIn(await askWaiting(bindings, gateway, question, 5_000));
    expect(first.asks).toEqual({ id: "call_2", name: "send", input: { to: "ada" } });
    expect(first.paused).toMatchObject({ model: CLAUDE, format: "anthropic", called: 0, tokensLeft: 900, results: [{ id: "call_1", text: "Launch is Friday.", failed: false }] });
    expect(first.paused.question).not.toHaveProperty("tools");
    expect(sent).toEqual([]);
    expect(asked).toHaveLength(1);

    // Allowed, the call runs, and the answer waits at the next of the same turn, the model not asked meanwhile.
    const second = waitingIn(await goOn(bindings, gateway, tools, kept(first.paused), true, 5_000));
    expect(second.asks).toEqual({ id: "call_3", name: "send", input: { to: "grace" } });
    expect(second.paused.results.map(({ text }) => text)).toEqual(["Launch is Friday.", "Sent 1"]);
    expect(sent).toEqual([{ to: "ada" }]);
    expect(asked).toHaveLength(1);

    // Declined, it doesn't run, and the model is told so with what the others came to, as one round of calls.
    const answered = await goOn(bindings, gateway, tools, kept(second.paused), false, 5_000);
    expect(answered).toMatchObject({ text: "Ada knows now. Grace wasn't told.", sources: [{ url: "https://example.com/launch", title: "Launch" }] });
    expect(sent).toHaveLength(1);
    expect(asked).toHaveLength(2);
    const [, went] = asked;
    expect(went!.body).toMatchObject({ max_tokens: 900, thinking: expect.anything() as unknown });
    expect(went!.body.messages!.slice(-2)).toEqual([
      { role: "assistant", content: [THOUGHT, read, use("call_1", "look", {}), use("call_2", "send", { to: "ada" }), use("call_3", "send", { to: "grace" })] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "Launch is Friday." },
          { type: "tool_result", tool_use_id: "call_2", content: "Sent 1" },
          { type: "tool_result", tool_use_id: "call_3", content: CALL_DECLINED, is_error: true },
        ],
      },
    ]);
  });

  it("counts the calls of every round toward what an answer may make, in Responses too, and a tool gone while it waited isn't run", async () => {
    const call = (id: string, name: string) => ({ type: "function_call", id: `fc_${id}`, call_id: id, name, arguments: "{}", status: "completed" });
    const turn = (output: unknown[]) => ({ object: "response", status: "completed", output, usage: { input_tokens: 1_000, output_tokens: 100 } });
    const said = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] };
    // All but two of the calls an answer may make look it up, and of the three sends after them, the last is one too many.
    const looks = TOOL_CALLS_PER_ANSWER - 2;
    const [sendOne, sendTwo, sendThree] = [1, 2, 3].map((n) => `call_${looks + n}`) as [string, string, string];
    answering([turn([REASONED, ...Array.from({ length: looks }, (_, index) => call(`call_${index + 1}`, "look"))]), turn([call(sendOne, "send"), call(sendTwo, "send"), call(sendThree, "send")]), turn([said])]);
    const gateway = gatewayFor(GPT, "openai");

    const first = waitingIn(await askWaiting(bindings, gateway, question, 5_000));
    expect(first.asks).toEqual({ id: sendOne, name: "send", input: {} });
    expect(first.paused).toMatchObject({ called: looks, tokensLeft: 800, results: [] });
    const second = waitingIn(await goOn(bindings, gateway, tools, kept(first.paused), true, 5_000));
    expect(second.asks.id).toBe(sendTwo);

    // The tool isn't the agent's any more by the time the second is allowed, and the third is past what an answer may call.
    expect(await goOn(bindings, gateway, tools.slice(0, 1), kept(second.paused), true, 5_000)).toMatchObject({ text: "Done." });
    expect(sent).toHaveLength(1);
    const [, , last] = asked;
    expect(last!.body).toMatchObject({ tool_choice: "none", max_output_tokens: 800 });
    expect(last!.body.input!.slice(-3)).toEqual([
      { type: "function_call_output", call_id: sendOne, output: "Sent 1" },
      { type: "function_call_output", call_id: sendTwo, output: "There's no tool called send any more." },
      { type: "function_call_output", call_id: sendThree, output: NO_CALLS_LEFT },
    ]);
  });

  it("keeps what Grok's searches of the web found before the call, in Chat Completions, and lists those it cites under the answer once it has waited, numbering what it finds then after them", async () => {
    const page = { url: "https://example.com/launch", title: "Launch day", description: "The launch is on March 3." };
    const time = { url: "https://example.com/launch-time", title: "Launch time", description: "It starts at noon." };
    const call = (id: string, name: string, args: Record<string, string>) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
    const turn = (message: Record<string, unknown>) => ({ object: "chat.completion", choices: [{ index: 0, message, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" }], usage: { completion_tokens: 50 } });
    const answers = [
      turn({ role: "assistant", content: null, tool_calls: [call("call_1", "web_search", { query: "launch date" }), call("call_2", "send", { to: "ada" })] }),
      turn({ role: "assistant", content: null, tool_calls: [call("call_3", "web_search", { query: "launch time" })] }),
      turn({ role: "assistant", content: "Ada knows it's on March 3 [1] at noon [2]." }),
    ];
    const results = [page, time];
    refusing = ({ url }) => Response.json(url.endsWith("/ai/websearch/") ? { success: true, result: { items: [results.shift()] } } : answers.shift());
    const gateway = gatewayFor(GROK, "chat");

    const waiting = waitingIn(await askWaiting(bindings, gateway, { ...question, webTools: ["search"] }, 5_000));
    expect(waiting.asks).toEqual({ id: "call_2", name: "send", input: { to: "ada" } });
    expect(waiting.paused.searches).toEqual({ found: [[expect.objectContaining({ url: page.url, title: page.title })]] });

    const answered = await goOn(bindings, gateway, tools, kept(waiting.paused), true, 5_000);
    expect(answered).toMatchObject({ text: "Ada knows it's on March 3 at noon.", sources: [{ url: page.url, title: page.title }, { url: time.url, title: time.title }] });
    expect(sent).toEqual([{ to: "ada" }]);
    // The model is still given Ember's tool for searching the web as it goes on, and what it finds then is numbered after what it found before.
    expect(asked.map(({ url }) => new URL(url).pathname.split("/ai/")[1])).toEqual(["v1/chat/completions", "websearch/", "v1/chat/completions", "websearch/", "v1/chat/completions"]);
    expect((asked[2]!.body.tools as Array<{ function: { name: string } }>).map(({ function: { name } }) => name)).toEqual(["web_search", "look", "send"]);
    expect(asked[4]!.body.messages!.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_3",
      content: `[2] Launch time\n${time.url}\nIt starts at noon.\n\nCite a page you use by its number in brackets, such as [2], after what you take from it.`,
    });
  });

  it("keeps the rest of an answer out of AI Gateway's logs from a call that came to what they mustn't keep, once it has waited, and its searches of the web", async () => {
    const call = (id: string, name: string, args: Record<string, string>) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
    const turn = (message: Record<string, unknown>) => ({ object: "chat.completion", choices: [{ index: 0, message, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" }], usage: { completion_tokens: 50 } });
    const answers = [
      turn({ role: "assistant", content: null, tool_calls: [call("call_1", "read_dm", {}), call("call_2", "send", { to: "ada" })] }),
      turn({ role: "assistant", content: null, tool_calls: [call("call_3", "web_search", { query: "tangerine" })] }),
      turn({ role: "assistant", content: "Ada knows the code." }),
    ];
    refusing = ({ url }) => Response.json(url.endsWith("/ai/websearch/") ? { success: true, result: { items: [] } } : answers.shift());
    const readDm: EmberTool = { name: "read_dm", description: "Reads a DM.", takes: { type: "object" }, run: async () => ({ text: "The launch code is tangerine.", unlogged: true }) };
    const given = [readDm, ...tools];
    const gateway = gatewayFor(GROK, "chat");

    const waiting = waitingIn(await askWaiting(bindings, gateway, { ...question, tools: given, webTools: ["search"] }, 5_000));
    expect(waiting.asks).toEqual({ id: "call_2", name: "send", input: { to: "ada" } });
    expect(waiting.paused.question.unlogged).toBe(true);
    expect(await goOn(bindings, gateway, given, kept(waiting.paused), true, 5_000)).toMatchObject({ text: "Ada knows the code." });
    // Only the first request, made before the DM was read, is kept whole.
    expect(asked.map(({ url, logsKeep }) => [new URL(url).pathname.split("/ai/")[1], logsKeep])).toEqual([
      ["v1/chat/completions", null],
      ["v1/chat/completions", "false"],
      ["websearch/", "false"],
      ["v1/chat/completions", "false"],
    ]);
  });

  it("tells a model refused going on once a call is allowed what every call of its answer did, as it's asked again without the tools, so that it doesn't answer as if they hadn't", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // An app that fails a call may say nothing of why, as Ember tells a model then.
    const close: EmberTool = { name: "close", description: "Closes the issue.", takes: { type: "object" }, run: () => Promise.reject(new ToolError("(The tool answered with nothing.)")) };
    const given = [...tools, close];
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
    const turn = (content: unknown[], stop_reason = "tool_use") => ({ type: "message", role: "assistant", content, stop_reason, usage: { input_tokens: 1_000, output_tokens: 100 } });
    const answers = [
      () => Response.json(turn([use("call_1", "look", {}), use("call_2", "close", { issue: 42 })])),
      () => Response.json(turn([use("call_3", "send", { to: "ada" })])),
      () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "messages.4: unexpected `tool_result`" } }, { status: 400 }),
      () => Response.json(turn([{ type: "text", text: "I've told Ada the launch is Friday." }], "end_turn")),
    ];
    refusing = () => answers.shift()!();
    const gateway = gatewayFor(CLAUDE, "anthropic");

    const waiting = waitingIn(await askWaiting(bindings, gateway, { ...question, tools: given }, 5_000));
    expect(waiting.asks).toEqual({ id: "call_3", name: "send", input: { to: "ada" } });
    expect(await goOn(bindings, gateway, given, kept(waiting.paused), true, 5_000)).toMatchObject({ text: "I've told Ada the launch is Friday." });
    expect(sent).toEqual([{ to: "ada" }]);

    // Asked once more, it reads the conversation as it was asked, then what each call came to, those before the answer waited too, and which failed.
    expect(asked).toHaveLength(4);
    const last = asked.at(-1)!.body;
    expect(last).not.toHaveProperty("tools");
    expect(last).toMatchObject({ max_tokens: 800 });
    expect(last.messages).toEqual([
      {
        role: "user",
        content: [
          "tell ada when the launch is",
          CALLS_MADE,
          "Call 1: look with {}\nLaunch is Friday.",
          'Call 2: close with {"issue":42}, which failed\n(The tool answered with nothing.)',
          'Call 3: send with {"to":"ada"}\nSent 1',
        ].join("\n\n"),
      },
    ]);
  });

  it("is only for an answer something waits for: asking a model any other way throws at a tool that asks first", async () => {
    const turn = { type: "message", role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "send", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 1_000, output_tokens: 100 } };
    for (const asking of [() => askModel(bindings, gatewayFor(CLAUDE, "anthropic"), question, 5_000), () => askOnce(bindings, gatewayFor(CLAUDE, "anthropic"), question, AbortSignal.timeout(5_000))]) {
      answering([turn]);
      await expect(asking()).rejects.toThrow("send asks first");
    }
    expect(sent).toEqual([]);
  });
});

/** What a tool answered a call, as Claude is told it, and whether it failed. */
interface Result {
  content: string;
  is_error?: boolean;
}

/**
 * What the room's tools answer `calls`, which Claude makes in the first turn of its answer to a question
 * asked in `room`, or in the thread under `under`, with the question.
 */
async function called(client: Client, room: RoomId, calls: Call[], under?: Message): Promise<{ results: Result[]; question: Message }> {
  asked.length = 0;
  script = [{ calls }, { text: "Done." }];
  const { question } = await ask(client, room, EMBER, undefined, under);
  return { results: (answers()[1]!.body.messages!.at(-1) as { content: Result[] }).content, question };
}

/** What each of `results` says, and whether it failed. */
const said = (results: Result[]) => results.map(({ content, is_error }) => [content, is_error === true]);

/** Someone called `name` joins with the join link as a member, signed in, with the email address `emailAddress`. */
async function join(name: string, emailAddress: string): Promise<Session> {
  const [{ join_code: joinCode }] = (await workspaceSql("SELECT join_code FROM accounts")) as [{ join_code: string }];
  const response = await api(`/api/join/${joinCode}`, { method: "POST", body: JSON.stringify({ name, emailAddress, password: "nanoseconds" }) });
  expect(response.status, await response.clone().text()).toBe(201);
  return { user: shown(((await response.json()) as { user: Me }).user), cookie: cookieOf(response) };
}

/** How the room's tools write `message`, a message of Ada's in the room or a reply in a thread they're reading. */
const adasLine = (message: Message) => `[${whenOf(message)}, id ${message.id}] Ada Lovelace: ${message.plainText}`;

describe("The room's search", () => {
  /** What the search answers Claude's call for `words` in an answer to a question asked in `room`. */
  async function searching(client: Client, room: RoomId, words: string): Promise<{ found: string; question: Message }> {
    const { results, question } = await called(client, room, [words]);
    return { found: results[0]!.content, question };
  }

  it("finds only the room's own messages, newest first, in its threads too, each with its id and its thread", async () => {
    const { ada, general, inGeneral } = await setUp(CLAUDE);
    const elsewhere = await createRoom("elsewhere");
    const inElsewhere = await connect(elsewhere.id, ada);
    await post(inElsewhere, "<p>The launch is a secret here.</p>");
    await caughtUp(elsewhere.id);
    const first = await post(inGeneral, "<p>The launch moved to March 3.</p>");
    const reply = await replyTo(inGeneral, first, "<p>Is the launch party on too?</p>");
    await moveOn(inGeneral);

    const { found } = await searching(inGeneral, general, "launch");
    expect(found.split("\n\n")).toEqual([
      "All 2 messages with those words, newest first:",
      `[${whenOf(reply)}, id ${reply.id}, a reply in the thread under ${first.id}] Ada Lovelace: Is the launch party on too?`,
      `[${whenOf(first)}, id ${first.id}, 1 reply in its thread] Ada Lovelace: The launch moved to March 3.`,
    ]);
  });

  it("finds what someone wrote, by their name as the conversation has it, with words or without, of everyone with that name", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    const [grace, namesake] = [await join("Grace Hopper", "grace@example.com"), await join("Grace Hopper", "hopper@example.com")];
    const launch = await post(await connect(general, grace), "<p>The launch moved to March 3.</p>");
    const lunch = await post(await connect(general, namesake), "<p>Lunch is at noon.</p>");
    await post(inGeneral, "<p>The launch party is at five.</p>");
    await moveOn(inGeneral);

    const { results } = await called(inGeneral, general, [
      { name: "search_messages", input: { from: "grace hopper" } },
      { name: "search_messages", input: { from: "Grace Hopper", words: "launch" } },
      { name: "search_messages", input: { from: "Ada Lovelace", words: "kumquat" } },
      { name: "search_messages", input: { from: "Nobody Here" } },
      { name: "search_messages", input: { from: " " } },
    ]);
    const line = ({ id, plainText, ...message }: Message) => `[${whenOf(message)}, id ${id}] Grace Hopper: ${plainText}`;
    expect(said(results)).toEqual([
      [["All 2 messages from grace hopper, newest first:", line(lunch), line(launch)].join("\n\n"), false],
      [`The only message from Grace Hopper with those words:\n\n${line(launch)}`, false],
      ["No message in this room from anyone named Ada Lovelace has those words.", false],
      ["No message in this room is from anyone named Nobody Here.", false],
      ["Give `from` as the name of whoever wrote the messages, as the conversation names them.", true],
    ]);
  });

  /** Renames whoever `session` is `name`, which the messages they wrote before don't take. */
  async function rename(session: Session, name: string): Promise<void> {
    const renamed = await api("/api/users/me/profile", { method: "PATCH", headers: as(session), body: JSON.stringify({ name }) });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
  }

  /** How the room's tools write `message`, written by someone then called `name`, as a search finds it. */
  const foundAs = (name: string, { id, plainText, ...message }: Message) => `[${whenOf(message)}, id ${id}] ${name}: ${plainText}`;

  it("finds what someone wrote by the name the conversation gives them, though they've changed it since", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    const grace = await join("Grace Hopper", "grace@example.com");
    const inGraces = await connect(general, grace);
    const launch = await post(inGraces, "<p>The launch moved to March 3.</p>");
    await moveOn(inGeneral);
    await post(inGraces, "<p>Lunch is at noon.</p>");
    await rename(grace, "Amazing Grace");

    const { results } = await called(inGeneral, general, [{ name: "search_messages", input: { from: "Grace Hopper" } }]);
    expect(said(results)).toEqual([[`The only message from Grace Hopper:\n\n${foundAs("Grace Hopper", launch)}`, false]]);
  });

  it("finds what someone wrote by a name a read gave them, though they've changed it since, and what whoever has it now wrote", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    const grace = await join("Grace Hopper", "grace@example.com");
    const launch = await post(await connect(general, grace), "<p>The launch moved to March 3.</p>");
    await rename(grace, "Amazing Grace");
    const namesake = await join("Grace Hopper", "hopper@example.com");
    const tea = await post(await connect(general, namesake), "<p>Tea is at four.</p>");
    await moveOn(inGeneral);

    const { results } = await called(inGeneral, general, [
      { name: "search_messages", input: { from: "Grace Hopper" } },
      { name: "read_room", input: {} },
      { name: "search_messages", input: { from: "grace hopper" } },
      { name: "search_messages", input: { from: "Amazing Grace" } },
    ]);
    const [before, read, after, now] = said(results);
    expect(before).toEqual([`The only message from Grace Hopper:\n\n${foundAs("Grace Hopper", tea)}`, false]);
    expect(read![0]).toContain(foundAs("Grace Hopper", launch));
    expect(after).toEqual([["All 2 messages from grace hopper, newest first:", foundAs("Grace Hopper", tea), foundAs("Grace Hopper", launch)].join("\n\n"), false]);
    expect(now).toEqual([`The only message from Amazing Grace:\n\n${foundAs("Grace Hopper", launch)}`, false]);
  });

  it("leaves out the messages the model was given with the question, however many match, and finds what was written before them", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    await post(inGeneral, "<p>The launch moved to March 3.</p>");
    for (let n = 1; n < ROOM_MESSAGES_READ; n++) await post(inGeneral, `<p>Is the launch still on? Asking for the ${n}th time.</p>`);

    const { found } = await searching(inGeneral, general, "launch");
    expect(found).toMatch(/^The only message with those words:\n\n\[.+\] Ada Lovelace: The launch moved to March 3\.$/);
  });

  it("says so when only the messages the model was given match", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    await post(inGeneral, "<p>The launch moved to March 3.</p>");

    const { found } = await searching(inGeneral, general, "launch");
    expect(found).toBe("No message in this room has those words, but for those of the conversation you were given.");
    expect((await searching(inGeneral, general, "kumquat")).found).toBe("No message in this room has those words.");
  });

  it("leaves out a thread's messages when it's asked in the thread, but not the room's", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    const first = await post(inGeneral, "<p>The launch moved to March 3.</p>");
    await post(inGeneral, "<p>The launch party is at noon.</p>");
    await caughtUp(general);
    asked.length = 0;
    script = [{ calls: ["launch"] }, { text: "Done." }];
    const mention = `<action-text-attachment sgid="${mentionSgid(EMBER.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>`;
    inGeneral.send({ type: "message.create", clientMessageId: crypto.randomUUID(), body: `<p>${mention} when is the launch?</p>`, parentId: first.id });
    for (;;) if ((await inGeneral.next("message.created")).message.creator.id === EMBER.id) break;

    const results = (answers()[1]!.body.messages!.at(-1) as { content: Array<{ content: string }> }).content;
    expect(results[0]!.content).toMatch(/^The only message with those words:\n\n\[.+\] Ada Lovelace: The launch party is at noon\.$/);
  });

  it("answers the newest of many matches, saying there are more, and the start of a long one", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    for (let n = 1; n <= MESSAGES_FOUND + 2; n++) await post(inGeneral, `<p>Kumquat count ${n}</p>`);
    await post(inGeneral, `<p>Kumquat ${"very ".repeat(200)}long</p>`);
    await moveOn(inGeneral);

    const { found } = await searching(inGeneral, general, "kumquat");
    const [count, long, ...rest] = found.split("\n\n");
    expect(count).toBe(`The newest ${MESSAGES_FOUND} messages with those words, of more:`);
    expect(long!.endsWith("…")).toBe(true);
    expect(long!.slice(long!.indexOf("Kumquat")).length).toBe(MAX_FOUND_LENGTH);
    expect(rest.map((line) => line.split(": ")[1])).toEqual(Array.from({ length: MESSAGES_FOUND - 1 }, (_, index) => `Kumquat count ${MESSAGES_FOUND + 2 - index}`));
  });

  it("tells the model what it needs when it's called without words or a name", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    const { found } = await searching(inGeneral, general, " ?! ");
    expect(found).toBe("Give the words to find, as `words`, or the name of whoever wrote the messages, as `from`.");
  });
});

describe("Reading the room", () => {
  it("reads back from the question, what the model was given too, a page at a time to the room's start", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    const launch = await post(inGeneral, "<p>The launch moved to March 3.</p>");
    await replyTo(inGeneral, launch, "<p>Is the party on too?</p>");
    const onwards: Message[] = [];
    for (let n = 1; n <= HISTORY_PAGE_SIZE; n++) onwards.push(await post(inGeneral, `<p>Onwards ${n}</p>`));

    const { results } = await called(inGeneral, general, [
      { name: "read_room", input: {} },
      { name: "read_room", input: { before: onwards[0]!.id } },
    ]);
    expect(said(results)).toEqual([
      [[`The room's ${HISTORY_PAGE_SIZE} messages before the message you're asked, oldest first:`, ...onwards.map(adasLine), `To read further back, call read_room with \`before\` set to ${onwards[0]!.id}.`].join("\n\n"), false],
      [[`The room's 1 message before message ${onwards[0]!.id}, oldest first:`, `[${whenOf(launch)}, id ${launch.id}, 1 reply in its thread] Ada Lovelace: The launch moved to March 3.`, "That's the start of the room."].join("\n\n"), false],
    ]);
  });

  it("reads on after a message it names, to the room's newest, and tells the model what it needs when it names none the room has", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    const [first, second] = [await post(inGeneral, "<p>First</p>"), await post(inGeneral, "<p>Second</p>")];

    const { results, question } = await called(inGeneral, general, [
      { name: "read_room", input: { after: first.id } },
      { name: "read_room", input: { before: "nothing-here" } },
      { name: "read_room", input: { before: second.id, after: first.id } },
      { name: "read_room", input: { after: 3 } },
    ]);
    expect(said(results)).toEqual([
      [[`The room's 2 messages after message ${first.id}, oldest first:`, adasLine(second), adasLine(question), "That's the room's newest message."].join("\n\n"), false],
      ["The room has no message with that id.", true],
      ["Give `before` or `after`, not both.", true],
      ["Give `after` as a message's id.", true],
    ]);
  });
});

describe("Reading a thread", () => {
  it("reads the thread it's asked in, the message it's under first, then its newest replies, older ones a page at a time, and the room before it", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    const before = await post(inGeneral, "<p>What led to it</p>");
    const launch = await post(inGeneral, "<p>The launch moved to March 3.</p>");
    const replies: Message[] = [];
    for (let n = 1; n <= HISTORY_PAGE_SIZE; n++) replies.push(await replyTo(inGeneral, launch, `<p>Reply ${n}</p>`));

    const calls = [
      { name: "read_thread", input: {} },
      { name: "read_thread", input: { message_id: replies[5]!.id, before: replies[1]!.id } },
      { name: "read_room", input: {} },
    ];
    const { results, question } = await called(inGeneral, general, calls, launch);
    expect(said(results)).toEqual([
      [
        [
          `The thread under message ${launch.id}: the message, then its newest ${HISTORY_PAGE_SIZE} replies, oldest first:`,
          `[${whenOf(launch)}, id ${launch.id}, ${HISTORY_PAGE_SIZE + 1} replies in its thread] Ada Lovelace: The launch moved to March 3.`,
          ...[...replies.slice(1), question].map(adasLine),
          `To read older replies, call read_thread with \`message_id\` set to ${launch.id} and \`before\` set to ${replies[1]!.id}.`,
        ].join("\n\n"),
        false,
      ],
      [`The reply before reply ${replies[1]!.id} in the thread under message ${launch.id}, oldest first:\n\n${adasLine(replies[0]!)}`, false],
      [["The room's 1 message before the thread you're asked in, oldest first:", adasLine(before), "That's the start of the room."].join("\n\n"), false],
    ]);
  });

  it("reads the thread of a message it names, or of a reply in it, and tells the model when there's none to read", async () => {
    const { general, inGeneral } = await setUp(CLAUDE);
    const launch = await post(inGeneral, "<p>The launch moved to March 3.</p>");
    const [party, cake] = [await replyTo(inGeneral, launch, "<p>Is the party on?</p>"), await replyTo(inGeneral, launch, "<p>With cake.</p>")];
    const quiet = await post(inGeneral, "<p>Nobody answered this.</p>");

    const { results } = await called(inGeneral, general, [
      { name: "read_thread", input: { message_id: launch.id } },
      { name: "read_thread", input: { message_id: cake.id } },
      { name: "read_thread", input: { message_id: quiet.id } },
      { name: "read_thread", input: {} },
      { name: "read_thread", input: { message_id: "nothing-here" } },
      { name: "read_thread", input: { message_id: launch.id, before: quiet.id } },
    ]);
    const thread = [
      `The thread under message ${launch.id}: the message, then all 2 of its replies, oldest first:`,
      `[${whenOf(launch)}, id ${launch.id}, 2 replies in its thread] Ada Lovelace: The launch moved to March 3.`,
      adasLine(party),
      adasLine(cake),
    ].join("\n\n");
    expect(said(results)).toEqual([
      [thread, false],
      [thread, false],
      [`Message ${quiet.id} has no replies:\n\n${adasLine(quiet)}`, false],
      ["You weren't asked in a thread, so give the id of the message whose thread to read, as `message_id`.", true],
      ["The room has no message with that id.", true],
      [`The thread under message ${launch.id} has no reply with the id given as \`before\`.`, true],
    ]);
  });
});

describe("What an answer's calls read of the room", () => {
  const AT = "2026-10-31T12:00:00.000Z";
  /** A message as a room has it, of Ada's, written at noon. */
  const message = (id: string, plainText: string, changes: Partial<Message> = {}): Message => ({
    id,
    clientMessageId: id,
    roomId: "room",
    creator: { id: "ada", name: "Ada Lovelace" },
    body: `<p>${plainText}</p>`,
    plainText,
    mentions: [],
    createdAt: AT,
    updatedAt: AT,
    editedAt: null,
    boosts: [],
    ...changes,
  });
  /** How the tools write `message`, or a reply in the thread they read, with what else they say of it. */
  const lineOf = ({ id, plainText }: Message, ...facts: string[]) => `[2026-10-31 12:00 UTC, ${[`id ${id}`, ...facts].join(", ")}] Ada Lovelace: ${plainText}`;
  /** A room whose messages are `messages`, oldest first, with one thread, of `replies`, as the tools read it. */
  const roomOf = (messages: Message[], replies: Message[] = []): RoomReader => ({
    page: async ({ before }) => {
      const end = messages.findIndex(({ id }) => id === before);
      return end < 0 ? null : { messages: messages.slice(Math.max(0, end - HISTORY_PAGE_SIZE), end), hasMore: end > HISTORY_PAGE_SIZE, hasNewer: true };
    },
    find: async (id) => [...messages, ...replies].find((message) => message.id === id) ?? null,
    replies: async () => ({ messages: replies, hasMore: false }),
  });
  /** The tool called `name` that reads `reader`'s room, `roomId`, for an answer to `question` whose calls have `read` what they have. */
  const toolIn = (reader: RoomReader, question: Message, read: RoomRead, name: string, roomId: RoomId = "room") =>
    roomTools({ env: bindings, roomId, askerId: "ada", question, given: [question], reader, read }).find(({ tool }) => tool.name === name)!.tool;
  /** What an answer's calls have read when they may read `left` more characters, and have read nothing yet. */
  const leaving = (left: number): RoomRead => ({ left, writers: [] });
  /** What a tool said, kept out of AI Gateway's logs or not. */
  const textOf = (said: string | Unlogged) => (typeof said === "string" ? said : said.text);

  it("is as much as it has left to read, the messages nearest where each read starts, after which its model is told it has read enough", async () => {
    const messages = Array.from({ length: 5 }, (_, n) => message(`m${n}`, `Message ${n}`, n === 2 ? { creator: { id: "grace", name: "Grace Hopper" } } : {}));
    const roomRead = leaving(lineOf(messages[2]!).length + lineOf(messages[3]!).length + 1);
    const read = toolIn(roomOf(messages), messages[4]!, roomRead, "read_room");

    expect(textOf(await read.run({})).split("\n\n")).toEqual([
      "The room's 2 messages before the message you're asked, oldest first:",
      lineOf(messages[2]!).replace("Ada Lovelace", "Grace Hopper"),
      lineOf(messages[3]!),
      "To read further back, call read_room with `before` set to m2.",
    ]);
    // Who wrote what it read, by the names it read, once each, nearest first.
    expect(roomRead).toEqual({ left: 1, writers: [{ id: "ada", name: "Ada Lovelace" }, { id: "grace", name: "Grace Hopper" }] });
    await expect(read.run({ before: "m2" })).rejects.toThrow(READ_ENOUGH);
    expect(roomRead.left).toBe(1);
  });

  it("reads the message a thread is under only with a reply, and each message only so far", async () => {
    const launch = message("m0", "The launch moved to March 3.", { thread: { count: 1, latestAt: AT, people: [] } });
    const reply = message("r0", `Is the party on? ${"Yes ".repeat(MAX_READ_LENGTH)}`, { parentId: "m0" });
    const question = message("m1", "@Ember what did they say?");
    const shown = `${reply.plainText.slice(0, MAX_READ_LENGTH - 1).trimEnd()}…`;
    const [head, rest] = [lineOf(launch, "1 reply in its thread"), lineOf({ ...reply, plainText: shown })];
    const roomRead = leaving(head.length + rest.length - 1);
    const read = toolIn(roomOf([launch, question], [reply]), question, roomRead, "read_thread");

    await expect(read.run({ message_id: "r0" })).rejects.toThrow(READ_ENOUGH);
    expect(roomRead).toEqual(leaving(head.length + rest.length - 1));
    roomRead.left += 1;
    expect(textOf(await read.run({ message_id: "r0" }))).toBe(["The thread under message m0: the message, then its only reply, oldest first:", head, rest].join("\n\n"));
    expect(roomRead.left).toBe(0);
  });

  it("is kept out of AI Gateway's logs once the room is private, or gone, as what it was asked in the open isn't", async () => {
    const { ada, general } = await setUp(CLAUDE);
    const leads = (await createRoom("Leads", { closedTo: [ada.user.id], as: ada })).id;
    const messages = [message("m0", "The budget is forty thousand."), message("m1", "@Ember what's the budget?")];
    const readIn = (roomId: RoomId) => toolIn(roomOf(messages), messages[1]!, leaving(1_000), "read_room", roomId).run({});

    const text = ["The room's 1 message before the message you're asked, oldest first:", lineOf(messages[0]!), "That's the start of the room."].join("\n\n");
    expect(await readIn(general)).toBe(text);
    expect(await readIn(leads)).toEqual({ text, unlogged: true });
    expect(await readIn("gone")).toEqual({ text, unlogged: true });
  });
});

describe("What a model's calls come to", () => {
  const echo: EmberTool = { name: "echo", description: "Says it back.", takes: { type: "object" }, run: async ({ said }) => `You said ${String(said)}` };
  const broken: EmberTool = {
    name: "broken",
    description: "Fails.",
    takes: { type: "object" },
    run: async ({ how }) => {
      throw how === "politely" ? new ToolError("Not that way.") : new TypeError("secret detail");
    },
  };

  it("tells the model of a tool that isn't there, of what isn't an object, why a tool couldn't, and only that one failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = [
      { id: "1", name: "echo", input: '{"said":"hi"}' },
      { id: "2", name: "echo", input: { said: "ho" } },
      { id: "3", name: "echo", input: "" },
      { id: "4", name: "nothing", input: "{}" },
      { id: "5", name: "echo", input: "[1]" },
      { id: "6", name: "echo", input: '{"said":' },
      { id: "7", name: "broken", input: { how: "politely" } },
      { id: "8", name: "broken", input: {} },
    ];
    expect((await resultsOf([echo, broken], calls, calls.length)).results).toEqual([
      { id: "1", text: "You said hi", failed: false },
      { id: "2", text: "You said ho", failed: false },
      { id: "3", text: "You said undefined", failed: false },
      { id: "4", text: "There's no tool called nothing.", failed: true },
      { id: "5", text: "echo takes a JSON object.", failed: true },
      { id: "6", text: "echo takes a JSON object.", failed: true },
      { id: "7", text: "Not that way.", failed: true },
      { id: "8", text: "broken failed. Answer without it.", failed: true },
    ]);
    expect(await resultsOf([echo], calls.slice(0, 2), 1)).toEqual({
      results: [
        { id: "1", text: "You said hi", failed: false },
        { id: "2", text: NO_CALLS_LEFT, failed: true },
      ],
    });
  });

  it("stops at a call of a tool that asks first, goes on from there once it's decided, and runs it only when it's allowed", async () => {
    const sent: unknown[] = [];
    const send: EmberTool = { name: "send", description: "Sends it.", takes: { type: "object" }, asksFirst: true, run: async (input) => `Sent ${sent.push(input)}` };
    const calls = [
      { id: "1", name: "echo", input: { said: "hi" } },
      { id: "2", name: "send", input: '{"to":"ada"}' },
      { id: "3", name: "send", input: "[1]" },
      { id: "4", name: "send", input: {} },
      { id: "5", name: "echo", input: { said: "ho" } },
    ];
    const first = await resultsOf([echo, send], calls, 4);
    expect(first).toEqual({ results: [{ id: "1", text: "You said hi", failed: false }], asks: { id: "2", name: "send", input: { to: "ada" } } });
    expect(sent).toEqual([]);

    // Allowed, it runs with what it was called with. One called with what it can't take never asks.
    const allowed = await decided([echo, send], calls[1]!, true);
    expect(allowed).toEqual({ id: "2", text: "Sent 1", failed: false });
    expect(sent).toEqual([{ to: "ada" }]);
    const second = await resultsOf([echo, send], calls, 4, [...first.results, allowed]);
    expect(second.results.slice(2)).toEqual([{ id: "3", text: "send takes a JSON object.", failed: true }]);
    expect(second.asks).toEqual({ id: "4", name: "send", input: {} });

    // Not allowed, it doesn't run, and neither does one whose tool is gone by then, or one past what the answer may call.
    expect(await decided([echo, send], calls[3]!, false)).toEqual({ id: "4", text: CALL_DECLINED, failed: true });
    expect(await decided([echo], calls[3]!, true)).toEqual({ id: "4", text: "There's no tool called send any more.", failed: true });
    expect(sent).toHaveLength(1);
    const last = await resultsOf([echo, send], calls, 4, [...second.results, { id: "4", text: CALL_DECLINED, failed: true }]);
    expect(last).toEqual({ results: [...second.results, { id: "4", text: CALL_DECLINED, failed: true }, { id: "5", text: NO_CALLS_LEFT, failed: true }] });
    expect(await resultsOf([send], [calls[3]!], 0)).toEqual({ results: [{ id: "4", text: NO_CALLS_LEFT, failed: true }] });
  });

  it("reads no call in an answer that was cut short, or that calls only its provider's tools", () => {
    const use = { type: "tool_use", id: "toolu_1", name: "echo", input: {} };
    expect(toolCallsIn("anthropic", { content: [use], stop_reason: "tool_use" })).toEqual([{ id: "toolu_1", name: "echo", input: {} }]);
    expect(toolCallsIn("anthropic", { content: [use], stop_reason: "max_tokens" })).toEqual([]);
    expect(toolCallsIn("anthropic", { content: [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }], stop_reason: "tool_use" })).toEqual([]);
    const call = { type: "function_call", call_id: "call_1", name: "echo", arguments: "{}" };
    expect(toolCallsIn("openai", { status: "completed", output: [{ type: "web_search_call", id: "ws_1" }, call] })).toEqual([{ id: "call_1", name: "echo", input: "{}" }]);
    expect(toolCallsIn("xai", { status: "incomplete", output: [call] })).toEqual([]);
    const message = { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "echo", arguments: "{}" } }] };
    expect(toolCallsIn("chat", { choices: [{ message, finish_reason: "tool_calls" }] })).toEqual([{ id: "call_1", name: "echo", input: "{}" }]);
    expect(toolCallsIn("chat", { choices: [{ message, finish_reason: "length" }] })).toEqual([]);
    expect(toolCallsIn("chat", null)).toEqual([]);
  });

  it("writes tools, what a call came to and the room left as each format has them", () => {
    const formats: ModelFormat[] = ["anthropic", "messages", "openai", "responses", "xai", "chat"];
    expect(formats.map((format) => Object.keys(toolsIn(format, [echo])[0]!))).toEqual([
      ["name", "description", "input_schema"],
      ["name", "description", "input_schema"],
      ["type", "name", "description", "parameters"],
      ["type", "name", "description", "parameters"],
      ["type", "name", "description", "parameters"],
      ["type", "function"],
    ]);
    const failed = [{ id: "toolu_1", text: "Not that way.", failed: true }];
    expect(goingOn("anthropic", { messages: [] }, { content: [] }, failed)).toEqual({
      messages: [
        { role: "assistant", content: [] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Not that way.", is_error: true }] },
      ],
    });
    expect(withRoom("anthropic", {}, 500, true)).toEqual({ max_tokens: 500, tool_choice: { type: "none" } });
    expect(withRoom("xai", {}, 500, true)).toEqual({ max_output_tokens: 500, tool_choice: "none" });
    expect(withRoom("chat", { model: "m" }, 500, false)).toEqual({ model: "m", max_completion_tokens: 500 });
  });
});
