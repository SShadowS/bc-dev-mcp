# TestPermissions over TestRunnerHub, live 2026-10-19

Issue #49: a suite of 220 tests in `TestPermissions = Restrictive` codeunits passed 220/0 under BcContainerHelper and 6/214 under `bcdev_test_run`. All 214 failures came from the suite's own guard that refuses to apply a persona when the Permissions Mock is not running.

Containers: Cronus28 (BC 28.4.53241.53758, Tests-TestLibraries installed) and Cronus29 (BC 29.0.54011.56136, no Tests-TestLibraries, Permissions Mock installed for this run).

Probe app `Issue49 Permissions Probe` 1.0.0.4 (IDs 50490..50497, depends on Permissions Mock + Library Assert). Its source and expected rows are kept as a fixture in business-central-mcp (`tests/fixtures/i49-permissions-probe/`, branch `fixture/i49-permissions-probe`). The Observe tests always fail and report `PermissionsMock.IsStarted()` plus `ReadPermission()` on an extension table no permission set grants (`probeLogRead`: No = a permission set baseline is in effect, Yes = SUPER/no effective sets).

Runners compared: `bcdev_test_run` (TestRunnerHub), BcContainerHelper 6.1.17 `Run-TestsInBcContainer` (page 130455, runner 130450), and business-central-mcp 2.2.0 `bc_run_tests` (page 130455 over the web client protocol). The last two agreed on every row.

| Probe | AL Test Runner, BC28 | AL Test Runner, BC29 | Hub, BC28 and BC29 |
|---|---|---|---|
| Restrictive: `PermissionsMock.IsStarted()` | true | true | false |
| Restrictive: `Set('I49 Company Only')`, then `Customer.FindFirst()` | `DB:ClientReadDenied` | `DB:ClientReadDenied` | succeeds (Set is a no-op) |
| Restrictive, no persona: `probeLogRead` | No (130302 D365 FULL ACCESS) | Yes (no 130302) | Yes |
| Disabled: mock started | true | true | false |
| No TestPermissions property: `probeLogRead` | No (so: Restrictive) | Yes | Yes |
| Method `[TestPermissions(TestPermissions::Disabled)]` in that codeunit: `probeLogRead` | Yes (attribute overrides) | Yes | Yes |
| Test starts the mock itself, `Set(persona)`, reads Customer | denied | denied | **denied** |
| Test A starts mock + sets persona, no cleanup; test B reads Customer | B reads | B reads | B reads, `mockStarted=Yes` (the flag leaks, the persona does not) |

The hub runner was checked in the service tier of BC28 and BC29: it receives each test's TestPermissions and does not use it, and `Initialize(company, debuggingContext, coverageMode)` / `RunTests(codeunitId, testMethods[])` take nothing that selects a runner or permissions. BC26 has no TestRunnerHub.

Compiled `.app` SymbolReference.json (alc 30.0.2863738): codeunit `Properties[{Name:"TestPermissions", Value:"Restrictive"}]`, absent when not set; method `Attributes[{Name:"TestPermissions", Arguments:[{Value:"Disabled"}]}]`.
