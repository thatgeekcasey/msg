import { cn } from "@/lib/utils";

/** Ember's stock app icon, which `/account/logo` serves while the workspace has no logo. */
export const STOCK_LOGO = "/logos/app-icon.png";

/**
 * The workspace's logo at `src`, as "Account logo", square and rounded by half its font size, as
 * Campfire's avatars.css shapes `.account-logo`. `className` sizes and places it.
 */
export function AccountLogo({ src, className }: { src: string; className?: string }) {
  return (
    <figure className={cn("grid aspect-square place-items-center", className)}>
      <img src={src} alt="Account logo" width={300} height={300} className="aspect-square size-full rounded-[0.5em] object-cover" />
    </figure>
  );
}
