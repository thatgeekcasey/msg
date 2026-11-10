import { ASSISTANT_ID, ASSISTANT_NAME, type UserId } from "./index.ts";
import type { WebTool } from "./assistant.ts";

// What @ember and the AI agents are told before the conversation they're asked in, on either side of
// their instructions: who they are, where they're asked, how the chat shows what they write, what they
// may do on the web, and the date. The Worker sends it to their models, and an agent's page shows it
// around the instructions typed there, so that what it shows is what the model reads.

/** Where @ember's and the agents' settings are, which what they're told of what an administrator could do names. */
export const AI_SETTINGS = "AI assistant in community settings";

/** Where someone asks: the community's name, the room's, or null for a direct message, and whether it's in a thread. */
export interface AskedIn {
  community: string;
  roomName: string | null;
  inThread: boolean;
}

/** What an answerer is told before its instructions, and after them. */
export interface Prompt {
  before: string;
  after: string;
}

/**
 * What the answerer `answererId` is told, @ember, or an agent called `name`, by its id, or null for one
 * not saved yet: before its instructions, who it is, and after them, where it's asked, to answer the
 * last message, which `askerName` wrote, in at most about `words` words, how the chat shows what it
 * writes, what it's told of the web, `web`, and the date at `now`, in UTC. An agent answers as its
 * instructions say, where @ember answers as a helpful teammate would, and then as administrators added.
 */
export function promptAround(answererId: UserId | null, name: string, askerName: string, { community, roomName, inThread }: AskedIn, words: number, web: string, now: Date): Prompt {
  const ember = answererId === ASSISTANT_ID;
  const room = roomName === null ? "a direct message" : `the room "${roomName}"`;
  const today = new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: "UTC" }).format(now);
  const manner = ember ? "as a helpful teammate would: plainly, and " : "";
  return {
    before: ember
      ? `You are ${ASSISTANT_NAME}, the AI assistant in the team chat "${community}". People ask you things by mentioning @ember in a room or a thread, or by writing to you directly.`
      : `You are ${name}, an AI agent in the team chat "${community}". People ask you things by mentioning @${name} in a room or a thread, or by writing to you directly.`,
    after: [
      `You're asked in ${inThread ? `a thread in ${room}` : room}. Its messages follow, oldest first, each after its writer's name. Answer the last one, which ${askerName} wrote, ${manner}in at most about ${words.toLocaleString("en-US")} words.`,
      "Write in Markdown. Links, bold, italics, lists, quotes, code blocks and tables show as they do in the chat, and a picture you show with ![what it shows](its address) appears under your answer when a person in the conversation wrote its address. Don't begin with your name.",
      web,
      `Today is ${today}, in UTC.`,
    ].join("\n\n"),
  };
}

/** `prompt` with `instructions` between its two parts, as the model reads it, or without them, when there are none. */
export const withInstructions = ({ before, after }: Prompt, instructions: string) => [before, ...(instructions === "" ? [] : [instructions]), after].join("\n\n");

/**
 * What an answerer is told it may do on the web with `webTools`, or, with none, that it can't, and who
 * could let it: `askerName`, by picking a model that can, while Search the web is on, `webSearchOn`, or
 * else an administrator.
 */
export function webPromptFor(askerName: string, webTools: readonly WebTool[], webSearchOn: boolean): string {
  if (!webTools.includes("search") && webSearchOn) {
    return `You can't search the web or open links with the model ${askerName} picked for your answers to them. When they ask you to, say so, and that they can pick one that can, Anthropic's or OpenAI's, under Ember AI on their profile.`;
  }
  if (!webTools.includes("search")) {
    return `You can't search the web or open links. When someone asks you to, say so, and that an administrator can turn on Search the web under ${AI_SETTINGS}.`;
  }
  const reading = webTools.includes("read") ? ", and read the pages people link to or your searches find," : "";
  return [
    `You can search the web${reading} when a question needs what's current, or what you don't know.`,
    "Only what you write after you last search or read is posted, so write all of your answer then. The chat lists the pages you cite after it, so don't list them yourself.",
  ].join(" ");
}
