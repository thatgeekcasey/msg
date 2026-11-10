import { useState } from "react";
import type { DirectRoom, User } from "@ember/protocol";
import { useNameOf } from "@/hooks/use-directory";
import { useMounted } from "@/hooks/use-mounted";
import { navigate } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import { deleteRoom, isSignedOut } from "@/lib/api";
import { membersShown, roomName } from "@/lib/directs";
import type { RoomAnswer } from "@/lib/room-list";
import { DeleteButton, isMissing } from "./room-settings-page";
import { Panel, SettingsPage } from "./settings-page";
import { AvatarLink } from "./user-avatar";

/** What Delete Ping asks first, in the browser's own dialog. */
export const CONFIRM_DELETE_DIRECT = "Are you sure you want to delete this ping and all messages in it? This can’t be undone.";

interface Props {
  room: DirectRoom;
  me: User;
  /** Where Go Back goes: the last room visited. */
  back: string;
  /** Called as the DM is deleted, with what lists it, for the sidebar, as the server answers. */
  askForRoom: () => (answer: RoomAnswer) => void;
  /** For a DM someone else has deleted since. */
  onMissing: () => void;
  /** Says why something else failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * DM settings: a card for each of the others in the DM, or for you in your DM with yourself, then Delete
 * Ping, which any of its members can press, and which goes home once the DM is deleted. Its members
 * never change, so there's nothing to save.
 */
export function DirectSettingsPage({ room, me, back, askForRoom, onMissing, onFailed }: Props) {
  const nameOf = useNameOf();
  const [busy, setBusy] = useState(false);
  const mounted = useMounted();
  const title = `Edit settings for ${roomName(room, me.id, nameOf)}`;
  useTitle(title);

  const remove = () => {
    if (!confirm(CONFIRM_DELETE_DIRECT)) return;
    setBusy(true);
    const answered = askForRoom();
    deleteRoom(room.id).then(
      () => {
        answered({ type: "gone", roomId: room.id });
        // Home once the DM's deleted, with no alert.
        if (mounted.current) navigate("/");
      },
      (error: unknown) => {
        // Once the page is left, only a session that's ended matters, which goes to sign in from any page.
        if (!mounted.current && !isSignedOut(error)) return;
        setBusy(false);
        if (isMissing(error)) onMissing();
        else onFailed(error);
      },
    );
  };

  return (
    <SettingsPage back={back}>
      <Panel className="text-center">
        {/* The page shows no heading, so this one is for screen readers only. */}
        <h1 className="sr-only">{title}</h1>
        {/* Campfire's `.directs--edit` (sidebar.css), two to a row at 900px and below. */}
        <section className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(33%,1fr))] grid-rows-[min-content] place-items-center gap-[1ch] max-md:grid-cols-2">
          {membersShown(room, me.id).map((member) => (
            <MemberCard key={member.id} member={member} name={nameOf(member)} />
          ))}
        </section>
        <DeleteButton label="Delete Ping" text="Ping" disabled={busy} onClick={remove} />
      </Panel>
    </SettingsPage>
  );
}

/**
 * Campfire's `.member` card (sidebar.css): a square of the sidebar's shade with the person's avatar,
 * 10ch across, over their name in bold, which wraps rather than run out of the card.
 */
function MemberCard({ member, name }: { member: User; name: string }) {
  return (
    <div className="flex aspect-square w-full flex-col place-content-center gap-x-[1ch] gap-y-4 rounded-[10px] border bg-surface px-[1ch] py-4">
      <AvatarLink user={member} lazy className="mx-auto size-[10ch]" />
      <strong className="wrap-anywhere">{name}</strong>
    </div>
  );
}
