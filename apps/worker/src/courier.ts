/** How many entries of one of its logs a room sends in one call, at most. */
export const ENTRIES_PER_CALL = 50;

/**
 * How long a courier waits after a call before the next, gathering the entries logged meanwhile, unless
 * the call was full or a full call's worth is logged sooner. So a busy room sends many in each call,
 * and makes at most four calls a second until they fill.
 */
const GATHER_MS = 250;

/** How long a courier waits to send its log again after a call fails, doubling each time up to the longest wait. */
const FIRST_RETRY_MS = 1_000;
const LONGEST_RETRY_MS = 5 * 60 * 1000;

/**
 * Sends one of a room's logs to whoever takes it. One call is out at a time, and the entries logged
 * meanwhile go in the next, a moment after it, or at once if the call left some behind or a full call's
 * worth comes first. A patient courier waits that moment before each call instead, the first included.
 * When a call fails, the next waits for the room's alarm, which tries again later, from the first entry
 * not taken.
 */
export class Courier {
  /**
   * Whether the courier has read its log since the room's object started. A restart in the middle of a
   * call, as a deploy can make, leaves the call's entries in the log with no alarm set to send them.
   */
  checked = false;
  /** The call out now, while there is one. */
  private delivering: Promise<void> | null = null;
  /** Whether the log has had entries since the call out now read it, so another call goes once it's done. */
  private undelivered = false;
  /** Roughly how many entries the next call has to send: those logged since the last call read the log, and those a full one may have left. */
  private logged = 0;
  /** Ends the wait for entries, while there is one, once a full call's worth is logged. */
  private stopGathering: (() => void) | null = null;
  /** How many calls in a row have failed, which puts the next try off longer. */
  private failures = 0;
  /** When the courier may call again after a call failed, which the room's alarm is set for. */
  private retryAt = 0;

  constructor(
    /** Sends the oldest entries of the log, as many as one call takes, and answers how many it sent. */
    private readonly send: () => Promise<number>,
    /** Sets the room's alarm to go off by a time, unless it's set for sooner, and answers whether it did. */
    private readonly wakeAt: (time: number) => Promise<boolean>,
    /** What the courier sends where, for the errors it logs. */
    private readonly errand: string,
    /**
     * Whether the log can be a moment behind, so that no call goes as soon as the room logs an entry,
     * when the room has other calls to make, and the entries logged just after go in the same call.
     */
    private readonly patient = false,
  ) {}

  /** Whether the courier's last call failed, so that it waits for the room's alarm to try again. */
  get failing(): boolean {
    return this.failures > 0;
  }

  /** Has the courier send what the room has logged, now or once the call out is done. */
  deliver(): void {
    this.undelivered = true;
    if (++this.logged >= ENTRIES_PER_CALL) this.stopGathering?.();
    if (this.delivering || Date.now() < this.retryAt) return;
    this.delivering = (this.patient ? this.gather().then(() => this.deliverBatch()) : this.deliverBatch().then(() => this.gather())).finally(() => {
      this.delivering = null;
      if (this.undelivered) this.deliver();
    });
  }

  /** Has the courier send the log now, however long ago a call failed, as the room's alarm does, and waits until it has. */
  async retry(): Promise<void> {
    this.retryAt = 0;
    this.deliver();
    await this.settled();
  }

  /** Waits until the courier has no call out, nor one to make once it's done. */
  async settled(): Promise<void> {
    while (this.delivering) await this.delivering;
  }

  /** Waits for the entries logged meanwhile, until a full call's worth is or `GATHER_MS` passes. */
  private async gather(): Promise<void> {
    if (this.logged >= ENTRIES_PER_CALL) return;
    await new Promise<void>((resolve) => {
      this.stopGathering = resolve;
      void scheduler.wait(GATHER_MS).then(resolve);
    });
    this.stopGathering = null;
  }

  /** Sends the oldest entries not taken, as many as one call takes. */
  private async deliverBatch(): Promise<void> {
    this.checked = true;
    this.undelivered = false;
    this.logged = 0;
    try {
      const sent = await this.send();
      this.failures = 0;
      if (sent < ENTRIES_PER_CALL) return;
      // A full call may have left as many behind, which go at once.
      this.undelivered = true;
      this.logged += ENTRIES_PER_CALL;
    } catch (error) {
      console.error(`Could not send ${this.errand}; trying again later`, error);
      this.failures++;
      await this.callLater().catch((error) => console.error("Could not set the alarm to send the log", error));
    }
  }

  /**
   * Has the room's alarm send the log a second after the first failure and twice as long after each one
   * since, up to the longest wait, and makes no calls until then, however much the room logs, unless the
   * room has no alarm for it, as a deleted room doesn't.
   */
  private async callLater(): Promise<void> {
    const at = Date.now() + Math.min(LONGEST_RETRY_MS, FIRST_RETRY_MS * 2 ** (this.failures - 1));
    if (await this.wakeAt(at)) this.retryAt = at;
  }
}
