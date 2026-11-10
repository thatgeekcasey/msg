# Rich text corpus

`expected.json` holds 658 stored message bodies (Campfire's fixtures, hand-written cases of Lexxy
and Trix markup, attachments, XSS, malformed markup and parser limits, and 400 seeded fuzz cases)
with what Campfire's own Rails pipeline made of each, or the error it raised:

| Field | What Rails made of the body | Read by |
|---|---|---|
| `plain_text` | `message.body.to_plain_text` | `src/corpus.test.ts` |
| `mentioned` | `Message::Mentionee#mentioned_users`, as user ids | `src/corpus.test.ts` |
| `filtered` | `TextMessagePresentationFilters.apply(...)` | `src/corpus.test.ts` |
| `presentation` | `MessagesHelper#message_presentation` | `src/corpus.test.ts` |
| `editable` | The `<lexxy-editor>` value for editing it | nothing yet |

The users, rooms and signed ids the bodies refer to are in the same file.

It was recorded by running each body through Campfire's Rails app, and is kept as it was. To take a
newer recording, copy it over this one and run `pnpm --filter @ember/richtext test`: the corpus test
names every case that no longer reads as Rails did, and every case in
`src/testing/known-differences.ts` that now does.

It's under the MIT license, which `MIT-LICENSE` copies.
