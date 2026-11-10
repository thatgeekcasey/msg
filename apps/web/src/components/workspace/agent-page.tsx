import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { MAX_USER_NAME_LENGTH, type Me, type RoomId, type SidebarRoom, type UserId } from "@ember/protocol";
import {
  agentCannotSearchWith,
  MAX_AGENT_DESCRIPTION_LENGTH,
  type AgentChanges,
  type AgentField,
  type AgentRoom,
  type AgentSettings,
  type AgentTrial,
  type AgentTrialAnswer,
  type NewAgent,
} from "@ember/protocol/agents";
import {
  ANSWER_WORDS,
  ASSISTANT_OFF,
  DEFAULT_LEVELS,
  formatOf,
  isWorkersAiModel,
  MAX_CONVERSATION_LENGTH,
  MAX_INSTRUCTIONS_LENGTH,
  maxTokensAt,
  MODEL_REFUSED,
  modelName,
  modelOf,
  PAGES_READ_PER_ANSWER,
  WEB_SEARCHES_PER_ANSWER,
  WEB_TOOLS_IN,
  type AnswerLevels,
  type AssistantCatalog,
  type AssistantModel,
  type AssistantSettings as Assistant,
  type ModelFormat,
  type ModelPrice,
} from "@ember/protocol/assistant";
import { promptAround, webPromptFor, withInstructions, type Prompt } from "@ember/protocol/prompts";
import { displayBody, type DisplayNode } from "@ember/richtext/dom";
import { AUTH_FORM } from "@/components/auth-page";
import defaultBotAvatar from "@/components/default-bot-avatar.svg";
import { FIELD_INPUT, Field, SubmitButton } from "@/components/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAccount } from "@/hooks/use-account";
import { useChosenPhoto } from "@/hooks/use-chosen-photo";
import { useMounted } from "@/hooks/use-mounted";
import { navigate } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import { ApiError, changeAgent, createAgent, deleteAgent, fetchAgent, fetchWorkspaceSettings, isSignedOut, listAssistantModels, removeAgentAvatar, tryAgent } from "@/lib/api";
import { dateLabel } from "@/lib/messages";
import { cn } from "@/lib/utils";
import { AGENTS_PATH, useAgentsOnly } from "./agent-list";
import { BotCards } from "./bot-card";
import { BUTTON } from "./email-settings";
import { lengthOf, searchingWith, TEXTAREA } from "./ember-settings";
import { LevelDials } from "./level-dials";
import { MessageBody } from "./message-body";
import { ANOTHER_MODEL, dollars, idOf, ModelPicker, modelChoiceOf, type ModelChoice } from "./model-picker";
import { PicturePicker } from "./picture-picker";
import { PromptPreview } from "./prompt-preview";
import { DeleteButton, isMissing } from "./room-settings-page";
import { PageHeading, Panel, SettingsPage } from "./settings-page";
import { UnsavedChanges } from "./unsaved-changes";

// New agent and an agent's settings, for administrators while Ember AI is on, which the Agents card on
// the AI assistant tab links to, as the project's owner chose in the mock-ups (2026-11-10): the agent's
// avatar, name and what it does, its Instructions, with what Ember adds around them, How it answers, its
// model and dials, with the most an answer costs at the model's prices, Search the web, its Rooms, and
// Try it, which asks it something as the page sets it up, saved or not. Create agent and Save changes
// ask its model a test question first when it's new, as Set up Ember AI does, and go back to the tab once
// the agent's saved. Leaving with changes asks first. An agent's settings say who last changed it, and
// when, and end with Delete agent, which asks first.

/** What the pages say an agent is. */
export const AGENT_EXPLAINED = "An AI agent people mention by name. It follows your instructions, on the model you choose, through Cloudflare AI Gateway.";

/** What the page says of an agent's instructions. */
export const INSTRUCTIONS_EXPLAINED =
  "The agent's system prompt: its task, how to go about it, and what to leave alone. Anyone who can ask it could get it to repeat these, so leave out anything secret.";

/** What leaving the page with changes asks. */
export const AGENT_CHANGES = "You’ve made changes to this agent. Save them before you leave, or discard them to keep things as they were.";

/** What Delete agent asks first, in the browser's own dialog. */
export const CONFIRM_DELETE_AGENT = "Are you sure you want to delete this agent? It leaves every room for good, though its answers stay. This can’t be undone.";

/** What Try it says of itself, of the agent called `name`. */
export const tryExplained = (name: string) => `Ask ${name} something, as it's set up above, before you save. Nobody else sees what it says.`;

/** What Search the web says for a model, called `name`, that can't search. */
export const cannotSearch = (name: string) => `${name} can't search the web through AI Gateway, but Anthropic's and OpenAI's models can.`;

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** One of the page's cards, as the bot form's and workspace settings' are. */
const CARD = "flex min-w-0 flex-col gap-4 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3";

/**
 * A radio button or a checkbox in a list of them, on a row 44px tall, whose box sits far enough into its
 * label, for fingers, for a fingertip on it to land on the label.
 */
const CHOICE = "flex min-h-11 cursor-pointer items-center gap-2.5 has-disabled:cursor-default touch:-ms-3.5 touch:ps-3.5";

/** Where leaving an agent's page goes, which is always away from what's typed there. */
const leaves = () => false;

/** What the page needs of Ember AI: its settings, whose account lists the models, and Cloudflare's catalog of them. */
interface Setup {
  assistant: Assistant;
  catalog: AssistantCatalog;
}

/** An agent's page as it's filled in, its rooms every open one, or the ones chosen, which choosing every one keeps. */
interface Fields {
  name: string;
  description: string;
  instructions: string;
  choice: ModelChoice;
  levels: AnswerLevels;
  webSearch: boolean;
  everyOpenRoom: boolean;
  chosenRooms: RoomId[];
}

/** Why what the page sends is refused, said on the field it's about, or else, with none, under Create agent or Save changes. */
interface Refusal {
  field: AgentField | null;
  error: string;
}

const AGENT_FIELDS: readonly string[] = ["name", "description", "instructions", "model", "levels", "webSearch", "rooms", "question"] satisfies AgentField[];

/** The field of the page an answer's `field` names, or null for none of them. */
const fieldOf = (field: string | undefined) => (field !== undefined && AGENT_FIELDS.includes(field) ? (field as AgentField) : null);

/** A new agent's page: nothing typed, @ember's model chosen, at the levels people start at, without the web, in every open room. */
const newFields = ({ assistant, catalog }: Setup): Fields => ({
  name: "",
  description: "",
  instructions: "",
  choice: modelChoiceOf(assistant, catalog.models),
  levels: DEFAULT_LEVELS,
  webSearch: false,
  everyOpenRoom: true,
  chosenRooms: [],
});

/** An agent's page as `agent` is saved, its model chosen from `models`, or else typed. */
const fieldsOf = (agent: AgentSettings, models: readonly AssistantModel[]): Fields => ({
  name: agent.name,
  description: agent.description,
  instructions: agent.instructions,
  choice: models.some(({ id }) => id === agent.model) ? { chosen: agent.model, typed: "" } : { chosen: ANOTHER_MODEL, typed: agent.model },
  levels: agent.levels,
  webSearch: agent.webTools.includes("search"),
  everyOpenRoom: agent.rooms === null,
  chosenRooms: agent.rooms?.map(({ id }) => id) ?? [],
});

/** The rooms `fields` put the agent in: null for every open one. */
const roomsChosen = ({ everyOpenRoom, chosenRooms }: Pick<Fields, "everyOpenRoom" | "chosenRooms">) => (everyOpenRoom ? null : chosenRooms);

const sameRooms = (a: readonly RoomId[] | null, b: readonly AgentRoom[] | null) =>
  a === null || b === null ? a === b : a.length === b.length && b.every(({ id }) => a.includes(id));

/**
 * The open rooms an agent can be kept to, by name: those in the sidebar's `rooms`, once it has them, and those
 * it's kept to already, `kept`, which the administrator may not be in, such as one made while they were banned.
 */
function roomsToPick(rooms: readonly SidebarRoom[] | null, kept: readonly AgentRoom[]): AgentRoom[] {
  const open = rooms?.flatMap((room) => (room.kind === "open" ? [{ id: room.id, name: room.name }] : [])) ?? [];
  // The sidebar's last, as its names follow renames.
  const byId = new Map([...kept, ...open].map((room) => [room.id, room]));
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The name of model `model` in `models`, as the Worker keeps it, if they list it. */
const listedName = (model: string, models: readonly AssistantModel[]) => models.find(({ id }) => id === model)?.name;

/** The agent `fields` set up, as New agent sends it. */
function newAgentOf({ name, description, instructions, choice, levels, webSearch, ...rooms }: Fields, models: readonly AssistantModel[]): NewAgent {
  const model = idOf(choice);
  const modelName = listedName(model, models);
  return { name, description, instructions, model, ...(modelName && { modelName }), thinking: levels.thinking, length: levels.length, webSearch, rooms: roomsChosen(rooms) };
}

/**
 * What `fields` change of `agent` as it's saved. Only they're sent, so that saving doesn't put back what
 * another administrator has saved since.
 */
function changesOf(agent: AgentSettings, fields: Fields, models: readonly AssistantModel[]): AgentChanges {
  const changes: AgentChanges = {};
  if (fields.name.trim() !== agent.name) changes.name = fields.name;
  if (fields.description.trim() !== agent.description) changes.description = fields.description;
  if (fields.instructions.trim() !== agent.instructions) changes.instructions = fields.instructions;
  const model = idOf(fields.choice);
  const name = listedName(model, models);
  if (model !== agent.model) Object.assign(changes, { model }, name && { modelName: name });
  if (fields.levels.thinking !== agent.levels.thinking) changes.thinking = fields.levels.thinking;
  if (fields.levels.length !== agent.levels.length) changes.length = fields.levels.length;
  if (fields.webSearch !== agent.webTools.includes("search")) changes.webSearch = fields.webSearch;
  const rooms = roomsChosen(fields);
  if (!sameRooms(rooms, agent.rooms)) changes.rooms = rooms;
  return changes;
}

/** About how many tokens a question reads at most: the longest conversation an agent reads, and `told`, around it, at about four characters a token. */
const mostRead = (told: string) => Math.ceil((MAX_CONVERSATION_LENGTH + told.length) / 4);

/** The most an answer at `levels` costs at `price`, in dollars for a million tokens read and written, having been `told`. */
const mostCostOf = (told: string, levels: AnswerLevels, { input, output }: ModelPrice) => (mostRead(told) * input + maxTokensAt(levels) * output) / 1_000_000;

/** `amount` of US dollars as an answer's cost: in cents under a dollar, and else in dollars and cents. */
function costOf(amount: number): string {
  const cents = Math.round(amount * 100);
  if (cents < 1) return "less than a cent";
  return cents < 100 ? `${cents}¢` : dollars(cents / 100);
}

/** How long Try it's answer took, `ms`: to a tenth of a second under ten. */
function secondsOf(ms: number): string {
  const seconds = Math.max(ms, 100) / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} seconds`;
}

/** Reads Ember AI and its catalog of models, once, for an administrator, sending the page away while Ember AI is off. */
function useSetup(administrator: boolean, off: () => void, failed: (error: unknown) => void): Setup | null {
  const [setup, setSetup] = useState<Setup | null>(null);
  useEffect(() => {
    if (!administrator) return;
    let stopped = false;
    fetchWorkspaceSettings()
      .then(async ({ assistant }) => assistant && { assistant, catalog: await listAssistantModels({ accountId: assistant.accountId }) })
      .then(
        (read) => {
          if (stopped) return;
          if (read) setSetup(read);
          else off();
        },
        (error: unknown) => {
          // A page left before Ember AI loads only reports a session that's ended, which goes to sign in.
          if (!stopped || isSignedOut(error)) failed(error);
        },
      );
    return () => void (stopped = true);
  }, [administrator, off, failed]);
  return setup;
}

interface PageProps {
  me: Me;
  /** The rooms in this person's sidebar, whose open ones an agent can be kept to, or null until it has them. */
  rooms: SidebarRoom[] | null;
  /** Says why something failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** New agent, which only administrators may open while Ember AI is on: anyone else is sent away at once, reading nothing, saying why. */
export function NewAgentPage({ me, rooms, onFailed }: PageProps) {
  const { forbidden, off, failed } = useAgentsOnly(onFailed);
  const setup = useSetup(me.administrator, off, failed);
  useTitle("New agent");

  // Before the form paints, so anyone else never sees it.
  useLayoutEffect(() => {
    if (!me.administrator) forbidden();
  }, [me.administrator, forbidden]);

  return (
    <SettingsPage back={AGENTS_PATH}>
      <Panel aria-busy={setup === null}>{setup && <AgentForm me={me} saved={null} setup={setup} rooms={rooms} onFailed={failed} />}</Panel>
    </SettingsPage>
  );
}

/** An agent's settings, which only administrators may open while Ember AI is on, as New agent; an id that isn't an agent's gets the 404 page. */
export function AgentSettingsPage({ agentId, me, rooms, onMissing, onFailed }: PageProps & { agentId: UserId; onMissing: () => void }) {
  const [agent, setAgent] = useState<AgentSettings | null>(null);
  const { forbidden, off, failed: agentsOnly } = useAgentsOnly(onFailed);
  const failed = useCallback((error: unknown) => (isMissing(error) ? onMissing() : agentsOnly(error)), [onMissing, agentsOnly]);
  const setup = useSetup(me.administrator, off, failed);
  useTitle("Edit agent");

  useLayoutEffect(() => {
    if (!me.administrator) forbidden();
  }, [me.administrator, forbidden]);

  useEffect(() => {
    if (!me.administrator) return;
    let stopped = false;
    fetchAgent(agentId).then(
      (agent) => !stopped && setAgent(agent),
      (error: unknown) => {
        // A page left before its agent loads only reports a session that's ended, which goes to sign in.
        if (!stopped || isSignedOut(error)) failed(error);
      },
    );
    return () => void (stopped = true);
  }, [me.administrator, agentId, failed]);

  return (
    <SettingsPage back={AGENTS_PATH}>
      <Panel aria-busy={agent === null || setup === null}>{agent && setup && <AgentForm me={me} saved={agent} setup={setup} rooms={rooms} onFailed={failed} />}</Panel>
    </SettingsPage>
  );
}

interface FormProps {
  /** Who's looking, whom What Ember adds around them and Try it show asking the agent. */
  me: Me;
  /** The agent as it's saved, or null for one not made yet. */
  saved: AgentSettings | null;
  setup: Setup;
  rooms: SidebarRoom[] | null;
  /** Says why something failed that the page doesn't say itself. */
  onFailed: (error: unknown) => void;
}

/** The agent's page: its form, with Try it, and for an agent that's saved, who last changed it and Delete agent. */
function AgentForm({ me, saved, setup, rooms, onFailed }: FormProps) {
  const models = setup.catalog.models;
  const [fields, setFields] = useState(() => (saved ? fieldsOf(saved, models) : newFields(setup)));
  // Whether anything's been typed or chosen on a new agent's page.
  const [touched, setTouched] = useState(false);
  const photo = useChosenPhoto();
  // Whether Remove avatar was pressed for the picture an administrator uploaded, which saving takes away.
  const [removingAvatar, setRemovingAvatar] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState<"saving" | "deleting" | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const community = useAccount().name;
  const mounted = useMounted();

  const name = fields.name.trim();
  // What the page calls the agent, before it has a name.
  const called = name || "the agent";
  const model = idOf(fields.choice);
  const sameModel = saved?.model === model;
  const nameOfModel = sameModel ? saved.modelName : modelName(model, models);
  const format: ModelFormat = sameModel ? saved.format : formatOf(model, models);
  const canSearch = WEB_TOOLS_IN[format].includes("search");
  // What it does on the web: what its tests found, while it has the model it has, or else what its model's format allows.
  const webTools = !fields.webSearch || !canSearch ? [] : sameModel && saved.webTools.length > 0 ? saved.webTools : [...WEB_TOOLS_IN[format]];
  const where = { community, roomName: null, inThread: false };
  const prompt: Prompt = promptAround(saved?.id ?? null, name || "Agent", me.name, where, ANSWER_WORDS[fields.levels.length], webPromptFor(me.name, webTools, webTools.length > 0), new Date());
  const price = isWorkersAiModel(model) ? undefined : models.find(({ id }) => id === model)?.price;
  const changes = saved && changesOf(saved, fields, models);
  const asksModel = !saved || changes?.model !== undefined || (changes?.webSearch === true && saved.webTools.length === 0);
  const changed = busy === null && (photo.preview !== null || (saved ? removingAvatar || Object.keys(changes ?? {}).length > 0 : touched));
  const openRooms = roomsToPick(rooms, saved?.rooms ?? []);

  /** Changes `field`'s part of the page, forgetting why it, or the page, was refused, as what's changed may not be. */
  const change = (field: AgentField, changes: Partial<Fields>) => {
    setFields((fields) => ({ ...fields, ...changes }));
    setTouched(true);
    // Another model may search where the last couldn't.
    if (refusal?.field === field || refusal?.field === null || (field === "model" && refusal?.field === "webSearch")) setRefusal(null);
  };

  /** Why the page can't be sent as it's filled in, before it is: a model that can't be one, or Search the web on for one that can't search. */
  const refusalBefore = (): Refusal | null => {
    if (modelOf(model) === null) return { field: "model", error: MODEL_REFUSED };
    if (fields.webSearch && !canSearch) return { field: "webSearch", error: agentCannotSearchWith(nameOfModel) };
    return null;
  };

  /**
   * Sends the page: makes the agent, with the picture chosen for its avatar, or saves what's changed, then
   * takes away its avatar if Remove avatar was pressed, settling with it as it's then saved.
   */
  const send = async (): Promise<AgentSettings> => {
    const refused = refusalBefore();
    if (refused) {
      setRefusal(refused);
      throw new Error(refused.error);
    }
    const avatar = await photo.photo();
    if (!saved) return createAgent(newAgentOf(fields, models), avatar);
    let agent = saved;
    if (Object.keys(changes ?? {}).length > 0 || avatar) agent = await changeAgent(saved.id, changes ?? {}, avatar);
    if (removingAvatar && !avatar) agent = await removeAgentAvatar(saved.id);
    return agent;
  };

  /** Says why saving or deleting failed: on the field it's about, on the avatar, under the button, or as the workspace's alerts do. */
  const refuse = (error: unknown) => {
    if (!(error instanceof ApiError)) return onFailed(error);
    if (error.field === "avatar") return photo.refuse(error.message);
    // What the Worker, AI Gateway or the model said of what was sent, or that it changed meanwhile, which the page says itself.
    const said = [422, 429, 502].includes(error.status) || (error.status === 409 && error.message !== ASSISTANT_OFF);
    if (said) setRefusal({ field: fieldOf(error.field), error: error.message });
    else onFailed(error);
  };

  /**
   * Sends the page for the unsaved changes dialog, which says so when it isn't saved, saying why the server
   * refused it as Create agent and Save changes do: on the field it's about, say, or by going to sign in.
   */
  const sendBeforeLeaving = () =>
    send().catch((error: unknown) => {
      // Anything else failed before the server answered, which the dialog says, or the page has said why already.
      if (error instanceof ApiError) refuse(error);
      throw error;
    });

  /** Runs `request`, holding the page meanwhile, going back to the AI assistant tab once it succeeds, or else saying why it didn't. */
  const run = (doing: "saving" | "deleting", request: () => Promise<unknown>) => {
    setBusy(doing);
    request().then(
      () => mounted.current && navigate(AGENTS_PATH),
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setBusy(null);
        refuse(error);
      },
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy !== null) return;
    setRefusal(null);
    const refused = refusalBefore();
    if (refused) return setRefusal(refused);
    run("saving", send);
  };

  const remove = () => {
    if (saved && confirm(CONFIRM_DELETE_AGENT)) run("deleting", () => deleteAgent(saved.id));
  };

  const refused = (field: AgentField) => (refusal?.field === field ? true : undefined);
  /** What describes `field`'s input: why it's refused, if it is, or else what it's for. */
  const describedBy = (id: string, field: AgentField) => (refusal?.field === field ? `${id}-refusal` : `${id}-description`);
  const savingNote = !asksModel ? null : !saved || changes?.model !== undefined ? `Asking ${nameOfModel} a test question…` : searchingWith(nameOfModel);

  return (
    <>
      <form ref={form} onSubmit={submit} className={AUTH_FORM}>
        <PageHeading title={saved ? `Edit ${saved.name}` : "New agent"}>{AGENT_EXPLAINED}</PageHeading>
        <div>
          <PicturePicker
            id="agent_avatar"
            src={photo.preview ?? (saved && !removingAvatar ? saved.avatarUrl : defaultBotAvatar)}
            alt={`${name || "The agent"}'s avatar`}
            label="Upload the agent's avatar"
            description="Everyone sees it beside the agent's answers."
            disabled={busy !== null}
            onChoose={(file) => {
              photo.take(file);
              setRemovingAvatar(false);
            }}
            remove={
              photo.preview !== null || (saved?.avatar && !removingAvatar)
                ? { label: "Remove avatar", onRemove: () => (photo.preview !== null ? photo.take(undefined) : setRemovingAvatar(true)) }
                : null
            }
          />
          {photo.refusal && (
            <p role="alert" className="-mt-2 mb-4 text-center text-[0.8rem] text-destructive">
              {photo.refusal}
            </p>
          )}
        </div>
        <Field id="agent_name" label="Name">
          <Input
            id="agent_name"
            placeholder="Name the agent"
            maxLength={MAX_USER_NAME_LENGTH}
            autoFocus={!saved}
            required
            disabled={busy !== null}
            data-1p-ignore
            value={fields.name}
            aria-invalid={refused("name")}
            aria-describedby={describedBy("agent-name", "name")}
            onChange={(event) => change("name", { name: event.target.value })}
            className={FIELD_INPUT}
          />
          <Under id="agent-name" field="name" refusal={refusal}>
            People mention it as @{name || "its name"}. Nobody else here can have its name.
          </Under>
        </Field>
        <Field id="agent_description" label="What it does">
          <Input
            id="agent_description"
            placeholder="Sums up threads into decisions and to-dos"
            maxLength={MAX_AGENT_DESCRIPTION_LENGTH}
            required
            disabled={busy !== null}
            value={fields.description}
            aria-invalid={refused("description")}
            aria-describedby={describedBy("agent-description", "description")}
            onChange={(event) => change("description", { description: event.target.value })}
            className={FIELD_INPUT}
          />
          <Under id="agent-description" field="description" refusal={refusal}>
            Shown in the list of agents, so people know when to ask it.
          </Under>
        </Field>
        <section aria-labelledby="agent-instructions-heading" className={CARD}>
          <div>
            <h2 id="agent-instructions-heading" className="text-base font-semibold">
              Instructions
            </h2>
            <p id="agent-instructions-note" className={NOTE}>
              {INSTRUCTIONS_EXPLAINED}
            </p>
          </div>
          <textarea
            id="agent_instructions"
            aria-labelledby="agent-instructions-heading"
            aria-describedby={`agent-instructions-note ${describedBy("agent-instructions", "instructions")}`}
            aria-invalid={refused("instructions")}
            rows={9}
            maxLength={MAX_INSTRUCTIONS_LENGTH}
            required
            disabled={busy !== null}
            placeholder="You sum up conversations for the team…"
            value={fields.instructions}
            onChange={(event) => change("instructions", { instructions: event.target.value })}
            className={TEXTAREA}
          />
          <Under id="agent-instructions" field="instructions" refusal={refusal} className="-mt-2 text-end">
            {lengthOf(fields.instructions)}
          </Under>
          <PromptPreview name={called} prompt={prompt} />
        </section>
        <section aria-labelledby="agent-model-heading" className={CARD}>
          <div>
            <h2 id="agent-model-heading" className="text-base font-semibold">
              How it answers
            </h2>
            <p className={NOTE}>
              Every answer {called} gives runs on this model, from Cloudflare's catalog for your AI Gateway, thinking and writing as much as you set here. People can't
              change these on their profile, as they can for @ember.
            </p>
          </div>
          <div>
            <ModelPicker
              models={models}
              unread={setup.catalog.refusal}
              choice={fields.choice}
              onChoose={(choice) => change("model", { choice })}
              refusal={refusal?.field === "model" ? { field: "model", error: refusal.error } : null}
              disabled={busy !== null}
              accountId={setup.assistant.accountId}
            />
          </div>
          <div>
            <LevelDials name="agent-levels" levels={fields.levels} disabled={busy !== null} onChange={(levels) => change("levels", { levels: { ...fields.levels, ...levels } })} />
            <Under id="agent-levels" field="levels" refusal={refusal} className="mt-2" />
          </div>
          {price && (
            <p className={cn(NOTE, "border-t pt-4")}>
              At {nameOfModel}'s prices, an answer at these levels costs at most about {costOf(mostCostOf(withInstructions(prompt, fields.instructions), fields.levels, price))},
              and most far less{webTools.length > 0 ? ", besides what searching the web costs" : ""}.
            </p>
          )}
        </section>
        <WebSearch
          called={called}
          modelName={nameOfModel}
          canSearch={canSearch}
          reads={WEB_TOOLS_IN[format].includes("read")}
          on={fields.webSearch}
          refusal={refusal?.field === "webSearch" ? refusal.error : null}
          disabled={busy !== null}
          onTurn={(webSearch) => change("webSearch", { webSearch })}
        />
        <section aria-labelledby="agent-rooms-heading" className={CARD}>
          <div>
            <h2 id="agent-rooms-heading" className="text-base font-semibold">
              Rooms
            </h2>
            <p id="agent-rooms-description" className={NOTE}>
              Where people can mention {called}. Anyone can also write to it directly.
            </p>
          </div>
          <fieldset aria-labelledby="agent-rooms-heading" aria-describedby={describedBy("agent-rooms", "rooms")} disabled={busy !== null} className="flex flex-col gap-1">
            <label className={CHOICE}>
              <input
                type="radio"
                name="agent-rooms"
                checked={fields.everyOpenRoom}
                onChange={() => change("rooms", { everyOpenRoom: true })}
                className="size-4 flex-none accent-foreground"
              />
              <span>Every room open to everyone, as @ember is, new ones too</span>
            </label>
            <label className={CHOICE}>
              <input
                type="radio"
                name="agent-rooms"
                checked={!fields.everyOpenRoom}
                onChange={() => change("rooms", { everyOpenRoom: false })}
                className="size-4 flex-none accent-foreground"
              />
              <span>Only the rooms I choose</span>
            </label>
            {!fields.everyOpenRoom && (
              <div className="ms-6 grid grid-cols-2 gap-x-[2ch] gap-y-1 upto-500px:grid-cols-1">
                {openRooms.map((room) => (
                  <label key={room.id} className={CHOICE}>
                    <input
                      type="checkbox"
                      checked={fields.chosenRooms.includes(room.id)}
                      onChange={(event) =>
                        change("rooms", {
                          chosenRooms: event.target.checked ? [...fields.chosenRooms, room.id] : fields.chosenRooms.filter((id) => id !== room.id),
                        })
                      }
                      className="size-4 flex-none accent-foreground"
                    />
                    <span className="truncate">{room.name}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <Under id="agent-rooms" field="rooms" refusal={refusal} />
        </section>
        <TryIt
          called={called}
          agentId={saved?.id ?? null}
          trialOf={(question) => {
            const { description: _, rooms: __, ...agent } = newAgentOf(fields, models);
            return { ...agent, question };
          }}
          refusalBefore={refusalBefore}
          modelName={nameOfModel}
          onFailed={onFailed}
        />
        <SubmitButton disabled={busy !== null}>{saved ? "Save changes" : "Create agent"}</SubmitButton>
        <p role="status" className={cn(NOTE, "-mt-1 text-center wrap-anywhere empty:hidden", busy === null && "text-negative")}>
          {busy === "saving" ? savingNote : refusal?.field === null ? refusal.error : null}
        </p>
        {saved && (
          <p className={cn(NOTE, "-mt-1 text-center")}>
            {saved.changedBy.name} last changed {saved.name} on {dateLabel(new Date(saved.changedAt))}.
          </p>
        )}
      </form>
      {saved && (
        <>
          <hr className="my-8 w-full" />
          <DeleteButton label={`Delete ${saved.name}`} text="Delete agent" disabled={busy !== null} onClick={remove} />
        </>
      )}
      <UnsavedChanges changed={changed} stays={leaves} onSave={sendBeforeLeaving} onStayAfterSave={() => navigate(AGENTS_PATH)} form={form} description={AGENT_CHANGES} />
    </>
  );
}

/** Under a field: why it's refused, if it is, or else what's said of it, if anything is. */
function Under({ id, field, refusal, className, children }: { id: string; field: AgentField; refusal: Refusal | null; className?: string; children?: ReactNode }) {
  if (refusal?.field === field) {
    return (
      <p id={`${id}-refusal`} role="alert" className={cn(NOTE, "wrap-anywhere text-negative", className)}>
        {refusal.error}
      </p>
    );
  }
  if (children === undefined) return null;
  return (
    <p id={`${id}-description`} className={cn(NOTE, className)}>
      {children}
    </p>
  );
}

/**
 * Search the web: its switch, `on` or not, and what it lets the agent called `called` do with its model,
 * called `modelName`, which `canSearch` or not, and `reads` pages or not, or why the switch can't be on
 * with it, or why it was refused.
 */
function WebSearch({
  called,
  modelName,
  canSearch,
  reads,
  on,
  refusal,
  disabled,
  onTurn,
}: {
  called: string;
  modelName: string;
  canSearch: boolean;
  reads: boolean;
  on: boolean;
  refusal: string | null;
  disabled: boolean;
  onTurn: (on: boolean) => void;
}) {
  const It = called.charAt(0).toUpperCase() + called.slice(1);
  const reading = reads ? `, and reads the pages people link to or its searches find, at most ${PAGES_READ_PER_ANSWER}` : "";
  const refused = refusal ?? (on && !canSearch ? agentCannotSearchWith(modelName) : null);
  const note =
    refused ??
    (!canSearch
      ? cannotSearch(modelName)
      : on
        ? `${It} searches the web when a question needs it, at most ${WEB_SEARCHES_PER_ANSWER} times an answer${reading}, and lists the pages it used under its answer. AI Gateway's credits pay for each search.`
        : `${It} answers from what its model learned in training. Turn this on to let it search the web when a question needs what's current.`);
  return (
    <section aria-labelledby="agent-search-heading" className={CARD}>
      <div className="flex items-center gap-x-[1ch]">
        <div className="min-w-0 flex-1">
          <h2 id="agent-search-heading" className="text-base font-semibold">
            Search the web
          </h2>
          <p id="agent-search-description" role={refused ? "alert" : undefined} className={cn(NOTE, "wrap-anywhere", refused && "text-negative")}>
            {note}
          </p>
        </div>
        <Switch checked={on} onCheckedChange={onTurn} disabled={disabled} aria-labelledby="agent-search-heading" aria-describedby="agent-search-description" />
      </div>
    </section>
  );
}

/** What Try it's answer shows, as a message of the agent's would, or null when it can't be shown. */
function shownAnswer(body: string): DisplayNode[] | null {
  try {
    return displayBody(body, "", location.hostname);
  } catch (error) {
    console.error("Could not show the agent's answer", error);
    return null;
  }
}

/**
 * Try it: asks the agent, as the page sets it up, saved as `agentId` or not yet, the question typed, as
 * the administrator would ask it directly, showing what it said, as a message of its would show it, and
 * how long its model took, or why it didn't answer. Nothing is saved.
 */
function TryIt({
  called,
  agentId,
  trialOf,
  refusalBefore,
  modelName,
  onFailed,
}: {
  called: string;
  agentId: UserId | null;
  trialOf: (question: string) => AgentTrial;
  refusalBefore: () => Refusal | null;
  modelName: string;
  onFailed: (error: unknown) => void;
}) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<AgentTrialAnswer | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const mounted = useMounted();
  const nodes = answer && shownAnswer(answer.body);

  const ask = () => {
    if (asking || question.trim() === "") return;
    setAnswer(null);
    const refused = refusalBefore();
    if (refused) return setRefusal(refused.error);
    setRefusal(null);
    setAsking(true);
    tryAgent(trialOf(question), agentId).then(
      (answered) => {
        if (!mounted.current) return;
        setAsking(false);
        setAnswer(answered);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setAsking(false);
        // What the Worker, AI Gateway or the model said of the question or the agent, which Try it says itself.
        if (error instanceof ApiError && ([422, 429, 502].includes(error.status) || (error.status === 409 && error.message !== ASSISTANT_OFF))) return setRefusal(error.message);
        onFailed(error);
      },
    );
  };

  // Enter asks, rather than saving the agent's page around it.
  const askOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    ask();
  };

  return (
    <section aria-labelledby="agent-try-heading" className={CARD}>
      <div>
        <h2 id="agent-try-heading" className="text-base font-semibold">
          Try it
        </h2>
        <p className={NOTE}>{tryExplained(called)}</p>
      </div>
      <div className="flex items-end gap-x-[1ch]">
        <div className="min-w-0 flex-1">
          <Field id="agent_try" label="Question">
            <Input
              id="agent_try"
              placeholder={`Ask ${called} something`}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={askOnEnter}
              className={FIELD_INPUT}
            />
          </Field>
        </div>
        <button type="button" onClick={ask} disabled={asking || question.trim() === ""} className={BUTTON}>
          Ask
        </button>
      </div>
      <p role="status" className={cn(NOTE, "-mt-2 wrap-anywhere empty:hidden", refusal !== null && "text-negative")}>
        {asking ? `Asking ${modelName} your question…` : refusal}
      </p>
      {answer && (
        <div className="flex flex-col gap-2 rounded-[9px] border bg-background px-[1.5ch] py-3">
          {nodes ? <MessageBody nodes={nodes} mentions={[]} className="text-message-ink" /> : <p className={NOTE}>Ember couldn't show this answer.</p>}
          {answer.cards.length > 0 && <BotCards cards={answer.cards} />}
          <p className={NOTE}>Answered in {secondsOf(answer.ms)}.</p>
        </div>
      )}
    </section>
  );
}
