import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestSignIn } from "./guest-sign-in";

const respond = (status: number, body: unknown) => vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status }));

afterEach(() => vi.restoreAllMocks());

describe("Sign in with a display name", () => {
  it("asks for the name people will see, and joins with it", async () => {
    const ada = { id: "u1", name: "Ada" };
    const fetch = respond(201, { user: ada });
    const onSignedIn = vi.fn();
    const user = userEvent.setup();
    render(<GuestSignIn logo={null} onSignedIn={onSignedIn} onUsePassword={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Welcome to Ember" })).toBeInTheDocument();
    const name = screen.getByLabelText("Your name");
    expect(name).toHaveFocus();
    expect(screen.getByRole("button", { name: "Join" })).toBeDisabled();

    await user.type(name, "Ada{Enter}");
    expect(fetch).toHaveBeenCalledWith("/api/session", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Ada" }) }));
    expect(onSignedIn).toHaveBeenCalledWith(ada);
  });

  it("won't join with a blank name and caps names at 48 characters", async () => {
    render(<GuestSignIn logo={null} onSignedIn={vi.fn()} onUsePassword={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Your name"), "   ");
    expect(screen.getByRole("button", { name: "Join" })).toBeDisabled();
    expect(screen.getByLabelText("Your name")).toHaveAttribute("maxlength", "48");
  });

  it("shows the server's reason when it refuses, on the field", async () => {
    respond(422, { error: "Name must be 1 to 48 characters" });
    const onSignedIn = vi.fn();
    render(<GuestSignIn logo={null} onSignedIn={onSignedIn} onUsePassword={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Your name"), "Ada{Enter}");

    expect(await screen.findByText("Name must be 1 to 48 characters")).toBeInTheDocument();
    expect(screen.getByLabelText("Your name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Your name")).toHaveAccessibleDescription("Name must be 1 to 48 characters");
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Join" })).toBeEnabled();
  });

  it("goes back to signing in with a password for someone who has an account", async () => {
    const onUsePassword = vi.fn();
    render(<GuestSignIn logo={null} onSignedIn={vi.fn()} onUsePassword={onUsePassword} />);
    expect(screen.getByText(/Have an account\?/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onUsePassword).toHaveBeenCalledOnce();
  });
});
