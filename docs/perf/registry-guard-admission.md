# Registry admission and unchanged credit-guard ticks

The coordinated pipeline parent, retry-claim, reseat, cancellation and termination paths now wait through the existing asynchronous registry admission helper. Keyed reads share the admitted transaction. Cancellation retains its original revision fence and rechecks custody before releasing a switch hold. Termination awaits its durable capture before any effect and awaits withdrawal after a refusal.

The watchdog checks local registry and obligation revisions plus its host-registration token before accessing storage. A quiescent tick performs no SQLite queries or obligation-file work. Changed inputs advance at most 64 pending directory entries in the recovery sweep. Native directory cursors avoid listing every pending name on each page. Cleanup before stopping reads only that conversation's pending cuts, in pages, with a runtime yield after each durable discharge. A keyed cut index preserves replay across observations of the same cut. Existing obligation JSON and terminal witnesses remain authoritative. A 30-second fallback discovers external changes; unsuccessful passes remain dirty. The cursor expires after 30 seconds of inactivity.

Guard storage runs under `account-credit-guard.store`, with the `account-credit-guard.obligations` wait origin. File transactions report synchronous and asynchronous admission waits of at least 50 ms. The pending-index marker upgrades to version 2; an existing version 1 pending index supplies its backfill without reading settled history.

Full requirement A remains incomplete. Confirmed synchronous paths outside the coordinated pipeline hunks include `src/lib/accounts/liveLimits.ts:recordLiveObservation`, `src/lib/agent/spawnParent.ts:conversationForTranscript`, `src/lib/runtime/registry.ts:bindStructuredHostPersistence` and `src/lib/runtime/structuredSpawn.ts:releaseAdoptionClaim`. Host persistence also crosses the boolean termination-capture contract in `src/lib/runtime/claudeStreamBrokerHost.ts`. Their result and callback contracts require a broader caller migration. The separate control below demonstrates the remaining stall.

The comparison uses the production `defaultPipelinePorts().claimSpawnRetry` call and the actual guard. Each fresh fixture contains four failed structured-launch receipts and 128 unresolved guard obligations whose conversations are absent. Identities and timestamps are fixed during fixture creation and restored before measurement. All six samples have the same registry-fixture SHA-256. Three warm-up guard calls drain initialization; the measured interval then makes four retry claims while a peer holds the SQLite writer for 200 ms each, followed by four unchanged guard ticks separated by one second.

The baseline is `05f90f84db4ec8e60736491d8e3df3dc5e1f47e2`. Runs alternate baseline and candidate three times. Each cell below shows baseline → candidate. The candidate source fingerprint, fixture fingerprint and raw samples are in [the evidence record](../../evidence/perf/registry-guard-admission.json).

| Pair | Main CPU ms | Core % | Max timer delay ms | Max synchronous registry slice ms | Guard reads | Sync waits | Async waits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 70 → 90 | 1.45 → 1.86 | 203.06 → 3.83 | 203.41 → 3.14 | 272 → 0 | 4 → 0 | 0 → 4 |
| 2 | 70 → 70 | 1.45 → 1.45 | 198.29 → 3.43 | 203.11 → 3.14 | 272 → 0 | 4 → 0 | 0 → 4 |
| 3 | 70 → 50 | 1.45 → 1.03 | 200.81 → 2.45 | 204.28 → 1.97 | 272 → 0 | 4 → 0 | 0 → 4 |

Both variants averaged 70 ms of main-thread CPU on this load. Main-thread CPU is Linux thread `utime + stime`, sampled at a 10 ms resolution. Timer delay uses a 5 ms interval. The synchronous-slice column times the registry method invocation inside the production port; individual guard file-read slices and whole guard-call durations are recorded separately. These samples cover this isolated load. Production CPU and a release observation window were not measured.

With `MEASURE_UNMIGRATED=1`, the same driver adds a fifth contended write through `recordLiveObservation`. That caller still takes 202.14 ms synchronously on the baseline and 202.77 ms on the candidate; its 5 ms timer has not advanced when the call returns in either variant. The candidate records four asynchronous retry admissions and one synchronous quota-observation wait. The broader caller migration remains required for A.

To reproduce, export each source revision with frozen dependencies, copy the same measurement driver into both exports, and give every invocation a fresh sandbox. Use the gate wrapper from `fe18cb41d73481f6b4e4bd105b708cb03e2d3b05`. `MEASURE_ASYNC` labels the variant; the checked-out production port determines its admission behavior. Run baseline, candidate, baseline, candidate, baseline, candidate.

```sh
sample_root=$(mktemp -d "${TMPDIR:?}/registry-guard.XXXXXX")
mkdir -p "$sample_root/home" "$sample_root/config" "$sample_root/tmp" "$sample_root/state"
env -u LLV_STATE_OWNER HOME="$sample_root/home" XDG_CONFIG_HOME="$sample_root/config" \
  TMPDIR="$sample_root/tmp" LLV_STATE_DIR="$sample_root/state" NODE_ENV=test \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 MEASURE_ASYNC=1 \
  bash "$GATE_WRAPPER" bun scripts/measure-registry-guard.ts
```

Validation ran 13 explicit test paths in separate isolated processes: 1,045 passing cases and three failures reproduced on main at `14e3199375a2ca4d1a3646eef52fc231794c7915`. The existing failures are the two managed-admission terminal-status cases in `engine.ports.test.ts` and the `early-switch-off` successor case in `engine.creation.test.ts`. The new coverage exercises real contended admission, replay, rollback, failed capture, custody changes after awaits, process restart, cursor progress, 130 older cuts before a stop, submitted receipts and an idle watchdog's zero store work. The controller lane's 35 tests also pass after merging main. TypeScript and changed-source ESLint pass, with nine existing warnings. The local privacy gate passes for the source, evidence and draft PR text.

The isolated runtime-host rehearsal under Bun 1.4.0 completed succession in 505 ms. The stable listener and runtime socket each answered 27/27 requests over 15 seconds, including abandoned clients. No runtime-host source changed.
