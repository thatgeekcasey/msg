import { useMemo, useState, type RefObject } from "react";
import type { ComposerHandle } from "@/components/workspace/composer";
import type { MessageEditorHandle } from "@/components/workspace/message-editor";
import type { MessageEditors } from "@/components/workspace/message-item";
import { hasTouchKeyboard } from "@/lib/keyboard";

/**
 * The editors open on a timeline's messages, by message, and what opens and closes them and writes
 * replies in `composer`, the timeline's: a room's, or a thread's.
 */
export function useMessageEditors(composer: RefObject<ComposerHandle | null>) {
  const [editing, setEditing] = useState<ReadonlySet<string>>(() => new Set());
  const editors = useMemo<MessageEditors>(() => {
    const open = new Map<string, MessageEditorHandle>();
    // As an editor closes, focus goes back to the composer, except on touch screens, where it would
    // bring up the keyboard.
    const returnFocus = () => {
      if (!hasTouchKeyboard()) composer.current?.focus();
    };
    return {
      // Up Arrow returns to your newest message's editor if it's open.
      open: (messageId) => {
        const editor = open.get(messageId);
        if (editor) editor.focus();
        else setEditing((ids) => (ids.has(messageId) ? ids : new Set(ids).add(messageId)));
      },
      close: (messageId) => {
        setEditing((ids) => new Set([...ids].filter((id) => id !== messageId)));
        returnFocus();
      },
      returnFocus,
      attach: (messageId, editor) => {
        if (editor) open.set(messageId, editor);
        else open.delete(messageId);
      },
      reply: (quote) => composer.current?.replace(quote),
    };
  }, [composer]);
  return { editing, editors };
}
