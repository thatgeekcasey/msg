import { useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { DirectoryUser, PersonRole, UserId } from "@ember/protocol";
import { Crown, EditPencil, Minus, Prohibition } from "@/components/icons/iconoir";
import { PageLink } from "@/components/page-link";
import type { People } from "@/hooks/use-directory";
import { PROFILE_PATH } from "@/hooks/use-route";
import { byName } from "@/lib/people";
import { cn } from "@/lib/utils";
import { ListRow } from "./list-row";
import { AvatarLink } from "./user-avatar";

// The people on workspace settings, as the Membership section groups them: everyone but bots by name,
// administrators under Admins and members under Members, each group left out while nobody's in it, each
// avatar linking to the person's page, and your own row to your profile. Administrators also see who's
// banned, dimmed under a cancel mark (Campfire's avatars.css), and on each active person's row a crown
// that makes them an administrator or a member again, and, but on their own, Delete, which removes them.
// They see members suspended for their Memberful membership's lapsing too, dimmed and said to be so,
// with Delete.

/** What Delete asks before removing someone. */
export const CONFIRM_REMOVE = "Are you sure you want to permanently remove this person from the account? This can’t be undone.";

interface Props {
  people: People;
  /** Whoever's looking, whose own row has My settings, and whose crown can't be pressed, so there's always an administrator. */
  myId: UserId;
  /** Gives someone another role, settling once it has or failed. Only administrators have it, and the crowns. */
  onChangeRole?: (person: DirectoryUser, role: PersonRole) => Promise<void>;
  /** Removes someone from the workspace, settling once it has or failed. Only administrators have it, and Delete. */
  onRemove?: (person: DirectoryUser) => Promise<void>;
}

/**
 * Who's listed, administrators then members, as an administrator or a member sees them: everyone active,
 * and for administrators, everyone banned or suspended too.
 */
function groupsOf(people: People, administrator: boolean): [DirectoryUser[], DirectoryUser[]] {
  const listed = byName([...people.values()].filter((person) => person.status === "active" || (administrator && person.status !== "deactivated")));
  return [listed.filter((person) => person.role === "administrator"), listed.filter((person) => person.role === "member")];
}

export function PeopleList({ people, myId, onChangeRole, onRemove }: Props) {
  const administrator = onChangeRole !== undefined;
  const [administrators, members] = useMemo(() => groupsOf(people, administrator), [people, administrator]);
  const headingId = useId();
  // A row that changes group is drawn afresh in the other list, so a crown with the focus as its row
  // leaves hands it to the one drawn for the same person, and any not taken by then is let go.
  const focusedCrown = useRef<UserId | null>(null);
  useLayoutEffect(() => {
    focusedCrown.current = null;
  });
  // Roles on their way to the server, which their crowns show until it answers.
  const [changing, setChanging] = useState<ReadonlyMap<UserId, PersonRole>>(new Map());
  // The people being removed, whose Delete waits for the server's answer.
  const [removing, setRemoving] = useState<ReadonlySet<UserId>>(new Set());

  const changeRole = (person: DirectoryUser, role: PersonRole) => {
    setChanging((changing) => new Map(changing).set(person.id, role));
    void onChangeRole?.(person, role).finally(() =>
      setChanging((changing) => {
        const next = new Map(changing);
        next.delete(person.id);
        return next;
      }),
    );
  };

  const remove = (person: DirectoryUser) => {
    if (!onRemove || !confirm(CONFIRM_REMOVE)) return;
    setRemoving((removing) => new Set(removing).add(person.id));
    void onRemove(person).finally(() =>
      setRemoving((removing) => {
        const next = new Set(removing);
        next.delete(person.id);
        return next;
      }),
    );
  };

  const row = (person: DirectoryUser) => {
    const banned = person.status === "banned";
    const suspended = person.status === "suspended";
    const mine = person.id === myId;
    const role = changing.get(person.id) ?? person.role;
    return (
      <ListRow key={person.id} figure={<Avatar person={person} banned={banned} dimmed={banned || suspended} />} name={person.name}>
        {suspended && <span className="shrink-0 text-[0.8em] text-muted-foreground">Membership lapsed</span>}
        {onChangeRole && person.status === "active" && (
          <RoleCrown
            personId={person.id}
            focused={focusedCrown}
            administrator={role === "administrator"}
            mine={mine}
            // A change on its way waits for the server's answer before another.
            onChange={(administrator) => !changing.has(person.id) && changeRole(person, administrator ? "administrator" : "member")}
          />
        )}
        {onRemove && !banned && !mine && <RemoveButton name={person.name} removing={removing.has(person.id)} onClick={() => remove(person)} />}
        {mine && <MySettings />}
      </ListRow>
    );
  };

  const groups = [
    { id: `${headingId}admins`, title: "Admins", people: administrators },
    { id: `${headingId}members`, title: "Members", people: members },
  ];
  return groups.map(
    ({ id, title, people }) =>
      people.length > 0 && (
        // A group, 24px below the one before it, its title over its people.
        <section key={title} aria-labelledby={id} className="[&+&]:mt-6">
          <h2 id={id} className="mb-3 text-base font-semibold">
            {title}
          </h2>
          <menu aria-labelledby={id} className="m-0 flex flex-col gap-x-[1ch] gap-y-4 py-4">
            {people.map(row)}
          </menu>
        </section>
      ),
  );
}

/**
 * Someone's avatar, linking to their page, at 3.75ch, dimmed when they can't sign in, and under a cancel
 * mark when they're banned, which taps go through.
 */
function Avatar({ person, banned, dimmed }: { person: DirectoryUser; banned: boolean; dimmed: boolean }) {
  const avatar = <AvatarLink user={person} className={cn("size-[3.75ch]", dimmed && "[&>img]:opacity-50")} lazy />;
  if (!banned) return avatar;
  return (
    <span className="relative grid shrink-0">
      {avatar}
      <Prohibition className="pointer-events-none absolute inset-0 size-full" />
    </span>
  );
}

/** My settings, a round `.btn.txt-small` with a pencil, on your own row, which opens your profile. */
function MySettings() {
  return (
    <PageLink href={PROFILE_PATH} className="grid size-9 shrink-0 place-items-center rounded-full border bg-background text-[0.8rem] touch:size-11">
      <EditPencil className="size-[1.3em]" />
      <span className="sr-only">My settings</span>
    </PageLink>
  );
}

/**
 * Delete, a round `.btn.txt-small.btn--negative` with a minus, white on red, which darkens under a mouse
 * (buttons.css), and waits while a removal is on its way.
 */
function RemoveButton({ name, removing, onClick }: { name: string; removing: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={removing}
      onClick={onClick}
      className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border border-transparent bg-negative-button text-[0.8rem] text-white touch:size-11 hover:not-active:brightness-70 disabled:pointer-events-none disabled:opacity-50"
    >
      <Minus className="size-[1.3em]" />
      <span className="sr-only">Delete {name}</span>
    </button>
  );
}

interface RoleCrownProps {
  personId: UserId;
  /** Whose crown had the focus as its row left its list, for the crown drawn for them in the other to take. */
  focused: RefObject<UserId | null>;
  administrator: boolean;
  mine: boolean;
  onChange: (administrator: boolean) => void;
}

/**
 * The crown, a round `.btn.txt-small` around a checkbox, reversed while it's checked, for an
 * administrator (buttons.css). Its checkbox is only visually hidden, so it can be reached and pressed
 * without a mouse.
 */
function RoleCrown({ personId, focused, administrator, mine, onChange }: RoleCrownProps) {
  const checkbox = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const input = checkbox.current;
    if (focused.current === personId) input?.focus();
    return () => {
      if (input !== null && document.activeElement === input) focused.current = personId;
    };
  }, [personId, focused]);
  return (
    <label
      className={cn(
        "relative grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border text-[0.8rem] touch:size-11",
        "has-focus-visible:outline-2 has-focus-visible:outline-offset-3 has-focus-visible:outline-foreground",
        administrator ? "bg-primary text-primary-foreground" : "bg-background",
        // Your own, as Campfire's disabled checkbox buttons are.
        mine && "pointer-events-none cursor-not-allowed opacity-50 grayscale contrast-50",
      )}
    >
      <span className="sr-only">Role: {administrator ? "Administrator" : "Member"}</span>
      <Crown className="size-[1.3em]" />
      <input ref={checkbox} type="checkbox" checked={administrator} disabled={mine} onChange={(event) => onChange(event.target.checked)} className="sr-only" />
    </label>
  );
}
