import { describe, expect, it } from "vitest";
import { ASSISTANT_ID } from "./index";
import { AI_SETTINGS, promptAround, webPromptFor, withInstructions } from "./prompts";

const NOW = new Date("2026-11-10T12:00:00Z");
const IN_LAUNCH = { community: "Fernwood", roomName: "Launch", inThread: true };

describe("What @ember and the agents are told", () => {
  it("tells an agent who it is before its instructions, and where it's asked, how to write, what it may do on the web and the date after them", () => {
    const prompt = promptAround("0mgk3x2a9b4c5e", "Scout", "Ada Lovelace", IN_LAUNCH, 150, "WEB", NOW);
    expect(prompt.before).toBe(
      `You are Scout, an AI agent in the team chat "Fernwood". People ask you things by mentioning @Scout in a room or a thread, or by writing to you directly.`,
    );
    const [where, writing, web, today] = prompt.after.split("\n\n");
    expect(where).toBe(
      `You're asked in a thread in the room "Launch". Its messages follow, oldest first, each after its writer's name. Answer the last one, which Ada Lovelace wrote, in at most about 150 words.`,
    );
    expect(writing).toMatch(/^Write in Markdown\..* Don't begin with your name\.$/);
    expect([web, today]).toEqual(["WEB", "Today is Tuesday, November 10, 2026, in UTC."]);
    expect(withInstructions(prompt, "Say what's current.")).toBe(`${prompt.before}\n\nSay what's current.\n\n${prompt.after}`);
    expect(withInstructions(prompt, "")).toBe(`${prompt.before}\n\n${prompt.after}`);
  });

  it("tells @ember it's the AI assistant, answering as a helpful teammate would, and an agent not saved yet as it's named", () => {
    const ember = promptAround(ASSISTANT_ID, "Ember", "Ada Lovelace", { community: "Fernwood", roomName: null, inThread: false }, 1_500, "WEB", NOW);
    expect(ember.before).toMatch(/^You are Ember, the AI assistant in the team chat "Fernwood"\. People ask you things by mentioning @ember/);
    expect(ember.after).toMatch(/^You're asked in a direct message\. .* Answer the last one, which Ada Lovelace wrote, as a helpful teammate would: plainly, and in at most about 1,500 words\./);
    expect(promptAround(null, "Polyglot", "Ada Lovelace", IN_LAUNCH, 150, "WEB", NOW).before).toMatch(/^You are Polyglot, an AI agent/);
  });

  it("says what it may do on the web, or who could let it", () => {
    expect(webPromptFor("Ada Lovelace", ["search", "read"], true)).toMatch(/^You can search the web, and read the pages people link to or your searches find, when a question needs/);
    expect(webPromptFor("Ada Lovelace", ["search"], true)).toMatch(/^You can search the web when a question needs what's current/);
    expect(webPromptFor("Ada Lovelace", [], false)).toBe(
      `You can't search the web or open links. When someone asks you to, say so, and that an administrator can turn on Search the web under ${AI_SETTINGS}.`,
    );
    expect(webPromptFor("Ada Lovelace", [], true)).toMatch(/^You can't search the web or open links with the model Ada Lovelace picked for your answers to them\./);
  });
});
