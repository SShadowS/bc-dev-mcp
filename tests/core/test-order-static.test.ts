import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverTests } from "../../src/core/al-objects";
import { BasicAuthorizationProvider } from "../../src/core/authorization";
import { ALSEM_ENV_VAR, type CommandRunner } from "../../src/core/call-graph";
import { TestRunnerClient } from "../../src/core/hubs/test-runner-hub";
import { expandOrderSelection, runOrderMode } from "../../src/core/test-order-mode";
import { identityKey } from "../../src/core/test-orchestration";
import {
  createAlSemOrderPredictor,
  digestWrites,
  explainPredictions,
  predictOrderPollution,
  readAlSemEnvelope,
  touchingRoutines,
  type OrderPredictionMethod,
  type PredictedPollution,
} from "../../src/core/test-order-static";
import type { CodeunitTestGroup, ConnectionConfig } from "../../src/core/types";
import { fakeHubFactory } from "../fakes/fake-hub";
import { orderPollutionHub, POLLUTION_CODEUNIT as CU } from "../fakes/order-pollution-hub";

const demo = join(import.meta.dir, "../../demos/order-pollution");
const fixtures = join(import.meta.dir, "../fixtures/alsem-order");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");
const FLAG = "6f1c2b9e-4d3a-4e8b-9a71-0c5d2e8f4b16/table/50160";

async function demoSelection(): Promise<OrderPredictionMethod[]> {
  const discovered = await discoverTests(demo);
  return expandOrderSelection([{ id: CU }], discovered).map((m) => ({ ...m, file: discovered[0]!.file }));
}

const payload = (text: string, kind: "digest" | "query.touches") => {
  const env = readAlSemEnvelope(text, kind);
  if (typeof env === "string") throw new Error(env);
  return env.payload;
};

const pairsOf = (pairs: PredictedPollution[]) =>
  pairs.map((p) => [p.polluter.method, p.victim.method, p.table?.id ?? null, p.survives]);

/** Replays the recorded outputs for the commands the predictor runs, recording each call. */
function recordedRunner(calls: string[][]): CommandRunner {
  return async (_binary, args) => {
    calls.push(args);
    const out = args[args.indexOf("--out") + 1]!;
    const source = args[0] === "digest" ? "digest.json" : args.includes("unknown") ? "touches-unknown.json" : "touches-50160.json";
    copyFileSync(join(fixtures, source), out);
  };
}

const EXPECTED = [
  ["PolluterCommitsCustomer", "VictimInsertsSameCustomer", null, "explicitCommit"],
  ["PolluterCommitsCustomer", "IndependentRolledBackWrite", null, "explicitCommit"],
  ["PolluterCommitsFlag", "VictimExpectsNoFlag", FLAG, "explicitCommit"],
];

describe("static order-pollution prediction (recorded al-sem output, demos/order-pollution)", () => {
  test("digest + touches -> polluter/victim pairs under the hub's isolation", async () => {
    const digest = digestWrites(payload(fixture("digest.json"), "digest"));
    expect(digest.warnings).toEqual([]);
    // IndependentRolledBackWrite writes Customer too, but it is AutoRollback: never a polluter.
    expect([...digest.writes.keys()].sort()).toEqual(
      ["IndependentRolledBackWrite", "PolluterCommitsCustomer", "PolluterCommitsFlag", "VictimInsertsSameCustomer"].map((m) => identityKey(CU, m)).sort(),
    );
    const touches = new Map([
      [FLAG, touchingRoutines(payload(fixture("touches-50160.json"), "query.touches"))],
      ["unknown", touchingRoutines(payload(fixture("touches-unknown.json"), "query.touches"))],
    ]);
    const pairs = predictOrderPollution(await demoSelection(), digest, touches);
    expect(pairsOf(pairs)).toEqual(EXPECTED);
    expect(pairs[2]!.reason).toContain("table Order Pollution Flag");
    expect(pairs[0]!.reason).toContain("could not resolve");
  });

  test("isolation: no pair across codeunits, none upward, none from AutoRollback", async () => {
    const digest = digestWrites(payload(fixture("digest.json"), "digest"));
    const touches = new Map([[FLAG, touchingRoutines(payload(fixture("touches-50160.json"), "query.touches"))]]);
    const selection = await demoSelection();
    const flag = selection.find((m) => m.method === "PolluterCommitsFlag")!;
    const victim = selection.find((m) => m.method === "VictimExpectsNoFlag")!;
    expect(predictOrderPollution([victim, flag], digest, touches)).toEqual([]); // victim declared above
    expect(predictOrderPollution([flag, { ...victim, codeunitId: CU + 1 }], digest, touches)).toEqual([]);
    expect(predictOrderPollution([{ ...flag, transactionModel: "AutoRollback" }, victim], digest, touches)).toEqual([]);
    const plain = predictOrderPollution([flag, victim], { ...digest, explicitCommit: new Set() }, touches);
    expect(plain.map((p) => p.survives)).toEqual(["transactionModel"]);
  });

  test("envelope: wrong kind or unknown schema major is a warning, not a parse", () => {
    const env = JSON.parse(fixture("digest.json"));
    expect(readAlSemEnvelope(JSON.stringify({ ...env, schemaVersion: "2.0.0" }), "digest")).toContain("not supported");
    expect(readAlSemEnvelope(fixture("digest.json"), "query.touches")).toContain("is not 'query.touches'");
    expect(readAlSemEnvelope("not json", "digest")).toContain("not JSON");
  });

  test("predictor: one digest over the codeunit file, one touches per committed table", async () => {
    const calls: string[][] = [];
    const r = await createAlSemOrderPredictor({ [ALSEM_ENV_VAR]: "alsem" }, recordedRunner(calls))(demo, await demoSelection());
    expect(r.warnings).toEqual([]);
    expect(r.prediction?.alsemVersion).toBe("1.5.0");
    expect(pairsOf(r.prediction!.pairs)).toEqual(EXPECTED);
    // Drop the workspace root and the trailing --out <tmp file>.
    expect(calls.map((c) => c.filter((a) => a !== resolve(demo)).slice(0, -2))).toEqual([
      ["digest", "--file", "src/OrderPollutionTests.Codeunit.al"],
      ["query", "touches", "--table", "unknown", "--format", "json"],
      ["query", "touches", "--table", FLAG, "--format", "json"],
    ]);
  });

  test("predictor: alsem missing or unknown schema -> no prediction, one warning", async () => {
    const enoent: CommandRunner = async () => {
      throw Object.assign(new Error("spawn alsem ENOENT"), { code: "ENOENT" });
    };
    const missing = await createAlSemOrderPredictor({}, enoent)(demo, await demoSelection());
    expect(missing.prediction).toBeNull();
    expect(missing.warnings).toHaveLength(1);
    expect(missing.warnings[0]).toContain(ALSEM_ENV_VAR);

    const future: CommandRunner = async (_b, args) => {
      const env = JSON.parse(fixture("digest.json"));
      writeFileSync(args[args.indexOf("--out") + 1]!, JSON.stringify({ ...env, schemaVersion: "2.0.0" }));
    };
    const unknown = await createAlSemOrderPredictor({}, future)(demo, await demoSelection());
    expect(unknown.prediction).toBeNull();
    expect(unknown.warnings[0]).toContain("schemaVersion 2.0.0");
  });
});

describe("predictions seed the bisect and are explained by it (order-pollution FakeHub)", () => {
  const config: ConnectionConfig = {
    environmentType: "OnPrem", authentication: "UserPassword", server: "http://localhost", serverInstance: "BC", username: "u", password: "p",
  };
  const execute = (groups: CodeunitTestGroup[]) =>
    new TestRunnerClient(fakeHubFactory(orderPollutionHub())).run(config, new BasicAuthorizationProvider("u", "p"), groups);

  test("predicted polluters are found with one probe each; a wrong prediction is refuted", async () => {
    const selection = await demoSelection();
    const prediction = await createAlSemOrderPredictor({}, recordedRunner([]))(demo, selection);
    const pairs = prediction.prediction!.pairs;
    const seeded = await runOrderMode({ selection, seeds: [1], execute, predictions: pairs });
    const plain = await runOrderMode({ selection, seeds: [1], execute });
    expect(seeded.bisection.victims.map((v) => [v.method, v.outcome, v.polluter?.method, v.probes])).toEqual([
      ["VictimInsertsSameCustomer", "found", "PolluterCommitsCustomer", 1],
      ["VictimExpectsNoFlag", "found", "PolluterCommitsFlag", 1],
    ]);
    expect(seeded.bisection.probes).toBeLessThan(plain.bisection.probes);
    expect(seeded.bisection.victims[0]!.predictionProbes).toEqual([
      { polluter: { codeunitId: CU, method: "PolluterCommitsCustomer" }, reproduced: true },
    ]);
    const explained = explainPredictions(pairs, seeded.analysis, seeded.bisection);
    expect(explained.map((p) => [p.victim.method, p.dynamic])).toEqual([
      ["VictimInsertsSameCustomer", "confirmed"],
      ["IndependentRolledBackWrite", "refuted"],
      ["VictimExpectsNoFlag", "confirmed"],
    ]);
  });

  test("a predicted polluter that does not reproduce falls back to bisection", async () => {
    const selection = await demoSelection();
    const wrong: PredictedPollution = {
      polluter: { codeunitId: CU, method: "IndependentArithmetic" },
      victim: { codeunitId: CU, method: "VictimExpectsNoFlag" },
      table: null, survives: "transactionModel", reason: "test",
    };
    const r = await runOrderMode({ selection, seeds: [1], execute, predictions: [wrong] });
    const victim = r.bisection.victims.find((v) => v.method === "VictimExpectsNoFlag")!;
    expect([victim.outcome, victim.polluter?.method]).toEqual(["found", "PolluterCommitsFlag"]);
    expect(victim.predictionProbes).toEqual([{ polluter: wrong.polluter, reproduced: false }]);
    expect(explainPredictions([wrong], r.analysis, r.bisection)[0]!.dynamic).toBe("refuted");
  });
});

/** The alsem binary to run live, when one is installed (BC_DEV_ALSEM or alsem on PATH). */
function liveAlsem(): string | undefined {
  const binary = process.env[ALSEM_ENV_VAR]?.trim() || "alsem";
  const probe = spawnSync(binary, ["digest", "--help"], { encoding: "utf8", windowsHide: true });
  return probe.status === 0 ? binary : undefined;
}

describe("live alsem (skipped unless alsem is installed)", () => {
  const binary = liveAlsem();
  test.if(binary !== undefined)("predicts the same pairs from demos/order-pollution as the recorded output", async () => {
    const r = await createAlSemOrderPredictor({ [ALSEM_ENV_VAR]: binary })(demo, await demoSelection());
    expect(r.warnings).toEqual([]);
    expect(pairsOf(r.prediction!.pairs)).toEqual(EXPECTED);
  }, 60_000);
});
