import { useLayoutEffect } from "react";

/**
 * Makes the workspace's logo at `logo` every page's icon and Apple touch icon, and marks the page's body
 * `account-has-logo` for custom CSS to go by, as Campfire's `body_classes` does. The icon is the logo's
 * 192-pixel variant rather than the 512-pixel one, since a full-size icon delays a room's largest paint,
 * as index.html's 48-pixel one is scaled down for. While there's no logo, pages keep index.html's icons.
 */
export function useAccountLogo(logo: string | null): void {
  useLayoutEffect(() => {
    if (!logo) return;
    document.body.classList.add("account-has-logo");
    const restore = [pointLink("icon", `${logo}&size=small`), pointLink("apple-touch-icon", logo)];
    return () => {
      document.body.classList.remove("account-has-logo");
      for (const pointBack of restore) pointBack();
    };
  }, [logo]);
}

/**
 * Points the page's `rel` link at `href`, without the size index.html gives Ember's own icon, answering
 * what points it back.
 */
function pointLink(rel: string, href: string): () => void {
  const link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!link) return () => {};
  const stock = { href: link.getAttribute("href"), sizes: link.getAttribute("sizes") };
  link.setAttribute("href", href);
  link.removeAttribute("sizes");
  return () => {
    if (stock.href !== null) link.setAttribute("href", stock.href);
    if (stock.sizes !== null) link.setAttribute("sizes", stock.sizes);
  };
}
