import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ShortcutTooltip } from "./shortcut-tooltip";

/** A button named in its tooltip, which `hidden` keeps closed. */
function buttonWith(hidden: boolean) {
  return (
    <ShortcutTooltip label="Schedule for later" hidden={hidden}>
      <button type="button">Schedule</button>
    </ShortcutTooltip>
  );
}

describe("ShortcutTooltip", () => {
  it("names the button the moment the pointer reaches it", async () => {
    const user = userEvent.setup();
    render(buttonWith(false));
    await user.hover(screen.getByRole("button", { name: "Schedule" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Schedule for later");
  });

  it("stays closed once hidden, as while its button's menu is open, rather than showing again as the menu closes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(buttonWith(false));
    // Open as a quick press that opens the menu finds it, before the menu hides it.
    await user.hover(screen.getByRole("button", { name: "Schedule" }));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    rerender(buttonWith(true));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    rerender(buttonWith(false));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
