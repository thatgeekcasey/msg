import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageLink } from "./page-link";

afterEach(() => history.replaceState(null, "", "/"));

describe("Room settings page", () => {
  it("shows the page it links to in place, as a new entry in the history", async () => {
    const onClick = vi.fn();
    render(
      <PageLink href="/account/edit" onClick={onClick}>
        Workspace
      </PageLink>,
    );
    const length = history.length;
    await userEvent.click(screen.getByRole("link", { name: "Workspace" }));
    expect(location.pathname).toBe("/account/edit");
    expect(history.length).toBe(length + 1);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("takes the current page's place in the history when it replaces it", async () => {
    render(
      <PageLink href="/rooms/closeds/new" replace>
        Private
      </PageLink>,
    );
    const length = history.length;
    await userEvent.click(screen.getByRole("link", { name: "Private" }));
    expect(location.pathname).toBe("/rooms/closeds/new");
    expect(history.length).toBe(length);
  });

  it.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])(
    "leaves a click with %o to the browser, which opens the link somewhere else",
    (init) => {
      render(<PageLink href="/account/edit">Workspace</PageLink>);
      // After the link has had the click, whether it kept the browser from following it; then this
      // keeps jsdom, which can't, from trying.
      const leftToTheBrowser = vi.fn();
      document.addEventListener(
        "click",
        (event) => {
          leftToTheBrowser(!event.defaultPrevented);
          event.preventDefault();
        },
        { once: true },
      );
      fireEvent.click(screen.getByRole("link", { name: "Workspace" }), init);
      expect(leftToTheBrowser).toHaveBeenCalledWith(true);
      expect(location.pathname).toBe("/");
    },
  );
});
