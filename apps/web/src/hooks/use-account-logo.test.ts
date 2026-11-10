import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAccountLogo } from "./use-account-logo";

const LOGO = "/account/logo?v=20261017120000";

/** The page's icon and Apple touch icon links, as index.html has them. */
beforeEach(() => {
  document.head.insertAdjacentHTML(
    "beforeend",
    '<link rel="icon" type="image/png" sizes="48x48" href="/logos/app-icon-48.png"><link rel="apple-touch-icon" href="/logos/app-icon.png">',
  );
});

afterEach(() => {
  for (const link of document.head.querySelectorAll("link")) link.remove();
});

const icon = () => document.head.querySelector('link[rel="icon"]')!;
const touchIcon = () => document.head.querySelector('link[rel="apple-touch-icon"]')!;

describe("Workspace logo", () => {
  it("makes the workspace's logo the page's icon, its small variant, and Apple touch icon", () => {
    const { unmount } = renderHook(() => useAccountLogo(LOGO));
    expect(icon()).toHaveAttribute("href", `${LOGO}&size=small`);
    expect(icon()).not.toHaveAttribute("sizes");
    expect(icon()).toHaveAttribute("type", "image/png");
    expect(touchIcon()).toHaveAttribute("href", LOGO);
    unmount();
    expect(icon()).toHaveAttribute("href", "/logos/app-icon-48.png");
    expect(icon()).toHaveAttribute("sizes", "48x48");
    expect(touchIcon()).toHaveAttribute("href", "/logos/app-icon.png");
  });

  it("follows the logo as it changes, keeping Ember's icons while there's none", () => {
    const { rerender, unmount } = renderHook(({ logo }) => useAccountLogo(logo), { initialProps: { logo: null as string | null } });
    expect(icon()).toHaveAttribute("href", "/logos/app-icon-48.png");
    rerender({ logo: LOGO });
    expect(icon()).toHaveAttribute("href", `${LOGO}&size=small`);
    rerender({ logo: "/account/logo?v=20261017130000" });
    expect(icon()).toHaveAttribute("href", "/account/logo?v=20261017130000&size=small");
    expect(touchIcon()).toHaveAttribute("href", "/account/logo?v=20261017130000");
    rerender({ logo: null });
    expect(icon()).toHaveAttribute("href", "/logos/app-icon-48.png");
    expect(touchIcon()).toHaveAttribute("href", "/logos/app-icon.png");
    unmount();
  });
});

describe("Custom CSS", () => {
  it("marks the page's body account-has-logo while the workspace has a logo", () => {
    const { rerender, unmount } = renderHook(({ logo }) => useAccountLogo(logo), { initialProps: { logo: LOGO as string | null } });
    expect(document.body).toHaveClass("account-has-logo");
    rerender({ logo: null });
    expect(document.body).not.toHaveClass("account-has-logo");
    rerender({ logo: LOGO });
    unmount();
    expect(document.body).not.toHaveClass("account-has-logo");
  });
});
