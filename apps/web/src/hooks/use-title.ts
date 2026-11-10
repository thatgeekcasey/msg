import { useEffect } from "react";

/** Names the tab `title` while the page is open; null leaves it as it is, as while a page loads. */
export function useTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return;
    const before = document.title;
    document.title = title;
    return () => void (document.title = before);
  }, [title]);
}
