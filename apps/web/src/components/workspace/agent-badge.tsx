import { useCallback, useContext } from "react";
import { ASSISTANT_ID, type DirectoryUser, type Room, type User } from "@ember/protocol";
import { Badge } from "@/components/ui/badge";
import { PeopleContext } from "@/hooks/use-directory";
import { cn } from "@/lib/utils";

/**
 * Whether someone is an AI agent, @ember or one an administrator made, as the people directory lists
 * them, or @ember before it lists anyone. A deleted agent stays one, as its answers stay.
 */
export const isAgent = (user: User & Pick<DirectoryUser, "agent">) => user.agent === true || user.id === ASSISTANT_ID;

/** Whether someone is an AI agent, as the people directory lists them now. */
export function useIsAgent(): (user: User) => boolean {
  const people = useContext(PeopleContext);
  return useCallback((user: User) => isAgent(people.get(user.id) ?? user), [people]);
}

/** Whether a room is someone's DM with an AI agent alone, which is named after it, so its name takes the badge too. */
export function useIsWithAgent(): (room: Room) => boolean {
  const isAgentNow = useIsAgent();
  return useCallback((room: Room) => room.kind === "direct" && room.members.length === 2 && room.members.some(isAgentNow), [isAgentNow]);
}

/**
 * The badge after an AI agent's name, so nobody takes it for a person: "Agent" in capitals at 10px on a
 * pill of the ink at 8%, which stays in sight on a hovered or picked row too. It's written as a word
 * after a space, so that screen readers say the name and it as two words, though a row of flex items
 * doesn't show the space. The mentions prompt draws it from its own markup (`.autocompletable__badge`
 * in rich-text-editor.css).
 */
export function AgentBadge({ className }: { className?: string }) {
  return (
    <>
      {" "}
      <Badge
        variant="secondary"
        className={cn("bg-foreground/8 px-1.5 py-0 text-[10px] leading-4 font-semibold tracking-wider text-message-muted uppercase", className)}
      >
        Agent
      </Badge>
    </>
  );
}
