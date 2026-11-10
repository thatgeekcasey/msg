/** Runs `run` once the browser is idle, or in a second where it can't say, and returns what cancels it. */
export function whenIdle(run: () => void): () => void {
  if (typeof requestIdleCallback !== "function") {
    const timer = setTimeout(run, 1_000);
    return () => clearTimeout(timer);
  }
  const idle = requestIdleCallback(run);
  return () => cancelIdleCallback(idle);
}
