import { Xmark } from "@/components/icons/iconoir";

/** What a room or a thread has to say over its messages, such as why something didn't go, until it's dismissed. */
export function RoomNotice({ notice, onDismiss }: { notice: string | null; onDismiss: () => void }) {
  if (!notice) return null;
  return (
    <div role="alert" className="mx-auto mt-3 flex max-w-[calc(100%-24px)] items-center gap-2 rounded-[10px] bg-foreground py-2 pr-1 pl-3 text-sm text-background touch:py-0.5">
      {notice}
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="flex size-6 shrink-0 items-center justify-center rounded hover:opacity-80 touch:size-11">
        <Xmark className="size-4" />
      </button>
    </div>
  );
}
