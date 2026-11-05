# Privacy worker correlation

Privacy preparation can time out while waiting for the shared worker. The
60-second worker deadline starts at submission and includes queueing; the
180-second preparation window also includes retries. A timeout alone cannot
identify which part of the work stalled. This instrumentation supplies that
evidence for future requests. The cause of the observed live incident remains
**UNKNOWN**. No performance improvement or incident recovery is claimed.

## Ownership and envelope

`spawnRunStage` and the runtime-switch driver establish a process-local async
context around preparation and dispatch. It carries a random request UUID and
the owning attempt. Pipeline and stage labels are SHA-256 digests of their
exact UTF-8 identifiers; attempt is a positive integer. This permits comparison
with a known attempt without logging user-controlled stage names. Nested work
for the same owner keeps the request UUID. Concurrent owners have separate
contexts. A later preparation invocation gets a fresh UUID.

`TaskPageWorker.submit` creates a separate random job UUID for each submission,
including a queue-full refusal. The existing numeric frame ID still identifies
the resident worker's active slot. The caller sends both UUIDs in `correlation`;
the production worker echoes that allowlisted pair in every phase, result and
error envelope. The worker acknowledges `started` before reading privacy state
or building a page. Owner labels never enter the worker payload.

The parent checks a supplied correlation pair against the active job before
consuming its phase, result or error. Replies from workers that omit correlation
remain compatible and leave execution timing unknown. Correlation grants no
authority. The existing authoritative revision check in the parent, stored-rule
checks in the worker, operation lease, dispatch fences, deadlines, queue limit,
retirement and fail-closed errors continue to govern effects.

## Observations and bounds

`taskPageWorkerDiagnostics().privacy` returns the last 128 phase observations,
an eviction count and the existing log sink's drop count. One process owns the
tail across route bundles; oldest observations are evicted first. Snapshots
are copies. The existing task-export measurement script consumes this
diagnostic object alongside its build and CPU counters. Restarting a process starts an empty tail. No registry scan, state
write, new timer or general telemetry service is involved.

The phases are `queued`, `dispatched`, `started`, `compile`, `match`,
`cancelled`, `settled` and `timeout`. Terminal records retain the preceding
phase, cancellation observation, static failure category, original budget and
elapsed duration. Cancellation is an observation of the existing lease; it
does not change the worker's retirement or deadline policy.

Durations use the caller's real monotonic clock. `queueMs` measures submission
through receipt of the start acknowledgement, including startup and transport;
`executeMs` measures receipt of that acknowledgement through the observation.
These timings include transport and caller event-loop scheduling. For a job that never
left the queue, terminal `queueMs` is its observed wait and `executeMs` is
`unknown`. After dispatch without a start acknowledgement, both components
remain `unknown`. A start acknowledgement proves execution began; losing it
cannot prove execution did not begin. `elapsedMs` remains available in every
case. Wall-clock `queuedAt` supports journal lookup without driving a deadline.

One terminal summary per submission goes to the existing asynchronous loop log
sink with prefix `[privacy-worker]`. Its two-entry backlog drops excess lines
and reports drops through diagnostics. Journal retention remains the host's
existing policy. Phase history is bounded independently of journal delivery.
The summary contains only generated UUIDs, hashed owner coordinates, static
phases/failures, timestamps and durations. It includes no request body, rule,
memory text, error message, account identity or filesystem path.

## Contract inventory and verification

The caller context covers initial stage composition, cached prompt preparation,
revision retries, final pre-dispatch filtering and runtime-switch composition.
The shared worker also accepts task-export pages, report/issue scrubbing and
curation operations without a pipeline owner; these report owner `unknown`.
The affirmative empty-store filter shortcut creates no worker job.

Every production reply branch echoes correlation: privacy results, page-builder
results, curation acknowledgements/refusals and classified errors. Malformed or
foreign supplied tokens fail closed in the parent; arbitrary worker text never
becomes a diagnostic field. The existing store revision check remains after
envelope validation.

Focused tests exercise the Viewer-side caller and its leased task-page worker
subprocess. Serving runtime-host health and live worker readiness remain unverified. The regression passes real production worker inputs through
the parent reader, covers queued and started timeouts using real timers, lease
cancellation, hostile tokens, legacy unknown timing, queue refusal and process
restart retention. Pipeline coverage runs real stage preparation with an
isolated fixture dispatch adapter. The original 180-second real-clock worker
deadline supervisor remains part of the focused checks.
