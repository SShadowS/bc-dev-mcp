import type { OrchestratedTestIdentity } from "./test-orchestration";

export type TestOrderMode = "recorded" | "reversed" | "shuffle";

export type TestOrderRequest =
  | { mode: "recorded" | "reversed" }
  | { mode: "shuffle"; seed: number };

/** One RunTests group: every selected method of one codeunit, in selection (declaration) order. */
export interface CodeunitOrderGroup {
  id: number;
  methods: string[];
}

/**
 * One plan = one hub connection (Initialize) running `groups` in array order.
 * WIRE: data is rolled back per RunTests group (even explicit Commit()), so committed-row
 * pollution is only observable between methods sharing ONE group; a method alone per group can
 * never see another method's rows. Inside a group methods run in declaration order whatever the
 * testMethods[] order, and a codeunit may run only once per Initialize. Groups of one Initialize
 * share a session, so SingleInstance codeunit globals carry across groups; a fresh Initialize is a
 * fresh session. Number-sequence increments and files leak across groups and Initializes.
 * (scripts/e2e.md #33 and #15 leak probe)
 * So the planner can only permute codeunit groups; within a codeunit, order is fixed and
 * pollution shows up as "passes alone (isolation), fails in its group".
 */
export interface TestOrderPlan {
  mode: TestOrderMode;
  /** Present for shuffle: replaying the same selection + seed yields the same plan. */
  seed?: number;
  groups: CodeunitOrderGroup[];
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

/** Methods in the order the server executes the plan (assumes the selection lists each codeunit's methods in declaration order). */
export function planExecutionOrder(plan: TestOrderPlan): OrchestratedTestIdentity[] {
  return plan.groups.flatMap((g) => g.methods.map((method) => ({ codeunitId: g.id, method })));
}

/**
 * Pure: selection (recorded order; each codeunit's methods in declaration order, as discoverTests
 * returns them) + mode (+ seed) -> one Initialize with one group per codeunit. Codeunit groups keep
 * first-appearance order (recorded), are reversed, or are seeded-shuffled; methods never move
 * within their group because the server would ignore it.
 */
export function planTestOrder(
  selection: readonly OrchestratedTestIdentity[],
  request: TestOrderRequest,
): TestOrderPlan {
  const byCodeunit = new Map<number, CodeunitOrderGroup>();
  for (const { codeunitId, method } of selection) {
    const group = byCodeunit.get(codeunitId) ?? { id: codeunitId, methods: [] };
    group.methods.push(method);
    byCodeunit.set(codeunitId, group);
  }
  const groups = [...byCodeunit.values()];
  if (request.mode === "reversed") groups.reverse();
  if (request.mode === "shuffle") {
    if (!Number.isInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff) {
      throw new RangeError(`seed must be an integer in [0, 4294967295], got ${request.seed}`);
    }
    // Fisher-Yates.
    const random = mulberry32(request.seed);
    for (let i = groups.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [groups[i], groups[j]] = [groups[j]!, groups[i]!];
    }
  }
  return {
    mode: request.mode,
    ...(request.mode === "shuffle" ? { seed: request.seed } : {}),
    groups,
  };
}
