import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlObjectIndex } from "../../../src/core/al-objects";
import { normalizeSnappoints, toWireLocations } from "../../../src/core/snapshot/snappoints";

let dir: string;
let index: AlObjectIndex;
const lines = async () => 40;
const norm = (input: Parameters<typeof normalizeSnappoints>[0]) => normalizeSnappoints(input, index, dir, lines);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "snap-"));
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "Page.al"), 'page 50152 "Trigger Demo Page"\n{\n}\n' + "// x\n".repeat(37));
  await writeFile(join(dir, "src", "Other.al"), 'page 50153 "Other"\n{\n}\n');
  await writeFile(join(dir, "src", "Empty.al"), "// nothing\n");
  await writeFile(join(dir, "src", "Enum.al"), 'enum 50100 "E"\n{\n}\n');
  index = await AlObjectIndex.build(dir);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const invalid = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

describe("normalizeSnappoints", () => {
  test("file+line resolves the object, 1-based line and 0-based wireLine", async () => {
    const [p] = await norm([{ file: "src/Page.al", line: 35 }]);
    expect(p).toMatchObject({ objectType: 8, objectTypeName: "page", objectId: 50152, line: 35, wireLine: 34, unverified: false });
  });
  test("explicit object is unverified", async () => {
    const [p] = await norm([{ objectType: "codeunit", objectId: 130, line: 10 }]);
    expect(p).toMatchObject({ objectType: 5, objectId: 130, line: 10, unverified: true });
  });
  test("duplicates collapse and toWireLocations groups by object", async () => {
    const pts = await norm([{ file: "src/Page.al", line: 5 }, { file: "src/Page.al", line: 5 }, { file: "src/Page.al", line: 6, condition: "x" }, { file: "src/Other.al", line: 2 }]);
    expect(pts).toHaveLength(3);
    expect(toWireLocations(pts)).toEqual([
      { objectType: 8, objectId: 50152, lines: [{ line: 4 }, { line: 5, condition: "x" }] },
      { objectType: 8, objectId: 50153, lines: [{ line: 1 }] },
    ]);
  });
  test("unknown file", () => invalid(norm([{ file: "src/Nope.al", line: 1 }])));
  test("file outside workspace", () => invalid(norm([{ file: "../outside.al", line: 1 }])));
  test("file without an object declaration", () => invalid(norm([{ file: "src/Empty.al", line: 1 }])));
  test("line 0", () => invalid(norm([{ file: "src/Page.al", line: 0 }])));
  test("line past end of file", () => invalid(norm([{ file: "src/Page.al", line: 41 }])));
  test("non-integer line", () => invalid(norm([{ file: "src/Page.al", line: 1.5 }])));
  test("enum has no code", () => invalid(norm([{ objectType: "enum", objectId: 5, line: 1 }])));
  test("enum file has no code", () => invalid(norm([{ file: "src/Enum.al", line: 1 }])));
  test("objectId 0", () => invalid(norm([{ objectType: "codeunit", objectId: 0, line: 1 }])));
  test("more than 20 snappoints", () => invalid(norm(Array.from({ length: 21 }, (_, i) => ({ file: "src/Page.al", line: i + 1 })))));
});
