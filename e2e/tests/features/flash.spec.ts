import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** Where a flash is, stopped mid-animation so it stays to be measured. */
async function hold(flash: Locator) {
  await flash.evaluate((node: HTMLElement) => {
    node.style.animation = "none";
  });
  return (await flash.boundingBox())!;
}

/** Leaves a flash for the next page this tab loads, as the app's `loadPage` does (apps/web/src/lib/flash.ts). */
const leaveForNextPage = (page: Page, message: { kind: "notice" | "alert"; text: string }) =>
  page.evaluate((message) => sessionStorage.setItem("ember:flash", JSON.stringify(message)), message);

test.describe("Saved notices", () => {
  test("centers an alert over the page, 12px below the header, at 1311, 1000 and 390px wide", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1311, height: 900 } } });
    for (const width of [1311, 1000, 390]) {
      await ada.page.setViewportSize({ width, height: 900 });
      await ada.page.goto("/rooms/opens/nowhere/edit");
      const alert = ada.page.getByRole("alert");
      await expect(alert).toHaveText("Room not found or inaccessible");
      await ada.connected();

      const flash = await hold(alert);
      // The page goes home, to the room, whose main content starts below the header.
      const main = (await ada.page.getByRole("main").boundingBox())!;
      expect(Math.abs(flash.x + flash.width / 2 - (main.x + main.width / 2)), `centered at ${width}px`).toBeLessThan(1);
      expect(flash.y, `12px below the header at ${width}px`).toBeCloseTo(main.y + 12, 0);
      expect(flash.width).toBeGreaterThanOrEqual(48);
      expect(flash.height).toBeGreaterThanOrEqual(48);
      await expect(alert.locator("svg")).toHaveCount(1);
    }
  });

  test("fades an alert in and out, then takes it away", async ({ members }) => {
    const ada = await members.signIn("Ada");
    await ada.page.goto("/rooms/opens/nowhere/edit");
    const alert = ada.page.getByRole("alert");
    await expect(alert).toHaveText("Room not found or inaccessible");
    expect(await alert.evaluate((node) => getComputedStyle(node).animationName)).toBe("appear-then-fade");
    await expect(alert).toHaveCount(0, { timeout: 5_000 });
  });

  test("shows an alert at once, without fading, to people who ask for less motion, until the fade would have ended", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { reducedMotion: "reduce" } });
    await ada.page.goto("/rooms/opens/nowhere/edit");
    const alert = ada.page.getByRole("alert");
    await expect(alert).toHaveText("Room not found or inaccessible");
    const style = await alert.evaluate((node) => {
      const { animationName, animationDuration, animationDelay, opacity } = getComputedStyle(node);
      return { animationName, animationDuration, animationDelay, opacity };
    });
    expect(style).toEqual({ animationName: "stay", animationDuration: "3.3s", animationDelay: "0s", opacity: "1" });
    await expect(alert).toHaveCount(0, { timeout: 5_000 });
  });

  test("shows a notice the page before a full page load left, once, as a lone check in white on green read as Changes saved", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 1311, height: 900 } } });
    await leaveForNextPage(ada.page, { kind: "notice", text: "✓" });
    await ada.page.reload();
    const notice = ada.page.getByRole("alert");
    await expect(notice).toHaveText("Changes saved");

    const flash = await hold(notice);
    expect(flash).toMatchObject({ width: 48, height: 48 });
    await expect(notice.locator("svg")).toHaveCount(1);
    const [background, green] = await notice.evaluate((node) => {
      // Campfire's --color-positive.
      const probe = document.body.appendChild(document.createElement("div"));
      probe.style.backgroundColor = "oklch(65.59% 0.234 142.49)";
      const colors = [getComputedStyle(node).backgroundColor, getComputedStyle(probe).backgroundColor];
      probe.remove();
      return colors;
    });
    expect(background).toBe(green);
    expect(await notice.evaluate((node) => getComputedStyle(node).color)).toBe("rgb(255, 255, 255)");

    await ada.page.reload();
    await ada.connected();
    await expect(notice).toHaveCount(0);
  });
});
