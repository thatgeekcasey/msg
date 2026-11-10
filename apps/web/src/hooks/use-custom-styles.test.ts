import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCustomStyles } from "./use-custom-styles";

/** The text of each `<style>` in the page's head, in order. */
const styleSheets = () => [...document.head.querySelectorAll("style")].map((style) => style.textContent);

describe("Custom CSS", () => {
  it("adds the workspace's CSS after the app's own, as text, so `</style>` in it adds nothing else", () => {
    const own = document.head.appendChild(document.createElement("style"));
    own.textContent = ".app {}";
    const css = "body { color: red; }\n</style><script>alert(1)</script>";
    const { unmount } = renderHook(() => useCustomStyles(css, false));
    expect(styleSheets()).toEqual([".app {}", css]);
    expect(document.querySelectorAll("script")).toHaveLength(0);
    unmount();
    expect(styleSheets()).toEqual([".app {}"]);
    own.remove();
  });

  it("follows the workspace's CSS as it changes, adding nothing while there is none", () => {
    const { rerender, unmount } = renderHook(({ css }) => useCustomStyles(css, false), { initialProps: { css: "" } });
    expect(styleSheets()).toEqual([]);
    rerender({ css: "body { color: red; }" });
    expect(styleSheets()).toEqual(["body { color: red; }"]);
    rerender({ css: "body { color: blue; }" });
    expect(styleSheets()).toEqual(["body { color: blue; }"]);
    rerender({ css: "" });
    expect(styleSheets()).toEqual([]);
    unmount();
  });

  it("marks the page's body admin while an administrator is signed in", () => {
    const { rerender, unmount } = renderHook(({ administrator }) => useCustomStyles("", administrator), { initialProps: { administrator: true } });
    expect(document.body).toHaveClass("admin");
    rerender({ administrator: false });
    expect(document.body).not.toHaveClass("admin");
    rerender({ administrator: true });
    unmount();
    expect(document.body).not.toHaveClass("admin");
  });
});
