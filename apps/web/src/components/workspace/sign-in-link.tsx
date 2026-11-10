import { transferLink } from "@ember/protocol";
import { ArrowRight, Crown, Laptop, SmartphoneDevice } from "@/components/icons/iconoir";
import { LinkButtons, ROUND_BUTTON, type LinkSharing } from "./link-buttons";

// The sign-in link block, at the foot of your profile and, for administrators, of the page of anyone
// active: Campfire's fieldset (base.css), with a laptop, an arrow and a phone on its top border, over
// the link and its buttons.

/** What the sign-in link's buttons are called, and what sharing it sends. */
const SIGN_IN_LINK: LinkSharing = {
  qrCodeLabel: "Show auto-login QR code",
  copyLabel: "Copy auto-login link",
  shareLabel: "Share auto-login link",
  title: "Your sign-in link",
  text: "This is your own private sign-in URL, DO NOT SHARE IT. Use it to sign-in on another device or if you get locked out.",
};

/** Campfire's `.input` in a panel: 42px tall, or 44px for fingers. */
const INPUT = "min-h-[42px] w-full min-w-0 rounded-[9px] border bg-transparent px-[0.8em] py-[0.5em] text-base focus:border-muted-foreground touch:min-h-11";

/**
 * The sign-in link `transferId`, to show as a QR code, copy or share. Your own is named for screen
 * readers only; someone else's says, beside a crown, that it gets them back into their account. Its QR
 * code is drawn in the page, so the link never reaches the Worker.
 */
export function SignInLink({ transferId, mine }: { transferId: string; mine: boolean }) {
  const url = new URL(transferLink(transferId), location.origin).href;

  return (
    <fieldset className="flex w-full flex-col border-t-2 py-4">
      <legend className="mx-auto flex items-center justify-center gap-x-[1ch] px-0.5">
        <Laptop className="size-9" />
        <ArrowRight className="size-9" />
        <SmartphoneDevice className="size-9" />
      </legend>
      <div className="flex flex-col gap-y-4">
        {mine ? (
          <label htmlFor="session_transfer_url" className="sr-only">
            Use this link to login automatically on another device
          </label>
        ) : (
          <div className="flex items-center justify-center gap-x-[1ch]">
            <Crown className="size-4 flex-none" />
            <label htmlFor="session_transfer_url">Share to get them back into their account</label>
          </div>
        )}
        <input type="text" id="session_transfer_url" value={url} readOnly className={INPUT} />
        <div className="mx-auto flex items-center gap-[1ch]">
          <LinkButtons url={url} sharing={SIGN_IN_LINK} qrCodeDrawn className={ROUND_BUTTON} />
        </div>
      </div>
    </fieldset>
  );
}
