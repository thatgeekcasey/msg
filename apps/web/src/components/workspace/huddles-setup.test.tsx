import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HuddlesSettings } from "@ember/protocol";
import { APP_ID_REFUSED, APP_ID_UNKNOWN, APP_SECRET_REFUSED, APP_SECRET_UNKNOWN, HUDDLES_FORBIDDEN, HUDDLES_UNCHECKED } from "@ember/protocol/huddles";
import { ApiError } from "@/lib/api";
import { HuddlesSetup } from "./huddles-setup";

/** A Realtime SFU app's keys, as an administrator copies them from Cloudflare's dashboard. */
const APP = { appId: "2a95132c15732412d22c1476fa83f27a", appSecret: "66bcf64aa8907b9f9d90ac17746a77ce394c393b92b3916633dc02846e608ad4" };
/** The Cloudflare account Ember is deployed to. */
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

/** Answers giving Ember the app's keys as the server would, or as `saved` says. */
function serve(saved: () => Response | Promise<Response> = () => Response.json({ huddles: { appId: APP.appId } })) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (`${init?.method} ${String(input)}` === "PUT /api/account/huddles") return saved();
    throw new Error(`Unexpected request for ${init?.method} ${String(input)}`);
  });
}

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

/** Set up huddles, open on a workspace whose huddles are as `huddles` says, deployed to `deployedAccountId`, if that's known. */
function showSetup({ huddles = null, deployedAccountId = null }: { huddles?: HuddlesSettings | null; deployedAccountId?: string | null } = {}) {
  const callbacks = { onSaved: vi.fn(), onClose: vi.fn(), onFailed: vi.fn() };
  render(<HuddlesSetup huddles={huddles} deployedAccountId={deployedAccountId} {...callbacks} />);
  return { ...callbacks, user: userEvent.setup() };
}

const dialog = (name: string) => screen.findByRole("dialog", { name });
const button = (name: string) => screen.getByRole("button", { name });
const appIdField = () => screen.getByRole("textbox", { name: "App ID" });
const appSecretField = () => screen.getByRole("textbox", { name: "App Secret" });

/** Types the app's keys, as given, and saves them. */
async function giveKeys(user: ReturnType<typeof userEvent.setup>, app: { appId: string; appSecret: string } = APP) {
  await user.clear(appIdField());
  await user.type(appIdField(), app.appId);
  await user.clear(appSecretField());
  await user.type(appSecretField(), app.appSecret);
  await user.click(button("Save"));
}

afterEach(() => vi.restoreAllMocks());

describe("Set up huddles", () => {
  it("starts with the app to make, linking to Serverless SFU in the Cloudflare dashboard", async () => {
    const fetch = serve();
    const { user, onClose } = showSetup();
    const setup = await dialog("Set up huddles");
    expect(within(setup).getByRole("heading", { name: "Set up huddles" })).toHaveFocus();
    expect(setup).toHaveAccessibleDescription(
      "Huddles run through Cloudflare's Realtime SFU, which carries what each person in a huddle says to the others. It has a free monthly allowance, and what it sends past that is billed to your Cloudflare account. Ember keeps the app's secret encrypted.",
    );
    const [app, keys] = within(screen.getByRole("list", { name: "Steps to make a Realtime SFU app" })).getAllByRole("listitem");
    expect(app).toHaveTextContent("In the Cloudflare dashboard, open Realtime and choose Serverless SFU, then create an app.");
    const dashboard = within(app!).getByRole("link", { name: "Open Serverless SFU in the Cloudflare dashboard" });
    // Without the account Ember is deployed to, the dashboard asks which.
    expect(dashboard).toHaveAttribute("href", "https://dash.cloudflare.com/?to=/:account/realtime/sfu");
    expect(dashboard).toHaveAttribute("target", "_blank");
    expect(keys).toHaveTextContent("Copy the app's App ID and App Secret here.");
    expect(appIdField()).toHaveValue("");
    expect(screen.queryByText(/has an app's keys already/)).not.toBeInTheDocument();
    expect(button("Save")).toBeDisabled();
    await user.type(appIdField(), APP.appId);
    expect(button("Save")).toBeDisabled();
    await user.type(appSecretField(), APP.appSecret);
    expect(button("Save")).toBeEnabled();

    await user.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("opens the dashboard at the account Ember is deployed to, once the deploy has given it", async () => {
    serve();
    showSetup({ deployedAccountId: ACCOUNT_ID });
    await dialog("Set up huddles");
    expect(screen.getByRole("link", { name: "Open Serverless SFU in the Cloudflare dashboard" })).toHaveAttribute("href", `https://dash.cloudflare.com/${ACCOUNT_ID}/realtime/sfu`);
  });

  it("refuses keys that can't be an app's on their fields, asking the server nothing, until they're typed again", async () => {
    const fetch = serve();
    const { user } = showSetup();
    await giveKeys(user, { appId: "my huddles app", appSecret: APP.appSecret });
    expect(screen.getByRole("alert")).toHaveTextContent(APP_ID_REFUSED);
    expect(appIdField()).toHaveAttribute("aria-invalid", "true");
    expect(appIdField()).toHaveAccessibleDescription(APP_ID_REFUSED);
    await user.clear(appIdField());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // The App ID, pasted where the secret goes.
    await giveKeys(user, { appId: APP.appId, appSecret: APP.appId });
    expect(screen.getByRole("alert")).toHaveTextContent(APP_SECRET_REFUSED);
    expect(appSecretField()).toHaveAttribute("aria-invalid", "true");
    expect(appIdField()).toHaveAttribute("aria-invalid", "false");
    expect(screen.getByRole("dialog", { name: "Set up huddles" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("saves the app's keys, without the spaces around them, once Cloudflare has started a session with them", async () => {
    const answer = held(() => Response.json({ huddles: { appId: APP.appId } }));
    serve(answer.answered);
    const { user, onSaved, onClose } = showSetup();
    await giveKeys(user, { appId: ` ${APP.appId} `, appSecret: `${APP.appSecret} ` });

    // Nothing closes it, or changes the keys, while Cloudflare is asked.
    expect(screen.getByRole("status")).toHaveTextContent("Asking Cloudflare to start a session with the app's keys…");
    expect(screen.getByRole("dialog", { name: "Set up huddles" })).toHaveAttribute("aria-busy", "true");
    expect(button("Checking…")).toBeDisabled();
    expect(button("Cancel")).toBeDisabled();
    expect(button("Close")).toBeDisabled();
    expect(appIdField()).toBeDisabled();
    expect(appSecretField()).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    await answer.answer();
    const done = await dialog("Huddles are set up");
    expect(within(done).getByRole("heading", { name: "Huddles are set up" })).toHaveFocus();
    expect(done).toHaveAccessibleDescription("Cloudflare started a session with the app's keys, so huddles can run through it. Ember keeps the keys until huddles are turned off.");
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ appId: APP.appId });
    expect(asked()).toEqual([["PUT /api/account/huddles", APP]]);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(button("Done"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says on its field why Cloudflare didn't take a key, until it's typed again", async () => {
    const refusals = [
      { error: APP_ID_UNKNOWN, field: "appId" },
      { error: APP_SECRET_UNKNOWN, field: "appSecret" },
    ];
    serve(() => Response.json(refusals.shift(), { status: 422 }));
    const { user, onSaved, onFailed } = showSetup();
    await giveKeys(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(APP_ID_UNKNOWN);
    expect(appIdField()).toHaveAccessibleDescription(APP_ID_UNKNOWN);
    expect(appIdField()).toBeEnabled();
    // What was typed is still there to correct.
    expect(appIdField()).toHaveValue(APP.appId);
    expect(appSecretField()).toHaveValue(APP.appSecret);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();

    await user.click(button("Save"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(APP_SECRET_UNKNOWN));
    expect(appSecretField()).toHaveAccessibleDescription(APP_SECRET_UNKNOWN);
    expect(appIdField()).toHaveAttribute("aria-invalid", "false");
    await user.type(appSecretField(), "{Backspace}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Set up huddles" })).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says under the keys that Cloudflare couldn't be asked, which saving again asks", async () => {
    const answers = [() => Response.json({ error: HUDDLES_UNCHECKED }, { status: 502 }), () => Response.json({ huddles: { appId: APP.appId } })];
    serve(() => answers.shift()!());
    const { user, onSaved, onFailed } = showSetup();
    await giveKeys(user);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(HUDDLES_UNCHECKED));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onFailed).not.toHaveBeenCalled();

    await user.click(button("Save"));
    await dialog("Huddles are set up");
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ appId: APP.appId });
    expect(asked()).toEqual([
      ["PUT /api/account/huddles", APP],
      ["PUT /api/account/huddles", APP],
    ]);
  });

  it("leaves any other failure to the page's alerts, the keys still there", async () => {
    serve(() => Response.json({ error: HUDDLES_FORBIDDEN }, { status: 403 }));
    const { user, onSaved, onFailed, onClose } = showSetup();
    await giveKeys(user);
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, HUDDLES_FORBIDDEN)));
    expect(screen.getByRole("dialog", { name: "Set up huddles" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(button("Save")).toBeEnabled();
    expect(appSecretField()).toHaveValue(APP.appSecret);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("starts from the app's ID when changing keys, and asks for its secret again", async () => {
    serve();
    const another = { appId: "f".repeat(32), appSecret: "0".repeat(64) };
    const { user, onSaved } = showSetup({ huddles: { appId: APP.appId } });
    await dialog("Set up huddles");
    expect(appIdField()).toHaveValue(APP.appId);
    expect(appSecretField()).toHaveValue("");
    expect(screen.getByText("Ember has an app's keys already. Give another app's to run huddles through it instead.")).toBeVisible();
    expect(button("Save")).toBeDisabled();

    vi.mocked(fetch).mockImplementation(async () => Response.json({ huddles: { appId: another.appId } }));
    await giveKeys(user, another);
    await dialog("Huddles are set up");
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ appId: another.appId });
    expect(asked()).toEqual([["PUT /api/account/huddles", another]]);
  });
});
