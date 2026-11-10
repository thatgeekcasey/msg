import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { badgeTheApp } from "@/test-badge";
import { useAppBadge } from "./use-app-badge";

describe("App icon badge", () => {
  it("badges the app with the count once there is one, again as it changes, and clears the badge at 0, as badge_dot_controller.js does", () => {
    const badges = badgeTheApp();
    const { rerender } = renderHook(({ count }) => useAppBadge(count), { initialProps: { count: null as number | null } });
    expect(badges).toEqual([]);

    rerender({ count: 2 });
    rerender({ count: 2 });
    rerender({ count: 3 });
    rerender({ count: 0 });
    expect(badges).toEqual([2, 3, "cleared"]);
  });

  it("does nothing where the browser has no app badges", () => {
    expect("setAppBadge" in navigator).toBe(false);
    expect(() => renderHook(() => useAppBadge(2))).not.toThrow();
  });

  it("lets the browser refuse", async () => {
    const badges = badgeTheApp({ refuse: true });
    renderHook(() => useAppBadge(2));
    // Vitest fails the run on a refusal left unhandled.
    await waitFor(() => expect(badges).toEqual([2]));
  });
});
