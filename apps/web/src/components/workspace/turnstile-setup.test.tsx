import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TURNSTILE_CHECK_EXPIRED,
  TURNSTILE_CHECK_PATH,
  TURNSTILE_KEYS_UNCHECKED,
  TURNSTILE_KEYS_UNMATCHED,
  TURNSTILE_SECRET_KEY_REFUSED,
  TURNSTILE_SITE_KEY_REFUSED,
  type WorkspaceSettings,
} from "@ember/protocol";
import { ApiError } from "@/lib/api";
import { TURNSTILE_DASHBOARD, TurnstileSetup } from "./turnstile-setup";

/** A Turnstile widget's keys, as an administrator copies them from Cloudflare's dashboard. */
const KEYS = { siteKey: "0x4AAAAAAA-a-widgets-site-key", secretKey: "0x4AAAAAAA-a-widgets-secret-key" };
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/** Answers giving Ember the keys as the server would, or as `saved` says. */
function serve(saved: () => Response | Promise<Response> = () => Response.json({ turnstile: "saved" })) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (`${init?.method} ${String(input)}` === "PUT /api/account/turnstile_keys") return saved();
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

/** Set up Turnstile, open on a workspace whose keys come from `turnstile`. */
function showSetup(turnstile: WorkspaceSettings["turnstile"] = null) {
  const callbacks = { onSaved: vi.fn(), onClose: vi.fn(), onFailed: vi.fn() };
  render(<TurnstileSetup turnstile={turnstile} {...callbacks} />);
  return { ...callbacks, user: userEvent.setup() };
}

const dialog = (name: string) => screen.findByRole("dialog", { name });
const button = (name: string) => screen.getByRole("button", { name });
const siteKeyField = () => screen.getByRole("textbox", { name: "Site key" });
const secretKeyField = () => screen.getByRole("textbox", { name: "Secret key" });
const frame = () => screen.getByTitle<HTMLIFrameElement>("Turnstile's check");

/** Types the widget's keys, as given, and goes on to its check. */
async function giveKeys(user: ReturnType<typeof userEvent.setup>, keys: { siteKey: string; secretKey: string } = KEYS) {
  await user.type(siteKeyField(), keys.siteKey);
  await user.type(secretKeyField(), keys.secretKey);
  await user.click(button("Continue"));
}

/** Has the check page say `said` of the check, as its script tells the page that framed it, from `source`, at `origin`. */
function checkSays(said: unknown, { source = frame().contentWindow, origin = location.origin }: { source?: Window | null; origin?: string } = {}) {
  act(() => void window.dispatchEvent(new MessageEvent("message", { data: { turnstileCheck: said }, origin, source })));
}

afterEach(() => vi.restoreAllMocks());

describe("Check that people are people with Cloudflare Turnstile", () => {
  it("starts with the widget to make for Ember's hostname, linking to Turnstile in the Cloudflare dashboard", async () => {
    const fetch = serve();
    const { user, onClose } = showSetup();
    const setup = await dialog("Set up Turnstile");
    expect(within(setup).getByRole("heading", { name: "Set up Turnstile" })).toHaveFocus();
    expect(setup).toHaveAccessibleDescription(
      "Cloudflare Turnstile checks that whoever signs up, or asks Ember to email them, is a person, mostly without asking them anything. It's free, and Ember keeps the widget's secret key encrypted.",
    );
    const [widget, keys] = within(screen.getByRole("list", { name: "Steps to make a Turnstile widget" })).getAllByRole("listitem");
    expect(widget).toHaveTextContent(
      `In the Cloudflare dashboard, open Turnstile and choose Add widget. Name it, add ${location.hostname} under Hostname Management, leave the mode Managed, and create it.`,
    );
    const dashboard = within(widget!).getByRole("link", { name: "Open Turnstile in the Cloudflare dashboard" });
    expect(dashboard).toHaveAttribute("href", TURNSTILE_DASHBOARD);
    expect(dashboard).toHaveAttribute("target", "_blank");
    expect(keys).toHaveTextContent("Copy the widget's site key and secret key here.");
    expect(siteKeyField()).toHaveAttribute("placeholder", "0x4AAAAAAA…");
    expect(button("Continue")).toBeDisabled();
    await user.type(siteKeyField(), KEYS.siteKey);
    expect(button("Continue")).toBeDisabled();
    await user.type(secretKeyField(), KEYS.secretKey);
    expect(button("Continue")).toBeEnabled();

    await user.click(button("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses keys that can't be a widget's on their fields, without drawing its check, until they're typed again", async () => {
    serve();
    const { user } = showSetup();
    await giveKeys(user, { siteKey: "a site key", secretKey: KEYS.secretKey });
    expect(screen.getByRole("alert")).toHaveTextContent(TURNSTILE_SITE_KEY_REFUSED);
    expect(siteKeyField()).toHaveAttribute("aria-invalid", "true");
    expect(siteKeyField()).toHaveAccessibleDescription(TURNSTILE_SITE_KEY_REFUSED);
    expect(screen.queryByTitle("Turnstile's check")).not.toBeInTheDocument();
    await user.clear(siteKeyField());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.type(siteKeyField(), KEYS.secretKey);
    await user.click(button("Continue"));
    expect(screen.getByRole("alert")).toHaveTextContent(TURNSTILE_SECRET_KEY_REFUSED);
    expect(secretKeyField()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("dialog", { name: "Set up Turnstile" })).toBeInTheDocument();
  });

  it("draws the widget's check with its site key, in the page's appearance, and saves the keys with the token once it passes", async () => {
    serve();
    const { user, onSaved, onClose } = showSetup();
    await giveKeys(user, { siteKey: ` ${KEYS.siteKey} `, secretKey: KEYS.secretKey });
    const check = await dialog("Pass the widget's check");
    expect(within(check).getByRole("heading", { name: "Pass the widget's check" })).toHaveFocus();
    expect(check).toHaveAccessibleDescription(
      "Ember draws the widget's check with its site key. Once it passes, Ember asks Cloudflare whether the secret key is the same widget's, then keeps both.",
    );
    // jsdom lays nothing out, so the step is narrower than the check draws at its flexible size.
    expect(frame()).toHaveAttribute("src", `${TURNSTILE_CHECK_PATH}#site_key=${KEYS.siteKey}&theme=light&size=compact`);
    expect(button("Waiting for the check…")).toBeDisabled();

    checkSays({ token: TOKEN });
    expect(await dialog("Turnstile is set up")).toHaveAccessibleDescription(
      "Turnstile now checks that whoever signs up, or asks Ember to email them a link to join or a code to reset a password, is a person, in place of the limits on each network.",
    );
    expect(onSaved).toHaveBeenCalledExactlyOnceWith("saved");
    expect(asked()).toEqual([["PUT /api/account/turnstile_keys", { ...KEYS, turnstileToken: TOKEN }]]);
    await user.click(button("Done"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("draws the check in the dark when the page is", async () => {
    document.documentElement.classList.add("dark");
    try {
      serve();
      const { user } = showSetup();
      await giveKeys(user);
      expect(frame().getAttribute("src")).toContain("&theme=dark&");
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });

  it("hears only its own frame, at Ember's origin", async () => {
    const fetch = serve();
    const { user } = showSetup();
    await giveKeys(user);
    checkSays({ token: TOKEN }, { source: window });
    checkSays({ token: TOKEN }, { origin: "https://elsewhere.example" });
    checkSays("not what the check page says");
    checkSays({ token: 42 });
    expect(fetch).not.toHaveBeenCalled();
    expect(button("Waiting for the check…")).toBeDisabled();
  });

  it("sends a key that's refused back to its field, keeping what was typed", async () => {
    serve(() => Response.json({ error: TURNSTILE_KEYS_UNMATCHED, field: "secretKey" }, { status: 422 }));
    const { user, onSaved, onFailed } = showSetup();
    await giveKeys(user);
    checkSays({ token: TOKEN });
    expect(await screen.findByRole("alert")).toHaveTextContent(TURNSTILE_KEYS_UNMATCHED);
    expect(screen.getByRole("dialog", { name: "Set up Turnstile" })).toBeInTheDocument();
    expect(secretKeyField()).toHaveAttribute("aria-invalid", "true");
    expect(siteKeyField()).toHaveValue(KEYS.siteKey);
    expect(secretKeyField()).toHaveValue(KEYS.secretKey);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("sends a site key Turnstile doesn't know back to its field, as its check says", async () => {
    const fetch = serve();
    const { user } = showSetup();
    await giveKeys(user);
    checkSays({ error: "110100" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Turnstile doesn't know that site key. Copy it again from your widget in Cloudflare Turnstile.");
    expect(siteKeyField()).toHaveAttribute("aria-invalid", "true");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a widget that doesn't list the hostname",
      { error: "110200" },
      `This widget doesn't list ${location.hostname}. Add it under Hostname Management in Cloudflare Turnstile, then try again. Open Turnstile in the Cloudflare dashboard`,
    ],
    ["a check that didn't pass", { error: "300030" }, "Turnstile's check didn't pass (error 300030). Try again, or in another browser."],
    ["Turnstile's script not loading", { unavailable: true }, "Turnstile's check didn't load. Make sure nothing in this browser blocks challenges.cloudflare.com, then try again."],
  ])("says what kept the check from passing with %s, and draws it afresh to try again", async (_, said, problem) => {
    const fetch = serve();
    const { user } = showSetup();
    await giveKeys(user);
    const drawn = frame();
    checkSays(said);
    expect(screen.getByRole("status")).toHaveTextContent(problem);
    expect(fetch).not.toHaveBeenCalled();

    await user.click(button("Try again"));
    expect(frame()).not.toBe(drawn);
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(button("Waiting for the check…")).toBeDisabled();
  });

  it.each([
    ["a check that expired", () => Response.json({ error: TURNSTILE_CHECK_EXPIRED, field: "turnstile" }, { status: 422 }), TURNSTILE_CHECK_EXPIRED],
    ["Cloudflare out of reach", () => Response.json({ error: TURNSTILE_KEYS_UNCHECKED }, { status: 502 }), TURNSTILE_KEYS_UNCHECKED],
  ])("says when it couldn't save the keys for %s, and tries again with a fresh check", async (_, answer, problem) => {
    serve(answer);
    const { user, onFailed } = showSetup();
    await giveKeys(user);
    checkSays({ token: TOKEN });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(problem));
    expect(onFailed).not.toHaveBeenCalled();
    await user.click(button("Try again"));
    checkSays({ token: "another token" });
    await waitFor(() => expect(asked()).toHaveLength(2));
    expect(asked()[1]).toEqual(["PUT /api/account/turnstile_keys", { ...KEYS, turnstileToken: "another token" }]);
  });

  it("can't be closed while it checks the keys, and says Checking…, hearing no other token meanwhile", async () => {
    const answer = held(() => Response.json({ turnstile: "saved" }));
    serve(answer.answered);
    const { user, onClose } = showSetup();
    await giveKeys(user);
    checkSays({ token: TOKEN });
    expect(await screen.findByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Checking the keys with Cloudflare…");
    expect(button("Back")).toBeDisabled();
    expect(button("Close")).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    checkSays({ token: "another token" });
    expect(asked()).toHaveLength(1);

    await answer.answer();
    expect(await dialog("Turnstile is set up")).toBeInTheDocument();
  });

  it("leaves a failure it can't say itself to the page's alerts, offering to try again", async () => {
    serve(() => Response.json({ error: "Only administrators can change the workspace" }, { status: 403 }));
    const { user, onFailed } = showSetup();
    await giveKeys(user);
    checkSays({ token: TOKEN });
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can change the workspace")));
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(button("Try again")).toBeEnabled();
  });

  it("says it has a widget's keys already when it's opened to change them, and goes back to them", async () => {
    serve();
    const { user } = showSetup("saved");
    expect(await screen.findByText("Ember has a widget's keys already. Give another widget's to check people with it instead.")).toBeInTheDocument();
    await giveKeys(user);
    await user.click(button("Back"));
    expect(await dialog("Set up Turnstile")).toBeInTheDocument();
    expect(siteKeyField()).toHaveValue(KEYS.siteKey);
  });
});
