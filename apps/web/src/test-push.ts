import type { Push } from "@/hooks/use-push";
import { CHROME_MAC } from "./test-platforms";

/** A browser that has notifications on, whose rooms' headers have the bell for your level in them. */
export const PUSH_ON: Push = { on: true, turningOn: false, turnOn: async () => null, platform: CHROME_MAC };
