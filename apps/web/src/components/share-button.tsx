import type { ComponentProps } from "react";
import { useFlash } from "@/components/flash";
import { shareFile } from "@/lib/share";

/** What's flashed when a file came too late for the click that asked to share it. */
export const SHARE_READY = "Your file is ready. Choose Share again to share it.";

/** What's flashed when a file couldn't be had to share, or the browser won't share it. */
export const SHARE_FAILED = "Couldn't share the file.";

interface ShareButtonProps extends Omit<ComponentProps<"button">, "type"> {
  /** The file to share. */
  url: string;
  /** What the share sheet is titled. */
  sharedTitle?: string;
}

/**
 * A button that shares the file at `url` through the system's share sheet (`shareFile`), flashing when the
 * file came too late for the click, so the next click shares it, or couldn't be had or shared. Over the
 * image viewer, whose dialog covers the flash, the next click still shares it at once. As a tooltip's
 * trigger, it's handed the tooltip's `onClick`, which a click calls first.
 */
export function ShareButton({ url, sharedTitle, onClick, ...props }: ShareButtonProps) {
  const flash = useFlash();
  async function share() {
    const shared = await shareFile(url, sharedTitle);
    if (shared === "ready") flash("notice", SHARE_READY);
    if (shared === "failed") flash("alert", SHARE_FAILED);
  }
  return (
    <button
      type="button"
      {...props}
      onClick={(event) => {
        onClick?.(event);
        void share();
      }}
    />
  );
}
