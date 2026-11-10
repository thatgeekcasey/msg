import { useLayoutEffect } from "react";

/**
 * Applies the CSS administrators give the workspace, after the app's own, as Campfire's
 * `custom_styles_tag` writes it into every page's head. It goes in as text, so `</style>` in it can't
 * add anything else to the page. The page's body is marked `admin` for an administrator, as Campfire's
 * `body_classes` marks it, for the CSS to go by.
 */
export function useCustomStyles(customStyles: string, administrator: boolean): void {
  useLayoutEffect(() => {
    if (!customStyles) return;
    const style = document.createElement("style");
    style.textContent = customStyles;
    document.head.append(style);
    return () => style.remove();
  }, [customStyles]);

  useLayoutEffect(() => {
    if (!administrator) return;
    document.body.classList.add("admin");
    return () => document.body.classList.remove("admin");
  }, [administrator]);
}
