import { identityKey, type OrchestratedTestIdentity, type TestObservationStatus } from "./test-orchestration";
import { planExecutionOrder, type TestOrderMode, type TestOrderPlan } from "./test-order-plan";

export interface OrderRunResult extends OrchestratedTestIdentity {
  status: TestObservationStatus;
}

/** One executed plan and the per-method results it produced. */
export interface OrderRun {
  plan: TestOrderPlan;
  results: OrderRunResult[];
}

export interface OrderAnalysisInput {
  /** Each method run alone (its own Initialize, nothing before it). Required for victim/brittle classes. */
  isolation?: OrderRunResult[];
  runs: OrderRun[];
}

export type OrderClassification =
  | "consistentPass"
  | "consistentFail"
  /** Passes in isolation, fails after some other method(s). */
  | "odVictim"
  /** Fails in isolation, passes after some other method(s) (needs a state-setter). */
  | "odBrittle"
  /** Pass and fail with the same preceding methods: not explained by order. */
  | "flakyInSameOrder"
  /** Order-dependent outcome but no isolation result to tell victim from brittle. */
  | "orderDependent"
  /** No passed/failed observation. */
  | "incomplete";

export interface OrderObservation {
  run: number | "isolation";
  status: TestObservationStatus;
}

export interface OrderAnalyzedTest extends OrchestratedTestIdentity {
  classification: OrderClassification;
  /** odVictim only: methods that preceded it in every failing run (bisection narrows further). */
  candidatePolluters: OrchestratedTestIdentity[];
  /** Indexes into runs[] where this method failed. */
  failingRuns: number[];
  observations: OrderObservation[];
}

export interface TestOrderAnalysis {
  runs: { mode: TestOrderMode; seed?: number; order: string[] }[];
  tests: OrderAnalyzedTest[];
  summary: Record<OrderClassification, number>;
}

const CLASSES: OrderClassification[] = [
  "consistentPass", "consistentFail", "odVictim", "odBrittle", "flakyInSameOrder", "orderDependent", "incomplete",
];

/**
 * Pure: classify each method's outcomes across orders. Predecessors are every method executed
 * earlier in the same plan (one Initialize). Committed rows only reach later methods of the same
 * codeunit group; session state (SingleInstance) reaches later groups too (see TestOrderPlan).
 * `isolation` must be each method run alone (planTestOrder([method])): it is the only way to see
 * a same-codeunit victim, since its in-group predecessors are identical in every mode.
 */
export function analyzeTestOrder(input: OrderAnalysisInput): TestOrderAnalysis {
  const orders = input.runs.map(({ plan }) => planExecutionOrder(plan));
  const lookup = (rows: OrderRunResult[] | undefined) =>
    new Map((rows ?? []).map((r) => [identityKey(r.codeunitId, r.method), r.status]));
  const isolation = lookup(input.isolation);
  const runResults = input.runs.map((r) => lookup(r.results));

  // Methods in first-seen plan order.
  const methods = new Map<string, OrchestratedTestIdentity>();
  for (const order of orders) for (const id of order) {
    const key = identityKey(id.codeunitId, id.method);
    if (!methods.has(key)) methods.set(key, id);
  }

  const tests = [...methods].map(([key, id]): OrderAnalyzedTest => {
    const observations: OrderObservation[] = [];
    const iso = isolation.get(key);
    if (iso) observations.push({ run: "isolation", status: iso });
    // Predecessor-set key -> statuses seen with exactly those predecessors.
    const byPrefix = new Map<string, Set<TestObservationStatus>>();
    // Isolation is the empty-predecessor observation: same conditions as running first.
    if (iso) byPrefix.set("", new Set([iso]));
    const failingPrefixes: OrchestratedTestIdentity[][] = [];
    const failingRuns: number[] = [];
    orders.forEach((order, run) => {
      const status = runResults[run]!.get(key);
      if (!status) return;
      observations.push({ run, status });
      const index = order.findIndex((o) => identityKey(o.codeunitId, o.method) === key);
      const prefix = order.slice(0, index);
      const prefixKey = prefix.map((o) => identityKey(o.codeunitId, o.method)).join("\u0001");
      byPrefix.set(prefixKey, (byPrefix.get(prefixKey) ?? new Set()).add(status));
      if (status === "failed") {
        failingRuns.push(run);
        failingPrefixes.push(prefix);
      }
    });

    const ordered = observations.filter((o) => o.run !== "isolation").map((o) => o.status);
    const decisive = (s: TestObservationStatus) => s === "passed" || s === "failed";
    let classification: OrderClassification;
    if ([...byPrefix.values()].some((s) => s.has("passed") && s.has("failed"))) {
      classification = "flakyInSameOrder";
    } else if (!observations.some((o) => decisive(o.status))) {
      classification = "incomplete";
    } else {
      const anyPass = ordered.includes("passed");
      const anyFail = ordered.includes("failed");
      if (iso === "passed" && anyFail) classification = "odVictim";
      else if (iso === "failed" && anyPass) classification = "odBrittle";
      else if (anyPass && anyFail) classification = "orderDependent";
      else classification = (anyFail || iso === "failed") ? "consistentFail" : "consistentPass";
    }

    const candidatePolluters = classification === "odVictim"
      ? failingPrefixes[0]!.filter((p) =>
          failingPrefixes.every((prefix) =>
            prefix.some((o) => identityKey(o.codeunitId, o.method) === identityKey(p.codeunitId, p.method)),
          ),
        )
      : [];
    return { ...id, classification, candidatePolluters, failingRuns, observations };
  });

  const summary = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<OrderClassification, number>;
  for (const t of tests) summary[t.classification]++;

  return {
    runs: input.runs.map(({ plan }, i) => ({
      mode: plan.mode,
      ...(plan.seed !== undefined ? { seed: plan.seed } : {}),
      order: orders[i]!.map((o) => `${o.codeunitId}:${o.method}`),
    })),
    tests,
    summary,
  };
}
