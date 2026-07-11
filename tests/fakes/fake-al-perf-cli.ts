#!/usr/bin/env bun
// fake-al-perf-cli: a tiny stand-in for al-perf's CLI (`lifecycle captures ...`
// subcommands only), so entry-args/queue-client/worker wiring can be smoked through
// the real scripts/work-capture-queue.ts without a real al-perf install. Stateless —
// every invocation is a fresh process, matching how the real CLI is invoked (once per
// queue-client call) — so state is entirely env-var-driven, not persisted to disk.
//
// Recognizes exactly the args queue-client.ts builds:
//   ["lifecycle", ["--db", <path>]?, "captures", "list", "-f", "json", "--status", "pending", ["--tenant", <t>]?]
//   ["lifecycle", ["--db", <path>]?, "captures", "claim", <id>, "--by", <name>]
//   ["lifecycle", ["--db", <path>]?, "captures", "cancel", <id>]
//
// Env:
//   FAKE_CLI_ROWS         JSON array of CaptureRequestRow, returned verbatim by `list` (default "[]")
//   FAKE_CLI_CLAIM_FAIL   comma-separated ids that `claim` fails for as a RACE (exit 1, "status is claimed.")
//   FAKE_CLI_CLAIM_ERROR  comma-separated ids that `claim` fails for as a CLI-BROKEN error (exit 1,
//                         a message matching neither "status is " nor "No capture request with id" —
//                         classifyFailure() in queue-client.ts then reports reason "error", not "raced")
//   FAKE_CLI_CANCEL_FAIL  comma-separated ids that `cancel` fails for (exit 1, "status is fulfilled.")

const args = process.argv.slice(2);
let i = 0;
if (args[i] === "lifecycle") i++;
if (args[i] === "--db") i += 2;
if (args[i] === "captures") i++;
const sub = args[i];

function failIds(envVar: string): string[] {
  return (process.env[envVar] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

if (sub === "list") {
  console.log(process.env.FAKE_CLI_ROWS ?? "[]");
  process.exit(0);
} else if (sub === "claim") {
  const id = args[i + 1];
  if (id && failIds("FAKE_CLI_CLAIM_ERROR").includes(id)) {
    console.error(`fake-al-perf-cli: unexpected internal failure claiming #${id}`);
    process.exit(1);
  }
  if (id && failIds("FAKE_CLI_CLAIM_FAIL").includes(id)) {
    console.error(`Capture request #${id} cannot be claimed — status is claimed.`);
    process.exit(1);
  }
  console.log(`Capture request #${id} claimed.`);
  process.exit(0);
} else if (sub === "cancel") {
  const id = args[i + 1];
  if (id && failIds("FAKE_CLI_CANCEL_FAIL").includes(id)) {
    console.error(`Capture request #${id} cannot be cancelled — status is fulfilled.`);
    process.exit(1);
  }
  console.log(`Capture request #${id} cancelled.`);
  process.exit(0);
} else {
  console.error(`fake-al-perf-cli: unrecognized invocation: ${args.join(" ")}`);
  process.exit(1);
}
