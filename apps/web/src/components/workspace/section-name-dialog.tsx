import { useId, useState, type FormEvent } from "react";
import { MAX_SECTION_NAME_LENGTH, type Section } from "@ember/protocol";
import { Field, FIELD_INPUT } from "@/components/field";
import { Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { ApiError, createSection, isSignedOut, renameSection } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Actions } from "./assistant-setup";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE } from "./unsaved-changes";

interface Props {
  /** The section to rename, or null to make one. */
  section: Section | null;
  /** Called with the section as the server answers it, once it's made or renamed. */
  onSaved: (section: Section) => void;
  onClose: () => void;
  /** Says why saving failed, when it isn't the name's doing, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/**
 * New section, from Rooms and permissions, or a section's Rename: the name everyone's sidebar lists
 * the section's rooms under, which no other section can have, whatever its case. A name refused is
 * said under it.
 */
export function SectionNameDialog({ section, onSaved, onClose, onFailed }: Props) {
  const [name, setName] = useState(section?.name ?? "");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useMounted();
  const inputId = useId();
  const refusalId = useId();

  const save = (event: FormEvent) => {
    event.preventDefault();
    setRefusal(null);
    setSaving(true);
    (section ? renameSection(section.id, name) : createSection(name)).then(
      (saved) => {
        onSaved(saved);
        if (mounted.current) onClose();
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        // A name another section has, or one that Blocked words keep out.
        if (error instanceof ApiError && (error.status === 409 || error.status === 422)) return setRefusal(error.message);
        onFailed(error);
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => open || saving || onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-busy={saving || undefined}
        overlayClassName={DIALOG_BACKDROP}
        // What's typed isn't lost to a click beside it.
        onInteractOutside={(event) => event.preventDefault()}
        className={DIALOG}
      >
        <button type="button" aria-label="Close" disabled={saving} onClick={onClose} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle className={cn(DIALOG_TITLE, "pe-10")}>{section ? "Rename section" : "New section"}</DialogTitle>
        <form onSubmit={save}>
          <DialogDescription className="mb-4 leading-[1.65]">Everyone’s sidebar lists the section’s rooms under its name.</DialogDescription>
          <Field id={inputId} label="Section name">
            <Input
              id={inputId}
              required
              autoComplete="off"
              maxLength={MAX_SECTION_NAME_LENGTH}
              placeholder="Such as Software engineering"
              value={name}
              disabled={saving}
              aria-invalid={refusal !== null || undefined}
              aria-describedby={refusal === null ? undefined : refusalId}
              onChange={(event) => {
                setName(event.target.value);
                setRefusal(null);
              }}
              className={FIELD_INPUT}
            />
          </Field>
          {refusal !== null && (
            <p id={refusalId} role="alert" className="mt-2 text-sm text-negative wrap-anywhere">
              {refusal}
            </p>
          )}
          <Actions
            back={onClose}
            backLabel="Cancel"
            next={null}
            nextLabel={saving ? "Saving…" : section ? "Rename" : "Create section"}
            disabled={name.trim() === "" || name === section?.name}
            saving={saving}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}
