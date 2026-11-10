// Fills a new Ember with a made-up team, Fernwood, and their conversations, to see Ember in use:
// threads, replies quoting what they answer, mentions, reactions, an edit, formatting and code, pictures, a
// video, files, link previews, DMs and bots' cards. It sets Ember up as the team's first person, so it
// takes only an Ember nobody has set up yet:
//
//   pnpm dev
//   pnpm seed                            # in another terminal, for http://localhost:5173
//   pnpm seed https://ember.example.com  # a deployment nobody has set up yet
//
// A deployment takes its setup password, in EMBER_SETUP_PASSWORD, or the setup token its deploy printed,
// in EMBER_SETUP_TOKEN. Everyone's password is
// EMBER_SEED_PASSWORD, or one the seed makes up and prints. To seed `pnpm dev`'s Ember again, stop it
// and delete apps/worker/.wrangler/state, which holds it.

import { isPasswordTooLong, isPasswordTooShort, type RoomId } from "@ember/protocol";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOTS, PEOPLE, WORKSPACE, type Bot, type BotName, type Person, type PersonName } from "./seed/cast.ts";
import { Ember, type BotKey, type SeedFile, type Session } from "./seed/client.ts";
import { converse, DIRECTS, ROOMS, type PlannedRoom, type RoomName } from "./seed/conversations.ts";
import { workerUrl } from "./worker-url.ts";

/** Where `pnpm dev` serves Ember: Vite, which passes on to `wrangler dev` everything the Worker serves. */
const DEV_URL = "http://localhost:5173";

const USAGE = "Usage: pnpm seed [Ember's address], with a deployment's setup password in EMBER_SETUP_PASSWORD, or its setup token in EMBER_SETUP_TOKEN";

const FILES = path.join(import.meta.dirname, "seed", "files");

/** The types of the seed's files, by their extensions. */
const TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** A problem with how the script was run, which exits with 2 rather than 1. */
class UsageError extends Error {}

/** `record`'s entries, by its keys. */
const entries = <K extends string, V>(record: Record<K, V>) => Object.entries(record) as [K, V][];

function file(name: string): SeedFile {
  const type = TYPES[path.extname(name)];
  if (!type) throw new Error(`The seed has no type for ${name}`);
  return { name, type, bytes: readFileSync(path.join(FILES, name)) };
}

const pictureOf = (avatar: string | undefined) => (avatar === undefined ? undefined : file(avatar));

/** Sets an Ember nobody has set up for Fernwood, everyone with `password`, then has them talk. */
async function seed(ember: Ember, password: string): Promise<void> {
  const formOf = ({ name, emailAddress }: Person) => ({ name, emailAddress, password });

  const maya = await ember.setUp(formOf(PEOPLE.maya), pictureOf(PEOPLE.maya.avatar));
  await ember.changeAccount(maya, WORKSPACE);
  await ember.changeLogo(maya, file("fernwood-512.png"), file("fernwood-512.png"), file("fernwood-192.png"));
  const { joinCode } = await ember.settings(maya);
  if (joinCode === null) throw new Error("Ember gave the administrator who set it up no join code");
  const people = { maya } as Record<PersonName, Session>;
  for (const [name, person] of entries<PersonName, Person>(PEOPLE)) {
    people[name] ??= await ember.join(joinCode, formOf(person), pictureOf(person.avatar));
    await ember.changeProfile(people[name], { bio: person.bio });
  }

  const { rooms: firstRooms } = await ember.sidebar(maya);
  const firstRoom = (name: string) => firstRooms.find((room) => room.kind === "open" && room.name === name)!.id;
  const rooms = { general: firstRoom("general"), random: firstRoom("random") } as Record<RoomName, RoomId>;
  for (const [key, { by, privateTo, ...room }] of entries<keyof typeof ROOMS, PlannedRoom>(ROOMS)) {
    const memberIds = privateTo && [by, ...privateTo].map((name) => people[name].user.id);
    rooms[key] = (await ember.createRoom(people[by], memberIds ? { ...room, kind: "closed", memberIds } : { ...room, kind: "open" })).id;
  }
  for (const [key, [by, ...others]] of entries(DIRECTS)) rooms[key] = await ember.startDirect(people[by], others.map((name) => people[name]));

  const bots = {} as Record<BotName, BotKey>;
  for (const [name, bot] of entries<BotName, Bot>(BOTS)) bots[name] = await ember.createBot(maya, bot.name, pictureOf(bot.avatar));
  await ember.star(maya, rooms.launch);
  await ember.dismissInvitation(maya);

  await converse({ ember, people, bots, rooms, file });
}

/** EMBER_SEED_PASSWORD, if it's one Ember takes, or a new one. */
function passwordOf(given: string | undefined): string {
  if (given === undefined) return randomBytes(12).toString("base64url");
  if (isPasswordTooShort(given) || isPasswordTooLong(given)) throw new UsageError("EMBER_SEED_PASSWORD has to be a password Ember takes, of 8 to 72 characters");
  return given;
}

async function main(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  if (args.length > 1) throw new UsageError(USAGE);
  const url = workerUrl(args[0] ?? DEV_URL);
  if (!url) throw new UsageError(`${USAGE}. The address has to be HTTPS, or HTTP on this machine.`);
  const ember = new Ember(url.origin, env.EMBER_SETUP_PASSWORD || env.EMBER_SETUP_TOKEN);
  const password = passwordOf(env.EMBER_SEED_PASSWORD);
  if (await ember.isSetUp()) {
    const startOver = ember.origin === DEV_URL ? " To start `pnpm dev`'s over, stop it and delete apps/worker/.wrangler/state." : "";
    throw new UsageError(`${ember.origin} is set up already, and the seed fills only an Ember nobody has set up.${startOver}`);
  }
  // Said before anyone is made, since a seed that fails after that can't be run again to say it.
  console.log(`Seeding ${ember.origin}, with the password ${password} for everyone.`);
  await seed(ember, password);
  const width = Math.max(...Object.values(PEOPLE).map(({ name }) => name.length));
  const accounts = Object.values(PEOPLE).map(({ name, emailAddress }, index) => `  ${name.padEnd(width)}  ${emailAddress}${index === 0 ? "  (administrator)" : ""}`);
  return [`${WORKSPACE.name} is ready at ${ember.origin}. Sign in as anyone, with that password:`, ...accounts].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(await main(process.argv.slice(2), process.env));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
