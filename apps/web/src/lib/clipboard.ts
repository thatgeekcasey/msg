/** Campfire's `btn--success` (buttons.css) in Ember's colors: Copy link turns green as it copies. */
const COPIED = ["text-positive", "motion-safe:animate-success"];

/**
 * Copies `text`, then turns the button clicked green and plays its success animation from the start. It
 * stays green until it's clicked again, and a clipboard that refuses leaves it as it was.
 */
export async function copyWithSuccess(button: HTMLButtonElement, text: string) {
  button.classList.remove(...COPIED);
  // Reading the layout ends the last run of the animation, so adding the classes starts it again.
  void button.offsetWidth;
  try {
    await navigator.clipboard.writeText(text);
    button.classList.add(...COPIED);
  } catch {
    // Nothing to show.
  }
}
