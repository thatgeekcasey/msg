import { useCallback, useSyncExternalStore } from "react";

/** Whether a CSS media query matches, updated when it changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches);
}

/**
 * How many of the screen's own pixels there are to each of the page's, updated when that changes, as it
 * does once the window is moved to another display or the page zoomed. A query of the ratio as it is
 * stops matching once it changes, so each change watches for the next by the ratio it changed to.
 */
export function usePixelRatio(): number {
  const subscribe = useCallback((onChange: () => void) => {
    let ratio = devicePixelRatio;
    let list = matchMedia(`(resolution: ${ratio}dppx)`);
    const changed = () => {
      if (devicePixelRatio === ratio) return;
      list.removeEventListener("change", changed);
      ratio = devicePixelRatio;
      list = matchMedia(`(resolution: ${ratio}dppx)`);
      list.addEventListener("change", changed);
      onChange();
    };
    list.addEventListener("change", changed);
    return () => list.removeEventListener("change", changed);
  }, []);
  return useSyncExternalStore(subscribe, () => devicePixelRatio);
}
