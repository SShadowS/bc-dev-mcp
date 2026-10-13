# Live progress + newer-major smoke, Cronus29 (BC29), 2026-10-13

Host: http://Cronus29:7049/BC, tenant default. dev/metadata: runtimeVersion 18.0, webApiVersion 7.0,
debuggerVersion 9.0. Driver: `node dist/index.js` (bun run build) spoken to over real stdio with raw
JSON-RPC (legacy `initialize`, `_meta.progressToken` on the calls). App: `demos/order-pollution`
compiled with alc 30.0 against the BC28 symbols (runtime 17.0, platform/application 28.0.0.0).

## Results

- bcdev_status: supportsTestRunning, supportsCoreSignalR, supportsSourceDownload all true.
- bcdev_app_publish (Dev scope) of the runtime-17 / platform-28 app on the BC29 server: published.
  No wire difference.
- bcdev_test_run codeunit 50161: 8 results (6 passed, 2 failed: VictimInsertsSameCustomer,
  VictimExpectsNoFlag), identical to the BC28 outcome in demos/ORDER-POLLUTION.md. 8
  notifications/progress, one per TestCompleted.
- bcdev_test_orchestrate mode repeat runs 3: 3 progress notifications (1..3 of 3).
- bcdev_test_orchestrate mode order seeds [1,2] maxProbes 4: 16 progress notifications.
- bcdev_debug_attach (breakOnError unhandled) -> debugSessionId; bcdev_debug_wait 35000 ms with token:
  timedOut at 35.0 s, heartbeats at 10.0 / 20.0 / 30.0 s; wait without token: none; detach: detached.
  Attach/HubConnected sequence and SessionId -1 worked unchanged on debugger 9.0.
- Cleanup: uninstall deleteData (alsoUninstalled []) + unpublish; bcdev_app_list 103 apps before and
  after, identical (hash of id/name/version/installed rows).

## Wire differences vs BC28

None observed. Not exercised on Cronus29: a debugger break (Break payload, breakpoints, stepping).
