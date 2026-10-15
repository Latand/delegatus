# Bounded controller work: baseline scope evidence, 2026-10-15

The pinned task's stop condition was reached during the baseline investigation. Items 4–6 can reduce synchronous
controller work, but an awaited stage Git operation can exceed the 15-second
phase deadline by itself. Including item 3 (separating stage Git/publication
jobs from tick completion) is required for the specified phase-duration bound
when an external operation takes longer than that deadline.

The operator subsequently authorized item 3 alongside items 4–6. Items 1–2
remain outside the implementation. The implementation and paired measurements
are recorded in [bounded controller work](pipelines-controller-bounded-work.md).

## Replay evidence

The baseline is `011a4fe97ff9fe2abae1c7a0c217c888a34ea07b`, with Bun 1.4.0,
dependencies installed from its frozen lockfile, and the supplied gate from
release `4b40ba59c993`. The unchanged E4/E5 reference checksums match
[`pipelines-controller-pass.md`](pipelines-controller-pass.md). Each process
uses fresh writable database copies, explicit private HOME, XDG_CONFIG_HOME,
TMPDIR and LLV_STATE_DIR, and a closed-port control URL. The saved replay's
guards refuse network, process actuation and filesystem writes outside the
private run directory. Successful runs recorded no guarded action or exception.

The first diagnostic uses the saved replay with its 10-second delayed
`git branch --show-current` response. The second uses the same engine and
external responses, extends this delay to 20 seconds, and observes the actual
`FlowPipelineController` with its default 15-second phase deadline. Only the
unrelated post-cycle hourly archive sweep is disabled on that private instance;
scan returns incomplete and forge/spawn sweeps are inert. Each cycle permits
one pass so its boundary is directly observable. A second poll probes the
existing pending operation before the harness awaits final settlement.

These are two baseline diagnostics with different imposed waits. They provide
no candidate performance comparison. Both first passes include cold
initialization; the subsequent passes observe mutated state and are not claimed
to represent steady state. Numeric observations, reference/source hashes,
controller heartbeats and limitations are in
[`pipelines-controller-bounds.json`](../../evidence/perf/pipelines-controller-bounds.json).

| Measurement | Baseline, 10-second wait | Controller boundary, 20-second wait |
| --- | ---: | ---: |
| First engine pass wall time | 11,685.93 ms | 21,793.39 ms |
| Observed external wait | 10,000.31 ms | 20,000.33 ms |
| Whole-pass main-thread CPU | 2,550 ms | 3,370 ms |
| Main-thread CPU during external wait | 880 ms | 1,630 ms |
| Maximum wait timer delay | 8.73 ms | 8.14 ms |
| Maximum whole-pass timer delay, including cold work | 547.71 ms | 603.20 ms |
| Largest existing labelled synchronous span, cold registry | 484.13 ms | 486.70 ms |
| Pipeline rows decoded | 614 | 849 |
| Decoded serialized source bytes | 75,757,641 | 101,235,651 |
| Pipeline rows cloned | 858 | 1,093 |
| Cloned serialized source bytes | 110,688,596 | 136,166,606 |
| Hosts selections / rows | 4 / 48 | 4 / 48 |
| Final returned whole-hot snapshot | 267 rows / 83.80 ms | 267 rows / 118.38 ms |
| Next two engine passes | 256.84 / 326.35 ms | 243.16 / 289.95 ms |

CPU uses main-thread utime+stime at 100 ticks/second. Clone bytes count known
serialized source bytes associated with instrumented decoded objects; they do
not measure allocations. Logical read bytes in the JSON include cached syscall
reads. Existing labels leave some synchronous copying and preparation uncovered.
The timer records scheduling delay separately from labelled synchronous spans.
CPU and timer observations include a 20 ms timer drain after the pass wall
clock stops. Port construction precedes that wall clock (183.73 / 208.08 ms
in the first passes); the instrumentation also observes that preparation.

At the real boundary, the controller returned after 15,004.71 ms with
`pipelines: timed-out` and the engine promise still pending. Another watchdog
poll immediately reported `pipelines: blocked`. The engine was invoked once
and finished after 21,793.39 ms. The imposed external wait alone exceeds the
phase budget by 5 seconds. Removing every synchronous controller cost would
still leave that lower bound while the operation remains awaited.

The longer probe remains within the ordinary executor's default 60-second
timeout (`src/lib/workflows/provision.ts:69`). Stage commit hooks can run for
15 minutes (`src/lib/pipelines/git.ts:47`). The engine awaits stage settlement
at `src/lib/pipelines/engine.ts:10346`; the controller's deadline races its
promise and keeps its active-phase ownership until settlement
(`src/lib/pipelines/controller.ts:310`). Returning while that work remains
pending crosses the item-3 fence.

All 941 resulting hot/archive authoritative records agree between the two
diagnostics. Both immutable reference checksums were rechecked afterward.
This establishes the scope conflict on the guarded replay, including actual
timeout and reentry behavior. It does not attribute a historical production
stall to a particular Git command or measure a production improvement.

## Work stopped at the scope fence

No product source was changed. No candidate, alternating before/after pairs,
history-growth acceptance test, full scenario matrix, implementation PR or
deployment is claimed. At that point those steps depended on the scope decision. The pinned
specification remains unchanged.

Focused baseline verification and the local privacy result are recorded in the
numeric evidence file. No runtime-host code changed.
