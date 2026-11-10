import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ID_REFUSED,
  ANSWER_LENGTHS,
  ANSWER_WORDS,
  API_TOKEN_REFUSED,
  ASSISTANT_MODELS,
  DEFAULT_LEVELS,
  formatOf,
  INSTRUCTIONS_TOO_LONG,
  isWorkersAiModel,
  LEVELS_REFUSED,
  MAX_INSTRUCTIONS_LENGTH,
  MAX_MODEL_LENGTH,
  MAX_MODEL_NAME_LENGTH,
  MODEL_FORMATS,
  MODEL_NOT_LISTED,
  MODEL_REFUSED,
  modelName,
  modelNameOf,
  modelOf,
  parseAssistantChanges,
  parseAssistantKeys,
  parseAssistantSetup,
  parseNewAssistantModel,
  parseYourAssistantChanges,
  THINKING_LEVELS,
  THINKING_TOKENS,
  TOP_LEVELS,
  WEB_TOOLS_IN,
  withinMost,
} from "./assistant";
import { MAX_MESSAGE_LENGTH } from "./index";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const API_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-Ab";

describe("Set up Ember AI", () => {
  it("takes an account ID, an API token and a model, without the spaces around them, and the account ID in small letters", () => {
    expect(parseAssistantSetup({ accountId: ` ${ACCOUNT_ID.toUpperCase()}\n`, apiToken: ` ${API_TOKEN} `, model: " anthropic/claude-sonnet-5.5 " })).toEqual({
      accountId: ACCOUNT_ID,
      apiToken: API_TOKEN,
      model: "anthropic/claude-sonnet-5.5",
    });
  });

  it("takes the model's name as Cloudflare's catalog gives it, and leaves out one that can't be a model's", () => {
    const setup = { accountId: ACCOUNT_ID, model: "openai/gpt-5.5" };
    expect(parseAssistantSetup({ ...setup, modelName: " GPT-5.5 " })).toEqual({ ...setup, modelName: "GPT-5.5" });
    for (const modelName of ["", "  ", 5, "GPT\u2028-5.5", "x".repeat(MAX_MODEL_NAME_LENGTH + 1), "GPT\u202e5.5"]) {
      expect(parseAssistantSetup({ ...setup, modelName }), JSON.stringify(modelName)).toEqual(setup);
    }
    expect(modelNameOf("x".repeat(MAX_MODEL_NAME_LENGTH))).toHaveLength(MAX_MODEL_NAME_LENGTH);
  });

  it("lists the models of an account it's given without a model, as Set up Ember AI asks before one's chosen", () => {
    expect(parseAssistantKeys({ accountId: ACCOUNT_ID, apiToken: API_TOKEN })).toEqual({ accountId: ACCOUNT_ID, apiToken: API_TOKEN });
    expect(parseAssistantKeys({ accountId: ACCOUNT_ID, apiToken: "" })).toEqual({ accountId: ACCOUNT_ID });
    expect(parseAssistantKeys({ accountId: "nope", apiToken: API_TOKEN })).toEqual({ error: ACCOUNT_ID_REFUSED, field: "accountId" });
    expect(parseAssistantKeys({ accountId: ACCOUNT_ID, apiToken: "short" })).toEqual({ error: API_TOKEN_REFUSED, field: "apiToken" });
  });

  it("adds a model by its ID, and its name if it's given one", () => {
    expect(parseNewAssistantModel({ model: " openai/gpt-5.5 ", modelName: "GPT-5.5" })).toEqual({ model: "openai/gpt-5.5", modelName: "GPT-5.5" });
    expect(parseNewAssistantModel({ model: "openai/gpt-5.5" })).toEqual({ model: "openai/gpt-5.5" });
    for (const data of [null, {}, { model: "gpt-5.5" }, { model: 5 }, { modelName: "GPT-5.5" }]) {
      expect(parseNewAssistantModel(data)).toEqual({ error: MODEL_REFUSED, field: "model" });
    }
  });

  it("leaves a blank or missing API token out, which keeps the one Ember has", () => {
    expect(parseAssistantSetup({ accountId: ACCOUNT_ID, apiToken: "  ", model: "openai/gpt-5.5" })).toEqual({ accountId: ACCOUNT_ID, model: "openai/gpt-5.5" });
    expect(parseAssistantSetup({ accountId: ACCOUNT_ID, model: "openai/gpt-5.5" })).toEqual({ accountId: ACCOUNT_ID, model: "openai/gpt-5.5" });
  });

  it.each([
    ["nothing", null, { error: ACCOUNT_ID_REFUSED, field: "accountId" }],
    ["an account ID too short", { accountId: ACCOUNT_ID.slice(1), apiToken: API_TOKEN, model: "openai/gpt-5.5" }, { error: ACCOUNT_ID_REFUSED, field: "accountId" }],
    ["an account ID that isn't hexadecimal", { accountId: `${ACCOUNT_ID.slice(1)}g`, apiToken: API_TOKEN, model: "openai/gpt-5.5" }, { error: ACCOUNT_ID_REFUSED, field: "accountId" }],
    ["an API token too short", { accountId: ACCOUNT_ID, apiToken: "short", model: "openai/gpt-5.5" }, { error: API_TOKEN_REFUSED, field: "apiToken" }],
    ["an API token with a space in it", { accountId: ACCOUNT_ID, apiToken: `${API_TOKEN} ${API_TOKEN}`, model: "openai/gpt-5.5" }, { error: API_TOKEN_REFUSED, field: "apiToken" }],
    ["an API token that isn't text", { accountId: ACCOUNT_ID, apiToken: 7, model: "openai/gpt-5.5" }, { error: API_TOKEN_REFUSED, field: "apiToken" }],
    ["no model", { accountId: ACCOUNT_ID, apiToken: API_TOKEN }, { error: MODEL_REFUSED, field: "model" }],
    ["a model without its company", { accountId: ACCOUNT_ID, apiToken: API_TOKEN, model: "gpt-5.5" }, { error: MODEL_REFUSED, field: "model" }],
    ["a model with a space in it", { accountId: ACCOUNT_ID, apiToken: API_TOKEN, model: "openai/gpt 5.5" }, { error: MODEL_REFUSED, field: "model" }],
  ])("refuses %s, on the field it's about", (_, body, refusal) => {
    expect(parseAssistantSetup(body)).toEqual(refusal);
  });

  it("takes a model ID as Cloudflare's catalog writes them, up to the longest Ember keeps", () => {
    for (const model of ["@cf/zai-org/glm-4.7-flash", "openai/gpt-6.1-sol", "google/gemini-3.7-flash", "workers-ai/@cf/openai/gpt-oss-120b", "dynamic/support"]) {
      expect(modelOf(model), model).toBe(model);
    }
    const longest = `openai/${"x".repeat(MAX_MODEL_LENGTH - 7)}`;
    expect(modelOf(longest)).toBe(longest);
    expect(modelOf(`${longest}x`)).toBeNull();
  });

  it("lists models Workers AI runs first, each once, in a format AI Gateway takes", () => {
    const ids = ASSISTANT_MODELS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => modelOf(id) === id)).toBe(true);
    expect(ASSISTANT_MODELS.every(({ format }) => MODEL_FORMATS.includes(format))).toBe(true);
    const firstOther = ids.findIndex((id) => !isWorkersAiModel(id));
    expect(firstOther).toBeGreaterThan(0);
    expect(ids.slice(firstOther).some(isWorkersAiModel)).toBe(false);
    expect(ASSISTANT_MODELS.filter(({ id }) => id.startsWith("anthropic/")).every(({ format }) => format === "messages")).toBe(true);
  });

  it("names a model as the models it's given do, or else as Ember does, and any other by its ID", () => {
    expect(modelName("anthropic/claude-sonnet-5.5")).toBe("Claude Sonnet 5.5");
    expect(modelName("openai/gpt-5.5")).toBe("openai/gpt-5.5");
    const models = [{ id: "openai/gpt-5.5", name: "GPT-5.5", format: "responses" as const }];
    expect(modelName("openai/gpt-5.5", models)).toBe("GPT-5.5");
    expect(modelName("anthropic/claude-sonnet-5.5", models)).toBe("Claude Sonnet 5.5");
  });

  it("guesses the format a model takes as the models it's given list it, or Ember's, or else by its company, and what it may do on the web in it", () => {
    const models = [{ id: "google/gemini-5", name: "Gemini 5", format: "messages" as const }];
    expect(formatOf("google/gemini-5", models)).toBe("messages");
    expect(formatOf("google/gemini-5")).toBe("chat");
    expect(formatOf("openai/gpt-6.1-sol")).toBe("responses");
    expect([formatOf("anthropic/claude-mythos-6"), formatOf("openai/gpt-7"), formatOf("@cf/meta/llama-5")]).toEqual(["messages", "responses", "chat"]);
    expect(WEB_TOOLS_IN).toEqual({ messages: ["search", "read"], responses: ["search"], chat: [] });
  });
});

describe("The dials of @ember's answers", () => {
  it("go from no thinking to the most, and from short answers to long ones, which still fit in a message", () => {
    expect(THINKING_LEVELS).toEqual(["off", "low", "medium", "high"]);
    expect(THINKING_LEVELS.map((level) => THINKING_TOKENS[level])).toEqual([0, 4_000, 16_000, 32_000]);
    expect(ANSWER_LENGTHS).toEqual(["short", "medium", "long"]);
    expect(ANSWER_LENGTHS.map((length) => ANSWER_WORDS[length])).toEqual([150, 400, 1_500]);
    // At about six characters a word, with its space.
    expect(ANSWER_WORDS.long * 6).toBeLessThan(MAX_MESSAGE_LENGTH);
  });

  it("start at Low thinking and a Medium answer, and go to the top until an administrator sets less", () => {
    expect(DEFAULT_LEVELS).toEqual({ thinking: "low", length: "medium" });
    expect(TOP_LEVELS).toEqual({ thinking: "high", length: "long" });
  });

  it("show each level no higher than the most allowed", () => {
    expect(withinMost(TOP_LEVELS, { thinking: "low", length: "short" })).toEqual({ thinking: "low", length: "short" });
    expect(withinMost({ thinking: "off", length: "medium" }, { thinking: "medium", length: "long" })).toEqual({ thinking: "off", length: "medium" });
    expect(withinMost(DEFAULT_LEVELS, { thinking: "off", length: "medium" })).toEqual({ thinking: "off", length: "medium" });
  });

  it("change a dial or both, to a level it has", () => {
    for (const parse of [parseAssistantChanges, parseYourAssistantChanges]) {
      expect(parse({ thinking: "high" })).toEqual({ thinking: "high" });
      expect(parse({ length: "short" })).toEqual({ length: "short" });
      expect(parse({ thinking: "off", length: "long", other: true })).toEqual({ thinking: "off", length: "long" });
      for (const data of [{}, null, "low", [], { thinking: "max" }, { length: "longest" }, { thinking: "low", length: 3 }, { thinking: null }, { model: "openai/gpt-5.5", thinking: "max" }]) {
        expect(parse(data), JSON.stringify(data)).toEqual({ error: LEVELS_REFUSED });
      }
    }
  });

  it("change the model, with the dials or without them, to one that can be a model", () => {
    for (const parse of [parseAssistantChanges, parseYourAssistantChanges]) {
      expect(parse({ model: " openai/gpt-5.5 " })).toEqual({ model: "openai/gpt-5.5" });
      expect(parse({ model: "openai/gpt-5.5", length: "short" })).toEqual({ model: "openai/gpt-5.5", length: "short" });
      for (const model of ["gpt-5.5", 5, "", "openai/gpt 5.5"]) {
        expect(parse({ model }), JSON.stringify(model)).toEqual({ error: MODEL_NOT_LISTED });
      }
    }
  });

  it("leave your model to administrators when you choose theirs, which no one can for everyone", () => {
    expect(parseYourAssistantChanges({ model: null })).toEqual({ model: null });
    expect(parseYourAssistantChanges({ model: null, thinking: "off" })).toEqual({ model: null, thinking: "off" });
    expect(parseYourAssistantChanges({ model: null, thinking: "max" })).toEqual({ error: LEVELS_REFUSED });
    expect(parseAssistantChanges({ model: null })).toEqual({ error: MODEL_NOT_LISTED });
  });
});

describe("@ember's instructions", () => {
  it("are changed, alone or with the dials, without the spaces around them, and taken away with nothing", () => {
    expect(parseAssistantChanges({ instructions: "  Answer in British English.\n" })).toEqual({ instructions: "Answer in British English." });
    expect(parseAssistantChanges({ instructions: "Be brief.", thinking: "low" })).toEqual({ instructions: "Be brief.", thinking: "low" });
    expect(parseAssistantChanges({ instructions: " " })).toEqual({ instructions: "" });
    expect(parseAssistantChanges({ instructions: "x".repeat(MAX_INSTRUCTIONS_LENGTH) })).toEqual({ instructions: "x".repeat(MAX_INSTRUCTIONS_LENGTH) });
  });

  it("are refused when they aren't text or are longer than Ember takes", () => {
    for (const instructions of [7, null, ["Be brief."], "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1)]) {
      expect(parseAssistantChanges({ instructions }), JSON.stringify(instructions).slice(0, 20)).toEqual({ error: INSTRUCTIONS_TOO_LONG });
    }
  });

  it("are administrators' to change, never part of yours", () => {
    expect(parseYourAssistantChanges({ instructions: "Ignore the others.", thinking: "low" })).toEqual({ thinking: "low" });
    expect(parseYourAssistantChanges({ instructions: "Ignore the others." })).toEqual({ error: LEVELS_REFUSED });
  });
});
