import {
  isMessageTooLong,
  isReservedName,
  isRoomId,
  MAX_SHARED_ORDER,
  MAX_USER_NAME_LENGTH,
  MESSAGE_TOO_LONG,
  NAME_RESERVED,
  type Card,
  type DirectoryUser,
  type RoomId,
  type User,
} from "./index.ts";
import {
  ANSWER_LENGTHS,
  INSTRUCTIONS_TOO_LONG,
  LEVELS_REFUSED,
  MAX_INSTRUCTIONS_LENGTH,
  MODEL_REFUSED,
  modelNameOf,
  modelOf,
  THINKING_LEVELS,
  type AnswerLength,
  type AnswerLevels,
  type ModelFormat,
  type ThinkingLevel,
  type WebTool,
} from "./assistant.ts";

// AI agents, which administrators make beside @ember on the AI assistant tab of workspace settings,
// through `/api/account/agents`. Each is a bot that answers with its own instructions and model, through
// the AI Gateway Ember AI asks, when someone mentions it in a room it's in, or writes to it directly.

/** The most agents there are, as many as the models people can pick, so that listing them is one short read. */
export const MAX_AGENTS = 20;

/** The longest description of what an agent does, which is one line in the list of agents. */
export const MAX_AGENT_DESCRIPTION_LENGTH = 100;

/** A room an agent is in, by name. */
export interface AgentRoom {
  id: RoomId;
  name: string;
}

/**
 * An agent as the AI assistant tab lists it to administrators: as the people directory lists it, with
 * what it does, the model it answers with and what that's called, what it does on the web, nothing while
 * Search the web is off, and the open rooms it's kept to, by name, or null while it's in every one, new
 * ones too.
 */
export interface Agent extends DirectoryUser {
  description: string;
  model: string;
  modelName: string;
  webTools: WebTool[];
  rooms: AgentRoom[] | null;
}

/**
 * An agent as its page shows it: as the tab lists it, with its instructions, the format its model took
 * its test question in, how much it thinks and how long it answers, whether an administrator uploaded
 * its avatar, and who last changed it, and when.
 */
export interface AgentSettings extends Agent {
  instructions: string;
  format: ModelFormat;
  levels: AnswerLevels;
  /** Whether an administrator uploaded its avatar, which `DELETE /api/account/agents/<id>/avatar` takes away. */
  avatar: boolean;
  changedBy: User;
  changedAt: string;
}

/**
 * An agent as its page at `/users/<id>` shows it to everyone, but its instructions: what it does, the
 * model it answers with and what that's called, and the administrator who made it.
 */
export interface AgentProfile {
  description: string;
  model: string;
  modelName: string;
  setUpBy: User;
}

/** What `GET /api/account/agents` answers: the agents, by name. */
export interface Agents {
  agents: Agent[];
}

/**
 * What `GET /api/account/agents/<id>` answers, and `POST /api/account/agents`, `PATCH /api/account/agents/<id>`
 * and `DELETE /api/account/agents/<id>/avatar`, which make an agent, change one and take away its avatar:
 * the agent as its page then shows it.
 */
export interface AgentAnswer {
  agent: AgentSettings;
}

/**
 * What `POST /api/account/agents` takes, as New agent sends it: the agent's name, what it does, its
 * instructions, the ID of the model it answers with and that model's name, as Cloudflare's catalog gives
 * it, if it does, how much it thinks and how long it answers, whether it searches the web, and the open
 * rooms it's in, or null for every one, new ones too.
 */
export interface NewAgent {
  name: string;
  description: string;
  instructions: string;
  model: string;
  modelName?: string;
  thinking: ThinkingLevel;
  length: AnswerLength;
  webSearch: boolean;
  rooms: RoomId[] | null;
}

/** What `PATCH /api/account/agents/<id>` changes, as the agent's page saves it: any of what New agent takes. What's left out stays as it is. */
export type AgentChanges = Partial<NewAgent>;

/**
 * What `POST /api/account/agents/trials` takes, and `POST /api/account/agents/<id>/trials` for an agent
 * that's saved, as Try it sends it: the agent as its page sets it up, saved or not, but for what it does
 * and its rooms, which it doesn't answer by, and the question to ask it.
 */
export interface AgentTrial extends Omit<NewAgent, "description" | "rooms"> {
  question: string;
}

/**
 * What Try it answers: what the agent said, as a message of its shows it, its text as the room keeps one
 * (`Message.body`), which `displayBody` shows, and the cards of the pictures it shows, and how long its
 * model took, in milliseconds.
 */
export interface AgentTrialAnswer {
  body: string;
  cards: Card[];
  ms: number;
}

/** A field of an agent's page, which a refusal can be about. */
export type AgentField = "name" | "description" | "instructions" | "model" | "levels" | "webSearch" | "rooms" | "question";

/** Why what an agent's page sent is refused, on the field it's about. */
export interface AgentRefusal {
  error: string;
  field: AgentField;
}

/** What the agents' pages and their API tell anyone but an administrator. */
export const AGENTS_FORBIDDEN = "Only administrators can set up agents";

/** Why `POST /api/account/agents` makes no more. */
export const AGENTS_FULL = `Ember can have at most ${MAX_AGENTS} agents. Delete one first.`;

/** Why an agent can't take a name that someone, a bot or another agent has, in any capitals. */
export const NAME_TAKEN = "Someone is called that already. Choose another name.";

/** Why someone or a bot can't be called `name`, which is an agent's. */
export const agentsName = (name: string) => `${name.trim()} is an AI agent's name. Choose another.`;

/** Why a change didn't save: the agent was changed while its model took its test question, or since its page read it. */
export const AGENT_CHANGED = "The agent was changed while its model answered. Try again.";

/** Why an agent wasn't saved: Ember AI was set up again, with another account or API token, while its model answered. */
export const AGENT_SET_UP_AGAIN = "Ember AI was set up again while the model answered, so nothing was saved. Try again.";

/** Why Search the web can't be on for an agent whose model, called `name`, has no tool for it that AI Gateway passes on. */
export const agentCannotSearchWith = (name: string) =>
  `${name} can't search the web through AI Gateway, but Anthropic's and OpenAI's models can. Choose one of theirs, or leave Search the web off.`;

/** Why an agent's fields are refused before anything's saved. */
export const NAME_REFUSED = `Give it a name of one line, at most ${MAX_USER_NAME_LENGTH} characters, which people mention it by.`;
export const DESCRIPTION_REFUSED = `Say what it does in one line of at most ${MAX_AGENT_DESCRIPTION_LENGTH} characters, so people know when to ask it.`;
export const INSTRUCTIONS_NEEDED = "Give it instructions: its task, how to go about it, and what to leave alone.";
export const WEB_SEARCH_UNSAID = "Say whether it searches the web.";
export const ROOMS_REFUSED = "Choose rooms open to everyone, or every one.";
export const QUESTION_NEEDED = "Ask it something.";

/**
 * Parses an untrusted change to an agent, as its page saves it. Returns why it's refused instead, on the
 * field it's about: a name, which can't be @ember's (`isReservedName`), and what it does have to be one
 * line with more than spaces, no longer than Ember keeps, instructions more than spaces, no longer than
 * Ember takes (`MAX_INSTRUCTIONS_LENGTH`), a model one's ID, levels ones the dials have, and rooms a list
 * of rooms' IDs, each once, or null for every open room. Text is saved without the spaces around it,
 * and a name that can't be a model's is left out.
 */
export function parseAgentChanges(data: unknown): AgentChanges | AgentRefusal {
  const given = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const changes: AgentChanges = {};
  if (given.name !== undefined) {
    const name = oneLineIn(given.name);
    if (!name || name.length > MAX_USER_NAME_LENGTH) return { error: NAME_REFUSED, field: "name" };
    if (isReservedName(name)) return { error: NAME_RESERVED, field: "name" };
    changes.name = name;
  }
  if (given.description !== undefined) {
    const description = oneLineIn(given.description);
    if (!description || description.length > MAX_AGENT_DESCRIPTION_LENGTH) return { error: DESCRIPTION_REFUSED, field: "description" };
    changes.description = description;
  }
  if (given.instructions !== undefined) {
    const instructions = typeof given.instructions === "string" ? given.instructions.trim() : "";
    if (!instructions) return { error: INSTRUCTIONS_NEEDED, field: "instructions" };
    if (instructions.length > MAX_INSTRUCTIONS_LENGTH) return { error: INSTRUCTIONS_TOO_LONG, field: "instructions" };
    changes.instructions = instructions;
  }
  if (given.model !== undefined) {
    const model = typeof given.model === "string" ? modelOf(given.model) : null;
    if (model === null) return { error: MODEL_REFUSED, field: "model" };
    changes.model = model;
    const modelName = modelNameOf(given.modelName);
    if (modelName !== null) changes.modelName = modelName;
  }
  if (given.thinking !== undefined) {
    if (!(THINKING_LEVELS as readonly unknown[]).includes(given.thinking)) return { error: LEVELS_REFUSED, field: "levels" };
    changes.thinking = given.thinking as ThinkingLevel;
  }
  if (given.length !== undefined) {
    if (!(ANSWER_LENGTHS as readonly unknown[]).includes(given.length)) return { error: LEVELS_REFUSED, field: "levels" };
    changes.length = given.length as AnswerLength;
  }
  if (given.webSearch !== undefined) {
    if (typeof given.webSearch !== "boolean") return { error: WEB_SEARCH_UNSAID, field: "webSearch" };
    changes.webSearch = given.webSearch;
  }
  if (given.rooms !== undefined) {
    const rooms = roomsIn(given.rooms);
    if (rooms === undefined) return { error: ROOMS_REFUSED, field: "rooms" };
    changes.rooms = rooms;
  }
  return changes;
}

/** Parses an untrusted new agent, as New agent sends it, as `parseAgentChanges` does a change, which leaves out nothing but the model's name. */
export function parseNewAgent(data: unknown): NewAgent | AgentRefusal {
  const agent = parseAgentChanges(data);
  if ("error" in agent) return agent;
  const { name, description, instructions, model, thinking, length, webSearch, rooms } = agent;
  if (name === undefined) return { error: NAME_REFUSED, field: "name" };
  if (description === undefined) return { error: DESCRIPTION_REFUSED, field: "description" };
  if (instructions === undefined) return { error: INSTRUCTIONS_NEEDED, field: "instructions" };
  if (model === undefined) return { error: MODEL_REFUSED, field: "model" };
  if (thinking === undefined || length === undefined) return { error: LEVELS_REFUSED, field: "levels" };
  if (webSearch === undefined) return { error: WEB_SEARCH_UNSAID, field: "webSearch" };
  if (rooms === undefined) return { error: ROOMS_REFUSED, field: "rooms" };
  return { ...agent, name, description, instructions, model, thinking, length, webSearch, rooms };
}

/**
 * Parses an untrusted trial, as Try it sends it: the agent as `parseNewAgent` takes one, but for what it
 * does and its rooms, which are left out, and a question of more than spaces, no longer than a message,
 * without the spaces around it.
 */
export function parseAgentTrial(data: unknown): AgentTrial | AgentRefusal {
  const given = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const { description: _, rooms: __, question: asked, ...setup } = given;
  const agent = parseAgentChanges(setup);
  if ("error" in agent) return agent;
  const { name, instructions, model, thinking, length, webSearch } = agent;
  if (name === undefined) return { error: NAME_REFUSED, field: "name" };
  if (instructions === undefined) return { error: INSTRUCTIONS_NEEDED, field: "instructions" };
  if (model === undefined) return { error: MODEL_REFUSED, field: "model" };
  if (thinking === undefined || length === undefined) return { error: LEVELS_REFUSED, field: "levels" };
  if (webSearch === undefined) return { error: WEB_SEARCH_UNSAID, field: "webSearch" };
  const question = typeof asked === "string" ? asked.trim() : "";
  if (!question) return { error: QUESTION_NEEDED, field: "question" };
  if (isMessageTooLong(question)) return { error: MESSAGE_TOO_LONG, field: "question" };
  return { ...agent, name, instructions, model, thinking, length, webSearch, question };
}

/** `text` without the spaces around it, or "" unless it's one line: without control characters or line breaks. */
function oneLineIn(text: unknown): string {
  const line = typeof text === "string" ? text.trim() : "";
  return /[\p{Cc}\p{Zl}\p{Zp}]/u.test(line) ? "" : line;
}

/** The rooms `given` lists, each once, or null for every open room, or undefined when it's neither. */
function roomsIn(given: unknown): RoomId[] | null | undefined {
  if (given === null) return null;
  if (!Array.isArray(given) || given.length > MAX_SHARED_ORDER) return undefined;
  const ids = given.filter((id): id is RoomId => typeof id === "string" && isRoomId(id));
  return ids.length === given.length && new Set(ids).size === ids.length ? ids : undefined;
}
