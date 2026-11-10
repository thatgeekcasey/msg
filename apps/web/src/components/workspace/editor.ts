import { lazy } from "react";

export type { PastedLink, RichTextEditorHandle } from "./rich-text-editor";

let loaded = false;

/**
 * The message editor, Lexxy, whose code is bigger than the rest of the app's, so it's a chunk of its
 * own that loads as the first editor shows.
 */
export const RichTextEditor = lazy(async () => {
  const editor = await import("./rich-text-editor");
  loaded = true;
  return editor;
});

/** Whether the editor's code has loaded, after which an editor shows at once. */
export const editorLoaded = () => loaded;
