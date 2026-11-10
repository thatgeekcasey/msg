import type { Bootstrap } from "@ember/protocol";
import { describe, expect, it } from "vitest";
import { browserNamesOf, isAppleMessages, isUnsupportedBrowser, platformOf } from "../src/user-agent";
import { api } from "./support";
// Campfire's answers for the user agents in fixtures/user-agents.json: `blocked?`, `apple_messages?`,
// the platform its views see, which is false or "" where Ruby raises, and the gem's browser, version and
// platform, "" where it reads none or raises.
import vectors from "./fixtures/user-agents.json";

/** Expects Campfire to answer each user agent with "Upgrade to a supported web browser". */
function expectTurnedAway(...userAgents: string[]) {
  for (const userAgent of userAgents) expect(isUnsupportedBrowser(userAgent), userAgent).toBe(true);
}

/** Expects Campfire to let each user agent through. */
function expectLetThrough(...userAgents: (string | null)[]) {
  for (const userAgent of userAgents) expect(isUnsupportedBrowser(userAgent), String(userAgent)).toBe(false);
}

describe("Supported browsers", () => {
  it("turns away exactly the vectors' user agents that Campfire does", () => {
    expect(vectors).toHaveLength(385);
    // Rails raises on two of them, which Campfire answers with an error page rather than the upgrade page.
    expect(vectors.filter(({ ua, blocked }) => isUnsupportedBrowser(ua) !== (blocked === true))).toEqual([]);
  });

  it("recognizes Apple Messages in exactly the vectors' user agents that Campfire does", () => {
    expect(vectors.filter(({ ua, appleMessages }) => isAppleMessages(ua) !== appleMessages)).toEqual([]);
  });

  it("turns away Safari before 17.2", () => {
    expectTurnedAway(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
      "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
      // Before Safari 3, Safari reported only its WebKit build, and 125.2 is Safari 1.2.2.
      "Mozilla/5.0 (Macintosh; U; PPC Mac OS X; en) AppleWebKit/125.2 (KHTML, like Gecko) Safari/125.8",
    );
    expectLetThrough(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
      "Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
    );
  });

  it("turns away Chrome before 120", () => {
    expectTurnedAway(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.199 Safari/537.36",
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
    );
    expectLetThrough("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  });

  it("turns away Firefox before 121", () => {
    expectTurnedAway("Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0");
    expectLetThrough(
      "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
      "Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0",
    );
  });

  it("turns away Opera before 104, by its own version rather than its Chrome's", () => {
    expectTurnedAway(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36 OPR/103.0.0.0",
      "Opera/9.80 (Windows NT 6.1; U; en) Presto/2.9.168 Version/11.52",
      "Opera/9.80 (Android; Opera Mini/7.5.33361/31.1448; U; en) Presto/2.8.119 Version/11.1010",
    );
    expectLetThrough(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 OPR/104.0.0.0",
    );
  });

  it("turns away every Internet Explorer", () => {
    expectTurnedAway(
      "Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko",
      "Mozilla/5.0 (compatible; MSIE 10.0; Windows Phone 8.0; Trident/6.0; IEMobile/10.0; ARM; Touch; NOKIA; Lumia 920)",
      "Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1; SV1)",
    );
  });

  it("reads Chromium Edge, Chrome on iOS and Samsung Internet by their Chrome version", () => {
    expectTurnedAway(
      // Not among the vectors, which have no Chromium Edge before 120.
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.2151.97",
      "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.6045.169 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
    );
    expectLetThrough(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.51",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/121.0.6167.66 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
    );
  });

  it("reads Firefox on iOS as Safari at the iOS version, and Edge on iOS by its Safari version", () => {
    expectTurnedAway(
      // Not among the vectors, which have no Firefox on iOS before 17.2.
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/124.2478.50 Mobile/15E148 Safari/605.1.15",
    );
    expectLetThrough(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/140.3485.94 Mobile/15E148 Safari/605.1.15",
    );
  });

  it("lets legacy Edge and other browsers through, whatever their version", () => {
    expectLetThrough(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19582",
      "Mozilla/5.0 (Linux; Android 13; V2185A Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.141 Mobile Safari/537.36 XWEB/5317 MMWEBSDK/20230701 MMWEBID/2350 MicroMessenger/8.0.40.2420(0x28002837) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64",
      "Mozilla/5.0 (Linux; U; Android 2.2; en-us; Nexus One Build/FRF91) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1",
      "Mozilla/5.0 (Macintosh; U; PPC Mac OS X 10.4; en-US; rv:1.8.1.14) Gecko/20080404 Camino/1.6.1",
      "curl/8.4.0",
    );
  });

  it("lets bots through", () => {
    expectLetThrough(
      "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.6099.216 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse",
      // The gem reads Chrome from its first product with a comment, and takes one without any for a bot.
      "Chrome/119.9.9.9.9.9.9",
    );
  });

  it("lets through user agents without a version, and requests without one", () => {
    expectLetThrough(
      null,
      "",
      "   ",
      "\t",
      "Chrome",
      "Opera",
      "Mozilla/4.0 (compatible; MSIE; Windows NT 6.1)",
      "Opera/9.80 (Android; Opera Mini; U; en) Presto/2.8.119",
    );
  });

  it("lets through user agents Rails fails to read, which Campfire answers with an error page", () => {
    expectLetThrough(
      // WeChat's version is its MicroMessenger product's, which this one hasn't got.
      "MicroMessengerX/1.0",
      // A PlayStation Vita without Silk has no browser for Rails to look a minimum up by.
      "Mozilla/5.0 (PlayStation Vita 3.60) AppleWebKit/537.73 (KHTML, like Gecko)",
    );
  });

  it("turns away a browser that calls itself IE, which Rails looks Internet Explorer up as", () => {
    expectTurnedAway("IE/6.0");
  });

  it("folds case as Ruby does, so a MicroMeßenger is WeChat", () => {
    // Rails then fails to read its version.
    expectLetThrough(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 MicroMeßenger/8.0",
    );
  });

  it("recognizes Apple Messages, which claims to be both Facebook's and Twitter's crawlers", () => {
    const appleMessages =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0";
    expect(isAppleMessages(appleMessages)).toBe(true);
    // It reports Safari 9, so its link previews get the upgrade page, which Campfire titles "Ember" for it.
    expect(isUnsupportedBrowser(appleMessages)).toBe(true);
    expect(
      isAppleMessages(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 facebookexternalhit/1.1 Twitterbot/1.0",
      ),
    ).toBe(true);

    expect(isAppleMessages("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)")).toBe(false);
    expect(isAppleMessages("Twitterbot/1.0")).toBe(false);
    expect(isAppleMessages(null)).toBe(false);
  });
});

describe("Notification setup help", () => {
  it("reads exactly the platforms the vectors' user agents have in Campfire's views", () => {
    expect(vectors.map(({ ua }) => ({ ua, platform: platformOf(ua) }))).toEqual(vectors.map(({ ua, platform }) => ({ ua, platform })));
  });

  it("counts Chromium Edge and Chrome on iPhone as Chrome, and Firefox and Edge on iPhone as Safari", () => {
    const browserOf = (userAgent: string) => {
      const { browser, chrome, firefox, safari, edge } = platformOf(userAgent);
      return { browser, chrome, firefox, safari, edge };
    };
    const chrome = { browser: "Chrome", chrome: true, firefox: false, safari: false, edge: false };
    const safari = { browser: "Safari", chrome: false, firefox: false, safari: true, edge: false };
    expect(
      browserOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.51"),
    ).toEqual(chrome);
    expect(
      browserOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1"),
    ).toEqual(chrome);
    expect(
      browserOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15"),
    ).toEqual(safari);
    expect(
      browserOf(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/124.2478.50 Mobile/15E148 Safari/605.1.15",
      ),
    ).toEqual(safari);
    // Only Edge from before it was built on Chrome is Edge.
    expect(
      browserOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19582"),
    ).toEqual({ browser: "Edge", chrome: false, firefox: false, safari: false, edge: true });
  });

  it("names the system from the device, else from the operating system, calling any Linux just Linux", () => {
    const systemOf = (userAgent: string | null) => {
      const { operatingSystem, windows, ios, android, desktop } = platformOf(userAgent);
      return { operatingSystem, windows, ios, android, desktop };
    };
    expect(systemOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0")).toEqual({
      operatingSystem: "Windows",
      windows: true,
      ios: false,
      android: false,
      desktop: true,
    });
    expect(systemOf("Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0")).toEqual({
      operatingSystem: "Android",
      windows: false,
      ios: false,
      android: true,
      desktop: false,
    });
    expect(
      systemOf("Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"),
    ).toEqual({ operatingSystem: "iPad", windows: false, ios: true, android: false, desktop: false });
    // iPadOS Safari says it's a Mac.
    expect(
      systemOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"),
    ).toEqual({ operatingSystem: "macOS", windows: false, ios: false, android: false, desktop: true });
    expect(systemOf("Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0").operatingSystem).toBe("Linux");
    expect(systemOf("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0").operatingSystem).toBe("Ubuntu");
    expect(
      systemOf("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36").operatingSystem,
    ).toBe("ChromeOS 14541.0.0");
    // No user agent reads as the gem's "Mozilla/4.0 (compatible)", which names no system.
    expect(platformOf(null)).toEqual({
      ios: false,
      android: false,
      desktop: true,
      windows: false,
      chrome: false,
      firefox: false,
      safari: false,
      edge: false,
      browser: "Mozilla",
      operatingSystem: "",
    });
  });

  it("tells the app the platform of the browser that asks, which its setup help is for", async () => {
    const iPhone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    const { platform } = (await (await api("/api/bootstrap", { headers: { "User-Agent": iPhone } })).json()) as Bootstrap;
    expect(platform).toEqual({
      ios: true,
      android: false,
      desktop: false,
      windows: false,
      chrome: false,
      firefox: false,
      safari: true,
      edge: false,
      browser: "Safari",
      operatingSystem: "iPhone",
    });
  });
});

describe("Push subscriptions page", () => {
  it("names exactly the vectors' browsers, versions and platforms the push subscriptions page shows", () => {
    expect(vectors.map(({ ua }) => ({ ua, names: browserNamesOf(ua) }))).toEqual(vectors.map(({ ua, names }) => ({ ua, names })));
  });

  it("names a browser that sent no user agent as the gem reads one, Mozilla 4.0, on no platform", () => {
    expect(browserNamesOf(null)).toEqual({ browser: "Mozilla", version: "4.0", platform: "" });
  });
});
