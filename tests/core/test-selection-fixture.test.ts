import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { discoverAlProcedureIdentities } from "../../src/core/al-procedures";
import type { CoverageMap } from "../../src/core/coverage-map";

// Guards the recorded live coverage map against fixture source drift: every identity BC
// reported must still resolve to a local procedure, and the README's edge claims must hold.
test("recorded test-selection coverage map resolves to fixture procedures", async () => {
  const fixture = resolve("tests/fixtures/test-selection");
  const map = JSON.parse(readFileSync(join(fixture, "coverage-map.json"), "utf8")) as CoverageMap;
  const found = await discoverAlProcedureIdentities(fixture, readdirSync(join(fixture, "src")).map((f) => `src/${f}`));
  const names = new Map(found.procedures.map((p) => [`${p.objectType}|${p.objectId}|${p.methodId}`, `${p.objectName}.${p.name}`]));
  const reached = (method: string) =>
    map.tests.find((t) => t.method === method)!.procedures.map((p) => names.get(`${p.objectType}|${p.objectId}|${p.methodId}`));

  expect(map.complete).toBe(true);
  expect(map.tests.length).toBe(12);
  for (const t of map.tests) {
    expect(names.get(`5|${t.codeunitId}|${t.methodId}`)?.endsWith(`.${t.method}`)).toBe(true);
    for (const name of reached(t.method!)) expect(name).toBeDefined();
  }
  // Event edge: subscriber attributed to the test that only calls the publisher's caller.
  expect(reached("FinalizeSmallAmountAddsSurcharge")).toContain("Sel Surcharge Subscriber.AddSurchargeOnFinalize");
  expect(reached("CalcLineAmountRaisesNoEvent")).not.toContain("Sel Surcharge Subscriber.AddSurchargeOnFinalize");
  // Interface edge: the implementation reached only via dispatch is attributed.
  expect(reached("ShippingCostExpressDispatch")).toContain("Sel Express Rate.Rate");
  // Uncoverable: no test reaches LegacyTaxAmount.
  expect(map.tests.flatMap((t) => reached(t.method!))).not.toContain("Sel Pricing.LegacyTaxAmount");
});
