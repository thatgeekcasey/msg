import { expect, type Browser, type Page } from "@playwright/test";
import { useOwnAddress } from "../../fixtures";

/** Has someone new join through `joinUrl` in a browser of their own, from an IP address of its own or `address`, and answers their page. */
export async function join(browser: Browser, baseURL: string, joinUrl: string, name: string, address?: string): Promise<Page> {
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await useOwnAddress(page, address);
  await page.goto(joinUrl);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email address").fill(`${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password").fill("compiler error");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("textbox", { name: "Write a message" })).toBeVisible();
  return page;
}
