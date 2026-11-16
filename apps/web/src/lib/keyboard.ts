/** Phones and tablets: their on-screen keyboards have no Shift+Enter. */
export const hasTouchKeyboard = () => matchMedia("(pointer: coarse)").matches;

/** Whether the keyboard is an Apple device's, whose shortcuts take Cmd where others take Ctrl. */
export const appleKeyboard = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Whether Cmd is held and Ctrl isn't on an Apple keyboard, or Ctrl and not Cmd on any other. */
const commandHeld = (event: KeyboardEvent) => (appleKeyboard() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

/**
 * Cmd+F on a Mac, iPad or iPhone, or Ctrl+F elsewhere, which opens the search box, as it opens Slack's,
 * and the browser's own find from inside it. A Mac's Ctrl+F moves the caret on in a field, so it stays
 * the field's.
 */
export function opensFind(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== "f" || event.altKey || event.shiftKey || event.isComposing) return false;
  return commandHeld(event);
}

/**
 * Cmd+/ on a Mac, iPad or iPhone, or Ctrl+/ elsewhere, which opens the list of keyboard shortcuts,
 * from the composer too.
 */
export function opensShortcuts(event: KeyboardEvent): boolean {
  if ((event.key !== "/" && event.code !== "Slash") || event.altKey || event.shiftKey || event.isComposing) return false;
  return commandHeld(event);
}

/**
 * Cmd+Option+Shift+H on a Mac, iPad or iPhone, or Ctrl+Alt+Shift+H elsewhere, which starts or joins the
 * huddle of the room shown, or leaves the one the tab is in. Slack's app takes the keys without Option or
 * Alt, which browsers keep for their home page or their history. Option changes the letter a Mac's key
 * types, so the key counts by where it is on the keyboard too.
 */
export function togglesHuddle(event: KeyboardEvent): boolean {
  if (event.code !== "KeyH" && event.key.toLowerCase() !== "h") return false;
  return event.altKey && event.shiftKey && !event.isComposing && commandHeld(event);
}

/** Cmd+Shift+Space on a Mac, iPad or iPhone, or Ctrl+Shift+Space elsewhere, which mutes or unmutes a huddle's microphone, as Slack's do. */
export function togglesMute(event: KeyboardEvent): boolean {
  if (event.code !== "Space" && event.key !== " ") return false;
  return event.shiftKey && !event.altKey && !event.isComposing && commandHeld(event);
}

/** A shortcut's keys: as a tooltip shows them, and as `aria-keyshortcuts` names them for screen readers. */
export interface Shortcut {
  keys: string[];
  aria: string;
}

/** The keys `togglesHuddle` takes on this keyboard. */
export const huddleShortcut = (apple = appleKeyboard()): Shortcut =>
  apple ? { keys: ["⌘", "⌥", "⇧", "H"], aria: "Meta+Alt+Shift+H" } : { keys: ["Ctrl", "Alt", "Shift", "H"], aria: "Control+Alt+Shift+H" };

/** The keys `togglesMute` takes on this keyboard. */
export const muteShortcut = (apple = appleKeyboard()): Shortcut =>
  apple ? { keys: ["⌘", "⇧", "Space"], aria: "Meta+Shift+Space" } : { keys: ["Ctrl", "Shift", "Space"], aria: "Control+Shift+Space" };

/** Ctrl+K, or Cmd+K on a Mac, which opens the Link field of Lexxy's toolbar (its `data-hotkey="cmd+k ctrl+k"`). */
export function opensLink(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === "k" && event.ctrlKey !== event.metaKey && !event.altKey && !event.shiftKey;
}

/**
 * Whether a keypress in a message's editor should send it, as Campfire's composer_controller.js decides:
 * Enter sends and Shift+Enter starts a new line, except on touch screens, where Enter has to start the
 * new line and the Send button sends, and while the formatting toolbar is open, when Enter starts a new
 * paragraph. Cmd/Ctrl+Enter sends everywhere.
 *
 * Campfire treats any touch-capable device that way, and doesn't send on Cmd/Ctrl+Enter there either;
 * this checks the primary pointer instead, so a laptop with a touchscreen still sends on Enter.
 */
export function sendsMessage(event: KeyboardEvent, { toolbarOpen = false } = {}): boolean {
  if (event.key !== "Enter" || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey) return true;
  return !event.shiftKey && !toolbarOpen && !hasTouchKeyboard();
}

/**
 * Ctrl+Enter, or Cmd+Enter on a Mac, which saves a message's edit, as Campfire's edit form takes them
 * (messages/edit.html.erb, `keydown.ctrl+enter` and `keydown.meta+enter`): with no other modifier held.
 */
export function savesEdit(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !event.isComposing && event.ctrlKey !== event.metaKey && !event.altKey && !event.shiftKey;
}

/** Whether `key` was pressed with no modifier held, as Stimulus's key filters such as `keydown.esc` take it. */
export function pressedAlone(event: KeyboardEvent, key: string): boolean {
  return event.key === key && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

/** A row of the keyboard shortcuts dialog: what a key does, and the keys, as an Apple keyboard or another names them. */
export interface ShortcutRow {
  action: string;
  keys: (apple: boolean) => string[];
}

/** Cmd on an Apple keyboard, Ctrl on another. */
const command = (apple: boolean) => (apple ? "⌘" : "Ctrl");
/** Option on an Apple keyboard, Alt on another. */
const option = (apple: boolean) => (apple ? "⌥" : "Alt");
/** Shift, as each keyboard names it. */
const shift = (apple: boolean) => (apple ? "⇧" : "Shift");

/**
 * What the keyboard shortcuts dialog lists, a group at a time: each key the matchers here take, so a
 * shortcut added to them is listed beside them.
 */
export const SHORTCUTS: { group: string; rows: ShortcutRow[] }[] = [
  {
    group: "Navigate",
    rows: [
      { action: "Search", keys: (apple) => [command(apple), "F"] },
      { action: "Move a starred room up or down", keys: (apple) => [option(apple), "↑ ↓"] },
      { action: "Show keyboard shortcuts", keys: (apple) => [command(apple), "/"] },
    ],
  },
  {
    group: "Huddles",
    rows: [
      { action: "Start, join or leave a huddle", keys: (apple) => huddleShortcut(apple).keys },
      { action: "Mute or unmute", keys: (apple) => muteShortcut(apple).keys },
    ],
  },
  {
    group: "Write a message",
    rows: [
      { action: "Send", keys: () => ["Enter"] },
      { action: "Send with the formatting toolbar open, or on a touch screen", keys: (apple) => [command(apple), "Enter"] },
      { action: "Start a new line", keys: (apple) => [shift(apple), "Enter"] },
      { action: "Add a link", keys: (apple) => [command(apple), "K"] },
      { action: "Edit your last message, with nothing written", keys: () => ["↑"] },
    ],
  },
  {
    group: "Edit a message",
    rows: [
      { action: "Save", keys: (apple) => [command(apple), "Enter"] },
      { action: "Close", keys: () => ["Esc"] },
    ],
  },
];
