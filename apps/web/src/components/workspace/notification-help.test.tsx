import type { Platform } from "@ember/protocol";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listenForInstallPrompt, replaceInstallPromptsFor } from "@/lib/install-prompt";
import { CHROME_LINUX, CHROME_MAC, SAFARI_IPHONE, SAFARI_MAC } from "@/test-platforms";
import facts from "./golden/platforms.json";
import { InstallInstructions, NotificationHelp } from "./notification-help";

// The goldens of the help, by path, such as ./golden/browser_settings_chrome_mac.html (golden/README.md).
const goldens = import.meta.glob<string>("./golden/*.html", { query: "?raw", import: "default", eager: true });

/** The user agents the goldens were rendered for, such as `chrome_mac`. */
const LABELS = Object.keys(facts.user_agents) as Array<keyof typeof facts.platforms>;

/** The partials of help, in the order the setup dialog gives them. */
const PARTIALS = ["browser_settings", "system_settings", "install_instructions"];

/** The platform Rails read from the user agent `label`, as the Worker gives it. */
function platformOf(label: keyof typeof facts.platforms): Platform {
  const { ios, android, desktop, windows, chrome, firefox, safari, edge, browser, operating_system } = facts.platforms[label];
  return { ios, android, desktop, windows, chrome, firefox, safari, edge, browser, operatingSystem: operating_system };
}

/**
 * What Campfire's `partial` says for the user agent `label`, as `linesOf` reads it, in Ember's name and at
 * this page's address, or null where Campfire leaves it out.
 */
function golden(partial: string, label: string): string[] | null {
  const html = goldens[`./golden/${partial}_${label}.html`];
  if (html === undefined) throw new Error(`No golden for ${partial}_${label}`);
  if (!html.trim()) return null;
  const site = new URL("/", location.href).href;
  const page = new DOMParser().parseFromString(html.replaceAll("Campfire", "Ember").replaceAll(`${facts.base_url}/`, site), "text/html");
  // Install now, which only shows once the browser offers to install Ember, as tests below check.
  page.querySelector(".pwa__installer")?.remove();
  return linesOf(page.body);
}

const BLOCKS = new Set(["DETAILS", "SUMMARY", "H2", "OL", "LI", "P", "DIV", "HR"]);

/**
 * What a section of help says, as a screen reader takes it in: a line for each block, after its tag,
 * with a picture, or the Apple menu, by its name in brackets, and nothing for one that only decorates.
 */
function linesOf(root: Element): string[] {
  let text = "";
  const read = (node: Node) => {
    // Its own line breaks are the markup's, which a reader doesn't see.
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent!.replace(/\s+/g, " ");
    if (!(node instanceof Element)) return;
    const name = node.tagName === "IMG" ? node.getAttribute("alt") : node.getAttribute("aria-label");
    if (node.getAttribute("aria-hidden") === "true") return;
    if (name) return void (text += `[${name}]`);
    const block = BLOCKS.has(node.tagName);
    if (block) text += `\n${node.tagName.toLowerCase()}: `;
    node.childNodes.forEach(read);
    if (block) text += "\n";
  };
  read(root);
  return text
    .split("\n")
    .map((line) => line.replace(/ +/g, " ").trim())
    .filter((line) => !/^([a-z0-9]+:)?$/.test(line));
}

/** The sections shown, as `linesOf` reads them. */
const sectionsIn = (container: HTMLElement) => [...container.querySelectorAll("details")].map(linesOf);

/** Says the page is shown in `displayMode`, as a browser's `display-mode` media feature does. */
function shownIn(displayMode: "browser" | "standalone" | "minimal-ui") {
  vi.stubGlobal("matchMedia", (media: string) => ({ matches: media === `(display-mode: ${displayMode})`, media, addEventListener() {}, removeEventListener() {} }));
}

const titleOf = (details: HTMLDetailsElement) => details.querySelector("summary")!.textContent;

afterEach(() => vi.unstubAllGlobals());

describe("Notification setup help", () => {
  // These tests' matchMedia matches nothing, as in a window that's neither a browser tab nor the
  // installed app, where every section shows.
  it.each(LABELS)("gives %s exactly the help Campfire gives it, in its words", (label) => {
    const { container } = render(<NotificationHelp platform={platformOf(label)} />);
    expect(sectionsIn(container)).toEqual(PARTIALS.map((partial) => golden(partial, label)).filter((lines) => lines !== null));
  });

  it("leaves out the system's settings in a browser tab, and how to install Ember in the installed app", () => {
    shownIn("browser");
    const { container, rerender } = render(<NotificationHelp platform={SAFARI_MAC} />);
    expect([...container.querySelectorAll("details")].map(titleOf)).toEqual(["Check your Safari settings", "Install Ember as a web app."]);
    shownIn("standalone");
    rerender(<NotificationHelp key="installed" platform={SAFARI_MAC} />);
    expect([...container.querySelectorAll("details")].map(titleOf)).toEqual(["Check your Safari settings", "Check your macOS settings"]);
  });

  it("opens the one section it gives, and none of two or more", () => {
    shownIn("browser");
    const { container, rerender } = render(<NotificationHelp platform={SAFARI_IPHONE} />);
    expect([...container.querySelectorAll("details")].map((details) => [titleOf(details), details.open])).toEqual([["Install Ember as a web app.", true]]);
    expect(screen.getByText("To receive push notifications in Safari for iPhone, you must install Ember as a web app.")).toBeVisible();

    rerender(<NotificationHelp platform={CHROME_MAC} />);
    expect([...container.querySelectorAll("details")].map((details) => [titleOf(details), details.open])).toEqual([["Check your Chrome settings", true]]);

    rerender(<NotificationHelp platform={SAFARI_MAC} />);
    expect([...container.querySelectorAll("details")].map((details) => details.open)).toEqual([false, false]);
  });

  it("gives a system it has no steps for, such as Linux, the sentence for one", () => {
    shownIn("standalone");
    render(<NotificationHelp platform={CHROME_LINUX} />);
    expect(screen.getByText("Check your Linux settings")).toBeInTheDocument();
    // Once for Chrome's own notifications, under its settings, and once for the system's.
    expect(screen.getAllByText("Ensure notifications are allowed for Chrome in your system settings.")).toHaveLength(2);
    expect(screen.queryByRole("img", { name: "the Apple menu" })).not.toBeInTheDocument();
    expect(screen.queryByText("System Settings…")).not.toBeInTheDocument();
  });

  it("names the Apple menu's logo as a picture", () => {
    shownIn("browser");
    render(<NotificationHelp platform={CHROME_MAC} />);
    expect(screen.getByRole("img", { name: "the Apple menu" })).toHaveTextContent("");
  });
});

describe("Install as an app", () => {
  it.each(LABELS)("gives %s exactly the install steps Campfire's profile gives it", (label) => {
    const { container } = render(<InstallInstructions platform={platformOf(label)} />);
    expect(sectionsIn(container)).toEqual([golden("install_instructions", label)].filter((lines) => lines !== null));
  });

  it("gives none in the installed app", () => {
    shownIn("standalone");
    const { container } = render(<InstallInstructions platform={SAFARI_MAC} />);
    expect(container).toBeEmptyDOMElement();
  });

  describe("Install now", () => {
    beforeAll(() => {
      // Pages only have service workers where they're secure, which jsdom's aren't.
      Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
      listenForInstallPrompt();
      replaceInstallPromptsFor(SAFARI_MAC);
      Reflect.deleteProperty(navigator, "serviceWorker");
    });

    /** The browser offering to install Ember, as Chromium does with `beforeinstallprompt`. */
    function offerToInstall() {
      const offer = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt: vi.fn(async () => ({ outcome: "accepted" })) });
      act(() => void dispatchEvent(offer));
      return offer;
    }

    it("shows once the browser offers to install Ember, in place of the browser's own offer, and prompts to", () => {
      render(<InstallInstructions platform={SAFARI_MAC} />);
      expect(screen.queryByRole("button", { name: "Install now" })).not.toBeInTheDocument();

      const offer = offerToInstall();
      expect(offer.defaultPrevented).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Install now" }));
      expect(offer.prompt).toHaveBeenCalledOnce();
      // A prompt only shows once.
      expect(screen.queryByRole("button", { name: "Install now" })).not.toBeInTheDocument();
    });

    it("goes once Ember is installed", () => {
      render(<InstallInstructions platform={SAFARI_MAC} />);
      offerToInstall();
      expect(screen.getByRole("button", { name: "Install now" })).toBeInTheDocument();
      act(() => void dispatchEvent(new Event("appinstalled")));
      expect(screen.queryByRole("button", { name: "Install now" })).not.toBeInTheDocument();
    });
  });
});
