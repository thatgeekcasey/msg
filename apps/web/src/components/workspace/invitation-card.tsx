import { useState } from "react";
import { AccountLogo } from "@/components/account-logo";
import { Link, Xmark } from "@/components/icons/iconoir";
import { TranslationButton } from "@/components/translation-button";
import { useAccount } from "@/hooks/use-account";
import { JOIN_LINK, joinUrl } from "./join-link";
import { LinkButtons } from "./link-buttons";

// The welcome card, which only administrators are shown, with an × that dismisses it, as the project's
// owner chose.

/** A `.btn` among an invitation's actions: a 38px square, 44px for fingers. */
const BUTTON = "grid size-[38px] flex-none cursor-pointer place-items-center rounded-[9px] border bg-background text-sm touch:size-11";

interface Props {
  joinCode: string;
  /** Dismisses the card for good, settling once it's gone, or failed to go. */
  onDismiss: () => Promise<void>;
}

/** Welcomes an administrator to the workspace's first room with its join link, to copy or share, until they dismiss it. */
export function InvitationCard({ joinCode, onDismiss }: Props) {
  const url = joinUrl(joinCode);
  const { logo } = useAccount();

  return (
    <div className="mx-6 mb-1 w-[560px] max-w-[calc(100%-48px)] rounded-[14px] border bg-background p-[22px] narrow:mx-[18px] narrow:max-w-[calc(100%-36px)] narrow:p-[18px] max-md:mx-3 max-md:max-w-[calc(100%-24px)] max-md:p-4">
      <div className="mb-5 flex items-start gap-3.5 max-md:mb-3.5 max-md:gap-3">
        {/* The logo on the card's background, in an 11px rounded square, as `#system_welcome .account-logo`. */}
        {logo ? (
          <AccountLogo src={logo} className="size-11 flex-none rounded-[11px] bg-background" />
        ) : (
          <img src="/ember-icon.png" alt="Ember" width={44} height={44} className="size-11 flex-none object-contain" />
        )}
        <div>
          <h2 className="mb-[3px] text-[17px] font-[650] max-md:text-[15px]">Welcome to Ember</h2>
          <p className="text-muted-foreground max-md:text-[13px]">To invite people to chat, share the join link below.</p>
        </div>
        <TranslationButton translations="invite_message" />
        <DismissButton onDismiss={onDismiss} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-[38px] min-w-0 flex-1 items-center gap-2 rounded-[9px] border px-[9px] py-[7px] narrow:basis-full max-md:basis-full touch:min-h-11">
          <span id="invite_label" className="sr-only">
            Share to invite more people
          </span>
          <Link className="size-5 flex-none text-muted-foreground" />
          {/* 16px for fingers, so iOS doesn't zoom in when it's tapped. */}
          <input
            type="text"
            id="invite_url"
            value={url}
            aria-labelledby="invite_label"
            readOnly
            className="w-full min-w-0 bg-transparent p-0 font-mono text-[13px] text-ellipsis text-foreground touch:text-base"
          />
        </label>
        <div className="flex flex-none items-center gap-2">
          <LinkButtons url={url} sharing={JOIN_LINK} className={BUTTON} />
        </div>
      </div>
    </div>
  );
}

/**
 * The card's ×, at the end of its heading, drawn as the icon dialog draws its own: 36px, or 44px for
 * fingers, with a 20px ×, in the muted ink of the star in a room's header. While the dismissal saves,
 * it's dimmed and ignores presses, through `aria-disabled`, as the star is, so it keeps the keyboard's
 * focus.
 */
function DismissButton({ onDismiss }: Pick<Props, "onDismiss">) {
  const [dismissing, setDismissing] = useState(false);

  const dismiss = async () => {
    if (dismissing) return;
    setDismissing(true);
    try {
      await onDismiss();
    } finally {
      setDismissing(false);
    }
  };

  return (
    <button
      type="button"
      aria-label="Dismiss welcome card"
      aria-disabled={dismissing || undefined}
      onClick={dismiss}
      className="-mt-1.5 -mr-1.5 ml-auto grid size-9 flex-none cursor-pointer place-items-center rounded-[9px] text-muted-foreground hover:bg-hover hover:text-foreground touch:size-11 aria-disabled:pointer-events-none aria-disabled:opacity-50"
    >
      <Xmark className="size-5" />
    </button>
  );
}
