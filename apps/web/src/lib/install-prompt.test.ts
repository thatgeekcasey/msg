import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHROME_MAC, OPERA_ANDROID } from "@/test-platforms";
import { canInstall, listenForInstallPrompt, replaceInstallPromptsFor } from "./install-prompt";

// notification-help.test.tsx has Install now keep and use the browser's offer.

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  vi.unstubAllGlobals();
});

/** The browser offering to install Ember, as Chromium does with `beforeinstallprompt`. */
function offerToInstall() {
  const offer = new Event("beforeinstallprompt", { cancelable: true });
  dispatchEvent(offer);
  return offer;
}

/** Whether the browser may make its own offer to install Ember, which Install now would have taken. */
function browserOffers() {
  return !offerToInstall().defaultPrevented && !canInstall();
}

describe("Install as an app", () => {
  it("leaves the browser its own offer on a page without service workers, as Campfire does", () => {
    listenForInstallPrompt();
    expect(browserOffers()).toBe(true);
  });

  it("leaves the browser its own offer in the installed app", () => {
    Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
    vi.stubGlobal("matchMedia", (media: string) => ({ matches: media === "(display-mode: standalone)", media }));
    listenForInstallPrompt();
    expect(browserOffers()).toBe(true);
  });

  describe("on a page that has service workers", () => {
    beforeAll(() => {
      // Pages only have service workers where they're secure, which jsdom's aren't.
      Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
      listenForInstallPrompt();
    });

    it("keeps the offer for Install now, in place of the browser's own once it knows the browser is given the install steps", () => {
      expect(offerToInstall().defaultPrevented).toBe(false);
      expect(canInstall()).toBe(true);

      replaceInstallPromptsFor(OPERA_ANDROID);
      expect(offerToInstall().defaultPrevented).toBe(true);
      expect(canInstall()).toBe(true);
    });

    it("leaves Chrome its own offer, as it gets no install steps", () => {
      replaceInstallPromptsFor(CHROME_MAC);
      expect(offerToInstall().defaultPrevented).toBe(false);
    });
  });
});
