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

## Correction regression

The disposable fixture was republished as version 1.0.0.5 after the edge-case review.
A table method whose implicit `Rec` was a different table executed an explicit
`with Target` block containing parenthesis-free `Insert`, `Modify`, `Delete`, and
`DeleteAll` calls.

- The targeted capture completed with every writer receiver reported as `Target`, not
  the host table's `Rec`.
- All four parenthesis-free operations were classified from deployed source with zero
  unresolved writes.
- The original full acceptance matrix was rerun unchanged and retained its 13 observed,
  10 matched, 9 grouped, 3 unrelated, and 0 unresolved result.
- Configuration rejection, unexpected clean connection closure, and a Break callback
  delivered asynchronously during finish are deterministic fake-hub fault injections;
  they were not induced against the live Sandbox. The asynchronous finish test verifies
  both accepted and rejected release-barrier responses without dropping the Break or
  sending a duplicate release.

The fixture and harness lived outside the repository and are not part of the feature
diff.
