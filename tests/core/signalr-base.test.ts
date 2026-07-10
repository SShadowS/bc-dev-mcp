import { describe, expect, test } from "bun:test";
import { buildHubQuery, normalizeKeys } from "../../src/core/hubs/signalr-base";
import type { ConnectionConfig } from "../../src/core/types";

const config: ConnectionConfig = {
  server: "http://localhost",
  serverInstance: "BC",
  tenant: "default",
  username: "u",
  password: "p",
};

describe("buildHubQuery", () => {
  test("carries Authentication header value and tenant", () => {
    const q = buildHubQuery(config);
    expect(q["Authentication"]).toBe("Basic " + Buffer.from("u:p").toString("base64"));
    expect(q["tenant"]).toBe("default");
  });

  test("defaults tenant to \"default\" when unset, merges extras", () => {
    const q = buildHubQuery({ ...config, tenant: undefined }, { sessionId: "7" });
    expect(q["tenant"]).toBe("default");
    expect(q["sessionId"]).toBe("7");
  });
});

describe("normalizeKeys", () => {
  test("lowercases first letter deeply, through arrays", () => {
    expect(
      normalizeKeys<Record<string, unknown>>({
        ObjectId: { ObjectType: 5, ObjectNumber: 50100 },
        Stack: [{ MethodName: "Foo", StatementSpan: { From: { Line: 12, Column: 4 } } }],
        already: 1,
      }),
    ).toEqual({
      objectId: { objectType: 5, objectNumber: 50100 },
      stack: [{ methodName: "Foo", statementSpan: { from: { line: 12, column: 4 } } }],
      already: 1,
    });
  });

  test("passes primitives and null through", () => {
    expect(normalizeKeys<null>(null)).toBeNull();
    expect(normalizeKeys<number>(42)).toBe(42);
  });
});
