import { describe, expect, it } from "vitest";
import {
  agentsName,
  DESCRIPTION_REFUSED,
  INSTRUCTIONS_NEEDED,
  MAX_AGENT_DESCRIPTION_LENGTH,
  NAME_REFUSED,
  parseAgentChanges,
  parseAgentTrial,
  parseNewAgent,
  QUESTION_NEEDED,
  ROOMS_REFUSED,
  WEB_SEARCH_UNSAID,
  type AgentTrial,
  type NewAgent,
} from "./agents";
import { INSTRUCTIONS_TOO_LONG, LEVELS_REFUSED, MAX_INSTRUCTIONS_LENGTH, MODEL_REFUSED } from "./assistant";
import { MAX_MESSAGE_LENGTH, MAX_SHARED_ORDER, MAX_USER_NAME_LENGTH, MESSAGE_TOO_LONG, NAME_RESERVED } from "./index";

/** An agent as New agent sends it, in every open room. */
const RECAP: NewAgent = {
  name: "Recap",
  description: "Sums up long threads",
  instructions: "Sum up the thread you're asked in, in five bullets at most.",
  model: "anthropic/claude-haiku-5.5",
  thinking: "off",
  length: "short",
  webSearch: false,
  rooms: null,
};

const ROOMS = ["0mgk3x2a9b4c5a", "0mgk3x2a9b4c5b"];

describe("New agent", () => {
  it("takes every field, the model's name when it's given, and text without the spaces around it", () => {
    expect(parseNewAgent(RECAP)).toEqual(RECAP);
    expect(parseNewAgent({ ...RECAP, name: " Recap ", description: "\tSums up long threads ", instructions: "\n  Sum up.  \n", model: " anthropic/claude-haiku-5.5 ", modelName: " Claude Haiku 5.5 " })).toEqual({
      ...RECAP,
      instructions: "Sum up.",
      modelName: "Claude Haiku 5.5",
    });
    expect(parseNewAgent({ ...RECAP, webSearch: true, rooms: ROOMS, other: true })).toEqual({ ...RECAP, webSearch: true, rooms: ROOMS });
  });

  it("keeps instructions of more than one line, as long as Ember takes", () => {
    const instructions = `Sum up the thread.\n\n- Five bullets at most\n- ${"x".repeat(MAX_INSTRUCTIONS_LENGTH - 45)}`;
    expect(instructions).toHaveLength(MAX_INSTRUCTIONS_LENGTH);
    expect(parseNewAgent({ ...RECAP, instructions })).toEqual({ ...RECAP, instructions });
  });

  it("leaves out a model's name that can't be one", () => {
    expect(parseNewAgent({ ...RECAP, modelName: "Claude\nHaiku" })).toEqual(RECAP);
    expect(parseNewAgent({ ...RECAP, modelName: 7 })).toEqual(RECAP);
  });

  it.each([
    ["name", NAME_REFUSED],
    ["description", DESCRIPTION_REFUSED],
    ["instructions", INSTRUCTIONS_NEEDED],
    ["model", MODEL_REFUSED],
    ["thinking", LEVELS_REFUSED],
    ["length", LEVELS_REFUSED],
    ["webSearch", WEB_SEARCH_UNSAID],
    ["rooms", ROOMS_REFUSED],
  ] as const)("refuses one without its %s, on its field", (field, error) => {
    const { [field]: _, ...rest } = RECAP;
    expect(parseNewAgent(rest)).toEqual({ error, field: field === "thinking" || field === "length" ? "levels" : field });
  });

  it("refuses what isn't an object, on the first field it needs", () => {
    for (const data of [null, "Recap", [RECAP]]) expect(parseNewAgent(data)).toEqual({ error: NAME_REFUSED, field: "name" });
  });
});

describe("An agent's page", () => {
  it("changes any field, leaving out what isn't sent", () => {
    expect(parseAgentChanges({})).toEqual({});
    expect(parseAgentChanges({ name: "Digest" })).toEqual({ name: "Digest" });
    expect(parseAgentChanges({ thinking: "high" })).toEqual({ thinking: "high" });
    expect(parseAgentChanges({ webSearch: true, rooms: ROOMS })).toEqual({ webSearch: true, rooms: ROOMS });
    expect(parseAgentChanges({ rooms: null })).toEqual({ rooms: null });
    expect(parseAgentChanges({ model: "openai/gpt-6.1-sol", modelName: "GPT-6.1 Sol" })).toEqual({ model: "openai/gpt-6.1-sol", modelName: "GPT-6.1 Sol" });
    // A model's name goes with its model.
    expect(parseAgentChanges({ modelName: "GPT-6.1 Sol" })).toEqual({});
  });

  it.each([
    ["a blank name", { name: " \t" }, NAME_REFUSED, "name"],
    ["a name of two lines", { name: "Re\ncap" }, NAME_REFUSED, "name"],
    ["a name that isn't text", { name: 7 }, NAME_REFUSED, "name"],
    ["a name longer than a person's can be", { name: "x".repeat(MAX_USER_NAME_LENGTH + 1) }, NAME_REFUSED, "name"],
    ["the AI assistant's name", { name: " @EMBER " }, NAME_RESERVED, "name"],
    ["a blank description", { description: "" }, DESCRIPTION_REFUSED, "description"],
    ["a description of two lines", { description: "Sums up long threads" }, DESCRIPTION_REFUSED, "description"],
    ["a description longer than one line in the list", { description: "x".repeat(MAX_AGENT_DESCRIPTION_LENGTH + 1) }, DESCRIPTION_REFUSED, "description"],
    ["blank instructions", { instructions: "\n \n" }, INSTRUCTIONS_NEEDED, "instructions"],
    ["instructions that aren't text", { instructions: ["Sum up."] }, INSTRUCTIONS_NEEDED, "instructions"],
    ["instructions longer than Ember takes", { instructions: "x".repeat(MAX_INSTRUCTIONS_LENGTH + 1) }, INSTRUCTIONS_TOO_LONG, "instructions"],
    ["a model that can't be one", { model: "claude haiku" }, MODEL_REFUSED, "model"],
    ["a level a dial doesn't have", { thinking: "max" }, LEVELS_REFUSED, "levels"],
    ["a length a dial doesn't have", { length: 3 }, LEVELS_REFUSED, "levels"],
    ["Search the web that isn't on or off", { webSearch: "yes" }, WEB_SEARCH_UNSAID, "webSearch"],
    ["rooms that aren't a list", { rooms: "0mgk3x2a9b4c5a" }, ROOMS_REFUSED, "rooms"],
    ["a room twice", { rooms: [ROOMS[0], ROOMS[0]] }, ROOMS_REFUSED, "rooms"],
    ["something that can't be a room", { rooms: [ROOMS[0], "Launch!"] }, ROOMS_REFUSED, "rooms"],
    ["more rooms than there can be", { rooms: Array.from({ length: MAX_SHARED_ORDER + 1 }, (_, n) => `room-${n}`) }, ROOMS_REFUSED, "rooms"],
  ])("refuses %s, on its field", (_, data, error, field) => {
    expect(parseAgentChanges(data)).toEqual({ error, field });
  });

  it("says a name is an agent's in the words it was given", () => {
    expect(agentsName(" Recap ")).toBe("Recap is an AI agent's name. Choose another.");
  });
});

describe("Try it", () => {
  /** Recap as Try it sends it, with a question. */
  const TRIAL: AgentTrial = { name: "Recap", instructions: RECAP.instructions, model: RECAP.model, thinking: "off", length: "short", webSearch: false, question: "Sum up this week." };

  it("takes the agent as its page sets it up, and the question, leaving out what it does and its rooms, which it doesn't answer by", () => {
    expect(parseAgentTrial(TRIAL)).toEqual(TRIAL);
    expect(parseAgentTrial({ ...TRIAL, modelName: "Claude Haiku 5.5", question: "\n Sum up this week. \n" })).toEqual({ ...TRIAL, modelName: "Claude Haiku 5.5" });
    // What it does and its rooms may be anything while they're unsaved.
    expect(parseAgentTrial({ ...TRIAL, description: "", rooms: "Launch!" })).toEqual(TRIAL);
    const longest = "x".repeat(MAX_MESSAGE_LENGTH);
    expect(parseAgentTrial({ ...TRIAL, question: longest })).toEqual({ ...TRIAL, question: longest });
  });

  it.each([
    ["name", NAME_REFUSED],
    ["instructions", INSTRUCTIONS_NEEDED],
    ["model", MODEL_REFUSED],
    ["thinking", LEVELS_REFUSED],
    ["length", LEVELS_REFUSED],
    ["webSearch", WEB_SEARCH_UNSAID],
    ["question", QUESTION_NEEDED],
  ] as const)("refuses one without its %s, on its field", (field, error) => {
    const { [field]: _, ...rest } = TRIAL;
    expect(parseAgentTrial(rest)).toEqual({ error, field: field === "thinking" || field === "length" ? "levels" : field });
  });

  it("refuses a field that can't be what it's for, and a question that's blank, not text, or longer than a message", () => {
    expect(parseAgentTrial({ ...TRIAL, name: "Ember" })).toEqual({ error: NAME_RESERVED, field: "name" });
    expect(parseAgentTrial({ ...TRIAL, model: "claude haiku" })).toEqual({ error: MODEL_REFUSED, field: "model" });
    expect(parseAgentTrial({ ...TRIAL, question: " \t\n" })).toEqual({ error: QUESTION_NEEDED, field: "question" });
    expect(parseAgentTrial({ ...TRIAL, question: ["Sum up."] })).toEqual({ error: QUESTION_NEEDED, field: "question" });
    expect(parseAgentTrial({ ...TRIAL, question: "x".repeat(MAX_MESSAGE_LENGTH + 1) })).toEqual({ error: MESSAGE_TOO_LONG, field: "question" });
    for (const data of [null, "Recap", [TRIAL]]) expect(parseAgentTrial(data)).toEqual({ error: NAME_REFUSED, field: "name" });
  });
});
