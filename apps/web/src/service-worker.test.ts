import { describe, expect, it, vi } from "vitest";
import source from "../public/service-worker.js?raw";

// The service worker, public/service-worker.js, which the build copies as it is, so its test can't sit
// beside it.

type Listener = (event: object) => unknown;

/** Runs the service worker in a stand-in for its global scope, with a focused window if `focused`, and app badges unless `badges` is false. */
function serviceWorker({ focused = false, badges = true } = {}) {
  const listeners = new Map<string, Listener>();
  const window = { focused, navigate: vi.fn(async () => window) };
  const self = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    registration: { showNotification: vi.fn(async () => {}) },
    navigator: badges ? { setAppBadge: vi.fn(async () => {}) } : {},
    clients: { matchAll: vi.fn(async () => [window]), openWindow: vi.fn(async () => null) },
    location: { origin: "https://ember.example" },
  };
  new Function("self", source)(self);

  /** Dispatches `event` as the browser does, settling once all it waits for has. */
  async function dispatch(type: string, event: object): Promise<void> {
    const waits: Array<Promise<unknown>> = [];
    await listeners.get(type)!({ ...event, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
  }
  return { self, window, listeners, dispatch };
}

/** A push as the Worker sends one, with its message's room and the person's unread count. */
const push = (data: object) => ({ data: { json: () => ({ title: "general", options: { body: "Ada: Lunch?", icon: "/logo.png", data } }) } });

const click = (path: string) => ({ notification: { data: { path }, close: vi.fn() } });

describe("Service worker", () => {
  it("listens only for pushes and clicks, so it caches nothing", () => {
    expect([...serviceWorker().listeners.keys()]).toEqual(["push", "notificationclick"]);
  });

  it("shows a push as a notification with its title and options, and sets the app's badge to its count", async () => {
    const { self, dispatch } = serviceWorker();
    await dispatch("push", push({ path: "/rooms/r1", badge: 3 }));
    expect(self.registration.showNotification).toHaveBeenCalledWith("general", { body: "Ada: Lunch?", icon: "/logo.png", data: { path: "/rooms/r1", badge: 3 } });
    expect(self.navigator.setAppBadge).toHaveBeenCalledWith(3);
  });

  it("clears the badge for a push without a count, and leaves it be in a browser without badges", async () => {
    const { self, dispatch } = serviceWorker();
    await dispatch("push", push({ path: "/rooms/r1" }));
    expect(self.navigator.setAppBadge).toHaveBeenCalledWith(0);

    const withoutBadges = serviceWorker({ badges: false });
    await withoutBadges.dispatch("push", push({ path: "/rooms/r1", badge: 3 }));
    expect(withoutBadges.self.registration.showNotification).toHaveBeenCalledOnce();
  });

  it("closes a clicked notification and opens its page in the focused window", async () => {
    const { self, window, dispatch } = serviceWorker({ focused: true });
    const event = click("/rooms/r1");
    await dispatch("notificationclick", event);
    expect(event.notification.close).toHaveBeenCalled();
    expect(window.navigate).toHaveBeenCalledWith("https://ember.example/rooms/r1");
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens the page in a new window when none is focused", async () => {
    const { self, window, dispatch } = serviceWorker();
    await dispatch("notificationclick", click("/rooms/r1"));
    expect(self.clients.openWindow).toHaveBeenCalledWith("https://ember.example/rooms/r1");
    expect(window.navigate).not.toHaveBeenCalled();
  });
});
