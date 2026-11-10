import { useSyncExternalStore } from "react";
import { joinedHuddle, watchHuddle } from "@/lib/huddle-store";

/** The huddle this tab is in, as it changes, or null while it's in none. */
export const useHuddle = () => useSyncExternalStore(watchHuddle, joinedHuddle);
