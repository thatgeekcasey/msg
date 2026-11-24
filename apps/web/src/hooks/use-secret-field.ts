import { useLayoutEffect, useRef } from "react";

/**
 * A ref for the field of a secret a form keeps as `typed`, which leaves the field uncontrolled, as
 * passwords are: React puts a controlled field's value in its `value` attribute too, where custom CSS
 * could read it. The field shows what the form has, once the form clears it or puts it back.
 */
export function useSecretField(typed: string) {
  const field = useRef<HTMLInputElement>(null);
  // After every render, not only when `typed` changes: the form can clear what's typed in the same render as a keystroke the field already shows.
  useLayoutEffect(() => {
    if (field.current && field.current.value !== typed) field.current.value = typed;
  });
  return field;
}
