import type { Prompt } from "@ember/protocol/prompts";
import { cn } from "@/lib/utils";

// What Ember adds around the instructions typed on an agent's page, or on @ember's: what its model reads
// before the conversation, as the Worker writes it (`promptAround`), the instructions in their place,
// for a question the administrator looking writes to it directly, as Try it asks one.

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** What the preview says of what it shows, for the agent called `name`. */
export const aroundExplained = (name: string) =>
  `Ember tells ${name} who it is, where it's asked and how the chat shows an answer, then gives it the conversation, each message after its writer's name. Your instructions go in between. For a question you write to it directly, it reads:`;

/** What Ember adds around them, closed until it's opened: `prompt`, with a mark where the instructions go. */
export function PromptPreview({ name, prompt }: { name: string; prompt: Prompt }) {
  return (
    <details className="border-t pt-4">
      {/* 44px tall for fingers, its words where they were. */}
      <summary className="cursor-pointer text-sm font-semibold touch:-mt-3 touch:py-3">What Ember adds around them</summary>
      <p className={cn(NOTE, "mt-2 touch:mt-0")}>{aroundExplained(name)}</p>
      <div className="mt-3 rounded-[9px] border bg-background px-[1.5ch] py-3 font-mono text-[13px] leading-[1.5] whitespace-pre-wrap wrap-anywhere text-muted-foreground">
        {prompt.before}
        {"\n\n"}
        <span className="rounded-[4px] bg-foreground/8 px-1 text-foreground">Your instructions</span>
        {"\n\n"}
        {prompt.after}
      </div>
    </details>
  );
}
