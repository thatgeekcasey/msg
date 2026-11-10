import { Launcher } from "chrome-launcher";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { Session } from "../room-client.ts";

/** Chrome from CHROME_PATH, or wherever chrome-launcher finds an installed one. */
export function chromePath(): string {
  const found = Launcher.getFirstInstallation();
  if (!found) throw new Error("No Chrome found. Install Chrome, or set CHROME_PATH to a Chrome or Chromium binary.");
  return found;
}

export function launchChrome(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    // Chrome's sandbox refuses to run as root, which is how containers usually run.
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
    defaultViewport: { width: 1280, height: 800 },
  });
}

/** Signs the page in by giving its browser the session's cookie, without loading the app. */
export async function signInPage(page: Page, origin: string, session: Session): Promise<void> {
  const [name, value] = session.cookie.split("=") as [string, string];
  const { hostname, protocol } = new URL(origin);
  // Over HTTPS the cookie is `__Host-session_token`, which Chrome only takes when it's Secure.
  await page.browserContext().setCookie({ name, value, domain: hostname, path: "/", secure: protocol === "https:", httpOnly: true, sameSite: "Lax" });
}
