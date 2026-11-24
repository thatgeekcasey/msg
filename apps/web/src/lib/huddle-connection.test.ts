import type { UserId } from "@ember/protocol";
import type { CameraSizeName } from "@ember/protocol/huddles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKED_EVERY_MS, LARGER_AFTER_MS, LEAST_PACKETS, REPORT_COUNTS_MS, SMALLER_EVERY_MS, smallerOf, STEADY_AFTER, TROUBLE_AFTER_LARGER_MS, watchConnection } from "./huddle-connection";

/** The pair of addresses a connection goes by, which the browser says it chose, and one it didn't, whose round trips are slow. */
const pairsOf = (roundTrip: number) => [
  { type: "transport", id: "transport", timestamp: Date.now(), selectedCandidatePairId: "chosen" },
  { type: "candidate-pair", id: "chosen", timestamp: Date.now(), currentRoundTripTime: roundTrip },
  { type: "candidate-pair", id: "unchosen", timestamp: Date.now(), currentRoundTripTime: 3 },
];

/** Stands in for a connection, of which the browser gives the statistics `statsNow` has, unless it's `refusing`. */
abstract class Measured {
  roundTrip = 0.05;
  refusing = false;
  readonly connection = () => this as unknown as RTCPeerConnection;
  protected abstract statsNow(): Array<{ id: string }>;

  async getStats() {
    if (this.refusing) throw new DOMException("The connection is closed", "InvalidStateError");
    return new Map(this.statsNow().map((stat) => [stat.id, stat]));
  }
}

/** A connection that receives the others, each on a track `track-<their id>`. */
class Receiving extends Measured {
  readonly #counts = new Map<string, { lost: number; received: number }>();
  readonly whose = (trackId: string) => trackId.replace(/^track-/, "") as UserId;

  /** Receives `packets` of each person's that `lost` names, losing as much of them as it says. */
  receive(lost: Record<string, number>, packets = 100) {
    for (const [userId, fraction] of Object.entries(lost)) {
      const { lost: was, received } = this.#counts.get(userId) ?? { lost: 0, received: 0 };
      this.#counts.set(userId, { lost: was + Math.round(packets * fraction), received: received + Math.round(packets * (1 - fraction)) });
    }
  }

  protected statsNow() {
    const tracks = [...this.#counts].map(([userId, { lost, received }]) => ({ type: "inbound-rtp", id: `in-${userId}`, timestamp: Date.now(), trackIdentifier: `track-${userId}`, packetsLost: lost, packetsReceived: received }));
    return [...pairsOf(this.roundTrip), ...tracks];
  }
}

/** A connection that sends, of which the SFU reports how much it lost. */
class Sending extends Measured {
  #reports = 0;
  #lost = 0;

  /** The SFU reports that it lost `lost` of what the connection sent since its last report. */
  report(lost: number) {
    this.#reports++;
    this.#lost = lost;
  }

  protected statsNow() {
    const report = { type: "remote-inbound-rtp", id: "reported", timestamp: Date.now(), reportsReceived: this.#reports, fractionLost: this.#lost, roundTripTime: 0.05 };
    return [...pairsOf(this.roundTrip), ...(this.#reports > 0 ? [report] : [])];
  }
}

let receiving: Receiving;
let sending: Sending;
/** Everyone else in the huddle, and who of them say their own connection is unstable. */
let others: UserId[];
let troubled: UserId[];
let shown: CameraSizeName;
const judged = { unstable: vi.fn<(unstable: boolean) => void>(), capped: vi.fn<(cap: CameraSizeName | null) => void>() };
let stop: () => void;

/** Whether the tab was last told that its connection is unstable. */
const isUnstable = () => judged.unstable.mock.calls.at(-1)?.[0] ?? false;
/** The size it was last told to ask for cameras in at most. */
const cap = () => judged.capped.mock.calls.at(-1)?.[0] ?? null;

/** Lets `times` checks happen, before each of which `between` is done. */
async function check(times = 1, between = () => {}) {
  for (let done = 0; done < times; done++) {
    between();
    await vi.advanceTimersByTimeAsync(CHECKED_EVERY_MS);
  }
}

/** Has the tab receive Grace, Linus and Katherine, losing as much of each as `lost` says, and the rest whole. */
const receive = (lost: Partial<Record<"grace" | "linus" | "katherine", number>>) => () => receiving.receive({ grace: 0, linus: 0, katherine: 0, ...lost });

const inTheHuddle = () => others.map((id) => ({ user: { id }, ...(troubled.includes(id) && { unstable: true as const }) }));

beforeEach(() => {
  vi.useFakeTimers();
  receiving = new Receiving();
  sending = new Sending();
  others = ["grace" as UserId, "linus" as UserId, "katherine" as UserId];
  troubled = [];
  shown = "large";
  judged.unstable.mockClear();
  judged.capped.mockClear();
  stop = watchConnection({ receiving: [receiving], sending: [sending], others: inTheHuddle, shown: () => shown }, judged);
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("A tab's connection to the SFU", () => {
  it("is unstable once much is lost of what two people send in three of four checks, and steady again after five checks that lose little", async () => {
    // The first check has nothing to measure what's received from.
    await check(1, receive({}));
    await check(2, receive({ grace: 0.1, linus: 0.06 }));
    expect(isUnstable()).toBe(false);
    await check(1, receive({}));
    await check(1, receive({ grace: 0.2, linus: 0.05 }));
    expect(judged.unstable.mock.calls).toEqual([[true]]);

    await check(STEADY_AFTER - 1, receive({}));
    expect(isUnstable()).toBe(true);
    await check(1, receive({}));
    expect(judged.unstable.mock.calls).toEqual([[true], [false]]);
  });

  it("takes much lost of one person's but not the others' to be theirs, and of half of them to be its own", async () => {
    await check(6, receive({ grace: 0.3 }));
    expect(isUnstable()).toBe(false);

    // Three people, two of whom lose much: and of four, half.
    await check(3, receive({ grace: 0.3, linus: 0.3 }));
    expect(isUnstable()).toBe(true);
    others = [...others, "margaret" as UserId];
    await check(STEADY_AFTER, () => receiving.receive({ grace: 0, linus: 0, katherine: 0, margaret: 0 }));
    expect(isUnstable()).toBe(false);
    await check(3, () => receiving.receive({ grace: 0.3, linus: 0.3, katherine: 0, margaret: 0 }));
    expect(isUnstable()).toBe(true);
  });

  it("leaves out whoever says their own connection is unstable", async () => {
    troubled = ["grace" as UserId, "linus" as UserId];
    await check(6, receive({ grace: 0.3, linus: 0.3 }));
    expect(isUnstable()).toBe(false);
  });

  it("forgets what the checks before found lost once someone says their connection is unstable, which may have been theirs", async () => {
    others = ["grace" as UserId, "linus" as UserId];
    const both = () => receiving.receive({ grace: 0.3, linus: 0.3 });
    await check(3, both);
    // Grace says so first, and what's lost of Linus's alone would be the tab's, now he's the only other who doesn't.
    troubled = ["grace" as UserId];
    await check(2, both);
    troubled = ["grace" as UserId, "linus" as UserId];
    await check(6, both);
    expect(judged.unstable).not.toHaveBeenCalled();
  });

  it("takes much lost of what the one other there is sends to be its own trouble, unless they say it's theirs", async () => {
    others = ["grace" as UserId];
    await check(4, () => receiving.receive({ grace: 0.3 }));
    expect(isUnstable()).toBe(true);
    troubled = ["grace" as UserId];
    await check(STEADY_AFTER, () => receiving.receive({ grace: 0.3 }));
    expect(isUnstable()).toBe(false);

    // And of what Linus sends, once he's there too, while she still says so: he's the one other who doesn't.
    others = ["grace" as UserId, "linus" as UserId];
    await check(4, () => receiving.receive({ grace: 0.3, linus: 0.3 }));
    expect(isUnstable()).toBe(true);
  });

  it("doesn't take much lost of what one person sends to be its own trouble while there are others, who send too little to tell or nothing", async () => {
    await check(6, () => {
      receiving.receive({ grace: 0.3 });
      receiving.receive({ linus: 0 }, LEAST_PACKETS - 2);
    });
    expect(isUnstable()).toBe(false);

    // Until Grace is the only one left.
    others = ["grace" as UserId];
    await check(3, () => receiving.receive({ grace: 0.3 }));
    expect(isUnstable()).toBe(true);
  });

  it("counts only those it received enough packets of in a check to tell", async () => {
    await check(6, () => receiving.receive({ grace: 0.5, linus: 0.5, katherine: 0 }, LEAST_PACKETS - 2));
    expect(isUnstable()).toBe(false);
    await check(3, () => receiving.receive({ grace: 0.5, linus: 0.5, katherine: 0 }, LEAST_PACKETS));
    expect(isUnstable()).toBe(true);
  });

  it("is unstable once the SFU reports losing much of what it sends in two of three checks, each report counting a few seconds", async () => {
    sending.report(0.08);
    await check(1);
    expect(isUnstable()).toBe(false);
    // The same report, which still counts.
    await check(1);
    expect(isUnstable()).toBe(true);

    // Until it's older than that, steady again once five checks lose little.
    await check(REPORT_COUNTS_MS / CHECKED_EVERY_MS - 2);
    expect(isUnstable()).toBe(true);
    await check(STEADY_AFTER);
    expect(isUnstable()).toBe(false);
    // Reports of little lost aren't trouble.
    await check(6, () => sending.report(0.02));
    expect(judged.unstable.mock.calls).toEqual([[true], [false]]);
  });

  it("is unstable while round trips to the SFU take a second or more, by the pair of addresses the browser chose", async () => {
    sending.roundTrip = 0.9;
    receiving.roundTrip = 0.9;
    await check(6, receive({}));
    expect(isUnstable()).toBe(false);
    sending.roundTrip = 1;
    await check(2, receive({}));
    expect(isUnstable()).toBe(true);
    sending.roundTrip = 0.05;
    await check(STEADY_AFTER, receive({}));
    expect(isUnstable()).toBe(false);

    receiving.roundTrip = 1.5;
    await check(3, receive({}));
    expect(isUnstable()).toBe(true);
  });

  it("goes by the pair Firefox says it chose, which it says of the pair itself", async () => {
    const firefox = new (class extends Sending {
      protected override statsNow() {
        return [
          { type: "candidate-pair", id: "chosen", timestamp: Date.now(), selected: true, currentRoundTripTime: this.roundTrip },
          { type: "candidate-pair", id: "unchosen", timestamp: Date.now(), selected: false, currentRoundTripTime: 3 },
        ];
      }
    })();
    stop();
    stop = watchConnection({ receiving: [], sending: [firefox], others: () => [], shown: () => shown }, judged);
    await check(4);
    expect(isUnstable()).toBe(false);
    firefox.roundTrip = 2;
    await check(2);
    expect(isUnstable()).toBe(true);
  });

  it("measures nothing of a connection there isn't, or that the browser has no statistics of", async () => {
    receiving.refusing = true;
    sending.refusing = true;
    sending.report(0.5);
    await check(6, receive({ grace: 0.5, linus: 0.5 }));
    stop();
    stop = watchConnection({ receiving: [{ connection: () => null, whose: () => undefined }], sending: [{ connection: () => null }], others: () => [], shown: () => shown }, judged);
    await check(6);
    expect(judged.unstable).not.toHaveBeenCalled();
  });

  it("stops measuring once it's stopped", async () => {
    await check(2, receive({ grace: 0.5, linus: 0.5 }));
    stop();
    await check(6, receive({ grace: 0.5, linus: 0.5 }));
    expect(judged.unstable).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("The cameras a tab asks for", () => {
  /** Has what the tab receives struggle: three checks that lose much of two people's, after the first, which measures nothing. */
  const struggle = async () => {
    await check(1, receive({}));
    await check(3, receive({ grace: 0.3, linus: 0.3 }));
  };

  it("are a size smaller as soon as what it receives struggles, and smaller again every few seconds while it still loses much, down to the smallest", async () => {
    await struggle();
    expect(judged.capped.mock.calls).toEqual([["medium"]]);
    await check(SMALLER_EVERY_MS / CHECKED_EVERY_MS - 1, receive({ grace: 0.3, linus: 0.3 }));
    expect(cap()).toBe("medium");
    await check(1, receive({ grace: 0.3, linus: 0.3 }));
    expect(cap()).toBe("small");
    await check(10, receive({ grace: 0.3, linus: 0.3 }));
    expect(judged.capped.mock.calls).toEqual([["medium"], ["small"]]);
  });

  it("aren't any smaller while it struggles still but loses little, as it does on its way to steady", async () => {
    await struggle();
    await check(STEADY_AFTER - 1, receive({}));
    expect(isUnstable()).toBe(true);
    expect(judged.capped.mock.calls).toEqual([["medium"]]);
  });

  it("are a size smaller than its tiles show them, which they're never larger than", async () => {
    shown = "medium";
    await struggle();
    expect(cap()).toBe("small");
    await check(10, receive({ grace: 0.3, linus: 0.3 }));
    expect(judged.capped.mock.calls).toEqual([["small"]]);
  });

  it("are a size larger a while after it's steady again, and again after as long, back to what its tiles show", async () => {
    await struggle();
    await check(SMALLER_EVERY_MS / CHECKED_EVERY_MS, receive({ grace: 0.3, linus: 0.3 }));
    expect(cap()).toBe("small");
    await check(STEADY_AFTER, receive({}));
    expect(isUnstable()).toBe(false);

    await check(LARGER_AFTER_MS[0] / CHECKED_EVERY_MS - 1, receive({}));
    expect(cap()).toBe("small");
    await check(1, receive({}));
    expect(cap()).toBe("medium");
    await check(LARGER_AFTER_MS[0] / CHECKED_EVERY_MS, receive({}));
    expect(judged.capped.mock.calls).toEqual([["medium"], ["small"], ["medium"], [null]]);
  });

  it("wait twice as long for a size larger after one that brought trouble back soon after, up to a limit, and as long as at first after one that didn't", async () => {
    /** How many checks it takes, steady, for the cameras to be asked for a size larger. */
    const checksToLarger = async () => {
      const before = judged.capped.mock.calls.length;
      let checks = 0;
      while (judged.capped.mock.calls.length === before && checks < 100) {
        await check(1, receive({}));
        checks++;
      }
      return checks * CHECKED_EVERY_MS;
    };
    /** Has what the tab receives struggle again, and be steady again, which takes it a size smaller, a few seconds after it was a size larger. */
    const troubleAgain = async () => {
      await check(3, receive({ grace: 0.3, linus: 0.3 }));
      await check(STEADY_AFTER, receive({}));
    };

    await struggle();
    await check(STEADY_AFTER, receive({}));
    const waits = [await checksToLarger()];
    for (let again = 0; again < 4; again++) {
      await troubleAgain();
      waits.push(await checksToLarger());
    }
    expect(waits).toEqual([10_000, 20_000, 40_000, 80_000, LARGER_AFTER_MS[1]]);

    // Steady for long enough after the last that what comes next isn't its fault.
    await check(TROUBLE_AFTER_LARGER_MS / CHECKED_EVERY_MS, receive({}));
    await troubleAgain();
    expect(await checksToLarger()).toBe(LARGER_AFTER_MS[0]);
  });

  it("aren't asked for a size larger while that's larger than the tiles show, until they show larger", async () => {
    await struggle();
    shown = "small";
    await check(STEADY_AFTER + 20, receive({}));
    expect(judged.capped.mock.calls).toEqual([["medium"]]);
    shown = "large";
    await check(1, receive({}));
    expect(cap()).toBeNull();
  });
});

describe("The smaller of two sizes", () => {
  it("is the one that's smaller, and either where there's no cap", () => {
    expect(smallerOf("large", "medium")).toBe("medium");
    expect(smallerOf("small", "medium")).toBe("small");
    expect(smallerOf("medium", "medium")).toBe("medium");
    expect(smallerOf("medium", null)).toBe("medium");
  });
});
