// The corpus cases where Ember deliberately reads a body differently from Rails, each with its
// reason. corpus.test.ts fails when a listed case starts matching, so the list stays true.

export type Field = "plain_text" | "mentioned" | "filtered" | "presentation";

const TRIX =
  "Action Text turns the `<figure data-trix-attachment>` elements of Trix, Campfire's earlier editor, into attachments as it loads a " +
  "body. Ember never stored a Trix body and its clients send Lexxy's markup, so a figure a client sends stays a figure: its text " +
  "shows, and its JSON is ignored.";

export const KNOWN_DIFFERENCES: Record<string, { fields: readonly Field[]; reason: string }> = {
  "trix figure attachment": { fields: ["plain_text", "mentioned", "filtered", "presentation"], reason: TRIX },
  "trix figure attachment typed values": { fields: ["plain_text", "filtered", "presentation"], reason: TRIX },
  "trix figure attachment empty json": { fields: ["plain_text", "filtered", "presentation"], reason: TRIX },
  "trix figure attachment broken json": { fields: ["plain_text", "filtered", "presentation"], reason: TRIX },
  "trix figure attachment array json": { fields: ["plain_text", "mentioned", "filtered", "presentation"], reason: TRIX },
  "trix figure attachment json comment": { fields: ["plain_text", "filtered", "presentation"], reason: TRIX },
};
