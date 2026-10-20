# Structured-host pipeline authority

## Observation

The service journal for 2026-10-20 03:50–03:55 UTC contains 77
`pipeline registry unreadable` records from one Viewer process. Its journal
envelope identifies the writer; the original warning payload contains neither
PID nor role. The runtime host does not call this reconciliation path.

`completeViewerRuntimeActivation` starts structured-host startup in the
background after state initialization, then starts controllers. Each startup
phase and each host claim or demotion takes a short pipeline admission.
`withPipelineStartupAdmission` previously converted every error before callback
entry into `available=false`. Startup replaced that error with the synthetic
`pipeline admission authority is unavailable` message. This message could not
distinguish an uninitialized authority, contention, corrupt evidence or a changed
pipeline revision.

A writer committing while startup waits for the lease reproduces the refusal:
the prepared evidence fails its revision check immediately before admission.
Both full and compact evidence modes reproduce it. The journal's lost error
details prevent assigning that underlying reason to each historical record.
The repeated warning mechanism is established: every remaining host can report
the same unavailable result in one pass. Deferred pipeline evidence has a
separate probe, starting at one second and doubling to 30 seconds. Whole-pass
startup failures have a separate five-second to five-minute backoff with jitter.

## Change and boundaries

Preparation, queueing, lease acquisition and revision retries share one
`waitForStateLock` deadline, normally 30 seconds and bounded by
`LLV_PIPELINE_LOCK_WAIT_MS`. Pending admissions retain shared prepared evidence while yielding to a local
lease holder; they never queue behind an application callback. Only failures before callback entry may retry. Callback
errors cross that retry boundary as results and are rethrown unchanged;
callbacks retain independent admission for their other resources.

One exhausted or unreadable authority fences the remaining pipeline members
for that pass and produces one refusal with its actual error, PID and role.
The deferred probe can recover those members after repair. Cancellation and
release retirement are checked before callback entry. The operation is
`pipelines.startup-admission`; its wait correlation also names the startup phase.
Lease-budget warnings carry PID and role. Loop-gap and performance-summary
emission is unchanged.

The production caller is `adoptStructuredHostsPass` in
`src/lib/runtime/startup.ts`; it requests compact ownership evidence. Full
admission remains available to its store tests. Prepared evidence is consumed
by the ownership, health and full-record readers through the existing scoped
context, which is cleared on callback exit. There is no schema or persisted
record change. `outsideStateLockWait` is used only at this admitted callback
boundary.

## Reproduction

Build each revision in its own scratch source export with the same dependencies
and Bun interpreter. Use private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR,
and set LLV_VIEWER_CONTROL_URL to a closed loopback port. Run each heavy command
through the project's gate slot:

```sh
bash "$GATE_SLOT" bun run build
bash "$GATE_SLOT" bun scripts/startup-retry-benchmark.ts --authority-restarts
```

The benchmark seeds 1,024 draft pipelines and 64 completed structured Claude
rows. It starts the production Next build on an ephemeral loopback port, then
restarts that build with the same retained state. Each generation runs for
70 seconds. An independent writer attempts a pipeline revision update every
five milliseconds for eight seconds at each boot. No runtime socket, account
home or engine process is inherited. Writer commits and busy refusals are
reported separately; these measurements make no latency or CPU claim.

The driver parses each warning's own physical line as JSON and requires the
payload PID to equal the writing server generation's PID and its role to be
`viewer`. A missing, split or malformed attribution refuses the measurement.
It also counts complete warning prefixes, synthetic unavailable messages,
lease-budget warnings, loop-gap records and performance summaries. It refuses
missing startup completion, a failed writer, zero committed writes or truncated
output. The adjacent tests drive both production adopters through host claim
and delivery-controller publication with a fake engine host and owed handoff
work. The built-server measurement reconciles completed rows without launching
engines.

## Verification

Run explicit test paths: `src/lib/pipelines/startupResponsiveness.test.ts`,
`src/lib/runtime/startup.test.ts`, `src/lib/state/lockWait.test.ts` and
`src/lib/pipelines/store.test.ts`. The admission suite covers invalidation,
contention, one deadline under sustained churn, cancellation, callback failure,
nested-resource admission, corrupt state, process attribution and the large
startup burst. Startup cases cover both engines, one refusal per pass, retained
members and adoption after repair.

The project's touched-test comparator passes with zero new failures. Three
startup assertions also fail on the baseline:

- `startup terminalizes a delivered Claude spawn whose unverifiable host claim survived reboot`
- `startup settles a delivered pipeline retry and collapses its rebooted predecessor exactly once`
- `deferred pipeline evidence completes the pass with both engines retained, reconciles pending spawns outside the fence, and re-probes only the evidence until it moves (#1501)`

The three new startup cases fail against the baseline and pass on the candidate.
Full TypeScript checking, changed-file ESLint, both production builds and both
built-server restart measurements pass.


## Built-server results

The committed record is `evidence/structured-host-authority.json`. The baseline
is `720aa48c5537cba0a25c00b65b59504437378886`; the candidate's three production
source hashes and the shared driver's hash identify the measured inputs.

| Generation | Baseline warnings | Candidate warnings | Baseline / candidate loop-gap records | Baseline / candidate summaries |
| --- | ---: | ---: | ---: | ---: |
| First boot | 70 | 0 | 2 / 2 | 1 / 1 |
| Restart, retained state | 3 | 0 | 0 / 0 | 1 / 1 |

The old synthetic unavailable-message counts are also 70 and 3 before, and
zero in both candidate generations. Committed writer updates were 1,336 and
1,528 before, and 1,384 and 1,478 after. Busy writer attempts were 241 and 48
before, and 192 and 90 after. The writer schedule and input data were identical;
the record retains actual commits and refusals for each generation. Both
builds reached structured-startup ready on both boots. These are controlled
reconciliation counts; they establish no production latency or CPU gain.
The candidate run rechecked the one-line attribution gate; it emitted no
refusal or lease-budget warnings, so the corresponding attributed counts were
0/0 in both generations. The direct logger tests exercise emitted warning
records and require the current process PID and role in each line.
