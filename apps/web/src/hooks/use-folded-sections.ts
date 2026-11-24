import { useSyncExternalStore } from "react";
import type { SectionId } from "@ember/protocol";

// The sidebar sections this browser has folded, by id, as their arrows leave them, whoever signs in, as
// the last room is kept (`last-room.ts`). Every sidebar drawn, as the drawer's is beside the one a wider
// window shows, and every tab of the browser, fold and unfold them together.

export const FOLDED_SECTIONS_KEY = "ember:folded-sections";

const listeners = new Set<() => void>();
// What's folded, read once while any sidebar is drawn, and kept as folded in this tab if storage is refused.
let folds: ReadonlySet<SectionId> | null = null;

function storedFolds(): ReadonlySet<SectionId> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(FOLDED_SECTIONS_KEY) ?? "[]");
    return new Set(Array.isArray(stored) ? stored.filter((id): id is SectionId => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

const tell = () => listeners.forEach((listener) => listener());

function heard(event: StorageEvent) {
  // A null key is storage cleared.
  if (event.key !== FOLDED_SECTIONS_KEY && event.key !== null) return;
  folds = storedFolds();
  tell();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", heard);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.removeEventListener("storage", heard);
    // Read again when a sidebar is next drawn, since other tabs may have folded others meanwhile.
    folds = null;
  };
}

const folded = () => (folds ??= storedFolds());

/** Folds section `sectionId`, or unfolds it, in every sidebar drawn and every tab. */
function fold(sectionId: SectionId, folding: boolean) {
  const next = new Set(folded());
  if (folding) next.add(sectionId);
  else next.delete(sectionId);
  folds = next;
  try {
    if (next.size > 0) localStorage.setItem(FOLDED_SECTIONS_KEY, JSON.stringify([...next]));
    else localStorage.removeItem(FOLDED_SECTIONS_KEY);
  } catch {
    // Storage can be refused, and then sections stay folded in this tab only.
  }
  tell();
}

/** The sections this browser has folded, and what folds or unfolds one, in every sidebar and tab. */
export function useFoldedSections() {
  return { folded: useSyncExternalStore(subscribe, folded), fold };
}
