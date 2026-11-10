import type { Favorites } from "@ember/protocol";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FavoriteButton } from "./favorite-button";

const starred: Favorites = { rooms: ["general"], version: 1 };

function renderStar(favorite = false) {
  const [onSaved, onSessionChanged] = [vi.fn(), vi.fn()];
  const view = render(<FavoriteButton roomId="general" favorite={favorite} onSaved={onSaved} onSessionChanged={onSessionChanged} />);
  return { ...view, onSaved, onSessionChanged, star: screen.getByRole("button", { name: "Favorite room" }) };
}

/** What the star sent, as the JSON it sent it as. */
const sent = () => vi.mocked(fetch).mock.calls.map(([input, init]) => [String(input), init?.method, JSON.parse(String(init?.body))]);

beforeEach(() => {
  vi.spyOn(globalThis, "fetch");
});

afterEach(() => vi.restoreAllMocks());

describe("Star rooms", () => {
  it("stars the room, handing on the stars the server answers", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ favorites: starred }));
    const { star, onSaved } = renderStar();
    expect(star).toHaveAttribute("aria-pressed", "false");
    expect(star).toHaveAttribute("title", "Add to favorites");
    expect(star.querySelector("svg")).toHaveClass("size-[18px]", "iconoir-star");

    await userEvent.click(star);
    expect(sent()).toEqual([["/api/rooms/general/favorite", "PUT", { favorite: true }]]);
    expect(onSaved).toHaveBeenCalledWith(starred);
  });

  it("unstars a starred room, filled until then", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ favorites: { rooms: [], version: 2 } }));
    const { star, onSaved } = renderStar(true);
    expect(star).toHaveAttribute("aria-pressed", "true");
    expect(star).toHaveAttribute("title", "Remove from favorites");
    expect(star.querySelector("svg")).toHaveClass("size-[18px]", "iconoir-star-solid");
    // In the muted color at 65%.
    expect(star).toHaveClass("text-muted-foreground/65");

    await userEvent.click(star);
    expect(sent()).toEqual([["/api/rooms/general/favorite", "PUT", { favorite: false }]]);
    expect(onSaved).toHaveBeenCalledWith({ rooms: [], version: 2 });
  });

  it("is dimmed while it saves, keeping the keyboard's focus and ignoring presses", async () => {
    let answer!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { star, onSaved } = renderStar();
    const user = userEvent.setup();

    star.focus();
    await user.keyboard(" ");
    expect(star).toHaveAttribute("aria-disabled", "true");
    expect(star).toHaveClass("aria-disabled:opacity-50", "aria-disabled:pointer-events-none", "aria-disabled:grayscale", "aria-disabled:contrast-50");
    await user.keyboard(" ");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(star).toHaveFocus();

    await act(async () => answer(Response.json({ favorites: starred })));
    expect(star).not.toHaveAttribute("aria-disabled");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the server fails", () => Promise.resolve(Response.json({ error: "Workspace unavailable" }, { status: 503 }))],
    ["it can't be reached", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("says so under the star when %s, changing nothing, until it's pressed again", async (_, answer) => {
    vi.mocked(fetch).mockImplementationOnce(answer);
    const { star, onSaved, onSessionChanged } = renderStar();

    await userEvent.click(star);
    const note = screen.getByRole("status");
    expect(note).toHaveTextContent("Couldn’t save your favorite. Please try again.");
    expect(note).toHaveClass("absolute", "top-full", "left-0", "w-[200px]", "text-[13px]");
    expect(star).toHaveAttribute("aria-pressed", "false");
    expect(star).not.toHaveAttribute("aria-disabled");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onSessionChanged).not.toHaveBeenCalled();

    vi.mocked(fetch).mockResolvedValue(Response.json({ favorites: starred }));
    await userEvent.click(star);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledWith(starred);
  });

  it("sends someone whose session has expired to sign in", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: "Not signed in" }, { status: 401 }));
    const { star, onSessionChanged } = renderStar();
    await userEvent.click(star);
    expect(onSessionChanged).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("hears nothing about a session once it's gone from the page, as when another person has signed in", async () => {
    let answer!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { star, onSessionChanged, unmount } = renderStar();
    await userEvent.click(star);

    unmount();
    await act(async () => answer(Response.json({ error: "Not signed in" }, { status: 401 })));
    expect(onSessionChanged).not.toHaveBeenCalled();
  });
});
