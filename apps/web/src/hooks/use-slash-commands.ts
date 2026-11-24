import { useContext, useEffect, useRef } from "react";
import { MESSAGE_TOO_LONG, searchPath, startingInvolvement, type Involvement, type Me, type Room, type RoomId, type SharedRoom, type SidebarRoom, type User } from "@ember/protocol";
import { roomIdsIn, writtenBody } from "@ember/richtext/dom";
import { useFlash } from "@/components/flash";
import { useJoinsNoHuddle } from "@/components/workspace/huddle-button";
import { OpenSearchContext } from "@/components/workspace/search-box";
import { changeMembers, changeRoom, CONFIRM_LEAVE, fetchRoomSettings, leaveRoom, setInvolvement, startDirect } from "@/lib/api";
import { chooseAppearance } from "@/lib/appearance";
import { roomName, toSentence } from "@/lib/directs";
import { hasHuddles } from "@/lib/huddle-people";
import { sendAway } from "@/lib/outbox";
import type { RoomAnswer } from "@/lib/room-list";
import { bodyAfter, commandsIn, isBlankBody, mentionAfter, personNamedIn, roomMentionAfter, roomNamedIn, type CommandName, type CommandRunner, type SlashCommand, type Taken } from "@/lib/slash-commands";
import { useAccount } from "./use-account";
import { PeopleContext, useNameOf } from "./use-directory";
import { isTooLong, pendingMessage } from "./use-room";
import { huddlePath, navigate, roomPath, roomSettingsPath } from "./use-route";

interface Options {
  room: Room;
  me: Me;
  /** This person's level in the room. */
  involvement: Involvement;
  /** This person's rooms, as their sidebar has them, hidden ones too. */
  rooms: SidebarRoom[];
  /** Has the sidebar list a room as the server answers a change to it. */
  askForRoom: () => (answer: RoomAnswer) => void;
  /** Says why a command failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
  /** Opens New direct message, the DMs, giving focus back to `opener` as it closes. */
  onOpenDirects: (opener: HTMLElement | null) => void;
  onOpenShortcuts: () => void;
  /** Sends a message to the room, answering whether it went. */
  onSend: (body: string) => boolean;
}

/** What /msg sends to, and how it's named after the command. */
interface Recipient {
  roomId: () => Promise<RoomId>;
  name: string;
  taken: Taken;
  /** The room, unless it's a DM, whose people a message to it can notify. */
  room?: SharedRoom;
}

/**
 * Slack's commands that Ember can do in `room`, which / lists, and what runs each but /shrug and
 * /snippet, which the composer runs itself: as Slack's do, with a room where Slack has a channel, saying
 * what they did, or why they couldn't, over the page. Where a command needs more than it's given, such as
 * /invite with nobody named, it opens the page that asks for it.
 */
export function useSlashCommands({ room, me, involvement, rooms, askForRoom, onFailed, onOpenDirects, onOpenShortcuts, onSend }: Options): {
  commands: SlashCommand[];
  run: CommandRunner;
} {
  const flash = useFlash();
  const people = useContext(PeopleContext);
  const openSearch = useContext(OpenSearchContext);
  const nameOf = useNameOf();
  const joinsNone = useJoinsNoHuddle();
  const huddlesOn = useAccount().huddles;
  const huddles = huddlesOn && hasHuddles(room, me.id, joinsNone);
  const shared = rooms.filter((r): r is SidebarRoom & SharedRoom => r.kind !== "direct");
  // How a room is named after a command: by its name after a #, or a DM by whom it's with.
  const named = (r: Room) => (r.kind === "direct" ? roomName(r, me.id, nameOf) : `#${r.name}`);
  // What's said of a command that can't run as written, which stays to be put right.
  const refuse = (alert: string) => {
    flash("alert", alert);
    return false;
  };
  const focused = () => (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  // Whether the room's view is still open, which a command can find it isn't by the time it sends, as when
  // the room's been left while /msg asked for its DM.
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  /**
   * The people named after an @ at the start of `argument`, one after another, and what follows them. Two
   * people can share a name, so each mention of it names the next of them mentioned, in turn, and once
   * they're all found, whom it named before.
   */
  const peopleIn = (argument: string, mentions: User[]) => {
    const found: User[] = [];
    const isFound = (person: User) => found.some(({ id }) => id === person.id);
    for (let rest = argument; ; ) {
      const next = personNamedIn(rest, [...mentions.filter((person) => !isFound(person)), ...found], people.values());
      if (!next) return { found, rest };
      if (!isFound(next.named)) found.push(next.named);
      rest = next.rest;
    }
  };

  /** This person's rooms that `markup` mentions, as the # list writes them. */
  const roomsMentionedIn = (markup: string) => roomIdsIn(markup).flatMap((id) => shared.filter((r) => r.id === id));

  /**
   * The room `argument` names after a #, one `markup` mentions first, as two rooms can share a name, or this
   * one, where it names none; undefined where it names one that isn't this person's.
   */
  const roomIn = (argument: string, markup: string): Room | undefined => (argument === "" ? room : roomNamedIn(argument, roomsMentionedIn(markup), shared)?.named);

  const runners: Record<Exclude<CommandName, "shrug" | "snippet">, CommandRunner> = {
    darkmode: async () => {
      chooseAppearance(document.documentElement.classList.contains("dark") ? "light" : "dark");
      return true;
    },
    dm: async () => {
      onOpenDirects(focused());
      return true;
    },
    huddle: async () => {
      if (huddlesOn && !huddles) return refuse("There's nobody here to huddle with.");
      // As the huddle's link does: it offers the huddle, or opens it, once the tab is in it.
      navigate(huddlePath(room.id));
      return true;
    },
    invite: async ({ typed, markup, mentions }) => {
      const { found, rest } = peopleIn(typed.argument, mentions);
      if (rest.startsWith("@")) return refuse("Pick whom to add from the list @ shows.");
      const target = roomIn(rest, markup);
      if (!target) return refuse("Name a room you're in after the #.");
      if (target.kind === "direct") return refuse("Nobody can be added to a direct message.");
      if (target.kind === "open") {
        flash("notice", `Everyone is in #${target.name} already.`);
        return true;
      }
      // Slack's /invite alone asks whom to add, as the room's settings do.
      if (found.length === 0) {
        navigate(roomSettingsPath("closed", target.id));
        return true;
      }
      const settings = await fetchRoomSettings(target.id);
      if (!settings.canAdminister) return refuse(`Only administrators and the room's creator can add people to #${target.name}.`);
      const offered = new Set(settings.people.map((person) => person.id));
      const members = settings.people.filter((person) => person.member).map((person) => person.id);
      const refused = found.filter((person) => !offered.has(person.id));
      if (refused.length > 0) return refuse(`${toSentence(refused.map(nameOf))} can't be added to a room.`);
      const added = found.filter((person) => !members.includes(person.id));
      if (added.length === 0) {
        flash("notice", `${toSentence(found.map(nameOf))} ${found.length === 1 ? "is" : "are"} in #${target.name} already.`);
        return true;
      }
      // Only whom it names, so it undoes nothing changed in the room since its settings were read.
      const answered = askForRoom();
      answered({ type: "saved", room: await changeMembers(target.id, { addedIds: added.map((person) => person.id), removedIds: [] }) });
      flash("notice", `Added ${toSentence(added.map(nameOf))} to #${target.name}.`);
      return true;
    },
    leave: async () => {
      if (room.kind === "direct") return refuse("A direct message can't be left, though /mute turns its notifications off.");
      if (room.kind === "open") {
        // Everyone's in an open room, so leaving it, as Slack has it, is hiding it from the sidebar.
        const answered = askForRoom();
        answered({ type: "involved", roomId: room.id, involvement: await setInvolvement(room.id, "invisible") });
        flash("notice", `#${room.name} is hidden from your sidebar.`);
      } else {
        // As the room's settings ask.
        if (!confirm(CONFIRM_LEAVE)) return true;
        const answered = askForRoom();
        await leaveRoom(room.id);
        answered({ type: "gone", roomId: room.id });
      }
      // Unless another room's been opened meanwhile.
      if (open.current) navigate("/");
      return true;
    },
    msg: async ({ typed, markup, mentions }, askToNotify) => {
      const to = recipientOf(typed.name.length + 1, typed.argument, markup, mentions);
      if (!to) return refuse("Write /msg, then @someone or #room, then your message.");
      const body = bodyAfter(markup, typed.name.length + 1, to.taken);
      const roomId = await to.roomId();
      if (isBlankBody(body)) {
        // Unless another room's been opened while /msg asked for its DM.
        if (open.current) navigate(roomPath(roomId));
        return true;
      }
      // As one written there would, it asks first where it would notify six or more in the room.
      if (to.room && !(await askToNotify(to.room, body))) return false;
      // Written here, while the room's view is open to show it; once it's gone, it goes as to any other room.
      if (roomId === room.id && open.current) return onSend(body);
      const { plainText, mentions: mentioned } = writtenBody(body);
      if (isTooLong(body, plainText)) return refuse(MESSAGE_TOO_LONG);
      // Sent as one written in that room while it was away would be, which shows there as it's opened, and
      // said to be sent once the room has it. One that wasn't sent is written again, to send again, but not
      // one that may have gone, which could go twice: the room shows it, sent or not.
      const message = { ...pendingMessage(crypto.randomUUID(), roomId, me, body, plainText, mentioned, new Date().toISOString()), queued: true };
      const sent = await sendAway(roomId, message);
      if (sent === "not sent") return refuse(`Your message to ${to.name} wasn't sent.`);
      if (sent === "unconfirmed") flash("alert", `Your message to ${to.name} may not have gone yet. If it doesn't, it shows there as not sent.`);
      else flash("notice", `Sent to ${to.name}.`);
      return true;
    },
    mute: async ({ typed, markup }) => {
      const target = roomIn(typed.argument, markup);
      if (!target) return refuse("Name a room you're in after the #.");
      const level = target.id === room.id ? involvement : (rooms.find((r) => r.id === target.id)?.involvement ?? startingInvolvement(target));
      const muted = level === "nothing" || level === "invisible";
      const answered = askForRoom();
      answered({ type: "involved", roomId: target.id, involvement: await setInvolvement(target.id, muted ? startingInvolvement(target) : "nothing") });
      flash("notice", `${muted ? "Unmuted" : "Muted"} ${named(target)}.`);
      return true;
    },
    remove: async ({ typed, mentions }) => {
      if (room.kind !== "closed") return refuse(room.kind === "open" ? `Everyone is in #${room.name}, so nobody can be taken out of it.` : "Nobody can be taken out of a direct message.");
      const { found, rest } = peopleIn(typed.argument, mentions);
      if (found.length === 0 || rest !== "") return refuse("Pick whom to remove from the list @ shows.");
      const settings = await fetchRoomSettings(room.id);
      if (!settings.canAdminister) return refuse(`Only administrators and the room's creator can take people out of #${room.name}.`);
      const members = settings.people.filter((person) => person.member).map((person) => person.id);
      const removed = found.filter((person) => members.includes(person.id));
      if (removed.length === 0) {
        flash("notice", `${toSentence(found.map(nameOf))} ${found.length === 1 ? "isn't" : "aren't"} in #${room.name}.`);
        return true;
      }
      const leaving = removed.some((person) => person.id === me.id);
      // Only whom it names, as for /invite.
      const answered = askForRoom();
      const saved = await changeMembers(room.id, { addedIds: [], removedIds: removed.map((person) => person.id) });
      answered(leaving ? { type: "gone", roomId: room.id } : { type: "saved", room: saved });
      flash("notice", `Removed ${toSentence(removed.map(nameOf))} from #${room.name}.`);
      // Home, as after /leave, unless another room's been opened meanwhile.
      if (leaving && open.current) navigate("/");
      return true;
    },
    rename: async ({ typed }) => {
      if (room.kind === "direct") return refuse("A direct message is named after the people in it.");
      // Slack's /rename alone asks for the name, as the room's settings do.
      if (typed.argument === "") {
        navigate(roomSettingsPath(room.kind, room.id));
        return true;
      }
      const answered = askForRoom();
      const saved = await changeRoom(room.id, { name: typed.argument });
      answered({ type: "saved", room: saved });
      flash("notice", `Renamed the room #${saved.name}.`);
      return true;
    },
    search: async ({ typed }) => {
      if (typed.argument === "") openSearch({ opener: focused(), roomId: room.id });
      else navigate(searchPath({ q: typed.argument }));
      return true;
    },
    shortcuts: async () => {
      onOpenShortcuts();
      return true;
    },
  };

  /**
   * Whom or where /msg sends to: whom it mentions first thing, as the @ list writes them, or whom it names
   * after an @ as typed, in a DM with them, started if they have none, or the room it mentions first thing,
   * as the # list writes it, or names after a # as typed.
   */
  function recipientOf(length: number, argument: string, markup: string, mentions: User[]): Recipient | null {
    const mentioned = mentionAfter(markup, length);
    const person = mentioned ? (people.get(mentioned) ?? mentions.find(({ id }) => id === mentioned)) : personNamedIn(argument, [], people.values())?.named;
    if (person) {
      return {
        name: nameOf(person),
        taken: mentioned ? "mention" : person.name.length + 1,
        roomId: async () => {
          const answered = askForRoom();
          const direct = await startDirect([person.id]);
          answered({ type: "saved", room: direct });
          return direct.id;
        },
      };
    }
    const mentionedRoom = roomMentionAfter(markup, length);
    const to = mentionedRoom ? shared.find(({ id }) => id === mentionedRoom) : roomNamedIn(argument, [], shared)?.named;
    return to ? { name: `#${to.name}`, taken: mentionedRoom ? "mention" : to.name.length + 1, roomId: async () => to.id, room: to } : null;
  }

  return {
    commands: commandsIn(room, huddles),
    run: async (written, askToNotify) => {
      const runner = runners[written.command.name as keyof typeof runners];
      try {
        return await runner(written, askToNotify);
      } catch (error) {
        onFailed(error);
        return false;
      }
    },
  };
}
