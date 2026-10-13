import type { OrchestratedTestIdentity } from "./test-orchestration";

export type TestOrderMode = "recorded" | "reversed" | "shuffle";

export type TestOrderRequest =
  | { mode: "recorded" | "reversed" }
  | { mode: "shuffle"; seed: number };

/** One RunTests group holding exactly one method. */
export interface SingleMethodGroup {
  id: number;
  methods: [string];
}

/**
 * One hub connection (Initialize) running exactly one group.
 * WIRE: a codeunit may run only once per Initialize (a second RunTests for it kills the hub),
 * and methods inside one group run in declaration order regardless of testMethods[] order,
 * so a caller-controlled method order needs one single-method group per Initialize.
 * Every group is rolled back, so separate Initializes are data-equivalent. (scripts/e2e.md #33)
 */
export interface PlannedInitialize {
  groups: [SingleMethodGroup];
}

export interface TestOrderPlan {
  mode: TestOrderMode;
  /** Present for shuffle: replaying the same selection + seed yields the same plan. */
  seed?: number;
  /** Execute in array order, each on its own connection. */
  initializes: PlannedInitialize[];
}

/** Seeded 32-bit PRNG (mulberry32); returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pure: selection (recorded order) + mode (+ seed) -> ordered plan of one Initialize per method. */
export function planTestOrder(
  selection: readonly OrchestratedTestIdentity[],
  request: TestOrderRequest,
): TestOrderPlan {
  const ordered = [...selection];
  if (request.mode === "reversed") ordered.reverse();
  if (request.mode === "shuffle") {
    if (!Number.isInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff) {
      throw new RangeError(`seed must be an integer in [0, 4294967295], got ${request.seed}`);
    }
    // Fisher-Yates.
    const random = mulberry32(request.seed);
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
    }
  }
  return {
    mode: request.mode,
    ...(request.mode === "shuffle" ? { seed: request.seed } : {}),
    initializes: ordered.map(({ codeunitId, method }) => ({ groups: [{ id: codeunitId, methods: [method] }] })),
  };
}
