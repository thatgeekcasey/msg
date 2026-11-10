import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { MAX_CUSTOM_STYLES_LENGTH, type Account } from "@ember/protocol";
import { useFlash } from "@/components/flash";
import { CheckCircle, WarningTriangle } from "@/components/icons/iconoir";
import { TranslationButton } from "@/components/translation-button";
import { useMounted } from "@/hooks/use-mounted";
import { navigate, WORKSPACE_SETTINGS_PATH } from "@/hooks/use-route";
import { useTitle } from "@/hooks/use-title";
import { ApiError, changeCustomStyles, fetchCustomStyles, isSignedOut } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NavigationIconSettings } from "./navigation-icon-settings";
import { Panel, SettingsPage, TITLE } from "./settings-page";

interface Props {
  /**
   * Called as the page saves the navigation icons or the CSS. What it returns is called with the
   * workspace as saving leaves it, for every page to apply.
   */
  askForAccount: () => (account: Account) => void;
  /** Says why loading or saving failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * Custom styles: the rail's icons (`NavigationIconSettings`), which the project's owner moved here from
 * Community, then the Custom CSS page, where administrators write CSS for every page, which saving
 * applies at once, here and in everyone's tabs, with the notice "✓". Ctrl or ⌘ + Enter saves too. Anyone
 * else is sent to workspace settings with an alert.
 */
export function CustomStylesPage({ askForAccount, onFailed }: Props) {
  const [customStyles, setCustomStyles] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const flash = useFlash();
  const mounted = useMounted();
  useTitle("Custom styles");

  useEffect(() => {
    let stopped = false;
    fetchCustomStyles().then(
      (customStyles) => !stopped && setCustomStyles(customStyles),
      (error: unknown) => {
        if (stopped && !isSignedOut(error)) return;
        if (!(error instanceof ApiError && error.status === 403)) return onFailed(error);
        navigate(WORKSPACE_SETTINGS_PATH, { replace: true });
        flash("alert", error.message);
      },
    );
    return () => void (stopped = true);
  }, [flash, onFailed]);

  const save = (event?: FormEvent) => {
    event?.preventDefault();
    if (customStyles === null || saving) return;
    setSaving(true);
    const answered = askForAccount();
    changeCustomStyles(customStyles).then(
      (account) => {
        answered(account);
        if (!mounted.current) return;
        setSaving(false);
        flash("notice", "✓");
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        onFailed(error);
      },
    );
  };
  const saveOnCtrlEnter = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    save();
  };

  return (
    <SettingsPage back={WORKSPACE_SETTINGS_PATH}>
      <NavigationIconSettings askForAccount={askForAccount} onFailed={onFailed} loading={customStyles === null} />
      {/* `.panel--wide`: 900px. Named for its heading, as the navigation icons' is, so each Save changes is told apart. */}
      <Panel aria-labelledby="custom-styles-heading" aria-busy={customStyles === null} className="relative w-[900px] text-center">
        <form onSubmit={save} onKeyDown={saveOnCtrlEnter} className="flex flex-col gap-x-[1ch] gap-y-4">
          <div className="absolute top-4 left-4">
            <TranslationButton translations="custom_styles" />
          </div>
          <div className="mx-[1ch] px-[2ch] max-md:px-3">
            {/* Set, and spaced from what it says, as the other sections' titles are. */}
            <h1 id="custom-styles-heading" className={cn("mb-1.5", TITLE)}>
              Custom CSS
            </h1>
            <p className="mb-[1em] flex flex-wrap items-center justify-center gap-x-[0.5ch]">
              <span>Add custom CSS styles.</span>
              <WarningTriangle className="size-4" />
              <span>Use Caution: you could break things.</span>
            </p>
          </div>
          <textarea
            id="account_custom_styles"
            aria-labelledby="custom-styles-heading"
            rows={16}
            maxLength={MAX_CUSTOM_STYLES_LENGTH}
            placeholder="Add CSS styles…"
            autoComplete="off"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            value={customStyles ?? ""}
            onChange={(event) => setCustomStyles(event.target.value)}
            disabled={customStyles === null}
            // Campfire's `.input--code`, in 16px, so iOS doesn't zoom in.
            className="w-full resize-none rounded-[9px] border bg-transparent px-[0.8em] py-[0.5em] font-mono text-base break-words whitespace-pre-wrap focus:border-selected-dark"
          />
          {/* A `.btn--reversed` circle holding a check, which darkens under the pointer: 36px, or 44px for fingers. */}
          <button
            type="submit"
            disabled={customStyles === null || saving}
            className="mx-auto grid size-9 cursor-pointer place-items-center rounded-full bg-primary text-[17px] text-primary-foreground transition-[filter] hover:brightness-[0.7] disabled:cursor-not-allowed disabled:opacity-50 disabled:grayscale touch:size-11"
          >
            <CheckCircle className="h-5 w-[1.3em]" />
            <span className="sr-only">Save changes</span>
          </button>
        </form>
      </Panel>
    </SettingsPage>
  );
}
