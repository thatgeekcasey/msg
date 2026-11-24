import { SPECIAL_MENTIONS, type SpecialMention } from "@ember/richtext";

// Whom a message's special mentions notify: its widest, as Slack notifies each person once, whatever a
// message mentions. They're listed narrowest first, each reaching everyone a narrower one does, so
// @channel, everyone in the room, is wider than @here, those in it who are active, and @everyone,
// everyone in the workspace, is wider than @channel, as an open room, the only one it notifies, holds
// everyone.

/** The widest of `mentions`, or nothing for none. */
export const widestOf = (mentions: readonly SpecialMention[]): SpecialMention | undefined => SPECIAL_MENTIONS.findLast((mention) => mentions.includes(mention));

/**
 * Whom a message that notified `notified` notifies once it's edited to make `mentions`: the narrower of
 * that and the widest of them, since an edit notifies nobody, and nothing once it makes none, or for one
 * that notified nobody.
 */
export function narrowed(notified: SpecialMention | undefined, mentions: readonly SpecialMention[]): SpecialMention | undefined {
  const widest = widestOf(mentions);
  if (notified === undefined || widest === undefined) return undefined;
  return SPECIAL_MENTIONS[Math.min(SPECIAL_MENTIONS.indexOf(notified), SPECIAL_MENTIONS.indexOf(widest))];
}
