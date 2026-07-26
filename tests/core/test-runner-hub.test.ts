import { describe, expect, test } from "bun:test";
import { TestRunnerClient } from "../../src/core/hubs/test-runner-hub";
import { BasicAuthorizationProvider } from "../../src/core/authorization";
import type { ConnectionConfig } from "../../src/core/types";
import { FakeHub, fakeHubFactory } from "../fakes/fake-hub";

const config: ConnectionConfig = {
  environmentType: "OnPrem",
  authentication: "UserPassword",
  server: "http://localhost",
  serverInstance: "BC",
  username: "u",
  password: "p",
};
const auth = new BasicAuthorizationProvider("u", "p");

describe("TestRunnerClient.run", () => {
  test("initializes, runs groups sequentially, maps results", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "RunTests") {
        const groupIndex = hub.invoked("RunTests").length - 1;
        queueMicrotask(() => {
          if (groupIndex === 0) {
            hub.emit("TestStarted", 50100, "PostInvoice");
            hub.emit("TestCompleted", 50100, "PostInvoice", 0, "", 123);
            hub.emit("TestCompleted", 50100, "CancelInvoice", 1, "Expected 2, got 3", 45);
          } else {
            hub.emit("TestCompleted", 50110, "OtherTest", 2, "", 1);
          }
          hub.emit("TestRunCompleted", { Tests: [] });
        });
      }
      return undefined;
    };

    const result = await new TestRunnerClient(fakeHubFactory(hub)).run(
      config,
      auth,
      [{ id: 50100 }, { id: 50110, methods: ["OtherTest"] }],
      { company: "CRONUS", coverage: "procedure" },
    );

    expect(hub.url).toBe("http://localhost:7049/BC/dev/TestRunnerHub");
    expect(hub.opts?.authHeader).toBe("Basic " + Buffer.from("u:p").toString("base64"));
    expect(hub.opts?.queryParams["Authentication"]).toBe(hub.opts?.authHeader);
    expect(hub.invoked("Initialize")[0]?.args).toEqual(["CRONUS", "", 2]);
    expect(hub.invoked("RunTests").map((i) => i.args)).toEqual([
      [50100, []],
      [50110, ["OtherTest"]],
    ]);
    expect(result.results).toEqual([
      { codeunitId: 50100, method: "PostInvoice", status: "passed", durationMs: 123, output: "" },
      { codeunitId: 50100, method: "CancelInvoice", status: "failed", durationMs: 45, output: "Expected 2, got 3" },
      { codeunitId: 50110, method: "OtherTest", status: "skipped", durationMs: 1, output: "" },
    ]);
    expect(result.runAborted).toBeUndefined();
    expect(hub.stopped).toBe(true);
  });

  test("collects coverage from TestRunCompleted payload", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "RunTests") {
        queueMicrotask(() => {
          hub.emit("TestCompleted", 50100, "PostInvoice", 0, "", 1);
          hub.emit("TestRunCompleted", {
            Tests: [
              {
                MethodId: 1,
                ApplicationObjectId: 50100,
                CoveredProcedures: [{ MethodId: 7, ObjectId: 50000, ObjectType: 5 }],
              },
            ],
          });
        });
      }
      return undefined;
    };
    const result = await new TestRunnerClient(fakeHubFactory(hub)).run(config, auth, [{ id: 50100 }], { coverage: "procedure" });
    expect(result.coverage).toEqual([
      { testObjectId: 50100, testMethodId: 1, coveredProcedures: [{ objectType: 5, objectId: 50000, methodId: 7 }] },
    ]);
    expect(result.coverageComplete).toBe(true);
  });

  test("marks requested coverage incomplete when executed tests return an empty Tests payload", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "RunTests") {
        queueMicrotask(() => {
          hub.emit("TestCompleted", 50100, "PostInvoice", 0, "", 1);
          hub.emit("TestRunCompleted", { Tests: [] });
        });
      }
      return undefined;
    };

    const result = await new TestRunnerClient(fakeHubFactory(hub)).run(
      config,
      auth,
      [{ id: 50100 }],
      { coverage: "procedure" },
    );

    expect(result.results).toHaveLength(1);
    expect(result.coverage).toEqual([]);
    expect(result.coverageComplete).toBe(false);
  });

  test("keeps requested coverage complete when a group without executed tests returns an empty Tests payload", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "RunTests") {
        queueMicrotask(() => {
          // WIRE: BC emits this synthetic codeunit rollup even when no requested test exists.
          hub.emit("TestCompleted", 50100, "", 0, "", 0);
          hub.emit("TestRunCompleted", { Tests: [] });
        });
      }
      return undefined;
    };

    const result = await new TestRunnerClient(fakeHubFactory(hub)).run(
      config,
      auth,
      [{ id: 50100 }],
      { coverage: "procedure" },
    );

    expect(result.results).toEqual([
      { codeunitId: 50100, method: "", status: "passed", durationMs: 0, output: "" },
    ]);
    expect(result.coverageComplete).toBe(true);
  });

  test("marks requested coverage incomplete when TestRunCompleted omits its Tests payload", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "RunTests") queueMicrotask(() => hub.emit("TestRunCompleted", {}));
      return undefined;
    };

    const result = await new TestRunnerClient(fakeHubFactory(hub)).run(
      config,
      auth,
      [{ id: 50100 }],
      { coverage: "procedure" },
    );

    expect(result.coverage).toEqual([]);
    expect(result.coverageComplete).toBe(false);
  });

  test("passes debuggingContext to Initialize", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "RunTests") queueMicrotask(() => hub.emit("TestRunCompleted", { Tests: [] }));
      return undefined;
    };
    await new TestRunnerClient(fakeHubFactory(hub)).run(config, auth, [{ id: 1 }], { debuggingContext: "conn-42" });
    expect(hub.invoked("Initialize")[0]?.args).toEqual(["", "conn-42", 0]);
  });

  test("hub close mid-run yields partial results with runAborted", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "RunTests") {
        queueMicrotask(() => {
          hub.emit("TestCompleted", 50100, "PostInvoice", 0, "", 1);
          hub.close(new Error("socket dropped"));
        });
      }
      return undefined;
    };
    const result = await new TestRunnerClient(fakeHubFactory(hub)).run(config, auth, [{ id: 50100 }]);
    expect(result.results).toHaveLength(1);
    expect(result.runAborted).toBe(true);
    expect(result.abortReason).toContain("socket dropped");
  });

  test("stops the hub when a RunTests invoke rejects", async () => {
    const hub = new FakeHub();
    hub.onInvoke = (method) => {
      if (method === "RunTests") throw new Error("server exploded");
      return undefined;
    };
    const result = await new TestRunnerClient(fakeHubFactory(hub)).run(config, auth, [{ id: 1 }]);
    expect(result.runAborted).toBe(true);
    expect(result.abortReason).toContain("server exploded");
    expect(hub.stopped).toBe(true);
  });
});
