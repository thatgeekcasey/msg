import type { Page } from "@playwright/test";
import { expect, test, type Member } from "./fixtures";

const html = (page: Page) => page.locator("html");
const isDark = (page: Page) => html(page).evaluate((html) => html.classList.contains("dark"));
const colorScheme = (page: Page) => html(page).evaluate((html) => html.style.colorScheme);
const themeColors = (page: Page) => page.locator('meta[name="theme-color"]').evaluateAll((metas) => metas.map((meta) => (meta as HTMLMetaElement).content));
const appearanceButton = (page: Page) => page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: /^Appearance: / });
const appearanceMenu = (page: Page) => page.getByRole("dialog", { name: "Appearance" });

/** Picks a choice in the rail's appearance dialog, opening it first if need be. It stays open. */
async function choose(member: Member, appearance: "Light" | "Dark" | "System") {
  const menu = appearanceMenu(member.page);
  if (!(await menu.isVisible())) await appearanceButton(member.page).click();
  await menu.getByText(appearance, { exact: true }).click();
  await expect(menu.getByRole("radio", { name: appearance })).toBeChecked();
}

test.describe("Light, dark or system appearance", () => {
  test("opens a dialog of radio buttons from a button named for the choice", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { colorScheme: "light" } });
    const button = appearanceButton(ada.page);
    await expect(button).toHaveAccessibleName("Appearance: System");
    await expect(button).toHaveAttribute("title", "Appearance: System");
    await expect(button).toHaveAttribute("aria-haspopup", "dialog");

    await button.click();
    const menu = appearanceMenu(ada.page);
    await expect(menu.getByRole("group", { name: "Appearance" }).getByRole("radio")).toHaveCount(3);
    await expect(menu.getByRole("radio", { name: "System" })).toBeChecked();
    await expect(menu.getByRole("radio", { name: "System" })).toBeFocused();

    // The arrow keys move between the choices, applying each at once.
    await ada.page.keyboard.press("ArrowUp");
    await expect(menu.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(await isDark(ada.page)).toBe(true);
    await expect(button).toHaveAccessibleName("Appearance: Dark");
    await expect(button).toHaveAttribute("title", "Appearance: Dark");

    await ada.page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(button).toBeFocused();

    // Tab closes it and goes on from the button: on to your profile, or back to Workspace.
    await ada.page.keyboard.press("Enter");
    await expect(menu.getByRole("radio", { name: "Dark" })).toBeFocused();
    await ada.page.keyboard.press("Tab");
    await expect(menu).toBeHidden();
    await expect(ada.page.getByRole("link", { name: "Your profile" })).toBeFocused();
    await ada.page.keyboard.press("Shift+Tab");
    await ada.page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await ada.page.keyboard.press("Shift+Tab");
    await expect(menu).toBeHidden();
    await expect(ada.page.getByRole("link", { name: "Workspace" })).toBeFocused();
  });

  test("fits a phone, where Escape closes it before the drawer it's in", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { viewport: { width: 320, height: 740 } } });
    await ada.page.getByRole("button", { name: "Open conversations" }).click();
    await appearanceButton(ada.page).click();
    const menu = appearanceMenu(ada.page);
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);

    await ada.page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(appearanceButton(ada.page)).toBeFocused();
    await expect(ada.page.getByRole("button", { name: "Close conversations" })).toBeVisible();
  });

  test("switches to Dark and keeps it, applied before the app has even loaded", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { colorScheme: "light" } });
    expect(await isDark(ada.page)).toBe(false);
    await expect(ada.page.locator("body")).toHaveCSS("background-color", "rgb(250, 250, 250)");

    await choose(ada, "Dark");
    expect(await isDark(ada.page)).toBe(true);
    await expect(ada.page.locator("body")).toHaveCSS("background-color", "rgb(28, 28, 28)");
    await expect(html(ada.page)).toHaveAttribute("data-appearance", "dark");
    expect(await colorScheme(ada.page)).toBe("dark");
    await ada.page.keyboard.press("Escape");
    await appearanceButton(ada.page).click();
    await expect(appearanceMenu(ada.page).getByRole("radio", { name: "Dark" })).toBeChecked();
    await ada.page.keyboard.press("Escape");

    // With the app's scripts blocked, only the inline script in index.html can set the theme.
    await ada.page.route("**/assets/*.js", (route) => route.abort());
    await ada.page.reload();
    await expect(ada.page.locator("#root")).toBeEmpty();
    expect(await isDark(ada.page)).toBe(true);
    await expect(html(ada.page)).toHaveAttribute("data-appearance", "dark");
    expect(await colorScheme(ada.page)).toBe("dark");
  });

  test("follows the device's setting on System, saved like the other choices", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { colorScheme: "dark" } });
    expect(await isDark(ada.page)).toBe(true);
    await expect(html(ada.page)).toHaveAttribute("data-appearance", "system");

    await ada.page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => isDark(ada.page)).toBe(false);
    expect(await colorScheme(ada.page)).toBe("light");

    await choose(ada, "Dark");
    await choose(ada, "System");
    expect(await ada.page.evaluate(() => localStorage.getItem("ember:appearance"))).toBe("system");
    expect(await isDark(ada.page)).toBe(false);
    await ada.page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => isDark(ada.page)).toBe(true);
  });

  test("Light overrides a dark device setting", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { colorScheme: "dark" } });
    await choose(ada, "Light");
    expect(await isDark(ada.page)).toBe(false);
    await ada.page.reload();
    await ada.connected();
    expect(await isDark(ada.page)).toBe(false);
  });

  test("colors the browser around the page to match, from the moment it loads", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { colorScheme: "dark" } });
    expect(await themeColors(ada.page)).toEqual(["#171717", "#171717"]);
    await choose(ada, "Light");
    expect(await themeColors(ada.page)).toEqual(["#ffffff", "#ffffff"]);

    // With the app's scripts blocked, only the inline script in index.html can set it.
    await ada.page.route("**/assets/*.js", (route) => route.abort());
    await ada.page.reload();
    await expect(ada.page.locator("#root")).toBeEmpty();
    expect(await themeColors(ada.page)).toEqual(["#ffffff", "#ffffff"]);
  });

  test("keeps every open tab in step, also when the site's storage is cleared", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { colorScheme: "light" } });
    const otherTab = await ada.page.context().newPage();
    await otherTab.goto("/");
    await expect(appearanceButton(otherTab)).toBeVisible();

    await choose(ada, "Dark");
    await expect.poll(() => isDark(otherTab)).toBe(true);
    await expect(appearanceButton(otherTab)).toHaveAccessibleName("Appearance: Dark");
    await choose(ada, "System");
    await expect.poll(() => isDark(otherTab)).toBe(false);

    // Clearing it in one tab takes the others back to System.
    await choose(ada, "Dark");
    await expect.poll(() => isDark(otherTab)).toBe(true);
    await ada.page.evaluate(() => localStorage.clear());
    await expect(html(otherTab)).toHaveAttribute("data-appearance", "system");
    expect(await isDark(otherTab)).toBe(false);
    await expect(appearanceButton(otherTab)).toHaveAccessibleName("Appearance: System");
  });

  test("catches up with a choice made in another tab while it was loading", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { colorScheme: "light" } });
    const otherTab = await ada.page.context().newPage();
    // Holding the app's scripts back puts the choice after index.html's script but before the app's.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await otherTab.route("**/assets/*.js", async (route) => {
      await held;
      await route.continue();
    });
    const loading = otherTab.goto("/");
    await expect(html(otherTab)).toHaveAttribute("data-appearance", "system");

    await choose(ada, "Dark");
    await expect.poll(() => otherTab.evaluate(() => localStorage.getItem("ember:appearance"))).toBe("dark");
    release();
    await loading;
    await expect(appearanceButton(otherTab)).toHaveAccessibleName("Appearance: Dark");
    expect(await isDark(otherTab)).toBe(true);
  });

  test("keeps pages without the rail in step too, such as sign-in", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { colorScheme: "light" } });
    const signIn = await ada.page.context().newPage();
    await signIn.goto("/session/new");
    await expect(signIn.getByRole("heading", { name: /^Sign in to / })).toBeVisible();

    await choose(ada, "Dark");
    await expect.poll(() => isDark(signIn)).toBe(true);
    expect(await themeColors(signIn)).toEqual(["#171717", "#171717"]);
    await choose(ada, "System");
    await expect.poll(() => isDark(signIn)).toBe(false);
    await signIn.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => isDark(signIn)).toBe(true);
  });

  test("still works when the browser won't keep the choice", async ({ members }) => {
    const ada = await members.signIn("Ada", { context: { colorScheme: "light" } });
    await ada.page.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw new Error("Storage unavailable");
      };
      Storage.prototype.setItem = () => {
        throw new Error("Storage unavailable");
      };
    });
    await ada.page.reload();
    await ada.connected();
    expect(await isDark(ada.page)).toBe(false);

    await choose(ada, "Dark");
    expect(await isDark(ada.page)).toBe(true);
    // It's this page's choice now, which the device's doesn't override.
    for (const colorScheme of ["dark", "light"] as const) {
      await ada.page.emulateMedia({ colorScheme });
      // Media queries report changes before the next frame is drawn.
      await ada.page.evaluate(() => new Promise(requestAnimationFrame));
    }
    expect(await isDark(ada.page)).toBe(true);
  });
});
