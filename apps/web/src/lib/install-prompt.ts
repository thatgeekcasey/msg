import type { Platform } from "@ember/protocol";

// A browser's offer to install Ember as an app, which Campfire's pwa_install_controller.js keeps for
// Install now. The browser makes it once a page load, perhaps before anything with Install now has
// shown, so the app listens for it from the start.

/**
 * Whether this browser is given the steps to install Ember, and Install now with them, as Campfire's
 * app/views/pwa/_install_instructions.html.erb gives them: not Chrome, which is what Chromium Edge and
 * Brave are too by their user agents, nor Firefox but on Android.
 */
export const givesInstallSteps = ({ chrome, firefox, android }: Platform) => !(chrome || (firefox && !android));

/** Chromium's `beforeinstallprompt`, which TypeScript's DOM types leave out. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
}

let offer: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
/** Whether Install now stands in for the browser's own offer, which waits on knowing which browser this is. */
let replacing = false;

function setOffer(event: InstallPromptEvent | null) {
  offer = event;
  for (const listener of listeners) listener();
}

/**
 * Keeps the browser's offer for Install now, as Campfire does wherever there are service workers and
 * Ember isn't installed already. It takes the place of the browser's own, such as its banner on Android,
 * once `replaceInstallPromptsFor` says to.
 */
export function listenForInstallPrompt(): void {
  if (!("serviceWorker" in navigator) || matchMedia("(display-mode: standalone)").matches) return;
  addEventListener("beforeinstallprompt", (event) => {
    if (replacing) event.preventDefault();
    setOffer(event as InstallPromptEvent);
  });
  addEventListener("appinstalled", () => setOffer(null));
}

/**
 * Has Install now take the place of the browser's own offer from now on where `platform` is given the
 * steps to install Ember, as Campfire's controller does on the pages that show them, here every room's
 * and your profile. Any other browser keeps its own, as there.
 */
export function replaceInstallPromptsFor(platform: Platform): void {
  replacing = givesInstallSteps(platform);
}

/** Calls `listener` whenever the browser offers to install Ember, or stops offering. */
export function subscribeToInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the browser has offered to install Ember. */
export const canInstall = () => offer !== null;

/**
 * Shows the browser's prompt to install Ember. A prompt shows only once, so the offer goes with it,
 * until the browser makes another, where Campfire's Install now stays and does nothing when pressed again.
 */
export function promptInstall(): void {
  const prompt = offer;
  setOffer(null);
  prompt?.prompt().catch(() => {});
}
