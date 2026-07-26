# Break-on-record-write triage — SaaS evidence

Validated on 2026-07-26 against a disposable Business Central SaaS Sandbox app. The
fixture was compiled locally and published with `~/bin/bc-al-publish.sh`. The harness
refused any non-Sandbox configuration. No Production or on-premises call was made.

All tenant, environment, company, user, host, session, connection, token, authorization,
and authenticated-URL values were omitted. No record field value or raw source body was
retained.

## Capture path

The triage tool armed a Background-session attachment and returned with phase `arming`.
A disposable API page then started the matching Background workload. Collection bound,
classified each record-write stop, and continued the workload automatically; the
harness made no manual debugger wait or continue call.

## Results

- The default capture completed with 13 observed writes: 10 exact target writes in 9
  grouped writers, 3 proven unrelated writes, and 0 unresolved writes.
- The exact groups covered `Insert`, `Modify`, `ModifyAll`, `Rename`, `Delete`, and
  `DeleteAll`, including repeated calls from one stack, a second caller stack, and a
  runtime `RecordRef` receiver.
- Every exact writer used deployed source and retained a usable full statement span.
  The report was complete for its attached-session capture window.
- Repeating the capture with temporary writes enabled added exactly one matched target
  write relative to the default non-temporary capture.
- Forced local-source fallback without `changesDeployed` produced 0 exact matches and
  incomplete evidence. After the already-published fixture was explicitly asserted
  with `changesDeployed: true`, the same narrow workload produced 3 exact
  `localAsserted` matches.
- With `maxObservedWrites: 1`, the cap event was classified, the workload was released,
  and the report returned `truncated: true`, `complete: false`, with exactly one
  observed write.
- Finish cleared the shared debugger owner. An immediate manual attach/detach cycle
  succeeded, confirming slot reuse.

The fixture and harness lived outside the repository and are not part of the feature
diff.
