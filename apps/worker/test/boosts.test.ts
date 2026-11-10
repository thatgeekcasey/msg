import { MAX_BOOST_LENGTH, REACTIONS } from "@ember/protocol";
import { describe, expect, it } from "vitest";
import { connect, freshRoom, post, settle } from "./support";

describe("React to a message", () => {
  it("adds a reaction to a message for everyone, attributed to whoever reacted", async () => {
    const room = await freshRoom("boost");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const message = await post(ada, "Ship it?");

    grace.send({ type: "boost.create", messageId: message.id, content: "🔥" });
    const { boost } = await ada.next("boost.created");
    expect(boost).toMatchObject({ messageId: message.id, content: "🔥", booster: grace.me });
    expect((await grace.next("boost.created")).boost).toEqual(boost);
  });

  it("accepts every reaction in the toolbar and tray", async () => {
    const ada = await connect(await freshRoom("every"), "Ada");
    const message = await post(ada, "React");
    for (const [emoji] of REACTIONS) {
      ada.send({ type: "boost.create", messageId: message.id, content: emoji });
      expect((await ada.next("boost.created")).boost.content).toBe(emoji);
    }
  });

  it("keeps reactions in order, so latecomers see them as they were added", async () => {
    const room = await freshRoom("boost-order");
    const ada = await connect(room, "Ada");
    const message = await post(ada, "Order");
    const added = [];
    for (const content of ["👍", "👏", "🎉"]) {
      ada.send({ type: "boost.create", messageId: message.id, content });
      added.push((await ada.next("boost.created")).boost);
    }
    expect((await connect(room, "Grace")).welcome.messages[0]!.boosts).toEqual(added);
  });

  it("ignores a reaction the same person already added", async () => {
    const ada = await connect(await freshRoom("repeat-boost"), "Ada");
    const message = await post(ada, "React once");
    ada.send({ type: "boost.create", messageId: message.id, content: "👍" });
    ada.send({ type: "boost.create", messageId: message.id, content: "👍" });
    await settle(ada);
    expect(ada.log.filter((frame) => frame.type === "boost.created")).toHaveLength(1);
  });

  it("refuses reactions to messages that don't exist", async () => {
    const ada = await connect(await freshRoom("boost-missing"), "Ada");
    ada.send({ type: "boost.create", messageId: "missing", content: "👍" });
    expect((await ada.next("error")).message).toBe("That message no longer exists");
  });
});

describe("Custom reactions", () => {
  it(`stores free-text reactions up to ${MAX_BOOST_LENGTH} characters, trimmed`, async () => {
    const ada = await connect(await freshRoom("custom"), "Ada");
    const message = await post(ada, "Custom");
    ada.send({ type: "boost.create", messageId: message.id, content: "  nice one  " });
    expect((await ada.next("boost.created")).boost.content).toBe("nice one");

    ada.send({ type: "boost.create", messageId: message.id, content: "x".repeat(MAX_BOOST_LENGTH) });
    expect((await ada.next("boost.created")).boost.content).toHaveLength(MAX_BOOST_LENGTH);
    ada.send({ type: "boost.create", messageId: message.id, content: "x".repeat(MAX_BOOST_LENGTH + 1) });
    expect((await ada.next("error")).message).toBe("Unrecognized frame");
    ada.send({ type: "boost.create", messageId: message.id, content: "   " });
    expect((await ada.next("error")).message).toBe("Unrecognized frame");
  });
});

describe("Take back a reaction", () => {
  it("lets people take back their own reactions, for everyone", async () => {
    const room = await freshRoom("unboost");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const message = await post(ada, "Hmm");
    grace.send({ type: "boost.create", messageId: message.id, content: "👋" });
    const { boost } = await grace.next("boost.created");

    grace.send({ type: "boost.delete", boostId: boost.id });
    expect(await ada.next("boost.deleted")).toEqual({ type: "boost.deleted", boostId: boost.id, messageId: message.id, seq: 3 });
    await grace.next("boost.deleted");
    expect((await connect(room, "Linus")).welcome.messages[0]!.boosts).toEqual([]);
  });

  it("refuses to remove someone else's reaction", async () => {
    const room = await freshRoom("unboost-other");
    const ada = await connect(room, "Ada");
    const grace = await connect(room, "Grace");
    const message = await post(ada, "Mine to react to");
    grace.send({ type: "boost.create", messageId: message.id, content: "👍" });
    const { boost } = await grace.next("boost.created");

    ada.send({ type: "boost.delete", boostId: boost.id });
    expect((await ada.next("error")).message).toBe("You can only remove your own reactions");
    await settle(ada, grace);
    expect(grace.pending("boost.deleted")).toEqual([]);
    expect((await connect(room, "Linus")).welcome.messages[0]!.boosts).toHaveLength(1);
  });
});
