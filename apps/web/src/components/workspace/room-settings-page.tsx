import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Me, RoomChanges, RoomIconName, RoomId, RoomSettings, SectionChoice, UserId } from "@ember/protocol";
import { Button } from "@/components/ui/button";
import { useAccount } from "@/hooks/use-account";
import { useMounted } from "@/hooks/use-mounted";
import { navigate, roomPath, roomSettingsPath, type Access } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import { LogOut, Trash } from "@/components/icons/iconoir";
import { ApiError, changeRoom, CONFIRM_LEAVE, deleteRoom, fetchRoomSettings, isSignedOut, leaveRoom } from "@/lib/api";
import type { RoomAnswer } from "@/lib/room-list";
import { HuddlesContext } from "./huddle-button";
import { AccessSwitch, CheckMark, RoomForm, withChoice } from "./room-form";
import { workspaceSectionPath } from "./settings-navigation";
import { PageHeading, Panel, SettingsPage } from "./settings-page";
import { UnsavedChanges } from "./unsaved-changes";

/** Whether `error` says the room isn't there for this person. */
export const isMissing = (error: unknown) => error instanceof ApiError && error.status === 404;

/** What Delete asks first, in the browser's own dialog. */
export const CONFIRM_DELETE = "Are you sure you want to delete this room and all messages in it? This can’t be undone.";

const membersOf = (settings: RoomSettings) => new Set(settings.people.flatMap((person) => (person.member ? [person.id] : [])));

const sameMembers = (a: ReadonlySet<UserId>, b: ReadonlySet<UserId>) => a.size === b.size && [...a].every((id) => b.has(id));

/** Whether a room's settings allow huddles in it, which they do until they say not. */
const allowsHuddles = (settings: RoomSettings) => settings.room.huddles !== false;

/** Whether a room's settings let @channel, @here and @everyone notify it, which they do until they say not. */
const allowsChannelMentions = (settings: RoomSettings) => settings.room.channelMentions !== false;

/** Whether two choices of section are the same: the same section, none, or a new one of the same name. */
const sameSection = (a: SectionChoice, b: SectionChoice) => (typeof a === "object" && a !== null && typeof b === "object" && b !== null ? a.name === b.name : a === b);

interface Props {
  roomId: RoomId;
  /** Which of the two forms the address names. */
  access: Access;
  me: Me;
  /**
   * Called as the room is saved or deleted, with what lists it, for the sidebar, as the server answers:
   * as saved, or gone once it's saved without this person, or deleted. The page then shows the room, or
   * goes home, unless it was left first.
   */
  askForRoom: () => (answer: RoomAnswer) => void;
  /** For a room this person isn't in, one that doesn't exist, or a DM. */
  onMissing: () => void;
  /** Says why something else failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * A room's settings. Whoever can change the room renames it, and with the Everyone switch, which swaps
 * one form for the other in place, opens it to everyone or makes it private to the people whose switches
 * are on; under the form, they can delete it. Leaving with changes asks first. Where huddles are on,
 * an administrator's form has the Huddles switch, which says whether the room allows them, as a Slack
 * channel's settings do for its workspace's owners and admins, and every administrator's has the
 * Room-wide mentions switch, which says whether @channel, @here and @everyone notify it. Whoever can
 * change the room picks its sidebar section too, and an administrator can make one there. Everyone else
 * sees the room's name and people, in the form for its kind, and can leave a private room, and whoever
 * has no Huddles switch, or no Room-wide mentions switch, the room's creator among them, reads that the
 * room has no huddles, or that those mentions notify nobody there, when that's so. The server refuses the
 * last of its people who could open it, saying why: the page can't tell who they are, as it lists
 * active people, bots among them, and none who are suspended.
 */
export function RoomSettingsPage({ roomId, access, me, askForRoom, onMissing, onFailed }: Props) {
  const [settings, setSettings] = useState<RoomSettings | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<RoomIconName | null>(null);
  // The section picked, and the one the room is in, as loaded or last saved, which is sent only once another is picked.
  const [section, setSection] = useState<SectionChoice>(null);
  const [savedSection, setSavedSection] = useState<SectionChoice>(null);
  // Who the private form lets in, starting with the room's members.
  const [chosen, setChosen] = useState<ReadonlySet<UserId>>(new Set());
  // Whether the Huddles and Room-wide mentions switches are on, starting as the room's settings have them.
  const [huddles, setHuddles] = useState(true);
  const [channelMentions, setChannelMentions] = useState(true);
  const huddlesOn = useAccount().huddles;
  // Whether a huddle is going on in the room, which turning huddles off there would end.
  const live = useContext(HuddlesContext).live[roomId] !== undefined;
  // Saving or deleting, either of which keeps both buttons from being pressed until it answers.
  const [busy, setBusy] = useState(false);
  // The form the page opened on, which the Everyone switch can move away from and back to, or the one
  // last saved.
  const [opened, setOpened] = useState(access);
  // How many times saving or deleting the room has started here, so that settings loaded again before
  // one neither undo what it saves nor speak for it.
  const changesStarted = useRef(0);
  const roomForm = useRef<HTMLFormElement>(null);
  const mounted = useMounted();
  useTitle(settings && `Edit settings for ${settings.room.name}`);

  useEffect(() => {
    let stopped = false;
    fetchRoomSettings(roomId).then(
      (settings) => {
        if (stopped) return;
        setSettings(settings);
        setName(settings.room.name);
        setIcon(settings.room.icon);
        setSection(settings.section?.id ?? null);
        setSavedSection(settings.section?.id ?? null);
        setChosen(membersOf(settings));
        setHuddles(allowsHuddles(settings));
        setChannelMentions(allowsChannelMentions(settings));
      },
      (error: unknown) => {
        // A page left before its settings load only reports a session that's ended, which goes to sign in.
        if (stopped && !isSignedOut(error)) return;
        if (isMissing(error)) onMissing();
        else onFailed(error);
      },
    );
    return () => void (stopped = true);
  }, [roomId, onMissing, onFailed]);

  // Whoever can change the room picks the form; anyone else sees the one for its kind, as the other
  // would describe the room wrongly.
  const kind = settings && !settings.canAdminister ? settings.room.kind : null;
  useEffect(() => {
    if (kind && kind !== access) navigate(roomSettingsPath(kind, roomId), { replace: true });
  }, [kind, access, roomId]);

  // An answer that comes after the page was left changes the sidebar, but leaves the page shown then alone.
  const failed = (error: unknown) => {
    // Once the page is left, only a session that's ended matters, which goes to sign in from any page.
    if (!mounted.current && !isSignedOut(error)) return;
    setBusy(false);
    if (isMissing(error)) onMissing();
    else onFailed(error);
  };

  /**
   * Saves the form, then lists the room as saved, or takes it out of the sidebar if it's saved without
   * this person, settling with whether it was. The form is then compared with what's saved.
   */
  const send = () => {
    // A switch is sent only where it shows, so saving a room while huddles are off, or as anyone but an administrator, leaves its own setting alone.
    const kept = {
      name,
      icon: icon ?? "",
      ...(huddlesOn && settings?.canChangeHuddles && { huddles }),
      // The Room-wide mentions switch is sent only once it's moved, as the section is.
      ...(settings?.canChangeChannelMentions && channelMentions !== allowsChannelMentions(settings) && { channelMentions }),
      // The section is sent only once another is picked, so one deleted since the page loaded isn't refused.
      ...(!sameSection(section, savedSection) && { section }),
    } satisfies RoomChanges;
    const changes: RoomChanges = access === "open" ? { ...kept, kind: access } : { ...kept, kind: access, memberIds: [...chosen] };
    const leaving = access === "closed" && !chosen.has(me.id);
    const answered = askForRoom();
    changesStarted.current++;
    return changeRoom(roomId, changes).then((room) => {
      answered(leaving ? { type: "gone", roomId: room.id } : { type: "saved", room });
      // An open room takes in everyone.
      setSettings((settings) => settings && { ...settings, room, people: settings.people.map((person) => ({ ...person, member: access === "open" || chosen.has(person.id) })) });
      setOpened(access);
      setSavedSection(section);
      return leaving;
    });
  };

  const save = () => {
    setBusy(true);
    send().then((left) => {
      if (!mounted.current) return;
      // Saved, the room shows, or sends someone no longer in it home with its alert.
      if (left) onMissing();
      else navigate(roomPath(roomId));
    }, failed);
  };

  /**
   * Once the unsaved changes dialog has saved the room with a new section and the page stays, as it does
   * when signing out fails, the section shows by its name, as the menu then lists it, rather than as one
   * still to make: the settings load again for it, since what saving answers is the room alone.
   */
  const showSectionMade = () => {
    if (typeof section !== "object" || section === null) return;
    const made = section;
    const asked = changesStarted.current;
    // Once the room is being saved or deleted again, what these settings say is from before that, and how
    // it goes is that change's to say.
    const outrun = () => !mounted.current || changesStarted.current !== asked;
    fetchRoomSettings(roomId).then(
      (loaded) => {
        if (outrun()) return;
        setSettings((settings) => settings && { ...settings, sections: loaded.sections });
        const sectionId = loaded.section?.id ?? null;
        setSavedSection(sectionId);
        // Unless another has been picked since.
        setSection((picked) => (sameSection(picked, made) ? sectionId : picked));
      },
      (error: unknown) => {
        // As ever, a session that's ended goes to sign in, from any page.
        if (outrun() && !isSignedOut(error)) return;
        if (isMissing(error)) onMissing();
        else onFailed(error);
      },
    );
  };

  /** Once `question` is confirmed, has `go` take the room from this person, then from the sidebar. */
  const goOnceConfirmed = (question: string, go: (roomId: RoomId) => Promise<void>) => {
    if (!confirm(question)) return;
    setBusy(true);
    const answered = askForRoom();
    changesStarted.current++;
    go(roomId).then(() => {
      answered({ type: "gone", roomId });
      // Gone, it goes home, with no alert.
      if (mounted.current) navigate("/");
    }, failed);
  };

  const open = access === "open";
  const flip = () => navigate(roomSettingsPath(open ? "closed" : "open", roomId), { replace: true });
  // Whether the form differs from how it loaded or was last saved, the form its address names included.
  // Saving or deleting isn't guarded.
  const changed =
    !!settings?.canAdminister &&
    !busy &&
    (name !== settings.room.name ||
      icon !== settings.room.icon ||
      !sameSection(section, savedSection) ||
      access !== opened ||
      (huddlesOn && huddles !== allowsHuddles(settings)) ||
      channelMentions !== allowsChannelMentions(settings) ||
      (!open && !sameMembers(chosen, membersOf(settings))));
  // The Huddles row is there while huddles are on: with its switch for an administrator, and for anyone
  // else, the room's creator too, only where the room has none, to say so.
  const huddlesRow = !huddlesOn || !settings ? null : settings.canChangeHuddles ? { allowed: huddles, onChange: setHuddles, live } : allowsHuddles(settings) ? null : { allowed: false };
  // The Room-wide mentions row has its switch for an administrator, and for anyone else only says they
  // notify nobody, where they don't.
  const channelMentionsRow = !settings
    ? null
    : settings.canChangeChannelMentions
      ? { allowed: channelMentions, onChange: setChannelMentions }
      : allowsChannelMentions(settings)
        ? null
        : { allowed: false };
  // The Everyone switch moves between the room's two forms, keeping the draft.
  const stays = useCallback((path: string) => path === roomSettingsPath("open", roomId) || path === roomSettingsPath("closed", roomId), [roomId]);
  return (
    // Go Back returns to Rooms and permissions.
    <SettingsPage back={workspaceSectionPath("channel-settings")}>
      <Panel aria-busy={settings === null}>
        <PageHeading title="Room settings">Manage the room name, access, and members.</PageHeading>
        {settings && (
          <RoomForm
            canAdminister={settings.canAdminister}
            name={settings.canAdminister ? name : settings.room.name}
            onNameChange={setName}
            icon={icon}
            onIconChange={setIcon}
            section={{ sections: settings.sections, value: section, onChange: setSection, canMake: me.administrator }}
            // The private form has the Everyone row only for whoever can change the room.
            everyone={settings.canAdminister ? { on: open, onFlip: flip } : open ? { on: true } : null}
            // A private room lists its members first.
            groups={open ? [settings.people] : [settings.people.filter((p) => p.member), settings.people.filter((p) => !p.member)]}
            mark={(person) =>
              settings.canAdminister &&
              (open ? (
                <CheckMark />
              ) : (
                <AccessSwitch person={person} checked={chosen.has(person.id)} onCheckedChange={(checked) => setChosen((chosen) => withChoice(chosen, person, checked))} />
              ))
            }
            huddles={huddlesRow}
            channelMentions={channelMentionsRow}
            saving={busy}
            onSave={save}
            ref={roomForm}
          />
        )}
      </Panel>
      {settings && !settings.canAdminister && settings.room.kind === "closed" && (
        <Panel>
          <Button type="button" variant="outline" disabled={busy} onClick={() => goOnceConfirmed(CONFIRM_LEAVE, leaveRoom)} className="max-w-full touch:h-11">
            <LogOut className="size-[1.3em] shrink-0" />
            <span className="truncate">Leave {settings.room.name}</span>
          </Button>
        </Panel>
      )}
      {settings?.canAdminister && (
        <Panel>
          <DeleteButton label={`Delete ${settings.room.name}`} text={settings.room.name} disabled={busy} onClick={() => goOnceConfirmed(CONFIRM_DELETE, deleteRoom)} />
        </Panel>
      )}
      <UnsavedChanges changed={changed} stays={stays} onSave={send} onStayAfterSave={showSectionMade} form={roomForm} />
    </SettingsPage>
  );
}

/** Campfire's `.btn.btn--negative` (buttons.css): red, with its icon white in both modes, and 36px tall in a panel. */
export const NEGATIVE_BUTTON =
  "inline-flex min-h-9 max-w-full cursor-pointer items-center justify-center gap-[0.5em] rounded-[9px] border border-transparent bg-negative-button px-[1.1em] py-[0.5em] text-start font-medium text-white touch:min-h-11 hover:not-active:brightness-70 disabled:pointer-events-none disabled:opacity-50 disabled:grayscale disabled:contrast-50";

/**
 * A room's Delete, and a DM's Delete Ping: a negative button with a trash can.
 */
export function DeleteButton({ label, text, disabled, onClick }: { label: string; text: string; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className={NEGATIVE_BUTTON}>
      <Trash className="size-[1.3em] shrink-0" />
      <span className="truncate">{text}</span>
    </button>
  );
}
