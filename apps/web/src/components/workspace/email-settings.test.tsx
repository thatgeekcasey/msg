import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CANT_SEND_EMAIL, type EmailSettings as Email } from "@ember/protocol";
import { ApiError } from "@/lib/api";
import { CONFIRM_STOP_EMAIL, EmailSettings } from "./email-settings";

/** How a new workspace sends email: with the binding wrangler.jsonc declares, from no address yet. */
const NEW_EMAIL: Email = { provider: "cloudflare", resendKey: null, cloudflare: true, from: null };

/** Answers Send me a test email as the server would, or as `tested` says, and Stop sending email as `stopped` says. */
function serve(
  tested: () => Response | Promise<Response> = () => Response.json({ to: "ada@example.com" }),
  stopped: () => Response | Promise<Response> = () => Response.json({ account: { name: "Ember" } }),
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    switch (`${init?.method} ${String(input)}`) {
      case "POST /api/account/test_email":
        return tested();
      case "PATCH /api/account":
        return stopped();
      default:
        throw new Error(`Unexpected request for ${init?.method} ${String(input)}`);
    }
  });
}

/** A response the test lets through when it says, with `answer` letting it through. */
function held(response: () => Response) {
  let answer = () => {};
  const answered = new Promise<Response>((resolve) => (answer = () => resolve(response())));
  return { answered: () => answered, answer: () => act(async () => answer()) };
}

/** The card, for a workspace that sends email as `email` says. */
function showCard(email: Email) {
  const answered = vi.fn();
  const callbacks = { askForAccount: vi.fn(() => answered), onSetUp: vi.fn(), onStopped: vi.fn(), onFailed: vi.fn() };
  const { rerender } = render(<EmailSettings email={email} {...callbacks} />);
  return { ...callbacks, answered, rerender: (email: Email) => rerender(<EmailSettings email={email} {...callbacks} />), user: userEvent.setup() };
}

const card = () => screen.getByRole("region", { name: "Email" });
const testButton = () => screen.queryByRole("button", { name: "Send me a test email" });
const stopButton = () => screen.queryByRole("button", { name: "Stop sending email" });

afterEach(() => vi.restoreAllMocks());

describe("Sending email", () => {
  it("says Ember can't send email yet, and what that keeps it from, with Set up email", async () => {
    serve();
    const { user, onSetUp } = showCard(NEW_EMAIL);
    expect(card()).toHaveTextContent("Ember can't send email yet, so it can't email invitations, the links people at your email domains join with, or codes to reset a forgotten password.");
    expect(testButton()).not.toBeInTheDocument();
    expect(stopButton()).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Set up email" }));
    expect(onSetUp).toHaveBeenCalledOnce();
  });

  it.each<[string, Email]>([
    ["a From address but nothing to send with", { ...NEW_EMAIL, provider: null, cloudflare: false, from: "chat@example.com" }],
    ["a Resend API key but no From address", { ...NEW_EMAIL, provider: "resend", resendKey: "saved" }],
  ])("says Ember can't send email yet with %s", (_, email) => {
    serve();
    showCard(email);
    expect(card()).toHaveTextContent("Ember can't send email yet");
    expect(screen.getByRole("button", { name: "Set up email" })).toBeInTheDocument();
    expect(testButton()).not.toBeInTheDocument();
  });

  it.each<[string, Email]>([
    ["with Cloudflare Email Service", { ...NEW_EMAIL, from: "Ember <ember@example.com>" }],
    ["with Resend", { ...NEW_EMAIL, provider: "resend", resendKey: "saved", from: "Ember <ember@example.com>" }],
    ["with Resend, with the API key in RESEND_API_KEY", { ...NEW_EMAIL, provider: "resend", resendKey: "secret", from: "Ember <ember@example.com>" }],
  ])("says Ember sends email from its From address %s, with Change, Stop sending email and a test email", async (sentWith, email) => {
    serve();
    const { user, onSetUp } = showCard(email);
    expect(card()).toHaveTextContent(`Ember sends email from Ember <ember@example.com> ${sentWith}.`);
    expect(testButton()).toBeEnabled();
    expect(stopButton()).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(onSetUp).toHaveBeenCalledOnce();
  });

  it("puts its buttons in one row under what it says, as Custom domain's card does", () => {
    serve();
    showCard({ ...NEW_EMAIL, from: "Ember <ember@example.com>" });
    const buttons = within(card()).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Send me a test email", "Change", "Stop sending email"]);
    expect(new Set(buttons.map((button) => button.parentElement)).size).toBe(1);
  });

  it("takes the From address away once the administrator confirms Stop sending email", async () => {
    const answer = held(() => Response.json({ account: { name: "Ember" } }));
    const fetch = serve(undefined, answer.answered);
    const sure = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user, answered, onStopped } = showCard({ ...NEW_EMAIL, from: "Ember <ember@example.com>" });
    await user.click(stopButton()!);
    expect(sure).toHaveBeenCalledWith(CONFIRM_STOP_EMAIL);
    expect(fetch).not.toHaveBeenCalled();

    await user.click(stopButton()!);
    expect(fetch).toHaveBeenCalledWith("/api/account", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ emailFrom: null }) }));
    expect(stopButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
    await answer.answer();
    expect(answered).toHaveBeenCalledWith({ name: "Ember" });
    expect(onStopped).toHaveBeenCalledOnce();
    expect(stopButton()).toBeEnabled();
  });

  it("leaves Stop sending email that failed to the page's alerts", async () => {
    serve(undefined, () => Response.json({ error: "Only administrators can change the workspace" }, { status: 403 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onStopped, onFailed } = showCard({ ...NEW_EMAIL, from: "Ember <ember@example.com>" });
    await user.click(stopButton()!);
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can change the workspace")));
    expect(onStopped).not.toHaveBeenCalled();
    expect(stopButton()).toBeEnabled();
  });

  it("sends a test email, and says where it went", async () => {
    const answer = held(() => Response.json({ to: "ada@example.com" }));
    serve(answer.answered);
    const { user } = showCard({ ...NEW_EMAIL, from: "Ember <ember@example.com>" });
    await user.click(testButton()!);
    expect(screen.getByRole("status")).toHaveTextContent("Sending a test email…");
    expect(testButton()).toBeDisabled();

    await answer.answer();
    expect(screen.getByRole("status")).toHaveTextContent("Sent to ada@example.com. If it isn't in your inbox, look in spam.");
    expect(testButton()).toBeEnabled();
  });

  it("forgets what a test email came to once the From address changes", async () => {
    serve();
    const { user, rerender } = showCard({ ...NEW_EMAIL, from: "chat@example.com" });
    await user.click(testButton()!);
    expect(await screen.findByText("Sent to ada@example.com. If it isn't in your inbox, look in spam.")).toBeInTheDocument();
    rerender({ ...NEW_EMAIL, from: "ember@example.com" });
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it.each([
    [502, "Resend refused it: The example.com domain is not verified."],
    [503, CANT_SEND_EMAIL],
    [422, "Give Ember a From address first."],
  ])("says why the test email wasn't sent when the server answers %i", async (status, error) => {
    serve(() => Response.json({ error }, { status }));
    const { user, onFailed } = showCard({ ...NEW_EMAIL, provider: "resend", resendKey: "saved", from: "Ember <ember@example.com>" });
    await user.click(testButton()!);
    expect(await screen.findByText(error, { selector: "[role=status]" })).toBeInTheDocument();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("leaves a test email that failed for another reason to the page's alerts", async () => {
    serve(() => Response.json({ error: "Only administrators can change the workspace" }, { status: 403 }));
    const { user, onFailed } = showCard({ ...NEW_EMAIL, from: "chat@example.com" });
    await user.click(testButton()!);
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can change the workspace")));
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(testButton()).toBeEnabled();
  });
});
