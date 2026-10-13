import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALSEM_ENV_VAR } from "../../src/core/call-graph";
import { createAlSemRiskProvider, findRisk, parseAlSemDigest, sortByRisk, type RiskSubject } from "../../src/core/risk";

const fixture = join(import.meta.dir, "..", "fixtures", "alsem-risk");
const recorded = readFileSync(join(fixture, "digest.json"), "utf8");
const subject = (name: string, startLine: number, objectType = 5): RiskSubject =>
  ({ objectType, objectId: 50990, name, relativeFile: "src/RiskOps.Codeunit.al", startLine });

describe("alsem digest risk", () => {
  const entries = parseAlSemDigest(recorded);

  test("summarizes effects per routine from the recorded digest", () => {
    const risk = (name: string, line: number) => findRisk(entries, subject(name, line))!;
    expect(risk("PostOrder", 3)).toMatchObject({ level: "commits", commits: true, writes: ["Risk Order"], summary: "commits; writes Risk Order" });
    expect(risk("ResetAmount", 13)).toMatchObject({ level: "writes", summary: "writes Risk Order" });
    expect(risk("CheckAmount", 22)).toMatchObject({ level: "error-ui", errors: true });
    // al-sem lists only routines with effects: an effect-free routine has no entry, hence no risk field.
    expect(findRisk(entries, subject("Double", 28))).toBeUndefined();
  });

  test("the object type takes part in the join (table 50990 is not codeunit 50990)", () => {
    expect(findRisk(entries, subject("PostOrder", 3, 1))).toBeUndefined();
  });

  test("sorts commits > writes > error-ui > none, stable within a level", () => {
    const items = ["Double", "CheckAmount", "ResetAmount", "PostOrder", "Missing"].map((name, i) => ({
      name, risk: findRisk(entries, subject(name, 0)), i,
    }));
    expect(sortByRisk(items).map((x) => x.name)).toEqual(["PostOrder", "ResetAmount", "CheckAmount", "Double", "Missing"]);
  });

  test("rejects another kind or schema major", () => {
    expect(() => parseAlSemDigest(recorded.replace('"kind": "digest"', '"kind": "prove"'))).toThrow("not 'digest'");
    expect(() => parseAlSemDigest(recorded.replace('"schemaVersion": "1.3.0"', '"schemaVersion": "2.0.0"'))).toThrow("not supported");
  });

  test("provider fails soft: missing alsem and bad output become one warning", async () => {
    const missing = createAlSemRiskProvider({}, async () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); });
    const a = await missing(fixture, ["src/RiskOps.Codeunit.al"]);
    expect(a.entries).toEqual([]);
    expect(a.warnings).toHaveLength(1);
    expect(a.warnings[0]).toContain(ALSEM_ENV_VAR);

    const garbage = createAlSemRiskProvider({}, async (_bin, args) => { writeFileSync(args[args.indexOf("--out") + 1]!, "not json"); });
    expect((await garbage(fixture, ["x.al"])).warnings).toHaveLength(1);
  });

  test("provider passes each changed file as --file", async () => {
    let seen: string[] = [];
    const provider = createAlSemRiskProvider({ [ALSEM_ENV_VAR]: "alsem-x" }, async (bin, args) => {
      seen = [bin, ...args];
      writeFileSync(args[args.indexOf("--out") + 1]!, recorded);
    });
    const digest = await provider(fixture, ["a.al", "b.al"]);
    expect(digest.entries.length).toBe(3);
    expect(seen[0]).toBe("alsem-x");
    expect(seen.filter((a) => a === "--file")).toHaveLength(2);
  });

  const alsem = process.env[ALSEM_ENV_VAR];
  test.skipIf(!alsem || !existsSync(alsem))("live alsem digest matches the recorded risk levels", async () => {
    const digest = await createAlSemRiskProvider(process.env)(fixture, ["src/RiskOps.Codeunit.al"]);
    expect(digest.warnings).toEqual([]);
    expect(findRisk(digest.entries, subject("PostOrder", 3))?.level).toBe("commits");
    expect(findRisk(digest.entries, subject("ResetAmount", 13))?.level).toBe("writes");
  });
});
