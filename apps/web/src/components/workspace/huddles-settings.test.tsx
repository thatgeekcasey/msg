import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSettings } from "@ember/protocol";
import { HUDDLES_FORBIDDEN } from "@ember/protocol/huddles";
import { ApiError } from "@/lib/api";
import { CONFIRM_STOP_HUDDLES, HUDDLES_EXPLAINED, HuddlesSettings } from "./huddles-settings";

const APP_ID = "2a95132c15732412d22c1476fa83f27a";

/** Answers turning huddles off as the server would, or as `stopped` says. */
function serve(stopped: () => Response | Promise<Response> = () => Response.json({ huddles: null })) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (`${init?.method} ${String(input)}` === "DELETE /api/account/huddles") return stopped();
    throw new Error(`Unexpected request for ${init?.method} ${String(input)}`);
  });
}

/** A response the test lets through when it says, with `answer` letting it through. */
function held(response: () => Response) {
  let answer = () => {};
  const answered = new Promise<Response>((resolve) => (answer = () => resolve(response())));
  return { answered: () => answered, answer: () => act(async () => answer()) };
}

/** The card, for a workspace whose huddles are as `huddles` says. */
function showCard(huddles: WorkspaceSettings["huddles"]) {
  const callbacks = { onSetUp: vi.fn(), onStopped: vi.fn(), onFailed: vi.fn() };
  render(<HuddlesSettings huddles={huddles} {...callbacks} />);
  return { ...callbacks, user: userEvent.setup() };
}

const card = () => screen.getByRole("region", { name: "Huddles" });
const huddlesSwitch = () => within(card()).getByRole("switch", { name: "Huddles" });

afterEach(() => vi.restoreAllMocks());

describe("Set up huddles", () => {
  it("says what huddles are while its switch is off, which turning on opens Set up huddles", async () => {
    serve();
    const { user, onSetUp } = showCard(null);
    expect(card()).toHaveTextContent(HUDDLES_EXPLAINED);
    expect(within(card()).getByRole("heading", { level: 3, name: "Huddles" })).toBeVisible();
    expect(huddlesSwitch()).not.toBeChecked();
    expect(huddlesSwitch()).toHaveAccessibleDescription(HUDDLES_EXPLAINED);
    expect(within(card()).queryAllByRole("button")).toEqual([]);
    await user.click(huddlesSwitch());
    expect(onSetUp).toHaveBeenCalledOnce();
    // It stays off until the app's keys are given.
    expect(huddlesSwitch()).not.toBeChecked();
  });

  it("names the SFU app huddles run through, its switch on, with Change keys", async () => {
    serve();
    const { user, onSetUp } = showCard({ appId: APP_ID });
    const description = `Huddles run through the Realtime SFU app ${APP_ID} in your Cloudflare account.`;
    expect(card()).toHaveTextContent(description);
    expect(huddlesSwitch()).toBeChecked();
    expect(huddlesSwitch()).toBeEnabled();
    expect(huddlesSwitch()).toHaveAccessibleDescription(description);
    expect(within(card()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Change keys"]);
    await user.click(screen.getByRole("button", { name: "Change keys" }));
    expect(onSetUp).toHaveBeenCalledOnce();
  });

  it("forgets the app's keys once the administrator confirms turning its switch off", async () => {
    const answer = held(() => Response.json({ huddles: null }));
    const fetch = serve(answer.answered);
    const sure = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user, onStopped } = showCard({ appId: APP_ID });
    await user.click(huddlesSwitch());
    expect(sure).toHaveBeenCalledWith(CONFIRM_STOP_HUDDLES);
    expect(fetch).not.toHaveBeenCalled();
    expect(huddlesSwitch()).toBeChecked();

    await user.click(huddlesSwitch());
    expect(fetch).toHaveBeenCalledWith("/api/account/huddles", expect.objectContaining({ method: "DELETE" }));
    expect(huddlesSwitch()).not.toBeChecked();
    expect(huddlesSwitch()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change keys" })).toBeDisabled();
    await answer.answer();
    expect(onStopped).toHaveBeenCalledOnce();
    expect(huddlesSwitch()).toBeEnabled();
  });

  it("leaves turning it off that failed to the page's alerts, its switch back on", async () => {
    serve(() => Response.json({ error: HUDDLES_FORBIDDEN }, { status: 403 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onStopped, onFailed } = showCard({ appId: APP_ID });
    await user.click(huddlesSwitch());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, HUDDLES_FORBIDDEN)));
    expect(onStopped).not.toHaveBeenCalled();
    expect(huddlesSwitch()).toBeChecked();
    expect(huddlesSwitch()).toBeEnabled();
  });
});
