import type { PendingUpload } from "@/lib/room-state";
import { cn } from "@/lib/utils";

/** A file's size as its upload card gives it: in whole KB, at least 1, under a megabyte, and in MB to one place from there. */
export const uploadSize = (size: number) => (size < 1_000_000 ? `${Math.max(1, Math.ceil(size / 1000))} KB` : `${(size / 1_000_000).toFixed(1)} MB`);

/**
 * The card for a file on its way to becoming a message: its name and size, then a bar showing how much
 * of it has gone, or why it failed, which a failed card keeps until the page is loaded again.
 */
export function UploadCard({ upload }: { upload: PendingUpload }) {
  const { name, size, percent, error } = upload;
  const status = error ? "Upload failed" : percent === 100 ? "Processing…" : `Uploading · ${percent}%`;
  return (
    <div role="group" aria-label={`Upload ${name}`} className={cn("my-1.5 grid w-[min(380px,100%)] gap-2.5 rounded-[12px] border bg-surface px-4 py-3.5", error && "border-negative")}>
      <div className="flex min-w-0 items-baseline gap-3">
        <strong className="min-w-0 flex-1 text-[14px] font-semibold wrap-anywhere">{name}</strong>
        <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">{uploadSize(size)}</span>
      </div>
      {error ? (
        <p role="alert" className="text-[13px] leading-normal text-negative wrap-anywhere">
          {error}
        </p>
      ) : (
        <progress
          max={100}
          value={percent}
          aria-label={`Upload progress for ${name}`}
          className={cn(
            "block h-1.5 w-full appearance-none overflow-hidden rounded-full border-0 bg-border",
            "[&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-border",
            "[&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-foreground [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-foreground",
          )}
        />
      )}
      <span role="status" className="text-[12px] text-muted-foreground tabular-nums">
        {status}
      </span>
    </div>
  );
}
