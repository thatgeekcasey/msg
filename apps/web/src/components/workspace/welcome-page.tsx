import type { User } from "@ember/protocol";
import { ChatBubbleQuestion } from "@/components/icons/iconoir";
import { MainContent } from "@/components/main-content";
import { useTitle } from "@/hooks/use-title";
import { PageHeader } from "./page-header";

/**
 * The page for someone in no rooms yet: an empty top bar, and a faint chat bubble in the middle of the
 * page, as `.message-area--empty` lays it out in Campfire's messages.css.
 */
export function WelcomePage({ me }: { me: User }) {
  useTitle("No rooms yet");
  return (
    <>
      <PageHeader />
      <MainContent className="flex min-h-0 min-w-0 flex-col bg-background pr-[env(safe-area-inset-right)] max-md:pl-[env(safe-area-inset-left)]">
        <div className="grid flex-1 place-items-center p-6 text-center text-muted-foreground">
          <figure className="px-[1ch] py-4">
            <ChatBubbleQuestion className="mx-auto h-auto w-16 max-w-[25vw] text-foreground opacity-20" />
            <span className="sr-only">{me.name}</span>
          </figure>
        </div>
      </MainContent>
    </>
  );
}
