import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createAlSemBreakEffects, runForStdout, type StdoutRunner } from "../../src/core/break-effects";

const FIX = resolve(import.meta.dir, "../fixtures/alsem-prove");
const rec = (name: string) => readFileSync(join(FIX, "recorded", name), "utf8");

/** Replays recorded alsem output keyed by (subcommand, routine selector/stable id, question). */
function replay(calls: string[][] = []): StdoutRunner {
  const ids = new Map<string, string>();
  for (const m of ["post", "validate"]) ids.set(JSON.parse(rec(`effects.${m}.json`)).payload.routine.routine.stableId, m);
  return async (_binary, args) => {
    calls.push(args);
    if (args[0] === "query") {
      const sel = args[args.indexOf("--routine") + 1]!;
      const key = sel.split(".")[1]!.toLowerCase();
      return { stdout: rec(`effects.${key}.json`) };
    }
    return { stdout: rec(`prove.${ids.get(args[2]!)}.${args[3]}.json`) };
  };
}

const frame = (methodName: string, inWorkspace = true) => ({ project: FIX, objectName: "Asp Work", methodName, inWorkspace });

describe("break effects", () => {
  test("resolved routine: writes + three proofs with obligations", async () => {
    const calls: string[][] = [];
    const out = await createAlSemBreakEffects({}, replay(calls))(frame("Post"));
    expect(out.status).toBe("ok");
    expect(out.tableWrites).toEqual([{ op: "Insert", table: "Asp Entry", via: "direct", temporary: "known(false)" }]);
    expect(out.proofs?.mayCommit).toMatchObject({ answer: "yes", coverageComplete: true, unresolvedCallsites: 0 });
    expect(out.proofs?.throwsError.answer).toBe("no");
    expect(out.proofs?.reachesUi.answer).toBe("no");
    expect(calls.filter((c) => c[0] === "prove").map((c) => c[3]).sort()).toEqual(["may-commit", "reaches-ui", "throws-error"]);
  });

  test("overloads are reported as candidates, no proofs", async () => {
    const out = await createAlSemBreakEffects({}, replay())(frame("Overloaded"));
    expect(out.status).toBe("ambiguous");
    expect(out.candidates).toHaveLength(2);
    expect(out.proofs).toBeUndefined();
  });

  test("unmatched routine", async () => {
    expect((await createAlSemBreakEffects({}, replay())(frame("Nope"))).status).toBe("unmatched");
  });

  test("symbol-only frame makes no call", async () => {
    const calls: string[][] = [];
    const out = await createAlSemBreakEffects({}, replay(calls))(frame("Post", false));
    expect(out.status).toBe("symbolOnly");
    expect(calls).toHaveLength(0);
  });

  test("alsem missing: soft status, one warning only", async () => {
    const provider = createAlSemBreakEffects({}, async () => ({ stdout: "", notFound: true }));
    const first = await provider(frame("Post"));
    const second = await provider(frame("Post"));
    expect(first).toMatchObject({ status: "unavailable" });
    expect(first.warning).toContain("BC_DEV_ALSEM");
    expect(second.status).toBe("unavailable");
    expect(second.warning).toBeUndefined();
  });

  test("unknown schema major fails soft", async () => {
    const bumped = rec("effects.post.json").replace('"schemaVersion": "1.0.0"', '"schemaVersion": "2.0.0"');
    const out = await createAlSemBreakEffects({}, async () => ({ stdout: bumped }))(frame("Post"));
    expect(out.status).toBe("failed");
    expect(out.message).toContain("not supported");
  });

  test("wrong kind fails soft", async () => {
    const out = await createAlSemBreakEffects({}, async () => ({ stdout: rec("prove.post.may-commit.json") }))(frame("Post"));
    expect(out.status).toBe("failed");
  });
});

// Live: runs the real alsem (BC_DEV_ALSEM, else alsem on PATH) against the fixture; skipped when none runs.
const alsem = (() => { const b = process.env["BC_DEV_ALSEM"]?.trim() || "alsem"; return spawnSync(b, ["--version"], { windowsHide: true }).status === 0 ? b : undefined; })();
describe.skipIf(!alsem)("break effects (live alsem)", () => {
  test("Post commits and writes, Overloaded is ambiguous", async () => {
    const provider = createAlSemBreakEffects({ BC_DEV_ALSEM: alsem }, runForStdout);
    const post = await provider(frame("Post"));
    expect(post.status).toBe("ok");
    expect(post.proofs?.mayCommit.answer).toBe("yes");
    expect(post.tableWrites?.[0]?.table).toBe("Asp Entry");
    expect((await provider(frame("Overloaded"))).status).toBe("ambiguous");
  });
});
