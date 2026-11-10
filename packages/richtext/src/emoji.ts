// `String#all_emoji?` (Campfire's lib/rails_ext/string.rb): a message or boost of nothing but emoji
// shows large.

/**
 * Its alternation of the three, as one class. A browser's regular expressions backtrack: for a run of
 * emoji that both properties take, then a character that's neither, the alternation would try each
 * property for each emoji, in time that doubles with every one.
 */
const ALL_EMOJI = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F]+$/u;

/**
 * Whether the text is one or more emoji and nothing else. Skin tones, flags, ❤️, © and ™ count, but
 * a zero-width joiner (in families, say) or a keycap's digit doesn't.
 */
export function isAllEmoji(text: string): boolean {
  return ALL_EMOJI.test(text);
}
