import type { OrderAnalyzedTest, OrderRunResult } from "./test-order-analysis";
import { identityKey, type OrchestratedTestIdentity } from "./test-orchestration";
import { planTestOrder, type TestOrderPlan } from "./test-order-plan";

/** Injected executor: runs a plan (one Initialize, its groups in order) and returns per-method results. */
export type OrderRunner = (plan: TestOrderPlan) => Promise<OrderRunResult[]>;

export type BisectOutcome =
  /** A single preceding method reproduces the failure (verified by a [polluter, victim] probe). */
  | "found"
  /** The victim passed after all candidates: the failing order was not reproduced. */
  | "notReproduced"
  /** Neither half alone reproduces: pollution needs methods from both halves of remainingCandidates. */
  | "compound"
  /** The probe cap was reached; remainingCandidates still contains the polluter(s). */
  | "capped"
  /** A probe gave no passed/failed status for the victim. */
  | "inconclusive";

export interface BisectedVictim extends OrchestratedTestIdentity {
  outcome: BisectOutcome;
  polluter?: OrchestratedTestIdentity;
  /** Smallest candidate set known to reproduce the failure (unverified for notReproduced/inconclusive). */
  remainingCandidates: OrchestratedTestIdentity[];
  probes: number;
  /** Present when static predictions seeded this victim: each predicted polluter probed alone first (null = inconclusive). */
  predictionProbes?: { polluter: OrchestratedTestIdentity; reproduced: boolean | null }[];
}

export interface BisectResult {
  victims: BisectedVictim[];
  probes: number;
  maxProbes: number;
  capped: boolean;
}

export interface BisectInput {
  /** odVictim rows from analyzeTestOrder (candidatePolluters in the order they preceded the victim). */
  victims: (Pick<OrderAnalyzedTest, "codeunitId" | "method" | "candidatePolluters"> & {
    /** Statically predicted polluters, probed one by one as [polluter, victim] before bisecting. */
    predictedPolluters?: OrchestratedTestIdentity[];
  })[];
  runner: OrderRunner;
  /** Total probe budget across all victims. Default 50. */
  maxProbes?: number;
}

/**
 * Pairwise bisection: confirm candidates+victim fails, then halve the candidate list, keeping the
 * half that still fails, until one polluter remains. Each probe is one Initialize: other-codeunit
 * candidates' groups first, then the victim's own group holding its same-codeunit candidates and
 * the victim (declaration order, so they precede it). Victims are processed sequentially.
 */
export async function bisectPolluters(input: BisectInput): Promise<BisectResult> {
  const maxProbes = input.maxProbes ?? 50;
  if (!Number.isInteger(maxProbes) || maxProbes < 1) {
    throw new RangeError(`maxProbes must be a positive integer, got ${maxProbes}`);
  }
  let probes = 0;

  const victims: BisectedVictim[] = [];
  for (const victim of input.victims) {
    const key = identityKey(victim.codeunitId, victim.method);
    let used = 0;
    // true = victim failed (polluted), false = passed, undefined = inconclusive or capped.
    const probe = async (candidates: OrchestratedTestIdentity[]) => {
      probes++;
      used++;
      // Victim's codeunit group last, so every other-codeunit candidate still runs before it.
      const others = candidates.filter((c) => c.codeunitId !== victim.codeunitId);
      const same = candidates.filter((c) => c.codeunitId === victim.codeunitId);
      const results = await input.runner(planTestOrder([...others, ...same, victim], { mode: "recorded" }));
      const status = results.find((r) => identityKey(r.codeunitId, r.method) === key)?.status;
      return status === "failed" ? true : status === "passed" ? false : undefined;
    };
    const isCandidate = (p: OrchestratedTestIdentity) =>
      victim.candidatePolluters.some((c) => identityKey(c.codeunitId, c.method) === identityKey(p.codeunitId, p.method));
    const hints = (victim.predictedPolluters ?? []).filter((p, i, all) =>
      isCandidate(p) && all.findIndex((q) => identityKey(q.codeunitId, q.method) === identityKey(p.codeunitId, p.method)) === i);
    const predictionProbes: NonNullable<BisectedVictim["predictionProbes"]> = [];
    const done = (outcome: BisectOutcome, remaining: OrchestratedTestIdentity[]): BisectedVictim => ({
      codeunitId: victim.codeunitId,
      method: victim.method,
      outcome,
      ...(outcome === "found" ? { polluter: remaining[0] } : {}),
      remainingCandidates: remaining,
      probes: used,
      ...(victim.predictedPolluters ? { predictionProbes } : {}),
    });

    const bisect = async (): Promise<BisectedVictim> => {
      let remaining = [...victim.candidatePolluters];
      // Predicted polluters first: one failing [polluter, victim] probe is the verified "found".
      for (const hint of hints) {
        if (probes >= maxProbes) return done("capped", remaining);
        const failed = await probe([hint]);
        predictionProbes.push({ polluter: hint, reproduced: failed ?? null });
        if (failed) return done("found", [hint]);
      }
      if (probes >= maxProbes) return done("capped", remaining);
      const confirmed = await probe(remaining);
      if (confirmed === undefined) return done("inconclusive", remaining);
      if (!confirmed) return done("notReproduced", remaining);
      while (remaining.length > 1) {
        const mid = Math.ceil(remaining.length / 2);
        let narrowed = false;
        for (const half of [remaining.slice(0, mid), remaining.slice(mid)]) {
          if (probes >= maxProbes) return done("capped", remaining);
          const failed = await probe(half);
          if (failed === undefined) return done("inconclusive", remaining);
          if (failed) {
            remaining = half;
            narrowed = true;
            break;
          }
        }
        if (!narrowed) return done("compound", remaining);
      }
      // The last failing probe was exactly [polluter, victim]. No candidates = failed on its own.
      return done(remaining.length === 1 ? "found" : "inconclusive", remaining);
    };
    victims.push(await bisect());
  }

  return { victims, probes, maxProbes, capped: victims.some((v) => v.outcome === "capped") };
}
