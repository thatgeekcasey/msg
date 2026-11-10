/** A latency distribution in milliseconds. Percentiles are nearest-rank. */
export interface Summary {
  count: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

const round = (value: number) => Math.round(value * 100) / 100;

export function summarize(samples: ArrayLike<number>): Summary | null {
  if (samples.length === 0) return null;
  const sorted = Float64Array.from(samples).sort();
  const at = (q: number) => round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    mean: round(total / sorted.length),
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: round(sorted[sorted.length - 1]!),
  };
}

export const perSecond = (count: number, ms: number) => (ms > 0 ? Math.round((count / ms) * 1000 * 10) / 10 : 0);
