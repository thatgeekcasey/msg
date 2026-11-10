import { TRANSLATIONS, type TranslationKey } from "@ember/protocol";
import { Fragment, useEffect, useRef, useState } from "react";
import { Translate } from "@/components/icons/iconoir";
import { useAccount } from "@/hooks/use-account";

// The translation button, drawn by Campfire's buttons.css and base.css: a button beside a field that
// opens what the field asks for in seven languages, with Iconoir's translate. It's a <details>, which
// opens and closes by itself, and its button can't be reached with Tab.

/** `translations` under a translate button, unless the workspace hides translation buttons, as it does until an administrator shows them. */
export function TranslationButton({ translations }: { translations: TranslationKey }) {
  return useAccount().hideTranslationButtons ? null : <Translations translations={translations} />;
}

function Translations({ translations }: { translations: TranslationKey }) {
  const details = useRef<HTMLDetailsElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // As Campfire's popup_controller.js does, a click anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const closeOnClickOutside = (event: MouseEvent) => {
      if (!details.current!.contains(event.target as Node)) details.current!.open = false;
    };
    document.addEventListener("click", closeOnClickOutside);
    return () => document.removeEventListener("click", closeOnClickOutside);
  }, [open]);

  const toggled = () => {
    setOpen(details.current!.open);
    if (details.current!.open) keepToTheScreen(details.current!, menu.current!);
  };

  return (
    <details ref={details} onToggle={toggled} onKeyDown={(event) => event.key === "Escape" && (event.currentTarget.open = false)} className="relative">
      {/* A circle `.btn`, as Campfire draws one holding only an icon: 36px, or 44px for fingers. */}
      <summary
        tabIndex={-1}
        className="grid size-9 cursor-pointer list-none place-items-center rounded-full border bg-background touch:size-11 [&::-webkit-details-marker]:hidden"
      >
        {/* 1.3em wide in the 20px it's given, as Campfire's globe is. */}
        <Translate className="h-5 w-[1.3em]" />
        <span className="sr-only">Translate</span>
      </summary>
      {/* Campfire's `.language-list-menu` and `.language-list` (base.css), under the button, in the text around it. */}
      <div
        ref={menu}
        className="absolute z-3 mx-[1ch] w-max max-w-[40ch] overflow-clip [--max-width:40ch] rounded-[0.5em] border border-border bg-border shadow-[0_8px_24px_var(--color-menu-shadow)] max-[100ch]:max-w-[calc(var(--max-width)-1ch)]"
      >
        <dl className="m-0 grid grid-cols-[min-content_1fr] justify-start gap-x-[1ch] gap-y-2 px-[2ch] py-4 text-start">
          {TRANSLATIONS[translations].map(([flag, text]) => (
            <Fragment key={flag}>
              <dt>{flag}</dt>
              <dd>{text}</dd>
            </Fragment>
          ))}
        </dl>
      </div>
    </details>
  );
}

/**
 * On a narrow screen the menu keeps to the room on its right, which popup_controller.js measures as it
 * opens. It measures the window, which a phone widens to fit a menu already too wide for the screen, and
 * which can be wider than what's seen of the part of the page the globe is in, such as the messages,
 * which cut off what overflows them past the notch. So this measures what's seen around the globe. A
 * list that doesn't fit there opens leftward where there's more room, as beside a globe at the screen's
 * edge, which Campfire's would leave cut off.
 */
function keepToTheScreen(globe: HTMLElement, menu: HTMLElement) {
  // Back where it opens by itself, as wide as the list is with room enough: at most 40ch.
  menu.style.removeProperty("--max-width");
  menu.style.removeProperty("right");
  const wanted = menu.getBoundingClientRect().width;
  const margin = parseFloat(getComputedStyle(menu).marginLeft);
  const { left, right } = globe.getBoundingClientRect();
  const seen = seenAround(globe);
  const onRight = seen.right - left - margin;
  const onLeft = right - seen.left - margin;
  const leftward = wanted + margin > onRight && onLeft > onRight;
  if (leftward) menu.style.setProperty("right", "0");
  menu.style.setProperty("--max-width", `${leftward ? onLeft : onRight}px`);
}

/** The left and right edges of what's seen around `element`: the page's, or nearer ones that cut off what overflows them. */
function seenAround(element: HTMLElement): { left: number; right: number } {
  let [left, right] = [0, document.documentElement.clientWidth];
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (getComputedStyle(ancestor).overflowX === "visible") continue;
    // Its padding box, where it cuts off what overflows it.
    const start = ancestor.getBoundingClientRect().left + ancestor.clientLeft;
    [left, right] = [Math.max(left, start), Math.min(right, start + ancestor.clientWidth)];
  }
  return { left, right };
}
