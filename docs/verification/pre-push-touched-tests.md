# Touched-test comparison execution budget

## Rule

The comparator spends confirmation rounds on unresolved assertion occurrences.
A complete passing head retry or failing base retry already establishes
`FLAKY` under the existing verdict rule. That occurrence leaves subsequent
selections. Its evidence counts stop at classification. A stable head-only assertion
failure still receives three rounds per side and refuses publication.

Both sides of each confirmation round run concurrently in separate sandboxes,
with at most three files per side. Both settle before the round returns,
including when one rejects. An occurrence retires after a complete paired round.
Missing assertions, unexpected runner diagnostics, incomplete baseline evidence
and failed ownership cleanup retain their refusal paths. Same-name occurrences
remain separate; Bun's name filter can execute a retired occurrence alongside
an unresolved occurrence with the same name. No result survives a comparator
process, and no baseline result is cached.

The consumers are the pre-push touched and Linux selections in
`scripts/local-gate.ts`, direct review comparisons, and local shared native
contracts in `scripts/verify-native-codex-runtime.ts`. All use
`scripts/local-gate-tests.ts`. The initial head sample uses eight file workers.
Baseline and confirmation samples retain three workers per side. Full-file
diagnostics and filtered assertions share one baseline pool. The file/run
limits and shared five-minute confirmation budget are retained. Pipeline
engine and publication changes use the scoped publication deadline described
in the follow-up below.

## Measurement procedure

Export the immutable lane source into scratch clones without updating its
branch. Preserve the publication remote in each clone. Compute its merge base
against the captured main revision. Run the comparator from the captured gate
revision, first unchanged and then with the candidate implementation; retain
the same lane code, selected paths and dependency graph on both sides.

Borrow dependencies only when the manifest, Bun lockfile and declared patch
inputs match byte for byte. Otherwise install with
`bun install --frozen-lockfile --ignore-scripts` through the gate wrapper.
Every invocation has private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and
`LLV_STATE_DIR`, plus `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`.

```sh
bash "$GATE_SLOT" bun scripts/local-gate-tests.ts --base "$BASE" \
  <explicit test paths from the captured pre-push plan>
```

Record wall time before entering the wrapper and execution start inside its
owned service. Sample machine load every five seconds. The difference to
execution start is admission; the gate's CPU-wait ledger reports any nested
admission separately. Record each file's wall duration, baseline setup, base
and head runs, confirmation rounds and terminal verdict. The unchanged gate
can be observed with equivalent timing-only logging in its scratch copy.

For a loaded observation, an admitted supervisor starts six Python processes executing
`while True: sum(i*i for i in range(10000))`, runs the same comparator, then
terminates and joins those exact child handles.
The wrapper retains its default CPU containment and finite execution deadline;
nested test services retain their own containment. Repeat the same burner
count for the candidate. These observations measure completion under recorded
machine conditions; changing ambient load limits speed comparisons.

## Results from #3106

All times are seconds. Load is the sampled one-minute minimum/median/maximum on
24 online CPUs. A service retains its three-CPU quota; the work slice retains
its eighteen-CPU aggregate quota. Six burners share the admitted supervisor’s
three-CPU service, while test files retain their separate services.

| ID | Test selection | Gate | Burners | Load min/median/max | Credited wait | Execution | Verdict: new/existing/flaky |
| --- | --- | --- | ---: | --- | ---: | ---: | --- |
| A | provider + privacy (9) | baseline | 0 | 10.2/17.9/33.2 | — | — | incomplete; blocked |
| B | provider + privacy (9) | baseline | 0 | 10.3/13.0/15.0 | 0.0 | 336.1 | pass 0/2/0 |
| C | provider + privacy (9) | confirmation-only | 0 | 8.7/12.4/17.4 | 0.0 | 441.7 | pass 0/3/4 |
| D | provider + privacy (9) | confirmation-only | 6 | 12.8/21.3/37.3 | 0.0 | 519.6 | pass 0/6/92 |
| E | retirement lane (55) | baseline | 6 | 8.8/17.3/30.0 | 44.0 | 621.6 | pass 0/14/0 |
| F | retirement lane (55) | confirmation-only | 6 | 10.9/23.9/35.2 | 43.6 | 900.0 | incomplete; blocked |
| G | provider + privacy (9) | candidate | 6 | 10.0/14.2/17.9 | 0.0 | 281.4 | pass 0/0/2 |
| H | retirement lane (55) | candidate | 6 | 7.6/17.8/29.1 | 45.3 | 734.1 | pass 0/20/34 |
| I | provider + privacy (9) | candidate | 6 | 12.1/15.4/17.9 | 0.0 | 275.7 | pass 0/0/1 |

A is the initial higher-load reproduction. Its nested-wait counter was not
retained; the fully instrumented repeat B recorded zero nested admission.
A exhausted the shared five-minute confirmation budget after its first head
retry had already recovered every selected assertion. Its third base round
ended without a comparison verdict. B needed no confirmation rounds.

Execution is wall time after admission/handoff, minus credited nested waits.
Credited waits include the integration fixtures’ private admission queues.
Ambient load and failure sets changed between observations. The assessment
uses observed confirmation work and deterministic counter tests. Whole-run
speed ratios require matching ambient conditions.

| ID | Admission/handoff | Head wall | Base setup/install | Base run wall | Confirmation wall | Other | Total wall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 0.3 | 493.1 | 0.7/0.0 | 89.3 | 300.4 | 0.1 | 883.9 |
| B | 2.3 | 323.7 | 0.7/0.0 | 11.5 | 0.0 | 0.2 | 338.4 |
| C | 0.2 | 378.6 | 0.7/0.0 | 35.6 | 26.6 | 0.2 | 441.9 |
| D | 0.2 | 355.9 | 1.8/0.0 | 81.0 | 80.5 | 0.4 | 519.8 |
| E | 0.3 | 658.3 | 2.5/0.0 | 4.4 | 0.0 | 0.4 | 665.9 |
| F | 2.3 | 869.7 | 1.4/0.0 | — | — | 72.5 | 945.9 |
| G | 0.2 | 261.7 | 1.6/0.0 | 9.0 | 8.7 | 0.5 | 281.7 |
| H | 0.2 | 615.0 | 1.9/0.0 | 100.5 | 61.6 | 0.4 | 779.6 |
| I | 2.2 | 264.0 | 1.7/0.0 | 4.4 | 5.1 | 0.6 | 278.0 |

The confirmation-only change in C resolved four flaky occurrences in one paired round
lasting 26.6 seconds. Its loaded nine-file run D took one paired round of
80.5 seconds and resolved 92 flaky occurrences. Stable new failures still
require all three rounds. The 55-file control E completed on the original gate
with fourteen pre-existing failures and no confirmation work. The confirmation-only
change in F exhausted the owned execution deadline during baseline sampling;
its head alone took 869.7 seconds. That result led to four initial head workers.
The final candidate runs are G, H and I. H repeats the full 55-file set with six
burners and reaches a verdict in 733.7 seconds of comparator execution. I repeats
the loaded provider/privacy selection. Each final loaded run finishes within
the 900-second owned deadline.
F’s Other column includes its interrupted baseline interval and teardown.

### Provider-file head durations

These are full-file wall durations. Their concurrent intervals overlap.
Every base and confirmation sample, including the interrupted original retry,
is recorded by repository-relative path in
[the measurement record](../../evidence/perf/pre-push-touched-tests.json).

| File under `src/lib/pipelines/` | A | B | C | D | G | I |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `engine.providerBudget.test.ts` | 30.1 | 23.5 | 20.5 | 28.0 | 29.0 | 24.5 |
| `engine.providerBudgetChains.test.ts` | 158.2 | 126.6 | 121.4 | 77.6 | 146.1 | 138.0 |
| `engine.providerBudgetKinds.test.ts` | 31.4 | 25.0 | 21.3 | 29.9 | 30.9 | 25.5 |
| `engine.providerBudgetOutput.test.ts` | 185.0 | 139.4 | 158.0 | 215.4 | 159.0 | 151.3 |
| `engine.providerBudgetPoolOutput.test.ts` | 186.9 | 139.9 | 155.3 | 224.2 | 147.5 | 146.5 |
| `engine.providerChains.test.ts` | 43.3 | 65.8 | 89.8 | 12.8 | 78.6 | 70.6 |
| `engine.providerReset.test.ts` | 291.6 | 160.7 | 202.0 | 265.5 | 152.2 | 167.9 |
| `engine.providerSignals.test.ts` | 67.2 | 33.2 | 44.3 | 48.1 | 31.3 | 34.0 |
| `engine.rolePrivacy.test.ts` | 31.2 | 14.5 | 16.5 | 19.4 | 13.7 | 15.3 |

### Inputs and verification

The provider/privacy fixture is `446313c75a6054f2dcd32534bcca146e126d9fdc`,
compared with `1f3872d6aec6a596f2c3c9d9dacc9763e95f075f`.
The retirement fixture and its captured base are recorded in the JSON.
The original gate is `c963aa9c76431425b7102cae0106dfcde3791ed4`;
the final candidate implementation is from `0bc3cbd38c66f005faac5e7b53da767ad4e3d0a3`.
Its `scripts/local-gate-tests.ts` SHA-256 is
`0f367b27eb840fc9bd0ea94f5b5a991f64abe215c43d788e86b39b73ea7ae39f`.

The implementation was recommitted with hooks enabled after backing up the
predecessor; the tracked trees were identical. G and the earlier verification
records retain their original measured revisions. H and I use the new commit
and the required wrapper revision `c921b5546542`; recovered runs used wrapper
`7b3d575ccb1e`. The supporting gate and dependency input digests are in the JSON.

A predecessor 55-file candidate observation ended during recovery with an
owned-process cleanup refusal and no complete metadata. It is recorded
separately and supplies no passing evidence.

The initial baseline graphs match their heads, so all reported runs share
matching dependencies and perform zero baseline installs. Timings include
fresh isolated test processes and state roots, with no baseline-result cache.

The gate suites passed: 56 comparator cases, four CPU-admission cases and
66 hook cases. Four new recovery/overlap controls failed against the original
gate and passed against the candidate. The four-worker rendezvous control
failed against the three-worker change and passed with four workers. The CLI
controls restart comparator
processes, rendezvous across real base/head processes, retain duplicate
occurrences, refuse a stable head-only failure, and reject incomplete samples.
Recovered checks and fresh checks of the new commit both passed, including
full typecheck. The stage report records the final committed pre-push verdict.

## Engine-selection follow-up

An `engine.ts` change selects every sibling `engine.*.test.ts` file. The
following captures retain the six lane heads named by the reopened task. Each
base is the merge base of that head and the captured main revision
`89fb1d290b1395be1901c4cbd52f8530421526d8`. No lane was merged, reset or
edited for these measurements. The full branch names, revisions, changed
paths and selections are retained in the measurement record.

| Lane capture | Selected files | Engine sibling suites | Base |
| --- | ---: | ---: | --- |
| Restarted publication | 29 | 26 | `89fb1d290b13` |
| Attempt adoption | 28 | 26 | `89fb1d290b13` |
| Finished-lane retirement | 35 | 26 | `d216fcffafb3` |
| Flow retirement | 55 | 26 | `e16513f8b2bd` |
| Seat reminders | 35 | 27 | `1d45cbd6841a` |
| Role-memory retry | 63 | 27 | `89fb1d290b13` |

All variants use the same lane export, selection, runtime and dependencies.
The original comparator is from #3106; the candidate changes its initial head
workers from four to eight and combines the two baseline phases into one pool.
Baseline and paired confirmation workers remain three per side. Every file
retains its separate owned process and private state. The full selection still
runs on head; results are never cached.

The planner in `scripts/local-gate.ts` supplies the touched and Linux
selections. Direct review comparisons and the shared native contracts in
`scripts/verify-native-codex-runtime.ts` call the same comparator and receive
the new limit for head files. `scripts/merge-batch.ts` imports its report and
comparison helpers, whose behavior is unchanged. The five-minute file limit,
fifteen-minute run limit, five-minute shared confirmation budget, admission
and admission credit are unchanged. Publication receives the shared budget
from `src/lib/pipelines/gateBudget.ts`.

A head-only six-worker trial still expired during the 63-file lane's baseline.
Its head phase took 587.8 seconds; the full-file baseline diagnostic took
281.1 seconds before any filtered assertion file could start. The original
code awaited the full-file group, then created a separate assertion pool.
The final change chooses each file's filter inside one three-worker pool,
so a slow diagnostic no longer holds every assertion sample behind it. The
regression control makes a full-file sample and a filtered sample rendezvous,
restarts the comparator, and checks that both head-only failures still refuse.

The combined-pool trial at six head workers reached a verdict on the 63-file
lane in 860.4 seconds of execution. The 35-file seat-reminder lane still
expired during confirmation: its head took 661.3 seconds and base 292.8 seconds.
The final candidate uses eight head workers to leave comparison time after
those long head suites. The work slice and each owned runner keep their CPU
quotas, file/run budgets, isolation and cleanup policy.

The eight-worker trial also expired during confirmation. Its head took
511.7 seconds and base 307.5 seconds; a provider-budget base sample alone took
178.8 seconds. The publisher's old 900-second push limit gave its hook only
840 seconds before the pack margin. The direct hook also launched its checks
under a 900-second owned runner. Parallel head files and overlapping baseline
samples alone leave too little time for slow paired evidence.

The final policy reserves 1,500 seconds for a push changing the pipeline
engine source/test family, `git.ts` or `parkedPublication.test.ts`, with 1,440
seconds for its hook. Other changes retain 900 and 840 seconds. The publisher
opts in only for a repository using `scripts/local-gate-tests.ts`, reads its
changed paths against the hook's `origin/main`, and rechecks the accepted head
after those asynchronous reads. An unknown scope receives the finite larger
window. Privacy memory is read after the awaits. The hook derives the same
default from its current changes; an explicit caller deadline takes priority.
No file, baseline/head phase or shared confirmation cap is raised.

### Follow-up measurements

Seconds, rounded to one decimal. Load is one-minute minimum/median/maximum
sampled every five seconds across admission and execution. Follow-up captures
use ambient machine load. R = restarted publication, A = attempt adoption,
T = finished-lane retirement, F = flow retirement, S = seat reminders,
M = role-memory retry. The digit is the initial head-worker count. T marks
the head-only trial, P the combined-pool six-worker trial, and R the extended
budget rehearsal before the policy was wired into the publisher and hook.

The original comparator reached a verdict in all six fresh captures. Those
runs did not reproduce the earlier exit 124. They gave the comparator 900
seconds; the original publisher allowed its hook only 840 seconds. M6T, S6P
and S8T reproduced owned deadlines in baseline or confirmation. All six
final captures use the committed policy's 1,440-second hook window and validate
that value before starting. Every selected head file is retained.

Ambient load and failure sets vary. These are completion observations under
the recorded conditions; they support no speedup ratio.

| ID | Load min/med/max | Head wall | Base wall | Confirmation wall | CPU wait | Execution | Owned cap | Verdict new/existing/flaky |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| R4 | 8.0/15.6/21.2 | 639.1 | 87.9 | 67.6 | 57.3 | 737.3 | 900.0 | refuse 5/11/2 |
| R6T | 5.2/15.6/23.2 | 485.5 | 122.1 | 39.7 | 58.5 | 588.8 | 900.0 | refuse 5/12/43 |
| R8 | 8.1/16.8/21.6 | 367.1 | 33.5 | 41.1 | 55.1 | 386.7 | 1440.0 | refuse 5/6/9 |
| A4 | 10.9/14.1/21.1 | 586.2 | 42.9 | 41.7 | 57.3 | 613.5 | 900.0 | pass 0/8/43 |
| A6T | 8.0/16.5/27.5 | 552.9 | 197.9 | 28.1 | 57.1 | 721.9 | 900.0 | refuse 1/6/38 |
| A8 | 9.4/20.5/38.3 | 482.7 | 180.3 | 96.6 | 54.3 | 705.3 | 1440.0 | refuse 1/6/96 |
| T4 | 4.3/7.8/9.6 | 435.5 | 9.1 | 0.0 | 59.1 | 385.5 | 900.0 | pass 0/11/0 |
| T6T | 8.0/12.5/17.1 | 465.0 | 90.0 | 71.3 | 58.9 | 567.4 | 900.0 | pass 0/16/2 |
| T8 | 10.6/18.9/34.1 | 498.9 | 223.6 | 72.9 | 53.7 | 741.8 | 1440.0 | refuse 1/11/169 |
| F4 | 6.6/9.0/11.2 | 452.0 | 4.4 | 0.0 | 46.0 | 410.4 | 900.0 | pass 0/13/0 |
| F6T | 12.3/17.5/33.5 | 524.6 | 136.3 | 52.1 | 49.1 | 664.0 | 900.0 | pass 0/19/42 |
| F8 | 10.4/19.5/28.1 | 425.1 | 37.5 | 53.7 | 43.6 | 472.7 | 1440.0 | pass 0/13/47 |
| S4 | 6.3/12.5/17.5 | 613.0 | 63.1 | 64.3 | 59.9 | 680.5 | 900.0 | pass 0/5/11 |
| S6T | 14.0/24.5/42.8 | 614.1 | 325.8 | 0.0 | 54.8 | 885.1 | 900.0 | pass 0/46/0 |
| S6P | 15.2/21.3/40.3 | 661.3 | 292.8 | — | — | — | 900.0 | incomplete; exit 124 in confirmation |
| S8T | 8.8/22.0/32.0 | 511.7 | 307.5 | — | — | — | 900.0 | incomplete; exit 124 in confirmation |
| S8R | 10.9/14.2/24.6 | 376.5 | 133.0 | 129.5 | 54.5 | 584.4 | 1440.0 | pass 0/13/109 |
| S8 | 8.7/21.3/47.1 | 560.7 | 315.4 | 134.0 | 61.0 | 949.1 | 1440.0 | refuse 4/6/165 |
| M4 | 6.4/10.2/12.7 | 487.7 | 2.7 | 0.0 | 58.8 | 431.6 | 900.0 | pass 0/14/0 |
| M6T | 12.7/21.2/47.2 | 587.8 | — | — | — | — | 900.0 | incomplete; exit 124 in baseline |
| M6P | 12.2/24.7/36.8 | 646.3 | 249.5 | 17.0 | 52.4 | 860.4 | 900.0 | refuse 1/149/9 |
| M8 | 12.0/17.1/35.0 | 445.8 | 117.9 | 95.1 | 55.0 | 603.8 | 1440.0 | pass 0/24/126 |

Head, base and confirmation are phase wall times. Base includes checkout
preparation. Execution is the comparator's wall time less its credited CPU
admission waits. Initial admission and handoff are separate below. Private
queues exercised by integration fixtures are credited. An incomplete row has
no passing comparison; the JSON retains its last sampled wait credit and
estimated owned execution at exit.

| ID | Admission/handoff | Paired rounds | Completed file reruns base/head | Total wall |
| --- | ---: | ---: | --- | ---: |
| R4 | 0.5 | 3 | 4/4 | 795.2 |
| R6T | 0.5 | 3 | 5/5 | 648.0 |
| R8 | 0.8 | 3 | 4/4 | 442.7 |
| A4 | 0.8 | 1 | 2/2 | 671.7 |
| A6T | 0.5 | 1 | 1/1 | 779.5 |
| A8 | 0.7 | 1 | 2/2 | 760.5 |
| T4 | 0.6 | 0 | 0/0 | 445.4 |
| T6T | 0.5 | 2 | 2/2 | 627.0 |
| T8 | 0.8 | 1 | 5/5 | 796.3 |
| F4 | 0.6 | 0 | 0/0 | 457.1 |
| F6T | 2.6 | 2 | 3/3 | 715.9 |
| F8 | 0.6 | 1 | 4/4 | 517.1 |
| S4 | 0.6 | 1 | 1/1 | 741.1 |
| S6T | 0.7 | 0 | 0/0 | 941.0 |
| S6P | 4.8 | — | 0/0 | 961.0 |
| S8T | 2.7 | — | 2/3 | 956.9 |
| S8R | 0.5 | 1 | 3/3 | 639.6 |
| S8 | 0.8 | 1 | 7/7 | 1011.1 |
| M4 | 2.5 | 0 | 0/0 | 493.1 |
| M6T | 83.3 | — | 0/0 | 1034.7 |
| M6P | 16.6 | 1 | 5/5 | 929.6 |
| M8 | 0.7 | 2 | 6/6 | 659.7 |

Rerun counts are completed owned file invocations, including their individual
durations in the JSON. They do not count individual assertion observations.
A deadline can interrupt a round before its file runners produce results.

The controls restart real comparator and hook processes. Eight isolated head
files rendezvous before the next file is processed; a stable failure in that
next file still receives three paired rounds and refuses. A missing report
also refuses. A separate rendezvous proves full-file and filtered baseline
samples overlap. Both controls fail on the original gate. Real publisher
fixtures verify Git's timeout and the deadline received by its hook, retained
hook refusals, unknown scope, head changes after each metadata read, and
privacy memory damaged during budget lookup. Explicit caller caps remain
authoritative. Standalone checks passed: 60 comparator cases, four CPU-wait
cases, 68 hook cases, 180 Git cases, parked-publication regressions and
typecheck. The stage report records the final committed pre-push result.

### Per-file wall durations

Each head attempts the full file. Base samples select failing assertions, or
the full file for diagnostics. A dash means that no sample was needed. A
dagger marks a file runner without a complete report; its diagnostic remains
in the comparison. A head-only incomplete file refuses. Matching broken
head/base runs retain the existing PRE-EXISTING rule. File intervals overlap.
Rerun columns count base/head file invocations; all retry durations remain
in the JSON.

#### Restarted publication

| Repository-relative test file | Head 4 | Base 4 | Head 8 | Base 8 | Reruns B/H: 4 → 8 |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/lib/pipelines/engine.accountGuard.test.ts` | 7.1 | — | 14.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.activation.test.ts` | 30.5 | 0.8 | 59.4 | 1.0 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.containment.test.ts` | 31.0 | — | 58.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.controllerPass.test.ts` | 42.7 | 0.8 | 55.0 | 0.8 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.controllerSnapshot.test.ts` | 3.1 | — | 5.2 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 86.1 | — | 89.9 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.cpuQueue.test.ts` | 1.2 | — | 2.4 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.creation.test.ts` | 31.0 | 0.5 | 37.6 | 0.5 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.ports.test.ts` | 141.4 | — | 153.8 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudget.test.ts` | 31.9 | — | 34.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetChains.test.ts` | 178.1 | — | 181.2 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetKinds.test.ts` | 29.4 | — | 37.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetOutput.test.ts` | 201.6 | — | 193.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetPoolOutput.test.ts` | 199.2 | — | 192.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerChains.test.ts` | 93.6 | — | 92.9 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerReset.test.ts` | 220.7 | 86.8 | 236.8 | 32.4 | 1/1 → 1/1 |
| `src/lib/pipelines/engine.providerSignals.test.ts` | 41.8 | — | 47.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.provisioning.test.ts` | 39.3 | 1.0 | 50.6 | 1.1 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.publication.test.ts` | 13.7 | — | 15.3 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recovery.test.ts` | 65.4 | — | 91.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recoveryAdmission.test.ts` | 67.2 | — | 88.2 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recoveryAuthority.test.ts` | 107.5 | — | 117.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.routing.test.ts` | 82.0 | 3.7 | 78.2 | 3.4 | 3/3 → 3/3 |
| `src/lib/pipelines/engine.settlement.test.ts` | 77.0 | — | 73.4 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.succession.test.ts` | 194.4 | — | 138.4 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.watchdogRegression.test.ts` | 4.1 | — | 3.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/git.test.ts` | 44.1 | — | 39.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/parkedPublication.test.ts` | 74.9 | — | 62.9 | — | 0/0 → 0/0 |
| `src/lib/viewerLoopMonitor.test.ts` | 0.3 | — | 0.3 | — | 0/0 → 0/0 |

#### Attempt adoption

| Repository-relative test file | Head 4 | Base 4 | Head 8 | Base 8 | Reruns B/H: 4 → 8 |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/lib/pipelines/engine.accountGuard.test.ts` | 9.7 | — | 12.9 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.activation.test.ts` | 40.2 | 0.9 | 66.5 | 1.4 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.containment.test.ts` | 41.2 | — | 65.9 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.controllerPass.test.ts` | 48.1 | 0.8 | 65.2 | 1.3 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.controllerSnapshot.test.ts` | 3.5 | — | 4.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 86.6 | — | 92.1 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.cpuQueue.test.ts` | 1.4 | — | 1.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.creation.test.ts` | 33.4 | 0.7 | 42.0 | 0.8 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.ports.test.ts` | 134.9 | — | 209.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudget.test.ts` | 31.3 | — | 39.1 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetChains.test.ts` | 155.0 | — | 25.0 | 124.6 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.providerBudgetKinds.test.ts` | 28.5 | — | 41.9 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetOutput.test.ts` | 185.5 | — | 276.1 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetPoolOutput.test.ts` | 175.1 | — | 274.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerChains.test.ts` | 28.5 | 41.5 | 120.1 | — | 1/1 → 0/0 |
| `src/lib/pipelines/engine.providerReset.test.ts` | 228.0 | 28.5 | 300.1† | 178.3 | 1/1 → 0/0 |
| `src/lib/pipelines/engine.providerSignals.test.ts` | 44.4 | — | 50.1 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.provisioning.test.ts` | 47.4 | 1.0 | 57.3 | 1.4 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.publication.test.ts` | 15.3 | — | 17.2 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recovery.test.ts` | 81.7 | — | 161.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recoveryAdmission.test.ts` | 74.8 | — | 159.4 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recoveryAuthority.test.ts` | 99.8 | — | 197.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.routing.test.ts` | 66.4 | 1.3 | 133.6 | 1.6 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.settlement.test.ts` | 64.6 | — | 75.6 | 34.3 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.succession.test.ts` | 164.9 | — | 212.0 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.watchdogRegression.test.ts` | 3.8 | — | 5.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/publicationRecovery.test.ts` | 28.4 | — | 44.1 | — | 0/0 → 0/0 |
| `src/lib/pipelines/stageAttemptPush.test.ts` | 37.7 | — | 48.2 | — | 0/0 → 0/0 |

#### Finished-lane retirement

| Repository-relative test file | Head 4 | Base 4 | Head 8 | Base 8 | Reruns B/H: 4 → 8 |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/lib/pipelines/engine.accountGuard.test.ts` | 8.3 | — | 12.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.activation.test.ts` | 31.7 | — | 47.8 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.containment.test.ts` | 31.1 | — | 47.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.controllerPass.test.ts` | 41.1 | 0.6 | 51.1 | 0.9 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.controllerSnapshot.test.ts` | 2.9 | — | 4.1 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 83.6 | — | 91.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.cpuQueue.test.ts` | 0.9 | — | 1.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.creation.test.ts` | 22.4 | 0.5 | 32.3 | 0.7 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.ports.test.ts` | 100.6 | — | 95.6 | 51.3 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.providerBudget.test.ts` | 18.8 | — | 27.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetChains.test.ts` | 113.4 | — | 70.3 | 74.0 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.providerBudgetKinds.test.ts` | 22.7 | — | 32.8 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetOutput.test.ts` | 121.9 | — | 282.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetPoolOutput.test.ts` | 120.5 | — | 289.3 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerChains.test.ts` | 51.6 | — | 32.8 | 45.3 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.providerReset.test.ts` | 143.3 | — | 300.1† | 176.8 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerSignals.test.ts` | 26.7 | — | 82.8 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.provisioning.test.ts` | 28.5 | — | 101.4 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.publication.test.ts` | 10.0 | — | 36.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recovery.test.ts` | 51.7 | — | 155.6 | 2.8 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.recoveryAdmission.test.ts` | 49.3 | — | 154.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recoveryAuthority.test.ts` | 71.9 | — | 188.0 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.routing.test.ts` | 48.6 | 1.2 | 122.7 | 1.6 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.settlement.test.ts` | 46.3 | — | 65.0 | 27.3 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.succession.test.ts` | 130.5 | — | 252.0 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.watchdogRegression.test.ts` | 2.9 | — | 5.0 | — | 0/0 → 0/0 |
| `src/lib/pipelines/hostRetirement.test.ts` | 0.5 | — | 0.9 | — | 0/0 → 0/0 |
| `src/lib/pipelines/stageHostTeardown.test.ts` | 8.3 | 8.0 | 9.2 | 8.1 | 0/0 → 0/0 |
| `src/lib/pipelines/store.reads.test.ts` | 0.7 | — | 1.4 | — | 0/0 → 0/0 |
| `src/lib/pipelines/store.test.ts` | 3.3 | — | 6.8 | — | 0/0 → 0/0 |
| `src/lib/pipelines/terminalReap.test.ts` | 49.1 | — | 75.1 | — | 0/0 → 0/0 |
| `src/lib/state/pipelineControllerIndex.owner.test.ts` | 0.1 | — | 0.2 | — | 0/0 → 0/0 |
| `src/lib/state/sqliteStateStore.bounded.test.ts` | 3.9 | — | 7.1 | — | 0/0 → 0/0 |
| `src/lib/state/sqliteStateStore.lifecycle.test.ts` | 0.6 | — | 1.2 | — | 0/0 → 0/0 |
| `src/lib/state/sqliteStateStore.readCache.test.ts` | 3.0 | — | 6.3 | — | 0/0 → 0/0 |

#### Flow retirement

| Repository-relative test file | Head 4 | Base 4 | Head 8 | Base 8 | Reruns B/H: 4 → 8 |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/app/api/pipelines/[id]/route.lifecycle.test.ts` | 0.6 | — | 0.9 | — | 0/0 → 0/0 |
| `src/app/api/pipelines/[id]/route.test.ts` | 0.4 | 0.3 | 0.6 | 0.3 | 0/0 → 0/0 |
| `src/app/api/pipelines/route.admission.test.ts` | 1.3 | — | 1.9 | — | 0/0 → 0/0 |
| `src/app/api/pipelines/route.busy.test.ts` | 0.9 | 0.8 | 1.3 | 1.0 | 0/0 → 0/0 |
| `src/app/api/pipelines/route.test.ts` | 0.9 | — | 1.1 | — | 0/0 → 0/0 |
| `src/lib/flows/commands.durable.test.ts` | 0.5 | — | 0.6 | — | 0/0 → 0/0 |
| `src/lib/flows/commands.set-roles.test.ts` | 0.5 | — | 0.6 | — | 0/0 → 0/0 |
| `src/lib/flows/commands.test.ts` | 0.4 | — | 0.6 | — | 0/0 → 0/0 |
| `src/lib/flows/decisions.test.ts` | 0.5 | — | 0.6 | — | 0/0 → 0/0 |
| `src/lib/flows/engine.test.ts` | 0.5 | — | 0.8 | — | 0/0 → 0/0 |
| `src/lib/flows/retirement.test.ts` | 2.7 | — | 3.2 | — | 0/0 → 0/0 |
| `src/lib/flows/store.test.ts` | 0.7 | — | 1.0 | 0.4 | 0/0 → 0/0 |
| `src/lib/mcp/bindings.test.ts` | 9.2 | 1.3 | 10.3 | 1.5 | 0/0 → 1/1 |
| `src/lib/mcp/server.test.ts` | 27.7 | — | 32.7 | — | 0/0 → 0/0 |
| `src/lib/monitor/evidence.test.ts` | 0.1 | — | 0.2 | — | 0/0 → 0/0 |
| `src/lib/pipelines/controller.test.ts` | 1.6 | — | 2.0 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.accountGuard.test.ts` | 8.7 | — | 11.1 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.activation.test.ts` | 20.8 | 0.7 | 28.8 | 1.0 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.containment.test.ts` | 29.6 | — | 43.8 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.controllerPass.test.ts` | 41.3 | 0.6 | 48.6 | 0.7 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.controllerSnapshot.test.ts` | 2.7 | — | 3.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 67.7 | — | 71.0 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.cpuQueue.test.ts` | 0.8 | — | 1.3 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.creation.test.ts` | 23.5 | 0.6 | 29.4 | 0.5 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.ports.test.ts` | 98.2 | — | 160.4 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudget.test.ts` | 18.1 | — | 26.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetChains.test.ts` | 108.0 | — | 201.0 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetKinds.test.ts` | 18.4 | — | 31.3 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetOutput.test.ts` | 122.8 | — | 229.4 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetPoolOutput.test.ts` | 120.6 | — | 227.8 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerChains.test.ts` | 57.9 | — | 54.7 | 28.6 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.providerReset.test.ts` | 163.2 | — | 273.2 | 35.1 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.providerSignals.test.ts` | 31.5 | — | 60.0 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.provisioning.test.ts` | 27.0 | — | 51.8 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.publication.test.ts` | 10.6 | — | 20.2 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recovery.test.ts` | 51.0 | — | 92.4 | 2.4 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.recoveryAdmission.test.ts` | 58.2 | — | 107.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recoveryAuthority.test.ts` | 83.6 | — | 144.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.routing.test.ts` | 42.1 | 1.5 | 70.7 | 1.5 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.settlement.test.ts` | 50.4 | — | 77.2 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.succession.test.ts` | 132.6 | — | 193.9 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.watchdogRegression.test.ts` | 3.6 | — | 4.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/legacyReviewConversion.test.ts` | 3.9 | 2.5 | 6.6 | 2.4 | 0/0 → 0/0 |
| `src/lib/reaperRuntime.performance.test.ts` | 2.9 | — | 3.9 | — | 0/0 → 0/0 |
| `src/lib/reaperRuntime.test.ts` | 2.7 | — | 4.7 | — | 0/0 → 0/0 |
| `src/lib/runtime/consumers.test.ts` | 0.3 | — | 0.4 | — | 0/0 → 0/0 |
| `src/lib/runtime/serverConsumers.test.ts` | 0.4 | — | 0.7 | — | 0/0 → 0/0 |
| `src/lib/scanner/index.integrity.test.ts` | 0.6 | — | 1.2 | — | 0/0 → 0/0 |
| `src/lib/scanner/index.pin.test.ts` | 0.6 | — | 1.1 | — | 0/0 → 0/0 |
| `src/lib/workflows/engine.contention.test.ts` | 0.4 | — | 0.6 | — | 0/0 → 0/0 |
| `src/lib/workflows/engine.cpuAdmission.test.ts` | 0.4 | — | 0.6 | — | 0/0 → 0/0 |
| `src/lib/workflows/engine.test.ts` | 0.4 | — | 0.6 | — | 0/0 → 0/0 |
| `src/lib/workflows/store.test.ts` | 0.3 | — | 0.5 | — | 0/0 → 0/0 |
| `src/runtime-host/journal.test.ts` | 4.3 | — | 6.2 | — | 0/0 → 0/0 |
| `src/runtime-host/legacyScheduler.test.ts` | 0.4 | — | 0.6 | — | 0/0 → 0/0 |

#### Seat reminders

| Repository-relative test file | Head 4 | Base 4 | Head 8 | Base 8 | Reruns B/H: 4 → 8 |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/lib/mcp/server.test.ts` | 27.0 | — | 50.8 | — | 0/0 → 0/0 |
| `src/lib/monitor/seatTick.activity.test.ts` | 1.1 | — | 3.0 | — | 0/0 → 0/0 |
| `src/lib/monitor/seatTick.test.ts` | 1.0 | — | 2.3 | — | 0/0 → 0/0 |
| `src/lib/monitor/seatTickSources.test.ts` | 16.4 | — | 41.5 | 5.4 | 0/0 → 0/0 |
| `src/lib/monitor/seatTickState.test.ts` | 2.1 | — | 5.8 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.accountGuard.test.ts` | 8.3 | — | 22.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.activation.test.ts` | 30.1 | — | 88.8 | 3.6 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.containment.test.ts` | 29.5 | — | 86.3 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.controllerPass.test.ts` | 37.7 | 0.8 | 54.0 | 16.0 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.controllerSnapshot.test.ts` | 2.6 | — | 7.4 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 82.0 | — | 95.9 | 7.5 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.cpuQueue.test.ts` | 0.9 | — | 2.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.creation.test.ts` | 21.1 | 0.5 | 55.4 | 0.7 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.pauseMetadata.test.ts` | 0.8 | — | 2.1 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.ports.test.ts` | 89.8 | — | 235.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudget.test.ts` | 15.4 | — | 50.4 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetChains.test.ts` | 111.7 | — | 26.2 | 114.3 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.providerBudgetKinds.test.ts` | 15.3 | — | 51.9 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetOutput.test.ts` | 173.8 | — | 300.3† | 126.0 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetPoolOutput.test.ts` | 204.5 | — | 300.3† | 125.4 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerChains.test.ts` | 89.4 | — | 12.9 | 53.8 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.providerReset.test.ts` | 278.9 | 62.5 | 300.2† | 148.9 | 1/1 → 0/0 |
| `src/lib/pipelines/engine.providerSignals.test.ts` | 49.8 | — | 70.2 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.provisioning.test.ts` | 53.9 | — | 78.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.publication.test.ts` | 15.1 | — | 25.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recovery.test.ts` | 98.1 | — | 140.3 | 2.1 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.recoveryAdmission.test.ts` | 91.4 | — | 138.2 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recoveryAuthority.test.ts` | 121.9 | — | 217.4 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.routing.test.ts` | 76.3 | 1.4 | 127.0 | 1.5 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.settlement.test.ts` | 72.0 | — | 66.3 | 34.4 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.succession.test.ts` | 175.1 | — | 300.2† | 140.5 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.watchdogRegression.test.ts` | 4.2 | — | 5.2 | — | 0/0 → 0/0 |
| `src/lib/pipelines/store.reads.test.ts` | 1.2 | — | 1.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/store.test.ts` | 5.3 | — | 8.3 | — | 0/0 → 0/0 |
| `src/lib/viewerLoopMonitor.test.ts` | 0.1 | — | 0.2 | — | 0/0 → 0/0 |

#### Role-memory retry

| Repository-relative test file | Head 4 | Base 4 | Head 8 | Base 8 | Reruns B/H: 4 → 8 |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/lib/agent/registry.admission.test.ts` | 0.9 | 0.3 | 2.0 | 0.4 | 0/0 → 0/0 |
| `src/lib/agent/registry.backendResolution.test.ts` | 0.3 | — | 0.7 | — | 0/0 → 0/0 |
| `src/lib/agent/registry.deliveryCompaction.test.ts` | 0.6 | — | 1.2 | — | 0/0 → 0/0 |
| `src/lib/agent/registry.deliveryRead.test.ts` | 0.5 | — | 1.0 | — | 0/0 → 0/0 |
| `src/lib/agent/registry.engineNative.test.ts` | 0.2 | — | 0.5 | — | 0/0 → 0/0 |
| `src/lib/agent/registry.migrationBinding.test.ts` | 0.8 | — | 2.0 | — | 0/0 → 0/0 |
| `src/lib/agent/registry.projectOwnership.test.ts` | 0.4 | — | 0.9 | — | 0/0 → 0/0 |
| `src/lib/agent/registry.reseat.test.ts` | 1.0 | — | 2.8 | — | 0/0 → 0/0 |
| `src/lib/agent/registry.retentionRead.test.ts` | 0.9 | — | 1.7 | — | 0/0 → 0/0 |
| `src/lib/agent/registry.servingWriters.test.ts` | 11.4 | — | 13.3 | — | 0/0 → 0/0 |
| `src/lib/agent/registry.spawnCapabilityHandover.test.ts` | 1.6 | 1.6 | 3.2 | 2.2 | 0/0 → 0/0 |
| `src/lib/agent/registry.sqlite.test.ts` | 31.6 | — | 58.5 | 10.6 | 0/0 → 2/2 |
| `src/lib/agent/registry.sqliteOnly.test.ts` | 0.6 | — | 1.1 | — | 0/0 → 0/0 |
| `src/lib/agent/registry.targetedHistory.test.ts` | 3.2 | — | 5.7 | — | 0/0 → 0/0 |
| `src/lib/agent/registry.test.ts` | 15.6 | — | 20.9 | — | 0/0 → 0/0 |
| `src/lib/agent/registry.writerWait.test.ts` | 5.3 | — | 10.7 | 3.8 | 0/0 → 1/1 |
| `src/lib/memory/privacy.test.ts` | 6.4 | — | 7.8 | — | 0/0 → 0/0 |
| `src/lib/memory/roleStore.test.ts` | 2.4 | — | 4.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.accountGuard.test.ts` | 6.0 | — | 13.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.activation.test.ts` | 34.4 | 0.7 | 60.9 | 1.0 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.containment.test.ts` | 34.1 | — | 60.9 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.controllerPass.test.ts` | 43.9 | 0.6 | 55.0 | 0.8 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.controllerSnapshot.test.ts` | 3.6 | — | 4.1 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.cpuAdmissionPolling.test.ts` | 84.7 | — | 89.4 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.cpuQueue.test.ts` | 1.0 | — | 2.2 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.creation.test.ts` | 25.4 | 0.5 | 40.7 | 0.7 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.ports.test.ts` | 104.1 | — | 164.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudget.test.ts` | 18.4 | — | 37.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetChains.test.ts` | 110.0 | — | 138.4 | 41.5 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.providerBudgetKinds.test.ts` | 20.2 | — | 37.6 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetOutput.test.ts` | 124.1 | — | 245.9 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerBudgetPoolOutput.test.ts` | 126.5 | — | 239.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerChains.test.ts` | 56.4 | — | 11.0 | 77.6 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.providerReset.test.ts` | 171.0 | — | 290.8 | 53.1 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.providerSignals.test.ts` | 33.8 | — | 40.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.provisioning.test.ts` | 36.4 | 0.8 | 39.3 | 1.2 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.publication.test.ts` | 11.2 | — | 12.8 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recovery.test.ts` | 66.2 | — | 125.2 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recoveryAdmission.test.ts` | 62.0 | — | 132.2 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.recoveryAuthority.test.ts` | 87.0 | — | 187.7 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.rolePrivacy.test.ts` | 14.5 | — | 36.1 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.routing.test.ts` | 59.5 | 0.9 | 128.7 | 1.5 | 0/0 → 0/0 |
| `src/lib/pipelines/engine.settlement.test.ts` | 57.3 | — | 37.2 | 68.8 | 0/0 → 1/1 |
| `src/lib/pipelines/engine.succession.test.ts` | 136.9 | — | 204.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/engine.watchdogRegression.test.ts` | 3.5 | — | 7.9 | — | 0/0 → 0/0 |
| `src/lib/pipelines/stageInput.restricted.probe.test.ts` | 0.3 | — | 0.5 | — | 0/0 → 0/0 |
| `src/lib/pipelines/stageInput.test.ts` | 1.0 | 0.3 | 2.4 | 0.4 | 0/0 → 0/0 |
| `src/lib/runtime/commands.inject.test.ts` | 0.2 | — | 0.5 | — | 0/0 → 0/0 |
| `src/lib/runtime/commands.test.ts` | 0.2 | — | 0.5 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredDeliveryQueue.copilot.test.ts` | 0.4 | — | 0.9 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredDeliveryQueue.inject.test.ts` | 0.5 | — | 1.0 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredDeliveryQueue.progress.test.ts` | 1.1 | — | 1.8 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredDeliveryQueue.recoveryContention.test.ts` | 8.0 | — | 10.8 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredDeliveryQueue.test.ts` | 1.9 | — | 4.7 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredMessageDelivery.accountReseat.test.ts` | 1.3 | — | 2.8 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredMessageDelivery.keyed.test.ts` | 5.7 | — | 8.6 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredMessageDelivery.placement.test.ts` | 0.6 | — | 1.0 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredMessageDelivery.sqlite.test.ts` | 5.5 | — | 9.0 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredMessageDelivery.test.ts` | 3.9 | — | 9.4 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredSpawn.cpuPlacement.test.ts` | 1.9 | — | 4.1 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredSpawn.integration.test.ts` | 21.5 | — | 30.1 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredSpawn.memory.test.ts` | 0.6 | — | 1.2 | — | 0/0 → 0/0 |
| `src/lib/runtime/structuredSpawn.terminalize.test.ts` | 7.9 | — | 15.3 | — | 0/0 → 0/0 |

## Loaded engine-family campaign

Status: complete. All required qualifying runs and both refusal controls passed their acceptance checks. The required sample is 30 qualifying after-runs, ten before-runs and two refusal controls. All attempts, including load outliers, are retained in `evidence/perf/pre-push-touched-tests.json#engineLoadCampaign`.

The fixed comparison uses main `144c87e12af0` before the fix and `04df47ce7042` after it, with three captured lane heads and their merged trees recorded in the manifest. The stage merged current main at resumption (`51d851863f7d`); the paired campaign keeps its original inputs so the earlier qualifying runs remain comparable. The separate final gate verified the integrated source after the last main merge (see the completed campaign and integration below).

Each attempt runs the real pre-push entry point in a scratch clone with its own HOME, config, temp and state roots and a closed Viewer control URL. The local bare origin pins the side’s main revision. No scratch commit or push is created. Load and owned file services are sampled every two seconds. Only an execution-period median load from 25 through 30 qualifies. Outer admission is excluded from complete-gate time; any nested wait is retained in that wall time and also reported by the comparator. Kernel samples retain the three-CPU file quota and eighteen-CPU work quota. CPU counters are sampled lower bounds; short services can finish between samples.

| Side | Qualifying runs | Complete sample P90 (s) | File expirations | Refusals | NEW lines |
| --- | ---: | ---: | ---: | ---: | ---: |
| before | 10 | 1006.8 | 7 | 5 | 2 |
| after | 30 | 472.8 | 0 | 0 | 0 |

P90 uses the nearest-rank observation at `ceil(0.9 × run count)` in the complete qualifying sample. An incomplete baseline or runner error is a refusal even when it emits no NEW assertion line.

| Attempt | Side | Branch | Load min / median / max | Outer admission (s) | Complete gate (s) | Qualifies | Expirations | Exit |
| --- | --- | ---: | --- | ---: | ---: | --- | ---: | ---: |
| after-01 | after | 1 | 17.64 / 30.50 / 45.84 | 41.6 | 643.1 | outlier | 0 | 0 |
| after-101 | after | 1 | 22.72 / 26.46 / 38.68 | 1.5 | 431.1 | yes | 0 | 0 |
| after-02 | after | 2 | 19.72 / 28.60 / 36.25 | 37.4 | 508.2 | yes | 0 | 0 |
| after-03 | after | 3 | 21.53 / 32.92 / 37.94 | 25.5 | 459.9 | outlier | 0 | 0 |
| after-103 | after | 3 | 20.36 / 25.15 / 31.17 | 17.1 | 421.5 | yes | 0 | 0 |
| before-01 | before | 1 | 9.91 / 29.19 / 36.47 | 36.2 | 1166.6 | yes | 5 | 1 |
| after-04 | after | 1 | 26.41 / 35.68 / 49.79 | 1.8 | 542.1 | outlier | 0 | 0 |
| after-104 | after | 1 | 20.02 / 36.03 / 41.26 | 1.4 | 518.6 | outlier | 0 | 0 |
| after-204 | after | 1 | 23.54 / 29.75 / 34.75 | 29.6 | 461.2 | yes | 0 | 0 |
| after-05 | after | 2 | 20.72 / 35.44 / 46.92 | 183.7 | 594.9 | outlier | 0 | 0 |
| after-105 | after | 2 | 15.22 / 32.88 / 40.30 | 1.2 | 518.3 | outlier | 0 | 0 |
| after-205 | after | 2 | 19.51 / 25.41 / 34.94 | 45.6 | 476.4 | yes | 0 | 0 |
| after-06 | after | 3 | 24.21 / 35.52 / 45.57 | 76.3 | 521.6 | outlier | 0 | 0 |
| after-106 | after | 3 | 18.91 / 30.17 / 36.57 | 107.6 | 487.0 | outlier | 0 | 0 |
| after-206 | after | 3 | 13.62 / 33.46 / 51.23 | 1.2 | 449.9 | outlier | 0 | 0 |
| after-306 | after | 3 | 19.85 / 27.60 / 32.79 | 77.6 | 414.9 | yes | 0 | 0 |
| before-02 | before | 2 | 14.88 / 20.78 / 42.33 | 3.2 | 1124.8 | outlier | 4 | 1 |
| before-102 | before | 2 | 12.16 / 19.46 / 30.93 | 37.3 | 879.5 | outlier | 1 | 1 |
| before-202 | before | 2 | 7.39 / 31.94 / 41.28 | 1.3 | 967.3 | outlier | 1 | 1 |
| before-302 | before | 2 | 6.79 / 26.84 / 34.43 | 1.3 | 842.1 | yes | 0 | 1 |
| after-07 | after | 1 | 5.83 / 27.98 / 38.06 | 1.2 | 432.1 | yes | 0 | 0 |
| after-08 | after | 2 | 7.75 / 28.16 / 35.83 | 1.0 | 384.6 | yes | 0 | 0 |
| after-09 | after | 3 | 8.50 / 27.80 / 31.06 | 1.2 | 400.5 | yes | 0 | 0 |
| before-03 | before | 3 | 7.94 / 26.40 / 39.11 | 1.0 | 783.4 | yes | 0 | 0 |
| after-10 | after | 1 | 3.80 / 27.75 / 34.06 | 7.0 | 395.7 | yes | 0 | 0 |
| after-11 | after | 2 | 6.23 / 28.78 / 31.83 | 1.1 | 435.1 | yes | 0 | 0 |
| after-12 | after | 3 | 11.62 / 39.60 / 69.29 | 9.1 | 546.9 | outlier | 0 | 0 |
| after-112 | after | 3 | 12.41 / 26.44 / 32.09 | 1.2 | 379.7 | yes | 0 | 0 |
| before-04 | before | 1 | 9.22 / 28.25 / 37.94 | 1.2 | 916.4 | yes | 0 | 1 |
| after-13 | after | 1 | 6.42 / 27.97 / 59.52 | 3.1 | 495.0 | yes | 0 | 0 |
| after-14 | after | 2 | 4.96 / 27.36 / 31.90 | 0.9 | 385.1 | yes | 0 | 0 |
| after-15 | after | 3 | 9.66 / 27.07 / 35.00 | 1.0 | 395.2 | yes | 0 | 0 |
| before-05 | before | 2 | 8.47 / 28.68 / 32.91 | 1.3 | 945.7 | yes | 0 | 0 |
| after-16 | after | 1 | 10.84 / 29.22 / 32.31 | 1.0 | 425.0 | yes | 0 | 0 |
| after-17 | after | 2 | 6.41 / 28.72 / 31.98 | 3.0 | 470.4 | yes | 0 | 0 |
| after-18 | after | 3 | 6.44 / 29.19 / 31.36 | 0.8 | 414.4 | yes | 0 | 0 |
| before-106 | before | 3 | 5.40 / 27.85 / 35.61 | 3.3 | 952.8 | yes | 0 | 0 |
| after-19 | after | 1 | 3.95 / 26.69 / 38.08 | 2.9 | 404.7 | yes | 0 | 0 |
| after-90-assertion | after | 1 | 10.55 / 27.68 / 38.64 | 11.2 | 402.1 | control | 0 | 1 |
| after-91-hang | after | 2 | 11.38 / 26.09 / 31.86 | 3.2 | 594.9 | control | 0 | 1 |
| after-20 | after | 2 | 12.36 / 27.40 / 30.51 | 23.6 | 439.3 | yes | 0 | 0 |
| after-21 | after | 3 | 17.02 / 26.59 / 32.19 | 494.1 | 402.8 | yes | 0 | 0 |
| before-07 | before | 1 | 16.80 / 29.36 / 63.94 | 954.7 | 908.8 | yes | 1 | 1 |
| after-22 | after | 1 | 20.66 / 44.06 / 69.83 | 62.1 | 703.0 | outlier | 0 | 0 |
| after-122 | after | 1 | 22.05 / 31.28 / 39.39 | 4.0 | 507.7 | outlier | 0 | 0 |
| after-222 | after | 1 | 23.35 / 35.73 / 42.31 | 682.1 | 606.8 | outlier | 0 | 0 |
| after-23 | after | 2 | 27.98 / 40.04 / 56.20 | 183.7 | 599.0 | outlier | 0 | 0 |
| after-322 | after | 1 | 24.06 / 36.28 / 40.33 | 38.3 | 518.0 | outlier | 0 | 0 |
| after-123 | after | 2 | 18.15 / 31.43 / 38.89 | 3.4 | 507.4 | outlier | 0 | 0 |
| after-24 | after | 3 | 16.43 / 28.46 / 34.30 | 3.4 | 426.5 | yes | 0 | 0 |
| after-422 | after | 1 | 11.20 / 37.81 / 68.20 | 3.3 | 602.4 | outlier | 0 | 0 |
| after-522 | after | 1 | 10.32 / 26.52 / 32.99 | 3.4 | 400.8 | yes | 0 | 0 |
| after-223 | after | 2 | 10.95 / 31.50 / 55.02 | 3.3 | 723.7 | outlier | 0 | 0 |
| before-08 | before | 2 | 18.82 / 28.34 / 45.13 | 9.5 | 861.3 | yes | 1 | 1 |
| after-323 | after | 2 | 7.75 / 28.92 / 37.20 | 3.2 | 472.8 | yes | 0 | 0 |
| after-25 | after | 1 | 8.03 / 27.47 / 31.67 | 5.3 | 386.4 | yes | 0 | 0 |
| after-26 | after | 2 | 14.92 / 25.65 / 27.10 | 3.3 | 364.7 | yes | 0 | 0 |
| before-09 | before | 3 | 11.61 / 29.82 / 36.95 | 3.2 | 966.9 | yes | 0 | 0 |
| after-27 | after | 3 | 11.45 / 26.63 / 34.49 | 3.7 | 402.3 | yes | 0 | 0 |
| after-28 | after | 1 | 11.83 / 27.43 / 37.03 | 3.4 | 412.3 | yes | 0 | 0 |
| after-29 | after | 2 | 6.19 / 28.01 / 33.99 | 3.1 | 378.8 | yes | 0 | 0 |
| before-10 | before | 1 | 8.08 / 26.45 / 48.22 | 3.3 | 1006.8 | yes | 0 | 0 |
| after-30 | after | 3 | 10.61 / 28.45 / 33.22 | 9.3 | 390.4 | yes | 0 | 0 |

The ten split families retain all 1,078 registered cases, including their names, parameter values and assertion bodies. The preserved calibration and JUnit inventory established that partition before the campaign. The measured timeout exceptions are described in `docs/design/pre-push-gate-under-load.md#2-fix`.

The resumed campaign began with three qualifying after-runs and one before-run. No test or verdict rule changed during resumption. Batches retain every attempted load condition and stop between attempts. Complete-gate time includes the driver’s owned cleanup after hook exit.

| Resumed batch | Attempts | Qualifying after | Qualifying before |
| --- | ---: | ---: | ---: |
| batch-01 | 3 | 1 | 0 |
| batch-02 | 4 | 1 | 0 |
| batch-03 | 4 | 1 | 0 |
| batch-04 | 1 | 0 | 0 |
| batch-05 | 4 | 3 | 1 |
| batch-06 | 1 | 0 | 1 |
| batch-07 | 3 | 2 | 0 |
| batch-08 | 3 | 2 | 1 |
| batch-09 | 4 | 3 | 1 |
| batch-10 | 3 | 2 | 0 |
| batch-11 | 1 | 0 | 1 |
| batch-12 | 1 | 1 | 0 |
| batch-13 | 1 | 0 | 0 |
| batch-14 | 1 | 0 | 0 |
| batch-15 | 1 | 1 | 0 |
| batch-16 | 2 | 1 | 1 |
| batch-17 | 1 | 0 | 0 |
| batch-18 | 1 | 0 | 0 |
| batch-20 | 2 | 0 | 0 |
| batch-21 | 3 | 1 | 0 |
| batch-22 | 1 | 0 | 0 |
| batch-23 | 3 | 1 | 1 |
| batch-24 | 3 | 3 | 0 |
| batch-26 | 1 | 0 | 1 |
| batch-28 | 3 | 3 | 0 |
| batch-29 | 1 | 0 | 1 |
| batch-30 | 1 | 1 | 0 |

Two before-runs fell below the required load band as their remaining files and baseline work used fewer CPUs. Observed test CPU usage averaged at least 3.78 CPUs in `before-02`, against 7.04 in `after-306`. Future before-runs use a four-CPU foreground estimate for initial load padding; after-runs retain eight. New records include `paddingForegroundCpuEstimate`; earlier records used eight. The real gate retains its eight head workers and existing quotas, deadlines and verdict rules. Every earlier qualifier and outlier stays in the sample.

Static padding still produced an above-band before-run (`before-202`, median 31.94). Future attempts on both sides use the two-second load samples to adjust only their own padding scopes every 30 seconds, with at most twelve requested active scopes. A load above 30 removes one scope; above 35 removes up to two. Below 25 adds one scope after the first 90 seconds and after pending stops finish. Start and stop requests are recorded per run. The gate continues during asynchronous stop requests, and all owned launcher and stop-command handles settle at cleanup. Each new invocation follows a separate three-minute cooldown. All method epochs retain the same qualifying load band and frozen test inputs.

The separate merged-source engine comparison passed on `b68b4fb6c5b1`: 46 explicit engine files, 425.9 s including admission, exit 0, zero NEW failures. Its command, source digest and log digest are recorded in `integratedEngineComparison`. Other final project checks were outstanding at that checkpoint.

The high-load `after-05` outlier captured two existing 15-second explicit test timeouts in `engine.providerReset.part3.test.ts`; filtered retries passed and the comparator classified the occurrences as flaky. At that checkpoint, the 30/10 sample and the two controls remained incomplete.

The recovery attempt merged current main before continuing. Its process now has a private PID namespace; both frozen campaign runners capture local process identities and launch user-manager services without namespace support. The host process view showed that the preceding run was still alive after its agent restarted. That run was allowed to finish, and its campaign pause flag prevented another dispatch. Its later 889.5-second result is excluded from acceptance at the campaign owner’s direction and retained under `discardedRuns`. That recovery attempt submitted no new hook. At that checkpoint, the remaining runs required a compatible execution context or an agreed new measurement epoch. At that checkpoint, the merged dependency lock differed from the captured inputs; final project and integration checks were still outstanding.

The supported-wrapper probe completed with exit 0 and an effective ancestor quota of three CPUs (`60000 20000`), outside the historical shared work slice. A read-only identity probe found that the frozen local-PID owner differs from the host identity, while the supported helper translates it correctly. The environment observations and procedures are retained in `engineLoadCampaign.continuationEnvironment`. No acceptance hook was dispatched from the recovery attempt. That recovery window also retained its 06:00 UTC dispatch cutoff.

### Managed-runner continuation

The approved adapter translates its namespace-local supervisor identity with `cpuOwnerIdentity`, then invokes the unchanged frozen host service runner. The hook, comparator, admission rules, worker count and fixture trees are unchanged. The host probe verified a three-CPU supervisor under the historical eighteen-CPU shared work slice. Every observed test-file service in the equivalence control retained its three-CPU quota.

The full equivalence control reran the branch used by `after-18`: 390.8 s complete-gate time, 2.9 s outer admission, load 7.42/27.37/35.15, exit 0, zero expirations and zero NEW failures. Its prior paired observation took 414.4 s. Runtime, source and gate digests matched; all owned padding scopes were quiescent afterward. This control contributes no acceptance run. The adapter and raw evidence digests are in `engineLoadCampaign.managedRunnerContinuation`.

At the previous 06:00 UTC checkpoint, the ledger contained 20/30 qualifying after-runs and 6/10 before-runs. Before-run 6 remains excluded. 2 refusal controls are recorded. That window checked the pause flag and stopped new dispatches at 06:00 UTC; its current run and owned cleanup could finish afterward. Only this campaign's recorded processes and scopes are stopped.

| Refusal control | Complete gate (s) | Median load | Result |
| --- | ---: | ---: | --- |
| assertion | 402.1 | 27.68 | Named injected failure refused; zero unrelated NEW failures |
| hang | 594.9 | 26.09 | Named injected failure refused; zero unrelated NEW failures |

Both controls remove their temporary test and restore the frozen tracked tree. The hanging control records its initial timeout plus three independent head confirmations, each near 60 seconds. These intentional failures contribute no qualifying after-run.

The isolated integration gate on source `61b10d71b898` completed with exit 0 in 340.8 s. It used a fresh frozen-lockfile install. The source digest, exact command and log digest are recorded in `managedRunnerContinuation`.

The integration comparison retained two baseline failures: `scripts/merge-batch.test.ts` (the real main scanner publishes a healthy remainder with a stale branch hook) and `src/lib/pipelines/engine.controllerPass.test.ts` (a bounded reconciliation preserves another lane’s CPU ticket and FIFO age). Both failed on the fresh baseline too; the gate reported zero NEW failures.

### Final quiet-window continuation

The resumed window began at 21:10 UTC on 2026-10-21 after merging current main by merge commit. The six frozen input trees and gate digests were verified against the preserved ledger before dispatch. The adapter continues to translate process identities and runs the frozen service runner in the same eighteen-CPU shared work slice with three CPUs per file. Before-run 6 remains excluded.

Current qualifying counts: 22/30 after and 7/10 before. After P90 is 476.4 s, with 0 expirations and 0 NEW failures. All attempted load conditions remain in the table. The dispatch cutoff for this window is 01:10 UTC on 2026-10-22; a seat stop message closes dispatch immediately and permits the current run and owned cleanup to finish.

The separate integration pre-push on merged source `e3f85d8efbb4` completed with exit 0 in 583.5 s including its admission waits, using a fresh frozen-lockfile install. Commands, source and log digests, named checks and classifications are recorded in `engineLoadCampaign.quietWindowContinuation`.

The recovered private adapter now preserves ancestor queue-wait ledgers across both environment boundaries. During `before-07`, 953.6 s of completed, recorded admission wait was restored to its two owned supervisors. Their execution allowances and all frozen hook deadlines stayed unchanged. The run finished with a complete refusal after its provider-reset file expired at 300 seconds.

A separate, non-counting control reran the same frozen branch as `after-21`: 408.4 s against 402.8 s, median load 26.19, exit 0, zero expirations and zero NEW failures. Source, runtime and gate digests and all 65 head file invocations matched. It retained the three-CPU file quota and eighteen-CPU work slice; both ancestor ledgers received the same 243.7 s of actual queue-wait credit. All observed file services and owned padding scopes were quiescent. The control contributes no acceptance sample; its verification releases the held qualifying record for `before-07`.

The quiet-window dispatches are closed. The remaining sample is 8 after-runs and 3 before-runs. The after sample has no expirations and no NEW failures; its P90 remains provisional until all 30 qualifying runs complete. The two refusal controls and the isolated integration gate are complete. All attempted load conditions, including outliers, remain in the record.

While the campaign had no active acceptance run, 27 retained hold samples ranged from 18.10 to 52.98, with median 26.54. These observations explain the dispatch holds and contribute no acceptance run. The separate supervision-ledger control also contributes no acceptance run.

### Second quiet-window continuation

The window started at 01:55 UTC on 2026-10-22, with a 04:55 UTC cutoff for new hooks and an immediate dispatch stop on a seat message. Current main was merged by merge commit before verification; the paired campaign retains its frozen inputs, translated process identities, eighteen-CPU shared work slice and three-CPU file quota. The prior 22 after and 7 before qualifiers remain unchanged; before-run 6 remains excluded.

Current sample: 29/30 after and 10/10 before. After P90: 476.4 s; 0 file expirations and 0 NEW failures. Every load outlier remains in the table.

The isolated full integration gate on merged source `75369593ceb7` completed with exit 0 in 374.8 s including admission, after a fresh frozen-lockfile install. Its source, command and log digests and classifications are recorded in `engineLoadCampaign.secondQuietWindowContinuation`.

Dispatch is closed. Remaining: 1 after and 0 before. The active run was allowed to finish with owned cleanup.

The window completed 12 attempts: seven qualifying after-runs, three qualifying before-runs and two after load outliers. All 764 recorded test services and 95 owned padding scopes are quiescent. All 62 raw and published records reconcile. The last hook started at 04:48:14 UTC; after-run 30 was never submitted.

Later upstream main `026855f85090` changed 56 files after the window-start merge. The read-only merge check found content conflicts in `src/lib/pipelines/engine.ports.test.ts` and `src/lib/pipelines/engine.recovery.test.ts`: upstream retired embedded-flow cases whose bodies this fix partitioned into sibling files. The next integration merge must carry those case changes into the split files and reverify the integrated source. The campaign keeps its frozen trees; the successful window-start integration remains the check of this checkpoint's product source.

### Completed campaign and integration

The final window started at 05:40 UTC on 2026-10-22, with a 06:25 UTC dispatch cutoff and an immediate stop on a seat message. Main was merged by merge commit. Upstream retired embedded-flow registrations were carried into their split locations; no extra cases were retired. All six paired campaign input trees, the frozen driver, the managed adapter and CPU quotas were preserved. Before-run 6 remains excluded.

Final qualifying sample: 30/30 after and 10/10 before. After P90 is 472.8 s, against 1006.8 s before. The after sample has 0 per-file expirations, 0 NEW failures and 0 refusals. All outliers and the two successful refusal controls remain recorded.

The isolated integration pre-push on merged source `132932cd96db` completed with exit 0 in 319.6 s including admission, following a fresh frozen-lockfile install. The gate retained its fresh baseline classification; the new-failure count was 0. Source, commands, classifications and log digests are recorded in `engineLoadCampaign.finalQuietWindowContinuation`.

All 63 recorded test services and 5 padding scopes from this window are quiescent. All 63 raw and published records reconcile, and earlier evidence rows remain unchanged. The verified code digest matches the final product source. Dispatch is closed; other lanes' processes were untouched.

### Workflow publication repair

The publisher completed its checks and the remote refused the optional Windows workflow command changes because the publishing App lacks workflow permission. The repair restores `.github/workflows/platform-tests.yml` to the published main contents and defers those two CI command changes. The accepted gate implementation, test partitions, 30/10 campaign records and all prior commits are retained.

A fresh frozen-lockfile install and the full isolated `bun scripts/local-gate.ts pre-push` on source `a40ccffbf035` passed in 326.2 s including admission. Privacy, types, lint, touched tests, Linux checks, audit and supply chain passed. The controllerPass failure reproduced on the fresh baseline; there were zero NEW failures. The managed supervisor is inactive. Source and log digests are recorded in `engineLoadCampaign.publicationRepair`. Publication is left to the controller.
