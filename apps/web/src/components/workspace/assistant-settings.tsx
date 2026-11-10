import { useState } from "react";
import type { WorkspaceSettings } from "@ember/protocol";
import { Switch } from "@/components/ui/switch";
import { useMounted } from "@/hooks/use-mounted";
import { forgetAssistant, isSignedOut } from "@/lib/api";
import { BUTTON } from "./email-settings";

// The Ember AI card on the AI assistant tab, for administrators: whether Ember's AI agents, @ember and
// any made for a task, run on models through Cloudflare AI Gateway. Its switch says whether they do, as
// Turnstile's does. Turning it on opens Set up Ember AI (`AssistantSetup`), as switches open setup
// that's missing, as the project's owner asked (2026-10-26), and turning it off takes @ember and the
// agents out of every room and forgets the API token and the models people could pick, keeping each
// agent for when it's on again. Change opens the setup with the account and @ember's model as they are.
// While it's on, the card says what an agent sends its model, which its provider reads. What @ember
// does is on its own page, which the Agents card under this one links to (`AgentList`).

/** What an agent sends its model as it answers, which the card says while Ember AI is on. */
export const WHAT_AGENTS_SEND =
  "Mention an agent, or write to it directly, and it answers, sending the thread, or the room's latest messages, through Cloudflare to its model.";

/** What the card says while Ember AI is off. */
export const ASSISTANT_EXPLAINED =
  "Ember AI adds AI agents people can mention in the chat: @ember, and any you make for a task, each running on a model you choose through Cloudflare AI Gateway.";

/** What it says while it's on. */
export const AGENTS_ANSWER = "Ember's agents answer through Cloudflare AI Gateway, each on the model you choose for it.";

/** What turning Ember AI off asks first. */
export const CONFIRM_STOP_ASSISTANT =
  "Are you sure you want to turn off Ember AI? @ember and the agents will leave every room, and Ember will forget the API token and the models people can pick. It keeps each agent for when Ember AI is on again.";

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

interface Props {
  assistant: WorkspaceSettings["assistant"];
  /** Opens Set up Ember AI. */
  onSetUp: () => void;
  /** Shows that Ember AI is off, once turning it off has. */
  onStopped: () => void;
  /** Says why turning it off failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Whether Ember's agents run on models, for administrators, or else what Ember AI would add. */
export function AssistantSettings({ assistant, onSetUp, onStopped, onFailed }: Props) {
  const [stopping, setStopping] = useState(false);
  const mounted = useMounted();

  const stop = () => {
    if (!confirm(CONFIRM_STOP_ASSISTANT)) return;
    setStopping(true);
    forgetAssistant().then(
      () => {
        onStopped();
        if (mounted.current) setStopping(false);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setStopping(false);
        onFailed(error);
      },
    );
  };

  return (
    <section aria-labelledby="assistant-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div className="flex items-center gap-x-[1ch] gap-y-4">
        <div className="min-w-0 flex-1">
          <h2 id="assistant-heading" className="text-base font-semibold">
            Ember AI
          </h2>
          <p id="assistant-description" className={NOTE}>
            {assistant === null ? ASSISTANT_EXPLAINED : AGENTS_ANSWER}
          </p>
        </div>
        <Switch
          checked={assistant !== null && !stopping}
          onCheckedChange={(on) => (on ? onSetUp() : stop())}
          disabled={stopping}
          aria-labelledby="assistant-heading"
          aria-describedby="assistant-description"
        />
      </div>
      {assistant !== null && (
        <>
          <p className={NOTE}>{WHAT_AGENTS_SEND}</p>
          <div>
            <button type="button" onClick={onSetUp} disabled={stopping} className={BUTTON}>
              Change
            </button>
          </div>
        </>
      )}
    </section>
  );
}
