// tests/core/snapshot/profile-summary.test.ts
import { describe, expect, test } from "bun:test";
import { summarizeProfile } from "../../../src/core/snapshot/profile-summary";

const fixture = JSON.stringify({
  nodes: [
    { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 } },
    { id: 2, callFrame: { functionName: "OnOpenPage", url: "al://Page_22.dal", lineNumber: 10 } },
    { id: 3, callFrame: { functionName: "CalcFields", url: "al://Table_18.dal", lineNumber: 200 } },
  ],
  samples: [2, 2, 3, 2], // node 2 three times, node 3 once
  timeDeltas: [100, 100, 500, 100], // microseconds; node 3's single sample is the heaviest
  startTime: 1000,
  endTime: 1600,
});

describe("summarizeProfile", () => {
  test("ranks hotspots by self time with correct math", () => {
    const s = summarizeProfile(fixture);
    expect(s.sampleCount).toBe(4);
    expect(s.nodeCount).toBe(3);
    expect(s.durationMs).toBe(0.6); // (1600-1000)/1000
    // CalcFields ranks first despite FEWER samples (1 vs 3) — proves the sort key is
    // self time, not sample count, and that ordering is descending (not ascending).
    expect(s.hotspots[0]!.function).toBe("CalcFields");
    expect(s.hotspots[0]!.selfSamples).toBe(1);
    expect(s.hotspots[0]!.selfMs).toBeCloseTo(0.5, 5); // 500/1000
    expect(s.hotspots[0]!.selfPct).toBeCloseTo(62.5, 3); // 500 of 800 micros
    expect(s.hotspots[1]!.function).toBe("OnOpenPage");
    expect(s.hotspots[1]!.selfSamples).toBe(3);
    expect(s.hotspots[1]!.selfMs).toBeCloseTo(0.3, 5); // (100+100+100)/1000
    expect(s.hotspots[1]!.selfPct).toBeCloseTo(37.5, 3); // 300 of 800 micros
  });

  test("honours topN and keeps the top-ranked hotspot", () => {
    const top = summarizeProfile(fixture, 1).hotspots;
    expect(top).toHaveLength(1);
    expect(top[0]!.function).toBe("CalcFields"); // the larger self time survives the slice
  });

  test("missing callFrame falls back to (anonymous)/\"\"/-1", () => {
    // Node id 99 is sampled but absent from nodes → byId.get() is undefined → empty callFrame.
    const noFrame = JSON.stringify({
      nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 } }],
      samples: [99],
      timeDeltas: [100],
      startTime: 0,
      endTime: 100,
    });
    const s = summarizeProfile(noFrame);
    expect(s.hotspots).toHaveLength(1);
    expect(s.hotspots[0]!.function).toBe("(anonymous)");
    expect(s.hotspots[0]!.url).toBe("");
    expect(s.hotspots[0]!.line).toBe(-1);
  });

  test("empty profile yields a zeroed summary", () => {
    const empty = JSON.stringify({ nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 0 });
    expect(summarizeProfile(empty)).toEqual({
      durationMs: 0,
      sampleCount: 0,
      nodeCount: 0,
      hotspots: [],
    });
  });
});
