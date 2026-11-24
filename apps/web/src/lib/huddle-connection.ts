import type { UserId } from "@ember/protocol";
import { CAMERA_SIZE_NAMES, type CameraSizeName } from "@ember/protocol/huddles";

// How a tab finds that its connection to the SFU is unstable, and what it does about it. Every couple of
// seconds it has the browser measure each of its connections (`getStats`): how much of what it receives
// of each person was lost on the way, how much of what it sends the SFU reports it lost, and how long a
// round trip to the SFU takes. A tab that loses too much, or waits a second or more on round trips, tells
// its person, and the room, which marks their tile for the others. While what it receives struggles, it
// asks for the others' cameras a size smaller, and once that has steadied, a size larger again, as the
// browser does of itself for what the tab sends.
//
// What's lost of someone's on its way to the SFU is lost to everyone who receives it, so what's lost of
// one person's says little of the tab's own connection. Their tab finds that what it sends struggles,
// sooner than the others' tabs find that what they receive does, and says so, and they're left out.
// What the tab receives struggles only when much is lost of what two people send at least, and of half of
// those it receives enough of to tell, or of what the one other there is sends. A picture that freezes
// isn't counted, since a busy computer freezes them as well.

/** How often the tab measures its connections. */
export const CHECKED_EVERY_MS = 2_000;
/** How much of what's sent can be lost on the way before it's too much. */
export const LOST_TOO_MUCH = 0.05;
/** The fewest packets of someone's a check counts for what's lost of theirs to say anything. */
export const LEAST_PACKETS = 40;
/** How long a round trip to the SFU takes, in seconds, when it's too slow. */
export const SLOW_ROUND_TRIP_S = 1;
/** How long what the SFU reports of what it lost of the tab's counts for, from when the report comes. */
export const REPORT_COUNTS_MS = 6_000;
/**
 * How many of the last few checks of what the tab sends, and of what it receives, find trouble for it to
 * struggle. What it receives takes longer, so that whoever's trouble it is has said so first.
 */
const SENDING = { troubled: 2, of: 3 };
const RECEIVING = { troubled: 3, of: 4 };
/** How many checks in a row find no trouble for what struggled to be steady again. */
export const STEADY_AFTER = 5;
/** How long the tab waits between asking for cameras a size smaller while what it receives struggles. */
export const SMALLER_EVERY_MS = 6_000;
/** How long it waits, steady again, to ask for them a size larger: twice as long each time the last size larger brought trouble back, up to the second. */
export const LARGER_AFTER_MS = [10_000, 80_000] as const;
/** How soon after the tab asked for cameras a size larger trouble that comes back is taken to be the larger size's. */
export const TROUBLE_AFTER_LARGER_MS = 30_000;

/** What a check reads of a connection's statistics, by the names WebRTC's give them. */
interface Stat {
  type: string;
  id: string;
  timestamp: number;
  trackIdentifier?: string;
  packetsLost?: number;
  packetsReceived?: number;
  fractionLost?: number;
  roundTripTime?: number;
  reportsReceived?: number;
  selectedCandidatePairId?: string;
  selected?: boolean;
  currentRoundTripTime?: number;
}

/** What a check finds of the packets of one person's, or of one track's. */
interface Count {
  lost: number;
  received: number;
}

/** A report of the SFU's of what it lost of a track the tab sends: what tells it from the next, and when the tab first saw it. */
interface Report {
  mark: number;
  seenAt: number;
}

/** One of the tab's connections that receive the others. */
export interface MeasuredReceiving {
  /** The connection there is now, if any. */
  connection(): RTCPeerConnection | null;
  /** Whose the track the connection receives by the id `trackId` is. */
  whose(trackId: string): UserId | undefined;
}

/** What the tab measures. */
export interface Measured {
  receiving: MeasuredReceiving[];
  sending: Array<{ connection(): RTCPeerConnection | null }>;
  /** Everyone else in the huddle, `unstable` while they say their own connection is. */
  others(): ReadonlyArray<{ user: { id: UserId }; unstable?: true }>;
  /** The size the tab's tiles show cameras in. */
  shown(): CameraSizeName;
}

/** What the tab is told of what it measures, as that changes. */
export interface Judged {
  /** Its connection is unstable now, or steady again. */
  unstable(unstable: boolean): void;
  /** The largest size it's to ask for cameras in, or null for whatever its tiles show them in. */
  capped(cap: CameraSizeName | null): void;
}

/** The smaller of the size `size` and `cap`, where null is no smaller than any. */
export const smallerOf = (size: CameraSizeName, cap: CameraSizeName | null): CameraSizeName =>
  cap === null ? size : CAMERA_SIZE_NAMES[Math.max(CAMERA_SIZE_NAMES.indexOf(size), CAMERA_SIZE_NAMES.indexOf(cap))]!;

/** The statistics the browser has of `connection`, or none where it has none to give. */
async function statsOf(connection: RTCPeerConnection): Promise<Stat[]> {
  try {
    const stats: Stat[] = [];
    (await connection.getStats()).forEach((stat: Stat) => stats.push(stat));
    return stats;
  } catch {
    return [];
  }
}

/** How long the round trips to the SFU take, in seconds, by the pair of addresses the connection goes by, or 0 where the browser hasn't said. */
function roundTripOf(stats: Stat[]): number {
  const chosen = new Set(stats.flatMap(({ type, selectedCandidatePairId }) => (type === "transport" && selectedCandidatePairId ? [selectedCandidatePairId] : [])));
  // Firefox says which pair it chose of the pair itself.
  const pairs = stats.filter((stat) => stat.type === "candidate-pair" && (chosen.has(stat.id) || stat.selected === true));
  return Math.max(0, ...pairs.map(({ currentRoundTripTime }) => currentRoundTripTime ?? 0));
}

const isTooMuch = ({ lost, received }: Count) => lost / (lost + received) >= LOST_TOO_MUCH;

/**
 * Whether a check finds trouble with what the tab receives, by what it lost of each person's, `received`,
 * and how long round trips took: much of what two people send, and of half of those it can tell of, or
 * of what the one other there is sends. Those in `troubled` say their connection is unstable, and are
 * left out, as their trouble is theirs; `untroubled` is how many others there are who don't, some of
 * whom may send too little to tell, or nothing.
 */
function isReceivingTroubled(received: Array<{ people: Map<UserId, Count>; roundTrip: number }>, troubled: ReadonlySet<UserId>, untroubled: number): boolean {
  if (received.some(({ roundTrip }) => roundTrip >= SLOW_ROUND_TRIP_S)) return true;
  const everyone = new Map<UserId, Count>();
  for (const [userId, { lost, received: got }] of received.flatMap(({ people }) => [...people])) {
    const theirs = everyone.get(userId) ?? { lost: 0, received: 0 };
    everyone.set(userId, { lost: theirs.lost + lost, received: theirs.received + got });
  }
  const counted = [...everyone].filter(([userId, { lost, received: got }]) => !troubled.has(userId) && lost + got >= LEAST_PACKETS).map(([, count]) => count);
  const lossy = counted.filter(isTooMuch).length;
  return lossy * 2 >= counted.length && (lossy >= 2 || (lossy === 1 && untroubled === 1));
}

/** Whether what a tab sends, or receives, struggles: once `troubled` of the last `of` checks find trouble, until `STEADY_AFTER` in a row find none. */
function struggles({ troubled, of }: { troubled: number; of: number }) {
  let last: boolean[] = [];
  let untroubled = 0;
  let struggling = false;
  return {
    check(found: boolean) {
      last = [...last, found].slice(-of);
      untroubled = found ? 0 : untroubled + 1;
      if (last.filter(Boolean).length >= troubled) struggling = true;
      else if (untroubled >= STEADY_AFTER) struggling = false;
      return struggling;
    },
    /** Forgets the trouble the last checks found, which was someone else's. */
    forget() {
      last = [];
    },
  };
}

/**
 * The largest size the tab asks for cameras in: a size smaller every `SMALLER_EVERY_MS` while what it
 * receives struggles and checks find trouble, and once it's steady, a size larger after a wait, which is
 * twice the last when trouble came back soon after the last size larger, and starts over when it didn't.
 * Null once it's back to the largest.
 */
function cameraCap() {
  let cap: CameraSizeName | null = null;
  let changedAt = -Infinity;
  let largerAt = -Infinity;
  let steadyAt = -Infinity;
  let wait: number = LARGER_AFTER_MS[0];
  let struggled = false;
  return (now: number, struggling: boolean, troubled: boolean, shown: CameraSizeName) => {
    if (struggling !== struggled) {
      if (!struggling) steadyAt = now;
      else wait = now - largerAt < TROUBLE_AFTER_LARGER_MS ? Math.min(wait * 2, LARGER_AFTER_MS[1]) : LARGER_AFTER_MS[0];
      struggled = struggling;
    }
    const asked = smallerOf(shown, cap);
    const smaller = CAMERA_SIZE_NAMES[CAMERA_SIZE_NAMES.indexOf(asked) + 1];
    if (struggling && troubled && smaller && now - changedAt >= SMALLER_EVERY_MS) {
      cap = smaller;
      changedAt = now;
    }
    // A size larger only while the cap keeps the tab from the size its tiles show.
    if (!struggling && cap !== null && asked !== shown && now - Math.max(changedAt, steadyAt) >= wait) {
      const larger = CAMERA_SIZE_NAMES[CAMERA_SIZE_NAMES.indexOf(cap) - 1]!;
      cap = larger === "large" ? null : larger;
      changedAt = largerAt = now;
    }
    return cap;
  };
}

/** Measures what `measured` has every `CHECKED_EVERY_MS`, and tells `judged` what it finds as that changes, until the function returned is called. */
export function watchConnection(measured: Measured, judged: Judged): () => void {
  /** What each connection had received of each track, by its statistics' id, at the last check. */
  const countedBefore = new WeakMap<RTCPeerConnection, Map<string, Count>>();
  /** And the SFU's reports of each track it sends. */
  const reportedBefore = new WeakMap<RTCPeerConnection, Map<string, Report>>();
  const receiving = struggles(RECEIVING);
  const sending = struggles(SENDING);
  const capOf = cameraCap();
  let troubledBefore = new Set<UserId>();
  let unstable = false;
  let cap: CameraSizeName | null = null;
  let checking = false;
  let stopped = false;

  /** What was lost of each person's on `connection` since the last check, of the tracks it had then, and how long round trips take. */
  async function receivedOn({ connection, whose }: MeasuredReceiving) {
    const on = connection();
    const people = new Map<UserId, Count>();
    if (!on) return { people, roundTrip: 0 };
    const stats = await statsOf(on);
    const before = countedBefore.get(on);
    const counted = new Map<string, Count>();
    for (const { type, id, trackIdentifier, packetsLost = 0, packetsReceived = 0 } of stats) {
      if (type !== "inbound-rtp") continue;
      counted.set(id, { lost: packetsLost, received: packetsReceived });
      const earlier = before?.get(id);
      const userId = trackIdentifier === undefined ? undefined : whose(trackIdentifier);
      if (!earlier || userId === undefined) continue;
      const theirs = people.get(userId) ?? { lost: 0, received: 0 };
      people.set(userId, { lost: theirs.lost + Math.max(0, packetsLost - earlier.lost), received: theirs.received + Math.max(0, packetsReceived - earlier.received) });
    }
    countedBefore.set(on, counted);
    return { people, roundTrip: roundTripOf(stats) };
  }

  /** Whether a check finds trouble with what `connection` sends: the SFU's latest reports say it lost too much of it, or round trips are too slow. */
  async function isSendingTroubled(connection: RTCPeerConnection | null, now: number): Promise<boolean> {
    if (!connection) return false;
    const stats = await statsOf(connection);
    const before = reportedBefore.get(connection);
    const reported = new Map<string, Report>();
    let roundTrip = roundTripOf(stats);
    let lost = 0;
    for (const { type, id, timestamp, reportsReceived, fractionLost = 0, roundTripTime = 0 } of stats) {
      if (type !== "remote-inbound-rtp") continue;
      const mark = reportsReceived ?? timestamp;
      const earlier = before?.get(id);
      const report = earlier?.mark === mark ? earlier : { mark, seenAt: now };
      reported.set(id, report);
      if (now - report.seenAt >= REPORT_COUNTS_MS) continue;
      lost = Math.max(lost, fractionLost);
      roundTrip = Math.max(roundTrip, roundTripTime);
    }
    reportedBefore.set(connection, reported);
    return lost >= LOST_TOO_MUCH || roundTrip >= SLOW_ROUND_TRIP_S;
  }

  async function check() {
    const now = Date.now();
    const others = measured.others();
    const troubled = new Set(others.flatMap(({ user, unstable }) => (unstable ? [user.id] : [])));
    // Someone who says now that their connection is unstable may be why so much of theirs was lost before they did.
    if ([...troubled].some((userId) => !troubledBefore.has(userId))) receiving.forget();
    troubledBefore = troubled;
    const [received, sent] = await Promise.all([Promise.all(measured.receiving.map(receivedOn)), Promise.all(measured.sending.map(({ connection }) => isSendingTroubled(connection(), now)))]);
    if (stopped) return;
    const receivingTroubled = isReceivingTroubled(received, troubled, others.length - troubled.size);
    const receivingStruggles = receiving.check(receivingTroubled);
    const sendingStruggles = sending.check(sent.includes(true));
    const isUnstable = receivingStruggles || sendingStruggles;
    if (isUnstable !== unstable) judged.unstable((unstable = isUnstable));
    const next = capOf(now, receivingStruggles, receivingTroubled, measured.shown());
    if (next !== cap) judged.capped((cap = next));
  }

  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void check().finally(() => (checking = false));
  }, CHECKED_EVERY_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
