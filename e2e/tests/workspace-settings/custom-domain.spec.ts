import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures";
import { signInAsAdministrator, useOwnAddress } from "../../fixtures";

// The second test server answers at 127.0.0.1, which can't be a custom domain, and stands in for the
// workers.dev address a deploy gives Ember, and at chat.localhost, which can, as Chromium takes any name
// under localhost to this machine.

/** Stops Ember using a custom domain, from `page` wherever it's open, so the other specs find it at the server's own address. */
const stopUsingDomain = (page: Page) =>
  page.evaluate(() => fetch("/api/account", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customDomain: null }) }));

test.describe("Custom domain", () => {
  test("the administrator gives Ember a custom domain, which pages then move to, and goes back from the old address, which pages then move back to", async ({ page, baseURL }) => {
    const { port } = new URL(baseURL!);
    const deployed = `127.0.0.1:${port}`;
    const domain = `chat.localhost:${port}`;
    await useOwnAddress(page);
    await page.goto("/account/edit#domain-settings");
    await signInAsAdministrator(page);
    const section = page.getByRole("region", { name: "Custom domain" });
    await expect(section).toContainText(`Ember's address is ${deployed}.`);

    try {
      await section.getByRole("textbox", { name: "Domain" }).fill(domain);
      await section.getByRole("button", { name: "Set up" }).click();
      const steps = section.getByRole("list", { name: `Steps to make ${domain} Ember's address` });
      // Set up's check doesn't find Ember there yet, as the Worker's own request doesn't reach a name under
      // localhost, and a name under localhost has no DNS to look up, so the steps start at Cloudflare's.
      const provider = section.getByRole("combobox", { name: "DNS provider" });
      await expect(provider).toHaveValue("cloudflare");
      await expect(steps.getByRole("listitem")).toHaveCount(2);
      await expect(steps).toContainText("Open Cloudflare, choose the Worker that runs Ember, then Domains > Add Domain, and paste chat.localhost.");
      await expect(steps.getByRole("link", { name: "Open Cloudflare" })).toHaveAttribute("href", "https://dash.cloudflare.com/?to=/:account/workers-and-pages");
      // Keeping DNS at another provider takes a CNAME record there, which the domain someone registered
      // can't have for itself, and with no DNS to say otherwise, this one would be that.
      await provider.selectOption({ label: "GoDaddy" });
      await expect(section).toContainText(
        "Keeping DNS at GoDaddy takes a name under chat.localhost, such as chat.chat.localhost. Or choose Cloudflare above to move chat.localhost's DNS there instead.",
      );
      await expect(steps).toHaveCount(0);
      await provider.selectOption({ label: "Cloudflare" });
      // The Worker's own request doesn't reach this server at a name under localhost: only the browser
      // takes the name to this machine and trusts its certificate.
      await steps.getByRole("button", { name: `Use ${domain}` }).click();
      await expect(steps.getByRole("alert")).toHaveText(`Nothing answers at ${domain} yet. Cloudflare can take a minute to add it, so try again soon.`);
      await expect(section).toContainText(`Ember's address is ${deployed}.`);

      // Sessions belong to their address, so the administrator signs in there once more.
      const there = await page.context().newPage();
      await useOwnAddress(there);
      await there.goto(`https://${domain}/account/edit#domain-settings`);
      await signInAsAdministrator(there);
      const sectionThere = there.getByRole("region", { name: "Custom domain" });
      await sectionThere.getByRole("button", { name: `Use ${domain}` }).click();
      await expect(there.getByRole("alert")).toHaveText("Changes saved.");
      await expect(sectionThere).toContainText(`Ember's address is ${domain}.`);
      await expect(sectionThere).toContainText(`If ${domain} stops working, open Domain settings at ${deployed} and go back.`);

      // The tab left at the old address hears of it, and offers to go back.
      await expect(section).toContainText(`Ember's address is ${domain}.`);
      await expect(steps).toHaveCount(0);
      await expect(section.getByRole("button", { name: `Go back to ${deployed}` })).toBeVisible();
      await page.getByRole("link", { name: "Go Back" }).click();
      await expect(page.getByRole("textbox", { name: "Write a message" })).toBeVisible();
      await expect(page.getByText(`Ember has moved to ${domain}.`)).toBeVisible();
      const room = new URL(page.url()).pathname;
      await expect(page.getByRole("link", { name: "Go there" })).toHaveAttribute("href", `https://${domain}${room}`);

      // A page opened at the old address moves to the same page at the new one.
      const opened = await page.context().newPage();
      await opened.goto(`${room}?from=bookmark`);
      await expect(opened).toHaveURL(`https://${domain}${room}?from=bookmark`);
      await expect(opened.getByRole("textbox", { name: "Write a message" })).toBeVisible();
      await expect(opened.getByText(/Ember has moved/)).toHaveCount(0);
      // A page that moved names this browser's push subscription at the old address, which the page
      // there takes out of its address, keeping it for the subscription saved there to replace.
      await opened.goto(`https://${domain}${room}?from=bookmark&replacing_push=BOv7-moved_from`);
      await expect(opened.getByRole("textbox", { name: "Write a message" })).toBeVisible();
      await expect(opened).toHaveURL(`https://${domain}${room}?from=bookmark`);
      expect(await opened.evaluate(() => localStorage.getItem("ember:replacing-push"))).toBe("BOv7-moved_from");

      // Workspace settings stay at the old address, from where the administrator goes back to it.
      await page.goto("/account/edit#domain-settings");
      expect(page.url()).toBe(`${baseURL}/account/edit#domain-settings`);
      await section.getByRole("button", { name: `Go back to ${deployed}` }).click();
      await expect(page.getByRole("alert")).toHaveText("Changes saved.");
      await expect(section).toContainText(`Ember's address is ${deployed}.`);
      await expect(section.getByRole("textbox", { name: "Domain" })).toBeVisible();
      // The domain it left reaches it until it's removed in Cloudflare, sending people back here.
      const left = section.getByRole("list", { name: "Other addresses that reach Ember" });
      await expect(left).toContainText(`${domain} still forwards here.`);
      // The page there needs no check of its own address, which it reaches Ember at.
      await expect(sectionThere.getByRole("list", { name: "Other addresses that reach Ember" })).toContainText(`${domain} still forwards to ${deployed}.`);
      await expect(sectionThere.getByRole("button", { name: `Check ${domain}` })).toHaveCount(0);
      await opened.goto(`https://${domain}${room}?from=bookmark`);
      await expect(opened).toHaveURL(`${baseURL}${room}?from=bookmark`);
      await expect(opened.getByRole("textbox", { name: "Write a message" })).toBeVisible();

      // As with Use, the Worker's own request doesn't reach the name under localhost, so its check finds
      // the domain gone, as it would once it's removed from the Worker, and forgets it.
      await left.getByRole("button", { name: `Check ${domain}` }).click();
      await expect(section.getByRole("status")).toHaveText(`${domain} no longer reaches Ember.`);
      await expect(left).toHaveCount(0);
    } finally {
      await stopUsingDomain(page);
    }
  });
});
