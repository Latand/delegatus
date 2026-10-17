# Structured startup quarantine

## Read-only cause (2026-10-16)

The investigation read the user-service journal and a read-only SQLite
connection to the registry, then made an offline SQLite backup. It changed no
production row or process.

The affected Codex row has a registered transcript whose file is absent, an
unknown turn from an empty transcript, a pending spawn marker, and a retained
native callback process. Its claim owner is empty. The journal names the
actual attachment failure: `no rollout found for thread id`. The registry
still records that process after the failed attachment.

The causal path on comparison main `02f9301fc323` is:

- `src/lib/runtime/registry.ts:899`: a failed reconnect to a callback owner
  whose process is alive releases the Viewer claim and retains the row.
- `src/lib/runtime/startup.ts:1111`: an eligible row with a surviving process
  is classified as contested, even when the cause was a missing rollout.
- `src/lib/runtime/startup.ts:1125`: with no adopted host, the contested row
  throws `RuntimeHostUnavailableError` and the pass never records readiness.
- `src/lib/runtime/startup.ts:1952`: only a completed pass is reused.
- `src/lib/viewerInstrumentation.ts:711`: the outer retry backs off to five
  minutes and re-enters the entire startup pass.

The journal sample is 2026-10-16 03:00–05:00 UTC. It contains 25 missing-rollout
errors for the same row and 25 scheduled startup failures, from
03:00:00.195500 to 04:57:05.062253 UTC. The recorded process still existed at
inspection. This independently confirms the causal chain. The earlier study's
116 retries in two hours is its historical observation; this sample was already
at the outer scheduler's five-minute cap.

## Mechanism and shared boundaries

The initial pass completes with contested rows retained. Each row has its own
retry record and deadline beside the registry, outside the registry schema.
The first two delays are one and two seconds. The third failure enters
quarantine, with delays of one, two, four, eight and then fifteen minutes.
Retries remain capped at fifteen minutes. A restart reloads the count, reason
and deadline; it does not reset the backoff. A recovered or removed row loses
its retry record. A healthy completed startup is reused.

A row retry uses a singleton host scope and fresh keyed projections for its
conversation, aliases, deliveries and receipts. It does not repeat global
transcript refresh, historical fallback publication, superseded-delivery
cleanup or pending-spawn recovery. Unrelated retained hosts and existing
pipeline/restart-cut deferrals remain in place. The controller's ordinary
publication registers a recovered row. The existing pipeline admission and
claim checks still decide whether that row may be adopted.

The log carries the row key and a fixed reason: missing rollout, failed
adoption or incumbent ownership. After the third failure, the existing task
store admits one deterministic quarantine card in the row's project. The
seat can read it through its normal task tools. Recovery closes the card;
a refused task write is retried by the row timer. No exception payload enters
the persisted reason or card.

The optional `onFailure` adopter callback has two producers, the Codex and
Claude adoption catch paths, and one production consumer, Viewer startup.
Both default to no callback. Direct adopter users in native callback and seat
fixtures, host tests, linked boot adoption, pipeline restart recovery and CPU
placement keep their previous behavior. Registry storage, row normalization,
copy paths and write contracts are unchanged. The new retry document has one
Viewer owner per registry shared across compiled module copies. It reads only
startup host keys, evicts settled rows, and serializes timers that become due
together. The loop monitor names the work `runtime.startup-row`. The delivery controller
owns one narrow setter for each conversation's startup deferral; startup is its
only consumer. It preserves other deferrals while releasing a reconciled row,
and avoids the controller's historical fallback sweep on a row retry. Runtime
host generation replacement still performs its required full controller
completion. A persisted notice-pending bit avoids task-store reads on unchanged
quarantine retries; a resolved bit retains failed card closures for retry.

Open parallel changes were inspected before editing: registry storage in
#2958 and stage publication in #2964. Registry storage and publication files are outside this change. A concurrent
GC-attribution lane also edits `viewerLoopMonitor.ts`; its actual diff was
read before publication. This change adds only an operation name to the type
in that file, leaving its collector implementation alone.

## Verification and measurement

The unchanged comparison revision is `02f9301fc323`. The candidate source
hashes, offline input digest, complete row census, six samples and procedure
are in `evidence/structured-startup-quarantine.json`. Source hashes cover every
runtime input changed by this feature and the driver. Documentation and test
edits after measurement do not affect those inputs.

The driver runs against a fresh copy of the same read-only SQLite backup in
six separate processes, alternating main and candidate three times, through
one heavy-work admission. The backup contains 7,213 conversations. Current
actuation rows and their cold pointers are removed from each throw-away copy
before it is opened; retained conversation, lineage and membership history and
immutable archive versions remain. One deterministic busy handover row is
added, with the benchmark process itself holding its claim. A private runtime
journal answers all runtime calls. No native engine starts.

The clock is frozen and advanced to the production scheduler's requested
callbacks over one simulated hour, with jitter disabled. Initial startup is
included. CPU is real `process.cpuUsage()` user plus system time during that
replay, including startup completion and row retry work. Transcript refresh is
a counted stub. These figures cover the retained-history reconciliation
workload; native attachment and production transcript I/O require separate
measurement.

| Run | Main full passes/h | Candidate full passes/h | Candidate row retries/h | Main CPU (ms/h) | Candidate CPU (ms/h) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 17 | 1 | 8 | 6591.656 | 3126.144 |
| 2 | 17 | 1 | 8 | 6505.940 | 3256.962 |
| 3 | 17 | 1 | 8 | 6990.233 | 2672.624 |
| Median | 17 | 1 | 8 | 6591.656 | 3126.144 |

Median CPU falls by 52.6%. The first simulated hour includes the outer
scheduler's ramp from five seconds to its five-minute cap, and the row
scheduler's ramp to fifteen minutes. Counts are first-hour measurements.

Reproduce each sample from an isolated export of the revision:

```sh
bash scripts/gate-slot.sh bun scripts/startup-retry-benchmark.ts "$OFFLINE_REGISTRY"
```

Use the same driver and offline input on main and candidate. The standalone
driver claims a private test temp root before loading state-resolving modules.

Acceptance detectors run by explicit file path:

- `src/lib/runtime/startup.quarantine.test.ts`: the absent-rollout/live-owner
  causal shape, log reason and seat card, repair and eviction, one-hour
  scheduler work bounds, and preservation of another pipeline's deferral.
  Each acceptance case is red against main's startup implementation.
- `src/lib/runtime/startup.handoverRetry.test.ts`: a lone handover completes
  boot; an unrelated Claude seat accepts work while the Codex attach fails;
  its live handle is retained across retries and runtime-host replacement.
- `src/lib/runtime/startupRowRetries.test.ts`: real process restart persistence,
  capped backoff, fixed reason classification, durable write refusal,
  ownership revocation, asynchronous task admission under a peer SQLite lock,
  deduplication and resolution, independent row scheduling and cleared timers.
- `src/lib/runtime/startup.test.ts`: both real incumbent engines still obey
  the handover fence. The changed assertions now require ready boot and a
  single-row retry. They are red on main with the updated detectors.

Broader checks and publication results are recorded in the pull request.
