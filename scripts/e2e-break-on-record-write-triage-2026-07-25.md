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

- The default workload produced 13 observed writes: 10 exact target writes in 9
  grouped writers, 3 proven unrelated writes, and 0 unresolved writes.
- The exact groups covered `Insert`, `Modify`, `ModifyAll`, `Rename`, `Delete`, and
  `DeleteAll`, including repeated calls from one stack, a second caller stack, and a
  runtime `RecordRef` receiver.
- Every exact writer used deployed source and retained a usable full statement span.
  Classification had zero unresolved writes.
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

The disposable fixture was republished as version 1.0.0.5 after the first edge-case review.
A table method whose implicit `Rec` was a different table executed an explicit
`with Target` block containing parenthesis-free `Insert`, `Modify`, `Delete`, and
`DeleteAll` calls.

- The targeted capture classified every writer receiver as `Target`, not
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

## Detach and conditional-upsert follow-up

Version 1.0.0.6 added the idiomatic conditional form
`if not Target.Insert(false) then Target.Modify(true)` and reran the full matrix.

- SaaS reported an individual write-call statement span for each `Insert` and `Modify`,
  not one enclosing conditional span. The scenario observed 5 writes, matched all 5,
  and produced 0 unresolved writes.
- `multipleWriteCandidates` remains a stable fail-closed reason for a server or source
  span that genuinely contains more than one write candidate.
- SaaS Background completion emits `OnDetachedFromConnection` before finish. The final
  implementation therefore retains the exact 13/10/9/3/0 evidence but reports
  `complete: false`, `stopReason: "sessionDetached"`, and a warning rather than a false
  all-clear. A detach caused by finish's own release barrier remains a deliberate
  `finished` window.
- The full matrix still passed: temporary delta +1, asserted/unasserted local fallback,
  one-write cap release, contextual `with`, parenthesis-free calls, automatic
  continuation, and debugger-slot reuse.

The fixture and harness lived outside the repository and are not part of the feature
diff.
