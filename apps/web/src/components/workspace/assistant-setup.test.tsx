import { useState } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_ID_REFUSED,
  API_TOKEN_REFUSED,
  ASSISTANT_MODELS,
  MODEL_REFUSED,
  TOP_LEVELS,
  modelName,
  type AssistantCatalog,
  type AssistantSettings,
  type AssistantSetup as Setup,
} from "@ember/protocol/assistant";
import { ApiError } from "@/lib/api";
import { AssistantSetup, searchTurnedOff } from "./assistant-setup";
import { CATALOG_UNREAD, MODEL_CATALOG } from "./model-picker";

/** A Cloudflare account's ID and an API token of its, as an administrator copies them from Workers AI's Use REST API. */
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
/** Another account's ID. */
const OTHER_ACCOUNT_ID = "fedcba9876543210fedcba9876543210";
const API_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-Ab";
const GREETING = "Hello, team! I'm Ember, here whenever you mention @ember.";

/** Ember AI as the server saves it from `setup`: on the model sent, the only one people can pick. */
const savedOf = ({ accountId, model, modelName: name }: Pick<Setup, "accountId" | "model" | "modelName">): AssistantSettings => {
  const format = ASSISTANT_MODELS.find(({ id }) => id === model)?.format ?? "chat";
  // Searching the web waits for Search the web to be turned on, for a model that can.
  return {
    accountId,
    model,
    models: [{ id: model, name: name ?? modelName(model), format }],
    most: TOP_LEVELS,
    webTools: format === "chat" ? null : [],
    instructions: "",
    avatarUrl: "/users/ember.abc/avatar?v=20261101120000",
    avatar: false,
  };
};

/** What Cloudflare's catalog lists when it can't be read, as the server answers: the models Ember knows. */
const KNOWN: AssistantCatalog = { models: [...ASSISTANT_MODELS], refusal: null };

/**
 * Answers listing Cloudflare's catalog and setting Ember AI up as the server would, with the models Ember
 * knows and the model sent, or as `saved` and `listed` say.
 */
function serve(saved?: (setup: Setup) => Response | Promise<Response>, listed: () => Response | Promise<Response> = () => Response.json(KNOWN)) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method} ${String(input)}`;
    if (request === "POST /api/account/assistant/catalog") return listed();
    if (request !== "PUT /api/account/assistant") throw new Error(`Unexpected request for ${request}`);
    const setup = JSON.parse(String(init?.body)) as Setup;
    return saved ? saved(setup) : Response.json({ assistant: savedOf(setup), greeting: GREETING });
  });
}

/** Listing the catalog with the account and API token the tests type. */
const LISTED = ["POST /api/account/assistant/catalog", { accountId: ACCOUNT_ID, apiToken: API_TOKEN }];

/** What the dialog asked of the server, in order, with what it sent. */
const asked = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([input, init]) => [`${init?.method} ${String(input)}`, init?.body === undefined ? undefined : JSON.parse(String(init.body))]);

/** A response the test lets through when it says, with `answer` letting it through. */
function held(response: () => Response) {
  let answer = () => {};
  const answered = new Promise<Response>((resolve) => (answer = () => resolve(response())));
  return { answered: () => answered, answer: () => act(async () => answer()) };
}

/**
 * Set up Ember AI, open on a workspace whose Ember AI is `assistant`, deployed to the Cloudflare account
 * `deployedAccountId` names, if the deploy said, as the settings page opens it: on Ember AI as it's saved,
 * once it is.
 */
function showSetup(assistant: AssistantSettings | null = null, deployedAccountId: string | null = null) {
  const callbacks = { onSaved: vi.fn(), onClose: vi.fn(), onFailed: vi.fn() };
  function SettingsPage() {
    const [shown, setShown] = useState(assistant);
    const onSaved = (saved: AssistantSettings) => {
      setShown(saved);
      callbacks.onSaved(saved);
    };
    return <AssistantSetup assistant={shown} deployedAccountId={deployedAccountId} {...callbacks} onSaved={onSaved} />;
  }
  render(<SettingsPage />);
  return { ...callbacks, user: userEvent.setup() };
}

const dialog = (name: string) => screen.findByRole("dialog", { name });
const button = (name: string) => screen.getByRole("button", { name });
const accountIdField = () => screen.getByRole("textbox", { name: "Account ID" });
const apiTokenField = () => screen.getByRole("textbox", { name: "API token" });
const modelMenu = () => screen.getByRole("combobox", { name: "Model" });
const modelIdField = () => screen.getByRole("textbox", { name: "Model ID" });
const steps = () => within(screen.getByRole("list", { name: "Steps to make a Workers AI API token" })).getAllByRole("listitem");
const workersAiLink = () => screen.getByRole("link", { name: "Open Workers AI in the Cloudflare dashboard" });
const aiGatewayLink = () => screen.getByRole("link", { name: "Open AI Gateway in the Cloudflare dashboard" });

/** Types the account's ID and API token, as given, and goes on to the model. */
async function giveKeys(user: ReturnType<typeof userEvent.setup>, { accountId = ACCOUNT_ID, apiToken = API_TOKEN } = {}) {
  await user.type(accountIdField(), accountId);
  if (apiToken) await user.type(apiTokenField(), apiToken);
  await user.click(button("Continue"));
}

afterEach(() => vi.restoreAllMocks());

describe("Set up Ember AI", () => {
  it("starts with the account and API token Workers AI's Use REST API gives, linking to it in the Cloudflare dashboard", async () => {
    const fetch = serve();
    const { user, onClose } = showSetup();
    const setup = await dialog("Set up Ember AI");
    expect(within(setup).getByRole("heading", { name: "Set up Ember AI" })).toHaveFocus();
    expect(setup).toHaveAccessibleDescription(
      "Ember AI asks a model through your Cloudflare account's AI Gateway. Workers AI's models come with a free daily allowance, and other companies' are paid for with AI Gateway's credits. Ember keeps the API token encrypted.",
    );
    const [open, token, account] = steps();
    expect(open).toHaveTextContent("In the Cloudflare dashboard, open Workers AI and choose Use REST API.");
    const dashboard = within(open!).getByRole("link", { name: "Open Workers AI in the Cloudflare dashboard" });
    expect(dashboard).toHaveAttribute("href", "https://dash.cloudflare.com/?to=/:account/ai/workers-ai");
    expect(dashboard).toHaveAttribute("target", "_blank");
    expect(token).toHaveTextContent("Choose Create a Workers AI API Token, then Create API Token, and copy the token here.");
    expect(account).toHaveTextContent("Copy the Account ID shown there too.");
    expect(accountIdField()).toHaveValue("");
    expect(accountIdField()).not.toHaveAccessibleDescription();
    expect(button("Continue")).toBeDisabled();
    await user.type(accountIdField(), ACCOUNT_ID);
    expect(dashboard).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/ai/workers-ai`);
    expect(button("Continue")).toBeDisabled();
    await user.type(apiTokenField(), API_TOKEN);
    expect(button("Continue")).toBeEnabled();

    await user.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an account ID or an API token that can't be one on its field, without going on, until it's typed again", async () => {
    const fetch = serve();
    const { user } = showSetup();
    await giveKeys(user, { accountId: "my account" });
    expect(screen.getByRole("alert")).toHaveTextContent(ACCOUNT_ID_REFUSED);
    expect(accountIdField()).toHaveAttribute("aria-invalid", "true");
    expect(accountIdField()).toHaveAccessibleDescription(ACCOUNT_ID_REFUSED);
    await user.clear(accountIdField());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.type(accountIdField(), ACCOUNT_ID);
    await user.clear(apiTokenField());
    await user.type(apiTokenField(), "short");
    await user.click(button("Continue"));
    expect(screen.getByRole("alert")).toHaveTextContent(API_TOKEN_REFUSED);
    expect(apiTokenField()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("dialog", { name: "Set up Ember AI" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists Workers AI's models first, then other companies', then Another model, saying what pays for each", async () => {
    serve();
    const { user } = showSetup();
    await giveKeys(user);
    const step = await dialog("Choose a model");
    expect(within(step).getByRole("heading", { name: "Choose a model" })).toHaveFocus();
    expect(step).toHaveAccessibleDescription(
      "Choose the model @ember answers everyone with. Ember asks it a test question through AI Gateway before keeping it. You can let people pick other models later.",
    );
    const groups = within(modelMenu()).getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("label"))).toEqual(["Workers AI, with a free daily allowance", "Other companies', paid for with AI Gateway's credits"]);
    expect(within(groups[0]!).getAllByRole("option").map((option) => option.textContent)).toEqual(["GLM-4.7 Flash", "Gemma 4 26B", "gpt-oss-120b"]);
    expect(within(groups[1]!).getAllByRole("option")).toHaveLength(ASSISTANT_MODELS.length - 3);
    expect(within(modelMenu()).getAllByRole("option").at(-1)).toHaveTextContent("Another model…");
    expect(modelMenu()).toHaveValue(ASSISTANT_MODELS[0]!.id);
    expect(modelMenu()).toHaveAccessibleDescription("Workers AI's models run on Cloudflare, free up to a daily allowance, and beyond it on Workers Paid.");

    await user.selectOptions(modelMenu(), "Claude Sonnet 5.5");
    expect(modelMenu()).toHaveAccessibleDescription("AI Gateway's credits pay for this model. Top them up under Credits Available in AI Gateway. Open AI Gateway in the Cloudflare dashboard");
    expect(aiGatewayLink()).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/ai/ai-gateway`);
  });

  it("asks the model chosen a test question, saving it with the account and API token, and shows what it said", async () => {
    serve();
    const { user, onSaved, onClose } = showSetup();
    await giveKeys(user, { accountId: ` ${ACCOUNT_ID.toUpperCase()} `, apiToken: ` ${API_TOKEN} ` });
    await user.selectOptions(await screen.findByRole("combobox", { name: "Model" }), "Claude Sonnet 5.5");
    await user.click(button("Save"));
    const done = await dialog("Ember AI is set up");
    expect(within(done).getByRole("heading", { name: "Ember AI is set up" })).toHaveFocus();
    expect(done).toHaveAccessibleDescription("@ember is in every room open to everyone, running on Claude Sonnet 5.5. Asked to say hello, it said:");
    expect(done).toHaveTextContent(GREETING);
    const setup = { accountId: ACCOUNT_ID, model: "anthropic/claude-sonnet-5.5", modelName: "Claude Sonnet 5.5" };
    expect(asked()).toEqual([LISTED, ["PUT /api/account/assistant", { ...setup, apiToken: API_TOKEN }]]);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(savedOf(setup));
    await user.click(button("Done"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("takes another model by its ID, from Cloudflare's catalog, refusing one that can't be one without asking", async () => {
    serve();
    const { user, onSaved } = showSetup();
    await giveKeys(user);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Model" }), "Another model…");
    expect(modelIdField()).toHaveAttribute("placeholder", "company/model");
    expect(modelIdField()).toHaveAccessibleDescription("Copy a model's ID from Cloudflare's catalog, such as anthropic/claude-sonnet-5.5. Open the model catalog");
    expect(screen.getByRole("link", { name: "Open the model catalog" })).toHaveAttribute("href", MODEL_CATALOG);
    expect(button("Save")).toBeDisabled();
    await user.type(modelIdField(), "mistral large");
    await user.click(button("Save"));
    expect(screen.getByRole("alert")).toHaveTextContent(MODEL_REFUSED);
    expect(modelIdField()).toHaveAttribute("aria-invalid", "true");
    expect(asked()).toEqual([LISTED]);

    await user.clear(modelIdField());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.type(modelIdField(), " mistral/mistral-large-3 ");
    await user.click(button("Save"));
    expect(await dialog("Ember AI is set up")).toHaveAccessibleDescription(
      "@ember is in every room open to everyone, running on mistral/mistral-large-3. Asked to say hello, it said:",
    );
    expect(asked()).toEqual([LISTED, ["PUT /api/account/assistant", { accountId: ACCOUNT_ID, apiToken: API_TOKEN, model: "mistral/mistral-large-3" }]]);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(savedOf({ accountId: ACCOUNT_ID, model: "mistral/mistral-large-3" }));
  });

  it.each([
    ["account ID", "accountId", "Cloudflare has no account with that ID that the token can reach.", accountIdField],
    ["API token", "apiToken", "Cloudflare didn't take that API token for this account.", apiTokenField],
  ])("sends an %s AI Gateway refuses back to its field, keeping what was typed", async (_, field, refusal, fieldOf) => {
    serve(() => Response.json({ error: refusal, field }, { status: 422 }));
    const { user, onSaved, onFailed } = showSetup();
    await giveKeys(user);
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
    expect(screen.getByRole("dialog", { name: "Set up Ember AI" })).toBeInTheDocument();
    expect(fieldOf()).toHaveAttribute("aria-invalid", "true");
    expect(accountIdField()).toHaveValue(ACCOUNT_ID);
    expect(apiTokenField()).toHaveValue(API_TOKEN);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();

    await user.click(button("Continue"));
    expect(await screen.findByRole("combobox", { name: "Model" })).toHaveValue(ASSISTANT_MODELS[0]!.id);
  });

  it("says on the model menu why AI Gateway didn't take the model, until another's chosen", async () => {
    serve(() => Response.json({ error: "AI Gateway didn't take that model.", field: "model" }, { status: 422 }));
    const { user, onFailed } = showSetup();
    await giveKeys(user);
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AI Gateway didn't take that model.");
    expect(modelMenu()).toHaveAttribute("aria-invalid", "true");
    expect(modelMenu()).toHaveAccessibleDescription("AI Gateway didn't take that model.");
    await user.selectOptions(modelMenu(), "Gemma 4 26B");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it.each([
    ["no credits", 422, "This model is paid for with AI Gateway's credits, and there aren't enough."],
    ["AI Gateway turning requests away", 429, "AI Gateway is turning requests away for now, or a spend limit was reached. Try again later."],
    ["AI Gateway not answering", 502, "AI Gateway didn't answer. Try again in a moment."],
  ])("says under the model when it couldn't be saved for %s, saving it when asked again", async (_, status, problem) => {
    let answers = 0;
    serve((setup) => (answers++ === 0 ? Response.json({ error: problem }, { status }) : Response.json({ assistant: savedOf(setup), greeting: GREETING })));
    const { user, onFailed } = showSetup();
    await giveKeys(user);
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(problem));
    expect(onFailed).not.toHaveBeenCalled();
    await user.click(button("Save"));
    expect(await dialog("Ember AI is set up")).toBeInTheDocument();
    expect(asked().map(([request]) => request)).toEqual(["POST /api/account/assistant/catalog", "PUT /api/account/assistant", "PUT /api/account/assistant"]);
  });

  it("can't be closed while the model's asked, saying so", async () => {
    const answer = held(() => Response.json({ assistant: savedOf({ accountId: ACCOUNT_ID, model: "anthropic/claude-sonnet-5.5" }), greeting: GREETING }));
    serve(answer.answered);
    const { user, onClose } = showSetup();
    await giveKeys(user);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Model" }), "Claude Sonnet 5.5");
    await user.click(button("Save"));
    expect(button("Asking…")).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Asking Claude Sonnet 5.5 a test question…");
    expect(modelMenu()).toBeDisabled();
    expect(button("Back")).toBeDisabled();
    expect(button("Close")).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    await answer.answer();
    expect(await dialog("Ember AI is set up")).toBeInTheDocument();
  });

  it("leaves a failure it can't say itself to the page's alerts", async () => {
    serve(() => Response.json({ error: "Only administrators can set up Ember AI" }, { status: 403 }));
    const { user, onFailed } = showSetup();
    await giveKeys(user);
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can set up Ember AI")));
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(button("Save")).toBeEnabled();
  });

  it("opens on Ember AI as it is to change it, keeping the API token Ember has when none is given", async () => {
    serve();
    const { user } = showSetup(savedOf({ accountId: ACCOUNT_ID, model: "openai/gpt-6.1-sol" }));
    await dialog("Set up Ember AI");
    expect(steps()).toHaveLength(2);
    expect(accountIdField()).toHaveValue(ACCOUNT_ID);
    expect(workersAiLink()).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/ai/workers-ai`);
    expect(apiTokenField()).toHaveValue("");
    expect(apiTokenField()).toHaveAccessibleDescription("Ember has an API token already. Leave this blank to keep it, or paste another to ask with it instead.");
    expect(button("Continue")).toBeEnabled();
    await user.click(button("Continue"));
    expect(await screen.findByRole("combobox", { name: "Model" })).toHaveValue("openai/gpt-6.1-sol");
    await user.selectOptions(modelMenu(), "GPT-6.1 Terra");
    await user.click(button("Save"));
    await dialog("Ember AI is set up");
    expect(asked()).toEqual([
      ["POST /api/account/assistant/catalog", { accountId: ACCOUNT_ID }],
      ["PUT /api/account/assistant", { accountId: ACCOUNT_ID, model: "openai/gpt-6.1-terra", modelName: "GPT-6.1 Terra" }],
    ]);
  });

  it("fills in the account Ember is deployed to, saying so, and opens its pages in the Cloudflare dashboard", async () => {
    serve();
    const { user, onSaved } = showSetup(null, ACCOUNT_ID);
    await dialog("Set up Ember AI");
    expect(steps().map((step) => step.textContent)).toEqual([
      "In the Cloudflare dashboard, open Workers AI and choose Use REST API. Open Workers AI in the Cloudflare dashboard",
      "Choose Create a Workers AI API Token, then Create API Token, and copy the token here.",
    ]);
    expect(accountIdField()).toHaveValue(ACCOUNT_ID);
    expect(accountIdField()).toHaveAccessibleDescription("Ember is deployed to this account. To ask through another, paste that account's ID.");
    expect(workersAiLink()).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/ai/workers-ai`);
    expect(button("Continue")).toBeDisabled();
    await user.type(apiTokenField(), API_TOKEN);
    await user.click(button("Continue"));
    await user.selectOptions(await screen.findByRole("combobox", { name: "Model" }), "Claude Sonnet 5.5");
    expect(aiGatewayLink()).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/ai/ai-gateway`);
    await user.click(button("Save"));
    await dialog("Ember AI is set up");
    const setup = { accountId: ACCOUNT_ID, model: "anthropic/claude-sonnet-5.5", modelName: "Claude Sonnet 5.5" };
    expect(asked()).toEqual([LISTED, ["PUT /api/account/assistant", { ...setup, apiToken: API_TOKEN }]]);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(savedOf(setup));
  });

  it("takes another account in place of the one Ember is deployed to, the dashboard's pages following what's typed", async () => {
    serve();
    const { user } = showSetup(null, ACCOUNT_ID);
    await dialog("Set up Ember AI");
    await user.clear(accountIdField());
    expect(accountIdField()).not.toHaveAccessibleDescription();
    expect(workersAiLink()).toHaveAttribute("href", "https://dash.cloudflare.com/?to=/:account/ai/workers-ai");
    await user.type(accountIdField(), OTHER_ACCOUNT_ID.toUpperCase());
    expect(accountIdField()).not.toHaveAccessibleDescription();
    expect(workersAiLink()).toHaveAttribute("href", `https://dash.cloudflare.com/${OTHER_ACCOUNT_ID}/ai/workers-ai`);
    await user.type(apiTokenField(), API_TOKEN);
    await user.click(button("Continue"));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await dialog("Ember AI is set up");
    expect(asked()).toEqual([
      ["POST /api/account/assistant/catalog", { accountId: OTHER_ACCOUNT_ID, apiToken: API_TOKEN }],
      ["PUT /api/account/assistant", { accountId: OTHER_ACCOUNT_ID, apiToken: API_TOKEN, model: ASSISTANT_MODELS[0]!.id, modelName: ASSISTANT_MODELS[0]!.name }],
    ]);
  });

  it("says why AI Gateway refused the account Ember is deployed to in place of saying it's that account", async () => {
    const refusal = "Cloudflare has no account with that ID that the token can reach.";
    serve(() => Response.json({ error: refusal, field: "accountId" }, { status: 422 }));
    const { user } = showSetup(null, ACCOUNT_ID);
    await user.type(await screen.findByRole("textbox", { name: "API token" }), API_TOKEN);
    await user.click(button("Continue"));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
    expect(accountIdField()).toHaveAccessibleDescription(refusal);
    expect(screen.queryByText("Ember is deployed to this account.", { exact: false })).not.toBeInTheDocument();
  });

  it("opens on Ember AI's own account when it's on, saying only of the deployed account that Ember is there", async () => {
    serve();
    showSetup(savedOf({ accountId: OTHER_ACCOUNT_ID, model: "openai/gpt-6.1-sol" }), ACCOUNT_ID);
    await dialog("Set up Ember AI");
    expect(steps()).toHaveLength(2);
    expect(accountIdField()).toHaveValue(OTHER_ACCOUNT_ID);
    expect(accountIdField()).not.toHaveAccessibleDescription();
    expect(workersAiLink()).toHaveAttribute("href", `https://dash.cloudflare.com/${OTHER_ACCOUNT_ID}/ai/workers-ai`);
  });

  it("opens a model it doesn't list under Another model, with its ID", async () => {
    serve();
    const { user } = showSetup(savedOf({ accountId: ACCOUNT_ID, model: "mistral/mistral-large-3" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("combobox", { name: "Model" })).toHaveValue("");
    expect(modelIdField()).toHaveValue("mistral/mistral-large-3");
  });

  it("says Search the web is off once a change of model turned it off, as the new model hasn't searched", async () => {
    const searching: AssistantSettings = { ...savedOf({ accountId: ACCOUNT_ID, model: "anthropic/claude-sonnet-5.5" }), webTools: ["search", "read"] };
    serve((setup) => Response.json({ assistant: setup.model === searching.model ? searching : savedOf(setup), greeting: GREETING }));
    for (const [model, said] of [
      ["Claude Sonnet 5.5", null],
      ["Claude Opus 5.5", searchTurnedOff([])],
      ["GLM-4.7 Flash", searchTurnedOff(null)],
    ] as const) {
      const { user, onClose } = showSetup(searching);
      await user.click(await screen.findByRole("button", { name: "Continue" }));
      await user.selectOptions(await screen.findByRole("combobox", { name: "Model" }), model);
      await user.click(button("Save"));
      const done = await dialog("Ember AI is set up");
      if (said === null) expect(done).not.toHaveTextContent("Search the web");
      else expect(done).toHaveTextContent(said);
      await user.click(button("Done"));
      expect(onClose).toHaveBeenCalledOnce();
      cleanup();
    }
  });

  it("says Search the web is off for the new account once moving the same model to another turned it off", async () => {
    const searching: AssistantSettings = { ...savedOf({ accountId: ACCOUNT_ID, model: "anthropic/claude-sonnet-5.5" }), webTools: ["search", "read"] };
    // The server turns it off, as the other account's AI Gateway may not take the same tools.
    serve();
    const { user } = showSetup(searching);
    await dialog("Set up Ember AI");
    await user.clear(accountIdField());
    await user.type(accountIdField(), OTHER_ACCOUNT_ID);
    await user.type(apiTokenField(), API_TOKEN);
    await user.click(button("Continue"));
    await user.click(await screen.findByRole("button", { name: "Save" }));
    expect(await dialog("Ember AI is set up")).toHaveTextContent("Search the web is off for the new account. Turn it on again to try it.");
    const setup = { accountId: OTHER_ACCOUNT_ID, model: "anthropic/claude-sonnet-5.5", modelName: "Claude Sonnet 5.5", apiToken: API_TOKEN };
    expect(asked().at(-1)).toEqual(["PUT /api/account/assistant", setup]);
  });
});

describe("Cloudflare's model catalog", () => {
  /** The catalog as the Worker lists it: Workers AI's models first, with what other companies' cost, where it says. */
  const CATALOG: AssistantCatalog = {
    models: [
      { id: "@cf/zai-org/glm-4.7-flash", name: "GLM-4.7 Flash", format: "chat" },
      { id: "@cf/qwen/qwen3.5-coder", name: "Qwen 3.5 Coder", format: "chat" },
      { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", format: "messages", price: { input: 3, output: 15 } },
      { id: "deepseek/deepseek-v4", name: "DeepSeek V4", format: "chat", price: { input: 0.28, output: 0.42 } },
      { id: "xai/grok-5", name: "Grok 5", format: "chat" },
    ],
    refusal: null,
  };

  it("lists the account's models from it on Continue, saying so while it does, with what other companies' cost", async () => {
    const list = held(() => Response.json(CATALOG));
    serve(undefined, list.answered);
    const { user } = showSetup();
    await giveKeys(user);
    expect(screen.getByRole("status")).toHaveTextContent("Listing the models in Cloudflare's catalog…");
    expect(button("Listing models…")).toBeDisabled();
    expect(button("Cancel")).toBeDisabled();
    // The account and API token stay as they're listed for.
    expect(accountIdField()).toBeDisabled();
    expect(apiTokenField()).toBeDisabled();
    expect(asked()).toEqual([LISTED]);

    await list.answer();
    await dialog("Choose a model");
    const groups = within(modelMenu()).getAllByRole("group");
    expect(within(groups[0]!).getAllByRole("option").map((option) => option.textContent)).toEqual(["GLM-4.7 Flash", "Qwen 3.5 Coder"]);
    expect(within(groups[1]!).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Claude Sonnet 5.5 · $3 / $15",
      "DeepSeek V4 · $0.28 / $0.42",
      "Grok 5",
    ]);
    expect(screen.queryByText(CATALOG_UNREAD, { exact: false })).not.toBeInTheDocument();

    await user.selectOptions(modelMenu(), "deepseek/deepseek-v4");
    expect(modelMenu()).toHaveAccessibleDescription(
      "AI Gateway's credits pay for this model, $0.28 for each million tokens it reads, and $0.42 for each million it writes. Top them up under Credits Available in AI Gateway. Open AI Gateway in the Cloudflare dashboard",
    );
    await user.selectOptions(modelMenu(), "xai/grok-5");
    expect(modelMenu()).toHaveAccessibleDescription("AI Gateway's credits pay for this model. Top them up under Credits Available in AI Gateway. Open AI Gateway in the Cloudflare dashboard");
    await user.click(button("Save"));
    await dialog("Ember AI is set up");
    expect(asked().at(-1)).toEqual(["PUT /api/account/assistant", { accountId: ACCOUNT_ID, apiToken: API_TOKEN, model: "xai/grok-5", modelName: "Grok 5" }]);
  });

  it("lists the models Ember knows when the catalog couldn't be read, saying why", async () => {
    const refusal = "Cloudflare didn't take that API token for this account.";
    serve(undefined, () => Response.json({ ...KNOWN, refusal }));
    const { user } = showSetup();
    await giveKeys(user);
    await dialog("Choose a model");
    expect(within(modelMenu()).getAllByRole("option")).toHaveLength(ASSISTANT_MODELS.length + 1);
    expect(screen.getByText(`${CATALOG_UNREAD} ${refusal}`)).toBeInTheDocument();
    expect(modelMenu()).toHaveAccessibleDescription(
      `Workers AI's models run on Cloudflare, free up to a daily allowance, and beyond it on Workers Paid. ${CATALOG_UNREAD} ${refusal}`,
    );
  });

  it("lists it again only for another account or API token, keeping the model chosen while it's listed", async () => {
    serve(undefined, () => Response.json(CATALOG));
    const { user } = showSetup();
    await giveKeys(user);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Model" }), "anthropic/claude-sonnet-5.5");
    await user.click(button("Back"));
    await user.click(button("Continue"));
    expect(await screen.findByRole("combobox", { name: "Model" })).toHaveValue("anthropic/claude-sonnet-5.5");
    expect(asked()).toEqual([LISTED]);

    await user.click(button("Back"));
    await user.clear(apiTokenField());
    await user.type(apiTokenField(), `${API_TOKEN}x`);
    await user.click(button("Continue"));
    expect(await screen.findByRole("combobox", { name: "Model" })).toHaveValue("anthropic/claude-sonnet-5.5");
    expect(asked()).toEqual([LISTED, ["POST /api/account/assistant/catalog", { accountId: ACCOUNT_ID, apiToken: `${API_TOKEN}x` }]]);
  });

  it("starts at the first model the catalog lists when it doesn't list the one Ember knows first", async () => {
    serve(undefined, () => Response.json({ models: CATALOG.models.slice(1), refusal: null }));
    const { user } = showSetup();
    await giveKeys(user);
    expect(await screen.findByRole("combobox", { name: "Model" })).toHaveValue("@cf/qwen/qwen3.5-coder");
  });

  it("refuses a field the Worker refuses as it lists on that field, staying on the account", async () => {
    const refusal = "Paste an API token. Ember doesn't have one yet.";
    serve(undefined, () => Response.json({ error: refusal, field: "apiToken" }, { status: 422 }));
    const { user, onFailed } = showSetup();
    await giveKeys(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
    expect(apiTokenField()).toHaveAttribute("aria-invalid", "true");
    expect(apiTokenField()).toBeEnabled();
    expect(screen.getByRole("dialog", { name: "Set up Ember AI" })).toBeInTheDocument();
    expect(button("Continue")).toBeEnabled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("leaves a listing that failed otherwise to the page's alerts, staying on the account", async () => {
    serve(undefined, () => Response.json({ error: "Only administrators can set up Ember AI" }, { status: 403 }));
    const { user, onFailed } = showSetup();
    await giveKeys(user);
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can set up Ember AI")));
    expect(screen.getByRole("dialog", { name: "Set up Ember AI" })).toBeInTheDocument();
    expect(button("Continue")).toBeEnabled();
    expect(accountIdField()).toBeEnabled();
  });
});
