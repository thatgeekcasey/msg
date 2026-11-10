import type { ComponentProps, MouseEvent } from "react";
import { navigate } from "@/hooks/use-route";

/**
 * A link to another of the app's pages, which it shows in place, unless it's opened somewhere else: with
 * a modifier key, say, or another button. `replace` takes the current page's place in the history, as
 * Turbo's `data-turbo-action="replace"` does.
 */
export function PageLink({ href, replace, onClick, ...props }: ComponentProps<"a"> & { href: string; replace?: boolean }) {
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href, { replace });
  };
  return <a href={href} onClick={follow} {...props} />;
}
