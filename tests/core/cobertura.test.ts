import { describe, expect, test } from "bun:test";
import type { AlProcedureIdentity } from "../../src/core/al-procedures";
import { buildCobertura } from "../../src/core/cobertura";

function proc(p: Partial<AlProcedureIdentity> & Pick<AlProcedureIdentity, "objectId" | "name" | "relativeFile" | "startLine" | "methodId">): AlProcedureIdentity {
  return {
    objectType: 5,
    objectName: "X",
    file: `/p/${p.relativeFile}`,
    endLine: p.startLine + 2,
    signature: { returnType: { navTypeKind: 0, symbolKind: 2 }, parameters: [], eventLike: false },
    ...p,
  } as AlProcedureIdentity;
}

describe("cobertura", () => {
  const procedures = [
    proc({ objectId: 50200, name: "Later", relativeFile: "src\\b\\Zeta.Codeunit.al", startLine: 20, methodId: 22 }),
    proc({ objectId: 50200, name: "First", relativeFile: "src\\b\\Zeta.Codeunit.al", startLine: 4, methodId: 21 }),
    proc({ objectId: 50100, name: 'Calc<&>"', relativeFile: "src\\alpha.Codeunit.al", startLine: 3, methodId: 11 }),
    proc({ objectId: 50101, name: "Helper", relativeFile: "src\\Tests.Codeunit.al", startLine: 3, methodId: 31 }),
    proc({ objectId: 50100, name: "NoIdentity", relativeFile: "src\\alpha.Codeunit.al", startLine: 9, methodId: null }),
  ];
  const coverage = [
    { testObjectId: 50101, testMethodId: 1, coveredProcedures: [
      { objectType: 5, objectId: 50100, methodId: 11 }, { objectType: 5, objectId: 50101, methodId: 31 }, { objectType: 1, objectId: 18, methodId: 7 },
    ] },
    { testObjectId: 50101, testMethodId: 2, coveredProcedures: [{ objectType: 5, objectId: 50100, methodId: 11 }, { objectType: 5, objectId: 50200, methodId: 22 }] },
    // same test reported twice must not double-count hits
    { testObjectId: 50101, testMethodId: 2, coveredProcedures: [{ objectType: 5, objectId: 50100, methodId: 11 }] },
  ];

  test("emits the altool procedure-mode layout with hits per distinct test", () => {
    const report = buildCobertura(coverage, procedures, new Set(["5|50101"]));
    expect(report).toMatchObject({ procedures: 3, covered: 2, outside: 1, unidentified: 1 });
    expect(report.xml).toBe(`<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="0.6666666666666666" lines-covered="2" lines-valid="3" branch-rate="0" branches-covered="0" branches-valid="0" complexity="0" version="1.0" timestamp="0">
  <sources>
    <source></source>
  </sources>
  <packages>
    <package name="AL" line-rate="1" branch-rate="0" complexity="0">
      <classes>
        <class name="alpha.Codeunit" filename="src/alpha.Codeunit.al" line-rate="1" branch-rate="0" complexity="0">
          <methods>
            <method name="Calc&lt;&amp;&gt;&quot;" signature="11" line-rate="1" branch-rate="0">
              <lines>
                <line number="3" hits="2" branch="false" />
              </lines>
            </method>
          </methods>
          <lines>
            <line number="3" hits="2" branch="false" />
          </lines>
        </class>
      </classes>
    </package>
    <package name="AL" line-rate="0.5" branch-rate="0" complexity="0">
      <classes>
        <class name="Zeta.Codeunit" filename="src/b/Zeta.Codeunit.al" line-rate="0.5" branch-rate="0" complexity="0">
          <methods>
            <method name="First" signature="21" line-rate="0" branch-rate="0">
              <lines>
                <line number="4" hits="0" branch="false" />
              </lines>
            </method>
            <method name="Later" signature="22" line-rate="1" branch-rate="0">
              <lines>
                <line number="20" hits="1" branch="false" />
              </lines>
            </method>
          </methods>
          <lines>
            <line number="4" hits="0" branch="false" />
            <line number="20" hits="1" branch="false" />
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
`);
  });

  test("an empty report has root line-rate 0 and no packages", () => {
    const report = buildCobertura([], [], new Set());
    expect(report).toMatchObject({ procedures: 0, covered: 0, outside: 0, unidentified: 0 });
    expect(report.xml).toContain('<coverage line-rate="0" lines-covered="0" lines-valid="0"');
    expect(report.xml).toContain("<packages>\n  </packages>");
  });
});
