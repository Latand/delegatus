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
`scripts/local-gate-tests.ts`. The initial head sample uses four file workers.
Baseline and confirmation samples retain three workers per side. The file/run
limits, shared five-minute confirmation budget and publication execution
deadline are retained.

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

## Results

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
