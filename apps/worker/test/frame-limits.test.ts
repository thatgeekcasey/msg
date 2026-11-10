import { MAX_MESSAGE_HTML_LENGTH, MESSAGE_TOO_LONG } from "@ember/protocol";
import { describe, expect, it } from "vitest";
import { MAX_ROOM_FRAME_SIZE, MAX_WORKSPACE_FRAME_SIZE } from "../src/sockets";
import { closeOf, connect, freshRoom, openWorkspaceSocket, settle, signIn } from "./support";

// A Durable Object reads one frame at a time, for every socket it serves, so it closes a socket that
// sends a frame larger than it takes before reading it.

/** A ping the runtime doesn't answer itself, of `bytes` in UTF-8: JSON may end in as many spaces as it likes. */
const paddedPing = (bytes: number) => JSON.stringify({ type: "ping" }).padEnd(bytes, " ");

/** A ping with `nonce`, which takes 26 bytes more than it. */
const ping = (nonce: string) => JSON.stringify({ type: "ping", nonce });

describe("Request and connection limits", () => {
  it("reads a frame of 1 MiB on a room's socket, and closes one sent a byte more, before reading it", async () => {
    const room = await freshRoom("frame-limit");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    await ada.next("presence.joined");

    ada.sendRaw(paddedPing(MAX_ROOM_FRAME_SIZE));
    expect(await ada.next("pong")).toEqual({ type: "pong" });
    const closed = closeOf(grace.ws);
    grace.sendRaw(JSON.stringify({ type: "message.create", clientMessageId: "c1", body: "Too long" }).padEnd(MAX_ROOM_FRAME_SIZE + 1, " "));
    expect((await closed).code).toBe(1009);
    expect(await ada.next("presence.left")).toEqual({ type: "presence.left", userId: grace.me.id });
    await settle(ada);
    expect(ada.pending("message.created")).toEqual([]);

    // Nothing ended but the socket.
    const back = await connect(room, grace.session);
    expect(back.welcome.messages).toEqual([]);
  });

  it("counts a frame's text in UTF-8, as it came", async () => {
    const room = await freshRoom("frame-limit-text");
    const ada = await connect(room, "Ada");
    // Each takes two bytes.
    ada.sendRaw(ping("é".repeat((MAX_ROOM_FRAME_SIZE - 26) / 2)));
    expect(await ada.next("pong")).toEqual({ type: "pong" });
    const closed = closeOf(ada.ws);
    // 350,026 characters, but 1,050,026 bytes.
    ada.sendRaw(ping("€".repeat(350_000)));
    expect((await closed).code).toBe(1009);
  });

  it("reads the largest frame the app sends: a message as long as it can be, of the characters JSON writes longest", async () => {
    const ada = await connect(await freshRoom("frame-limit-largest"), "Ada");
    // Each is `\u0001` in JSON, so the frame is some 600 KB. The room reads it, and refuses so many characters.
    ada.send({ type: "message.create", clientMessageId: "c1", body: "\u0001".repeat(MAX_MESSAGE_HTML_LENGTH) });
    expect(await ada.next("error")).toMatchObject({ clientMessageId: "c1", message: MESSAGE_TOO_LONG });
    expect(ada.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes a workspace socket sent a frame of more than 1 KiB, which takes only pings, counting its text in UTF-8", async () => {
    const session = await signIn("Ada");
    const socket = await openWorkspaceSocket(session);
    const other = await openWorkspaceSocket(session);
    socket.send(ping("a".repeat(MAX_WORKSPACE_FRAME_SIZE - 26)));
    expect(await socket.next()).toEqual({ type: "pong" });
    socket.send(ping("é".repeat((MAX_WORKSPACE_FRAME_SIZE - 26) / 2)));
    expect(await socket.next()).toEqual({ type: "pong" });
    // 359 characters, but 1,025 bytes.
    socket.send(ping("€".repeat(333)));
    expect((await socket.closed).code).toBe(1009);
    expect(await other.answers()).toBe(true);
  });
});
