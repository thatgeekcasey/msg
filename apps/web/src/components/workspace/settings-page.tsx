import { useContext, type ComponentProps, type ReactNode } from "react";
import { ArrowLeft } from "@/components/icons/iconoir";
import { MainContent } from "@/components/main-content";
import { PageLink } from "@/components/page-link";
import { cn } from "@/lib/utils";
import { HEADER_BUTTON, PageHeader } from "./page-header";
import { SettingsLayout } from "./settings-navigation";

/**
 * The pages beside rooms, such as New room and a room's settings: Go Back in the top bar, with any
 * `links` the page has at its other end, then panels on the canvas, which scrolls. Its last panel
 * scrolls clear of the home indicator.
 */
export function SettingsPage({ back, links, children }: { back: string; links?: ReactNode; children: ReactNode }) {
  return (
    <>
      <PageHeader>
        <PageLink href={back} className={HEADER_BUTTON}>
          <ArrowLeft className="size-5" />
          <span className="sr-only">Go Back</span>
        </PageLink>
        {links && <div className="ml-auto flex items-center gap-[1ch]">{links}</div>}
      </PageHeader>
      <MainContent className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-background pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] max-md:pl-[env(safe-area-inset-left)]">
        {children}
      </MainContent>
    </>
  );
}

/**
 * On a page of community settings, a panel: no card, but a 720px column, 36px from its neighbors (28px
 * at 900px and below), whatever width the page gives its panel, `.panel--wide` too.
 */
const SETTINGS_PANEL =
  "my-9 w-[720px] max-w-[calc(100%-64px)] rounded-none border-0 p-0 [&+&]:mt-9 max-md:my-7 max-md:max-w-[calc(100%-40px)] max-md:rounded-none max-md:p-0 max-md:[&+&]:mt-7 upto-500px:max-w-[calc(100%-32px)]";

/** A panel: a 640px card, narrower on phones, with no gap between two in a row. */
export function Panel({ className, ...props }: ComponentProps<"section">) {
  const settings = useContext(SettingsLayout);
  return (
    <section
      className={cn(
        "mx-auto my-7 w-[640px] max-w-[calc(100%-48px)] rounded-[14px] border bg-background p-[clamp(20px,3vw,32px)] text-start [&+&]:mt-0",
        "max-md:my-4 max-md:max-w-[calc(100%-24px)] max-md:rounded-xl max-md:px-4 max-md:py-5",
        className,
        settings && SETTINGS_PANEL,
      )}
      {...props}
    />
  );
}

/** What settings say once the name is saved, changed or not. */
export const CHANGES_SAVED = "Changes saved.";

/** A section's heading, 4px above what follows it in the section, which spaces its parts 24px apart. */
export const SECTION_HEADING = "mb-1";

/** A page's title, which a panel sets at 23px. */
export const TITLE = "text-[23px] leading-[1.3] font-[650]";

/**
 * A link at the end of a title's row, such as Rooms and permissions' New room and Add a chat bot: one of
 * the sections' buttons, 44px tall, with an icon before its label.
 */
export const TITLE_LINK = "inline-flex min-h-11 items-center justify-center gap-[0.5em] rounded-[9px] border bg-background px-3.5 py-2.5 font-medium";

/** A page's heading, whose title a panel sets at 23px. */
export function PageHeading({ title, id, className, children }: { title: string; id?: string; className?: string; children: ReactNode }) {
  return (
    <header className={cn("mb-6", className)}>
      <h1 id={id} className={cn("mb-1.5", TITLE)}>
        {title}
      </h1>
      <p className="text-muted-foreground">{children}</p>
    </header>
  );
}
