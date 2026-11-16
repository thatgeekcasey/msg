import { afterEach, describe, expect, it, vi } from "vitest";
import { huddleShortcut, muteShortcut, opensFind, opensLink, opensShortcuts, SHORTCUTS, pressedAlone, savesEdit, sendsMessage, togglesHuddle, togglesMute } from "./keyboard";

function pointer(coarse: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)" && coarse }));
}

const press = (key: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key, ...init });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendsMessage", () => {
  it("sends on Enter and starts a new line on Shift+Enter with a physical keyboard", () => {
    pointer(false);
    expect(sendsMessage(press("Enter"))).toBe(true);
    expect(sendsMessage(press("Enter", { shiftKey: true }))).toBe(false);
  });

  it("starts a new line on Enter with a touch keyboard", () => {
    pointer(true);
    expect(sendsMessage(press("Enter"))).toBe(false);
  });

  it("starts a new paragraph on Enter while the formatting toolbar is open", () => {
    pointer(false);
    expect(sendsMessage(press("Enter"), { toolbarOpen: true })).toBe(false);
    expect(sendsMessage(press("Enter", { ctrlKey: true }), { toolbarOpen: true })).toBe(true);
  });

  it("sends on Cmd+Enter or Ctrl+Enter everywhere", () => {
    pointer(true);
    expect(sendsMessage(press("Enter", { metaKey: true }))).toBe(true);
    expect(sendsMessage(press("Enter", { ctrlKey: true }))).toBe(true);
  });

  it("leaves Enter to an input method that is still composing", () => {
    pointer(false);
    expect(sendsMessage(press("Enter", { isComposing: true }))).toBe(false);
    expect(sendsMessage(press("Enter", { isComposing: true, metaKey: true }))).toBe(false);
  });

  it("ignores other keys", () => {
    pointer(false);
    expect(sendsMessage(press("a"))).toBe(false);
  });
});

describe("opensLink", () => {
  it("is Ctrl+K or Cmd+K, as Lexxy's toolbar takes them", () => {
    expect(opensLink(press("k", { ctrlKey: true }))).toBe(true);
    expect(opensLink(press("k", { metaKey: true }))).toBe(true);
    expect(opensLink(press("K", { ctrlKey: true }))).toBe(true);
  });

  it("isn't K on its own or with other keys held", () => {
    expect(opensLink(press("k"))).toBe(false);
    expect(opensLink(press("k", { ctrlKey: true, metaKey: true }))).toBe(false);
    expect(opensLink(press("k", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(opensLink(press("k", { metaKey: true, altKey: true }))).toBe(false);
    expect(opensLink(press("j", { ctrlKey: true }))).toBe(false);
  });
});

describe("savesEdit", () => {
  it("is Ctrl+Enter or Cmd+Enter", () => {
    expect(savesEdit(press("Enter", { ctrlKey: true }))).toBe(true);
    expect(savesEdit(press("Enter", { metaKey: true }))).toBe(true);
  });

  it("isn't Enter on its own, with other keys held, or while an input method is composing", () => {
    expect(savesEdit(press("Enter"))).toBe(false);
    expect(savesEdit(press("Enter", { shiftKey: true }))).toBe(false);
    expect(savesEdit(press("Enter", { ctrlKey: true, metaKey: true }))).toBe(false);
    expect(savesEdit(press("Enter", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(savesEdit(press("Enter", { metaKey: true, altKey: true }))).toBe(false);
    expect(savesEdit(press("Enter", { ctrlKey: true, isComposing: true }))).toBe(false);
  });
});

describe("pressedAlone", () => {
  it("is the key with nothing held", () => {
    expect(pressedAlone(press("Escape"), "Escape")).toBe(true);
    expect(pressedAlone(press("ArrowUp"), "ArrowUp")).toBe(true);
  });

  it("isn't another key, the key with a modifier held, or one an input method is composing", () => {
    expect(pressedAlone(press("ArrowDown"), "ArrowUp")).toBe(false);
    for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey", "isComposing"]) {
      expect(pressedAlone(press("ArrowUp", { [modifier]: true }), "ArrowUp"), modifier).toBe(false);
    }
  });
});

/** The keyboard of a device whose `navigator.platform` is `platform`. */
const on = (platform: string) => vi.stubGlobal("navigator", { ...navigator, platform });

describe("opensFind", () => {
  it("takes Ctrl+F, in either case, but on Apple's devices", () => {
    on("Win32");
    expect(opensFind(press("f", { ctrlKey: true }))).toBe(true);
    expect(opensFind(press("F", { ctrlKey: true }))).toBe(true);
    expect(opensFind(press("f", { metaKey: true }))).toBe(false);
    on("Linux x86_64");
    expect(opensFind(press("f", { ctrlKey: true }))).toBe(true);
  });

  it("takes Cmd+F on a Mac, iPad or iPhone, where Ctrl+F moves the caret on in a field", () => {
    for (const platform of ["MacIntel", "iPad", "iPhone"]) {
      on(platform);
      expect(opensFind(press("f", { metaKey: true })), platform).toBe(true);
      expect(opensFind(press("f", { ctrlKey: true })), platform).toBe(false);
    }
  });

  it("leaves F with other modifiers, alone, or while an input method composes", () => {
    on("Win32");
    expect(opensFind(press("f"))).toBe(false);
    expect(opensFind(press("f", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(opensFind(press("f", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(opensFind(press("f", { ctrlKey: true, metaKey: true }))).toBe(false);
    expect(opensFind(press("f", { ctrlKey: true, isComposing: true }))).toBe(false);
    expect(opensFind(press("g", { ctrlKey: true }))).toBe(false);
  });
});

describe("togglesHuddle", () => {
  it("takes Ctrl+Alt+Shift+H, but on Apple's devices", () => {
    on("Win32");
    expect(togglesHuddle(press("H", { code: "KeyH", ctrlKey: true, altKey: true, shiftKey: true }))).toBe(true);
    expect(togglesHuddle(press("h", { code: "KeyH", ctrlKey: true, altKey: true, shiftKey: true }))).toBe(true);
    expect(togglesHuddle(press("H", { code: "KeyH", metaKey: true, altKey: true, shiftKey: true }))).toBe(false);
  });

  it("takes Cmd+Option+Shift+H on a Mac, where Option makes the key type another letter", () => {
    on("MacIntel");
    expect(togglesHuddle(press("Ó", { code: "KeyH", metaKey: true, altKey: true, shiftKey: true }))).toBe(true);
    expect(togglesHuddle(press("Ó", { code: "KeyH", ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
  });

  it("takes the key that types H on a keyboard laid out another way", () => {
    on("Linux x86_64");
    expect(togglesHuddle(press("H", { code: "KeyJ", ctrlKey: true, altKey: true, shiftKey: true }))).toBe(true);
  });

  it("leaves the browser's own Cmd+Shift+H and Ctrl+Shift+H, and H with anything less", () => {
    on("MacIntel");
    expect(togglesHuddle(press("H", { code: "KeyH", metaKey: true, shiftKey: true }))).toBe(false);
    on("Win32");
    expect(togglesHuddle(press("H", { code: "KeyH", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(togglesHuddle(press("h", { code: "KeyH", ctrlKey: true, altKey: true }))).toBe(false);
    expect(togglesHuddle(press("H", { code: "KeyH", altKey: true, shiftKey: true }))).toBe(false);
    expect(togglesHuddle(press("H", { code: "KeyH", ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }))).toBe(false);
    expect(togglesHuddle(press("H", { code: "KeyH", ctrlKey: true, altKey: true, shiftKey: true, isComposing: true }))).toBe(false);
    expect(togglesHuddle(press("G", { code: "KeyG", ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
  });

  it("names its keys as the keyboard does, and as screen readers hear them", () => {
    on("MacIntel");
    expect(huddleShortcut()).toEqual({ keys: ["⌘", "⌥", "⇧", "H"], aria: "Meta+Alt+Shift+H" });
    on("Win32");
    expect(huddleShortcut()).toEqual({ keys: ["Ctrl", "Alt", "Shift", "H"], aria: "Control+Alt+Shift+H" });
  });
});

describe("togglesMute", () => {
  it("takes Ctrl+Shift+Space, but on Apple's devices, which take Cmd+Shift+Space", () => {
    on("Win32");
    expect(togglesMute(press(" ", { code: "Space", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(togglesMute(press(" ", { code: "Space", metaKey: true, shiftKey: true }))).toBe(false);
    on("MacIntel");
    expect(togglesMute(press(" ", { code: "Space", metaKey: true, shiftKey: true }))).toBe(true);
    expect(togglesMute(press(" ", { code: "Space", ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("leaves Space alone, with anything less or more held, and other keys", () => {
    on("Win32");
    expect(togglesMute(press(" ", { code: "Space" }))).toBe(false);
    expect(togglesMute(press(" ", { code: "Space", shiftKey: true }))).toBe(false);
    expect(togglesMute(press(" ", { code: "Space", ctrlKey: true }))).toBe(false);
    expect(togglesMute(press(" ", { code: "Space", ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(togglesMute(press(" ", { code: "Space", ctrlKey: true, metaKey: true, shiftKey: true }))).toBe(false);
    expect(togglesMute(press(" ", { code: "Space", ctrlKey: true, shiftKey: true, isComposing: true }))).toBe(false);
    expect(togglesMute(press("Enter", { code: "Enter", ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("names its keys as the keyboard does, and as screen readers hear them", () => {
    on("MacIntel");
    expect(muteShortcut()).toEqual({ keys: ["⌘", "⇧", "Space"], aria: "Meta+Shift+Space" });
    on("Linux x86_64");
    expect(muteShortcut()).toEqual({ keys: ["Ctrl", "Shift", "Space"], aria: "Control+Shift+Space" });
  });
});

describe("opensShortcuts", () => {
  it("takes Ctrl+/, but on Apple's devices, which take Cmd+/", () => {
    on("Win32");
    expect(opensShortcuts(press("/", { ctrlKey: true }))).toBe(true);
    expect(opensShortcuts(press("/", { metaKey: true }))).toBe(false);
    for (const platform of ["MacIntel", "iPad", "iPhone"]) {
      on(platform);
      expect(opensShortcuts(press("/", { metaKey: true })), platform).toBe(true);
      expect(opensShortcuts(press("/", { ctrlKey: true })), platform).toBe(false);
    }
  });

  it("counts the key by where it is, for keyboards whose / is somewhere else", () => {
    on("Linux x86_64");
    expect(opensShortcuts(press("-", { code: "Slash", ctrlKey: true }))).toBe(true);
  });

  it("leaves / alone, with other modifiers, or while an input method composes", () => {
    on("Win32");
    expect(opensShortcuts(press("/"))).toBe(false);
    for (const modifier of ["altKey", "shiftKey", "metaKey", "isComposing"]) {
      expect(opensShortcuts(press("/", { ctrlKey: true, [modifier]: true })), modifier).toBe(false);
    }
    expect(opensShortcuts(press("?", { ctrlKey: true }))).toBe(false);
  });
});

describe("SHORTCUTS", () => {
  it("names Cmd and Option on an Apple keyboard, and Ctrl and Alt on another", () => {
    const keys = (apple: boolean) => SHORTCUTS.flatMap(({ rows }) => rows.flatMap((row) => row.keys(apple)));
    expect(keys(true)).toContain("⌘");
    expect(keys(true)).not.toContain("Ctrl");
    expect(keys(false)).toContain("Ctrl");
    expect(keys(false)).not.toContain("⌘");
    expect(keys(false)).not.toContain("⌥");
  });

  it("lists the huddle keys as their buttons' tooltips show them", () => {
    const huddles = SHORTCUTS.find(({ group }) => group === "Huddles")!.rows;
    expect(huddles.map((row) => row.keys(true))).toEqual([huddleShortcut(true).keys, muteShortcut(true).keys]);
    expect(huddles.map((row) => row.keys(false))).toEqual([huddleShortcut(false).keys, muteShortcut(false).keys]);
  });
});
