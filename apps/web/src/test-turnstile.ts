import { act } from "@testing-library/react";
import { onTestFinished, vi } from "vitest";
import type { Turnstile } from "@/components/turnstile-check";

/**
 * Plays Turnstile's script for the test, whose checks are drawn as `w1`, `w2` and so on, and pass or
 * expire as the test says.
 */
export function fakeTurnstile() {
  const drawn: Parameters<Turnstile["render"]>[] = [];
  const turnstile = { render: vi.fn<Turnstile["render"]>((...check) => `w${drawn.push(check)}`), remove: vi.fn<Turnstile["remove"]>() };
  window.turnstile = turnstile;
  onTestFinished(() => {
    delete window.turnstile;
  });
  const latest = () => drawn.at(-1)![1];
  return { turnstile, drawn, pass: (token: string) => act(() => latest().callback(token)), expire: () => act(() => latest()["expired-callback"]()) };
}
