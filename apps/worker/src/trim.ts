// Trimming without a regular expression: one like `/^\s+|\s+$/g` tries to end each run of what it takes
// inside the text at the text's end, a character at a time, so a long run takes it quadratic time.

/** `text` without the characters `trims` takes at either end. */
export function trimmed(text: string, trims: (character: string) => boolean): string {
  let [start, end] = [0, text.length];
  while (start < end && trims(text[start]!)) start++;
  while (end > start && trims(text[end - 1]!)) end--;
  return text.slice(start, end);
}
