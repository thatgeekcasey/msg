import type { Me, WorkspaceSettings } from "@ember/protocol";
import { APP_ID_UNKNOWN, APP_SECRET_UNKNOWN } from "@ember/protocol/huddles";
import type { APIRequestContext, Page } from "@playwright/test";
import { administratorSession, cookieHeader, expect, newAddress, SAME_ORIGIN, signInAsAdministrator, test, useOwnAddress, type TestRoom } from "../../fixtures";
import { AI_GATEWAY_ACCOUNT, SFU_APP } from "../../projects/workspace-settings";
import { startFakeSfu, type FakeSfu } from "./fake-sfu";

// Rooms and permissions' Huddles card and Set up huddles, and a huddle itself, on the second test server,
// which asks the Realtime SFU this spec fakes: to start a session with the keys it's given, and to carry
// what the people in a huddle say, which the fake does through a page of its own. Each test leaves the
// workspace as a new one is: huddles off.

let sfu: FakeSfu;
let relay: Page;
test.beforeAll(async ({ browser }) => {
  relay = await browser.newPage();
  sfu = await startFakeSfu(relay);
});
test.afterAll(async () => {
  // The page first, which answers whatever the SFU is still asked, so nothing keeps it open.
  await relay.close();
  await sfu.close();
});
test.afterEach(async ({ request }) => {
  const forgotten = await request.delete("/api/account/huddles", { headers: await asAdministrator(request) });
  expect(forgotten.status(), await forgotten.text()).toBe(200);
});

/** The administrator's session's headers, for the API. */
const asAdministrator = async (request: APIRequestContext) => ({ Cookie: cookieHeader(await administratorSession(request)), ...SAME_ORIGIN });

/** The Huddles card on the page. */
const huddlesCard = (page: Page) => page.getByRole("region", { name: "Huddles", exact: true });

/** Opens Rooms and permissions as the administrator, answering its Huddles card. */
async function openHuddles(page: Page) {
  await useOwnAddress(page);
  await page.goto("/account/edit#channel-settings");
  await signInAsAdministrator(page);
  return huddlesCard(page);
}

test.describe("Set up huddles", () => {
  test("the administrator gives Ember an SFU app's keys, which Cloudflare starts a session with, and Ember keeps them", async ({ page }) => {
    const huddles = await openHuddles(page);
    await expect(huddles).toContainText("Huddles let people in a room talk to each other.");
    const huddlesSwitch = huddles.getByRole("switch", { name: "Huddles" });
    await expect(huddlesSwitch).not.toBeChecked();
    await huddlesSwitch.click();

    const setup = page.getByRole("dialog");
    await expect(setup).toHaveAccessibleName("Set up huddles");
    // The dashboard opens at the account Ember is deployed to.
    await expect(setup.getByRole("link", { name: "Open Serverless SFU in the Cloudflare dashboard" })).toHaveAttribute(
      "href",
      `https://dash.cloudflare.com/${AI_GATEWAY_ACCOUNT.accountId}/realtime/sfu`,
    );
    const [appId, appSecret] = [setup.getByRole("textbox", { name: "App ID" }), setup.getByRole("textbox", { name: "App Secret" })];
    const save = setup.getByRole("button", { name: "Save" });

    // An app Cloudflare doesn't know comes back to its field, as does a secret that isn't the app's.
    await appId.fill("0".repeat(32));
    await appSecret.fill(SFU_APP.appSecret);
    await save.click();
    await expect(setup.getByRole("alert")).toHaveText(APP_ID_UNKNOWN);
    await expect(appId).toHaveAccessibleDescription(APP_ID_UNKNOWN);
    await appId.fill(SFU_APP.appId);
    await appSecret.fill("f".repeat(64));
    await save.click();
    await expect(setup.getByRole("alert")).toHaveText(APP_SECRET_UNKNOWN);
    await expect(appSecret).toHaveAccessibleDescription(APP_SECRET_UNKNOWN);

    await appSecret.fill(SFU_APP.appSecret);
    await save.click();
    await expect(setup).toHaveAccessibleName("Huddles are set up");
    expect(sfu.asked.at(-1)).toEqual({ method: "POST", path: `/v1/apps/${SFU_APP.appId}/sessions/new`, authorization: `Bearer ${SFU_APP.appSecret}` });
    await setup.getByRole("button", { name: "Done" }).click();
    await expect(setup).toBeHidden();
    await expect(huddles).toContainText(`Huddles run through the Realtime SFU app ${SFU_APP.appId} in your Cloudflare account.`);
    await expect(huddlesSwitch).toBeChecked();

    // Ember keeps the keys, and Change keys starts from the app's ID, asking for its secret again.
    await page.reload();
    await expect(huddlesCard(page).getByRole("switch", { name: "Huddles" })).toBeChecked();
    await huddlesCard(page).getByRole("button", { name: "Change keys" }).click();
    await expect(page.getByRole("dialog").getByRole("textbox", { name: "App ID" })).toHaveValue(SFU_APP.appId);
    await expect(page.getByRole("dialog").getByRole("textbox", { name: "App Secret" })).toHaveValue("");
    await expect(page.getByRole("dialog")).toContainText("Ember has an app's keys already.");
  });

  test("the administrator turns huddles off, once they're sure, which forgets the app's keys", async ({ page, request }) => {
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers: await asAdministrator(request) });
    expect(saved.status(), await saved.text()).toBe(200);
    const huddles = await openHuddles(page);
    page.once("dialog", (dialog) => void dialog.accept());
    const huddlesSwitch = huddles.getByRole("switch", { name: "Huddles" });
    await expect(huddlesSwitch).toBeChecked();
    await huddlesSwitch.click();
    await expect(huddlesSwitch).not.toBeChecked();
    await expect(huddlesSwitch).toBeEnabled();
    await expect(huddles.getByRole("button", { name: "Change keys" })).toHaveCount(0);
    await page.reload();
    await expect(huddlesCard(page).getByRole("switch", { name: "Huddles" })).not.toBeChecked();
  });
});

/** The bar of the huddle `page` is in, along the window's base. */
const huddleBar = (page: Page, room: TestRoom) => page.getByRole("region", { name: `Huddle in ${room.name}` });

/** Whether `page` plays the voice of `userId`: their track brings sound, and its audio runs. */
const hears = (page: Page, userId: string) =>
  page.evaluate((userId) => {
    const audio = document.querySelector<HTMLAudioElement>(`[data-huddle-voices] audio[data-user-id="${userId}"]`);
    const [track] = audio?.srcObject instanceof MediaStream ? audio.srcObject.getAudioTracks() : [];
    return track !== undefined && !track.muted && track.readyState === "live" && !audio!.paused && audio!.currentTime > 0;
  }, userId);

test.describe("A huddle", () => {
  test("two people start and join a room's huddle, hear each other, and leave it", async ({ page, browser, baseURL, request }) => {
    const administrator = await administratorSession(request);
    const headers = { Cookie: cookieHeader(administrator), ...SAME_ORIGIN };
    // In a room of the test's own, which everyone is in.
    const created = await request.post("/api/rooms", { data: { kind: "open", name: `Standup ${crypto.randomUUID().slice(0, 8)}` }, headers });
    expect(created.status(), await created.text()).toBe(201);
    const { room } = (await created.json()) as { room: TestRoom };

    // Ada has the room open as huddles are turned on, which gives its header the huddle button.
    await useOwnAddress(page);
    await page.goto(`/rooms/${room.id}`);
    await signInAsAdministrator(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(room.name);
    const start = page.getByRole("button", { name: "Start huddle", exact: true });
    await expect(start).toHaveCount(0);
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers });
    expect(saved.status(), await saved.text()).toBe(200);
    // She starts the room's huddle from it, by the preview, which has her microphone open.
    await start.click();
    const starting = page.getByRole("dialog", { name: `Start a huddle in ${room.name}` });
    await expect(starting.getByRole("combobox", { name: "Microphone" })).toBeVisible();
    await starting.getByRole("button", { name: "Start Huddle" }).click();
    const adasBar = huddleBar(page, room);
    await expect(adasBar).toContainText("Just you in the huddle");
    await expect(page.getByRole("button", { name: "Leave huddle", exact: true })).toBeVisible();

    // Grace, who joins Ember with the join link, sees it going on in the room's header, and its link
    // opens the room at the preview.
    const { joinCode } = (await (await request.get("/api/account", { headers })).json()) as WorkspaceSettings;
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    const joined = await context.request.post(`/api/join/${joinCode}`, {
      data: { name: `Grace ${crypto.randomUUID().slice(0, 8)}`, emailAddress: `${crypto.randomUUID()}@example.com`, password: "compiler error" },
      headers: { "CF-Connecting-IP": newAddress(), ...SAME_ORIGIN },
    });
    expect(joined.status(), await joined.text()).toBe(201);
    const { user: her } = (await joined.json()) as { user: Me };
    const grace = await context.newPage();
    await useOwnAddress(grace);
    await grace.goto(`/rooms/${room.id}`);
    await expect(grace.getByRole("button", { name: "Join huddle, 1 in it" })).toBeVisible();
    await grace.goto(`/rooms/${room.id}/huddle`);
    const joining = grace.getByRole("dialog", { name: `Join the huddle in ${room.name}` });
    await expect(joining).toContainText("Ada is in it now.");
    await expect(grace).toHaveURL(`${baseURL}/rooms/${room.id}`);
    await joining.getByRole("button", { name: "Join Huddle" }).click();
    const gracesBar = huddleBar(grace, room);
    await expect(gracesBar).toContainText("Ada and you are in the huddle");
    await expect(adasBar).toContainText("Grace and you are in the huddle");

    // Each hears the other, through the SFU.
    await expect.poll(() => hears(grace, administrator.user.id), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => hears(page, her.id), { timeout: 15_000 }).toBe(true);

    // Ada mutes from the bar, and unmutes with the keys, which the button she pressed doesn't take as a press.
    await adasBar.getByRole("button", { name: "Mute microphone" }).click();
    await expect(adasBar.getByRole("button", { name: "Unmute microphone" })).toBeFocused();
    await page.keyboard.press("Control+Shift+Space");
    await expect(adasBar.getByRole("button", { name: "Mute microphone" })).toBeVisible();

    // Grace leaves from her bar. The huddle goes on for Ada, who no longer hears her.
    await gracesBar.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(gracesBar).toHaveCount(0);
    await expect(grace.getByRole("button", { name: "Join huddle, 1 in it" })).toBeVisible();
    await expect(adasBar).toContainText("Just you in the huddle");
    await expect(page.locator("[data-huddle-voices] audio")).toHaveCount(0);

    // Ada leaves from the room's header, which ends the huddle, and its keys offer to start another.
    await page.getByRole("button", { name: "Leave huddle", exact: true }).click();
    await expect(adasBar).toHaveCount(0);
    await expect(grace.getByRole("button", { name: "Start huddle", exact: true })).toBeVisible();
    await page.keyboard.press("Control+Alt+Shift+H");
    await expect(starting).toBeVisible();
    await starting.getByRole("button", { name: "Cancel", exact: true }).last().click();
    await expect(starting).toBeHidden();

    // The room had the SFU close what each of them published, and what each heard.
    const carried = new Set(sfu.asked.flatMap(({ method, path }) => (method === "POST" ? (/\/sessions\/([^/]+)\/tracks\/new$/.exec(path)?.[1] ?? []) : [])));
    expect(carried.size).toBeGreaterThanOrEqual(4);
    const closed = (sessionId: string) => sfu.asked.some(({ method, path }) => method === "PUT" && path.endsWith(`/sessions/${sessionId}/tracks/close`));
    await expect.poll(() => [...carried].filter((sessionId) => !closed(sessionId))).toEqual([]);

    // Turning huddles off takes the button from the headers of the rooms people have open.
    const forgotten = await request.delete("/api/account/huddles", { headers });
    expect(forgotten.status(), await forgotten.text()).toBe(200);
    await expect(grace.getByRole("button", { name: "Start huddle", exact: true })).toHaveCount(0);
    await expect(start).toHaveCount(0);
    await context.close();
  });
});
