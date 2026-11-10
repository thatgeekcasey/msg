import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepReplacingPush, moveTo, movesTo } from "./custom-domain";
import { loadPage } from "./page";
import { pushKey, replaceOnSave } from "./push";

vi.mock("./page", () => ({ loadPage: vi.fn() }));
vi.mock("./push", () => ({ pushKey: vi.fn(), replaceOnSave: vi.fn() }));

const DOMAIN = "chat.example.com";
/** This browser's push subscription's P-256 key, in URL-safe Base64 with `-` and `_`. */
const KEY = "BNcRdreA-tBHItJI5_x";

/** This page's address, but its origin. */
const address = () => `${location.pathname}${location.search}${location.hash}`;

beforeEach(() => {
  vi.mocked(pushKey).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  history.replaceState(null, "", "/");
});

describe("Custom domain", () => {
  it("moves a page to the same page at Ember's custom domain, naming this browser's push subscription there", async () => {
    vi.mocked(pushKey).mockResolvedValue(KEY);
    history.replaceState(null, "", "/rooms/general#top");
    await moveTo(DOMAIN);
    expect(loadPage).toHaveBeenLastCalledWith(`http://${DOMAIN}/rooms/general?replacing_push=${KEY}#top`);

    history.replaceState(null, "", "/rooms/general?ref=email");
    await moveTo(DOMAIN);
    expect(loadPage).toHaveBeenLastCalledWith(`http://${DOMAIN}/rooms/general?ref=email&replacing_push=${KEY}`);
  });

  it("names none for a browser without a push subscription, or that can't say", async () => {
    history.replaceState(null, "", "/rooms/general");
    await moveTo(DOMAIN);
    expect(loadPage).toHaveBeenLastCalledWith(`http://${DOMAIN}/rooms/general`);

    vi.mocked(pushKey).mockRejectedValue(new DOMException("No", "SecurityError"));
    await moveTo(DOMAIN);
    expect(loadPage).toHaveBeenLastCalledWith(`http://${DOMAIN}/rooms/general`);
  });

  it("moves no page at Ember's custom domain, nor workspace settings, nor any while Ember has none", async () => {
    history.replaceState(null, "", "/rooms/general");
    expect(movesTo(DOMAIN)).toBe(true);
    expect(movesTo(location.host)).toBe(false);
    expect(movesTo(null)).toBe(false);
    await moveTo(location.host);
    await moveTo(null);
    expect(loadPage).not.toHaveBeenCalled();

    history.replaceState(null, "", "/account/edit");
    expect(movesTo(DOMAIN)).toBe(false);
  });

  it("takes the push subscription a page that moved here names out of its address, keeping it for the one saved here to replace", () => {
    history.replaceState({ scrolled: true }, "", `/rooms/general?ref=email&replacing_push=${KEY}&tab=2#top`);
    keepReplacingPush();
    expect(replaceOnSave).toHaveBeenCalledWith(KEY);
    expect(address()).toBe("/rooms/general?ref=email&tab=2#top");
    expect(history.state).toEqual({ scrolled: true });

    history.replaceState(null, "", `/rooms/general?replacing_push=${KEY}`);
    keepReplacingPush();
    expect(address()).toBe("/rooms/general");
    expect(replaceOnSave).toHaveBeenCalledTimes(2);
  });

  it("leaves an address that names none as it is, and keeps nothing that can't be a key", () => {
    history.replaceState(null, "", "/rooms/general?ref=email#top");
    const replaceState = vi.spyOn(history, "replaceState");
    keepReplacingPush();
    expect(replaceState).not.toHaveBeenCalled();
    replaceState.mockRestore();

    for (const junk of ["", "%3Cb%3E", "a b", "K".repeat(257)]) {
      history.replaceState(null, "", `/rooms/general?replacing_push=${junk}`);
      keepReplacingPush();
      expect(address()).toBe("/rooms/general");
    }
    expect(replaceOnSave).not.toHaveBeenCalled();
  });
});
