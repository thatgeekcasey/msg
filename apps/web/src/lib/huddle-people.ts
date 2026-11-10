import { toSentence } from "./directs";

/** How many people a sentence about a huddle names before it counts the rest. */
const MAX_NAMED = 3;

const firstName = (name: string) => name.trim().split(/\s+/)[0]!;

const othersCounted = (count: number) => (count === 1 ? "1 other" : `${count} others`);

/**
 * `count` people as a sentence starts with them, `names` being those of them whose names are known: by
 * first name up to three, "Sam, Priya, and Leo", then how many others, "Sam, Priya, Leo, and 2 others",
 * and with no name known, "2 people".
 */
function peopleListed(names: string[], count: number): string {
  if (names.length === 0) return count === 1 ? "1 person" : `${count} people`;
  const named = names.slice(0, MAX_NAMED).map(firstName);
  return toSentence(count > named.length ? [...named, othersCounted(count - named.length)] : named);
}

/** Who's in a huddle that's going on, for someone about to join it: "Sam is in it now." */
export const inItNow = (names: string[], count: number) => `${peopleListed(names, count)} ${count === 1 ? "is" : "are"} in it now.`;

/**
 * Who's in a huddle, for someone in it, by the names of the others: "Just you in the huddle", "Sam and
 * you are in the huddle", and past three others, "Sam, Priya, Leo, and 2 others are in the huddle".
 */
export function inTheHuddle(others: string[]): string {
  if (others.length === 0) return "Just you in the huddle";
  const everyone = others.length <= MAX_NAMED ? toSentence([...others.map(firstName), "you"]) : peopleListed(others, others.length);
  return `${everyone} are in the huddle`;
}
