import { describe, expect, test } from "bun:test";
import { mulberry32, planExecutionOrder, planTestOrder } from "../../src/core/test-order-plan";

const selection = [
  { codeunitId: 50100, method: "A" },
  { codeunitId: 50100, method: "B" },
  { codeunitId: 50101, method: "C" },
  { codeunitId: 50100, method: "D" },
  { codeunitId: 50102, method: "E" },
];

const groups = (plan: ReturnType<typeof planTestOrder>) => plan.groups.map((g) => `${g.id}:${g.methods.join(",")}`);

describe("planTestOrder", () => {
  test("recorded: one group per codeunit (codeunit once per Initialize), methods share it in selection order", () => {
    const plan = planTestOrder(selection, { mode: "recorded" });
    expect(plan.mode).toBe("recorded");
    expect(groups(plan)).toEqual(["50100:A,B,D", "50101:C", "50102:E"]);
    expect(planExecutionOrder(plan).map((m) => m.method)).toEqual(["A", "B", "D", "C", "E"]);
  });

  test("reversed reverses codeunit groups, never methods within a group, without mutating the selection", () => {
    const before = JSON.stringify(selection);
    expect(groups(planTestOrder(selection, { mode: "reversed" }))).toEqual(["50102:E", "50101:C", "50100:A,B,D"]);
    expect(JSON.stringify(selection)).toBe(before);
  });

  test("shuffle is a deterministic permutation of codeunit groups per seed", () => {
    const a = planTestOrder(selection, { mode: "shuffle", seed: 7 });
    const b = planTestOrder(selection, { mode: "shuffle", seed: 7 });
    expect(a).toEqual(b);
    expect(a.seed).toBe(7);
    expect([...groups(a)].sort()).toEqual(groups(planTestOrder(selection, { mode: "recorded" })).sort());
    const distinct = new Set([1, 2, 3, 4, 5, 6].map((seed) => groups(planTestOrder(selection, { mode: "shuffle", seed })).join()));
    expect(distinct.size).toBeGreaterThan(1);
  });

  test("shuffle output is pinned for a seed (cross-version reproducibility)", () => {
    expect(groups(planTestOrder(selection, { mode: "shuffle", seed: 42 }))).toEqual(PINNED_42);
  });

  test("rejects a non-integer or out-of-range seed", () => {
    expect(() => planTestOrder(selection, { mode: "shuffle", seed: 1.5 })).toThrow(/seed/);
    expect(() => planTestOrder(selection, { mode: "shuffle", seed: -1 })).toThrow(/seed/);
    expect(() => planTestOrder(selection, { mode: "shuffle", seed: 2 ** 32 })).toThrow(/seed/);
  });

  test("empty selection plans nothing", () => {
    expect(planTestOrder([], { mode: "shuffle", seed: 1 }).groups).toEqual([]);
  });
});

const PINNED_42 = ["50102:E", "50100:A,B,D", "50101:C"];

describe("mulberry32", () => {
  test("is deterministic and in [0, 1)", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x >= 0 && x < 1).toBe(true);
    }
  });
});
