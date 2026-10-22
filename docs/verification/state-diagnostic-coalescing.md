# State admission and scan journal windows

Reconfirmed on main `1a32fcc7517536d5ab3a56e79ae36dc88c91deff`,
2026-10-22. The relevant production files match the lane's starting main
revision `4da1e12922993eb77d31a3555eeae9969eace338`.

- `src/lib/blockingWaits.ts:146` logged every refused state-write-lock sample.
- `src/lib/state/lockWait.ts:169` converted a zero-budget acquisition into a
  timeout.
- `src/lib/pipelines/controller.ts:265` repeated the incomplete-scan message
  on every completed incomplete observation.

The regression tests were written before the corresponding fixes. They were
also copied into a scratch export of the main revision above and run through
`gate-remote` and `scripts/gate-slot.sh`, with the same isolated HOME,
XDG_CONFIG_HOME, TMPDIR, LLV_STATE_DIR and closed Viewer control URL as the
branch checks. The selected four cases failed: five synchronous deferrals
produced five lines, zero-budget async admission threw a timeout, a held lease
had no safe holder metadata, and five incomplete ticks produced five lines.

The selected baseline command inside that export was:

```sh
bun run test ./src/lib/state/lockWait.test.ts ./src/lib/pipelines/controller.test.ts \
  --test-name-pattern 'five zero-wait admissions|zero-budget async|incomplete ticks log|safe holder kind'
```

Short retryable state admissions now use `deferred: true`. Journal summaries
group them by process role, subject, operation label, synchronous flag, call
site and admission reason within a five-second process-owned window. Each
summary retains the latest sample, `firstAt`, `count` and `suppressedCount`
(`count - 1`). Changing operation ids cannot defeat coalescing. A single
unreferenced timer flushes the window even without another sample; normal
process exit and explicit exit flush a partial window. At most 128 groups are
retained; admitting a new group at capacity writes the oldest group's exact
receipt before eviction. Abrupt process termination can lose the unflushed
partial window. This diagnostic buffer carries no lease authority.

All samples still enter the existing bounded diagnostics ring. Refusal counts
exclude retryable deferrals, which have their own lifetime counter. Terminal
errors, timeouts and cancellation retain individual journal evidence.
Thresholds still apply after rounding to a tenth of a millisecond: 50 ms for
state-write-lock, state-lease and file-transaction sites; 250 ms for every
other blocking-wait site. Threshold observations bypass coalescing.

The lease acquisition path adds only metadata from the row it already reads:
the current process's kind when it holds the lease, otherwise `other-process`,
and the nonnegative age at observation. It publishes no holder token or path
and adds no process scan. SQLite writer contention has no proven holder and
omits those fields. Stale-owner checks, compare-and-set fencing, release and
write authority remain unchanged. Other admission producers (SQLite attempts
and file-transaction admission errors) may omit holder metadata; wrapper
causes and nested admission preserve the existing error contract.

An audible incomplete scan episode records its start, age at most once per
minute, and a single completion. Age uses the controller's monotonic clock.
`incompleteChecks` counts completed incomplete observations;
`suppressedCount` counts those without a start or age line. A failure or a
timed-out phase cannot manufacture completion. Quiet startup diagnostics
remain quiet, and enabling diagnostics begins an episode on the next
incomplete observation. The Viewer loop-gap and performance-summary paths
are unchanged. No startup or registry preparation path is edited, and no
throughput or latency improvement is claimed.

Coverage lives in `src/lib/blockingWaits.test.ts`,
`src/lib/state/lockWait.test.ts` and `src/lib/pipelines/controller.test.ts`.
It includes window boundaries, exact counts, caller separation, eviction,
failed log sinks, real process restarts, natural and explicit exit, threshold
boundaries, callback non-entry, retry, cancellation and committed-write
preservation. The existing lease-recovery and loop diagnostics suites check
the authority and service-journal fences separately.

The seven-file focused check ran 100 cases: 96 passed and four release-retention
instrumentation cases failed. The project's comparator, run as
`gate-remote -- bash scripts/gate-slot.sh bun scripts/local-gate-tests.ts --base
4da1e12922993eb77d31a3555eeae9969eace338
./src/lib/mainThreadInstrumentation.test.ts`, reproduced all four on the base
with the same isolation and returned zero new failures. The retained fixture
bindings expect the earlier synchronous retention implementation. Those
unrelated fixtures are outside this change.
