# snapshot-debug fixtures

`page-exception.snapshot.json`: output of bc-mdc-converter 0.2.0 (`--format snapshot-json`) for
`snapshot-page-exception.zip`, captured on Cronus29 2026-10-14 (page 50152 OnOpenPage, snappoint on
line 35 plus an `Error()` on line 36).

The bundled source `Page%50152.al` is not stored here; the test builds it as an inline string
(lines 30-40 of the bundled source).

`page-exception.zip`: that archive itself (copied from bc-mdc-converter `fixtures/snapshot-page-exception.zip`),
served as the finish body in `tests/mcp/snapshot-tools.test.ts`.

`fake-converter.ts`: stand-in for bc-mdc-converter in `tests/core/snapshot/run-converter.test.ts`
(`FAKE_MODE` = ok | fail | sleep | big).
