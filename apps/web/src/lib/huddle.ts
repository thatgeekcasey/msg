import { CloseCode, parseServerFrame, type RoomId, type UserId } from "@ember/protocol";
import { HuddleCloseCode, huddleSocketQuery, MAX_HUDDLE_PEOPLE, type HuddleClientFrame, type HuddlePerson, type HuddleServerFrame, type OfferedHuddleTrack } from "@ember/protocol/huddles";
import { socketUrl } from "./api";
import { listsSpeaker, watchDevices } from "./huddle-devices";
import { endHuddle, leaveHuddle, showHuddle, type HuddleControls, type JoinedHuddle } from "./huddle-store";
import { reconnectingSocket } from "./reconnecting-socket";

// A tab's side of a huddle. Its socket to the room (`/api/rooms/:id/huddle`) says who's in the huddle and
// carries the session descriptions the browser and Cloudflare's Realtime SFU agree with, which the room
// passes between them. What people say goes over two connections to the SFU: one sends the tab's
// microphone, and one receives everyone else, so that neither's changes wait on the other's. The room
// has the SFU close both whenever the socket closes, so a socket that connects again starts both afresh.
//
// The room's answers don't say which frame they're to, so the tab asks one thing at a time of each
// connection, and waits for the answer before it asks the next.

/** How a tab joins a huddle, as the preview before it leaves things. */
export interface HuddleJoin {
  roomId: RoomId;
  muted: boolean;
  /** The microphone, open already, which the huddle stops as it's left, or null to join listening only. */
  microphone: MediaStream | null;
  /** The speaker the others play through, by its device's id, or empty for the browser's own. */
  speakerId: string;
}

/** Cloudflare's STUN server, by which the browser learns the address the SFU reaches it at. */
const CONNECTION: RTCConfiguration = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], bundlePolicy: "max-bundle" };
/**
 * How long the room has to answer what a connection asked of it: longer than it gives the SFU to answer
 * all that a round of listening can have it ask. A room that hasn't by then isn't going to, and the tab
 * joins again on a new socket.
 */
export const ANSWER_TIMEOUT_MS = 45_000;
/** How long the tab waits to ask again for someone it can listen to and doesn't hear, doubling up to the second. */
export const LISTEN_AGAIN_MS = [500, 8_000] as const;
/** How long it waits to publish again after its sending connection failed, doubling up to the second. */
export const PUBLISH_AGAIN_MS = [1_000, 15_000] as const;

/**
 * What the tab's person is told once the room has ended the huddle for them, by the code it closed their
 * socket with, or null where the app says so for itself. After any other close the tab connects again.
 */
const ENDINGS: Record<number, string | null> = {
  [HuddleCloseCode.Full]: `That huddle is full. A huddle takes ${MAX_HUDDLE_PEOPLE} people.`,
  [HuddleCloseCode.Off]: "Huddles have been turned off.",
  [HuddleCloseCode.Moved]: "You joined the huddle somewhere else, so it left this tab.",
  [CloseCode.NotFound]: "You left the huddle, since its room is no longer there for you.",
  // Their sessions have ended, and the app goes to sign in.
  [CloseCode.Revoked]: null,
};

/** The address of room `roomId`'s huddle's socket, which says whether the tab joins muted. */
export const huddleSocketUrl = (roomId: RoomId, muted: boolean) => socketUrl(`/api/rooms/${encodeURIComponent(roomId)}/huddle${huddleSocketQuery({ muted })}`);

/** A wait that doubles each time it's taken, from `least` to `most`, until it's started over. */
function growingWait([least, most]: readonly [number, number]) {
  let next = least;
  return {
    take() {
      const wait = next;
      next = Math.min(most, next * 2);
      return wait;
    },
    startOver() {
      next = least;
    },
  };
}

/** What a browser takes for the person's touch, and lets a voice play from. A tap is one at its click, and not as the finger lands. */
const TOUCHES = ["click", "keydown"] as const;

/** Plays `audio` through the speaker `deviceId`, or the system's for none. Safari has no way to choose one, and plays through the system's. */
function playThrough(audio: HTMLAudioElement, deviceId: string): void {
  if (typeof audio.setSinkId === "function") void audio.setSinkId(deviceId).catch(() => {});
}

/**
 * The others' voices: an `<audio>` each, kept in the page, hidden, which plays its person's track from
 * when the tab is offered it until they leave. A browser that won't play one until the person has
 * touched the page plays it at their next click or key. They play through the speaker `speakerId`, or
 * through the system's when that's empty, and for as long as that speaker is unplugged, when it would
 * play nothing.
 */
function voicesThrough(speakerId: string) {
  const playing = new Map<UserId, HTMLAudioElement>();
  const box = document.createElement("div");
  box.hidden = true;
  box.dataset.huddleVoices = "";
  /** The speaker they play through now, by its device's id, or empty for the system's. */
  let speaker = speakerId;
  const followSpeaker = async () => {
    if (!speakerId) return;
    speaker = (await listsSpeaker(speakerId)) ? speakerId : "";
    for (const audio of playing.values()) playThrough(audio, speaker);
  };
  const stopWatching = watchDevices(() => void followSpeaker());
  const playRefused = () => {
    for (const audio of playing.values()) if (audio.paused) void audio.play().catch(() => {});
  };
  // In the capture phase, which hears a click that whatever it lands on keeps to itself.
  const playOnceTouched = () => {
    for (const touch of TOUCHES) document.addEventListener(touch, playRefused, true);
  };
  const stop = (userId: UserId) => {
    const audio = playing.get(userId);
    if (!audio) return;
    audio.srcObject = null;
    audio.remove();
    playing.delete(userId);
  };
  return {
    play(userId: UserId, track: MediaStreamTrack) {
      const audio = playing.get(userId) ?? document.createElement("audio");
      audio.dataset.userId = userId;
      audio.autoplay = true;
      audio.srcObject = new MediaStream([track]);
      if (speaker) playThrough(audio, speaker);
      playing.set(userId, audio);
      if (!box.isConnected) document.body.append(box);
      box.append(audio);
      void audio.play().catch(playOnceTouched);
    },
    stop,
    stopAll() {
      for (const userId of [...playing.keys()]) stop(userId);
      for (const touch of TOUCHES) document.removeEventListener(touch, playRefused, true);
      stopWatching();
      box.remove();
    },
  };
}

/** Joins room `roomId`'s huddle, which starts it when nobody's in it, leaving any the tab was in. */
export function joinHuddle({ roomId, muted, microphone, speakerId }: HuddleJoin): void {
  leaveHuddle();
  const track = microphone?.getAudioTracks()[0] ?? null;
  let huddle: JoinedHuddle = { roomId, connected: false, you: null, people: [], muted: muted || !track, microphone: track !== null };
  let over = false;
  if (track) track.enabled = !huddle.muted;

  // The sending connection, which publishes the microphone.
  let sending: RTCPeerConnection | null = null;
  /** Whether the room has yet to answer the offer the sending connection published with. */
  let unanswered = false;
  /** Runs out on the room's answer to that offer, or brings the next time the tab publishes. */
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const publishWait = growingWait(PUBLISH_AGAIN_MS);

  // The receiving connection, on which the SFU offers the tab whoever it doesn't hear yet, a round at a
  // time: the tab asks (`huddle.listen`), answers the offer if one comes, and the room says `huddle.listening`.
  let receiving: RTCPeerConnection | null = null;
  /** Whom the tab has been offered, and so hears. */
  const heard = new Set<UserId>();
  /** The round under way: whether it has brought an offer, and whether the tab has given up the connection it asked on meanwhile. */
  let round: { offered: boolean; givenUp: boolean } | null = null;
  /** Runs out on the room's answer to that round, or brings the next. */
  let listenTimer: ReturnType<typeof setTimeout> | undefined;
  const listenWait = growingWait(LISTEN_AGAIN_MS);
  const voices = voicesThrough(speakerId);

  const socket = reconnectingSocket<HuddleClientFrame>({
    url: () => huddleSocketUrl(roomId, huddle.muted),
    onMessage: (data) => {
      const frame = parseServerFrame<HuddleServerFrame>(data);
      if (frame && !over) hear(frame);
    },
    // However the socket was lost: one that stops answering goes without a close.
    onConnecting: (status) => {
      if (status === "reconnecting") roomLost();
    },
    onClose: (code) => {
      const ending = ENDINGS[code];
      if (ending === undefined) return true;
      stop();
      if (ending === null) showHuddle(null);
      else endHuddle(ending);
      return false;
    },
  });

  const controls: HuddleControls = {
    leave() {
      stop();
      showHuddle(null);
    },
    setMuted(to) {
      if (!track || !huddle.microphone || to === huddle.muted) return;
      track.enabled = !to;
      socket.send({ type: "huddle.mute", muted: to });
      show({ muted: to });
    },
  };

  /** Shows the huddle with `changes`, the tab's person among its people muted as the tab is. */
  function show(changes: Partial<JoinedHuddle>) {
    if (over) return;
    const next = { ...huddle, ...changes };
    const people = next.people.map((person) => (person.user.id === next.you?.id && person.muted !== next.muted ? { ...person, muted: next.muted } : person));
    showHuddle((huddle = { ...next, people }), controls);
  }

  // A microphone that's unplugged, or that the browser stops letting the page use, leaves its person listening.
  const microphoneGone = () => {
    socket.send({ type: "huddle.mute", muted: true });
    show({ muted: true, microphone: false });
  };
  track?.addEventListener("ended", microphoneGone);

  /** Leaves for good: the socket closes, which is how the room hears, and so do both connections and the microphone. */
  function stop() {
    over = true;
    socket.close();
    hangUp();
    voices.stopAll();
    track?.removeEventListener("ended", microphoneGone);
    for (const each of microphone?.getTracks() ?? []) each.stop();
  }

  /** The socket is gone, and both connections with it, which the room has the SFU close. The next socket's welcome starts them again. */
  function roomLost() {
    hangUp();
    if (huddle.connected) show({ connected: false });
  }

  /** Joins again on a new socket, the room having left something the tab asked unanswered. */
  function rejoin() {
    socket.hold();
    socket.retry();
  }

  function hangUp() {
    hangUpSending();
    hangUpReceiving();
    endRound();
  }

  /** Publishes the microphone from a new sending connection, with the offer the connection makes for it. */
  async function publish() {
    hangUpSending();
    if (!track || track.readyState === "ended") return;
    const connection = (sending = new RTCPeerConnection(CONNECTION));
    const transceiver = connection.addTransceiver(track, { direction: "sendonly" });
    connection.onconnectionstatechange = () => {
      if (sending !== connection) return;
      if (connection.connectionState === "failed") return publishLater();
      if (connection.connectionState !== "connected") return;
      publishWait.startOver();
      socket.send({ type: "huddle.connected" });
    };
    let offer: string | undefined;
    try {
      await connection.setLocalDescription(await connection.createOffer());
      offer = connection.localDescription?.sdp;
    } catch {
      // Published again below, as an offer that couldn't be made.
    }
    if (sending !== connection) return;
    if (!offer || transceiver.mid === null) return publishLater();
    // Unsent, the socket is down, and the room's welcome on the next one publishes.
    if (!socket.send({ type: "huddle.publish", sdp: offer, tracks: [{ mid: transceiver.mid, kind: "audio" }] })) return;
    unanswered = true;
    publishTimer = setTimeout(rejoin, ANSWER_TIMEOUT_MS);
  }

  /** Publishes again in a while, longer each time until a sending connection has connected. */
  function publishLater() {
    hangUpSending();
    if (!over) publishTimer = setTimeout(() => void publish(), publishWait.take());
  }

  /** Gives the sending connection the SFU's answer to the offer it published with, after which it connects. */
  async function published(sdp: string) {
    const connection = sending;
    if (!connection || !unanswered) return;
    unanswered = false;
    clearTimeout(publishTimer);
    try {
      await connection.setRemoteDescription({ type: "answer", sdp });
    } catch {
      if (sending === connection) publishLater();
    }
  }

  function hangUpSending() {
    clearTimeout(publishTimer);
    unanswered = false;
    sending?.close();
    sending = null;
  }

  const isUnheard = ({ user, audio }: HuddlePerson) => audio && user.id !== huddle.you?.id && !heard.has(user.id);
  const canListenTo = (userId: UserId) => huddle.people.some(({ user, audio }) => audio && user.id === userId);

  /**
   * Starts a round, unless one is under way: asks to hear whoever the tab can listen to and doesn't, or
   * with `anyone`, whoever the room finds it doesn't.
   */
  function listen(anyone = false) {
    if (over || round) return;
    clearTimeout(listenTimer);
    if (!anyone && !huddle.people.some(isUnheard)) return;
    if (!socket.send(receiving ? { type: "huddle.listen" } : { type: "huddle.listen", fresh: true })) return;
    round = { offered: false, givenUp: false };
    listenTimer = setTimeout(rejoin, ANSWER_TIMEOUT_MS);
  }

  function listenLater() {
    listenTimer = setTimeout(() => listen(), listenWait.take());
  }

  function endRound() {
    clearTimeout(listenTimer);
    round = null;
  }

  /**
   * Answers the SFU's offer of `tracks` from the receiving connection, and plays them. An offer the tab
   * can't answer, or one to a connection it has given up, is the last the room says of the round: it lets
   * go of its side of the connection as the tab asks for a fresh one.
   */
  async function offered(sdp: string, tracks: OfferedHuddleTrack[]) {
    const asked = round;
    if (!asked) return;
    asked.offered = true;
    const answer = asked.givenUp ? undefined : await answerTo(sdp, tracks);
    // The socket has gone meanwhile, or the tab has left.
    if (round !== asked) return;
    if (answer !== undefined && !asked.givenUp) return void socket.send({ type: "huddle.answer", sdp: answer });
    endRound();
    hangUpReceiving();
    listenLater();
  }

  /**
   * The receiving connection's answer to an offer of `tracks`, which it plays, or undefined when it can't
   * make one. The first offer makes the connection. The tab hears whoever the offer names from when it
   * comes, though the connection takes a moment to have their tracks: whoever leaves or begins publishing
   * anew in that moment is forgotten, and isn't played what the offer carries of them, which is of before.
   */
  async function answerTo(sdp: string, tracks: OfferedHuddleTrack[]): Promise<string | undefined> {
    const connection = (receiving ??= receivingConnection());
    for (const { userId } of tracks) if (canListenTo(userId)) heard.add(userId);
    try {
      await connection.setRemoteDescription({ type: "offer", sdp });
      if (receiving !== connection) return undefined;
      for (const track of tracks) play(connection, track);
      await connection.setLocalDescription(await connection.createAnswer());
      return connection.localDescription?.sdp;
    } catch {
      return undefined;
    }
  }

  function receivingConnection(): RTCPeerConnection {
    const connection = new RTCPeerConnection(CONNECTION);
    connection.onconnectionstatechange = () => {
      if (receiving === connection && connection.connectionState === "failed") listenAfresh();
    };
    return connection;
  }

  /**
   * Plays the track the SFU offered of someone the tab hears, which the connection receives on the media
   * section the offer named. Not of someone who had left as the offer came, or couldn't be listened to
   * then, nor of someone the tab has forgotten since: the track is of what they published before, and
   * the tab asks for what they publish next.
   */
  function play(connection: RTCPeerConnection, { mid, userId }: OfferedHuddleTrack) {
    const theirs = connection.getTransceivers().find((transceiver) => transceiver.mid === mid)?.receiver.track;
    if (theirs && heard.has(userId)) voices.play(userId, theirs);
  }

  /**
   * The room has answered what the tab asked, which ends the round. After one that brought an offer the
   * tab asks again at once: for whoever the offer left out, and for anyone who began publishing anew
   * while it was made, whose track in it carries nothing. After one that brought none it asks in a
   * while, for whoever the SFU couldn't offer yet.
   */
  function listening() {
    if (!round) return;
    const { offered: wasOffered, givenUp } = round;
    endRound();
    if (wasOffered && !givenUp) {
      listenWait.startOver();
      return listen(true);
    }
    if (givenUp || huddle.people.some(isUnheard)) listenLater();
  }

  /**
   * Gives up the receiving connection, which has failed or which the room has let go of, to hear everyone
   * on a new one, which the tab asks for in a while, once the round under way is over.
   */
  function listenAfresh() {
    hangUpReceiving();
    if (round) round.givenUp = true;
    else listenLater();
  }

  /** Stops hearing `userId`, who left, or can't be listened to for the moment: what the tab heard of them carries nothing more. */
  function forget(userId: UserId) {
    heard.delete(userId);
    voices.stop(userId);
  }

  function hangUpReceiving() {
    receiving?.close();
    receiving = null;
    for (const userId of [...heard]) forget(userId);
  }

  function hear(frame: HuddleServerFrame) {
    switch (frame.type) {
      case "huddle.welcome": {
        socket.connected();
        publishWait.startOver();
        listenWait.startOver();
        // The address said whether the tab was muted as it asked to join, which it may not be now.
        const mine = frame.people.find(({ user }) => user.id === frame.you.id);
        if (mine && mine.muted !== huddle.muted) socket.send({ type: "huddle.mute", muted: huddle.muted });
        show({ connected: true, you: frame.you, people: frame.people });
        void publish();
        return listen();
      }
      case "huddle.joined":
      case "huddle.changed": {
        const { person } = frame;
        if (!person.audio) forget(person.user.id);
        const known = huddle.people.some(({ user }) => user.id === person.user.id);
        show({ people: known ? huddle.people.map((other) => (other.user.id === person.user.id ? person : other)) : [...huddle.people, person] });
        return listen();
      }
      case "huddle.left":
        forget(frame.userId);
        return show({ people: huddle.people.filter(({ user }) => user.id !== frame.userId) });
      case "huddle.published":
        return void published(frame.sdp);
      case "huddle.unpublished":
        // The offer the tab waits on the answer to publishes anew already.
        if (!unanswered) void publish();
        return;
      case "huddle.offer":
        return void offered(frame.sdp, frame.tracks);
      case "huddle.listening":
        return listening();
      case "error":
        if (frame.failed === "huddle.publish" && unanswered) publishLater();
        if ((frame.failed === "huddle.listen" || frame.failed === "huddle.answer") && round) {
          endRound();
          listenAfresh();
        }
        return;
      case "pong":
        return;
    }
  }

  show({});
}
