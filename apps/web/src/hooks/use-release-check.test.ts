import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseCheck } from "@ember/protocol";
import { checkForRelease, checkForReleaseAfresh } from "@/lib/api";
import { useReleaseCheck } from "./use-release-check";

vi.mock("@/lib/api", () => ({ checkForRelease: vi.fn(), checkForReleaseAfresh: vi.fn() }));

/** What the Worker says of releases while `newest` is GitHub's newest, after this Ember's 0.1. */
const newestIs = (newest: string): ReleaseCheck => ({
  release: "0.1",
  beta: false,
  newest: { release: newest, notes: `https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v${newest}.0`, newer: true },
  copy: null,
});

/** The browser's idle callbacks, which run when a test says, unless they're cancelled first. */
const idle = new Map<number, () => void>();
let lastIdle = 0;

/** Runs the idle callbacks waiting. */
function becomeIdle() {
  const waiting = [...idle.values()];
  idle.clear();
  act(() => waiting.forEach((run) => run()));
}

/** How many times the Worker was asked, and how many of those afresh. */
const asked = () => [vi.mocked(checkForRelease).mock.calls.length, vi.mocked(checkForReleaseAfresh).mock.calls.length];

beforeEach(() => {
  vi.stubGlobal("requestIdleCallback", (run: () => void) => {
    idle.set(++lastIdle, run);
    return lastIdle;
  });
  vi.stubGlobal("cancelIdleCallback", (handle: number) => idle.delete(handle));
  vi.mocked(checkForRelease).mockResolvedValue(newestIs("0.2"));
  vi.mocked(checkForReleaseAfresh).mockResolvedValue(newestIs("0.3"));
});

afterEach(() => {
  // Unmounted while what it calls on the way out is still stubbed.
  cleanup();
  idle.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Checking for a newer release", () => {
  it.each([false, true])("asks once the page is ready, then afresh each time Admin opens, and never for leaving it (strict: %s)", async (strict) => {
    const { result, rerender } = renderHook(({ ready, inAdmin }) => useReleaseCheck(true, ready, inAdmin), {
      initialProps: { ready: false, inAdmin: false },
      wrapper: strict ? StrictMode : undefined,
    });
    becomeIdle();
    expect(asked()).toEqual([0, 0]);
    rerender({ ready: true, inAdmin: false });
    becomeIdle();
    await waitFor(() => expect(result.current).toEqual(newestIs("0.2")));

    rerender({ ready: true, inAdmin: true });
    becomeIdle();
    await waitFor(() => expect(result.current).toEqual(newestIs("0.3")));
    rerender({ ready: true, inAdmin: false });
    becomeIdle();
    expect(asked()).toEqual([1, 1]);
    rerender({ ready: true, inAdmin: true });
    becomeIdle();
    expect(asked()).toEqual([1, 2]);
  });

  it.each([false, true])("asks afresh alone for a page that's ready in Admin as it loads (strict: %s)", async (strict) => {
    const { result } = renderHook(() => useReleaseCheck(true, true, true), { wrapper: strict ? StrictMode : undefined });
    becomeIdle();
    await waitFor(() => expect(result.current).toEqual(newestIs("0.3")));
    expect(asked()).toEqual([0, 1]);
  });

  it("asks nothing for anyone but an administrator, in Admin or out", () => {
    const { rerender } = renderHook(({ inAdmin }) => useReleaseCheck(false, true, inAdmin), { initialProps: { inAdmin: false } });
    rerender({ inAdmin: true });
    becomeIdle();
    expect(asked()).toEqual([0, 0]);
  });
});
