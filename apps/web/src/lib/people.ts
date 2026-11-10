// Workspace settings list people by name, and your profile your rooms, as `ORDER BY LOWER(name)` does:
// compared as SQLite compares text, folding only ASCII letters, then by id.

const folded = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

const codePoints = (text: string) => Array.from(text, (character) => character.codePointAt(0)!);

/**
 * Compares by code point, as SQLite compares UTF-8. JavaScript's `<` compares UTF-16 units instead,
 * which puts an emoji, a pair of surrogates, before characters such as "Ａ" that come before it.
 */
function compare(x: number[], y: number[]): number {
  for (let i = 0; i < x.length && i < y.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** `people` by name, each name and id read once rather than at every comparison. */
export function byName<T extends { id: string; name: string }>(people: T[]): T[] {
  return people
    .map((person) => ({ person, name: codePoints(folded(person.name)), id: codePoints(person.id) }))
    .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
    .map(({ person }) => person);
}
