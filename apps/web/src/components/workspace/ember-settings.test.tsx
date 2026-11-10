import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASSISTANT_ID, AVATAR_TOO_LARGE, MAX_AVATAR_SIZE, type DirectoryUser, type Me, type WorkspaceSettings } from "@ember/protocol";
import { AGENTS_FORBIDDEN } from "@ember/protocol/agents";
import {
  ASSISTANT_MODELS,
  ASSISTANT_OFF,
  cannotSearchWith,
  DEFAULT_MODEL_KEPT,
  MAX_ASSISTANT_MODELS,
  MODELS_FULL,
  TOP_LEVELS,
  WEB_SEARCH_CHANGED,
  type AnswerLevels,
  type AssistantCatalog,
  type AssistantChanges,
  type AssistantModel,
  type AssistantSettings as Assistant,
  type NewAssistantModel,
  type WebSearchChanged,
  type WebTool,
} from "@ember/protocol/assistant";
import { FlashProvider } from "@/components/flash";
import { Sheet } from "@/components/ui/sheet";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { agentSettingsPath, navigate } from "@/hooks/use-route";
import { ApiError } from "@/lib/api";
import { AGENTS_PATH } from "./agent-list";
import { searchTurnedOff } from "./assistant-setup";
import {
  AVATAR_EXPLAINED,
  EMBER_EXPLAINED,
  EmberPage,
  EmberSettings,
  INSTRUCTIONS_EXPLAINED,
  INSTRUCTIONS_UNSAVED,
  lengthOf,
  LIMITS_EXPLAINED,
  MODELS_EXPLAINED,
  searchingWith,
  UPLOADED_AVATAR_EXPLAINED,
  WEB_SEARCH_OFF,
  webSearchOn,
} from "./ember-settings";
import { CATALOG_UNREAD } from "./model-picker";
import { aroundExplained } from "./prompt-preview";
import { CHANGES_SAVED } from "./settings-page";

vi.mock("@/lib/previews", () => ({ avatarVariantOf: vi.fn(async () => new Blob(["variant"], { type: "image/webp" })) }));

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
/** @ember's avatar while it's Ember's flame, and once an administrator has uploaded a picture. */
const FLAME = "/users/ember.abc/avatar?v=20261101120000";
const UPLOADED = "/users/ember.abc/avatar?v=20261105120000";

/** The model `id`, as Ember knows it, or else as it would know one it doesn't. */
function known(id: string): AssistantModel {
  const { name, format } = ASSISTANT_MODELS.find((model) => model.id === id) ?? { name: id, format: "chat" as const };
  return { id, name, format };
}

/**
 * Ember AI on, running on `model`, with `most` the most its dials go to, people able to pick `others` too,
 * and doing `webTools` on the web: nothing yet for Anthropic's and OpenAI's models, which can search, and
 * null for the rest, which can't.
 */
const on = (model: string, most: AnswerLevels = TOP_LEVELS, others: string[] = [], webTools: WebTool[] | null = /^(?:anthropic|openai)\//.test(model) ? [] : null): Assistant => ({
  accountId: ACCOUNT_ID,
  model,
  models: [model, ...others].map(known),
  most,
  webTools,
  instructions: "",
  avatarUrl: FLAME,
  avatar: false,
});

type Answer<T = void> = (given: T) => Response | Promise<Response>;

/** Cloudflare's catalog, as the Worker lists it, Workers AI's models first. */
const CATALOG: AssistantCatalog = {
  models: [known("@cf/zai-org/glm-4.7-flash"), known("anthropic/claude-sonnet-5.5"), { ...known("openai/gpt-6.1-sol"), price: { input: 2, output: 10 } }],
  refusal: null,
};

/**
 * Answers turning Ember AI off, changing it, taking a model out, listing Cloudflare's catalog, adding a
 * model, and uploading @ember's avatar and taking it away as the server would, or as `stopped`, `changed`,
 * `removed`, `listed`, `added`, `pictured` and `unpictured` say, and reading Ember AI again as another
 * tab's upload left it, or as `read` says.
 */
function serve({
  stopped = () => Response.json({ assistant: null }),
  changed = ({ model, ...levels }) => Response.json({ assistant: on(model ?? "@cf/zai-org/glm-4.7-flash", { ...TOP_LEVELS, ...levels }) }),
  removed = () => Response.json({ assistant: on("@cf/zai-org/glm-4.7-flash") }),
  listed = () => Response.json(CATALOG),
  added = ({ model }) => Response.json({ assistant: on("anthropic/claude-sonnet-5.5", TOP_LEVELS, [model]), greeting: "Hello! I'm here to help." }),
  pictured = () => Response.json({ assistant: { ...on("anthropic/claude-sonnet-5.5"), avatarUrl: UPLOADED, avatar: true } }),
  unpictured = () => Response.json({ assistant: on("anthropic/claude-sonnet-5.5") }),
  read = () => Response.json({ assistant: { ...on("anthropic/claude-sonnet-5.5"), avatarUrl: UPLOADED, avatar: true } }),
}: {
  stopped?: Answer;
  changed?: Answer<AssistantChanges>;
  removed?: Answer<string>;
  listed?: Answer;
  added?: Answer<NewAssistantModel>;
  pictured?: Answer<FormData>;
  unpictured?: Answer;
  read?: Answer;
} = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    const body = () => JSON.parse(String(init?.body)) as unknown;
    if (request === "DELETE /api/account/assistant") return stopped();
    if (request === "PATCH /api/account/assistant") return changed(body() as AssistantChanges);
    if (request === "DELETE /api/account/assistant/models") return removed((body() as { model: string }).model);
    if (request === "POST /api/account/assistant/catalog") return listed();
    if (request === "POST /api/account/assistant/models") return added(body() as NewAssistantModel);
    if (request === "PUT /api/account/assistant/avatar") return pictured(init?.body as FormData);
    if (request === "DELETE /api/account/assistant/avatar") return unpictured();
    if (request === "GET /api/account") return read();
    throw new Error(`Unexpected request for ${request}`);
  });
}

/** A response the test lets through when it says, with `answer` letting it through. */
function held(response: () => Response) {
  let answer = () => {};
  const answered = new Promise<Response>((resolve) => (answer = () => resolve(response())));
  return { answered: () => answered, answer: () => act(async () => answer()) };
}

/** The administrator looking, whom What Ember adds around them shows asking @ember. */
const ada: Me = { id: "0mgk3x2a9b4c5d", name: "Ada Lovelace", administrator: true };

/** The workspace as the page shows it, by the name its prompt gives @ember. */
const Community = ({ children }: { children: React.ReactNode }) => <AccountContext value={{ ...useAccount(), name: "Analytical Engines" }}>{children}</AccountContext>;

/**
 * @ember's settings, for a workspace whose Ember AI is `assistant`, with everyone the people directory
 * lists, `people`, as the workspace has them, which `showPeople` changes.
 */
function showCard(assistant: Assistant, people: People = new Map()) {
  const callbacks = { onSetUp: vi.fn(), onStopped: vi.fn(), onChanged: vi.fn(), onFailed: vi.fn() };
  const shown = (listed: People) => (
    <Community>
      <PeopleContext value={listed}>
        <FlashProvider workspace>
          <EmberSettings me={ada} assistant={assistant} {...callbacks} />
        </FlashProvider>
      </PeopleContext>
    </Community>
  );
  const { rerender } = render(shown(people));
  return { ...callbacks, user: userEvent.setup(), showPeople: (listed: People) => rerender(shown(listed)) };
}

/** @ember's settings, showing Ember AI as each change to it leaves it, as @ember's page does, with `people` as `showCard` has them. */
function showLiveCard(assistant: Assistant, people: People = new Map()) {
  const callbacks = { onSetUp: vi.fn(), onStopped: vi.fn(), onFailed: vi.fn() };
  function Live() {
    const [shown, setShown] = useState(assistant);
    return <EmberSettings me={ada} assistant={shown} onChanged={setShown} {...callbacks} />;
  }
  const shown = (listed: People) => (
    <Community>
      <PeopleContext value={listed}>
        <FlashProvider workspace>
          <Live />
        </FlashProvider>
      </PeopleContext>
    </Community>
  );
  const { rerender } = render(shown(people));
  return { ...callbacks, user: userEvent.setup(), showPeople: (listed: People) => rerender(shown(listed)) };
}

const card = () => screen.getByRole("region", { name: "@ember" });
const picker = () => within(card()).getByLabelText("Upload @ember's avatar");
const addModel = () => within(card()).getByRole("button", { name: "Add a model" });
const webSwitch = () => within(card()).getByRole("switch", { name: "Search the web" });

afterEach(() => vi.restoreAllMocks());

describe("@ember's page", () => {
  const SONNET = on("anthropic/claude-sonnet-5.5");
  /** What reading Ember AI answers while it's `assistant`. */
  const readAs = (assistant: Assistant | null) => () => Response.json({ assistant, cloudflareAccountId: null });

  /** @ember's page at its address, as the workspace shows it, for `me`. */
  function showPage(me = ada) {
    const onFailed = vi.fn();
    history.replaceState(null, "", agentSettingsPath(ASSISTANT_ID));
    render(
      <Community>
        <FlashProvider workspace>
          <Sheet>
            <EmberPage me={me} onFailed={onFailed} />
          </Sheet>
        </FlashProvider>
      </Community>,
    );
    return { onFailed, user: userEvent.setup() };
  }

  afterEach(() => history.replaceState(null, "", "/"));

  it("is titled Edit agent and headed Ember, with Go Back to the AI assistant tab, showing @ember's settings once Ember AI is read", async () => {
    serve({ read: readAs(SONNET) });
    showPage();
    expect(document.title).toBe("Edit agent");
    expect(screen.getByRole("heading", { level: 1, name: "Ember" })).toBeInTheDocument();
    expect(screen.getByText(EMBER_EXPLAINED)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", AGENTS_PATH);
    expect(await screen.findByRole("region", { name: "@ember" })).toBeInTheDocument();
    expect(within(card()).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Avatar", "Instructions", "Models", "Search the web", "Limits"]);
  });

  it("sends anyone but an administrator to workspace settings at once, reading nothing, saying why", async () => {
    const fetch = serve();
    const { onFailed } = showPage({ ...ada, administrator: false });
    expect(await screen.findByRole("alert")).toHaveTextContent(AGENTS_FORBIDDEN);
    expect(location.pathname).toBe("/account/edit");
    expect(fetch).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("sends an administrator to the AI assistant tab while Ember AI is off, saying so", async () => {
    serve({ read: readAs(null) });
    const { onFailed } = showPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(ASSISTANT_OFF);
    expect(location.pathname + location.hash).toBe(AGENTS_PATH);
    expect(screen.queryByRole("region", { name: "@ember" })).toBeNull();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("goes to the AI assistant tab once a change finds Ember AI turned off in another tab, saying so", async () => {
    serve({ read: readAs(SONNET), changed: () => Response.json({ error: ASSISTANT_OFF }, { status: 409 }) });
    const { user, onFailed } = showPage();
    await screen.findByRole("region", { name: "@ember" });
    await user.click(within(card()).getByRole("radio", { name: "Low" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ASSISTANT_OFF);
    expect(location.pathname + location.hash).toBe(AGENTS_PATH);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("goes to the AI assistant tab once turning Search the web on finds Ember AI turned off in another tab, saying so", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = `${init?.method ?? "GET"} ${String(input)}`;
      if (request === "GET /api/account") return readAs(SONNET)();
      if (request === "PUT /api/account/assistant/web_search") return Response.json({ error: ASSISTANT_OFF }, { status: 409 });
      throw new Error(`Unexpected request for ${request}`);
    });
    const { user, onFailed } = showPage();
    await screen.findByRole("region", { name: "@ember" });
    await user.click(webSwitch());
    expect(await screen.findByRole("alert")).toHaveTextContent(ASSISTANT_OFF);
    expect(location.pathname + location.hash).toBe(AGENTS_PATH);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("leaves a failure to read Ember AI to the workspace's alerts", async () => {
    serve({ read: () => Response.json({ error: "Something went wrong" }, { status: 500 }) });
    const { onFailed } = showPage();
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(500, "Something went wrong")));
    expect(location.pathname).toBe(agentSettingsPath(ASSISTANT_ID));
  });

  it("opens Set up Ember AI over the page for Search the web with a model that can't search, to choose another", async () => {
    serve({ read: readAs(on("@cf/zai-org/glm-4.7-flash")), listed: () => Response.json(CATALOG) });
    const { user } = showPage();
    await screen.findByRole("region", { name: "@ember" });
    await user.click(webSwitch());
    expect(await screen.findByRole("dialog", { name: "Set up Ember AI" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Account ID" })).toHaveValue(ACCOUNT_ID);
  });
});

describe("Instructions", () => {
  const box = () => within(card()).getByRole("textbox", { name: "Instructions" });
  const save = () => within(card()).getByRole("button", { name: "Save instructions" });
  const SONNET = on("anthropic/claude-sonnet-5.5");
  const BRITISH: Assistant = { ...SONNET, instructions: "Answer in British English." };
  /** The preview of what Ember adds around them. */
  const preview = () => within(card()).getByText("What Ember adds around them").closest("details")!;

  beforeEach(() => history.replaceState(null, "", agentSettingsPath(ASSISTANT_ID)));
  afterEach(() => history.replaceState(null, "", "/"));

  it("shows what administrators add to Ember's own, which Save instructions saves once what's typed differs", async () => {
    serve();
    const { user } = showCard(BRITISH);
    expect(box()).toHaveValue("Answer in British English.");
    expect(box()).toHaveAccessibleDescription(`${INSTRUCTIONS_EXPLAINED} ${lengthOf("Answer in British English.")}`);
    expect(box()).toHaveAttribute("maxlength", "10000");
    expect(save()).toBeDisabled();

    await user.type(box(), " Keep it short.");
    expect(save()).toBeEnabled();
    expect(card()).toHaveTextContent("41 of 10,000 characters");
    // Spaces around what's typed don't make it different.
    await user.clear(box());
    await user.type(box(), "  Answer in British English. ");
    expect(save()).toBeDisabled();
  });

  it("saves what's typed, without the spaces around it, holding everything else meanwhile, with a notice", async () => {
    const answer = held(() => Response.json({ assistant: { ...SONNET, instructions: "Keep it short." } }));
    const fetch = serve({ changed: answer.answered });
    const { user } = showLiveCard(SONNET);
    await user.type(box(), "  Keep it short. ");
    await user.click(save());
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ instructions: "Keep it short." }) }));
    expect(save()).toBeDisabled();
    expect(addModel()).toBeDisabled();
    expect(webSwitch()).toBeDisabled();

    await answer.answer();
    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(box()).toHaveValue("Keep it short.");
    expect(save()).toBeDisabled();
    expect(addModel()).toBeEnabled();
  });

  it("keeps what's typed when saving fails, leaving why to the page's alerts", async () => {
    serve({ changed: () => Response.json({ error: "Something went wrong" }, { status: 500 }) });
    const { user, onFailed } = showLiveCard(SONNET);
    await user.type(box(), "Keep it short.");
    await user.click(save());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(500, "Something went wrong")));
    expect(box()).toHaveValue("Keep it short.");
    expect(save()).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows what Ember adds around them, as @ember reads it when the administrator writes to it directly", () => {
    serve();
    showCard(SONNET);
    expect(preview()).not.toHaveAttribute("open");
    expect(preview()).toHaveTextContent(aroundExplained("@ember"));
    expect(preview()).toHaveTextContent(`You are Ember, the AI assistant in the team chat "Analytical Engines".`);
    expect(preview()).toHaveTextContent("Your instructions");
    expect(preview()).toHaveTextContent("You're asked in a direct message. Its messages follow, oldest first, each after its writer's name. Answer the last one, which Ada Lovelace wrote, as a helpful teammate would: plainly, and in at most about 400 words.");
    expect(preview()).toHaveTextContent("You can't search the web or open links.");
  });

  it("shows @ember told to answer no longer than Limits let it answer anyone", () => {
    serve();
    showCard(on("anthropic/claude-sonnet-5.5", { ...TOP_LEVELS, length: "short" }));
    expect(preview()).toHaveTextContent("Answer the last one, which Ada Lovelace wrote, as a helpful teammate would: plainly, and in at most about 150 words.");
  });

  it("shows @ember told it can search the web while Search the web is on", () => {
    serve();
    showCard(on("anthropic/claude-sonnet-5.5", TOP_LEVELS, [], ["search", "read"]));
    expect(preview()).toHaveTextContent("You can search the web, and read the pages people link to or your searches find, when a question needs what's current");
  });

  it("asks before the page is left with what's typed unsaved, and saves it with Save", async () => {
    const fetch = serve({ changed: () => Response.json({ assistant: { ...SONNET, instructions: "Keep it short." } }) });
    const { user } = showLiveCard(SONNET);
    await user.type(box(), "Keep it short.");
    act(() => navigate("/rooms/general"));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved Changes" });
    expect(dialog).toHaveAccessibleDescription(INSTRUCTIONS_UNSAVED);
    expect(location.pathname).toBe(agentSettingsPath(ASSISTANT_ID));

    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(location.pathname).toBe("/rooms/general"));
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ instructions: "Keep it short." }) }));
  });

  it("keeps what's typed while they save unsaved, asking before the page is left with it", async () => {
    const answer = held(() => Response.json({ assistant: { ...SONNET, instructions: "Keep it short." } }));
    serve({ changed: answer.answered });
    const { user } = showLiveCard(SONNET);
    await user.type(box(), "Keep it short.");
    await user.click(save());
    await user.type(box(), " Use British English.");
    await answer.answer();
    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(box()).toHaveValue("Keep it short. Use British English.");
    expect(save()).toBeEnabled();

    act(() => navigate("/rooms/general"));
    expect(await screen.findByRole("dialog", { name: "Unsaved Changes" })).toHaveAccessibleDescription(INSTRUCTIONS_UNSAVED);
    expect(location.pathname).toBe(agentSettingsPath(ASSISTANT_ID));
  });

  it("asks before the page is left with what's typed unsaved while another change saves", async () => {
    const answer = held(() => Response.json({ assistant: on("anthropic/claude-sonnet-5.5", { ...TOP_LEVELS, thinking: "low" }) }));
    serve({ changed: answer.answered });
    const { user } = showLiveCard(SONNET);
    await user.type(box(), "Keep it short.");
    await user.click(within(card()).getByRole("radio", { name: "Low" }));
    expect(save()).toBeDisabled();
    act(() => navigate("/rooms/general"));
    expect(await screen.findByRole("dialog", { name: "Unsaved Changes" })).toHaveAccessibleDescription(INSTRUCTIONS_UNSAVED);
    expect(location.pathname).toBe(agentSettingsPath(ASSISTANT_ID));
    await answer.answer();
  });
});

describe("Avatar", () => {
  const avatar = () => within(card()).getByRole("img", { name: "@ember's avatar" });
  const useTheFlame = () => within(card()).queryByRole("button", { name: "Use Ember's flame" });
  const SONNET = on("anthropic/claude-sonnet-5.5");
  const PICTURED: Assistant = { ...SONNET, avatarUrl: UPLOADED, avatar: true };
  const moon = () => new File(["moon"], "moon.jpg", { type: "image/jpeg" });
  /** What each picture saved sent, in order. */
  const uploads = () =>
    vi
      .mocked(fetch)
      .mock.calls.filter(([input, init]) => `${init?.method} ${String(input)}` === "PUT /api/account/assistant/avatar")
      .map(([, init]) => init?.body as FormData);
  /** How many times Ember AI was read again. */
  const reads = () => vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/account" && init?.method === undefined).length;
  /** @ember as the people directory lists it, with its avatar at `avatarUrl`. */
  const listed = (avatarUrl: string): People =>
    new Map([[ASSISTANT_ID, { id: ASSISTANT_ID, name: "Ember", bio: null, role: "bot", status: "active", avatarUrl } satisfies DirectoryUser]]);

  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:moon");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("shows Ember's flame while Ember AI is on, which a picture picked replaces", () => {
    serve();
    showCard(SONNET);
    expect(avatar()).toHaveAttribute("src", FLAME);
    expect(picker()).toBeEnabled();
    expect(picker()).toHaveAttribute("type", "file");
    expect(picker()).toHaveAttribute("accept", "image/*");
    expect(picker()).toHaveAccessibleDescription(AVATAR_EXPLAINED);
    // Nothing to take away while it's the flame.
    expect(useTheFlame()).toBeNull();
  });

  it("saves a picture as soon as it's picked, showing it meanwhile, with its variant and a notice", async () => {
    const answer = held(() => Response.json({ assistant: PICTURED }));
    serve({ pictured: answer.answered });
    const { user, onFailed } = showLiveCard(SONNET);
    await user.upload(picker(), moon());

    await waitFor(() => expect(uploads()).toHaveLength(1));
    expect(avatar()).toHaveAttribute("src", "blob:moon");
    // Nothing else changes while it saves, so that its answer can't show Ember AI as it was.
    expect(picker()).toBeDisabled();
    expect(addModel()).toBeDisabled();
    expect(webSwitch()).toBeDisabled();
    const [sent] = uploads();
    expect(sent!.get("avatar")).toMatchObject({ name: "moon.jpg", type: "image/jpeg" });
    expect(sent!.get("variant")).toMatchObject({ type: "image/webp" });

    await answer.answer();
    expect(await screen.findByRole("alert")).toHaveTextContent(CHANGES_SAVED);
    expect(avatar()).toHaveAttribute("src", UPLOADED);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:moon");
    expect(picker()).toBeEnabled();
    expect(picker()).toHaveAccessibleDescription(UPLOADED_AVATAR_EXPLAINED);
    expect(useTheFlame()).toBeEnabled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("brings back Ember's flame with Use Ember's flame, saying nothing", async () => {
    const flameAgain = "/users/ember.abc/avatar?v=20261105130000";
    const fetch = serve({ unpictured: () => Response.json({ assistant: { ...SONNET, avatarUrl: flameAgain } }) });
    const { user } = showLiveCard(PICTURED);
    expect(avatar()).toHaveAttribute("src", UPLOADED);
    await user.click(useTheFlame()!);

    await waitFor(() => expect(useTheFlame()).toBeNull());
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant/avatar", expect.objectContaining({ method: "DELETE" }));
    expect(avatar()).toHaveAttribute("src", flameAgain);
    expect(picker()).toHaveAccessibleDescription(AVATAR_EXPLAINED);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says a picture over 16 MB is too large without sending it", async () => {
    serve();
    const { user, onChanged } = showCard(SONNET);
    const huge = moon();
    Object.defineProperty(huge, "size", { value: MAX_AVATAR_SIZE + 1 });
    await user.upload(picker(), huge);

    expect(await screen.findByRole("alert")).toHaveTextContent(AVATAR_TOO_LARGE);
    expect(uploads()).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
    expect(avatar()).toHaveAttribute("src", FLAME);
  });

  it("leaves a picture that couldn't be saved to the page's alerts, showing the avatar as it was", async () => {
    serve({ pictured: () => Response.json({ error: "Ember isn't set up to store files" }, { status: 503 }) });
    const { user, onChanged, onFailed } = showCard(SONNET);
    await user.upload(picker(), moon());

    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(503, "Ember isn't set up to store files")));
    expect(onChanged).not.toHaveBeenCalled();
    expect(avatar()).toHaveAttribute("src", FLAME);
    expect(picker()).toBeEnabled();
  });

  it("can't be changed while another change saves, so that its answer can't show the avatar as it was", async () => {
    const answer = held(() => Response.json({ assistant: { ...SONNET, most: { ...TOP_LEVELS, thinking: "low" } } }));
    serve({ changed: answer.answered });
    const { user } = showCard(PICTURED);
    await user.click(within(card()).getByRole("radio", { name: "Low" }));
    expect(picker()).toBeDisabled();
    expect(useTheFlame()).toBeDisabled();
    await answer.answer();
    expect(picker()).toBeEnabled();
    expect(useTheFlame()).toBeEnabled();
  });

  it("shows the avatar as another tab changes it, once the people directory hears, reading Ember AI again for Use Ember's flame", async () => {
    serve();
    const { showPeople, onFailed } = showLiveCard(SONNET, listed("/users/ember.abc/avatar?v=20261031120000"));
    // The directory can list an avatar from before the card's settings were read.
    expect(avatar()).toHaveAttribute("src", FLAME);
    expect(reads()).toBe(0);
    showPeople(listed(UPLOADED));
    expect(avatar()).toHaveAttribute("src", UPLOADED);

    expect(await within(card()).findByRole("button", { name: "Use Ember's flame" })).toBeEnabled();
    expect(picker()).toHaveAccessibleDescription(UPLOADED_AVATAR_EXPLAINED);
    expect(reads()).toBe(1);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("takes away Use Ember's flame once another tab brings back the flame", async () => {
    const flameAgain = "/users/ember.abc/avatar?v=20261105130000";
    serve({ read: () => Response.json({ assistant: { ...SONNET, avatarUrl: flameAgain } }) });
    const { showPeople } = showLiveCard(PICTURED, listed(UPLOADED));
    expect(useTheFlame()).toBeEnabled();
    showPeople(listed(flameAgain));

    await waitFor(() => expect(useTheFlame()).toBeNull());
    expect(avatar()).toHaveAttribute("src", flameAgain);
    expect(picker()).toHaveAccessibleDescription(AVATAR_EXPLAINED);
  });

  it("shows Ember AI off once it's read again after another tab turns it off", async () => {
    serve({ read: () => Response.json({ assistant: null }) });
    const { showPeople, onStopped } = showLiveCard(PICTURED, listed(UPLOADED));
    showPeople(listed("/users/ember.abc/avatar?v=20261105130000"));
    await waitFor(() => expect(onStopped).toHaveBeenCalledTimes(1));
  });

  it("doesn't read Ember AI again for a picture it saves itself, which the directory may hear of before its answer", async () => {
    const answer = held(() => Response.json({ assistant: PICTURED }));
    serve({ pictured: answer.answered });
    const { user, showPeople } = showLiveCard(SONNET, listed(FLAME));
    await user.upload(picker(), moon());
    await waitFor(() => expect(uploads()).toHaveLength(1));
    showPeople(listed(UPLOADED));

    await answer.answer();
    expect(useTheFlame()).toBeEnabled();
    expect(reads()).toBe(0);
  });

  it("drops a read begun before a change of its own, which could show Ember AI as it was before the change", async () => {
    const read = held(() => Response.json({ assistant: PICTURED }));
    const saved = held(() => Response.json({ assistant: { ...PICTURED, most: { ...TOP_LEVELS, thinking: "low" } } }));
    serve({ read: read.answered, changed: saved.answered });
    const { user } = showLiveCard(SONNET, listed(UPLOADED));
    await waitFor(() => expect(reads()).toBe(1));
    const low = within(card()).getByRole("radio", { name: "Low" });
    await user.click(low);
    await read.answer();
    expect(low).toBeChecked();

    await saved.answer();
    expect(low).toBeChecked();
    expect(useTheFlame()).toBeEnabled();
    expect(reads()).toBe(1);
  });

  it("reads Ember AI again once a change of its own that dropped a read fails", async () => {
    const first = held(() => Response.json({ assistant: PICTURED }));
    let answered = 0;
    serve({
      read: () => (answered++ === 0 ? first.answered() : Response.json({ assistant: PICTURED })),
      changed: () => Response.json({ error: "Something went wrong" }, { status: 500 }),
    });
    const { user, onFailed } = showLiveCard(SONNET, listed(UPLOADED));
    await waitFor(() => expect(reads()).toBe(1));
    await user.click(within(card()).getByRole("radio", { name: "Low" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());

    expect(await within(card()).findByRole("button", { name: "Use Ember's flame" })).toBeEnabled();
    expect(within(card()).getByRole("radio", { name: "High" })).toBeChecked();
    expect(reads()).toBe(2);
  });
});

describe("Models", () => {
  const models = () => within(card()).getByRole("group", { name: "Models" });
  const model = (name: string) => within(models()).getByRole("radio", { name });
  const SEVERAL = on("anthropic/claude-sonnet-5.5", TOP_LEVELS, ["@cf/zai-org/glm-4.7-flash", "openai/gpt-6.1-sol"]);

  it("lists the models people can pick, the one that answers everyone else chosen, with Remove for the others", () => {
    serve();
    showCard(SEVERAL);
    expect(models()).toHaveAccessibleDescription(MODELS_EXPLAINED);
    expect(within(models()).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual(["Claude Sonnet 5.5", "GLM-4.7 Flash", "GPT-6.1 Sol"]);
    expect(model("Claude Sonnet 5.5")).toBeChecked();
    expect(within(models()).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Remove GLM-4.7 Flash", "Remove GPT-6.1 Sol"]);
    expect(addModel()).toBeEnabled();
  });

  it("saves another model chosen to answer everyone at once, showing it meanwhile", async () => {
    const answer = held(() => Response.json({ assistant: { ...SEVERAL, model: "openai/gpt-6.1-sol" } }));
    const fetch = serve({ changed: answer.answered });
    const { user, onChanged } = showCard(SEVERAL);
    await user.click(model("GPT-6.1 Sol"));
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ model: "openai/gpt-6.1-sol" }) }));
    expect(onChanged).toHaveBeenCalledWith({ ...SEVERAL, model: "openai/gpt-6.1-sol" });
    expect(model("GLM-4.7 Flash")).toBeDisabled();
    expect(addModel()).toBeDisabled();
    expect(webSwitch()).toBeDisabled();
    await answer.answer();
    expect(onChanged).toHaveBeenLastCalledWith({ ...SEVERAL, model: "openai/gpt-6.1-sol" });
    expect(model("GLM-4.7 Flash")).toBeEnabled();
  });

  it("takes a model out at once with its Remove, showing it gone meanwhile", async () => {
    const answer = held(() => Response.json({ assistant: on("anthropic/claude-sonnet-5.5", TOP_LEVELS, ["openai/gpt-6.1-sol"]) }));
    const fetch = serve({ removed: answer.answered });
    const { user, onChanged } = showCard(SEVERAL);
    await user.click(within(models()).getByRole("button", { name: "Remove GLM-4.7 Flash" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/account/assistant/models",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify({ model: "@cf/zai-org/glm-4.7-flash" }) }),
    );
    expect(onChanged).toHaveBeenCalledWith({ ...SEVERAL, models: [known("anthropic/claude-sonnet-5.5"), known("openai/gpt-6.1-sol")] });
    expect(within(models()).getByRole("button", { name: "Remove GPT-6.1 Sol" })).toBeDisabled();
    await answer.answer();
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(within(models()).getByRole("button", { name: "Remove GPT-6.1 Sol" })).toBeEnabled();
  });

  it("shows the models as they were again when a change isn't saved, leaving why to the page's alerts", async () => {
    serve({ removed: () => Response.json({ error: DEFAULT_MODEL_KEPT }, { status: 409 }) });
    const { user, onChanged, onFailed } = showCard(SEVERAL);
    await user.click(within(models()).getByRole("button", { name: "Remove GPT-6.1 Sol" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(409, DEFAULT_MODEL_KEPT)));
    expect(onChanged.mock.calls).toEqual([[{ ...SEVERAL, models: [known("anthropic/claude-sonnet-5.5"), known("@cf/zai-org/glm-4.7-flash")] }], [SEVERAL]]);
  });

  it("can't add a model once people can pick from as many as there can be", () => {
    serve();
    const others = Array.from({ length: MAX_ASSISTANT_MODELS - 1 }, (_, index) => `@cf/meta/model-${index}`);
    showCard(on("anthropic/claude-sonnet-5.5", TOP_LEVELS, others));
    expect(addModel()).toBeDisabled();
    expect(addModel()).toHaveAccessibleDescription(MODELS_FULL);
  });
});

describe("Add a model", () => {
  const dialog = () => screen.getByRole("dialog");
  const menu = () => within(dialog()).getByRole("combobox", { name: "Model" });

  /** Opens Add a model from the card, for a workspace whose Ember AI is `assistant`, once its catalog is listed. */
  async function openDialog(assistant: Assistant = on("anthropic/claude-sonnet-5.5")) {
    const shown = showCard(assistant);
    await shown.user.click(within(card()).getByRole("button", { name: "Add a model" }));
    await within(dialog()).findByRole("combobox", { name: "Model" });
    return shown;
  }

  it("offers Cloudflare's catalog's models people can't pick yet, the first of them chosen", async () => {
    const fetch = serve();
    await openDialog();
    expect(dialog()).toHaveAccessibleName("Add a model");
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant/catalog", expect.objectContaining({ method: "POST", body: JSON.stringify({ accountId: ACCOUNT_ID }) }));
    expect(within(menu()).getAllByRole("option").map((option) => option.textContent)).toEqual(["GLM-4.7 Flash", "GPT-6.1 Sol · $2 / $10", "Another model…"]);
    expect(menu()).toHaveValue("@cf/zai-org/glm-4.7-flash");
    expect(dialog()).not.toHaveTextContent(CATALOG_UNREAD);
  });

  it("adds the model chosen once it answers a test question, saying what it said", async () => {
    const fetch = serve();
    const { user, onChanged } = await openDialog();
    await user.selectOptions(menu(), "openai/gpt-6.1-sol");
    expect(dialog()).toHaveTextContent("AI Gateway's credits pay for this model, $2 for each million tokens it reads, and $10 for each million it writes.");
    await user.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/account/assistant/models",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ model: "openai/gpt-6.1-sol", modelName: "GPT-6.1 Sol" }) }),
    );
    expect(await screen.findByRole("dialog", { name: "Model added" })).toHaveTextContent(
      "People can pick GPT-6.1 Sol on their profile now. Asked to say hello, it said:Hello! I'm here to help.",
    );
    expect(onChanged).toHaveBeenCalledWith(on("anthropic/claude-sonnet-5.5", TOP_LEVELS, ["openai/gpt-6.1-sol"]));
    await user.click(within(dialog()).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("adds a model the catalog doesn't list by its ID", async () => {
    const fetch = serve();
    const { user } = await openDialog();
    await user.selectOptions(menu(), "Another model…");
    await user.type(within(dialog()).getByRole("textbox", { name: "Model ID" }), " mistral/mistral-large-3 ");
    await user.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant/models", expect.objectContaining({ body: JSON.stringify({ model: "mistral/mistral-large-3" }) }));
    expect(await screen.findByRole("dialog", { name: "Model added" })).toHaveTextContent("People can pick mistral/mistral-large-3 on their profile now.");
  });

  it("says why a model didn't answer on its menu, adding nothing", async () => {
    const refusal = "The model didn't answer: it isn't one AI Gateway knows.";
    serve({ added: () => Response.json({ error: refusal, field: "model" }, { status: 422 }) });
    const { user, onChanged } = await openDialog();
    await user.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(refusal);
    expect(menu()).toHaveAttribute("aria-invalid", "true");
    expect(menu()).toHaveAccessibleDescription(refusal);
    expect(onChanged).not.toHaveBeenCalled();
    expect(dialog()).toHaveAccessibleName("Add a model");
  });

  it("offers the models Ember knows when the catalog couldn't be read, saying why", async () => {
    const refusal = "Cloudflare's model catalog didn't answer.";
    serve({ listed: () => Response.json({ models: ASSISTANT_MODELS, refusal }) });
    await openDialog();
    expect(dialog()).toHaveTextContent(`${CATALOG_UNREAD} ${refusal}`);
    expect(within(menu()).getAllByRole("option")).toHaveLength(ASSISTANT_MODELS.length);
  });

  it("leaves listing that failed to the page's alerts, closing", async () => {
    serve({ listed: () => Response.json({ error: "Only administrators can set up Ember AI" }, { status: 403 }) });
    const { user, onFailed } = showCard(on("anthropic/claude-sonnet-5.5"));
    await user.click(within(card()).getByRole("button", { name: "Add a model" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can set up Ember AI")));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Limits", () => {
  const dial = (name: string) => within(card()).getByRole("group", { name });
  const level = (name: string) => within(card()).getByRole("radio", { name });

  it("has the most @ember may think and write for anyone's question while Ember AI is on, any level allowed", () => {
    serve();
    showCard(on("anthropic/claude-sonnet-5.5", { thinking: "medium", length: "long" }));
    expect(card()).toHaveTextContent(LIMITS_EXPLAINED);
    expect(within(dial("Thinking")).getByRole("radio", { name: "Medium" })).toBeChecked();
    expect(dial("Thinking")).toHaveAccessibleDescription("Thinks more first, up to about 16,000 tokens.");
    for (const name of ["Off", "Low", "High"]) expect(level(name)).toBeEnabled();
    expect(level("Long")).toBeChecked();
    expect(dial("Answer length")).toHaveAccessibleDescription("About 1,500 words, nearly all one message holds.");
  });

  it("saves a change at once, showing it meanwhile", async () => {
    const answer = held(() => Response.json({ assistant: on("@cf/zai-org/glm-4.7-flash", { thinking: "low", length: "long" }) }));
    const fetch = serve({ changed: answer.answered });
    const shown = on("@cf/zai-org/glm-4.7-flash");
    const { user, onChanged } = showCard(shown);
    await user.click(level("Low"));
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ thinking: "low" }) }));
    expect(onChanged).toHaveBeenCalledWith({ ...shown, most: { thinking: "low", length: "long" } });
    expect(level("Off")).toBeDisabled();
    await answer.answer();
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(level("Off")).toBeEnabled();
  });

  it("holds every other change while one saves, so that its answer can't show Ember AI as it was", async () => {
    const answer = held(() => Response.json({ assistant: on("@cf/zai-org/glm-4.7-flash", { thinking: "low", length: "long" }) }));
    serve({ changed: answer.answered });
    const { user } = showCard(on("@cf/zai-org/glm-4.7-flash"));
    await user.click(level("Low"));
    const others = [picker(), within(card()).getByRole("radio", { name: "GLM-4.7 Flash" }), addModel(), webSwitch()];
    for (const control of others) expect(control).toBeDisabled();
    await answer.answer();
    for (const control of others) expect(control).toBeEnabled();
  });

  it("shows the most as it was again when a change isn't saved, leaving why to the page's alerts", async () => {
    serve({ changed: () => Response.json({ error: ASSISTANT_OFF }, { status: 409 }) });
    const shown = on("@cf/zai-org/glm-4.7-flash");
    const { user, onChanged, onFailed } = showCard(shown);
    await user.click(level("Short"));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(409, ASSISTANT_OFF)));
    expect(onChanged.mock.calls).toEqual([[{ ...shown, most: { thinking: "high", length: "short" } }], [shown]]);
    expect(level("Short")).toBeEnabled();
  });
});

describe("Search the web", () => {
  const SONNET = "anthropic/claude-sonnet-5.5";
  const FOUND = "AI Gateway is Cloudflare's proxy for requests to AI models.";

  /** Answers turning Search the web on or off as `changed` says, keeping what the card sent. */
  function serveWebSearch(changed: (on: boolean) => Response | Promise<Response>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (`${init?.method} ${String(input)}` !== "PUT /api/account/assistant/web_search") throw new Error(`Unexpected request for ${init?.method} ${String(input)}`);
      return changed((JSON.parse(String(init?.body)) as { on: boolean }).on);
    });
  }

  /** What the server answers once it has turned Search the web `on` with `webTools`, or off. */
  const turned = (on_: boolean, webTools: WebTool[] = ["search", "read"]) =>
    Response.json({ assistant: on(SONNET, TOP_LEVELS, [], on_ ? webTools : []), found: on_ ? FOUND : null } satisfies WebSearchChanged);

  it("is off for a model that can search until it's turned on, saying what turning it on lets @ember do", () => {
    serveWebSearch(() => turned(true));
    showLiveCard(on(SONNET));
    expect(webSwitch()).not.toBeChecked();
    expect(webSwitch()).toBeEnabled();
    expect(webSwitch()).toHaveAccessibleDescription(WEB_SEARCH_OFF);
    expect(within(card()).getByRole("status")).toHaveTextContent("");
  });

  it("turns on once the model has searched the web, saying what it found, with everything else held meanwhile", async () => {
    const answer = held(() => turned(true));
    const fetch = serveWebSearch(answer.answered);
    const { user } = showLiveCard(on(SONNET));

    await user.click(webSwitch());
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant/web_search", expect.objectContaining({ method: "PUT", body: JSON.stringify({ on: true }) }));
    expect(webSwitch()).toBeChecked();
    expect(webSwitch()).toBeDisabled();
    expect(within(card()).getByRole("status")).toHaveTextContent(searchingWith("Claude Sonnet 5.5"));
    expect(picker()).toBeDisabled();
    expect(addModel()).toBeDisabled();
    expect(within(card()).getByRole("radio", { name: "Claude Sonnet 5.5" })).toBeDisabled();
    expect(within(card()).getByRole("radio", { name: "Low" })).toBeDisabled();

    await answer.answer();
    expect(webSwitch()).toBeChecked();
    expect(webSwitch()).toBeEnabled();
    expect(webSwitch()).toHaveAccessibleDescription(webSearchOn(["search", "read"], [known(SONNET)]));
    expect(webSearchOn(["search", "read"], [known(SONNET)])).toContain("reads the pages people link to or its searches find, at most 3");
    expect(within(card()).getByRole("status")).toHaveTextContent(`It searched the web and said: ${FOUND}`);
    expect(addModel()).toBeEnabled();
  });

  it("says when it only searches, as AI Gateway didn't take the model's tool for reading pages", async () => {
    serveWebSearch(() => turned(true, ["search"]));
    const { user } = showLiveCard(on(SONNET));
    await user.click(webSwitch());
    await waitFor(() => expect(webSwitch()).toBeEnabled());
    expect(webSwitch()).toHaveAccessibleDescription(webSearchOn(["search"], [known(SONNET)]));
    expect(webSearchOn(["search"], [known(SONNET)])).not.toContain("reads");
  });

  it("says, while people can pick other models, that a model someone picks searches too, if it's Anthropic's or OpenAI's", () => {
    serveWebSearch(() => turned(false));
    showLiveCard(on(SONNET, TOP_LEVELS, ["openai/gpt-6.1-sol", "@cf/zai-org/glm-4.7-flash"], ["search", "read"]));
    expect(webSwitch()).toBeChecked();
    expect(webSwitch()).toHaveAccessibleDescription(webSearchOn(["search", "read"], [SONNET, "openai/gpt-6.1-sol", "@cf/zai-org/glm-4.7-flash"].map(known)));
    expect(webSearchOn(["search"], [known(SONNET), known("openai/gpt-6.1-sol")])).toContain("A model someone picks searches too, if it's Anthropic's or OpenAI's.");
    expect(webSearchOn(["search"], [known(SONNET)])).not.toContain("picks");
  });

  it("says why it didn't turn on, its switch back off", async () => {
    const refusal = "Claude Sonnet 5.5 answered without searching the web, so Search the web is still off. Try again, or choose another model under Models or Change.";
    serveWebSearch(() => Response.json({ error: refusal }, { status: 422 }));
    const { user, onFailed } = showLiveCard(on(SONNET));
    await user.click(webSwitch());
    await waitFor(() => expect(within(card()).getByRole("status")).toHaveTextContent(refusal));
    expect(webSwitch()).not.toBeChecked();
    expect(webSwitch()).toBeEnabled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says Ember AI changed while its model searched, its switch back off", async () => {
    serveWebSearch(() => Response.json({ error: WEB_SEARCH_CHANGED }, { status: 409 }));
    const { user, onFailed } = showLiveCard(on(SONNET));
    await user.click(webSwitch());
    await waitFor(() => expect(within(card()).getByRole("status")).toHaveTextContent(WEB_SEARCH_CHANGED));
    expect(webSwitch()).not.toBeChecked();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("turns off without searching, saying nothing more", async () => {
    const answer = held(() => turned(false));
    const fetch = serveWebSearch(answer.answered);
    const { user } = showLiveCard(on(SONNET, TOP_LEVELS, [], ["search", "read"]));
    expect(webSwitch()).toBeChecked();

    await user.click(webSwitch());
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant/web_search", expect.objectContaining({ body: JSON.stringify({ on: false }) }));
    expect(webSwitch()).not.toBeChecked();
    expect(within(card()).getByRole("status")).toHaveTextContent("");
    await answer.answer();
    expect(webSwitch()).not.toBeChecked();
    expect(webSwitch()).toHaveAccessibleDescription(WEB_SEARCH_OFF);
  });

  it("says a model that can't search can't, its switch opening Set up Ember AI to choose another", async () => {
    const fetch = serveWebSearch(() => turned(true));
    const { user, onSetUp } = showLiveCard(on("@cf/zai-org/glm-4.7-flash"));
    expect(webSwitch()).toHaveAccessibleDescription(cannotSearchWith("GLM-4.7 Flash"));
    await user.click(webSwitch());
    expect(onSetUp).toHaveBeenCalledOnce();
    expect(webSwitch()).not.toBeChecked();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a failure it can't say itself to the page's alerts", async () => {
    serveWebSearch(() => Response.json({ error: "Only administrators can set up Ember AI" }, { status: 403 }));
    const { user, onFailed } = showLiveCard(on(SONNET));
    await user.click(webSwitch());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can set up Ember AI")));
    expect(within(card()).getByRole("status")).toHaveTextContent("");
    expect(webSwitch()).not.toBeChecked();
  });

  it("says choosing another model to answer everyone turned it off, as the new model may not take the same tools", async () => {
    const answer = held(() => Response.json({ assistant: on("openai/gpt-6.1-sol", TOP_LEVELS, [SONNET]) }));
    const fetch = serve({ changed: answer.answered });
    const { user } = showLiveCard(on(SONNET, TOP_LEVELS, ["openai/gpt-6.1-sol"], ["search", "read"]));
    expect(webSwitch()).toBeChecked();

    await user.click(within(card()).getByRole("radio", { name: "GPT-6.1 Sol" }));
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ model: "openai/gpt-6.1-sol" }) }));
    expect(webSwitch()).toBeDisabled();
    await answer.answer();
    expect(webSwitch()).not.toBeChecked();
    expect(webSwitch()).toBeEnabled();
    expect(webSwitch()).toHaveAccessibleDescription(WEB_SEARCH_OFF);
    expect(within(card()).getByRole("status")).toHaveTextContent(searchTurnedOff([]));
  });

  it("forgets what the model said of searching once another model answers everyone", async () => {
    const refusal = "AI Gateway didn't let Claude Sonnet 5.5 search the web.";
    serveWebSearch(() => Response.json({ error: refusal }, { status: 422 }));
    const { user } = showLiveCard(on(SONNET, TOP_LEVELS, ["@cf/zai-org/glm-4.7-flash"]));
    await user.click(webSwitch());
    await waitFor(() => expect(within(card()).getByRole("status")).toHaveTextContent(refusal));

    vi.restoreAllMocks();
    serve({ changed: () => Response.json({ assistant: on("@cf/zai-org/glm-4.7-flash", TOP_LEVELS, [SONNET]) }) });
    await user.click(within(card()).getByRole("radio", { name: "GLM-4.7 Flash" }));
    await waitFor(() => expect(webSwitch()).toHaveAccessibleDescription(cannotSearchWith("GLM-4.7 Flash")));
    expect(within(card()).getByRole("status")).toHaveTextContent("");
  });

  it("forgets that choosing another model turned it off once Set up Ember AI opens, which may choose another", async () => {
    serve({ changed: () => Response.json({ assistant: on("@cf/zai-org/glm-4.7-flash", TOP_LEVELS, [SONNET]) }) });
    const { user, onSetUp } = showLiveCard(on(SONNET, TOP_LEVELS, ["@cf/zai-org/glm-4.7-flash"], ["search", "read"]));
    await user.click(within(card()).getByRole("radio", { name: "GLM-4.7 Flash" }));
    await waitFor(() => expect(within(card()).getByRole("status")).toHaveTextContent(searchTurnedOff(null)));

    await user.click(webSwitch());
    expect(onSetUp).toHaveBeenCalledOnce();
    expect(within(card()).getByRole("status")).toHaveTextContent("");
  });

  it("keeps saying what the model found through a change to the dials", async () => {
    serveWebSearch(() => turned(true));
    const { user } = showLiveCard(on(SONNET));
    await user.click(webSwitch());
    await waitFor(() => expect(within(card()).getByRole("status")).toHaveTextContent(`It searched the web and said: ${FOUND}`));

    vi.restoreAllMocks();
    serve({ changed: ({ model: _, ...levels }) => Response.json({ assistant: on(SONNET, { ...TOP_LEVELS, ...levels }, [], ["search", "read"]) }) });
    await user.click(within(card()).getByRole("radio", { name: "Low" }));
    await waitFor(() => expect(within(card()).getByRole("radio", { name: "Low" })).toBeEnabled());
    expect(within(card()).getByRole("status")).toHaveTextContent(`It searched the web and said: ${FOUND}`);
    expect(webSwitch()).toBeChecked();
  });
});
