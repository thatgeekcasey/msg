// What Fernwood's rooms and DMs say, written to show everything a message can be: threads, one with a
// reply also sent to its room, replies quoting what they answer, quotes, mentions, reactions, edits,
// formatting, code, pictures, a video, files, link previews, emoji on their own, and bots' cards. Maya,
// who sets Ember up, speaks in a few of them, so signed in as her, some rooms are read and others have news.

import type { RoomIconName, RoomId } from "@ember/protocol";
import type { BotName, PersonName } from "./cast.ts";
import { Conversation, type BotKey, type Ember, type SeedFile, type Session } from "./client.ts";
import { codeBlock, html, linkWithPreview, mention, preview } from "./markup.ts";

/** A room the seed makes: who makes it, and whom else it's for, if it's private. */
export interface PlannedRoom {
  name: string;
  icon: RoomIconName;
  by: PersonName;
  privateTo?: PersonName[];
}

/** The rooms the seed makes, besides general and random, which setup makes. */
export const ROOMS = {
  launch: { name: "Launch", icon: "rocket", by: "maya" },
  design: { name: "Design", icon: "palette", by: "priya" },
  engineering: { name: "Engineering", icon: "code", by: "sam" },
  support: { name: "Support", icon: "life-buoy", by: "amara" },
  leadership: { name: "Leadership", icon: "briefcase", by: "maya", privateTo: ["sam", "priya"] },
} satisfies Record<string, PlannedRoom>;

/** The DMs, each started by the first person it names. */
export const DIRECTS = {
  samAndMaya: ["sam", "maya"],
  priyaAndMaya: ["priya", "maya"],
  cakePlans: ["leo", "maya", "jordan"],
} satisfies Record<string, [PersonName, ...PersonName[]]>;

export type RoomName = "general" | "random" | keyof typeof ROOMS | keyof typeof DIRECTS;

/** Everyone and everything the conversations happen among. */
export interface Team {
  ember: Ember;
  people: Record<PersonName, Session>;
  bots: Record<BotName, BotKey>;
  rooms: Record<RoomName, RoomId>;
  /** A file from files/. */
  file: (name: string) => SeedFile;
}

type Script = (team: Team, room: Conversation) => Promise<void>;

/** Has every room and DM say what it says, one after another. */
export async function converse(team: Team): Promise<void> {
  const scripts: [RoomName, Script][] = [
    ["general", general],
    ["random", random],
    ["engineering", engineering],
    ["design", design],
    ["support", support],
    ["leadership", leadership],
    ["launch", launch],
    ["samAndMaya", samAndMaya],
    ["priyaAndMaya", priyaAndMaya],
    ["cakePlans", cakePlans],
  ];
  for (const [name, script] of scripts) {
    const room = new Conversation(team.ember, team.rooms[name]);
    try {
      await script(team, room);
      await room.readToEnd();
    } finally {
      room.close();
    }
  }
}

const general: Script = async ({ people: { maya, jordan, amara, tomas, sam, priya, leo } }, room) => {
  await room.say(maya, "Welcome to Fernwood, everyone! 👋 This room is for news the whole team should see.");
  const allHands = await room.say(jordan, html`<p>Heads up: the all-hands moved to <strong>Friday at 10:00</strong>. Bring questions, there will be pastries 🥐</p>`);
  await room.react(sam, allHands, "🥐");
  await room.react(leo, allHands, "🥐");
  const hello = await room.say(amara, "Hi everyone, I'm Amara! I just joined to lead support. Excited to meet you all 😊");
  for (const person of [maya, priya, sam, leo]) await room.react(person, hello, "👋");
  await room.react(jordan, hello, "welcome!");
  await room.reply(tomas, hello, "Welcome aboard! Ping me if you'd like a tour of how releases work.");
  await room.say(amara, "Will do, thank you!");
};

const random: Script = async ({ people: { tomas, priya, leo, sam, jordan }, file }, room) => {
  const photo = await room.share(tomas, file("sunrise.jpg"), file("sunrise.jpg"));
  await room.say(tomas, "Sunrise at the lake on Saturday. Worth the 5am alarm 🌄");
  await room.react(priya, photo, "😍");
  await room.react(leo, photo, "😍");
  await room.react(sam, photo, "🔥");
  await room.react(jordan, photo, "wow");
  await room.say(leo, "Okay, that's my new desktop background.");
  await room.say(priya, "🌅");
  const lunch = await room.say(jordan, "Lunch after the launch? I'm thinking ramen 🍜");
  for (const person of [sam, priya, tomas]) await room.react(person, lunch, "🍜");
  await room.react(leo, lunch, "I'm in");
};

const engineering: Script = async ({ people: { sam, leo, tomas }, bots: { deploys }, file }, room) => {
  const til = await room.say(
    leo,
    linkWithPreview("TIL Durable Objects can hibernate their WebSockets, so a quiet room costs nothing while everyone's idle:", {
      url: "https://developers.cloudflare.com/durable-objects/",
      title: "Overview · Cloudflare Durable Objects docs",
      description: "Build stateful serverless applications with Durable Objects, including AI agents, real-time chat, and collaborative apps.",
      image: "https://developers.cloudflare.com/durable-objects/og.png",
    }),
  );
  await room.react(sam, til, "🤯");
  await room.say(sam, "Speaking of rooms, here's p95 for sending a message since presence moved into the room's object:");
  const chart = await room.share(sam, file("send-latency.png"), file("send-latency.png"));
  await room.react(tomas, chart, "📉");
  await room.react(leo, chart, "🚀");
  await room.say(
    sam,
    html`<p>Down from <s>180 ms</s> to <strong>45 ms</strong>. The fix was to answer the sender first and fan out after:</p>${codeBlock(
      "javascript",
      `// Answer the sender before telling everyone else.\nsocket.send(JSON.stringify({ type: "message.created", message }));\nthis.ctx.waitUntil(this.broadcast(message, { except: socket }));`,
    )}`,
  );
  const local = await room.say(tomas, html`<p>Nice. Does <code>pnpm perf --quick</code> show the same locally?</p>`);
  await room.reply(sam, local, "Within a couple of ms, yes. Here are the numbers for every day:");
  await room.share(sam, file("send-latency.csv"));
  await room.post(deploys, deployed("api", "2026.10.30", "production", "Sam Rivera"));
  await room.say(
    leo,
    linkWithPreview("And the runtime's open source, if anyone wants to see how hibernation works:", {
      url: "https://github.com/cloudflare/workerd",
      title: "GitHub - cloudflare/workerd: The JavaScript / Wasm runtime that powers Cloudflare Workers",
      description: "The JavaScript / Wasm runtime that powers Cloudflare Workers - cloudflare/workerd",
      image: "https://opengraph.githubassets.com/1/cloudflare/workerd",
    }),
  );
};

const design: Script = async ({ people: { priya, leo, jordan, amara, maya }, file }, room) => {
  await room.say(priya, "Here's where the new onboarding is headed:");
  const mockup = await room.share(priya, file("onboarding-v3.png"), file("onboarding-v3.png"));
  await room.say(priya, html`<p>Bigger avatars, calmer type, and every room gets an icon. Thoughts welcome, <em>especially</em> on the empty state.</p>`);
  await room.react(leo, mockup, "😍");
  await room.react(jordan, mockup, "💯");
  await room.react(amara, mockup, "😍");
  const warmer = await room.say(leo, "Love it. Could we try a warmer accent? The blue feels a little cold next to people's photos.");
  await room.reply(priya, warmer, "Good call. I'll try the amber from the brand guide:");
  await room.share(priya, file("brand-guide.pdf"));
  await room.share(priya, file("prototype.mp4"), file("prototype-poster.jpg"));
  await room.say(
    amara,
    html`<blockquote>It's the first chat app that doesn't make me anxious. Everything is just… calm.</blockquote><p>That's from this morning's customer call. The new onboarding is going to land well 💛</p>`,
  );
  await room.share(priya, file("fernwood.svg"));
  await room.say(priya, html`<p>And a first pass at the new mark. ${mention(maya.user)}, does it work for the launch post?</p>`);
};

const support: Script = async ({ people: { amara, sam }, bots: { uptime } }, room) => {
  await room.watch(amara);
  await room.post(uptime, alert("FIRING", "danger", "5xx responses on the message API are at *7.2%*, above the 5% threshold."));
  const slow = await room.say(amara, html`<p>A few customers say messages are slow to send. ${mention(sam.user)}, is this related?</p>`);
  await room.replyInThread(sam, slow, "Yes, one of the cache nodes restarted under load. Rolling it now.");
  await room.replyInThread(amara, slow, "Thanks! I'll tell the customers who wrote in.");
  await room.post(uptime, alert("RESOLVED", "good", "5xx responses on the message API are back to *0.1%*."));
  const thanks = await room.say(amara, "Reports have stopped coming in. Thanks, Sam! 🙏");
  await room.react(sam, thanks, "🙌");
  await room.say(
    amara,
    html`<p>Summary for the log:</p><ul><li><strong>Impact:</strong> slow sends for about 12 minutes</li><li><strong>Cause:</strong> a cache node restarted under load</li><li><strong>Follow-up:</strong> alert at 2% errors, not 5%</li></ul>`,
  );
};

const leadership: Script = async ({ people: { maya, sam, priya } }, room) => {
  await room.say(maya, "The Q4 plan is ready for comments. Hiring is the big one: two engineers and a designer.");
  await room.say(priya, "I'll add the design team's asks by Friday.");
  const budget = await room.say(sam, html`<p>Infrastructure is at <strong>62%</strong> of budget, so there's room for a second region.</p>`);
  await room.react(maya, budget, "👍");
};

const launch: Script = async ({ people: { maya, sam, priya, leo, jordan, tomas }, bots: { deploys } }, room) => {
  await room.say(sam, "The release candidate is up on staging 🚀");
  await room.post(deploys, deployed("web", "1.8.0-rc.2", "staging", "Sam Rivera"));
  await room.say(priya, "Running through the checklist now.");
  await room.say(priya, "Everything I've tried works great on my phone.");
  const icons = await room.say(leo, "The room icons landed too, so every room can have one now.");
  await room.react(priya, icons, "😍");
  const shipIt = await room.say(maya, html`<p>Great work, everyone! Let's ship it <strong>Thursday morning</strong>.</p>`);
  for (const person of [sam, priya, leo, tomas]) await room.react(person, shipIt, "🎉");
  await room.react(jordan, shipIt, "ship it!");
  const notes = await room.say(sam, html`<p>${mention(maya.user)} can you give the release notes a last read before I tag it?</p>`);
  await room.replyInThread(maya, notes, "On it 👍 Comments by lunch.");
  await room.replyInThread(sam, notes, "Thanks! The upgrade steps are the part I'm least sure of.");
  await room.replyInThread(maya, notes, "Left two comments there. The rest reads well, tag it whenever you're ready.");
  const regressions = await room.say(
    tomas,
    html`<p>Regression pass is done ✅ Two small things:</p><ol><li>The unread dot lingers after switching rooms on an iPad</li><li>Long room names run under the header on 320px phones</li></ol>`,
  );
  const fixed = await room.replyInThread(leo, regressions, "Both fixed in #412, mind having one more look?");
  await room.edit(fixed, "Both fixed in #412 and #413, mind having one more look?");
  await room.react(tomas, fixed, "👀");
  await room.replyInThread(tomas, regressions, "Confirmed, both fixed 👌", { alsoSend: true });
  const announcement = await room.say(
    jordan,
    html`<p>The announcement draft is up, comments welcome: <a href="https://fernwood.example/blog/launch-week">https://fernwood.example/blog/launch-week</a></p>${preview({
      url: "https://fernwood.example/blog/launch-week",
      title: "Launch week at Fernwood",
      description: "Five new features, one calmer inbox. Here's everything shipping on Thursday.",
    })}`,
  );
  await room.react(maya, announcement, "❤️");
  await room.say(priya, "🚀🚀🚀");
};

const samAndMaya: Script = async ({ people: { sam, maya } }, room) => {
  await room.say(sam, "Lunch after the launch? 🍜");
  const yes = await room.say(maya, "Yes! The ramen place by the station?");
  await room.react(sam, yes, "👍");
};

const priyaAndMaya: Script = async ({ people: { priya } }, room) => {
  await room.say(priya, "Thanks for backing the onboarding redesign today. It means a lot.");
  await room.say(priya, "Want to look at the empty state together tomorrow? 15 minutes is plenty.");
};

const cakePlans: Script = async ({ people: { leo, maya, jordan } }, room) => {
  await room.say(leo, "Cake for Tomás on Friday? It's his first anniversary here 🎂 Don't tell him!");
  const flavor = await room.say(jordan, "I'll order it. Chocolate or lemon?");
  await room.reply(maya, flavor, "Chocolate, always.");
  await room.say(jordan, "🍫");
};

/** What a deploy pipeline sends a Slack incoming webhook when it's done: a card of Block Kit blocks. */
function deployed(service: string, version: string, environment: string, by: string) {
  const title = `Deployed ${service} ${version} to ${environment}`;
  return {
    text: title,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title } },
      {
        type: "section",
        text: { type: "mrkdwn", text: "Smoke tests passed in *2m 14s*. Nothing to roll back." },
        accessory: { type: "button", text: { type: "plain_text", text: "Release notes" }, url: `https://fernwood.example/releases/${version}`, style: "primary" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: "*Commit*\n`8a1969f`" },
          { type: "mrkdwn", text: `*Started by*\n${by}` },
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: "Took 4m 31s · <https://fernwood.example/deploys/1874|Deploy #1874>" }] },
    ],
  };
}

/** What a monitor sends a Slack incoming webhook about an alert: a legacy attachment in the alert's color. */
function alert(state: "FIRING" | "RESOLVED", color: "danger" | "good", text: string) {
  return {
    text: state === "FIRING" ? "Message API errors are up" : "Message API errors are back to normal",
    attachments: [
      {
        color,
        title: `[${state}] HighErrorRate message-api`,
        title_link: "https://status.fernwood.example/alerts/high-error-rate",
        text,
        mrkdwn_in: ["text"],
        fields: [
          { title: "Severity", value: state === "FIRING" ? "critical" : "resolved", short: true },
          { title: "Region", value: "fra1", short: true },
        ],
        actions: state === "FIRING" ? [{ type: "button", text: "Runbook", url: "https://runbooks.fernwood.example/high-error-rate", style: "danger" }] : [],
        footer: "Uptime",
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  };
}
