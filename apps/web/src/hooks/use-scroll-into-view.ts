import { createContext, useContext, useEffect, useLayoutEffect, type RefObject } from "react";

/**
 * What the timeline does as something opens in a message to scroll itself into view, as the message's editor does,
 * answering what it does once that's gone: while it's open, the timeline leaves it to grow and scroll as the browser
 * has it, so that it scrolls from where it opened.
 */
export const ScrollIntoViewContext = createContext<() => () => void>(() => () => {});

/** Once it's shown, an element scrolls to the middle of the timeline. */
export function useScrollIntoView(element: RefObject<HTMLElement | null>) {
  const opened = useContext(ScrollIntoViewContext);
  useLayoutEffect(() => opened(), [opened]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => element.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [element]);
}
