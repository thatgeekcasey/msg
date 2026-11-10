import type { Me } from "@ember/protocol";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPage } from "@/lib/page";
import { rememberThisPage } from "@/lib/return-path";
import { TransferPage } from "./transfer-page";

vi.mock("@/lib/page", () => ({ loadPage: vi.fn() }));

const grace: Me = { id: "u2", name: "Grace Hopper", administrator: false };
const TRANSFER_ID = "u2.mgk3x2a9.Ab-_9z";

/** Answers the page's requests to sign in with `answers`, one each, in order. */
function serve(...answers: Array<() => Response>) {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const answer of answers) fetch.mockImplementationOnce(async () => answer());
  return fetch;
}

/** Opens the sign-in link's page at `address`, the link itself unless given. */
function open(address = `/session/transfers#token=${TRANSFER_ID}`) {
  history.replaceState(null, "", address);
  return render(<TransferPage />);
}

const signedIn = () => Response.json({ user: grace }, { status: 201 });
const unreachable = () => {
  throw new TypeError("Failed to fetch");
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(loadPage).mockClear();
  vi.useRealTimers();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

describe("Private sign-in link", () => {
  it("signs in with the link's id as soon as it opens, sending it in the body, busy until it loads home as whoever the link is for", async () => {
    const fetch = serve(signedIn);
    open();
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/"));
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/api/session/transfers",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ transferId: TRANSFER_ID }) }),
    );
  });

  it("takes the id out of the address as it opens", () => {
    serve(signedIn);
    open(`/session/transfers?from=qr#token=${TRANSFER_ID}`);
    expect(`${location.pathname}${location.search}${location.hash}`).toBe("/session/transfers?from=qr");
  });

  it("loads the page this tab was sent to sign in from instead", async () => {
    history.replaceState(null, "", "/rooms/r2?q=1#m3");
    rememberThisPage();
    serve(signedIn);
    open();
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/rooms/r2?q=1#m3"));
  });

  it("leaves the page blank when the link doesn't work", async () => {
    serve(() => new Response(null, { status: 400 }));
    open();
    await waitFor(() => expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByRole("main")).toBeEmptyDOMElement();
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("leaves the page blank without asking Ember when the address holds no link", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const address of ["/session/transfers", "/session/transfers#token=", "/session/transfers#token", "/session/transfers#m3"]) {
      const { unmount } = open(address);
      expect(screen.getByRole("main"), address).toHaveAttribute("aria-busy", "false");
      unmount();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("signs in with another link opened over the page, which only changes its fragment", async () => {
    const fetch = serve(() => new Response(null, { status: 400 }), signedIn);
    open(`/session/transfers#token=expired`);
    await waitFor(() => expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "false"));

    act(() => {
      location.hash = `#token=${TRANSFER_ID}`;
    });
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/"));
    expect(fetch).toHaveBeenLastCalledWith("/api/session/transfers", expect.objectContaining({ body: JSON.stringify({ transferId: TRANSFER_ID }) }));
    expect(location.hash).toBe("");
  });

  it("tries again when it can't reach Ember, or Ember fails, waiting longer each time", async () => {
    vi.useFakeTimers();
    const fetch = serve(unreachable, () => Response.json({ error: "Something went wrong" }, { status: 500 }), signedIn);
    open();
    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1_999));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenLastCalledWith("/api/session/transfers", expect.objectContaining({ body: JSON.stringify({ transferId: TRANSFER_ID }) }));
    expect(loadPage).toHaveBeenCalledWith("/");
  });

  it("stops trying once it's gone", async () => {
    vi.useFakeTimers();
    const fetch = serve(unreachable);
    const { unmount } = open();
    await act(() => vi.advanceTimersByTimeAsync(0));
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
