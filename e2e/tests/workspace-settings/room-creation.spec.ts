import { expect, test } from "../../fixtures";
import { signInAsAdministrator, useOwnAddress } from "../../fixtures";
import { join } from "./fixtures";

test.describe("Only administrators create rooms (setting)", () => {
  test("the administrator lets only administrators create rooms, which takes New room from members at once, and gives it back", async ({ page, browser, baseURL }) => {
    await useOwnAddress(page);
    await page.goto("/account/edit#membership-settings");
    await signInAsAdministrator(page);
    const member = await join(browser, baseURL!, await page.getByRole("textbox", { name: "Share to invite more people" }).inputValue(), "Grace Hopper");
    await page.getByRole("link", { name: "Rooms and permissions" }).click();
    const restrict = page.getByRole("switch", { name: "Must be admin to create new rooms" });
    // A server kept from an earlier run may have it on still.
    await expect(restrict).toBeVisible();
    if (await restrict.isChecked()) await restrict.click();
    await expect(restrict).not.toBeChecked();
    await member.goto("/account/edit#channel-settings");
    const newRoom = member.getByRole("link", { name: "New room" });
    await expect(newRoom).toBeVisible();
    await expect(member.getByRole("switch")).toHaveCount(0);
    await expect(member.getByText("Community admins manage room order and permissions.")).toBeVisible();

    try {
      await restrict.click();
      await expect(restrict).toBeChecked();
      // The member's page follows without being loaded again.
      await expect(newRoom).toHaveCount(0);
      await expect(page.getByRole("link", { name: "New room" })).toBeVisible();

      await member.goto("/rooms/opens/new");
      await expect(member.getByRole("alert")).toHaveText("Only administrators can create rooms");
      await expect(member).toHaveURL(/\/account\/edit#channel-settings$/);
    } finally {
      // Other tests here create rooms as members.
      if (await restrict.isChecked()) await restrict.click();
    }
    await expect(restrict).not.toBeChecked();
    await expect(newRoom).toBeVisible();
    await newRoom.click();
    await expect(member.getByRole("textbox", { name: "Room name" })).toBeVisible();
    await member.context().close();
  });
});
