import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSettings } from "@ember/protocol";
import { TOP_LEVELS, type AssistantSettings as Assistant } from "@ember/protocol/assistant";
import { ApiError } from "@/lib/api";
import { AGENTS_ANSWER, ASSISTANT_EXPLAINED, AssistantSettings, CONFIRM_STOP_ASSISTANT, WHAT_AGENTS_SEND } from "./assistant-settings";

/** Ember AI on GLM-4.7 Flash. */
const ON: Assistant = {
  accountId: "0123456789abcdef0123456789abcdef",
  model: "@cf/zai-org/glm-4.7-flash",
  models: [{ id: "@cf/zai-org/glm-4.7-flash", name: "GLM-4.7 Flash", format: "chat" }],
  most: TOP_LEVELS,
  webTools: null,
  instructions: "",
  promptTemplate: null,
  avatarUrl: "/users/ember.abc/avatar?v=20261101120000",
  avatar: false,
};

/** Answers turning Ember AI off as `stopped` says. */
const serve = (stopped: () => Response | Promise<Response> = () => Response.json({ assistant: null })) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (`${init?.method} ${String(input)}` === "DELETE /api/account/assistant") return stopped();
    throw new Error(`Unexpected request for ${init?.method} ${String(input)}`);
  });

/** The card, for a workspace whose Ember AI is `assistant`. */
function showCard(assistant: WorkspaceSettings["assistant"]) {
  const callbacks = { onSetUp: vi.fn(), onStopped: vi.fn(), onFailed: vi.fn() };
  render(<AssistantSettings assistant={assistant} {...callbacks} />);
  return { ...callbacks, user: userEvent.setup() };
}

const card = () => screen.getByRole("region", { name: "Ember AI" });
const assistantSwitch = () => within(card()).getByRole("switch", { name: "Ember AI" });

afterEach(() => vi.restoreAllMocks());

describe("Ember AI", () => {
  it("says what Ember AI adds while its switch is off, which turning on opens Set up Ember AI", async () => {
    serve();
    const { user, onSetUp } = showCard(null);
    expect(card()).toHaveTextContent(ASSISTANT_EXPLAINED);
    expect(card()).not.toHaveTextContent(WHAT_AGENTS_SEND);
    expect(assistantSwitch()).not.toBeChecked();
    expect(assistantSwitch()).toHaveAccessibleDescription(ASSISTANT_EXPLAINED);
    expect(within(card()).queryAllByRole("button")).toEqual([]);
    await user.click(assistantSwitch());
    expect(onSetUp).toHaveBeenCalledOnce();
    // It stays off until a model has answered.
    expect(assistantSwitch()).not.toBeChecked();
  });

  it("says the agents answer through AI Gateway while it's on, and what they send their models, with Change", async () => {
    serve();
    const { user, onSetUp } = showCard(ON);
    expect(assistantSwitch()).toBeChecked();
    expect(assistantSwitch()).toBeEnabled();
    expect(assistantSwitch()).toHaveAccessibleDescription(AGENTS_ANSWER);
    // Who reads what an agent is asked: its model's provider, through Cloudflare.
    expect(card()).toHaveTextContent(WHAT_AGENTS_SEND);
    expect(within(card()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Change"]);
    await user.click(within(card()).getByRole("button", { name: "Change" }));
    expect(onSetUp).toHaveBeenCalledOnce();
  });

  it("turns Ember AI off once the administrator confirms turning its switch off", async () => {
    let answer = () => {};
    const fetch = serve(() => new Promise((resolve) => (answer = () => resolve(Response.json({ assistant: null })))));
    const sure = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user, onStopped } = showCard(ON);
    await user.click(assistantSwitch());
    expect(sure).toHaveBeenCalledWith(CONFIRM_STOP_ASSISTANT);
    expect(fetch).not.toHaveBeenCalled();
    expect(assistantSwitch()).toBeChecked();

    await user.click(assistantSwitch());
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant", expect.objectContaining({ method: "DELETE" }));
    expect(assistantSwitch()).not.toBeChecked();
    expect(assistantSwitch()).toBeDisabled();
    expect(within(card()).getByRole("button", { name: "Change" })).toBeDisabled();
    await act(async () => answer());
    expect(onStopped).toHaveBeenCalledOnce();
    expect(assistantSwitch()).toBeEnabled();
  });

  it("leaves turning it off that failed to the page's alerts, its switch back on", async () => {
    serve(() => Response.json({ error: "Only administrators can set up Ember AI" }, { status: 403 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onStopped, onFailed } = showCard(ON);
    await user.click(assistantSwitch());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can set up Ember AI")));
    expect(onStopped).not.toHaveBeenCalled();
    expect(assistantSwitch()).toBeChecked();
    expect(assistantSwitch()).toBeEnabled();
  });
});
