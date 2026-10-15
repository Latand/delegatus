# Registry admission and unchanged credit-guard ticks

The coordinated pipeline parent, retry-claim, reseat, cancellation and termination paths now wait through the existing asynchronous registry admission helper. Keyed reads share the admitted transaction. Cancellation retains its original revision fence and rechecks custody before releasing a switch hold. Termination awaits its durable capture before any effect and awaits withdrawal after a refusal.

Both already-exited termination branches await durable retirement. A refused retirement returns 409, a rejected write reaches the caller with its original error, and success follows the durable write with or without retained descendants.

The watchdog checks local registry and obligation revisions plus its host-registration token before accessing storage. A quiescent tick performs no SQLite queries or obligation-file work. Changed inputs advance at most 64 pending directory entries in the recovery sweep. Native directory cursors avoid listing every pending name on each page. Each page retains its bounded names until reconciliation succeeds; retries reload durable states before advancing, so partial effects remain idempotent. Cleanup before stopping reads only that conversation's pending cuts, in pages, with a runtime yield after each durable discharge. A keyed cut index preserves replay across observations of the same cut. Existing obligation JSON and terminal witnesses remain authoritative. A 30-second fallback discovers external changes; unsuccessful passes remain dirty. The cursor expires after 30 seconds of inactivity.

Recovery rechecks the selected generation and migration/reconfigure owner inside admitted registry callbacks and the resume authority guard. An operator selection acquired during an admission wait retains custody. The stop-ordering test records observations before a refused stop and asserts them after the rejection, including the exact termination failure and independent event-loop progress.

Guard storage runs under `account-credit-guard.store`, with the `account-credit-guard.obligations` wait origin. File transactions report synchronous and asynchronous admission waits of at least 50 ms. The pending-index marker upgrades to version 2; an existing version 1 pending index supplies its backfill without reading settled history.

Full requirement A remains incomplete. Confirmed synchronous paths outside the coordinated pipeline hunks include `src/lib/accounts/liveLimits.ts:recordLiveObservation`, `src/lib/agent/spawnParent.ts:conversationForTranscript`, `src/lib/runtime/registry.ts:bindStructuredHostPersistence` and `src/lib/runtime/structuredSpawn.ts:releaseAdoptionClaim`. Host persistence also crosses the boolean termination-capture contract in `src/lib/runtime/claudeStreamBrokerHost.ts`. Their result and callback contracts require a broader caller migration. The separate control below demonstrates the remaining stall.

The comparison uses the production `defaultPipelinePorts().claimSpawnRetry` call and the actual guard. Each fresh fixture contains four failed structured-launch receipts and 128 unresolved guard obligations whose conversations are absent. Identities and timestamps are fixed during fixture creation and restored before measurement. All six samples have the same registry-fixture SHA-256. Three warm-up guard calls drain initialization; the measured interval then makes four retry claims while a peer holds the SQLite writer for 200 ms each, followed by four unchanged guard ticks separated by one second.

The baseline is `05f90f84db4ec8e60736491d8e3df3dc5e1f47e2`. Runs alternate baseline and candidate three times. Each cell below shows baseline → candidate. The candidate source fingerprint, fixture fingerprint and raw samples are in [the evidence record](../../evidence/perf/registry-guard-admission.json).

| Pair | Main CPU ms | Core % | Max timer delay ms | Max synchronous registry slice ms | Guard reads | Sync waits | Async waits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 40 → 60 | 0.83 → 1.24 | 198.83 → 2.57 | 203.45 → 2.69 | 272 → 0 | 4 → 0 | 0 → 4 |
| 2 | 60 → 50 | 1.24 → 1.04 | 198.33 → 2.36 | 203.06 → 1.68 | 272 → 0 | 4 → 0 | 0 → 4 |
| 3 | 60 → 60 | 1.24 → 1.24 | 198.77 → 2.00 | 203.66 → 2.12 | 272 → 0 | 4 → 0 | 0 → 4 |

The baseline averaged 53.3 ms and the candidate averaged 56.7 ms of main-thread CPU on this load. These runs show no CPU reduction. Main-thread CPU is Linux thread `utime + stime`, sampled at a 10 ms resolution. Timer delay uses a 5 ms interval. The synchronous-slice column times the registry method invocation inside the production port; individual guard file-read slices and whole guard-call durations are recorded separately. These samples cover this isolated load. Production CPU and a release observation window were not measured.

With `MEASURE_UNMIGRATED=1`, the same driver adds a fifth contended write through `recordLiveObservation`. That caller still takes 201.89 ms synchronously on the baseline and 202.44 ms on the candidate; its 5 ms timer has not advanced when the call returns in either variant. The candidate records four asynchronous retry admissions and one synchronous quota-observation wait. The broader caller migration remains required for A.

To reproduce, export each source revision with frozen dependencies, copy the same measurement driver into both exports, and give every invocation a fresh sandbox. Use the gate wrapper from `fe18cb41d73481f6b4e4bd105b708cb03e2d3b05`. `MEASURE_ASYNC` labels the variant; the checked-out production port determines its admission behavior. Run baseline, candidate, baseline, candidate, baseline, candidate.

```sh
sample_root=$(mktemp -d "${TMPDIR:?}/registry-guard.XXXXXX")
mkdir -p "$sample_root/home" "$sample_root/config" "$sample_root/tmp" "$sample_root/state"
env -u LLV_STATE_OWNER HOME="$sample_root/home" XDG_CONFIG_HOME="$sample_root/config" \
  TMPDIR="$sample_root/tmp" LLV_STATE_DIR="$sample_root/state" NODE_ENV=test \
  LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1 MEASURE_ASYNC=1 \
  bash "$GATE_WRAPPER" bun scripts/measure-registry-guard.ts
```

Initial implementation validation ran 13 explicit test paths in separate isolated processes: 1,045 passing cases and three failures reproduced on main at `14e3199375a2ca4d1a3646eef52fc231794c7915`. The existing failures are the two managed-admission terminal-status cases in `engine.ports.test.ts` and the `early-switch-off` successor case in `engine.creation.test.ts`. The new coverage exercises real contended admission, replay, rollback, failed capture, custody changes after awaits, process restart, cursor progress, 130 older cuts before a stop, submitted receipts and an idle watchdog's zero store work. The controller lane's 35 tests also pass after merging main. TypeScript and changed-source ESLint pass, with nine existing warnings. The local privacy gate passes for the source, evidence and draft PR text.

The isolated runtime-host rehearsal under Bun 1.4.0 completed succession in 505 ms. The stable listener and runtime socket each answered 27/27 requests over 15 seconds, including abandoned clients. No runtime-host source changed.

Fix-round validation ran 120 passing tests across five explicit paths: the guard, its tick policy, the obligation store, structured recovery and account reseating. On the reviewed source, the 12 custody-race cases and both next-tick retry cases fail. Separate corruptions of the stop test's ordering, submitted receipt and loop-progress observations each produce a failing test. All runs used the specified gate wrapper and separate HOME, config, temp and state roots. TypeScript passes. The measurements above were rerun after the fixes on the same frozen fixture.

In the previous fix round, the broad pre-push sample hit its 300-second file limit in engine.providerBudget.test.ts and engine.publication.test.ts. Baseline comparison reproduced the three existing assertion failures. Isolated reruns of the candidate passed all 164 provider-budget tests in 324.43 seconds and all 432 publication tests in 236.40 seconds. The stopped Linux checks were run separately: backend verification and 194 tests across 17 explicit paths passed. Publication uses the documented LLV_SKIP_HOOKS=1 timeout escape after these reruns; types, lint and privacy passed. That round kept its measured source fingerprint.

Retirement-fix validation ran 163 passing tests across six explicit paths in separate isolated processes. Ten new already-exited cases fail on the reviewed source before the two awaits. Coverage holds real SQLite writer admission, verifies independent timer progress, returns 409 for durable refusal, preserves the exact rejection error, and reopens the registry to check committed success with and without retained descendants. TypeScript and affected-file ESLint pass with zero warnings. Three fresh alternating measurement pairs and the quota control use the same frozen fixture and the final source fingerprint.
