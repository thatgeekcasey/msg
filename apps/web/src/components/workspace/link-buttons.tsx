import type { MouseEvent } from "react";
import { Copy, QrCode, ShareAndroid } from "@/components/icons/iconoir";
import { QrCodeLink } from "@/components/qr-code-link";

// The buttons beside a link to hand on, the join link and the sign-in link: its QR code, Copy and Share.

/** What a link's buttons are called, and what sharing it sends with it. */
export interface LinkSharing {
  qrCodeLabel: string;
  copyLabel: string;
  shareLabel: string;
  /** The title and text the system's share sheet gets with the link. */
  title: string;
  text: string;
}

/** Campfire's round `.btn` showing only an icon, in a panel: 36px, and 44px for fingers. */
export const ROUND_BUTTON =
  "grid size-9 flex-none cursor-pointer place-items-center rounded-full border bg-background touch:size-11 disabled:pointer-events-none disabled:opacity-50";

/** Campfire's `btn--success` (buttons.css), which the copy button plays each time it copies. */
const COPIED = ["motion-safe:animate-success", "motion-safe:[&>img]:animate-zoom-fade"];

interface LinkButtonsProps {
  url: string;
  sharing: LinkSharing;
  /** Whether the page draws the link's QR code itself, as it does a sign-in link's (`QrCodeLink`). */
  qrCodeDrawn?: boolean;
  className: string;
}

/** `url`'s QR code, copy and share buttons, each styled with `className`. */
export function LinkButtons({ url, sharing, qrCodeDrawn = false, className }: LinkButtonsProps) {
  // Whether the browser can share at all, decided before it's ever asked to.
  const canShare = "canShare" in navigator;

  return (
    <>
      <QrCodeLink url={url} drawn={qrCodeDrawn} className={className}>
        <span className="sr-only">{sharing.qrCodeLabel}</span>
        <QrCode className="size-[1.3em]" />
      </QrCodeLink>
      <CopyButton text={url} label={sharing.copyLabel} className={className} />
      {canShare && (
        <button type="button" onClick={() => void share(url, sharing)} className={className}>
          <span className="sr-only">{sharing.shareLabel}</span>
          <ShareAndroid className="size-[1.3em]" />
        </button>
      )}
    </>
  );
}

/** A copy button, called `label` by screen readers, which copies `text`. */
export function CopyButton({ text, label, className }: { text: string; label: string; className: string }) {
  return (
    <button type="button" onClick={(event) => void copy(event, text)} className={className}>
      <span className="sr-only">{label}</span>
      <Copy className="size-[1.3em]" />
    </button>
  );
}

/**
 * Copies `text`, then plays the button's success animation from the start. A clipboard that refuses, as
 * on a page that isn't served securely, leaves the button as it was.
 */
async function copy({ currentTarget: button }: MouseEvent<HTMLButtonElement>, text: string) {
  button.classList.remove(...COPIED);
  // Reading the layout ends the last run of the animation, so adding the classes starts it again.
  void button.offsetWidth;
  try {
    await navigator.clipboard.writeText(text);
    button.classList.add(...COPIED);
  } catch {
    // Nothing to show.
  }
}

/** Offers `url` to the system's share sheet. Closing the sheet rejects, which needs no answer. */
async function share(url: string, { title, text }: LinkSharing) {
  await navigator.share({ title, text, url }).catch(() => undefined);
}
