import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, SidebarRoom } from "@ember/protocol";
import { AGENT_CHANGED, agentCannotSearchWith, AGENTS_FORBIDDEN, NAME_TAKEN, type AgentSettings, type AgentTrialAnswer, type NewAgent } from "@ember/protocol/agents";
import { ASSISTANT_MODELS, ASSISTANT_OFF, MODEL_REFUSED, TOP_LEVELS, type AssistantCatalog, type AssistantModel, type AssistantSettings as Assistant } from "@ember/protocol/assistant";
import defaultBotAvatar from "@/components/default-bot-avatar.svg";
import { FlashProvider } from "@/components/flash";
import { Sheet } from "@/components/ui/sheet";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { agentSettingsPath, leave, navigate, NEW_AGENT_PATH } from "@/hooks/use-route";
import { ApiError } from "@/lib/api";
import { dateLabel } from "@/lib/messages";
import { AGENTS_PATH } from "./agent-list";
import { AGENT_CHANGES, AGENT_EXPLAINED, AgentSettingsPage, cannotSearch, CONFIRM_DELETE_AGENT, INSTRUCTIONS_EXPLAINED, NewAgentPage, tryExplained } from "./agent-page";
import { searchingWith } from "./ember-settings";

vi.mock("@/lib/previews", () => ({ avatarVariantOf: vi.fn(async () => new Blob(["variant"], { type: "image/webp" })) }));

const ada: Me = { id: "0mgk3x2a9b4c5d", name: "Ada Lovelace", administrator: true };

/** The model `id`, as Ember knows it, with `price` when the catalog gives one. */
function known(id: string, price?: AssistantModel["price"]): AssistantModel {
  const { name, format } = ASSISTANT_MODELS.find((model) => model.id === id)!;
  return { id, name, format, ...(price && { price }) };
}

const SONNET = "anthropic/claude-sonnet-5.5";
const GPT = "openai/gpt-6.1-sol";
const GLM = "@cf/zai-org/glm-4.7-flash";

/** Ember AI on Claude Sonnet 5.5. */
const ON: Assistant = {
  accountId: "0123456789abcdef0123456789abcdef",
  model: SONNET,
  models: [known(SONNET)],
  most: TOP_LEVELS,
  webTools: [],
  instructions: "",
  avatarUrl: "/users/ember.abc/avatar?v=20261101120000",
  avatar: false,
};

/** Cloudflare's catalog, as the Worker lists it, with what other companies' models cost. */
const CATALOG: AssistantCatalog = { models: [known(GLM), known(SONNET, { input: 3, output: 15 }), known(GPT, { input: 2, output: 10 })], refusal: null };

const room = (id: string, name: string, kind: "open" | "closed" = "open"): SidebarRoom => ({ id, name, kind, icon: null, unread: false, involvement: "mentions" });
const DESIGN = room("0mgk3x2a9b4c5a", "design");
const RESEARCH = room("0mgk3x2a9b4c5b", "research");
/** Ada's sidebar: open rooms, one closed, which an agent can't be kept to. */
const ROOMS: SidebarRoom[] = [RESEARCH, DESIGN, room("0mgk3x2a9b4c5c", "secret plans", "closed")];

/** Recap, kept to the design room, as its page reads it. */
const RECAP: AgentSettings = {
  id: "0mgk3x2a9b4c60",
  name: "Recap",
  bio: null,
  role: "bot",
  status: "active",
  avatarUrl: "/users/0mgk3x2a9b4c60/avatar?v=20261109120000",
  description: "Sums up threads into decisions and to-dos.",
  model: SONNET,
  modelName: "Claude Sonnet 5.5",
  webTools: [],
  rooms: [{ id: DESIGN.id, name: "design" }],
  instructions: "Sum up the conversation so far as decisions and to-dos.",
  format: "messages",
  levels: { thinking: "low", length: "medium" },
  avatar: false,
  changedBy: { id: ada.id, name: "Ada Lovelace" },
  changedAt: "2026-11-09T12:00:00.000Z",
};

/** What Try it's model says, as a message of its keeps it, and how long it took. */
const TRIED: AgentTrialAnswer = { body: "<p><strong>Two</strong> decisions so far.</p>", cards: [], ms: 2345 };

type Answer = () => Response | Promise<Response>;
const answer = (agent: AgentSettings, status = 200) => Response.json({ agent }, { status });
const refused = (status: number, error: string, field?: string) => Response.json({ error, field }, { status });

/**
 * Answers the pages' requests as the server does for an administrator, or as `read`, `loaded`, `sent`,
 * `tried` and `deleted` say: reading Ember AI, loading the agent, making or changing it or taking away
 * its avatar, Try it, and deleting it.
 */
function serve({
  read = () => Response.json({ assistant: ON, cloudflareAccountId: null }),
  loaded = () => answer(RECAP),
  sent,
  tried = () => Response.json(TRIED),
  deleted = () => new Response(null, { status: 204 }),
}: { read?: Answer; loaded?: Answer; sent?: Answer; tried?: Answer; deleted?: Answer } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    switch (request) {
      case "GET /api/account":
        return read();
      case "POST /api/account/assistant/catalog":
        return Response.json(CATALOG);
      case `GET /api/account/agents/${RECAP.id}`:
        return loaded();
      case "POST /api/account/agents/trials":
      case `POST /api/account/agents/${RECAP.id}/trials`:
        return tried();
      case `DELETE /api/account/agents/${RECAP.id}`:
        return deleted();
      case "POST /api/account/agents":
        return sent ? sent() : answer(RECAP, 201);
      case `PATCH /api/account/agents/${RECAP.id}`:
      case `DELETE /api/account/agents/${RECAP.id}/avatar`:
        return sent ? sent() : answer(RECAP);
      default:
        throw new Error(`Unexpected request for ${request}`);
    }
  });
}

/** Shows `page` at `path`, as the workspace does, in the community called Analytical Engines. */
function showAt(path: string, page: (props: { onMissing: () => void; onFailed: () => void }) => ReactNode) {
  const [onMissing, onFailed] = [vi.fn(), vi.fn()];
  history.replaceState(null, "", path);
  function Community({ children }: { children: ReactNode }) {
    return <AccountContext value={{ ...useAccount(), name: "Analytical Engines" }}>{children}</AccountContext>;
  }
  render(
    <Community>
      <FlashProvider workspace>
        <Sheet>{page({ onMissing, onFailed })}</Sheet>
      </FlashProvider>
    </Community>,
  );
  return { onMissing, onFailed, user: userEvent.setup() };
}

const showNewAgent = (me = ada, rooms: SidebarRoom[] | null = ROOMS) => showAt(NEW_AGENT_PATH, ({ onFailed }) => <NewAgentPage me={me} rooms={rooms} onFailed={onFailed} />);
const showSettings = (me = ada, rooms: SidebarRoom[] = ROOMS) =>
  showAt(agentSettingsPath(RECAP.id), ({ onMissing, onFailed }) => <AgentSettingsPage agentId={RECAP.id} me={me} rooms={rooms} onMissing={onMissing} onFailed={onFailed} />);

const nameField = () => screen.getByRole("textbox", { name: "Name" });
const descriptionField = () => screen.getByRole("textbox", { name: "What it does" });
const instructionsField = () => screen.getByRole("textbox", { name: "Instructions" });
const modelMenu = () => screen.getByRole("combobox", { name: "Model" });
const level = (dial: "Thinking" | "Answer length", name: string) => within(screen.getByRole("group", { name: dial })).getByRole("radio", { name });
const webSwitch = () => screen.getByRole("switch", { name: "Search the web" });
const everyRoom = () => screen.getByRole("radio", { name: "Every room open to everyone, as @ember is, new ones too" });
const chosenRooms = () => screen.getByRole("radio", { name: "Only the rooms I choose" });
const tryIt = () => screen.getByRole("region", { name: "Try it" });
const question = () => within(tryIt()).getByRole("textbox", { name: "Question" });
const status = () => screen.getAllByRole("status").at(-1)!;
const avatarField = () => screen.getByLabelText("Upload the agent's avatar");
const robot = () => new File(["robot"], "robot.png", { type: "image/png" });

/** The page's form, once Ember AI and its catalog have loaded, and the agent, for its settings. */
const loaded = async () => {
  await waitFor(() => expect(screen.getByRole("button", { name: /^(?:Create agent|Save changes)$/ })).toBeInTheDocument());
  return nameField();
};

/** Fills in the new agent's name, what it does and its instructions. */
async function fillIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await loaded(), "Recap");
  await user.type(descriptionField(), "Sums up threads into decisions and to-dos.");
  await user.type(instructionsField(), "Sum up the conversation so far as decisions and to-dos.");
}

/** The requests the page has sent but for reading what it shows, with what they sent: JSON as it was, or a form's fields. */
const sent = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([input, init]) => {
      const body = init?.body instanceof FormData ? JSON.parse(String(init.body.get("user"))) : init?.body === undefined ? undefined : JSON.parse(String(init.body));
      return [`${init?.method ?? "GET"} ${String(input)}`, body] as [string, unknown];
    })
    .filter(([request]) => !request.startsWith("GET ") && request !== "POST /api/account/assistant/catalog");

/** Whether the page went back to the AI assistant tab. */
const wentBack = () => waitFor(() => expect(location.pathname + location.hash).toBe(AGENTS_PATH));

beforeEach(() => {
  serve();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:robot");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("New agent", () => {
  it("is titled New agent, with Go Back to the AI assistant tab, starting on @ember's model at the levels people start at, off the web, in every open room", async () => {
    showNewAgent();
    expect(document.title).toBe("New agent");
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", AGENTS_PATH);
    expect(await loaded()).toHaveFocus();
    expect(screen.getByRole("heading", { level: 1, name: "New agent" })).toBeInTheDocument();
    expect(screen.getByText(AGENT_EXPLAINED)).toBeInTheDocument();
    expect(nameField()).toHaveValue("");
    expect(nameField()).toBeRequired();
    expect(nameField()).toHaveAccessibleDescription("People mention it as @its name. Nobody else here can have its name.");
    expect(descriptionField()).toBeRequired();
    expect(descriptionField()).toHaveAttribute("maxlength", "100");
    expect(instructionsField()).toBeRequired();
    expect(instructionsField()).toHaveAccessibleDescription(`${INSTRUCTIONS_EXPLAINED} 0 of 10,000 characters`);
    expect(modelMenu()).toHaveValue(SONNET);
    expect(level("Thinking", "Low")).toBeChecked();
    expect(level("Answer length", "Medium")).toBeChecked();
    expect(webSwitch()).not.toBeChecked();
    expect(webSwitch()).toBeEnabled();
    expect(everyRoom()).toBeChecked();
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(screen.getByRole("img", { name: "The agent's avatar" })).toHaveAttribute("src", defaultBotAvatar);
    expect(tryIt()).toHaveTextContent(tryExplained("the agent"));
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("calls the agent by the name typed", async () => {
    const { user } = showNewAgent();
    await user.type(await loaded(), "Recap");
    expect(nameField()).toHaveAccessibleDescription("People mention it as @Recap. Nobody else here can have its name.");
    expect(screen.getByRole("img", { name: "Recap's avatar" })).toBeInTheDocument();
    expect(tryIt()).toHaveTextContent(tryExplained("Recap"));
    expect(question()).toHaveAttribute("placeholder", "Ask Recap something");
  });

  it("makes the agent as it's set up, its model asked a test question first, holding the page meanwhile, then goes back to the AI assistant tab", async () => {
    let made = () => {};
    serve({ sent: () => new Promise((resolve) => (made = () => resolve(answer(RECAP, 201)))) });
    const { user } = showNewAgent();
    await fillIn(user);
    await user.selectOptions(modelMenu(), GPT);
    await user.click(level("Thinking", "Off"));
    await user.click(level("Answer length", "Long"));
    await user.click(webSwitch());
    await user.click(chosenRooms());
    // Its open rooms, by name.
    expect(screen.getAllByRole("checkbox").map((box) => box.closest("label")?.textContent)).toEqual(["design", "research"]);
    await user.click(screen.getByRole("checkbox", { name: "design" }));
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    expect(status()).toHaveTextContent("Asking GPT-6.1 Sol a test question…");
    expect(screen.getByRole("button", { name: "Create agent" })).toBeDisabled();
    // Nothing typed meanwhile would be sent, nor asked about as the page goes back.
    for (const field of [nameField(), descriptionField(), instructionsField()]) expect(field).toBeDisabled();
    expect(sent()).toEqual([
      [
        "POST /api/account/agents",
        {
          name: "Recap",
          description: "Sums up threads into decisions and to-dos.",
          instructions: "Sum up the conversation so far as decisions and to-dos.",
          model: GPT,
          modelName: "GPT-6.1 Sol",
          thinking: "off",
          length: "long",
          webSearch: true,
          rooms: [DESIGN.id],
        } satisfies NewAgent,
      ],
    ]);
    act(() => made());
    await wentBack();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends the avatar chosen, and its variant, with the new agent", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.upload(avatarField(), robot());
    expect(screen.getByRole("img", { name: "Recap's avatar" })).toHaveAttribute("src", "blob:robot");
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await wentBack();
    const form = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === "/api/account/agents")![1]!.body as FormData;
    expect(form.get("avatar")).toMatchObject({ name: "robot.png", type: "image/png" });
    expect(form.get("variant")).toMatchObject({ type: "image/webp" });
  });

  it("lets go of the picture chosen with Remove avatar", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    expect(screen.queryByRole("button", { name: "Remove avatar" })).toBeNull();
    await user.upload(avatarField(), robot());
    await user.click(screen.getByRole("button", { name: "Remove avatar" }));
    expect(screen.getByRole("img", { name: "Recap's avatar" })).toHaveAttribute("src", defaultBotAvatar);
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await wentBack();
    expect(vi.mocked(fetch).mock.calls.find(([input]) => String(input) === "/api/account/agents")![1]!.body).not.toBeInstanceOf(FormData);
  });

  it("says why the server refused the agent on the field it's about, keeping what's typed, until that field changes", async () => {
    serve({ sent: () => refused(422, NAME_TAKEN, "name") });
    const { user, onFailed } = showNewAgent();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(nameField()).toHaveAttribute("aria-invalid", "true"));
    expect(nameField()).toHaveAccessibleDescription(NAME_TAKEN);
    expect(screen.getByRole("alert")).toHaveTextContent(NAME_TAKEN);
    expect(nameField()).toHaveValue("Recap");
    expect(location.pathname).toBe(NEW_AGENT_PATH);
    expect(onFailed).not.toHaveBeenCalled();

    await user.type(nameField(), "er");
    expect(nameField()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says why the model didn't answer on its menu", async () => {
    const refusal = "The model didn't answer: AI Gateway's credits have run out.";
    serve({ sent: () => refused(502, refusal, "model") });
    const { user } = showNewAgent();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(modelMenu()).toHaveAttribute("aria-invalid", "true"));
    expect(modelMenu()).toHaveAccessibleDescription(refusal);
  });

  it("says a refusal about none of its fields under Create agent", async () => {
    serve({ sent: () => refused(409, AGENT_CHANGED) });
    const { user, onFailed } = showNewAgent();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(status()).toHaveTextContent(AGENT_CHANGED));
    expect(screen.getByRole("button", { name: "Create agent" })).toBeEnabled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("goes to the AI assistant tab once Ember AI is found off as it's sent, saying so", async () => {
    serve({ sent: () => refused(409, ASSISTANT_OFF) });
    const { user, onFailed } = showNewAgent();
    await fillIn(user);
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ASSISTANT_OFF);
    expect(location.pathname + location.hash).toBe(AGENTS_PATH);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("refuses a model ID that can't be one before sending anything", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.selectOptions(modelMenu(), "Another model…");
    await user.type(screen.getByRole("textbox", { name: "Model ID" }), "not a model");
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    expect(screen.getByRole("textbox", { name: "Model ID" })).toHaveAccessibleDescription(MODEL_REFUSED);
    expect(sent()).toEqual([]);
  });

  it("says a model that can't search can't, refusing Search the web with it before sending anything, until another model's chosen", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.selectOptions(modelMenu(), GLM);
    expect(webSwitch()).toHaveAccessibleDescription(cannotSearch("GLM-4.7 Flash"));
    // Its switch isn't greyed out, but says why it can't be on.
    await user.click(webSwitch());
    expect(webSwitch()).toBeChecked();
    expect(webSwitch()).toHaveAccessibleDescription(agentCannotSearchWith("GLM-4.7 Flash"));
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    expect(screen.getByRole("alert")).toHaveTextContent(agentCannotSearchWith("GLM-4.7 Flash"));
    expect(sent()).toEqual([]);

    await user.selectOptions(modelMenu(), SONNET);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(webSwitch()).toHaveAccessibleDescription(
      "Recap searches the web when a question needs it, at most 5 times an answer, and reads the pages people link to or its searches find, at most 3, and lists the pages it used under its answer. AI Gateway's credits pay for each search.",
    );
  });

  it("says the most an answer costs at the model's prices, and nothing of one for a Workers AI model", async () => {
    const { user } = showNewAgent();
    await loaded();
    const cost = () => screen.queryByText(/an answer at these levels costs at most about/);
    expect(cost()).toHaveTextContent("At Claude Sonnet 5.5's prices, an answer at these levels costs at most about 12¢, and most far less.");
    await user.click(level("Thinking", "High"));
    await user.click(level("Answer length", "Long"));
    expect(cost()).toHaveTextContent("about 60¢");
    await user.click(webSwitch());
    expect(cost()).toHaveTextContent("about 60¢, and most far less, besides what searching the web costs.");
    await user.selectOptions(modelMenu(), GLM);
    expect(cost()).toBeNull();
  });

  it("shows what Ember adds around the instructions, as the agent reads it when the administrator writes to it directly", async () => {
    const { user } = showNewAgent();
    await user.type(await loaded(), "Recap");
    const preview = screen.getByText("What Ember adds around them").closest("details")!;
    expect(preview).toHaveTextContent(`You are Recap, an AI agent in the team chat "Analytical Engines". People ask you things by mentioning @Recap in a room or a thread`);
    expect(preview).toHaveTextContent("Answer the last one, which Ada Lovelace wrote, in at most about 400 words.");
    expect(preview).toHaveTextContent("You can't search the web or open links.");
  });

  it("asks before the page is left with anything typed, saying what's unsaved", async () => {
    const { user } = showNewAgent();
    await user.type(await loaded(), "Recap");
    act(() => navigate("/rooms/general"));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved Changes" });
    expect(dialog).toHaveAccessibleDescription(AGENT_CHANGES);
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    expect(location.pathname).toBe("/rooms/general");
    expect(sent()).toEqual([]);
  });

  it("says why the server refused what the dialog's Save sent on the field it's about, staying on the page", async () => {
    serve({ sent: () => refused(422, NAME_TAKEN, "name") });
    const { user, onFailed } = showNewAgent();
    await fillIn(user);
    act(() => navigate("/rooms/general"));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved Changes" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Your changes couldn’t be saved.");
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(nameField()).toHaveAttribute("aria-invalid", "true"));
    expect(nameField()).toHaveAccessibleDescription(NAME_TAKEN);
    expect(location.pathname).toBe(NEW_AGENT_PATH);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("leaves a session that's ended by the time the dialog's Save sends it to the workspace, as its own Save does", async () => {
    serve({ sent: () => refused(401, "Sign in to continue.") });
    const { onFailed, user } = showNewAgent();
    await fillIn(user);
    act(() => navigate("/rooms/general"));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(401, "Sign in to continue.")));
  });

  it("leaves without asking while nothing's typed", async () => {
    showNewAgent();
    await loaded();
    act(() => navigate("/rooms/general"));
    expect(location.pathname).toBe("/rooms/general");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("sends anyone but an administrator to workspace settings at once, reading nothing, saying why", async () => {
    const { onFailed } = showNewAgent({ ...ada, administrator: false });
    expect(await screen.findByRole("alert")).toHaveTextContent(AGENTS_FORBIDDEN);
    expect(location.pathname).toBe("/account/edit");
    expect(fetch).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("sends an administrator to the AI assistant tab while Ember AI is off, saying so", async () => {
    serve({ read: () => Response.json({ assistant: null, cloudflareAccountId: null }) });
    const { onFailed } = showNewAgent();
    expect(await screen.findByRole("alert")).toHaveTextContent(ASSISTANT_OFF);
    expect(location.pathname + location.hash).toBe(AGENTS_PATH);
    expect(onFailed).not.toHaveBeenCalled();
  });
});

describe("Try it", () => {
  it("asks the agent as the page sets it up, saved or not, showing what it said as a message and how long it took", async () => {
    let answered = () => {};
    serve({ tried: () => new Promise((resolve) => (answered = () => resolve(Response.json(TRIED)))) });
    const { user } = showNewAgent();
    await fillIn(user);
    const ask = within(tryIt()).getByRole("button", { name: "Ask" });
    expect(ask).toBeDisabled();
    await user.type(question(), "What did we decide?");
    await user.click(ask);
    expect(within(tryIt()).getByRole("status")).toHaveTextContent("Asking Claude Sonnet 5.5 your question…");
    expect(ask).toBeDisabled();
    expect(sent()).toEqual([
      [
        "POST /api/account/agents/trials",
        {
          name: "Recap",
          instructions: "Sum up the conversation so far as decisions and to-dos.",
          model: SONNET,
          modelName: "Claude Sonnet 5.5",
          thinking: "low",
          length: "medium",
          webSearch: false,
          question: "What did we decide?",
        },
      ],
    ]);

    act(() => answered());
    expect(await within(tryIt()).findByText("Two", { selector: "strong" })).toBeInTheDocument();
    expect(tryIt()).toHaveTextContent("Two decisions so far.Answered in 2.3 seconds.");
    expect(within(tryIt()).getByRole("status")).toHaveTextContent("");
    expect(location.pathname).toBe(NEW_AGENT_PATH);
  });

  it("asks with Enter, rather than making the agent", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.type(question(), "What did we decide?{Enter}");
    await within(tryIt()).findByText("Answered in 2.3 seconds.");
    expect(sent().map(([request]) => request)).toEqual(["POST /api/account/agents/trials"]);
  });

  it("says why the agent didn't answer", async () => {
    const refusal = "The model didn't answer in time. Try again.";
    serve({ tried: () => refused(502, refusal) });
    const { user, onFailed } = showNewAgent();
    await fillIn(user);
    await user.type(question(), "What did we decide?{Enter}");
    await waitFor(() => expect(within(tryIt()).getByRole("status")).toHaveTextContent(refusal));
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says why the page can't be asked as it's set up, sending nothing", async () => {
    const { user } = showNewAgent();
    await fillIn(user);
    await user.selectOptions(modelMenu(), GLM);
    await user.click(webSwitch());
    await user.type(question(), "What's new?{Enter}");
    expect(within(tryIt()).getByRole("status")).toHaveTextContent(agentCannotSearchWith("GLM-4.7 Flash"));
    expect(sent()).toEqual([]);
  });

  it("asks a saved agent at its own address", async () => {
    const { user } = showSettings();
    await loaded();
    await user.type(question(), "What did we decide?{Enter}");
    await within(tryIt()).findByText("Answered in 2.3 seconds.");
    expect(sent().map(([request]) => request)).toEqual([`POST /api/account/agents/${RECAP.id}/trials`]);
  });
});

describe("An agent's settings", () => {
  it("shows the agent as it's saved, titled Edit agent, with who last changed it, and Delete agent", async () => {
    showSettings();
    expect(document.title).toBe("Edit agent");
    expect(await loaded()).toHaveValue("Recap");
    expect(nameField()).not.toHaveFocus();
    expect(screen.getByRole("heading", { level: 1, name: "Edit Recap" })).toBeInTheDocument();
    expect(descriptionField()).toHaveValue(RECAP.description);
    expect(instructionsField()).toHaveValue(RECAP.instructions);
    expect(modelMenu()).toHaveValue(SONNET);
    expect(level("Thinking", "Low")).toBeChecked();
    expect(level("Answer length", "Medium")).toBeChecked();
    expect(webSwitch()).not.toBeChecked();
    expect(chosenRooms()).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "design" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "research" })).not.toBeChecked();
    expect(screen.getByRole("img", { name: "Recap's avatar" })).toHaveAttribute("src", RECAP.avatarUrl);
    expect(screen.queryByRole("button", { name: "Remove avatar" })).toBeNull();
    expect(screen.getByText(`Ada Lovelace last changed Recap on ${dateLabel(new Date(RECAP.changedAt))}.`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Recap" })).toHaveTextContent("Delete agent");
  });

  it("saves only what's changed, so another administrator's change stays, then goes back to the AI assistant tab", async () => {
    const { user } = showSettings();
    await loaded();
    await user.clear(descriptionField());
    await user.type(descriptionField(), "Sums up threads.");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await wentBack();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { description: "Sums up threads." }]]);
  });

  it("asks a new model a test question as it saves it", async () => {
    let saved = () => {};
    serve({ sent: () => new Promise((resolve) => (saved = () => resolve(answer({ ...RECAP, model: GPT, modelName: "GPT-6.1 Sol", format: "responses" })))) });
    const { user } = showSettings();
    await loaded();
    await user.selectOptions(modelMenu(), GPT);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(status()).toHaveTextContent("Asking GPT-6.1 Sol a test question…");
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { model: GPT, modelName: "GPT-6.1 Sol" }]]);
    act(() => saved());
    await wentBack();
  });

  it("has the model search the web as Search the web turns on", async () => {
    const { user } = showSettings();
    await loaded();
    await user.click(webSwitch());
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(status()).toHaveTextContent(searchingWith("Claude Sonnet 5.5"));
    await wentBack();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { webSearch: true }]]);
  });

  it("puts the agent in every open room, new ones too", async () => {
    const { user } = showSettings();
    await loaded();
    await user.click(everyRoom());
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await wentBack();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { rooms: null }]]);
  });

  it("lists a room the agent's kept to that the administrator isn't in, so they can take it out of it", async () => {
    // Such as one made while they were banned.
    const { user } = showSettings(ada, [RESEARCH]);
    await loaded();
    expect(screen.getByRole("checkbox", { name: "design" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "design" }));
    await user.click(screen.getByRole("checkbox", { name: "research" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await wentBack();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { rooms: [RESEARCH.id] }]]);
  });

  it("names a room as the sidebar does, which follows renames, once", async () => {
    showSettings(ada, [RESEARCH, room(DESIGN.id, "design studio")]);
    await loaded();
    expect(screen.getAllByRole("checkbox").map((box) => box.closest("label")?.textContent)).toEqual(["design studio", "research"]);
    expect(screen.getByRole("checkbox", { name: "design studio" })).toBeChecked();
  });

  it("keeps the rooms chosen once every open room is chosen and then not", async () => {
    const { user } = showSettings();
    await loaded();
    await user.click(everyRoom());
    await user.click(chosenRooms());
    expect(screen.getByRole("checkbox", { name: "design" })).toBeChecked();
    act(() => navigate("/rooms/general"));
    // Nothing's changed, so nothing asks.
    expect(location.pathname).toBe("/rooms/general");
  });

  it("takes away the avatar an administrator uploaded with Remove avatar, once it's saved", async () => {
    serve({ loaded: () => answer({ ...RECAP, avatar: true }) });
    const { user } = showSettings();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Remove avatar" }));
    expect(screen.getByRole("img", { name: "Recap's avatar" })).toHaveAttribute("src", defaultBotAvatar);
    expect(screen.queryByRole("button", { name: "Remove avatar" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await wentBack();
    expect(sent()).toEqual([[`DELETE /api/account/agents/${RECAP.id}/avatar`, undefined]]);
  });

  it("asks before the page is left with changes", async () => {
    const { user } = showSettings();
    await user.type(await loaded(), " Bot");
    act(() => navigate("/rooms/general"));
    expect(await screen.findByRole("dialog", { name: "Unsaved Changes" })).toHaveAccessibleDescription(AGENT_CHANGES);
  });

  it("goes back to the AI assistant tab once the dialog's Save has saved the changes, when signing out then fails, as its own Save does", async () => {
    const { user } = showSettings();
    await user.type(await loaded(), " Bot");
    const signOut = vi.fn(async () => false);
    act(() => leave(signOut));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await wentBack();
    expect(signOut).toHaveBeenCalledOnce();
    expect(sent()).toEqual([[`PATCH /api/account/agents/${RECAP.id}`, { name: "Recap Bot" }]]);
  });

  it("answers the 404 page for an id that isn't an agent's", async () => {
    serve({ loaded: () => refused(404, "Not found") });
    const { onMissing, onFailed } = showSettings();
    await waitFor(() => expect(onMissing).toHaveBeenCalledOnce());
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("answers the 404 page when the agent has gone by the time it's saved", async () => {
    serve({ sent: () => refused(404, "Not found") });
    const { onMissing, user } = showSettings();
    await user.type(await loaded(), " Bot");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onMissing).toHaveBeenCalledOnce());
  });

  it("answers the 404 page when the agent has gone by the time the dialog's Save sends it, as its own Save does", async () => {
    serve({ sent: () => refused(404, "Not found") });
    const { onMissing, onFailed, user } = showSettings();
    await user.type(await loaded(), " Bot");
    act(() => navigate("/rooms/general"));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(onMissing).toHaveBeenCalledOnce());
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("sends anyone but an administrator to workspace settings at once, reading nothing, saying why", async () => {
    const { onFailed } = showSettings({ ...ada, administrator: false });
    expect(await screen.findByRole("alert")).toHaveTextContent(AGENTS_FORBIDDEN);
    expect(location.pathname).toBe("/account/edit");
    expect(fetch).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });
});

describe("Delete an agent", () => {
  it("deletes the agent once it's confirmed, then goes back to the AI assistant tab", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user } = showSettings();
    await loaded();
    const remove = screen.getByRole("button", { name: "Delete Recap" });
    await user.click(remove);
    expect(confirm).toHaveBeenLastCalledWith(CONFIRM_DELETE_AGENT);
    expect(sent()).toEqual([]);
    await user.click(remove);
    await wentBack();
    expect(sent()).toEqual([[`DELETE /api/account/agents/${RECAP.id}`, undefined]]);
  });

  it("can't save or delete the agent while a deletion is on its way, and leaves why one failed to the workspace's alerts", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let fail = () => {};
    serve({ deleted: () => new Promise((resolve) => (fail = () => resolve(refused(500, "Something went wrong")))) });
    const { onFailed, user } = showSettings();
    await loaded();
    await user.click(screen.getByRole("button", { name: "Delete Recap" }));
    for (const name of ["Save changes", "Delete Recap"]) expect(screen.getByRole("button", { name })).toBeDisabled();

    act(() => fail());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(500, "Something went wrong")));
    for (const name of ["Save changes", "Delete Recap"]) expect(screen.getByRole("button", { name })).toBeEnabled();
    expect(location.pathname).toBe(agentSettingsPath(RECAP.id));
  });
});
