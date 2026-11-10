import { useEffect, useRef, useState, type FormEvent } from "react";
import { MODEL_REFUSED, modelName, modelOf, type AssistantCatalog, type AssistantField, type AssistantSettings } from "@ember/protocol/assistant";
import { Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useMounted } from "@/hooks/use-mounted";
import { addAssistantModel, ApiError, isSignedOut, listAssistantModels } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Actions } from "./assistant-setup";
import { ANOTHER_MODEL, idOf, ModelPicker, NOTE, type ModelChoice, type Refusal } from "./model-picker";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE } from "./unsaved-changes";

// Add a model, for administrators: a model people can pick for @ember to answer them with, from the text
// models Cloudflare's catalog lists for Ember AI's account, but for those people can pick already, or any
// other by its ID, in a dialog that the Ember AI card's Add a model opens. The Worker asks it a test
// question through AI Gateway before adding it, saying why it didn't answer, if it didn't. Then what the
// model said. Styled as Set up Ember AI is.

interface Props {
  assistant: AssistantSettings;
  /** Shows Ember AI as adding the model leaves it. */
  onAdded: (assistant: AssistantSettings) => void;
  onClose: () => void;
  /** Says why listing or adding failed, when it isn't the model's doing or AI Gateway's, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Add a model: the catalog's models people can't pick yet, the one chosen added once it answers a test question. */
export function AddAssistantModel({ assistant, onAdded, onClose, onFailed }: Props) {
  const [catalog, setCatalog] = useState<AssistantCatalog | null>(null);
  const [choice, setChoice] = useState<ModelChoice>({ chosen: ANOTHER_MODEL, typed: "" });
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Asking the model a test question holds the dialog open until it's answered.
  const [saving, setSaving] = useState(false);
  const [added, setAdded] = useState<{ name: string; greeting: string } | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const mounted = useMounted();
  // The models people can pick already aren't offered again.
  const offered = catalog?.models.filter(({ id }) => !assistant.models.some((listed) => listed.id === id)) ?? [];
  const id = idOf(choice);

  /** Lists the models in Cloudflare's catalog, with the API token Ember has, choosing the first people can't pick yet. */
  const list = () => {
    listAssistantModels({ accountId: assistant.accountId }).then(
      (listed) => {
        if (!mounted.current) return;
        const first = listed.models.find(({ id }) => !assistant.models.some((model) => model.id === id));
        setCatalog(listed);
        setChoice({ chosen: first?.id ?? ANOTHER_MODEL, typed: "" });
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        onFailed(error);
        onClose();
      },
    );
  };
  useEffect(list, []);

  // What the model said starts at the title, so that it's read first.
  useEffect(() => {
    if (added) title.current?.focus();
  }, [added]);

  const add = (event: FormEvent) => {
    event.preventDefault();
    const model = modelOf(id);
    if (model === null) return setRefusal({ field: "model", error: MODEL_REFUSED });
    setRefusal(null);
    setSaving(true);
    const name = offered.find((offer) => offer.id === model)?.name;
    addAssistantModel({ model, ...(name && { modelName: name }) }).then(
      (answer) => {
        onAdded(answer.assistant);
        if (!mounted.current) return;
        setSaving(false);
        setAdded({ name: modelName(model, answer.assistant.models), greeting: answer.greeting });
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        // What AI Gateway or the Worker said of the model, or that AI Gateway didn't answer, which the dialog says itself.
        if (error instanceof ApiError && [422, 429, 502].includes(error.status)) return setRefusal({ field: fieldOf(error.field), error: error.message });
        onFailed(error);
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => open || saving || onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-busy={saving || catalog === null || undefined}
        overlayClassName={DIALOG_BACKDROP}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        // What's typed isn't lost to a click beside it.
        onInteractOutside={(event) => event.preventDefault()}
        className={cn(DIALOG, "w-[480px]")}
      >
        <button type="button" aria-label="Close" disabled={saving} onClick={onClose} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle ref={title} tabIndex={-1} className={cn(DIALOG_TITLE, "pe-10 outline-none")}>
          {added ? "Model added" : "Add a model"}
        </DialogTitle>
        {added ? (
          <>
            <DialogDescription className="mb-4 leading-[1.65]">
              People can pick <span className="wrap-anywhere">{added.name}</span> on their profile now. Asked to say hello, it said:
            </DialogDescription>
            <blockquote className="border-s-2 ps-3 whitespace-pre-wrap wrap-anywhere">{added.greeting}</blockquote>
            <Actions back={null} next={onClose} nextLabel="Done" />
          </>
        ) : (
          <form onSubmit={add}>
            <DialogDescription className="mb-4 leading-[1.65]">
              Choose a model people can pick for @ember to answer them with. Ember asks it a test question through AI Gateway before adding it.
            </DialogDescription>
            {catalog === null ? (
              <p role="status" className={NOTE}>
                Listing the models in Cloudflare's catalog…
              </p>
            ) : (
              <>
                <ModelPicker
                  models={offered}
                  unread={catalog.refusal}
                  choice={choice}
                  onChoose={(chosen) => {
                    setChoice(chosen);
                    setRefusal(null);
                  }}
                  refusal={refusal}
                  disabled={saving}
                  accountId={assistant.accountId}
                />
                <p role="status" className={cn(NOTE, "mt-2 wrap-anywhere empty:mt-0", !saving && "text-negative")}>
                  {saving ? `Asking ${modelName(id, offered)} a test question…` : refusal?.field === null ? refusal.error : null}
                </p>
              </>
            )}
            <Actions back={onClose} backLabel="Cancel" next={null} nextLabel={saving ? "Asking…" : "Add"} disabled={catalog === null || id === ""} saving={saving} />
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The field a refusal names, which can only be the model's here, if it names one. */
const fieldOf = (field: string | undefined): AssistantField | null => (field === "model" ? field : null);
