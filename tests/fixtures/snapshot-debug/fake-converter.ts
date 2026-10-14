// Stand-in for bc-mdc-converter in run-converter tests: `<script> <in.zip> <out.json> --format snapshot-json`.
import { writeFileSync } from "node:fs";

const out = process.argv[3]!;
writeFileSync(`${process.argv[2]}.out`, out); // lets the test check the temp JSON is gone afterwards
switch (process.env["FAKE_MODE"]) {
  case "ok":
    writeFileSync(out, JSON.stringify({ format: "bc-mdc-snapshot", schemaVersion: 1, methods: [], sources: [] }));
    break;
  case "fail":
    process.stderr.write("error: entry 7.mdc is corrupt\n" + "S".repeat(10 * 1024) + "\n");
    process.exit(3);
  case "sleep":
    await new Promise((r) => setTimeout(r, 5000));
    break;
  case "invalid":
    writeFileSync(out, '{"value": "SECRET-MARKER-42", oops');
    break;
  case "big":
    writeFileSync(out, JSON.stringify({ pad: "x".repeat(2048) }));
    break;
}
