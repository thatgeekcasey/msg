/**
 * The drafts put aside in a room, DM or thread, as Slack's Save as draft puts them aside, beside the one
 * being written there, which Manage drafts lists and opens again. They're kept in this browser under the
 * key of the draft they were put aside from, so each person's are apart, as that draft is.
 */
export interface SavedDraft {
  id: string;
  /** What was written, as the composer keeps it. */
  body: string;
  /** When it was put aside, in milliseconds since the epoch, which the newest are listed by. */
  savedAt: number;
}

const savedKey = (draftKey: string) => `${draftKey}/saved`;

/** Where storage is tried, to see whether this browser keeps drafts at all. */
const PROBE = "composer-drafts-probe";

const isSavedDraft = (value: unknown): value is SavedDraft => {
  const draft = value as Partial<SavedDraft> | null;
  return typeof draft === "object" && draft !== null && typeof draft.id === "string" && typeof draft.body === "string" && typeof draft.savedAt === "number";
};

/**
 * The drafts put aside from the draft kept under `draftKey`, newest first: none where storage is
 * unavailable, or what it holds doesn't read as drafts.
 */
export function readSavedDrafts(draftKey: string): SavedDraft[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(savedKey(draftKey)) ?? "[]");
    return Array.isArray(saved) ? saved.filter(isSavedDraft).sort((a, b) => b.savedAt - a.savedAt) : [];
  } catch {
    return [];
  }
}

/** Keeps `drafts` as those put aside from the draft kept under `draftKey`, and answers whether it could. */
export function keepSavedDrafts(draftKey: string, drafts: SavedDraft[]): boolean {
  try {
    if (drafts.length === 0) localStorage.removeItem(savedKey(draftKey));
    else localStorage.setItem(savedKey(draftKey), JSON.stringify(drafts));
    return true;
  } catch {
    return false;
  }
}

/** `body` as a draft put aside now. */
export const savedDraft = (body: string): SavedDraft => ({ id: crypto.randomUUID(), body, savedAt: Date.now() });

/**
 * Whether this browser can keep drafts: storage can be unavailable, as in some private windows. Storage
 * that's full still holds the drafts put aside, which opening one makes room for.
 */
export function keepsDrafts(): boolean {
  try {
    localStorage.setItem(PROBE, "");
    localStorage.removeItem(PROBE);
    return true;
  } catch (error) {
    return error instanceof DOMException && error.name === "QuotaExceededError";
  }
}
