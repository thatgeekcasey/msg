// jsdom has no matchMedia. This stand-in answers `(prefers-color-scheme: dark)` from a flag that
// tests can flip, and tells listeners when it changes, as a browser does when the OS theme changes.

type Listener = (event: { matches: boolean }) => void;

const listeners = new Set<Listener>();
let prefersDark = false;

export function installMatchMedia(): void {
  window.matchMedia = (query: string) =>
    ({
      media: query,
      get matches() {
        return query.includes("dark") && prefersDark;
      },
      addEventListener: (_: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
    }) as unknown as MediaQueryList;
}

export function setPrefersDark(value: boolean): void {
  prefersDark = value;
  listeners.forEach((listener) => listener({ matches: value }));
}
