/**
 * The sessions the Workspace has used lately, by their token's digest, so most requests skip the
 * database. Only the Workspace changes sessions, so the cache stays current as long as everything
 * that ends one goes through `end`, everything that changes one through `change`, and everything
 * that reads one from the database through `get` or `keep`.
 */
export class SessionCache<Session> {
  /** Least recently used first, since a Map keeps insertion order. */
  private readonly sessions = new Map<string, Session>();
  /** Counts endings and changes, so a lookup that overlapped one isn't kept: on D1, queries interleave. */
  private endings = 0;
  /** How many endings and changes are under way. */
  private ending = 0;

  constructor(private readonly limit: number) {}

  /** The session `digest` names, from memory or else from `lookUp`, which is kept if it finds one. */
  async get(digest: string, lookUp: () => Promise<Session | null>): Promise<Session | null> {
    const cached = this.sessions.get(digest);
    if (cached) {
      this.remember(digest, cached);
      return cached;
    }
    return this.keep(digest, lookUp);
  }

  /** The session `read` reads for `digest`, such as one it starts, kept like a lookup in `get`. */
  async keep(digest: string, read: () => Promise<Session | null>): Promise<Session | null> {
    const endings = this.endings;
    const session = await read();
    // A session that ended or changed, or is ending or changing, during the read may have been read before it did.
    if (session && endings === this.endings && this.ending === 0) this.remember(digest, session);
    return session;
  }

  /** Keeps `session` as the most recently used, forgetting the least recently used past the limit. */
  remember(digest: string, session: Session): void {
    this.sessions.delete(digest);
    this.sessions.set(digest, session);
    if (this.sessions.size > this.limit) this.sessions.delete(this.sessions.keys().next().value!);
  }

  /**
   * Ends the session `digest` names with `end`, answering what it does. Forgets it first: on D1 the
   * session can be gone before `end` hears so, and a request in between mustn't find it here.
   */
  async end<T>(digest: string, end: () => Promise<T>): Promise<T> {
    this.sessions.delete(digest);
    return this.changing(end);
  }

  /**
   * Changes the sessions `affected` picks with `change`, such as by changing whom they sign in,
   * answering what it does. Forgets them first, as `end` does, so they're read again once it's done.
   */
  async change<T>(affected: (session: Session) => boolean, change: () => Promise<T>): Promise<T> {
    for (const [digest, session] of this.sessions) if (affected(session)) this.sessions.delete(digest);
    return this.changing(change);
  }

  /** Runs `change` to sessions, so that no lookup it overlaps is kept. */
  private async changing<T>(change: () => Promise<T>): Promise<T> {
    this.ending++;
    try {
      return await change();
    } finally {
      this.ending--;
      this.endings++;
    }
  }
}
