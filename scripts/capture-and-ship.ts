#!/usr/bin/env bun
// capture-and-ship: one scheduled cycle of BC instrumentation capture ->
// bc-mdc-converter ir-json -> gzip -> POST to al-perf /api/ingest.
// Thin I/O shell; all logic lives in src/core/ship/ (typechecked + unit-tested).
// Recipe doc: docs/capture-ship-recipe.md
import { randomUUID } from "node:crypto";
import { createAuthorizationProviderFactory } from "../src/core/authorization";
import { spawnRunner } from "../src/core/snapshot/converter";
import { resolveShipConfig, SHIP_USAGE } from "../src/core/ship/args";
import { runCaptureShipCycle } from "../src/core/ship/capture-cycle";

const res = resolveShipConfig(process.argv.slice(2), process.env);
if (res.kind === "help") {
  console.log(SHIP_USAGE);
  process.exit(0);
}
if (res.kind === "error") {
  for (const e of res.errors) console.error(`error: ${e}`);
  console.error(`\n${SHIP_USAGE}`);
  process.exit(2);
}

const outcome = await runCaptureShipCycle(res.config, res.connection, {
  fetchFn: fetch,
  authorizationFactory: createAuthorizationProviderFactory(),
  runConverter: spawnRunner,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (msg) => console.error(`[capture-and-ship] ${msg}`),
  uuid: randomUUID,
});

switch (outcome.kind) {
  case "shipped":
    console.error(`[capture-and-ship] shipped activity ${outcome.activityId} (${outcome.gzippedBytes} bytes gzipped)`);
    process.exit(0);
    break;
  case "duplicate":
    console.error(`[capture-and-ship] activity ${outcome.activityId} already ingested — no-op`);
    process.exit(0);
    break;
  case "no-capture":
    console.error("[capture-and-ship] 0 sessions captured in the window — nothing to ship (this is a normal outcome)");
    process.exit(0);
    break;
  case "dry-run":
    console.log(JSON.stringify({ manifest: outcome.manifest, gzippedBytes: outcome.gzippedBytes, zipPath: outcome.zipPath, irPath: outcome.irPath }, null, 2));
    console.error("[capture-and-ship] dry run — nothing POSTed; artifacts kept");
    process.exit(0);
    break;
  case "error":
    console.error(`[capture-and-ship] FAILED at ${outcome.stage}: ${outcome.message}`);
    if (outcome.artifacts) console.error(`[capture-and-ship] retained artifacts: ${JSON.stringify(outcome.artifacts)}`);
    process.exit(1);
    break;
  default:
    // scripts/ is excluded from tsconfig's `include` (see tsconfig.json) — this switch is not
    // exhaustiveness-checked at build time, so a future CycleOutcome variant would otherwise fall
    // through with no exit() call and process.exit(0) by default under a scheduled runner. Fail loud.
    console.error(`[capture-and-ship] FAILED: unrecognized outcome kind ${JSON.stringify((outcome as { kind?: unknown }).kind)}`);
    process.exit(1);
}
