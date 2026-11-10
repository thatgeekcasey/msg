import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushSubscriptions, SavedPushSubscription } from "@ember/protocol";
import { Sheet } from "@/components/ui/sheet";
import { ApiError } from "@/lib/api";
import { savePushAgain } from "@/lib/push";
import { PushSubscriptionsPage } from "./push-subscriptions-page";

const PHONE: SavedPushSubscription = { id: 1, endpoint: "https://web.push.apple.com/QGuQyavXutnMZHyWVcLaK", browser: "Safari", version: "18.0", platform: "iPhone" };
const LAPTOP: SavedPushSubscription = { id: 2, endpoint: "https://fcm.googleapis.com/fcm/send/dpH5lCsTSSM:APA91bHq", browser: "Chrome", version: "131.0.0.0", platform: "Macintosh" };

interface Answers {
  /** What loading the list answers, rather than the phone's and the laptop's subscriptions. */
  listed?: () => Response | Promise<Response>;
  /** What a test notification answers, rather than that it was sent. */
  tested?: () => Response | Promise<Response>;
  /** What saving this browser's subscription again answers, rather than that it was saved. */
  saved?: () => Response | Promise<Response>;
}

/** Answers the page's requests as the server does, or as `answers` says. */
function serve({
  listed = () => Response.json({ subscriptions: [PHONE, LAPTOP] } satisfies PushSubscriptions),
  tested = () => new Response(null, { status: 204 }),
  saved = () => new Response(null, { status: 204 }),
}: Answers = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method ?? "GET"} ${String(input)}`;
    if (request === "GET /api/push-subscriptions") return listed();
    if (request === "POST /api/push-subscriptions") return saved();
    if (/^POST \/api\/push-subscriptions\/\d+\/test-notifications$/.test(request)) return tested();
    if (/^DELETE \/api\/push-subscriptions\/\d+$/.test(request)) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request for ${request}`);
  });
}

function showPage() {
  const onFailed = vi.fn();
  history.replaceState(null, "", "/users/me/push_subscriptions");
  render(
    <Sheet>
      <PushSubscriptionsPage back="/rooms/7" onFailed={onFailed} />
    </Sheet>,
  );
  return { onFailed, user: userEvent.setup() };
}

/** Each subscription the page lists, once it has loaded. */
async function listed(count: number): Promise<HTMLElement[]> {
  const list = screen.getByRole("list", { name: "Push Notification Subscriptions" });
  await waitFor(() => expect(within(list).queryAllByRole("listitem")).toHaveLength(count));
  return within(list).queryAllByRole("listitem");
}

/** The requests the page has sent, but for loading the list. */
const sent = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([input, init]) => `${init?.method ?? "GET"} ${String(input)}`)
    .filter((request) => request !== "GET /api/push-subscriptions");

beforeEach(() => {
  serve();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  vi.restoreAllMocks();
});

describe("Push subscriptions page", () => {
  it("lists your browsers' subscriptions under the page's title and heading, with Go Back to the last room visited", async () => {
    showPage();
    expect(document.title).toBe("Push notification subscriptions");
    expect(screen.getByRole("heading", { level: 1, name: "Push Notification Subscriptions" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go Back" })).toHaveAttribute("href", "/rooms/7");

    const [phone, laptop] = await listed(2);
    expect(within(phone!).getByText("Safari 18.0 on iPhone").tagName).toBe("STRONG");
    expect(within(phone!).getByText(PHONE.endpoint)).toBeInTheDocument();
    expect(within(laptop!).getByText("Chrome 131.0.0.0 on Macintosh")).toBeInTheDocument();
    for (const row of [phone!, laptop!]) {
      expect(within(row).getAllByRole("button").map((button) => button.textContent)).toEqual(["Send test notification", "Delete subscription"]);
    }
  });

  it("names a browser the user agent says nothing of with what's left", async () => {
    serve({ listed: () => Response.json({ subscriptions: [{ id: 3, endpoint: PHONE.endpoint, browser: "Mozilla", version: "4.0", platform: "" }] }) });
    showPage();
    const [row] = await listed(1);
    expect(within(row!).getByText("Mozilla 4.0 on")).toBeInTheDocument();
  });

  it("sends a test notification to a subscription, its button waiting for the answer, and shows nothing more", async () => {
    let answer!: (response: Response) => void;
    serve({ tested: () => new Promise((resolve) => (answer = resolve)) });
    const { onFailed, user } = showPage();
    const [, laptop] = await listed(2);
    const send = within(laptop!).getByRole("button", { name: "Send test notification" });

    await user.click(send);
    expect(sent()).toEqual(["POST /api/push-subscriptions/2/test-notifications"]);
    expect(send).toBeDisabled();
    expect(within(laptop!).getByRole("button", { name: "Delete subscription" })).toBeEnabled();
    answer(new Response(null, { status: 204 }));
    await waitFor(() => expect(send).toBeEnabled());
    expect(await listed(2)).toHaveLength(2);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("says why a test notification failed, as the workspace's alerts do", async () => {
    serve({ tested: () => Response.json({ error: "Something went wrong" }, { status: 500 }) });
    const { onFailed, user } = showPage();
    const [phone] = await listed(2);
    const send = within(phone!).getByRole("button", { name: "Send test notification" });

    await user.click(send);
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(500, "Something went wrong")));
    await waitFor(() => expect(send).toBeEnabled());
  });

  it("deletes a subscription and leaves it off the list", async () => {
    const { onFailed, user } = showPage();
    const [phone] = await listed(2);

    await user.click(within(phone!).getByRole("button", { name: "Delete subscription" }));
    expect(sent()).toEqual(["DELETE /api/push-subscriptions/1"]);
    const [laptop] = await listed(1);
    expect(within(laptop!).getByText("Chrome 131.0.0.0 on Macintosh")).toBeInTheDocument();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("ends this browser's own subscription when it's deleted, so the bell can turn notifications on again, but not another browser's", async () => {
    const unsubscribe = vi.fn(async () => true);
    // This browser is the laptop.
    const registration = { pushManager: { getSubscription: async () => ({ endpoint: LAPTOP.endpoint, unsubscribe }) } };
    Object.defineProperty(navigator, "serviceWorker", { value: { getRegistration: async () => registration }, configurable: true });
    const { onFailed, user } = showPage();
    const [phone] = await listed(2);

    await user.click(within(phone!).getByRole("button", { name: "Delete subscription" }));
    const [laptop] = await listed(1);
    expect(unsubscribe).not.toHaveBeenCalled();
    await user.click(within(laptop!).getByRole("button", { name: "Delete subscription" }));
    await listed(0);
    expect(sent()).toEqual(["DELETE /api/push-subscriptions/1", "DELETE /api/push-subscriptions/2"]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("deletes this browser's own subscription only once saving it again as the workspace opened has, which would bring it back", async () => {
    const unsubscribe = vi.fn(async () => true);
    // This browser is the laptop, whose subscription the workspace is saving again as it opens.
    const subscription = { endpoint: LAPTOP.endpoint, toJSON: () => ({ endpoint: LAPTOP.endpoint, keys: { p256dh: "BNcRdreA", auth: "tBHItJI5" } }), unsubscribe };
    const registration = { pushManager: { getSubscription: async () => subscription } };
    Object.defineProperty(navigator, "serviceWorker", { value: { getRegistration: async () => registration }, configurable: true });
    let answer!: (response: Response) => void;
    serve({ saved: () => new Promise((resolve) => (answer = resolve)) });
    const saving = savePushAgain();
    const { onFailed, user } = showPage();
    const [, laptop] = await listed(2);

    await user.click(within(laptop!).getByRole("button", { name: "Delete subscription" }));
    expect(sent()).toEqual(["POST /api/push-subscriptions"]);
    answer(new Response(null, { status: 204 }));
    await saving;
    await listed(1);
    expect(sent()).toEqual(["POST /api/push-subscriptions", "DELETE /api/push-subscriptions/2"]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("lists nothing when no browser has turned notifications on, once it has loaded", async () => {
    serve({ listed: () => Response.json({ subscriptions: [] }) });
    showPage();
    const panel = screen.getByRole("main").querySelector("section");
    expect(panel).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(panel).toHaveAttribute("aria-busy", "false"));
    expect(await listed(0)).toEqual([]);
  });

  it("says why the list didn't load", async () => {
    serve({ listed: () => Response.json({ error: "Something went wrong" }, { status: 500 }) });
    const { onFailed } = showPage();
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(500, "Something went wrong")));
  });
});
