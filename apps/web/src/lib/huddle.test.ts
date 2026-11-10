import { CloseCode, type User } from "@ember/protocol";
import { HuddleCloseCode, type HuddlePerson, type HuddleServerFrame, type OfferedHuddleTrack } from "@ember/protocol/huddles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_TIMEOUT_MS, joinHuddle, LISTEN_AGAIN_MS, PUBLISH_AGAIN_MS } from "./huddle";
import { hearHuddleEnd, joinedHuddle, leaveHuddle, muteHuddle, watchHuddle } from "./huddle-store";

/** Stands in for the browser's WebSocket; tests play the room and the network. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  /** What the tab has sent, but for its socket's pings. */
  sent: Array<Record<string, unknown>> = [];
  /** Whether the socket's pings go unanswered, as on a network that has dropped without closing it. */
  silent = false;
  closedWith: number | undefined;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  /** Answers a ping as the runtime does for the room, and keeps anything else for the test. */
  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame.type !== "ping") this.sent.push(frame);
    else if (!this.silent) this.receive({ type: "pong" });
  }

  close(code?: number) {
    this.closedWith = code ?? 1005;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code: this.closedWith }));
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(frame: HuddleServerFrame) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  /** Closes as the network or the room does: 1006 when the connection drops. */
  drop(code = 1006) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code }));
  }

  /** What the tab has sent since the test last asked. */
  take() {
    return this.sent.splice(0);
  }
}

/** Stands in for a microphone's track, or one a connection receives. */
class FakeTrack extends EventTarget {
  readonly kind = "audio";
  enabled = true;
  readyState: MediaStreamTrackState = "live";

  stop() {
    this.readyState = "ended";
  }

  /** Ends as an unplugged microphone's does. */
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[] = []) {}
  getTracks = () => this.tracks;
  getAudioTracks = () => this.tracks;
}

interface FakeTransceiver {
  mid: string | null;
  direction?: string;
  sender: { track: FakeTrack | null };
  receiver: { track: FakeTrack };
}

/**
 * Stands in for the browser's RTCPeerConnection. Its offers are numbered in the order connections make
 * them, and an offer made to it names the media sections it carries after a colon: `offer:0,1`.
 */
class FakeConnection {
  static all: FakeConnection[] = [];
  static offers = 0;
  /** What the next description set fails with, as a browser refuses one it can't make sense of. */
  static refusing = false;

  connectionState: RTCPeerConnectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  transceivers: FakeTransceiver[] = [];

  constructor(readonly configuration: RTCConfiguration) {
    FakeConnection.all.push(this);
  }

  addTransceiver(track: FakeTrack, { direction }: { direction: string }) {
    const transceiver: FakeTransceiver = { mid: null, direction, sender: { track }, receiver: { track: new FakeTrack() } };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers = () => this.transceivers;

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: `offer ${++FakeConnection.offers}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: `answer to ${this.remoteDescription!.sdp}` };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.refuseIfTold();
    this.localDescription = description;
    this.transceivers.forEach((transceiver, index) => (transceiver.mid ??= String(index)));
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.refuseIfTold();
    this.remoteDescription = description;
    if (description.type !== "offer") return;
    for (const mid of description.sdp!.split(":")[1]!.split(",")) {
      if (!this.transceivers.some((transceiver) => transceiver.mid === mid)) this.transceivers.push({ mid, sender: { track: null }, receiver: { track: new FakeTrack() } });
    }
  }

  close() {
    this.connectionState = "closed";
  }

  /** Changes the connection's state, as the browser does once it has connected, or can't. */
  becomes(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  private refuseIfTold() {
    if (!FakeConnection.refusing) return;
    FakeConnection.refusing = false;
    throw new DOMException("Failed to parse the session description", "InvalidAccessError");
  }
}

const ada: User = { id: "u1", name: "Ada" };
const grace: User = { id: "u2", name: "Grace" };
const linus: User = { id: "u3", name: "Linus" };
const person = (user: User, overrides: Partial<HuddlePerson> = {}): HuddlePerson => ({ user, muted: false, audio: true, ...overrides });
const STARTED_AT = "2026-11-10T09:00:00.000Z";

const socket = () => FakeSocket.all.at(-1)!;
const connection = () => FakeConnection.all.at(-1)!;
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** Once what a frame started has run as far as it goes without the room or the browser. */
const settled = () => wait(0);
const voices = () => [...document.querySelectorAll<HTMLAudioElement>("[data-huddle-voices] audio")];
const voiceOf = (user: User) => voices().find((audio) => audio.dataset.userId === user.id);
/** The track `audio` plays, as the stream it was given holds it. */
const playedBy = (audio: HTMLAudioElement | undefined) => (audio?.srcObject as unknown as FakeStream | null | undefined)?.tracks[0];

let microphone: FakeStream;
const microphoneTrack = () => microphone.tracks[0]!;

/** Joins general's huddle, which the room lets the tab into with `people` in it besides Ada, who the tab is. */
async function joined(people: HuddlePerson[] = [], join: Partial<Parameters<typeof joinHuddle>[0]> = {}) {
  joinHuddle({ roomId: "general", muted: false, microphone: microphone as unknown as MediaStream, speakerId: "", ...join });
  socket().open();
  return welcomed(people);
}

/** The room lets the newest socket in, to a huddle with `people` in it besides Ada. */
async function welcomed(people: HuddlePerson[] = [], mine: Partial<HuddlePerson> = {}) {
  socket().receive({ type: "huddle.welcome", you: ada, people: [...people, person(ada, { audio: false, muted: joinedHuddle()!.muted, ...mine })], startedAt: STARTED_AT });
  await settled();
  return socket();
}

/** The room's offer of `tracks`, as the SFU makes it. */
const offer = (...tracks: Array<[mid: string, user: User]>): HuddleServerFrame => ({
  type: "huddle.offer",
  sdp: `offer:${tracks.map(([mid]) => mid).join(",")}`,
  tracks: tracks.map(([mid, user]): OfferedHuddleTrack => ({ mid, kind: "audio", userId: user.id })),
});

/** The tab's sending connection has its answer and has connected, which it tells the room. */
async function publishedAndConnected() {
  const sending = connection();
  socket().receive({ type: "huddle.published", sdp: "the SFU's answer" });
  await settled();
  sending.becomes("connected");
  return sending;
}

/** A round in which the room offers `tracks`, the tab answers, and the room says it's listening. */
async function offeredRound(...tracks: Array<[mid: string, user: User]>) {
  socket().receive(offer(...tracks));
  await settled();
  socket().receive({ type: "huddle.listening" });
  await settled();
}

beforeEach(() => {
  FakeSocket.all = [];
  FakeConnection.all = [];
  FakeConnection.offers = 0;
  FakeConnection.refusing = false;
  microphone = new FakeStream([new FakeTrack()]);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("RTCPeerConnection", FakeConnection);
  vi.stubGlobal("MediaStream", FakeStream);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter: back-off delays come out exact
});

afterEach(() => {
  leaveHuddle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Joining a huddle", () => {
  it("connects to the room's huddle, and shows it as joining until the room lets the tab in", async () => {
    const shown = vi.fn();
    const stop = watchHuddle(shown);
    joinHuddle({ roomId: "general", muted: false, microphone: microphone as unknown as MediaStream, speakerId: "" });

    expect(socket().url).toBe("ws://localhost:3000/api/rooms/general/huddle");
    expect(joinedHuddle()).toEqual({ roomId: "general", connected: false, you: null, people: [], muted: false, microphone: true });
    expect(shown).toHaveBeenCalledTimes(1);
    // Nothing is asked of the room before it has said who the tab is.
    socket().open();
    await settled();
    expect(socket().sent).toEqual([]);
    expect(FakeConnection.all).toEqual([]);

    await welcomed([person(grace)]);
    expect(joinedHuddle()).toEqual({ roomId: "general", connected: true, you: ada, people: [person(grace), person(ada, { audio: false })], muted: false, microphone: true });
    stop();
  });

  it("says in the address that the tab joins muted, and keeps its microphone off", async () => {
    joinHuddle({ roomId: "team/ops", muted: true, microphone: microphone as unknown as MediaStream, speakerId: "" });
    expect(socket().url).toBe("ws://localhost:3000/api/rooms/team%2Fops/huddle?muted=1");
    expect(microphoneTrack().enabled).toBe(false);
    expect(joinedHuddle()).toMatchObject({ muted: true, microphone: true });
  });

  it("joins listening only without a microphone: muted, publishing nothing, with nothing to unmute", async () => {
    const room = await joined([person(grace)], { microphone: null });
    expect(room.url).toBe("ws://localhost:3000/api/rooms/general/huddle?muted=1");
    expect(joinedHuddle()).toMatchObject({ muted: true, microphone: false });
    expect(room.take()).toEqual([{ type: "huddle.listen", fresh: true }]);

    muteHuddle(false);
    expect(joinedHuddle()).toMatchObject({ muted: true });
    expect(room.take()).toEqual([]);
  });

  it("leaves the huddle the tab was in as it joins another", async () => {
    const first = await joined();
    joinHuddle({ roomId: "random", muted: false, microphone: new FakeStream([new FakeTrack()]) as unknown as MediaStream, speakerId: "" });

    expect(first.closedWith).toBe(1000);
    expect(microphoneTrack().readyState).toBe("ended");
    expect(socket().url).toBe("ws://localhost:3000/api/rooms/random/huddle");
    expect(joinedHuddle()).toMatchObject({ roomId: "random", connected: false });
  });
});

describe("A huddle's microphone", () => {
  it("is published from a connection of its own once the room lets the tab in, which tells the room when it has connected", async () => {
    const room = await joined();
    const sending = connection();
    expect(sending.configuration).toEqual({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
    expect(sending.transceivers).toEqual([expect.objectContaining({ direction: "sendonly", sender: { track: microphoneTrack() } })]);
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 1", tracks: [{ mid: "0", kind: "audio" }] }]);

    room.receive({ type: "huddle.published", sdp: "the SFU's answer" });
    await settled();
    expect(sending.remoteDescription).toEqual({ type: "answer", sdp: "the SFU's answer" });
    expect(room.take()).toEqual([]);
    sending.becomes("connecting");
    expect(room.take()).toEqual([]);
    sending.becomes("connected");
    expect(room.take()).toEqual([{ type: "huddle.connected" }]);
  });

  it("is published again, a little later each time, after its connection fails or the room couldn't publish it", async () => {
    const room = await joined();
    const first = await publishedAndConnected();
    room.take();

    first.becomes("failed");
    expect(first.connectionState).toBe("closed");
    await wait(PUBLISH_AGAIN_MS[0] - 1);
    expect(room.take()).toEqual([]);
    await wait(1);
    expect(room.take()).toEqual([{ type: "huddle.publish", sdp: "offer 2", tracks: [{ mid: "0", kind: "audio" }] }]);
    expect(connection()).not.toBe(first);

    // The room couldn't: the SFU refused, or couldn't be reached.
    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.publish" });
    await wait(PUBLISH_AGAIN_MS[0] * 2 - 1);
    expect(room.take()).toEqual([]);
    await wait(1);
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish", sdp: "offer 3" })]);

    // Nor could the browser make sense of the SFU's answer.
    FakeConnection.refusing = true;
    room.receive({ type: "huddle.published", sdp: "not a session description" });
    await wait(PUBLISH_AGAIN_MS[0] * 4);
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish", sdp: "offer 4" })]);

    // Once one has connected, the next wait is the first again.
    (await publishedAndConnected()).becomes("failed");
    room.take();
    await wait(PUBLISH_AGAIN_MS[0]);
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish", sdp: "offer 5" })]);
  });

  it("waits no longer than the longest wait between tries", async () => {
    const room = await joined();
    for (let tries = 0; tries < 6; tries++) {
      room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.publish" });
      await wait(PUBLISH_AGAIN_MS[1]);
    }
    room.take();
    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.publish" });
    await wait(PUBLISH_AGAIN_MS[1] - 1);
    expect(room.take()).toEqual([]);
    await wait(1);
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish" })]);
  });

  it("is published again at once when the room says the SFU has lost it, unless the tab is waiting on an answer already", async () => {
    const room = await joined();
    const first = await publishedAndConnected();
    room.take();

    room.receive({ type: "huddle.unpublished" });
    await settled();
    expect(first.connectionState).toBe("closed");
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish", sdp: "offer 2" })]);

    // The answer on its way is to the offer just made, which a third would take for its own.
    room.receive({ type: "huddle.unpublished" });
    await settled();
    expect(room.take()).toEqual([]);
    expect(FakeConnection.all).toHaveLength(2);
    room.receive({ type: "huddle.published", sdp: "the SFU's answer" });
    await settled();
    expect(connection().remoteDescription).toEqual({ type: "answer", sdp: "the SFU's answer" });
  });

  it("takes no answer it isn't waiting on", async () => {
    const room = await joined();
    await publishedAndConnected();
    room.receive({ type: "huddle.published", sdp: "another answer" });
    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed: "huddle.publish" });
    await wait(PUBLISH_AGAIN_MS[1]);
    expect(connection().remoteDescription).toEqual({ type: "answer", sdp: "the SFU's answer" });
    expect(FakeConnection.all).toHaveLength(1);
  });

  it("mutes and unmutes: the track, the room, and the tab's own person among the huddle's", async () => {
    const room = await joined([person(grace)]);
    room.take();

    muteHuddle(true);
    expect(microphoneTrack().enabled).toBe(false);
    expect(room.take()).toEqual([{ type: "huddle.mute", muted: true }]);
    expect(joinedHuddle()).toMatchObject({ muted: true, people: [person(grace), person(ada, { audio: false, muted: true })] });
    // Muting again says nothing.
    muteHuddle(true);
    expect(room.take()).toEqual([]);

    muteHuddle(false);
    expect(microphoneTrack().enabled).toBe(true);
    expect(room.take()).toEqual([{ type: "huddle.mute", muted: false }]);
    expect(joinedHuddle()).toMatchObject({ muted: false, people: [person(grace), person(ada, { audio: false })] });
  });

  it("leaves its person listening once it's unplugged, or the browser takes it away", async () => {
    const room = await joined();
    room.take();

    microphoneTrack().end();
    expect(room.take()).toEqual([{ type: "huddle.mute", muted: true }]);
    expect(joinedHuddle()).toMatchObject({ muted: true, microphone: false });
    muteHuddle(false);
    expect(joinedHuddle()).toMatchObject({ muted: true });
    // And nothing more is published of it.
    room.receive({ type: "huddle.unpublished" });
    await settled();
    expect(room.take()).toEqual([]);
  });
});

describe("Hearing the others in a huddle", () => {
  it("asks for whoever can be listened to, answers the SFU's offer, and plays each person's track", async () => {
    const room = await joined([person(grace), person(linus, { audio: false })]);
    expect(room.take()).toEqual([{ type: "huddle.listen", fresh: true }, expect.objectContaining({ type: "huddle.publish" })]);
    expect(FakeConnection.all).toHaveLength(1);

    room.receive(offer(["0", grace]));
    await settled();
    const receiving = connection();
    expect(FakeConnection.all).toHaveLength(2);
    expect(receiving.configuration).toEqual({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" });
    expect(receiving.remoteDescription).toEqual({ type: "offer", sdp: "offer:0" });
    expect(room.take()).toEqual([{ type: "huddle.answer", sdp: "answer to offer:0" }]);
    expect(voices()).toHaveLength(1);
    expect(playedBy(voiceOf(grace))).toBe(receiving.transceivers[0]!.receiver.track);
    expect(voiceOf(grace)!.autoplay).toBe(true);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    // Kept in the page, where nobody sees them.
    expect(document.querySelector<HTMLElement>("[data-huddle-voices]")!.hidden).toBe(true);
  });

  it("asks once more after a round that brought an offer, for whoever it left out, on the same connection", async () => {
    const room = await joined([person(grace), person(linus)]);
    room.take();
    room.receive(offer(["0", grace]));
    await settled();
    room.take();

    room.receive({ type: "huddle.listening" });
    expect(room.take()).toEqual([{ type: "huddle.listen" }]);
    room.receive(offer(["0", grace], ["1", linus]));
    await settled();
    expect(FakeConnection.all).toHaveLength(2);
    expect(room.take()).toEqual([{ type: "huddle.answer", sdp: "answer to offer:0,1" }]);
    expect(playedBy(voiceOf(linus))).toBe(connection().transceivers[1]!.receiver.track);

    // And once more, since someone may have published anew while that offer was made.
    room.receive({ type: "huddle.listening" });
    expect(room.take()).toEqual([{ type: "huddle.listen" }]);
    // A round that brings nobody is the last, with everyone heard.
    room.receive({ type: "huddle.listening" });
    await wait(LISTEN_AGAIN_MS[1] * 2);
    expect(room.take()).toEqual([]);
  });

  it("asks again in a while for someone the SFU couldn't offer yet, a little longer each time", async () => {
    const room = await joined([person(grace)]);
    room.take();

    for (const expected of [500, 1_000, 2_000, 4_000, 8_000, 8_000]) {
      room.receive({ type: "huddle.listening" });
      await wait(expected - 1);
      expect(room.take()).toEqual([]);
      await wait(1);
      expect(room.take()).toEqual([{ type: "huddle.listen", fresh: true }]);
    }
    expect([LISTEN_AGAIN_MS[0], LISTEN_AGAIN_MS[1]]).toEqual([500, 8_000]);

    // An offer starts the wait over.
    await offeredRound(["0", grace]);
    room.receive({ type: "huddle.joined", person: person(linus) });
    room.take();
    room.receive({ type: "huddle.listening" });
    room.receive({ type: "huddle.listening" });
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen" }]);
  });

  it("asks for someone as they join or become someone to listen to, and for nobody while a round is under way", async () => {
    const room = await joined();
    expect(room.take()).toEqual([expect.objectContaining({ type: "huddle.publish" })]);

    // Grace has joined, and her microphone isn't connected yet.
    room.receive({ type: "huddle.joined", person: person(grace, { audio: false }) });
    expect(joinedHuddle()!.people).toEqual([person(ada, { audio: false }), person(grace, { audio: false })]);
    expect(room.take()).toEqual([]);
    room.receive({ type: "huddle.changed", person: person(grace) });
    expect(joinedHuddle()!.people).toEqual([person(ada, { audio: false }), person(grace)]);
    expect(room.take()).toEqual([{ type: "huddle.listen", fresh: true }]);

    // Linus can be listened to before the room has answered: the tab asks once it has.
    room.receive({ type: "huddle.joined", person: person(linus) });
    expect(room.take()).toEqual([]);
    await offeredRound(["0", grace]);
    expect(room.take()).toEqual([{ type: "huddle.answer", sdp: "answer to offer:0" }, { type: "huddle.listen" }]);

    // Someone muting is nobody new.
    await offeredRound(["0", grace], ["1", linus]);
    room.receive({ type: "huddle.listening" });
    room.take();
    room.receive({ type: "huddle.changed", person: person(grace, { muted: true }) });
    expect(joinedHuddle()!.people).toEqual([person(ada, { audio: false }), person(grace, { muted: true }), person(linus)]);
    expect(room.take()).toEqual([]);
    expect(voices()).toHaveLength(2);
  });

  it("stops playing someone who leaves, and someone publishing anew, whose next track it asks for", async () => {
    const room = await joined([person(grace), person(linus)]);
    await offeredRound(["0", grace], ["1", linus]);
    room.receive({ type: "huddle.listening" });
    room.take();

    room.receive({ type: "huddle.left", userId: linus.id });
    expect(joinedHuddle()!.people).toEqual([person(grace), person(ada, { audio: false })]);
    expect(voices().map((audio) => audio.dataset.userId)).toEqual([grace.id]);
    expect(room.take()).toEqual([]);

    // Grace's connection failed, or she joined from another tab: nothing comes of what the tab heard of her.
    const graces = voiceOf(grace)!;
    room.receive({ type: "huddle.changed", person: person(grace, { audio: false }) });
    expect(voices()).toEqual([]);
    expect(graces.srcObject).toBeNull();
    expect(room.take()).toEqual([]);
    room.receive({ type: "huddle.changed", person: person(grace) });
    expect(room.take()).toEqual([{ type: "huddle.listen" }]);
    await offeredRound(["2", grace]);
    expect(playedBy(voiceOf(grace))).toBe(connection().transceivers[2]!.receiver.track);
  });

  it("plays no track of someone who left while it was on its way, nor of someone who can't be listened to for the moment", async () => {
    const room = await joined([person(grace), person(linus)]);
    room.take();
    room.receive({ type: "huddle.left", userId: grace.id });
    room.receive({ type: "huddle.changed", person: person(linus, { audio: false }) });
    room.receive(offer(["0", grace], ["1", linus]));
    await settled();
    expect(voices()).toEqual([]);
    // The connection answers all the same, as the SFU waits for it to.
    expect(room.take()).toEqual([{ type: "huddle.answer", sdp: "answer to offer:0,1" }]);

    // Linus isn't heard yet, so he's asked for once he can be: the round after the offer's, or a later one.
    room.receive({ type: "huddle.listening" });
    expect(room.take()).toEqual([{ type: "huddle.listen" }]);
    room.receive({ type: "huddle.changed", person: person(linus) });
    room.receive({ type: "huddle.listening" });
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen" }]);
    await offeredRound(["2", linus]);
    expect(voices().map((audio) => audio.dataset.userId)).toEqual([linus.id]);
  });

  it("plays no track of someone who began publishing anew as the connection took the offer of it, and asks for what they publish now", async () => {
    const room = await joined([person(grace)]);
    room.take();
    room.receive(offer(["0", grace]));
    // Her connection failed, and she can be listened to again, before the tab's has taken the offer of what she published first.
    room.receive({ type: "huddle.changed", person: person(grace, { audio: false }) });
    room.receive({ type: "huddle.changed", person: person(grace) });
    await settled();
    expect(voices()).toEqual([]);
    expect(room.take()).toEqual([{ type: "huddle.answer", sdp: "answer to offer:0" }]);

    // The round after the offer's can't bring her yet, and the tab doesn't take her for heard: it asks again in a while.
    room.receive({ type: "huddle.listening" });
    expect(room.take()).toEqual([{ type: "huddle.listen" }]);
    room.receive({ type: "huddle.listening" });
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen" }]);
    await offeredRound(["1", grace]);
    expect(playedBy(voiceOf(grace))).toBe(connection().transceivers[1]!.receiver.track);
  });

  it("starts a fresh connection, in a while, when its receiving connection fails", async () => {
    const room = await joined([person(grace)]);
    await offeredRound(["0", grace]);
    room.receive({ type: "huddle.listening" });
    room.take();
    const receiving = connection();

    receiving.becomes("failed");
    expect(receiving.connectionState).toBe("closed");
    expect(voices()).toEqual([]);
    await wait(LISTEN_AGAIN_MS[0] - 1);
    expect(room.take()).toEqual([]);
    await wait(1);
    expect(room.take()).toEqual([{ type: "huddle.listen", fresh: true }]);
    await offeredRound(["0", grace]);
    expect(connection()).not.toBe(receiving);
    expect(playedBy(voiceOf(grace))).toBe(connection().transceivers[0]!.receiver.track);
  });

  it.each(["huddle.listen", "huddle.answer"] as const)("starts a fresh connection when the room couldn't do what a %s asked, having let go of the one it had", async (failed) => {
    const room = await joined([person(grace), person(linus)]);
    await offeredRound(["0", grace]);
    room.take();
    const receiving = connection();

    room.receive({ type: "error", message: "The huddle couldn't connect. Trying again.", failed });
    expect(receiving.connectionState).toBe("closed");
    expect(voices()).toEqual([]);
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen", fresh: true }]);
    await offeredRound(["0", grace], ["1", linus]);
    expect(voices()).toHaveLength(2);
  });

  it("starts a fresh connection when the browser can't answer the SFU's offer, which the room is left waiting on", async () => {
    const room = await joined([person(grace)]);
    room.take();
    FakeConnection.refusing = true;
    room.receive(offer(["0", grace]));
    await settled();
    const refused = connection();
    expect(refused.connectionState).toBe("closed");
    expect(room.take()).toEqual([]);

    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen", fresh: true }]);
    await offeredRound(["0", grace]);
    expect(connection()).not.toBe(refused);
    expect(voices()).toHaveLength(1);
  });

  it("starts a fresh connection when the one it has fails as it answers an offer", async () => {
    const room = await joined([person(grace)]);
    room.take();
    room.receive(offer(["0", grace]));
    const failing = connection();
    failing.becomes("failed");
    await settled();
    expect(failing.connectionState).toBe("closed");
    expect(voices()).toEqual([]);
    expect(room.take()).toEqual([]);
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen", fresh: true }]);
  });

  it("waits for the round under way to end before it asks for a fresh connection, and drops what the round offers the one it gave up", async () => {
    const room = await joined([person(grace), person(linus)]);
    await offeredRound(["0", grace]);
    expect(room.take().at(-1)).toEqual({ type: "huddle.listen" });
    const receiving = connection();

    // The round asked on this connection is still to be answered when it fails.
    receiving.becomes("failed");
    await wait(LISTEN_AGAIN_MS[1]);
    expect(room.take()).toEqual([]);
    room.receive(offer(["0", grace], ["1", linus]));
    await settled();
    expect(connection()).toBe(receiving);
    expect(voices()).toEqual([]);
    expect(room.take()).toEqual([]);
    await wait(LISTEN_AGAIN_MS[0]);
    expect(room.take()).toEqual([{ type: "huddle.listen", fresh: true }]);

    await offeredRound(["0", grace], ["1", linus]);
    expect(connection()).not.toBe(receiving);
    expect(voices()).toHaveLength(2);
  });

  it("plays through the speaker the preview left chosen, where the browser can choose one", async () => {
    const setSinkId = vi.fn(async () => {});
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: setSinkId });
    try {
      const room = await joined([person(grace)], { speakerId: "headphones" });
      room.receive(offer(["0", grace]));
      await settled();
      expect(setSinkId).toHaveBeenCalledExactlyOnceWith("headphones");
      expect(setSinkId.mock.contexts[0]).toBe(voiceOf(grace));
    } finally {
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    }
  });

  it("plays through the system's speaker for as long as the one chosen is unplugged, which would play nothing", async () => {
    const setSinkId = vi.fn(async () => {});
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: setSinkId });
    const speakers = (...ids: string[]) => ids.map((deviceId) => ({ kind: "audiooutput", deviceId }));
    const enumerateDevices = vi.fn(async () => speakers("default", "headphones"));
    const media = Object.assign(new EventTarget(), { enumerateDevices });
    vi.stubGlobal("navigator", { mediaDevices: media });
    const changes = async (to: ReturnType<typeof speakers>) => {
      setSinkId.mockClear();
      enumerateDevices.mockResolvedValue(to);
      media.dispatchEvent(new Event("devicechange"));
      await settled();
    };
    try {
      const room = await joined([person(grace), person(linus)], { speakerId: "headphones" });
      room.receive(offer(["0", grace]));
      await settled();

      // Something else is plugged in, and the voices stay where they play.
      await changes(speakers("default", "headphones", "monitor"));
      expect(setSinkId.mock.calls).toEqual([["headphones"]]);

      await changes(speakers("default", "monitor"));
      expect(setSinkId).toHaveBeenCalledExactlyOnceWith("");
      expect(setSinkId.mock.contexts[0]).toBe(voiceOf(grace));
      // Whoever is offered meanwhile plays there too, as an `<audio>` does until it's told otherwise.
      setSinkId.mockClear();
      await offeredRound(["1", linus]);
      expect(setSinkId).not.toHaveBeenCalled();

      await changes(speakers("default", "monitor", "headphones"));
      expect(setSinkId.mock.calls).toEqual([["headphones"], ["headphones"]]);
      expect(setSinkId.mock.contexts).toEqual([voiceOf(grace), voiceOf(linus)]);

      // Out of the huddle, it has stopped asking.
      leaveHuddle();
      enumerateDevices.mockClear();
      media.dispatchEvent(new Event("devicechange"));
      expect(enumerateDevices).not.toHaveBeenCalled();
    } finally {
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
    }
  });

  it("asks nothing of the browser's speakers when it plays through the system's", async () => {
    const enumerateDevices = vi.fn(async () => []);
    const media = Object.assign(new EventTarget(), { enumerateDevices });
    vi.stubGlobal("navigator", { mediaDevices: media });
    await joined([person(grace)]);
    media.dispatchEvent(new Event("devicechange"));
    await settled();
    expect(enumerateDevices).not.toHaveBeenCalled();
  });

  it("plays at the person's next click or key, in a browser that won't until they've touched the page", async () => {
    const started = new WeakSet<HTMLMediaElement>();
    let refusing = true;
    const play = vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(async function (this: HTMLMediaElement) {
      if (refusing) throw new DOMException("play() failed", "NotAllowedError");
      started.add(this);
    });
    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) {
      return !started.has(this);
    });
    const room = await joined([person(grace), person(linus)]);
    room.receive(offer(["0", grace]));
    await settled();
    expect(play).toHaveBeenCalledTimes(1);

    // A finger landing isn't yet a touch to the browser, which would refuse again.
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(play).toHaveBeenCalledTimes(1);
    // A key the browser doesn't count leaves the next touch to try.
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settled();
    expect(play).toHaveBeenCalledTimes(2);

    // A click plays it, even one that what was clicked keeps to itself.
    refusing = false;
    const button = document.body.appendChild(document.createElement("button"));
    button.addEventListener("click", (event) => event.stopPropagation());
    button.click();
    button.remove();
    expect(play).toHaveBeenCalledTimes(3);
    expect(play.mock.contexts[2]).toBe(voiceOf(grace));

    // Whoever plays is left playing, and whoever the browser refuses next waits for the next touch.
    refusing = true;
    await offeredRound(["1", linus]);
    expect(play).toHaveBeenCalledTimes(4);
    refusing = false;
    document.body.click();
    expect(play).toHaveBeenCalledTimes(5);
    expect(play.mock.contexts[4]).toBe(voiceOf(linus));
    document.body.click();
    expect(play).toHaveBeenCalledTimes(5);
  });
});

describe("A huddle whose socket closes", () => {
  it("shows that it's reconnecting, closes both connections, and starts them again once the room lets it back in", async () => {
    const room = await joined([person(grace)]);
    const sending = await publishedAndConnected();
    await offeredRound(["0", grace]);
    const receiving = connection();
    muteHuddle(true);

    room.drop();
    expect(joinedHuddle()).toMatchObject({ connected: false, people: [person(grace), person(ada, { audio: false, muted: true })] });
    expect([sending.connectionState, receiving.connectionState]).toEqual(["closed", "closed"]);
    expect(voices()).toEqual([]);

    await wait(500);
    expect(FakeSocket.all).toHaveLength(2);
    // The address says how the tab is muted now.
    expect(socket().url).toBe("ws://localhost:3000/api/rooms/general/huddle?muted=1");
    socket().open();
    await welcomed([person(grace), person(linus)]);
    expect(joinedHuddle()).toMatchObject({ connected: true, muted: true, people: [person(grace), person(linus), person(ada, { audio: false, muted: true })] });
    expect(socket().take()).toEqual([{ type: "huddle.listen", fresh: true }, expect.objectContaining({ type: "huddle.publish", sdp: "offer 2" })]);
    expect(FakeConnection.all).toHaveLength(3);
  });

  it("tells the room how it's muted when that changed while it connected", async () => {
    const room = await joined();
    room.drop();
    await wait(500);
    muteHuddle(true);
    socket().open();
    await welcomed([], { muted: false });
    expect(socket().take()[0]).toEqual({ type: "huddle.mute", muted: true });
  });

  it("connects again without a close, when the socket stops answering", async () => {
    const room = await joined([person(grace)]);
    const sending = await publishedAndConnected();
    await offeredRound(["0", grace]);
    room.receive({ type: "huddle.listening" });
    // Two heartbeats with nothing heard between them.
    room.silent = true;
    await wait(25_000);
    expect(joinedHuddle()).toMatchObject({ connected: true });
    await wait(25_000);
    expect(room.closedWith).toBe(1005);
    expect(joinedHuddle()).toMatchObject({ connected: false });
    expect([sending.connectionState, connection().connectionState]).toEqual(["closed", "closed"]);
    expect(voices()).toEqual([]);
  });

  it.each([
    ["a publish", 0],
    ["a round of listening", 1],
  ])("joins again on a new socket when the room leaves %s unanswered", async (_, people) => {
    const room = await joined(people ? [person(grace)] : []);
    if (people) room.receive({ type: "huddle.published", sdp: "the SFU's answer" });
    await wait(ANSWER_TIMEOUT_MS - 1);
    expect(room.closedWith).toBeUndefined();
    expect(joinedHuddle()).toMatchObject({ connected: true });

    await wait(1);
    expect(room.closedWith).toBe(1000);
    expect(joinedHuddle()).toMatchObject({ connected: false });
    for (const each of FakeConnection.all) expect(each.connectionState).toBe("closed");
    await wait(500);
    expect(FakeSocket.all).toHaveLength(2);
    socket().open();
    await welcomed(people ? [person(grace)] : []);
    expect(socket().take()).toEqual([...(people ? [{ type: "huddle.listen", fresh: true }] : []), expect.objectContaining({ type: "huddle.publish" })]);
  });
});

describe("Leaving a huddle", () => {
  it("closes the socket and both connections, stops the microphone and the voices, and shows no huddle", async () => {
    const shown = vi.fn();
    const stop = watchHuddle(shown);
    const room = await joined([person(grace)]);
    const sending = await publishedAndConnected();
    await offeredRound(["0", grace]);
    const receiving = connection();
    shown.mockClear();

    leaveHuddle();
    expect(room.closedWith).toBe(1000);
    expect([sending.connectionState, receiving.connectionState]).toEqual(["closed", "closed"]);
    expect(microphoneTrack().readyState).toBe("ended");
    expect(document.querySelector("[data-huddle-voices]")).toBeNull();
    expect(joinedHuddle()).toBeNull();
    expect(shown).toHaveBeenCalledTimes(1);

    // Nothing more comes of it: no socket, no connection, and nothing for its controls to do.
    muteHuddle(true);
    leaveHuddle();
    await wait(ANSWER_TIMEOUT_MS * 2);
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeConnection.all).toHaveLength(2);
    expect(shown).toHaveBeenCalledTimes(1);
    stop();
  });

  it.each([
    [HuddleCloseCode.Full, "That huddle is full. A huddle takes 50 people."],
    [HuddleCloseCode.Off, "Huddles have been turned off."],
    [HuddleCloseCode.Moved, "You joined the huddle somewhere else, so it left this tab."],
    [CloseCode.NotFound, "You left the huddle, since its room is no longer there for you."],
  ])("ends for good, and says why, when the room closes its socket with %i", async (code, why) => {
    const said = vi.fn();
    const stop = hearHuddleEnd(said);
    const room = await joined([person(grace)]);
    await offeredRound(["0", grace]);

    room.drop(code);
    expect(said).toHaveBeenCalledExactlyOnceWith(why);
    expect(joinedHuddle()).toBeNull();
    expect(microphoneTrack().readyState).toBe("ended");
    for (const each of FakeConnection.all) expect(each.connectionState).toBe("closed");
    expect(voices()).toEqual([]);
    await wait(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    stop();
  });

  it("ends without a word when the person's sessions have ended, which the app says for itself", async () => {
    const said = vi.fn();
    const stop = hearHuddleEnd(said);
    const room = await joined();
    room.drop(CloseCode.Revoked);
    expect(joinedHuddle()).toBeNull();
    expect(said).not.toHaveBeenCalled();
    await wait(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    stop();
  });

  it("connects again after any other close, as when the room asks it to", async () => {
    const said = vi.fn();
    const stop = hearHuddleEnd(said);
    const room = await joined();
    room.drop(CloseCode.Reconnect);
    expect(joinedHuddle()).toMatchObject({ connected: false });
    await wait(500);
    expect(FakeSocket.all).toHaveLength(2);
    expect(said).not.toHaveBeenCalled();
    stop();
  });

  it("says why to whoever listens now, and to nobody once they've stopped", () => {
    const [first, second] = [vi.fn(), vi.fn()];
    const stopFirst = hearHuddleEnd(first);
    const stopSecond = hearHuddleEnd(second);
    // The first to stop is no longer the one listening, and stops nothing.
    stopFirst();
    joinHuddle({ roomId: "general", muted: false, microphone: null, speakerId: "" });
    socket().open();
    socket().drop(HuddleCloseCode.Off);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith("Huddles have been turned off.");

    stopSecond();
    joinHuddle({ roomId: "general", muted: false, microphone: null, speakerId: "" });
    socket().open();
    socket().drop(HuddleCloseCode.Off);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
