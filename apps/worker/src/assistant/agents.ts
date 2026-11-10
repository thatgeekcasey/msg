import { ASSISTANT_ID, type UserId } from "@ember/protocol";
import {
  AGENT_CHANGED,
  AGENT_SET_UP_AGAIN,
  agentCannotSearchWith,
  AGENTS_FORBIDDEN,
  AGENTS_FULL,
  NAME_TAKEN,
  parseAgentChanges,
  parseAgentTrial,
  parseNewAgent,
  type AgentAnswer,
  type Agents,
  type AgentSettings,
  type AgentTrial,
  type AgentTrialAnswer,
} from "@ember/protocol/agents";
import { ASSISTANT_OFF, modelName, WEB_TOOLS_IN, type ModelFormat } from "@ember/protocol/assistant";
import { prepareBody } from "@ember/richtext";
import { credentialsOf } from "../auth";
import { userFormOf, userFormPhoto } from "../avatars";
import { jsonBodyOf } from "../bodies";
import { keptCards } from "../cards";
import type { Env } from "../env";
import { notFound } from "../error-pages";
import { anyOtherPage, formAnswer } from "../pages";
import { asksModel, workspace, type AgentTrialAccess, type AskedModel } from "../workspace";
import { answerOf, questionFor, waitFor } from "./answers";
import { askInTurn, formatsFor, type Answered, type Gateway, type GatewayRefusal } from "./gateway";
import { administratorOf, greetingFrom, searchedBy, TEST_QUESTION, WEB_TEST_QUESTION } from "./settings";

// AI agents, as administrators make, change and delete them beside @ember on the AI assistant tab of
// workspace settings, each with its own instructions and the model it answers with, which Ember AI asks
// AI Gateway for. They answer JSON for the tab and each agent's page.

const problem = (status: number, message: string) => Response.json({ error: message }, { status });

const NOT_SIGNED_IN = "Not signed in";
/** What's said of agents is for administrators, which no cache should keep. */
const PRIVATE = { "Cache-Control": "no-store" };

/** Why Search the web didn't turn on for an agent whose model, called `name`, answered without searching. */
export const agentAnsweredUnsearched = (name: string) =>
  `${name} answered without searching the web, so Search the web is still off. Try again, or choose another model.`;

/** What making the agent called `name`, or giving it a model, asks the model first, as Set up Ember AI asks @ember's. */
const testQuestionFor = (name: string) => ({
  ...TEST_QUESTION,
  instructions: `You are ${name}, an AI agent in a team's chat, where people ask you things by mentioning @${name}. An administrator has just set you up.`,
});

/** What turning on Search the web for the agent called `name` asks its model, which it has to search the web to answer. */
const webTestQuestionFor = (name: string) => ({
  ...WEB_TEST_QUESTION,
  instructions: `You are ${name}, an AI agent in a team's chat. An administrator has just let you search the web.`,
});

/**
 * An agent's settings page, `/account/agents/<id>/edit`: Campfire's 404 page for an administrator when
 * `id` isn't an active agent's, or @ember's, whose page is always there, and otherwise the app's page,
 * which sends anyone signed out to sign in, anyone else to workspace settings, and anyone while Ember AI
 * is off to the AI assistant tab.
 */
export async function agentPage(request: Request, env: Env, pathname: string, agentId: UserId): Promise<Response> {
  const credentials = agentId === ASSISTANT_ID ? null : await credentialsOf(request, env);
  const found = credentials && (await workspace(env).agent(credentials, agentId));
  return found === "not found" ? notFound(request) : anyOtherPage(request, env, pathname);
}

/** `GET /api/account/agents`: the agents, by name, as the AI assistant tab lists them while Ember AI is on. */
export async function listAgents(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const agents = credentials && (await workspace(env).agents(credentials));
  if (!agents) return problem(401, NOT_SIGNED_IN);
  if (agents === "forbidden") return problem(403, AGENTS_FORBIDDEN);
  if (agents === "off") return problem(409, ASSISTANT_OFF);
  return Response.json({ agents } satisfies Agents, { headers: PRIVATE });
}

/** `GET /api/account/agents/:id`: agent `id`, as its page shows it. */
export async function showAgent(request: Request, env: Env, agentId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return agentAnswer(credentials && (await workspace(env).agent(credentials, agentId)));
}

/**
 * `POST /api/account/agents`, `{ name, description, instructions, model, modelName?, thinking, length,
 * webSearch, rooms }`: makes an agent, once its model has answered a test question through Ember AI's
 * account, and searched the web, if it's to, answering 201 with the agent as its page shows it. With an
 * avatar, it's a form whose `user` part is that JSON and whose `avatar` and `variant` parts are the
 * picture, as a bot's is. Someone who isn't an administrator hears so before anything they sent is
 * read, and a field that can't be what it's for, or that AI Gateway refuses, is refused on that field.
 * Ember AI being off, as many agents as there can be and a name someone has are refused before the
 * model is asked, so that nobody waits for it to hear so.
 */
export async function createAgent(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env, AGENTS_FORBIDDEN);
  if (credentials instanceof Response) return credentials;
  const sent = await userFormOf(request);
  if ("error" in sent) return formAnswer({ error: sent.error, field: "avatar" }, sent.status);
  const agent = parseNewAgent(sent.fields);
  if ("error" in agent) return formAnswer(agent, 422);
  const ember = workspace(env);
  const gateway = await ember.agentGateway(credentials, agent.name);
  if (!gateway || typeof gateway === "string") return agentAnswer(gateway);
  const asked = await askedModel(env, gateway, agent.name, { model: agent.model, modelName: agent.modelName ?? modelName(agent.model) }, agent.webSearch);
  if (asked instanceof Response) return asked;
  const avatar = await userFormPhoto(env, sent.photo);
  if (avatar && "error" in avatar) return formAnswer({ error: avatar.error, field: "avatar" }, avatar.status);
  return agentAnswer(await ember.createAgent(credentials, agent, asked, avatar), 201);
}

/**
 * `PATCH /api/account/agents/:id`, with any of what `POST /api/account/agents` takes: changes agent `id`,
 * answering it as its page then shows it, with a new avatar as `createAgent` takes one. Its model answers
 * the test question first when it's another, and searches the web when Search the web is to be on and
 * wasn't, or it's another model, though a name someone has is refused before it's asked. As there,
 * someone who isn't an administrator hears so first, then that Ember AI is off, then an agent there
 * isn't isn't found, before anything that was sent is read.
 */
export async function changeAgent(request: Request, env: Env, agentId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, NOT_SIGNED_IN);
  const ember = workspace(env);
  const found = await ember.agent(credentials, agentId);
  if (!found || typeof found === "string") return agentAnswer(found);
  const sent = await userFormOf(request);
  if ("error" in sent) return formAnswer({ error: sent.error, field: "avatar" }, sent.status);
  const changes = parseAgentChanges(sent.fields);
  if ("error" in changes) return formAnswer(changes, 422);
  let asked: AskedModel | null = null;
  if (asksModel(found, changes)) {
    const gateway = await ember.agentGateway(credentials, changes.name ?? found.name, agentId);
    if (!gateway || typeof gateway === "string") return agentAnswer(gateway);
    const model =
      changes.model === undefined || changes.model === found.model
        ? { ...found, modelName: changes.modelName ?? found.modelName }
        : { model: changes.model, modelName: changes.modelName ?? modelName(changes.model) };
    const answered = await askedModel(env, gateway, changes.name ?? found.name, model, changes.webSearch ?? found.webTools.length > 0);
    if (answered instanceof Response) return answered;
    asked = answered;
  }
  const avatar = await userFormPhoto(env, sent.photo);
  if (avatar && "error" in avatar) return formAnswer({ error: avatar.error, field: "avatar" }, avatar.status);
  return agentAnswer(await ember.changeAgent(credentials, agentId, changes, asked && { ...asked, changedAt: found.changedAt }, avatar && { picture: avatar }));
}

/**
 * `POST /api/account/agents/trials`, `{ name, instructions, model, modelName?, thinking, length,
 * webSearch, question }`, and `POST /api/account/agents/:id/trials` for agent `id`: Try it, which asks
 * the agent, as its page sets it up, saved or not, the administrator's question, as if they'd written it
 * to the agent directly, through Ember AI's account, answering what it said, as a message of its would
 * show it, but for a preview of its first link, and how long its model took. Nobody else sees either,
 * and nothing is saved. A saved agent with the same model answers in the format, and with the web
 * tools, its tests found, and any other is asked in each format in turn (`formatsFor`). As with changing
 * an agent, someone who isn't an administrator hears so first, then that Ember AI is off, then that the
 * agent isn't there, before anything that was sent is read, and a field that can't be what it's for, or
 * that AI Gateway refuses, is refused on that field, as Search the web is for a model that can't search.
 */
export async function tryAgent(request: Request, env: Env, agentId: UserId | null): Promise<Response> {
  const credentials = await administratorOf(request, env, AGENTS_FORBIDDEN);
  if (credentials instanceof Response) return credentials;
  const access = await workspace(env).agentTrial(credentials, agentId);
  if (!access || typeof access === "string") return agentAnswer(access);
  const trial = parseAgentTrial(await jsonBodyOf(request));
  if ("error" in trial) return formAnswer(trial, 422);
  const startedAt = Date.now();
  const answered = await triedAnswer(env, access, trial);
  if ("refusal" in answered) return refused(answered, "model");
  const ms = Date.now() - startedAt;
  if (trial.webSearch && WEB_TOOLS_IN[answered.format].length === 0) {
    const name = trial.modelName ?? (access.saved?.model === trial.model ? access.saved.modelName : modelName(trial.model));
    return formAnswer({ error: agentCannotSearchWith(name), field: "webSearch" }, 422);
  }
  const text = answered.cut ? `${answered.text}\n\n…` : answered.text;
  const { markup, cards } = answerOf(text, answered.sources, [trial.question], access.addresses, trial.name);
  const answer: AgentTrialAnswer = { body: prepareBody(markup, () => undefined)?.html ?? "", cards: keptCards(cards).cards, ms };
  return Response.json(answer, { headers: PRIVATE });
}

/**
 * What the agent `trial` sets up answers its question, asked through `access` as a direct message from
 * the administrator who tries it, in the format of the agent as it's saved, while it has the same model,
 * or else in each in turn, and the format it took it in, or why it didn't answer.
 */
async function triedAnswer(env: Env, { asker, through, community, saved }: AgentTrialAccess, trial: AgentTrial): Promise<(Answered & { format: ModelFormat }) | GatewayRefusal> {
  const known = saved?.model === trial.model ? saved : null;
  const answerer = { id: saved?.id ?? null, name: trial.name, instructions: trial.instructions };
  const where = { community, roomName: null, inThread: false };
  const levels = { thinking: trial.thinking, length: trial.length };
  const webToolsIn = (format: ModelFormat) => (!trial.webSearch ? [] : known && known.webTools.length > 0 ? known.webTools : WEB_TOOLS_IN[format]);
  const questionIn = (format: ModelFormat) => questionFor(answerer, [{ creator: asker, plainText: trial.question }], asker, where, levels, new Date(), webToolsIn(format));
  const formats = known ? [known.format] : formatsFor(trial.model);
  return askInTurn(env, { ...through, model: trial.model }, formats, questionIn, waitFor(questionIn(formats[0]!)));
}

/** `DELETE /api/account/agents/:id/avatar`: takes away the avatar agent `id` was given, answering it as its page then shows it. */
export async function removeAgentAvatar(request: Request, env: Env, agentId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return agentAnswer(credentials && (await workspace(env).changeAgent(credentials, agentId, {}, null, { picture: null })));
}

/** `DELETE /api/account/agents/:id`: deletes agent `id`, which deactivates it, as deleting a bot does, answering 204. */
export async function deleteAgent(request: Request, env: Env, agentId: UserId): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const deleted = credentials && (await workspace(env).deleteAgent(credentials, agentId));
  if (!deleted || deleted !== "deleted") return agentAnswer(deleted);
  return new Response(null, { status: 204 });
}

/**
 * What asking `model`, called `modelName`, through Ember AI's gateway finds for the agent called `name`:
 * the format it takes the test question in, unless that's known already, and, while it's to search the
 * web (`webSearch`), what it may do there, or else why it can't, on the field it's about.
 */
async function askedModel(
  env: Env,
  gateway: Gateway,
  name: string,
  { model, modelName, format: known }: { model: string; modelName: string; format?: ModelFormat },
  webSearch: boolean,
): Promise<AskedModel | Response> {
  const through = { accountId: gateway.accountId, apiToken: gateway.apiToken };
  let format = known;
  if (format === undefined) {
    const answered = await greetingFrom(env, { ...through, model }, testQuestionFor(name));
    if ("refusal" in answered) return refused(answered, "model");
    format = answered.format;
  }
  if (!webSearch) return { model, modelName, format, webTools: [], through };
  if (WEB_TOOLS_IN[format].length === 0) return formAnswer({ error: agentCannotSearchWith(modelName), field: "webSearch" }, 422);
  const searched = await searchedBy(env, { ...through, model, format, name: modelName }, webTestQuestionFor(name), agentAnsweredUnsearched);
  if ("refusal" in searched) return refused(searched, "webSearch");
  return { model, modelName, format, webTools: searched.webTools, through };
}

/**
 * What to answer when the model didn't answer its test question: why, on `about`, the field of the
 * agent's page for the test it failed, when it's the model's doing, and not Ember AI's API token or
 * account's, which Ember AI's card changes, or AI Gateway's.
 */
const refused = ({ refusal, reason, field, status }: GatewayRefusal, about: "model" | "webSearch") =>
  formAnswer({ error: refusal, ...((field === "model" || reason === "model") && { field: about }) }, status);

/** What a request about an agent answers: the agent as its page then shows it, with `status`, or why it was refused. */
function agentAnswer(
  agent: AgentSettings | "off" | "changed" | "set up again" | "full" | "name taken" | "not found" | "forbidden" | null,
  status = 200,
): Response {
  if (!agent) return problem(401, NOT_SIGNED_IN);
  if (agent === "forbidden") return problem(403, AGENTS_FORBIDDEN);
  if (agent === "not found") return problem(404, "Not found");
  if (agent === "off") return problem(409, ASSISTANT_OFF);
  if (agent === "changed") return problem(409, AGENT_CHANGED);
  if (agent === "set up again") return problem(409, AGENT_SET_UP_AGAIN);
  if (agent === "full") return problem(409, AGENTS_FULL);
  if (agent === "name taken") return formAnswer({ error: NAME_TAKEN, field: "name" }, 422);
  return Response.json({ agent } satisfies AgentAnswer, { status, headers: PRIVATE });
}
