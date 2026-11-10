import type { ReactNode } from "react";

// The rows of the people lists, which the room forms and workspace settings share, and the rule between
// their groups.

/** One row of a list: a picture, the name in a pill, a dashed line, and what follows. */
export function ListRow({ figure, name, children }: { figure: ReactNode; name: string; children?: ReactNode }) {
  return (
    <li className="flex items-center gap-x-[1ch]">
      {figure}
      <div className="min-w-0">
        <div className="truncate rounded-full border bg-surface px-[9px] py-[3px] leading-[1.4]">
          <strong>{name}</strong>
        </div>
      </div>
      <hr aria-hidden="true" className="min-w-[2ch] grow border-t border-dashed" />
      {children}
    </li>
  );
}

/** Campfire's `.separator.full-width` with `--border-style: solid`, between a list's groups. */
export function ListSeparator() {
  return <hr className="w-full" />;
}
