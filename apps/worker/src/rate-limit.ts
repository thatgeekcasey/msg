/**
 * Counts attempts by key in fixed windows that start with each key's first attempt, as Rails'
 * `rate_limit` does on a cache that sets an entry's expiry only when it's created. The sign-in limit is
 * one. Counts live in memory, so they start over when the object holding them does.
 */
export class FixedWindowLimit {
  private readonly windows = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Counts an attempt by `key` at `now`, answering whether it's within the limit. */
  attempt(key: string, now = Date.now()): boolean {
    // A Map keeps keys in the order they were added, which is the order their windows end in, so
    // the expired ones come first and pruning stops at the first that isn't.
    for (const [other, window] of this.windows) {
      if (window.expiresAt > now) break;
      this.windows.delete(other);
    }
    const window = this.windows.get(key) ?? { count: 0, expiresAt: now + this.windowMs };
    window.count++;
    this.windows.set(key, window);
    return window.count <= this.limit;
  }
}
