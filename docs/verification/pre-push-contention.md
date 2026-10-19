# Pre-push checks under CPU contention

Investigation date: 2026-10-19 UTC. Baseline: `1c12c8cddf8b5eed60d0e39d57945516f202c42f`.

## Causes and changes

- Startup fixtures use durable rows and yield between phases. The historical
  fixture seeds 65 rows; its five-second deadline expired repeatedly. Under
  stronger contention an earlier production-shaped fixture also hit that
  default deadline and its unfinished pass retired a later caller's controller,
  reproducing `StructuredDeliveryControllerUnavailableError`. The suite now
  has a sixty-second supervising deadline and explicit historical-fixture
  cleanup. The two continuation
  concurrency tests await admission and delivery handshakes and finish their
  startup caller before retiring its controller.
- The gate's preparation-cleanup test also received an intermittent verdict
  during the focused comparison. Its elapsed-time assertion was replaced with
  a held helper, explicit PID readiness and proof that cancellation ended the
  helper before its release. A supervising watchdog only bounds failed cleanup.
- The severed-seat fixture now publishes readiness after the registry and
  terminal event are durable. Its request/readiness deadlines supervise actual
  completion rather than deciding when an assertion runs.
- The native verifier dropped CPU placement, slot and wait-ledger variables
  when constructing its child environment. Nested test services could escape
  the admitted work slice. Those fields now survive. Every directly verified
  file also receives independent home, configuration, state and temporary roots.
- The recorded Viewer build refusal named another active Next build. Each
  publication now builds current source in its own tree and runs the build's
  consumers there. It preserves dependencies without sharing generated output.
  Production page-data workers are capped at two; baseline Next selected 23
  workers despite the gate's three-CPU quota. The existing 6 GiB Node heap
  default and 8 GiB gate-service memory cap remain in force.
- A new between-tests diagnostic receives one full-file retry in fresh state.
  Recovery is reported as `FLAKY`. A repeated diagnostic, a different retry
  failure is retained. Incomplete reports and ownership failures receive no
  diagnostic retry and retain their existing comparison rules. Shared
  native contracts use this comparator during local publication; hosted checks
  keep their absolute verdict. Assertion confirmation retains its existing
  three rounds per side. A complete comparison that still contains only new
  between-tests diagnostics alongside flakiness authorizes one fresh phase
  retry before the lane parks. Assertions, runners, incomplete comparisons and
  failed cleanup veto it; a retry without a verdict retains the first refusal.

The execution consumers of `Prepared.root` are the single-step and grouped
paths in `scripts/local-gate.ts`; other preparations retain the original root.
The private build tree belongs to the build, MCP size check, Viewer/runtime-host
rehearsals and negative controls. `LLV_GATE_COMPARE_BASE` is produced only for
the shared native selection and consumed by its verifier. Engine fixture
selection and hosted defaults remain explicit.

## Procedure

All commands ran in scratch clones, through the stage-provided `gate-slot.sh`.
Every test/build invocation had private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and
`LLV_STATE_DIR`, with `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`.
Dependencies were installed with `bun install --frozen-lockfile --ignore-scripts`.

The measured commands were:

```sh
bash "$GATE_SLOT" bun test ./src/lib/runtime/codexAppServerHost.test.ts
bash "$GATE_SLOT" bun test ./src/lib/runtime/startup.test.ts
bash "$GATE_SLOT" bun run build
```

Each was repeated twice without synthetic work and twice with six owned Python
processes continuously calculating `sum(i*i for i in range(10000))`. Cleanup
terminated and joined those exact process handles. The stronger experiment
placed the supervisor, burners and nested runners in one newly owned work
slice with a 300% aggregate CPU quota. In the resumed and final runs each command retained its service memory
cap and a finite deadline: five minutes per test file and fifteen per build.
The initial batch reached its fifteen-minute aggregate supervisor deadline
during a build; that interrupted measurement was excluded and resumed with
individual command deadlines.

The lock control acquires Next's native `.next/lock`, waits for the holder's
readiness message, and invokes the real build. The private build tree is then
built while the source checkout's lock remains held. No existing lock is
removed and no other build is stopped.

## Results

Durations below are seconds for individual runs. Build caches warm between
runs; these measurements diagnose completion and failure identities and do not
establish a speedup. Bun was 1.4.0, Next 16.3.8, and Node 22.16.0.

| Source and command | No burners, two runs | Six burners, two runs |
| --- | --- | --- |
| Baseline Codex file | pass: 21.83 / 22.64 | pass: 17.81† / 42.19 |
| Baseline startup file | 5 failures: 48.55 / 59.11 | 4 failures: 44.69† / 94.32 |
| Baseline Viewer build | pass: 376.05 / 174.31 | pass: 416.01 / 326.62 |
| Fixed Codex file | pass: 11.96 / 26.45 | pass: 50.95 / 35.93 |
| Final startup file | 3 baseline failures: 46.86 / 45.82 | 3 baseline failures: 114.99 / 113.32 |
| Fixed private Viewer build | pass: 436.27 / 128.20 | pass: 273.26 / 255.88 |

† The initial file samples used the common work slice with per-service CPU
limits. Resumed baseline commands and every fixed-source sample used the
private aggregate three-CPU cap. The interrupted aggregate batch was reaped;
all ten recorded process identities were subsequently absent or exited.

The historical-row test expired at approximately five seconds on every
baseline run. It completed after its deadline was corrected, including a
6.82-second unloaded observation. One intermediate stressed run exposed the
earlier fixture's remaining default deadline, which prompted the suite-wide
supervising bound. All four final startup samples completed the affected
fixtures and continuation handshakes without a controller or between-tests
error. Three unrelated
startup assertions failed consistently on both sources:

- terminalizing a delivered Claude spawn with an unverifiable rebooted claim;
- settling a delivered pipeline retry and its rebooted predecessor;
- reconciling pending spawns after deferred pipeline evidence moves (#1501).

The reported severed-seat failure was not reproduced in these solo-file load
runs: all 233 Codex cases passed on both sources. Its readiness guarantee is
now checked against persisted state. No port collision or OOM kill was observed;
the experiment slice recorded zero `oom` and `oom_kill` events. Memory-limit
reclaim events did occur, so the result does not claim absence of memory pressure.

The real Next lock control refused the source-tree build with exit 1 in 1.42
seconds and named the existing build lock. All four private builds above
passed while that source lock stayed held. Their output named two page-data
workers; the baseline output named 23.

The private build's Viewer rehearsal passed (8.17 s), MCP size tests passed
(17.73 s), the two-generation runtime-host rehearsal passed (17.16 s), and
all three executable negative controls passed (60.74 s).

The new diagnostic-retry CLI cases failed on the baseline because no second
sample ran. The phase-retry regressions produced four passes and three failures
against the prior hook, then passed with the fix. They restart real hook
processes and cover recovery, a repeated refusal, assertion/runner/cleanup
vetoes, incomplete comparison output and cancellation during the retry.

The focused gate comparison reported zero new failures, one pre-existing
comparison-fixture failure, and one intermittent preparation-cleanup test.
After replacing that test's elapsed-time assertion, both deadline variants
passed twice without burners and twice with twelve burners under the private
CPU cap. Full typecheck passed. The stage report records the post-commit
pre-push result, including any baseline-only verdicts.

The exercised implementation and test inputs have this SHA-256 manifest digest:
`10a41624054c8dd54d3bf50bdd74f363f41a861d15f318e02cdb931efe5c7934`.
Recompute it from repository-relative paths:

```sh
sha256sum next.config.ts next.config.test.ts \
  scripts/local-gate-tests.ts scripts/local-gate-tests.test.ts \
  scripts/local-gate.ts scripts/local-gate.test.ts \
  scripts/verify-native-codex-runtime.ts src/lib/runtime/startup.test.ts \
  src/lib/runtime/codexAppServerHost.test.ts \
  src/lib/runtime/fixtures/seatSuccessorHost.ts | sha256sum
```
