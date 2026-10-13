import { BcDevError } from "./agent-errors";
import type { TestCodeunitInfo } from "./al-objects";
import { redactAuthorization } from "./redaction";
import { analyzeTestOrder, type OrderRun, type OrderRunResult, type TestOrderAnalysis } from "./test-order-analysis";
import { bisectPolluters, type BisectResult, type OrderRunner } from "./test-order-bisect";
import { planTestOrder } from "./test-order-plan";
import { identityKey, type OrchestratedTestIdentity } from "./test-orchestration";
import type { CodeunitTestGroup, RunTestsResult } from "./types";

/** Each Initialize costs a full server round; order mode is diagnostic, not a suite sweep. */
export const ORDER_MODE_MAX_METHODS = 50;

export interface OrderSelectionMethod extends OrchestratedTestIdentity {
  transactionModel: string;
}

/**
 * Pure: expand a codeunits selection against local discovery into identities in recorded order
 * (codeunits as given, methods in declaration order, declared spelling). Order mode needs the
 * declaration order (the server ignores testMethods[] order) and each method's TransactionModel.
 */
export function expandOrderSelection(
  requested: readonly CodeunitTestGroup[],
  discovered: readonly TestCodeunitInfo[],
): OrderSelectionMethod[] {
  const seen = new Set<number>();
  const selection: OrderSelectionMethod[] = [];
  for (const group of requested) {
    if (seen.has(group.id)) {
      throw new BcDevError("INVALID_ARGUMENT", `Codeunit ${group.id} is listed more than once; order mode needs each codeunit once (list all its methods in one entry)`, "validation");
    }
    seen.add(group.id);
    const codeunit = discovered.find((c) => c.codeunitId === group.id);
    if (!codeunit) {
      throw new BcDevError(
        "NOT_FOUND",
        `Test codeunit ${group.id} was not found in the local AL project; order mode reads its declaration order and TransactionModel from source. Point project at the app that contains it.`,
        "configuration",
        false,
        { codeunitId: group.id },
      );
    }
    const wanted = group.methods?.map((m) => identityKey(group.id, m));
    for (const name of wanted ?? []) {
      if (!codeunit.methodDetails.some((m) => identityKey(group.id, m.name) === name)) {
        const method = group.methods![wanted!.indexOf(name)];
        throw new BcDevError("INVALID_ARGUMENT", `Codeunit ${group.id} has no [Test] method "${method}" in local source`, "validation");
      }
    }
    for (const m of codeunit.methodDetails) {
      if (!wanted || wanted.includes(identityKey(group.id, m.name))) {
        selection.push({ codeunitId: group.id, method: m.name, transactionModel: m.transactionModel });
      }
    }
  }
  if (selection.length === 0) {
    throw new BcDevError("INVALID_ARGUMENT", "The selection contains no [Test] methods", "validation");
  }
  if (selection.length > ORDER_MODE_MAX_METHODS) {
    throw new BcDevError(
      "INVALID_ARGUMENT",
      `Order mode runs one Initialize per method plus one per order; ${selection.length} methods exceeds the ${ORDER_MODE_MAX_METHODS}-method cap. Narrow codeunits/methods to the suspect set.`,
      "validation",
    );
  }
  return selection;
}

export interface OrderModeOptions {
  selection: readonly OrchestratedTestIdentity[];
  seeds: readonly number[];
  maxProbes?: number;
  /** Runs groups in one Initialize. May throw; a throw or runAborted halts every later Initialize. */
  execute: (groups: CodeunitTestGroup[]) => Promise<RunTestsResult>;
  cancelled?: () => boolean;
}

export interface OrderModeResult {
  analysis: TestOrderAnalysis;
  bisection: BisectResult;
  /** Raw failure output of each method's first failing observation, by identityKey. */
  firstFailureOutput: Map<string, string>;
  initializes: number;
  complete: boolean;
  warnings: string[];
}

/**
 * Isolation (each method alone), recorded, reversed and one shuffle per seed, then pairwise
 * bisection of every od-victim. Strictly sequential: one Initialize at a time.
 */
export async function runOrderMode(opts: OrderModeOptions): Promise<OrderModeResult> {
  const warnings: string[] = [];
  const firstFailureOutput = new Map<string, string>();
  let halted: string | null = null;
  let initializes = 0;

  const runner: OrderRunner = async (plan) => {
    if (halted) return [];
    if (opts.cancelled?.()) {
      halted = "Client cancellation was observed; no later Initialize was started. An active server run is never cancelled.";
      return [];
    }
    initializes++;
    let result: RunTestsResult;
    try {
      result = await opts.execute(plan.groups.map((g) => ({ id: g.id, methods: [...g.methods] })));
    } catch (error) {
      halted = `Initialize ${initializes} failed before a complete server result: ${redactAuthorization(error instanceof Error ? error.message : String(error))}`;
      return [];
    }
    if (result.runAborted === true) {
      halted = `Initialize ${initializes} aborted (${result.abortReason ?? "no reason given"}); later Initializes were not started because the server run may still be active.`;
    }
    const rows: OrderRunResult[] = [];
    for (const r of result.results) {
      if (r.method === "") continue; // synthetic summary row
      rows.push({ codeunitId: r.codeunitId, method: r.method, status: r.status });
      const key = identityKey(r.codeunitId, r.method);
      if (r.status === "failed" && !firstFailureOutput.has(key)) firstFailureOutput.set(key, r.output);
    }
    return rows;
  };

  const isolation: OrderRunResult[] = [];
  for (const method of opts.selection) isolation.push(...(await runner(planTestOrder([method], { mode: "recorded" }))));
  const plans = [
    planTestOrder(opts.selection, { mode: "recorded" }),
    planTestOrder(opts.selection, { mode: "reversed" }),
    ...opts.seeds.map((seed) => planTestOrder(opts.selection, { mode: "shuffle", seed })),
  ];
  const runs: OrderRun[] = [];
  for (const plan of plans) runs.push({ plan, results: await runner(plan) });

  const analysis = analyzeTestOrder({ isolation, runs });
  const victims = analysis.tests.filter((t) => t.classification === "odVictim");
  const bisection = await bisectPolluters({ victims, runner, maxProbes: opts.maxProbes });

  if (halted) warnings.push(halted);
  if (new Set(opts.selection.map((m) => m.codeunitId)).size === 1) {
    warnings.push("One codeunit selected: reversed and shuffled orders only permute codeunit groups, so they repeat the recorded order. Victims are found by isolation versus the full group.");
  }
  if (bisection.capped) warnings.push(`Bisection stopped at the ${bisection.maxProbes}-probe cap; capped victims keep their remainingCandidates.`);
  const unresolved = bisection.victims.filter((v) => v.outcome !== "found").length;
  if (unresolved > 0) warnings.push(`${unresolved} od-victim(s) were not narrowed to a single polluter; see bisection.victims[].outcome.`);

  return {
    analysis,
    bisection,
    firstFailureOutput,
    initializes,
    complete: halted === null && analysis.summary.incomplete === 0 && unresolved === 0,
    warnings,
  };
}
