import type { Account } from "@ember/protocol";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AccountContext, useAccount } from "@/hooks/use-account";
import { AppearanceMenu } from "./appearance-menu";

/** The button, as it sits on the rail between Workspace and your profile. */
function renderOnRail() {
  render(
    <>
      <a href="/account/edit">Workspace</a>
      <AppearanceMenu />
      {/* Shown in place, as the app's links are. */}
      <a href="/users/me/profile" onClick={(event) => event.preventDefault()}>
        Your profile
      </a>
    </>,
  );
  return screen.getByRole("button", { name: /^Appearance: / });
}

const dialog = () => screen.queryByRole("dialog", { name: "Appearance" });
const radio = (name: string) => screen.getByRole("radio", { name });

describe("Light, dark or system appearance", () => {
  it("is a button named and titled for the choice shown, with its icon", async () => {
    const user = userEvent.setup();
    const button = renderOnRail();
    expect(button).toHaveAccessibleName("Appearance: System");
    expect(button).toHaveAttribute("title", "Appearance: System");
    expect(button.querySelector(".iconoir-computer")).toBeInTheDocument();

    await user.click(button);
    await user.click(screen.getByText("Dark"));
    expect(button).toHaveAccessibleName("Appearance: Dark");
    expect(button).toHaveAttribute("title", "Appearance: Dark");
    expect(button.querySelector(".iconoir-half-moon")).toBeInTheDocument();

    await user.click(screen.getByText("Light"));
    expect(button).toHaveAccessibleName("Appearance: Light");
    expect(button.querySelector(".iconoir-sun-light")).toBeInTheDocument();
  });

  it("opens a dialog of Light, Dark and System radio buttons, with the current one checked and focused", async () => {
    const user = userEvent.setup();
    const button = renderOnRail();
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const choices = within(dialog()!).getByRole("group", { name: "Appearance" });
    expect(within(choices).getAllByRole("radio").map((choice) => choice.closest("label")!.textContent)).toEqual(["Light", "Dark", "System"]);
    // Each with the icon the button shows for it.
    expect(within(choices).getAllByRole("radio").map((choice) => choice.closest("label")!.querySelector("svg")!.classList[0])).toEqual([
      "iconoir-sun-light",
      "iconoir-half-moon",
      "iconoir-computer",
    ]);
    expect(radio("System")).toBeChecked();
    expect(radio("System")).toHaveFocus();
  });

  it("applies and saves a choice at once, and stays open for another", async () => {
    const user = userEvent.setup();
    renderOnRail();
    await user.click(screen.getByRole("button", { name: "Appearance: System" }));
    await user.click(screen.getByText("Dark"));
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("ember:appearance")).toBe("dark");
    expect(radio("Dark")).toBeChecked();
    expect(dialog()).toBeInTheDocument();

    // The arrow keys move between them, as a group of radio buttons does.
    await user.keyboard("{ArrowDown}");
    expect(radio("System")).toBeChecked();
    expect(localStorage.getItem("ember:appearance")).toBe("system");
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("opens on the choice saved before", async () => {
    localStorage.setItem("ember:appearance", "dark");
    const user = userEvent.setup();
    await user.click(renderOnRail());
    expect(radio("Dark")).toBeChecked();
    expect(radio("Dark")).toHaveFocus();
  });

  it("closes with Escape, back on its button", async () => {
    const user = userEvent.setup();
    const button = renderOnRail();
    await user.click(button);
    await user.keyboard("{Escape}");
    expect(dialog()).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("closes with Tab, going on from its button either way", async () => {
    const user = userEvent.setup();
    const button = renderOnRail();
    await user.click(button);
    await user.tab();
    expect(dialog()).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Your profile" })).toHaveFocus();

    await user.click(button);
    await user.tab({ shift: true });
    expect(dialog()).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Workspace" })).toHaveFocus();
  });

  it("closes with a click elsewhere", async () => {
    const user = userEvent.setup();
    const button = renderOnRail();
    await user.click(button);
    await user.click(screen.getByRole("link", { name: "Your profile" }));
    expect(dialog()).not.toBeInTheDocument();
  });
});

describe("Navigation icons", () => {
  function AccountWith({ navigationIcons }: { navigationIcons: Account["navigationIcons"] }) {
    return (
      <AccountContext value={{ ...useAccount(), navigationIcons }}>
        <AppearanceMenu />
      </AccountContext>
    );
  }

  it("draws the icons an administrator chose for the modes, and Iconoir's for the rest", async () => {
    const user = userEvent.setup();
    render(<AccountWith navigationIcons={{ system: "monitor-cog", dark: "iconoir:regular:moon-sat" }} />);
    const button = screen.getByRole("button", { name: "Appearance: System" });
    expect(button.querySelector("[data-icon]")).toHaveAttribute("data-icon", "monitor-cog");

    await user.click(button);
    const iconOf = (name: string) => radio(name).closest("label")!.querySelector("[data-icon], svg:not(:last-child)");
    expect(iconOf("Light")).toHaveClass("iconoir-sun-light");
    expect(iconOf("Dark")).toHaveAttribute("data-icon", "iconoir:regular:moon-sat");
    expect(iconOf("System")).toHaveAttribute("data-icon", "monitor-cog");
  });
});
