import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { isViewing, VIEWING_TTL_MS, viewersOf, type Viewing } from "../src/viewing";
import { connect, freshRoom, roomStub, settle, signIn } from "./support";

/** Who the room counts as viewing it at `now`. */
const viewers = (room: string, now?: number) =>
  runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => viewersOf(state, now).sort());

/** When the runtime last answered a ping on each of the room's sockets, and when the room last heard from it otherwise. */
const heard = (room: string) =>
  runInDurableObject(roomStub(room), (_room, state: DurableObjectState) =>
    state.getWebSockets().map((socket) => ({
      pingedAt: state.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? null,
      heardAt: (socket.deserializeAttachment() as Viewing).heardAt,
    })),
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Presence", () => {
  describe("whether a socket counts as viewing", () => {
    const at = Date.UTC(2026, 9, 14);

    it("counts a shown tab the room heard from in the last minute", () => {
      expect(isViewing({ visible: true, heardAt: at }, null, at + VIEWING_TTL_MS)).toBe(true);
      expect(isViewing({ visible: true, heardAt: at }, null, at + VIEWING_TTL_MS + 1)).toBe(false);
    });

    it("counts a ping the runtime answered as hearing from it", () => {
      const pinged = new Date(at + 30_000);
      expect(isViewing({ visible: true, heardAt: at }, pinged, at + 30_000 + VIEWING_TTL_MS)).toBe(true);
      expect(isViewing({ visible: true, heardAt: at }, pinged, at + 30_000 + VIEWING_TTL_MS + 1)).toBe(false);
      expect(isViewing({ visible: true, heardAt: at + 30_000 }, new Date(at), at + 30_000 + VIEWING_TTL_MS)).toBe(true);
    });

    it("never counts a hidden tab", () => {
      expect(isViewing({ visible: false, heardAt: at }, new Date(at), at)).toBe(false);
    });
  });

  it("counts someone viewing the room in a shown tab, once however many tabs they have", async () => {
    const room = await freshRoom("viewing");
    const ada = await signIn("Ada");
    await connect(room, ada, { visible: true });
    await connect(room, ada);
    const grace = await connect(room, "Grace", { visible: false });
    expect(await viewers(room)).toEqual([ada.user.id]);
    // Hidden tabs are still here, as who's here shows them.
    expect(grace.welcome.present.map((user) => user.name).sort()).toEqual(["Ada", "Grace"]);
  });

  it("counts a tab as shown when its address doesn't say, as the app's tabs from before it said didn't", async () => {
    const room = await freshRoom("viewing-unsaid");
    const ada = await connect(room, "Ada");
    expect(await viewers(room)).toEqual([ada.me.id]);
  });

  it("counts a tab as away once it says it's hidden, and back once it says it's shown", async () => {
    const room = await freshRoom("hiding");
    const ada = await connect(room, "Ada", { visible: true });
    ada.send({ type: "presence.visible", visible: false });
    await settle(ada);
    expect(await viewers(room)).toEqual([]);

    ada.send({ type: "presence.visible", visible: true });
    await settle(ada);
    expect(await viewers(room)).toEqual([ada.me.id]);
  });

  it("takes only a yes or no for whether a tab is shown", async () => {
    const room = await freshRoom("hiding-wrongly");
    const ada = await connect(room, "Ada", { visible: true });
    ada.send({ type: "presence.visible", visible: "hidden" });
    expect(await ada.next("error")).toEqual({ type: "error", message: "Unrecognized frame" });
    expect(await viewers(room)).toEqual([ada.me.id]);
  });

  it("stops counting a tab once it closes, or the room closes it", async () => {
    const room = await freshRoom("viewing-closed");
    const ada = await signIn("Ada");
    const shown = await connect(room, ada, { visible: true });
    await connect(room, ada, { visible: false });
    const grace = await connect(room, "Grace", { visible: true });

    shown.close();
    // Once the room has heard: her hidden tab doesn't count.
    await vi.waitFor(async () => expect(await viewers(room)).toEqual([grace.me.id]));

    // As when Grace's access ends: her socket counts no more, though it's closing still.
    await runInDurableObject(roomStub(room), (_room, state: DurableObjectState) => {
      state.getWebSockets(grace.me.id)[0]!.close(4001, "Reconnect");
      expect(viewersOf(state)).toEqual([]);
    });
  });

  it("stops counting a tab the room hasn't heard from in a minute, which its pings put off", async () => {
    const room = await freshRoom("unheard");
    const ada = await connect(room, "Ada", { visible: true });
    const [connected] = await heard(room);
    expect(connected!.pingedAt).toBeNull();
    expect(await viewers(room, connected!.heardAt + VIEWING_TTL_MS + 1)).toEqual([]);

    await sleep(20);
    // The app's heartbeat, which the runtime answers without waking the room.
    ada.sendRaw('{"type":"ping"}');
    await ada.next("pong");
    const [pinged] = await heard(room);
    expect(pinged!.pingedAt).toBeGreaterThan(connected!.heardAt);
    expect(await viewers(room, connected!.heardAt + VIEWING_TTL_MS + 1)).toEqual([ada.me.id]);
    expect(await viewers(room, pinged!.pingedAt! + VIEWING_TTL_MS + 1)).toEqual([]);
  });
});

describe("Hibernating rooms", () => {
  it("keeps whether each tab is shown, and when it last pinged, when the room hibernates", async () => {
    const room = await freshRoom("hibernate-viewing");
    const ada = await connect(room, "Ada", { visible: true });
    const grace = await connect(room, "Grace", { visible: false });
    ada.send({ type: "presence.visible", visible: false });
    grace.send({ type: "presence.visible", visible: true });
    grace.sendRaw('{"type":"ping"}');
    await grace.next("pong");
    await settle(ada, grace);
    const before = await heard(room);

    await evictDurableObject(roomStub(room));

    expect(await heard(room)).toEqual(before);
    expect(await viewers(room)).toEqual([grace.me.id]);
  });
});
