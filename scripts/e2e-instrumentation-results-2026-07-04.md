# E2E live verification — headless instrumentation profiling — 2026-07-04

**Target:** docker container `Cronus28`, BC 28.0, instance `BC`, tenant `default`, company `CRONUS Danmark A/S`, UserPassword auth (`<user>` / `<pass>`). Snapshot-debugger endpoint `http://Cronus28:7083/BC` (`snapshotApiVersion 3.0`), dev endpoint `http://Cronus28:7049/BC`.

**Host toolchain:** node `v24.14.0`; `dotnet 10.0.301` with `Microsoft.NETCore.App 8.0.28` present (the converter is framework-dependent net8.0, shipping `System.Collections.Immutable 9.0.0` alongside — see `tools/mdc-converter/README.md`); al dotnet-tool DLLs at `~/.dotnet/tools/.store/microsoft.dynamics.businesscentral.development.tools/18.0.37.11445-beta/.../tools/net8.0/any`.

**Goal:** drive the full instrumentation chain — arm → trigger a live WebClient session → poll → finish → **convert the `.mdc` zip to a `.alcpuprofile` headlessly** — through the SHIPPED `bcdev_profile_*` tools (no re-implementing the wire), and confirm the **production converter-discovery path** (`resolveConverter` locating `dist/converter/<rid>/mdc-converter.exe` next to the built `dist/index.js`, the T4 open item), plus the graceful raw-fallback branch.

The headless conversion itself was previously proven feasible in `scratch/mdc2profile-findings.md` (a ~180-line reflection shim invoking Microsoft's own `CpuProfileGenerator`); this run validates the *productised* shim (`tools/mdc-converter/`, built by `bun run build:converter`) reached through the real tool surface and the real discovery code.

**Local gate before the run:** `bun test` → **147 pass / 0 fail**; `bun run typecheck` → clean; `bun run build` → `dist/index.js` (1.20 MB); `bun run build:converter` → `dist/converter/win-x64/mdc-converter.exe` (+ `Newtonsoft.Json.dll`, `System.Collections.Immutable.dll`, deps/runtimeconfig).

**Method:** `scratch/instr-e2e.mjs` (untracked; not part of this commit). The **session trigger** is a real WebClient session created via `business-central-mcp` (opening list pages 22/31/16/27/21/26 + reading data + a Tell-Me search = real AL execution). Two runs:

- **RUN A — production discovery.** Spawns the **built server** (`node dist/index.js`) as a stdio MCP subprocess and drives it via an MCP client. **No `converterOverride` is injected**, so `bcdev_profile_start`/`bcdev_profile_finish` exercise the real `resolveConverter({ distDir: resolveDistConverterDir() })` path: `resolveDistConverterDir()` = `dirname(fileURLToPath(import.meta.url))/converter` = `dist/converter`, `findShimPath` → `dist/converter/win-x64/mdc-converter.exe`, `findAlDllDir` → the al-tool net8 DLLs.
- **RUN B — raw fallback.** Loads the source tools with `converterOverride.resolveEnv = () => null` (converter "unavailable"), so `finish` must save the raw `.mdc` zip and report `instrumentation-raw` rather than converting.

---

## RUN A — production converter discovery (KEY T4 confirmation)

Driven entirely through the built `dist/index.js` MCP server. `debuggingContext = b84645b2-135f-4210-b60b-b62df80631a9`.

| Step | Tool call | Result |
|---|---|---|
| A1 | `bcdev_profile_status { server, serverInstance, tenant }` | `{ reachable:true, snapshotApiVersion:"3.0", sampleProfilingSupported:true, webEndpoint:"http://Cronus28/BC/" }` |
| A2 | `bcdev_profile_start { kind:"instrumentation", clientType:"WebClient", ...conn }` | `{ debuggingContext, attachKind:"NextSessionOnTenant", `**`converterAvailable:true`**` }` |
| A3 | trigger WebClient session (bc-mcp) + `bcdev_profile_poll` | poll #0 → `{ status:"Started", ready:true }` (Started immediately after the first AL burst; 4 post-Started bursts kept the recording window busy) |
| A4 | `bcdev_profile_finish { outPath }` | `{ captured:true, `**`kind:"instrumentation"`**`, profilePath:…b84645b2….alcpuprofile, zipPath:…b84645b2….snapshot.zip }` |

**`converterAvailable:true` from the real `resolveConverter` (no override) — the T4 open item is CONFIRMED end-to-end.** `bun build --target=node` preserves `fileURLToPath(import.meta.url)` in the bundle (verified textually — the emitted `dist/index.js` still contains `join(dirname(fileURLToPath(import.meta.url)), "converter")`, not an inlined src constant), so at runtime the bundle resolves its own on-disk `dist/` directory, finds the sibling `dist/converter/win-x64/mdc-converter.exe`, and `findAlDllDir` locates the al-tool net8 DLLs from the dotnet-tool store. No `converterOverride` was involved.

**Finish converted the recording headlessly** — `kind:"instrumentation"` means the production shim ran (`.mdc` zip → `.alcpuprofile`) via the discovered path.

**Finish summary:**

```
durationMs 108648.84   sampleCount 708   nodeCount 708
top self-time hotspots (real AL frames):
   3.6%  self=1  OnPageBackgroundTaskCompleted   @ …/Page/21/Page_21.dal:2557
   3.6%  self=1  GetAvgDaysPastDueDateLabel      @ …/Codeunit/32/CodeUnit_32.dal:141
   2.8%  self=1  OnCompanyOpenCompleted          @ …/Codeunit/2000000003/CodeUnit_2000000003.dal:46
   2.5%  self=1  GetCueStyle                     @ …/Codeunit/2000000004/CodeUnit_2000000004.dal:86
   2.4%  self=1  OnAfterGetCurrRecord            @ …/Page/1178/Page_1178.dal:249
   2.4%  self=1  HasContent                      @ …/Table/1173/Table_1173.dal:550
   1.8%  self=1  OnInit                          @ …/Page/22/Page_22.dal:1658
   1.7%  self=1  IsCRMIntegrationEnabled         @ …/Codeunit/5330/CodeUnit_5330.dal:175
```

Frame URLs are `al-preview://…` (the headless converter has no VS Code workspace to resolve symbols to real `.al` paths — expected, and exactly what `scratch/mdc2profile-findings.md` documents; function names / lines / timings are real regardless).

**On-disk `.alcpuprofile` parses as V8:** `nodes=708, samples=708, timeDeltas=708`, `validV8=true` (476,313 bytes). `nodes == samples == timeDeltas` is the instrumentation (deterministic every-call) shape, matching `CpuProfileGenerator.GenerateProfile` per `scratch/mdc2profile-findings.md`. The raw `.mdc` zip is also kept alongside (`…b84645b2….snapshot.zip`, 6,590,254 bytes).

---

## RUN B — raw fallback (converter unavailable)

Source tools with `converterOverride.resolveEnv = () => null`. `debuggingContext = 3f279035-113f-4310-bbd2-32462202c6c2`.

| Step | Tool call | Result |
|---|---|---|
| B2 | `bcdev_profile_start { kind:"instrumentation", … }` | `{ attachKind:"NextSessionOnTenant", `**`converterAvailable:false`**`, hint:"…WARNING: converter not found (al tool / .NET runtime); finish will save the raw .mdc snapshot…" }` |
| B3 | trigger + `bcdev_profile_poll` | poll #0 → `{ status:"Started", ready:true }` |
| B4 | `bcdev_profile_finish { outPath }` | `{ captured:true, `**`kind:"instrumentation-raw"`**`, zipPath:…3f279035….snapshot.zip, hint:"Raw .mdc snapshot saved. Convert by opening it in VS Code…" }` |

Saved zip: **6,477,388 bytes, isZip=true, 11,409 entries, 11,243 `.mdc`** — a genuine instrumentation recording preserved for the user. The injected `run` spawn-runner was **never called** (`runCalled=false`), confirming the raw branch returns *before* `convertMdcZip` when the converter is unavailable — no accidental spawn, no partial output. `converterAvailable:false` also surfaces the actionable warning at `start` time, before any recording is wasted.

---

## Summary

| Claim | Verdict |
|---|---|
| Local gate (test / typecheck / build / build:converter) | ✅ 147 pass; clean; `dist/index.js`; `dist/converter/win-x64/mdc-converter.exe` |
| **Production discovery: real `resolveConverter` (no override) finds shim + al-tool DLLs → `converterAvailable:true`** | ✅ **CONFIRMED via built `dist/index.js`** (T4 open item resolved) |
| Live instrumentation capture reaches `Started` | ✅ immediately after the first WebClient AL burst |
| `finish` converts headlessly → `kind:"instrumentation"` | ✅ 708-node `.alcpuprofile`, real AL frames |
| On-disk `.alcpuprofile` is valid V8 | ✅ `nodes==samples==timeDeltas==708` |
| Raw fallback → `kind:"instrumentation-raw"` + saved `.zip` | ✅ 6.48 MB zip, 11,243 `.mdc`; converter spawn not invoked |

The headless `.mdc → .alcpuprofile` conversion feasibility was first proven in **`scratch/mdc2profile-findings.md`** (reflection into Microsoft's `CpuProfileGenerator`, no VS Code / `al` CLI / language server / symbols required); this run validates the shipped, productised converter reached through the real `bcdev_profile_*` tool surface and the real discovery code, plus the graceful degrade when the converter is absent.

**Reproduce:** `bun run build && bun run build:converter && bun run scratch/instr-e2e.mjs` (needs the live `Cronus28` container + `business-central-mcp` built at `U:\Git\bc-mcp\dist\stdio-server.js`). Full transcript: `scratch/instr-e2e.log`; artifacts: `scratch/instr-e2e-out/`.
