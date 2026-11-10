import { INVITATIONS_AT_ONCE, NO_EMAIL_ADDRESSES, type EmailInvitation, type InvitationOutcome, type ResentInvitation } from "@ember/protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { dateLabel } from "@/lib/messages";
import { CONFIRM_REVOKE, InviteByEmail } from "./invite-by-email";

const DAY_MS = 24 * 60 * 60 * 1000;
const LINK = "https://ember.test/join/invitation#token=";

/** An invitation to `emailAddress`, made `daysAgo` days ago, as the server answers one, but for `changes`. */
function invitation(emailAddress: string, changes: Partial<EmailInvitation> = {}, daysAgo = 0): EmailInvitation {
  const createdAt = Date.now() - daysAgo * DAY_MS;
  return {
    id: `id-${emailAddress}`,
    emailAddress,
    invitedBy: "Ada Lovelace",
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + 7 * DAY_MS).toISOString(),
    delivery: "sent",
    ...changes,
  };
}

/** What inviting each of `emailAddresses` comes to: an invitation emailed, unless `delivery` says otherwise, with its link while it wasn't emailed. */
const outcomeOf = (emailAddress: string, delivery: EmailInvitation["delivery"] = "sent"): InvitationOutcome => ({
  emailAddress,
  invitation: invitation(emailAddress, { delivery }),
  link: delivery === "sent" ? null : `${LINK}${emailAddress}`,
});

interface Answers {
  /** What inviting answers, for the addresses asked: each emailed, unless given. */
  invited?: (emailAddresses: string[]) => Response | Promise<Response>;
  resent?: (id: string) => Response;
  revoked?: (id: string) => Response;
}

/** Answers the card's requests as the server would, or as `answers` says. */
function serve({ invited, resent, revoked }: Answers = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input);
    if (init?.method === "POST" && path === "/api/invitations") {
      const { emailAddresses } = JSON.parse(String(init.body)) as { emailAddresses: string[] };
      return invited ? invited(emailAddresses) : Response.json({ outcomes: emailAddresses.map((address) => outcomeOf(address)) });
    }
    const resend = /^\/api\/invitations\/([^/]+)\/resend$/.exec(path);
    if (init?.method === "POST" && resend) return resent!(decodeURIComponent(resend[1]!));
    const revoke = /^\/api\/invitations\/([^/]+)$/.exec(path);
    if (init?.method === "DELETE" && revoke) return revoked ? revoked(decodeURIComponent(revoke[1]!)) : new Response(null, { status: 204 });
    throw new Error(`Unexpected request for ${init?.method} ${path}`);
  });
}

/** The addresses each request to invite asked for, in order. */
const asked = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => init?.method === "POST" && path === "/api/invitations")
    .map(([, init]) => (JSON.parse(String(init?.body)) as { emailAddresses: string[] }).emailAddresses);

/** The card, with `invitations` pending, keeping them as Membership does. */
function showCard({ invitations = [], emails = true }: { invitations?: EmailInvitation[]; emails?: boolean } = {}) {
  const onFailed = vi.fn();
  const onSetUpEmail = vi.fn();
  function Card() {
    const [pending, setPending] = useState(invitations);
    return <InviteByEmail invitations={pending} emails={emails} onSetUpEmail={onSetUpEmail} onInvitationsChanged={setPending} onFailed={onFailed} />;
  }
  render(<Card />);
  return { onFailed, onSetUpEmail, user: userEvent.setup() };
}

const card = () => screen.getByRole("region", { name: "Invite by email" });
const box = () => screen.getByRole("textbox", { name: "Email addresses" });
const sendButton = () => screen.getByRole("button", { name: /^(Send invitations|Create invite links)$/ });
const outcome = () => screen.getByRole("status");
const pending = () => screen.queryByRole("region", { name: "Pending invitations" });
const rows = () => within(pending()!).getAllByRole("listitem");
const rowFor = (emailAddress: string) => rows().find((row) => within(row).queryByText(emailAddress, { selector: "strong" }))!;

afterEach(() => vi.restoreAllMocks());

describe("Invite people by email", () => {
  it("emails each address typed, apart by commas, spaces or lines, or with names, saying what came of them", async () => {
    serve();
    const { user } = showCard();
    expect(card()).toHaveTextContent("Ember emails each person a link to join with their address, whichever ways to join are on. A link works once, for 7 days.");
    expect(pending()).not.toBeInTheDocument();
    await user.type(box(), "ann@example.com, bob@example.com;cy@example.com{Enter}Dee <dee@example.com> ANN@example.com");
    await user.click(sendButton());

    expect(asked()).toEqual([["ann@example.com", "bob@example.com", "cy@example.com", "dee@example.com"]]);
    expect(await screen.findByText("Sent 4 invitations.")).toBe(outcome());
    expect(box()).toHaveValue("");
    expect(rows().map((row) => within(row).getByText(/@/, { selector: "strong" }).textContent)).toEqual(["dee@example.com", "cy@example.com", "bob@example.com", "ann@example.com"]);
    expect(rowFor("ann@example.com")).toHaveTextContent(`Emailed · Invited by Ada Lovelace · Expires ${dateLabel(new Date(Date.now() + 7 * DAY_MS))}`);
    expect(within(rowFor("ann@example.com")).queryByRole("button", { name: /^Copy/ })).not.toBeInTheDocument();
  });

  it("says what isn't an email address, sending nothing until it's fixed", async () => {
    serve();
    const { user } = showCard();
    await user.type(box(), "ann@example.com bob cy@example");
    await user.click(sendButton());
    expect(outcome()).toHaveTextContent("These aren't email addresses: bob, cy@example. Fix or remove them, then send again.");
    expect(box()).toHaveAttribute("aria-invalid", "true");
    expect(box()).toHaveValue("ann@example.com bob cy@example");

    await user.clear(box());
    await user.click(sendButton());
    expect(outcome()).toHaveTextContent(`${NO_EMAIL_ADDRESSES}.`);
    expect(asked()).toEqual([]);
  });

  it(`sends a long list ${INVITATIONS_AT_ONCE} at a time`, async () => {
    serve();
    const { user } = showCard();
    const emailAddresses = Array.from({ length: 45 }, (_, n) => `person${n}@example.com`);
    await user.click(box());
    await user.paste(emailAddresses.join("\n"));
    await user.click(sendButton());
    expect(await screen.findByText("Sent 45 invitations.")).toBeInTheDocument();
    expect(asked()).toEqual([emailAddresses.slice(0, 20), emailAddresses.slice(20, 40), emailAddresses.slice(40)]);
    expect(rows()).toHaveLength(45);
  });

  it("waits while it's sending, saying so, holding the addresses and each pending invitation's buttons, whose changes its answer would undo", async () => {
    let answer = (_: Response) => {};
    serve({ invited: () => new Promise<Response>((resolve) => (answer = resolve)) });
    const { user } = showCard({ invitations: [invitation("ann@example.com", {}, 1)] });
    const buttons = () => within(rowFor("ann@example.com")).getAllByRole("button");
    await user.type(box(), "ann@example.com");
    await user.click(sendButton());
    expect(outcome()).toHaveTextContent("Sending invitations…");
    expect(sendButton()).toBeDisabled();
    expect(box()).toBeDisabled();
    expect(buttons().map((button) => button.getAttribute("aria-label"))).toEqual(["Send again for ann@example.com", "Revoke the invitation for ann@example.com"]);
    for (const button of buttons()) expect(button).toBeDisabled();
    answer(Response.json({ outcomes: [outcomeOf("ann@example.com")] }));
    expect(await screen.findByText("Sent 1 invitation.")).toBeInTheDocument();
    expect(sendButton()).toBeEnabled();
    expect(box()).toBeEnabled();
    for (const button of buttons()) expect(button).toBeEnabled();
  });

  it("says which addresses have accounts already", async () => {
    serve({ invited: () => Response.json({ outcomes: [{ emailAddress: "Ada@example.com", member: true }, outcomeOf("ann@example.com"), { emailAddress: "grace@example.com", member: true }] }) });
    const { user } = showCard();
    await user.type(box(), "Ada@example.com ann@example.com grace@example.com");
    await user.click(sendButton());
    expect(await screen.findByRole("status")).toHaveTextContent("Sent 1 invitation. Ada@example.com, grace@example.com have accounts already.");
    expect(rows()).toHaveLength(1);
  });

  it("gives the links to copy while Ember can't send email", async () => {
    serve({ invited: (emailAddresses) => Response.json({ outcomes: emailAddresses.map((address) => outcomeOf(address, null)) }) });
    const { user, onSetUpEmail } = showCard({ emails: false });
    expect(card()).toHaveTextContent("Ember can't send email yet, so you'll get each person's link to send them yourself. A link works once, for 7 days. Set up email to have Ember send them.");
    await user.click(within(card()).getByRole("button", { name: "Set up email" }));
    expect(onSetUpEmail).toHaveBeenCalledOnce();
    await user.type(box(), "ann@example.com bob@example.com");
    await user.click(screen.getByRole("button", { name: "Create invite links" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Made 2 invite links. Copy each below and send it yourself.");
    expect(rowFor("ann@example.com")).toHaveTextContent("Not emailed · Invited by Ada Lovelace");

    await user.click(within(rowFor("ann@example.com")).getByRole("button", { name: "Copy the invite link for ann@example.com" }));
    expect(await navigator.clipboard.readText()).toBe(`${LINK}ann@example.com`);
  });

  it("says why the provider refused an invitation, giving its link to copy", async () => {
    const refusal = "Cloudflare won't send to that address, since email to it bounced or was marked as spam before.";
    serve({ invited: () => Response.json({ outcomes: [outcomeOf("ann@example.com"), outcomeOf("bob@example.com", { refusal })] }) });
    const { user } = showCard();
    await user.type(box(), "ann@example.com bob@example.com");
    await user.click(sendButton());
    expect(await screen.findByRole("status")).toHaveTextContent("Sent 1 invitation. 1 invitation couldn't be emailed. Copy its link below to send yourself.");
    expect(rowFor("bob@example.com")).toHaveTextContent(`Not emailed: ${refusal}`);
    await user.click(within(rowFor("bob@example.com")).getByRole("button", { name: "Copy the invite link for bob@example.com" }));
    expect(await navigator.clipboard.readText()).toBe(`${LINK}bob@example.com`);
  });

  it("leaves to the page's alerts a failure it can't say itself, keeping the addresses not yet invited", async () => {
    const emailAddresses = Array.from({ length: 25 }, (_, n) => `person${n}@example.com`);
    let calls = 0;
    serve({
      invited: (asked) =>
        ++calls === 1 ? Response.json({ outcomes: asked.map((address) => outcomeOf(address)) }) : Response.json({ error: "Only administrators can invite people" }, { status: 403 }),
    });
    const { user, onFailed } = showCard();
    await user.click(box());
    await user.paste(emailAddresses.join(" "));
    await user.click(sendButton());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can invite people")));
    expect(outcome()).toHaveTextContent("Sent 20 invitations.");
    expect(box()).toHaveValue(emailAddresses.slice(20).join("\n"));
    expect(rows()).toHaveLength(20);
  });

  describe("pending invitations", () => {
    it("lists each with who sent it, whether it was emailed, and when its link stops working, or stopped", () => {
      serve();
      const old = invitation("old@example.com", { delivery: null }, 8);
      const refused = invitation("bob@example.com", { delivery: { refusal: "Resend's daily sending quota is used up." } }, 1);
      showCard({ invitations: [invitation("ann@example.com"), refused, old] });
      expect(rowFor("ann@example.com")).toHaveTextContent(`Emailed · Invited by Ada Lovelace · Expires ${dateLabel(new Date(invitation("ann@example.com").expiresAt))}`);
      expect(rowFor("bob@example.com")).toHaveTextContent("Not emailed: Resend's daily sending quota is used up. · Invited by Ada Lovelace");
      expect(rowFor("old@example.com")).toHaveTextContent(`Not emailed · Invited by Ada Lovelace · Expired ${dateLabel(new Date(old.expiresAt))}`);
    });

    it("sends one again with a new link, which it gives to copy while it wasn't emailed", async () => {
      const resentAt = new Date().toISOString();
      const answers: ResentInvitation[] = [
        { invitation: invitation("ann@example.com", { createdAt: resentAt, delivery: "sent" }), link: null },
        { invitation: invitation("ann@example.com", { createdAt: resentAt, delivery: { refusal: "Resend didn't answer. Try again later." } }), link: `${LINK}new` },
      ];
      serve({ resent: () => Response.json(answers.shift()) });
      const { user } = showCard({ invitations: [invitation("ann@example.com", { delivery: null }, 2)] });
      await user.click(within(rowFor("ann@example.com")).getByRole("button", { name: "Send again for ann@example.com" }));
      await waitFor(() => expect(rowFor("ann@example.com")).toHaveTextContent("Emailed"));

      await user.click(within(rowFor("ann@example.com")).getByRole("button", { name: "Send again for ann@example.com" }));
      await waitFor(() => expect(rowFor("ann@example.com")).toHaveTextContent("Not emailed: Resend didn't answer. Try again later."));
      await user.click(within(rowFor("ann@example.com")).getByRole("button", { name: "Copy the invite link for ann@example.com" }));
      expect(await navigator.clipboard.readText()).toBe(`${LINK}new`);
      expect(vi.mocked(fetch).mock.calls.map(([path, init]) => `${init?.method} ${String(path)}`)).toEqual([
        "POST /api/invitations/id-ann%40example.com/resend",
        "POST /api/invitations/id-ann%40example.com/resend",
      ]);
    });

    it("makes a new link while Ember can't send email", async () => {
      serve({ resent: () => Response.json({ invitation: invitation("ann@example.com", { delivery: null }), link: `${LINK}new` }) });
      const { user } = showCard({ invitations: [invitation("ann@example.com", { delivery: null }, 2)], emails: false });
      await user.click(within(rowFor("ann@example.com")).getByRole("button", { name: "New link for ann@example.com" }));
      await user.click(await within(rowFor("ann@example.com")).findByRole("button", { name: "Copy the invite link for ann@example.com" }));
      expect(await navigator.clipboard.readText()).toBe(`${LINK}new`);
    });

    it("revokes one once they confirm", async () => {
      serve();
      const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
      const { user } = showCard({ invitations: [invitation("ann@example.com"), invitation("bob@example.com")] });
      const revoke = () => within(rowFor("ann@example.com")).getByRole("button", { name: "Revoke the invitation for ann@example.com" });
      await user.click(revoke());
      expect(confirm).toHaveBeenCalledWith(CONFIRM_REVOKE);
      expect(fetch).not.toHaveBeenCalled();

      await user.click(revoke());
      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(rows()[0]).toHaveTextContent("bob@example.com");
      expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/invitations/id-ann%40example.com", expect.objectContaining({ method: "DELETE" }));
    });

    it("takes away one found accepted or revoked already, and leaves other failures to the page's alerts", async () => {
      serve({ resent: () => Response.json({ error: "Not found" }, { status: 404 }), revoked: () => Response.json({ error: "Not signed in" }, { status: 401 }) });
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const { user, onFailed } = showCard({ invitations: [invitation("ann@example.com"), invitation("bob@example.com")] });
      await user.click(within(rowFor("ann@example.com")).getByRole("button", { name: "Send again for ann@example.com" }));
      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(onFailed).not.toHaveBeenCalled();

      await user.click(within(rowFor("bob@example.com")).getByRole("button", { name: "Revoke the invitation for bob@example.com" }));
      await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(401, "Not signed in")));
      expect(rows()).toHaveLength(1);
      expect(within(rowFor("bob@example.com")).getByRole("button", { name: "Revoke the invitation for bob@example.com" })).toBeEnabled();
    });
  });
});
