import { describe, expect, test } from "bun:test";
import { mulberry32, planTestOrder } from "../../src/core/test-order-plan";

const selection = [
  { codeunitId: 50100, method: "A" },
  { codeunitId: 50100, method: "B" },
  { codeunitId: 50101, method: "C" },
  { codeunitId: 50100, method: "D" },
  { codeunitId: 50102, method: "E" },
];

const order = (plan: ReturnType<typeof planTestOrder>) =>
  plan.initializes.map(({ groups: [g] }) => `${g.id}:${g.methods[0]}`);

describe("planTestOrder", () => {
  test("recorded keeps selection order, one single-method group per Initialize", () => {
    const plan = planTestOrder(selection, { mode: "recorded" });
    expect(plan.mode).toBe("recorded");
    expect(order(plan)).toEqual(["50100:A", "50100:B", "50101:C", "50100:D", "50102:E"]);
    for (const init of plan.initializes) {
      expect(init.groups).toHaveLength(1);
      expect(init.groups[0].methods).toHaveLength(1);
    }
  });

  test("reversed reverses without mutating the selection", () => {
    const before = JSON.stringify(selection);
    expect(order(planTestOrder(selection, { mode: "reversed" }))).toEqual([
      "50102:E", "50100:D", "50101:C", "50100:B", "50100:A",
    ]);
    expect(JSON.stringify(selection)).toBe(before);
  });

  test("shuffle is a deterministic permutation per seed", () => {
    const a = planTestOrder(selection, { mode: "shuffle", seed: 7 });
    const b = planTestOrder(selection, { mode: "shuffle", seed: 7 });
    expect(a).toEqual(b);
    expect(a.seed).toBe(7);
    expect([...order(a)].sort()).toEqual(order(planTestOrder(selection, { mode: "recorded" })).sort());
    const distinct = new Set([1, 2, 3, 4, 5, 6].map((seed) => order(planTestOrder(selection, { mode: "shuffle", seed })).join()));
    expect(distinct.size).toBeGreaterThan(1);
  });

  test("shuffle output is pinned for a seed (cross-version reproducibility)", () => {
    expect(order(planTestOrder(selection, { mode: "shuffle", seed: 42 }))).toEqual([
      "50100:A", "50102:E", "50101:C", "50100:B", "50100:D",
    ]);
  });

  test("rejects a non-integer or out-of-range seed", () => {
    expect(() => planTestOrder(selection, { mode: "shuffle", seed: 1.5 })).toThrow(/seed/);
    expect(() => planTestOrder(selection, { mode: "shuffle", seed: -1 })).toThrow(/seed/);
    expect(() => planTestOrder(selection, { mode: "shuffle", seed: 2 ** 32 })).toThrow(/seed/);
  });

  test("empty selection plans nothing", () => {
    expect(planTestOrder([], { mode: "shuffle", seed: 1 }).initializes).toEqual([]);
  });
});

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
