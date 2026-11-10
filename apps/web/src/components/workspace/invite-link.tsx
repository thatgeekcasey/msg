import type { ReactNode } from "react";
import { RefreshDouble, UserPlus } from "@/components/icons/iconoir";
import { JOIN_LINK, joinUrl } from "./join-link";
import { LinkButtons, ROUND_BUTTON, type LinkSharing } from "./link-buttons";

// The invite block on workspace settings: the join link in Campfire's `.input--actor` field, then its
// buttons, Campfire's round `.btn`s (inputs.css, buttons.css). Open sign-up's link shows the same way.

interface ShareableLinkProps {
  /** What the field's ids start with: `invite` for the join link. */
  id: string;
  label: string;
  url: string;
  sharing: LinkSharing;
  /** Any buttons after the link's own. */
  children?: ReactNode;
}

/** `url` in a field named `label`, to show as a QR code, copy or share. */
export function ShareableLink({ id, label, url, sharing, children }: ShareableLinkProps) {
  return (
    <div className="flex flex-col items-center gap-x-[1ch] gap-y-4">
      <label className="flex w-full flex-col gap-y-[0.5em]">
        <strong id={`${id}_label`}>{label}</strong>
        <span className="flex min-h-[42px] items-center gap-[1ch] rounded-[9px] border bg-background px-[0.8em] py-[0.5em] text-base transition-shadow duration-150 focus-within:ring-2 focus-within:ring-selected-dark touch:min-h-11">
          <UserPlus className="size-5 flex-none" />
          <input
            type="text"
            id={`${id}_url`}
            value={url}
            aria-labelledby={`${id}_label`}
            readOnly
            className="min-h-6 w-full min-w-0 bg-transparent p-0 focus-visible:outline-none"
          />
        </span>
      </label>
      <div className="flex items-center gap-[1ch]">
        <LinkButtons url={url} sharing={sharing} className={ROUND_BUTTON} />
        {children}
      </div>
    </div>
  );
}

interface Props {
  joinCode: string;
  /** Gives the link a new code. Only administrators can, and only they get Regenerate join link. */
  onRegenerate?: () => void;
  /** Whether a new code is on its way, which Regenerate join link waits for. */
  regenerating?: boolean;
}

/** The join link, to show as a QR code, copy or share, and for administrators to regenerate. */
export function InviteLink({ joinCode, onRegenerate, regenerating = false }: Props) {
  return (
    <ShareableLink id="invite" label="Share to invite more people" url={joinUrl(joinCode)} sharing={JOIN_LINK}>
      {onRegenerate && (
        <button type="button" onClick={onRegenerate} disabled={regenerating} className={ROUND_BUTTON}>
          <RefreshDouble className="size-[1.3em]" />
          <span className="sr-only">Regenerate join link</span>
        </button>
      )}
    </ShareableLink>
  );
}
