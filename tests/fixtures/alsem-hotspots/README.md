# alsem-hotspots fixture

`ws/` is a one-codeunit AL workspace (`Slow Loop`, 50100) with database operations inside loops.
`analyze.json` is the real output of

```
alsem analyze ws --format json --with-evidence --single-app --detector <PERF_DETECTORS of src/core/hotspot-explain.ts>
```

recorded with `alsem.exe` reporting `alsemVersion 1.5.0` (al-sem repo at `2c48e56f`, 2026-10-13; a
local release build, `generatedAt` is the recording time). It carries three findings: `d1` in
`SumLines` and `Unblock`, `d5` in `Unblock`. `tests/core/hotspot-explain.test.ts` replays it and
re-runs alsem live when `BC_DEV_ALSEM` or `alsem` on PATH is available.

Shapes this fixture pins: `primaryLocation.file` is `ws:<workspace-relative path>`, `line` is 1-based,
evidence `sourceAnchor.range` lines are 0-based, `confidence` is `{level}`, the fix is `fixHint`.
Regenerate by re-running the command above when al-sem bumps the `analyze-report` major.
