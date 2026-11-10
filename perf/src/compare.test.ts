import { describe, expect, it } from "vitest";
import { compareResults } from "./compare.ts";
import type { Results } from "./report.ts";
import type { ConnectionsStep } from "./scenarios/connections.ts";
import type { Summary } from "./stats.ts";

const summary = (p50: number): Summary => ({ count: 100, mean: p50, p50, p90: p50 * 1.4, p95: p50 * 1.5, p99: p50 * 2, max: p50 * 3 });
const step = (members: number, joinP50: number) => ({ members, connect: summary(joinP50), presenceKbPerJoin: members * 2 }) as ConnectionsStep;

/** A run with one of everything compare looks at, and nothing else. */
function baseline(): Results {
  return {
    environment: { profile: "quick", cpu: "test", cores: 4 } as Results["environment"],
    backend: {
      "do-sqlite": {
        latency: { ack: summary(3), delivery: summary(3.2), lost: 0 },
        throughput: { messagesPerSecond: 1000, outOfOrder: 0, errors: 0, timedOut: false },
        fanout: [{ members: 100, delivery: summary(20), lost: 0, outOfOrder: 0 }],
        connections: { maxConnectP95Ms: 2000, steps: [step(100, 50), step(200, 120)] },
        history: { welcome: summary(6), page: summary(1.7) },
      },
    } as unknown as Results["backend"],
    web: {
      bundle: { code: { gzipKb: 125 } },
      lighthouse: [{ page: "room", formFactor: "mobile", score: 96, lcpMs: 1950, tbtMs: 0, cls: 0 }],
      render: [{ cpuSlowdown: 1, roomReadyMs: 250, bursts: [{ frameToPaint: summary(6), mainThreadMsPerMessage: 6.5, missing: 0 }] }],
    } as unknown as Results["web"],
  };
}

const verdicts = (before: Results, after: Results) =>
  Object.fromEntries(compareResults(before, after, 10).flatMap((row) => (row.verdict ? [[row.metric, row.verdict]] : [])));

describe("compareResults", () => {
  it("reports nothing for swings as large as two runs of the same commit show", () => {
    const before = baseline();
    before.web!.lighthouse[0]!.lcpMs = 1719;
    before.web!.lighthouse[0]!.tbtMs = 128;
    before.web!.render[0]!.bursts[0]!.mainThreadMsPerMessage = 6.09;
    const after = baseline();
    after.backend["do-sqlite"]!.throughput!.messagesPerSecond = 820;
    after.backend["do-sqlite"]!.fanout![0]!.delivery = summary(22.5);
    after.backend["do-sqlite"]!.connections!.steps[1] = step(200, 160);
    after.backend["do-sqlite"]!.history!.welcome = summary(8);
    after.web!.lighthouse[0]!.lcpMs = 1995;
    after.web!.lighthouse[0]!.tbtMs = 265;
    after.web!.render[0]!.bursts[0]!.mainThreadMsPerMessage = 7.07;
    expect(verdicts(before, after)).toEqual({});
  });

  it("ignores changes smaller than a metric's floor", () => {
    const after = baseline();
    after.backend["do-sqlite"]!.latency!.ack = summary(3.8);
    expect(verdicts(baseline(), after)).toEqual({});
  });

  it("ignores a few milliseconds' swing in a short delivery tail", () => {
    const before = baseline();
    before.backend["do-sqlite"]!.fanout![0]!.delivery = { ...summary(4), p95: 5.44 };
    const after = baseline();
    after.backend["do-sqlite"]!.fanout![0]!.delivery = { ...summary(4), p95: 7.92 };
    expect(verdicts(before, after)).toEqual({});
  });

  it("judges a change and its reverse alike", () => {
    const slower = baseline();
    slower.backend["do-sqlite"]!.throughput!.messagesPerSecond = 700;
    expect(verdicts(baseline(), slower)).toEqual({ "do-sqlite throughput: messages/s": "worse" });
    expect(verdicts(slower, baseline())).toEqual({ "do-sqlite throughput: messages/s": "better" });
  });

  it("counts a new delay where there was none", () => {
    const after = baseline();
    after.web!.lighthouse[0]!.tbtMs = 300;
    expect(compareResults(baseline(), after, 10)).toContainEqual({ metric: "lighthouse room mobile: TBT ms", before: 0, after: 300, change: Infinity, verdict: "worse" });
  });

  it("counts any lost message", () => {
    const after = baseline();
    after.backend["do-sqlite"]!.fanout![0]!.lost = 3;
    expect(verdicts(baseline(), after)).toEqual({ "do-sqlite fan-out 100: lost": "worse" });
  });

  it("counts one more lost message even where some were lost before", () => {
    const before = baseline();
    before.backend["do-sqlite"]!.fanout![0]!.lost = 20;
    const after = baseline();
    after.backend["do-sqlite"]!.fanout![0]!.lost = 21;
    expect(verdicts(before, after)).toEqual({ "do-sqlite fan-out 100: lost": "worse" });
  });

  it("fails a run that no longer measures what the baseline did", () => {
    const after = baseline();
    after.backend["do-sqlite"]!.connections!.steps = [step(100, 50)];
    after.backend["do-sqlite"]!.fanout![0]!.delivery = null;
    expect(verdicts(baseline(), after)).toEqual({
      "do-sqlite fan-out 100: delivery p50 ms": "missing",
      "do-sqlite fan-out 100: delivery p95 ms": "missing",
      "do-sqlite room size: most members with join p95 under 2000 ms": "worse",
      "do-sqlite room of 200: join p50 ms": "missing",
      "do-sqlite room of 200: presence KB per join": "missing",
    });
  });
});
