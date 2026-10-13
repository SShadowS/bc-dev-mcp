// FakeHub script replaying the expected TestRunnerHub wire behaviour of the
// demos/order-pollution app (codeunit 50161) — see demos/ORDER-POLLUTION.md.
// Encodes the #33 WIRE facts (scripts/e2e.md): each RunTests group starts from clean data
// (groups roll back even after Commit()), methods inside a group run in DECLARATION order
// whatever testMethods[] says, and a second RunTests for the same codeunit on one
// connection closes the hub mid-group with no TestRunCompleted.
import { FakeHub } from "./fake-hub";

export const POLLUTION_CODEUNIT = 50161;

interface DemoMethod {
  name: string;
  /** Table name this method leaves committed for later methods in the same group. */
  pollutes?: string;
  /** Fails with this message if the given table was polluted earlier in the group. */
  victimOf?: { table: string; error: string };
}

/** Declaration order of codeunit 50161 "Order Pollution Tests". */
export const POLLUTION_METHODS: readonly DemoMethod[] = [
  { name: "PolluterCommitsCustomer", pollutes: "Customer" },
  { name: "IndependentArithmetic" },
  {
    name: "VictimInsertsSameCustomer",
    victimOf: { table: "Customer", error: "The record in table Customer already exists. Identification fields and values: No.='ODPOLL-C1'" },
  },
  { name: "IndependentCompanyName" },
  { name: "PolluterCommitsFlag", pollutes: "Order Pollution Flag" },
  { name: "IndependentRolledBackWrite" },
  {
    name: "VictimExpectsNoFlag",
    victimOf: { table: "Order Pollution Flag", error: "Expected no Order Pollution Flag rows, found 1" },
  },
  { name: "IndependentLast" },
];

/** A FakeHub that behaves like a BC28 TestRunnerHub with the demo app published. */
export function orderPollutionHub(): FakeHub {
  const hub = new FakeHub();
  const ranCodeunits = new Set<number>();
  hub.onInvoke = (method, args) => {
    if (method !== "RunTests") return undefined;
    const [codeunitId, requested] = args as [number, string[]];
    queueMicrotask(() => {
      if (ranCodeunits.has(codeunitId)) {
        // WIRE: NST TestRunnerExecutionException "An item with the same key has already been added" (#33).
        hub.close(new Error("Server closed the connection"));
        return;
      }
      ranCodeunits.add(codeunitId);
      const selected = POLLUTION_METHODS.filter((m) => requested.length === 0 || requested.includes(m.name));
      const polluted = new Set<string>(); // fresh per group: groups roll back
      for (const m of selected) {
        hub.emit("TestStarted", codeunitId, m.name);
        const failure = m.victimOf && polluted.has(m.victimOf.table) ? m.victimOf.error : undefined;
        hub.emit("TestCompleted", codeunitId, m.name, failure ? 1 : 0, failure ?? "", 5);
        if (m.pollutes) polluted.add(m.pollutes);
      }
      hub.emit("TestRunCompleted", { Tests: [] });
    });
    return undefined;
  };
  return hub;
}
