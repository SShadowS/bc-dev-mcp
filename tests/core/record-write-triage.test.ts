import { describe, expect, test } from "bun:test";
import {
  inspectRecordWriteAtSpan,
  inspectRecordWriteStatement,
  parseRecordWriteStatement,
  parseRuntimeTableType,
  RecordWriteCollector,
  sourceAtStatementSpan,
} from "../../src/core/record-write-triage";
import type { DebuggerEvent, StackFrameInfo } from "../../src/core/types";

const SOURCE = [
  "codeunit 50100 Writer",
  "{",
  "    procedure Run()",
  "    var",
  "        Customer: Record Customer;",
  "    begin",
  "        Customer.Modify(",
  "            true);",
  "    end;",
  "}",
].join("\n");

const SPAN = { from: { line: 7, column: 9 }, to: { line: 8, column: 19 } };

function frame(line = 7): StackFrameInfo {
  return {
    objectType: 5,
    objectId: 50100,
    objectName: "Writer",
    methodName: "Run",
    line,
    statementSpan: SPAN,
  };
}

function brk(stack: StackFrameInfo[] = [frame()]): DebuggerEvent {
  return { kind: "break", objectType: 5, objectId: 50100, line: 7, stack };
}

function spanFor(source: string, needle: string): NonNullable<StackFrameInfo["statementSpan"]> {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`Missing test needle: ${needle}`);
  const before = source.slice(0, index);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const column = index - lineStart + 1;
  const endIndex = index + needle.length - 1;
  const throughEnd = source.slice(0, endIndex);
  const endLine = throughEnd.split("\n").length;
  const endLineStart = throughEnd.lastIndexOf("\n") + 1;
  return {
    from: { line, column },
    to: { line: endLine, column: endIndex - endLineStart + 1 },
  };
}

function client(typeNames: string[]) {
  const steps: string[] = [];
  const watchExpressions: string[] = [];
  let sourceCalls = 0;
  let stops = 0;
  let watchIndex = 0;
  return {
    steps,
    watchExpressions,
    get sourceCalls() {
      return sourceCalls;
    },
    get stops() {
      return stops;
    },
    getSourceContent: async () => {
      sourceCalls++;
      return { content: SOURCE, isAlContent: true };
    },
    evalWatch: async (_frameId: number, expression: string) => {
      watchExpressions.push(expression);
      return {
        name: expression,
        typeName: typeNames[Math.min(watchIndex++, typeNames.length - 1)] ?? "",
        summary: "",
        hasChildren: true,
        changeState: "unknown" as const,
        changed: false,
      };
    },
    step: async (action: string) => {
      steps.push(action);
    },
    releaseForShutdown: async () => false,
    stop: async () => {
      stops++;
    },
  };
}

describe("record-write statement parsing", () => {
  test("extracts a multiline statement span", () => {
    expect(sourceAtStatementSpan(SOURCE, SPAN)).toContain("Customer.Modify");
    expect(sourceAtStatementSpan(SOURCE, SPAN)).toContain("true)");
  });

  test("recognizes every documented operation case-insensitively", () => {
    expect(parseRecordWriteStatement("Customer.Insert(true);")).toEqual({ operation: "insert", receiver: "Customer" });
    expect(parseRecordWriteStatement("Customer.MODIFY(false);")).toEqual({ operation: "modify", receiver: "Customer" });
    expect(parseRecordWriteStatement("Customer.ModifyAll(Name, 'x', true);")).toEqual({ operation: "modifyAll", receiver: "Customer" });
    expect(parseRecordWriteStatement("Customer.Rename('10000');")).toEqual({ operation: "rename", receiver: "Customer" });
    expect(parseRecordWriteStatement("Customer.Delete(true);")).toEqual({ operation: "delete", receiver: "Customer" });
    expect(parseRecordWriteStatement("Customer.DeleteAll(false);")).toEqual({ operation: "deleteAll", receiver: "Customer" });
  });

  test("recognizes valid zero-argument write calls without parentheses", () => {
    expect(parseRecordWriteStatement("Customer.Insert;")).toEqual({ operation: "insert", receiver: "Customer" });
    expect(parseRecordWriteStatement("Customer.Modify;")).toEqual({ operation: "modify", receiver: "Customer" });
    expect(parseRecordWriteStatement("Customer.Delete;")).toEqual({ operation: "delete", receiver: "Customer" });
    expect(parseRecordWriteStatement("Customer.DeleteAll;")).toEqual({ operation: "deleteAll", receiver: "Customer" });
    expect(parseRecordWriteStatement("Insert;")).toEqual({ operation: "insert", receiver: "Rec" });
  });

  test("uses an enclosing explicit WITH receiver instead of incorrectly assuming Rec", () => {
    const source = [
      "table 50100 Host",
      "{",
      "    procedure WriteTarget()",
      "    var",
      "        Target: Record Customer;",
      "    begin",
      "        with Target do begin",
      "            Insert(true);",
      "        end;",
      "        Rec.Modify(true);",
      "    end;",
      "}",
    ].join("\n");
    expect(inspectRecordWriteAtSpan(source, spanFor(source, "Insert(true);"))).toEqual({
      statement: { operation: "insert", receiver: "Target" },
      reason: null,
    });
    expect(inspectRecordWriteAtSpan(source, spanFor(source, "Rec.Modify(true);"))).toEqual({
      statement: { operation: "modify", receiver: "Rec" },
      reason: null,
    });

    const nested = [
      "table 50100 Host",
      "{",
      "    procedure WriteTarget()",
      "    var",
      "        Outer: Record Customer;",
      "        Inner: Record Vendor;",
      "    begin",
      "        with Outer do begin",
      "            with Inner do",
      "                Insert;",
      "        end;",
      "    end;",
      "}",
    ].join("\n");
    expect(inspectRecordWriteAtSpan(nested, spanFor(nested, "Insert;"))).toEqual({
      statement: { operation: "insert", receiver: "Inner" },
      reason: null,
    });
  });

  test("fails closed when an explicit WITH receiver is not a watch-compatible identifier", () => {
    const source = [
      "codeunit 50100 Writer",
      "{",
      "    procedure WriteTarget()",
      "    begin",
      "        with GetTarget() do",
      "            Insert(true);",
      "    end;",
      "}",
    ].join("\n");
    expect(inspectRecordWriteAtSpan(source, spanFor(source, "Insert(true);"))).toEqual({
      statement: null,
      reason: "receiverUnsupported",
    });
  });

  test("handles quoted and implicit Rec receivers while ignoring comments and strings", () => {
    expect(parseRecordWriteStatement('"Customer Buffer".Insert();')).toEqual({
      operation: "insert",
      receiver: '"Customer Buffer"',
    });
    expect(parseRecordWriteStatement("Modify(true);")).toEqual({ operation: "modify", receiver: "Rec" });
    expect(parseRecordWriteStatement("// Fake.Insert();\nCustomer.Delete();")).toEqual({
      operation: "delete",
      receiver: "Customer",
    });
    expect(parseRecordWriteStatement("Message('Fake.Insert()'); Customer.Rename('x');")).toEqual({
      operation: "rename",
      receiver: "Customer",
    });
  });

  test("refuses ambiguous, indexed, function-return, and non-write expressions", () => {
    expect(parseRecordWriteStatement("A.Insert(); B.Modify();")).toBeNull();
    expect(parseRecordWriteStatement("Records[1].Insert();")).toBeNull();
    expect(parseRecordWriteStatement("GetCustomer().Modify();")).toBeNull();
    expect(parseRecordWriteStatement("Outer.Inner.Insert();")).toBeNull();
    expect(parseRecordWriteStatement("Customer.Validate(Name);")).toBeNull();
    expect(inspectRecordWriteStatement("Records[1].Insert();").reason).toBe("receiverUnsupported");
    expect(inspectRecordWriteStatement("GetCustomer().Modify();").reason).toBe("receiverUnsupported");
    expect(inspectRecordWriteStatement("Outer.Inner.Insert();").reason).toBe("receiverUnsupported");
    expect(inspectRecordWriteStatement("A.Insert(); B.Modify();").reason).toBe("multipleWriteCandidates");
    expect(
      inspectRecordWriteStatement(
        "if not Customer.Insert(false) then\n    Customer.Modify(true);",
      ).reason,
    ).toBe("multipleWriteCandidates");
    expect(
      inspectRecordWriteStatement("Customer.Insert(); GetCustomer().Modify();").reason,
    ).toBe("receiverUnsupported");
  });

  test("parses only positive runtime Table identities", () => {
    expect(parseRuntimeTableType("Table Customer (18)")).toEqual({ tableId: 18, tableName: "Customer" });
    expect(parseRuntimeTableType(' Table "My Table" (50100) ')).toEqual({ tableId: 50100, tableName: '"My Table"' });
    expect(parseRuntimeTableType("Record Customer (18)")).toBeNull();
    expect(parseRuntimeTableType("Table Customer (0)")).toBeNull();
    expect(parseRuntimeTableType("Table Customer")).toBeNull();
  });
});

describe("RecordWriteCollector", () => {
  test("classifies, groups, and automatically continues target and unrelated writes", async () => {
    const fake = client(["Table Customer (18)", "Table Vendor (23)", "Table Customer (18)"]);
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => "/project/Writer.Codeunit.al",
    });
    collector.onEvent({ kind: "sessionBound", sessionId: 99, hostId: null });
    collector.onEvent(brk());
    collector.onEvent(brk());
    collector.onEvent(brk());
    await collector.waitForIdle();

    expect(collector.status()).toMatchObject({
      phase: "collecting",
      sessionId: 99,
      target: { tableId: 18, tableName: "Customer" },
      summary: {
        observedWrites: 3,
        matchedWrites: 2,
        uniqueWriters: 1,
        unrelatedWrites: 1,
        unresolvedWrites: 0,
      },
    });
    expect(fake.steps).toEqual(["continue", "continue", "continue"]);
    const report = await collector.finish();
    expect(report.complete).toBe(true);
    expect(report.writers).toHaveLength(1);
    expect(report.writers[0]).toMatchObject({
      operation: "modify",
      receiver: "Customer",
      count: 2,
      firstSequence: 1,
      lastSequence: 3,
      source: "deployed",
    });
    expect(report.writers[0]?.stack[0]?.file).toBe("/project/Writer.Codeunit.al");
    expect(fake.sourceCalls).toBe(1);
    expect(fake.watchExpressions).toEqual(["Customer", "Customer", "Customer"]);
  });

  test("unresolved writes fail closed but still continue", async () => {
    const fake = client(["Integer"]);
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    collector.onEvent(brk());
    await collector.waitForIdle();
    expect(fake.steps).toEqual(["continue"]);
    const report = await collector.finish();
    expect(report.complete).toBe(false);
    expect(report.summary.unresolvedWrites).toBe(1);
    expect(report.unresolved[0]?.reason).toBe("receiverTypeUnresolved");
  });

  test("a conditional statement with two write candidates is retained under its stable reason", async () => {
    const statement = "if not Customer.Insert(false) then\n            Customer.Modify(true);";
    const source = SOURCE.replace(
      "Customer.Modify(\n            true);",
      statement,
    );
    const fake = client(["Table Customer (18)"]);
    fake.getSourceContent = async () => ({ content: source, isAlContent: true });
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    collector.onEvent(brk([{
      ...frame(),
      statementSpan: spanFor(source, statement),
    }]));
    await collector.waitForIdle();

    const report = await collector.finish();
    expect(report).toMatchObject({
      complete: false,
      summary: { observedWrites: 1, unresolvedWrites: 1 },
      unresolved: [{ reason: "multipleWriteCandidates", operation: null, receiver: null }],
    });
    expect(fake.watchExpressions).toEqual([]);
    expect(fake.steps).toEqual(["continue"]);
  });

  test("finishing before any session binds cannot produce a false complete report", async () => {
    const fake = client(["Table Customer (18)"]);
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    const report = await collector.finish();
    expect(report).toMatchObject({
      outcome: "completed",
      stopReason: "finished",
      complete: false,
      summary: { observedWrites: 0 },
    });
    expect(report.warnings).toContain("No debugger session bound during the capture window.");
  });

  test("local source is exact only with changesDeployed assertion", async () => {
    const make = (changesDeployed: boolean) => {
      const fake = client(["Table Customer (18)"]);
      fake.getSourceContent = async () => ({ content: "", isAlContent: false });
      return {
        fake,
        collector: new RecordWriteCollector({
          tableId: 18,
          changesDeployed,
          maxObservedWrites: 10,
          client: fake as never,
          localSource: async () => SOURCE,
          localFile: () => "/project/Writer.Codeunit.al",
        }),
      };
    };
    const unasserted = make(false);
    unasserted.collector.onEvent(brk());
    await unasserted.collector.waitForIdle();
    expect((await unasserted.collector.finish()).unresolved[0]?.reason).toBe("sourceUnavailable");

    const asserted = make(true);
    asserted.collector.onEvent(brk());
    await asserted.collector.waitForIdle();
    const report = await asserted.collector.finish();
    expect(report.complete).toBe(true);
    expect(report.writers[0]?.source).toBe("localAsserted");
  });

  test("the cap classifies its final event then releases once", async () => {
    const fake = client(["Table Customer (18)", "Table Customer (18)"]);
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 2,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    collector.onEvent(brk());
    collector.onEvent(brk());
    collector.onEvent(brk());
    await collector.waitForIdle();
    expect(fake.steps).toEqual(["continue", "release"]);
    const report = await collector.finish();
    expect(report).toMatchObject({
      outcome: "truncated",
      stopReason: "maxObservedWrites",
      complete: false,
      truncated: true,
      summary: { observedWrites: 2, matchedWrites: 2 },
    });
  });

  test("different stacks remain separate", async () => {
    const fake = client(["Table Customer (18)", "Table Customer (18)"]);
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    collector.onEvent(brk());
    collector.onEvent(brk([{ ...frame(20), methodName: "Other", statementSpan: SPAN }]));
    await collector.waitForIdle();
    expect((await collector.finish()).writers).toHaveLength(2);
  });

  test("groups case-insensitive AL receiver spellings under the first source spelling", async () => {
    const caseLine = "        if Flag then Customer.Modify(true) else customer.Modify(true);";
    const caseSource = SOURCE.replace("        Customer.Modify(", `${caseLine}\n        //`).replace(
      "            true);",
      "",
    );
    const firstStart = caseLine.indexOf("Customer") + 1;
    const secondStart = caseLine.indexOf("customer") + 1;
    const fake = client(["Table Customer (18)", "Table Customer (18)"]);
    fake.getSourceContent = async () => ({ content: caseSource, isAlContent: true });
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    collector.onEvent(brk([{
      ...frame(),
      statementSpan: {
        from: { line: 7, column: firstStart },
        to: { line: 7, column: firstStart + "Customer.Modify(true)".length },
      },
    }]));
    collector.onEvent(brk([{
      ...frame(),
      statementSpan: {
        from: { line: 7, column: secondStart },
        to: { line: 7, column: secondStart + "customer.Modify(true)".length },
      },
    }]));
    await collector.waitForIdle();
    const report = await collector.finish();
    expect(report.writers).toHaveLength(1);
    expect(report.writers[0]).toMatchObject({ receiver: "Customer", count: 2 });
  });

  test("serializes rapid breaks and finish releases an accepted in-flight break", async () => {
    let resolveWatch!: (value: {
      name: string;
      typeName: string;
      summary: string;
      hasChildren: boolean;
      changeState: "unknown";
      changed: false;
    }) => void;
    const watch = new Promise<{
      name: string;
      typeName: string;
      summary: string;
      hasChildren: boolean;
      changeState: "unknown";
      changed: false;
    }>((resolve) => {
      resolveWatch = resolve;
    });
    let watchCalls = 0;
    const fake = client(["Table Customer (18)"]);
    fake.evalWatch = async () => {
      watchCalls++;
      return await watch;
    };
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    collector.onEvent(brk());
    await Bun.sleep(0);
    expect(watchCalls).toBe(1);

    const finishing = collector.finish();
    resolveWatch({
      name: "Customer",
      typeName: "Table Customer (18)",
      summary: "",
      hasChildren: true,
      changeState: "unknown",
      changed: false,
    });
    const report = await finishing;
    expect(report.summary).toMatchObject({ observedWrites: 1, matchedWrites: 1 });
    expect(fake.steps).toEqual(["release"]);
  });

  test("finish captures and releases a break that arrives as shutdown begins", async () => {
    const fake = client(["Table Customer (18)"]);
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    collector.onEvent({ kind: "sessionBound", sessionId: 99, hostId: null });
    await collector.waitForIdle();

    const finishing = collector.finish();
    collector.onEvent(brk());
    const report = await finishing;

    expect(report).toMatchObject({
      complete: true,
      stopReason: "finished",
      summary: { observedWrites: 1, matchedWrites: 1 },
    });
    expect(fake.steps).toEqual(["release"]);
    collector.onEvent(brk());
    expect(collector.status().summary.observedWrites).toBe(1);
  });

  test("finish orders an asynchronous Break callback through the shutdown release barrier", async () => {
    for (const releaseAccepted of [true, false]) {
      const fake = client(["Table Customer (18)"]);
      const collector = new RecordWriteCollector({
        tableId: 18,
        changesDeployed: false,
        maxObservedWrites: 10,
        client: fake as never,
        localSource: async () => null,
        localFile: () => undefined,
      });
      collector.onEvent({ kind: "sessionBound", sessionId: 99, hostId: null });
      await collector.waitForIdle();

      fake.releaseForShutdown = async () => {
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            collector.onEvent(brk());
            resolve();
          }, 0);
        });
        return releaseAccepted;
      };

      const report = await collector.finish();
      expect(report).toMatchObject({
        complete: true,
        stopReason: "finished",
        summary: { observedWrites: 1, matchedWrites: 1 },
      });
      // An accepted transport-level release already resumed this break. When the
      // barrier is rejected, the classified callback sends the one required release.
      expect(fake.steps).toEqual(releaseAccepted ? [] : ["release"]);
    }
  });

  test("inspection failures are redacted, fail closed, and continue automatically", async () => {
    const fake = client(["Table Customer (18)"]);
    fake.evalWatch = async () => {
      throw new Error("Authorization: Bearer super-secret");
    };
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    collector.onEvent(brk());
    await collector.waitForIdle();
    const report = await collector.finish();
    expect(fake.steps).toEqual(["continue"]);
    expect(report.complete).toBe(false);
    expect(report.unresolved[0]?.reason).toBe("inspectionFailed");
    expect(report.warnings.join(" ")).not.toContain("super-secret");
    expect(report.warnings.join(" ")).toContain("[REDACTED]");
  });

  test("mid-capture detach and fatal events fail closed while preserving partial reports", async () => {
    const detachedFake = client(["Table Customer (18)"]);
    const detached = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: detachedFake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    detached.onEvent(brk());
    detached.onEvent({ kind: "detached", terminateSession: false });
    await detached.waitForIdle();
    const detachedReport = await detached.finish();
    expect(detachedReport).toMatchObject({
      outcome: "completed",
      stopReason: "sessionDetached",
      complete: false,
      summary: { observedWrites: 1, matchedWrites: 1 },
    });
    expect(detachedReport.warnings.join(" ")).toContain("detached before finish");

    const fatalFake = client(["Table Customer (18)"]);
    const fatal = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fatalFake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    fatal.onEvent({ kind: "fatal", message: "Authorization: Bearer fatal-secret" });
    await fatal.waitForIdle();
    const failed = await fatal.finish();
    expect(failed).toMatchObject({ outcome: "failed", stopReason: "fatal", complete: false });
    expect(failed.warnings.join(" ")).not.toContain("fatal-secret");
  });

  test("a detach caused by finish's release barrier does not mark the deliberate window incomplete", async () => {
    const fake = client(["Table Customer (18)"]);
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    collector.onEvent({ kind: "sessionBound", sessionId: 99, hostId: null });
    await collector.waitForIdle();
    fake.releaseForShutdown = async () => {
      collector.onEvent({ kind: "detached", terminateSession: false });
      return true;
    };

    const report = await collector.finish();
    expect(report).toMatchObject({
      outcome: "completed",
      stopReason: "finished",
      complete: true,
      summary: { observedWrites: 0 },
    });
    expect(report.warnings).toEqual([]);
  });

  test("a terminated-session detach still fails closed because the detach cause is not provable", async () => {
    const fake = client(["Table Customer (18)"]);
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    collector.onEvent(brk());
    collector.onEvent({ kind: "detached", terminateSession: true });
    await collector.waitForIdle();

    const report = await collector.finish();
    expect(report).toMatchObject({
      outcome: "completed",
      stopReason: "sessionDetached",
      complete: false,
      summary: { observedWrites: 1, matchedWrites: 1 },
    });
    expect(report.warnings.join(" ")).toContain("detached before finish");
  });

  test("a continuation failure becomes fatal and attempts to release the paused workload", async () => {
    const fake = client(["Table Customer (18)"]);
    fake.step = async (action: string) => {
      fake.steps.push(action);
      if (action === "continue") throw new Error("resume failed");
    };
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    collector.onEvent(brk());
    await collector.waitForIdle();
    const report = await collector.finish();
    expect(fake.steps).toEqual(["continue", "release"]);
    expect(fake.stops).toBeGreaterThan(0);
    expect(report).toMatchObject({ outcome: "failed", stopReason: "fatal", complete: false });
  });

  test("warns when one numeric target is reported with conflicting runtime names", async () => {
    const fake = client(["Table Customer (18)", 'Table "Customer Alias" (18)']);
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
    });
    collector.onEvent(brk());
    collector.onEvent(brk());
    await collector.waitForIdle();
    const report = await collector.finish();
    expect(report.target.tableName).toBe("Customer");
    expect(report.warnings.join(" ")).toContain("Customer Alias");
  });
});

describe("stray-bind re-arm", () => {
  function timers() {
    const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    return {
      live: () => pending.filter((t) => !t.cancelled),
      schedule: (fn: () => void, ms: number) => {
        const timer = { fn, ms, cancelled: false };
        pending.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      fire() {
        const timer = pending.find((t) => !t.cancelled);
        if (!timer) throw new Error("no pending timer");
        timer.cancelled = true;
        timer.fn();
      },
    };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function setup(attachImpl: () => Promise<void> = async () => {}, maxRearms = 3) {
    const fake = client(["Table Customer (18)"]);
    const clock = timers();
    let attaches = 0;
    const collector = new RecordWriteCollector({
      tableId: 18,
      changesDeployed: false,
      maxObservedWrites: 10,
      client: fake as never,
      localSource: async () => null,
      localFile: () => undefined,
      rearm: {
        attach: async () => {
          attaches++;
          await attachImpl();
        },
        maxRearms,
        delayMs: 1000,
        schedule: clock.schedule,
      },
    });
    return { fake, clock, collector, attaches: () => attaches };
  }

  test("a detach before any break re-arms after the delay and later breaks are collected", async () => {
    const { fake, clock, collector, attaches } = setup();
    collector.onEvent({ kind: "sessionBound", sessionId: 77, hostId: "h1" });
    collector.onEvent({ kind: "detached", terminateSession: false });
    await collector.waitForIdle();
    expect(collector.status()).toMatchObject({ phase: "rearming", strayBinds: 1, rearms: 0, sessionId: null });
    expect(collector.status().warning).toContain("session 77, host h1");
    expect(fake.stops).toBe(1);
    expect(clock.live()[0]!.ms).toBe(1000);
    expect(attaches()).toBe(0);

    clock.fire();
    await tick();
    expect(attaches()).toBe(1);
    expect(collector.status()).toMatchObject({ phase: "arming", strayBinds: 1, rearms: 1 });

    collector.onEvent({ kind: "sessionBound", sessionId: 78, hostId: "h1" });
    collector.onEvent(brk());
    collector.onEvent({ kind: "detached", terminateSession: false });
    await collector.waitForIdle();
    const report = await collector.finish();
    expect(report).toMatchObject({
      stopReason: "sessionDetached",
      strayBinds: 1,
      rearms: 1,
      complete: false,
      summary: { observedWrites: 1, matchedWrites: 1 },
    });
    expect(report.warnings.join(" ")).toContain("A workload started before the re-attach is missed");
    expect(clock.live()).toEqual([]);
  });

  test("an immediate re-attach rejected while BC releases the registration is retried with backoff", async () => {
    let calls = 0;
    const { clock, collector, attaches } = setup(async () => {
      if (++calls === 1) throw new Error("An unexpected error occurred invoking 'Attach' on the server.");
    });
    collector.onEvent({ kind: "detached", terminateSession: false });
    await collector.waitForIdle();
    clock.fire();
    await tick();
    expect(attaches()).toBe(1);
    expect(collector.status().phase).toBe("rearming");
    expect(clock.live()[0]!.ms).toBe(2000);
    clock.fire();
    await tick();
    expect(attaches()).toBe(2);
    expect(collector.status()).toMatchObject({ phase: "arming", rearms: 1 });
  });

  test("a non-busy re-attach failure fails the capture", async () => {
    const { clock, collector } = setup(async () => {
      throw new Error("Unable to bind the requested user-filtered session.");
    });
    collector.onEvent({ kind: "detached", terminateSession: false });
    await collector.waitForIdle();
    clock.fire();
    await tick();
    expect(collector.status().phase).toBe("failed");
    const report = await collector.finish();
    expect(report).toMatchObject({ outcome: "failed", stopReason: "fatal", complete: false });
  });

  test("more stray binds than maxRearms stop with strayBindsExhausted", async () => {
    const { clock, collector, attaches } = setup(async () => {}, 1);
    collector.onEvent({ kind: "detached", terminateSession: false });
    await collector.waitForIdle();
    clock.fire();
    await tick();
    collector.onEvent({ kind: "sessionBound", sessionId: null, hostId: null, warning: "invalid NST session id" });
    collector.onEvent({ kind: "detached", terminateSession: false });
    await collector.waitForIdle();
    expect(collector.status()).toMatchObject({ phase: "stopped", strayBinds: 2, rearms: 1 });
    expect(clock.live()).toEqual([]);
    const report = await collector.finish();
    expect(attaches()).toBe(1);
    expect(report).toMatchObject({ stopReason: "strayBindsExhausted", complete: false, strayBinds: 2, rearms: 1 });
    expect(report.warnings.join(" ")).toContain("maxRearms=1 exhausted");
  });

  test("a detach after a break keeps the session-ended behaviour", async () => {
    const { clock, collector, attaches } = setup();
    collector.onEvent(brk());
    collector.onEvent({ kind: "detached", terminateSession: false });
    await collector.waitForIdle();
    expect(clock.live()).toEqual([]);
    const report = await collector.finish();
    expect(attaches()).toBe(0);
    expect(report).toMatchObject({ stopReason: "sessionDetached", strayBinds: 0, rearms: 0 });
  });

  test("finish during rearming cancels the pending re-attach", async () => {
    const { fake, clock, collector, attaches } = setup();
    collector.onEvent({ kind: "detached", terminateSession: false });
    await collector.waitForIdle();
    expect(clock.live().length).toBe(1);
    const report = await collector.finish();
    expect(clock.live()).toEqual([]);
    await tick();
    expect(attaches()).toBe(0);
    expect(fake.stops).toBe(2);
    expect(report).toMatchObject({ stopReason: "finished", complete: false, strayBinds: 1, rearms: 0 });
    expect(report.warnings).toContain("No debugger session bound during the capture window.");
  });

  test("the stray's late identity callback does not end rearming", async () => {
    const { clock, collector } = setup();
    collector.onEvent({ kind: "detached", terminateSession: false });
    collector.onEvent({ kind: "sessionBound", sessionId: 5, hostId: "h" });
    await collector.waitForIdle();
    expect(collector.status()).toMatchObject({ phase: "rearming", sessionId: null });
    clock.fire();
    await tick();
    expect(collector.status()).toMatchObject({ phase: "arming", rearms: 1 });
  });

  test("a slow stop of the stray shows rearming at once and a finish meanwhile schedules nothing", async () => {
    const { fake, clock, collector, attaches } = setup();
    let releaseStop!: () => void;
    fake.stop = () => new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    collector.onEvent({ kind: "detached", terminateSession: false });
    await tick();
    expect(collector.status().phase).toBe("rearming");
    const finishing = collector.finish();
    await tick();
    releaseStop();
    await tick();
    releaseStop();
    const report = await finishing;
    expect(clock.live()).toEqual([]);
    expect(attaches()).toBe(0);
    expect(report).toMatchObject({ stopReason: "finished", strayBinds: 1, rearms: 0 });
  });

  test("finish during an in-flight re-attach waits for it, then stops the new attachment", async () => {
    let releaseAttach!: () => void;
    const { fake, clock, collector, attaches } = setup(() => new Promise<void>((resolve) => {
      releaseAttach = resolve;
    }));
    collector.onEvent({ kind: "detached", terminateSession: false });
    await collector.waitForIdle();
    clock.fire();
    await tick();
    expect(attaches()).toBe(1);
    const finishing = collector.finish();
    releaseAttach();
    const report = await finishing;
    expect(report).toMatchObject({ stopReason: "finished", rearms: 1 });
    expect(collector.status().phase).toBe("stopped");
    expect(fake.stops).toBe(2);
    expect(clock.live()).toEqual([]);
  });
});
