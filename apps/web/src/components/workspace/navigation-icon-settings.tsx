import { useRef, useState, type FormEvent } from "react";
import { DEFAULT_NAVIGATION_ICONS, NAVIGATION_SLOTS, type Account, type NavigationIconChanges, type NavigationSlot } from "@ember/protocol";
import { SubmitButton } from "@/components/field";
import { useFlash } from "@/components/flash";
import { iconLabel } from "@/components/icons/room-icon-label";
import { useAccount } from "@/hooks/use-account";
import { useMounted } from "@/hooks/use-mounted";
import { changeAccount, isSignedOut } from "@/lib/api";
import { IconDialog, IconTrigger, type IconDialogHandle } from "./icon-picker";
import { SlotIcon } from "./navigation-icon";
import { CHANGES_SAVED, PageHeading, Panel, SECTION_HEADING } from "./settings-page";

/** What each slot is called. */
const SLOT_LABELS: Record<NavigationSlot, string> = {
  home: "Home",
  dms: "DMs",
  activity: "Activity",
  search: "Search",
  admin: "Admin",
  light: "Light mode",
  dark: "Dark mode",
  system: "System appearance",
};

interface Props {
  /**
   * Called as Save changes saves the icons. What it returns is called with the workspace the server
   * answers, for the rail and the appearance menu to show.
   */
  askForAccount: () => (account: Account) => void;
  /** Says why saving failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
  /** While the page loads, before it knows whoever's looking may change them. */
  loading?: boolean;
  /** Where the catalog comes from. */
  catalogUrl?: string;
}

/**
 * A picker for each of the rail's buttons and the appearance modes, two to a row, or one on screens up
 * to 600px wide, which open one dialog of icons. The project's owner moved them to Custom styles, so
 * they're a section of their own, which its own Save changes saves, saying "Changes saved." as General's
 * does.
 */
export function NavigationIconSettings({ askForAccount, onFailed, loading = false, catalogUrl }: Props) {
  const { navigationIcons } = useAccount();
  // The slots given another icon here that Save changes hasn't saved yet: each an icon, or "" for its
  // default. Only these are sent, so that saving never puts back what another tab changed in the others.
  const [changes, setChanges] = useState<NavigationIconChanges>({});
  const [saving, setSaving] = useState(false);
  const flash = useFlash();
  const mounted = useMounted();
  const dialog = useRef<IconDialogHandle>(null);

  const save = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const answered = askForAccount();
    const sent = changes;
    changeAccount({ navigationIcons: sent }).then(
      (account) => {
        answered(account);
        if (!mounted.current) return;
        setSaving(false);
        // Each icon saved shows as the workspace has it now, unless another's been chosen since.
        setChanges((changes) => Object.fromEntries(Object.entries(changes).filter(([slot, icon]) => icon !== sent[slot as NavigationSlot])));
        flash("notice", CHANGES_SAVED);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        onFailed(error);
      },
    );
  };

  return (
    // Headed as workspace settings' sections are.
    <Panel aria-labelledby="navigation-icons-heading" aria-busy={loading} className="flex flex-col gap-6">
      <PageHeading id="navigation-icons-heading" title="Navigation icons" className={SECTION_HEADING}>
        Choose the icons in your community’s left navigation. Changes apply to everyone.
      </PageHeading>
      <form onSubmit={save} className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-3 upto-600px:grid-cols-1">
          {NAVIGATION_SLOTS.map((slot) => {
            const changed = changes[slot];
            const icon = changed === undefined ? (navigationIcons[slot] ?? null) : changed || null;
            return (
              <IconTrigger
                key={slot}
                label={`Choose ${SLOT_LABELS[slot]} icon`}
                preview={<SlotIcon slot={slot} icon={icon} size={23} className="size-[23px]" />}
                title={SLOT_LABELS[slot]}
                subtitle={icon ? iconLabel(icon, "navigation") : "Default icon"}
                disabled={loading || saving}
                onOpen={(trigger) =>
                  dialog.current?.open({
                    icon,
                    defaultIcon: DEFAULT_NAVIGATION_ICONS[slot],
                    defaultLabel: "Default icon",
                    // The default's own icon is saved as the default.
                    apply: (chosen) => setChanges((changes) => ({ ...changes, [slot]: chosen === DEFAULT_NAVIGATION_ICONS[slot] ? "" : (chosen ?? "") })),
                    trigger,
                  })
                }
              />
            );
          })}
        </div>
        <IconDialog
          ref={dialog}
          context="navigation"
          title="Choose a navigation icon"
          description="Recommendations for your navigation buttons and appearance modes."
          group="Navigation icons"
          catalogUrl={catalogUrl}
        />
        {/* As General's: as wide as it needs, but at least 126px, at the form's end. */}
        <SubmitButton disabled={loading || saving} className="w-auto min-w-[126px] self-end">
          Save changes
        </SubmitButton>
      </form>
    </Panel>
  );
}
