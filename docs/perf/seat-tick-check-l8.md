# Seat check L8 replay

The complete copied-state check reached the same eligible wake decision in all six runs on both revisions. Every after run passes the 100 ms loop bound and the 50 ms synchronous-source bound. The full per-source timings, awaited wall times, load averages, outcomes and timestamps are in `evidence/perf/seat-tick-check.json`.

## Conditions

The M4 T9-check adapter in `scripts/probe-seat-tick.ts` ran under Bun 1.4.0 through `gate-slot.sh`. Base `7ac695acc0ce727d40784fe3c7b6b9fdf63e4b7f` and the final source tree used one immutable seed, restored to each isolated copy. The seed was copied at 2026-10-19T00:50:30.341000+00:00; its tree digest is recorded in the JSON artifact. Fingerprints identify each measured source tree.

The copy held 243 hot pipelines (32,084,865 JSON characters), 990 archived pipelines (132,652,422), 2,394 tasks (10,893,795), 4,009 role-memory rows (16,681,356), and a 33,356,772-byte summary. Copied registry statuses showed 39 live/idle and seven running entries. The observed project fleet was five live agents and three running at 2026-10-19T00:50:16.905Z. Load averages accompany every sample.

HOME, XDG_CONFIG_HOME, TMPDIR, CODEX_HOME and LLV_STATE_DIR were private to each copy. The adapter verified the control port was closed. `NODE_ENV=test` kept inbox resolution in the sandbox. GitHub and action effects were stubbed; transcript evidence was suppressed in both processes. Child event ledgers were included in the copied seed. `Date.now` used the same copied-state timestamp for both sides; performance timers remained real. Imports, inert summary/catalogue decoding and the registry scale count preceded run 0. Task, pipeline and memory lists remained cold until the check.

Each run returned `wake`, reason `lane-event`, and three items on both revisions. Before-side runs measured baseline cost without enforcing the candidate bounds. The after command used `--enforce`, which rejects a missing result, an error verdict, an ineligible wake, a loop gap above 100 ms or a synchronous source above 50 ms.

## Complete check

All values are milliseconds. Wall time includes asynchronous work. Loop interval is the largest interval observed by the 1 ms timer, including the final continuation.

| Run | Before wall | After wall | Before loop | After loop | Before largest sync entry | After largest sync entry |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 9,114.22 | 8,410.70 | 1,208.91 | 66.68 | 747.96 | 30.66 |
| 1 | 1,411.29 | 791.16 | 703.16 | 68.68 | 243.44 | 17.89 |
| 2 | 1,403.54 | 917.44 | 703.05 | 67.96 | 236.89 | 27.04 |
| 3 | 1,388.23 | 820.68 | 734.54 | 53.52 | 223.35 | 24.30 |
| 4 | 1,454.82 | 784.85 | 792.79 | 56.64 | 213.37 | 20.59 |
| 5 | 1,458.57 | 805.85 | 804.76 | 63.36 | 219.51 | 20.97 |

## Sources

Maximum synchronous entry per source across the six runs. Async waits are also covered by the complete-check loop measurement. `archivedPipelinesAsync` is the after-side cooperative reader corresponding to the before-side `archivedPipelines` source. All individual samples and awaited times remain in the JSON artifact.

| Source | Before ms | After ms |
| --- | ---: | ---: |
| `appendRecord` | 1.024 | 0.780 |
| `archivedPipelines` / `archivedPipelinesAsync` | 747.963 | 4.710 |
| `diskPressure` | 0.096 | 0.095 |
| `latestDeployment` | 0.171 | 0.196 |
| `lifecycleJournal` | 4.708 | 4.384 |
| `liveness.conversation` | 20.216 | 15.687 |
| `liveness.project` | 0.823 | 0.193 |
| `maintenanceRuns` | 8.917 | 5.008 |
| `memoryProblems` | 271.091 | 0.662 |
| `now` | 0.014 | 0.008 |
| `openPullRequests` | 0.041 | 0.030 |
| `pipelines` | 194.219 | 0.427 |
| `prepareRead` | — | 20.996 |
| `readState` | 4.857 | 4.188 |
| `recordDeploySnapshots` | 0.320 | 0.269 |
| `recordRuleReports` | 368.409 | 0.196 |
| `refreshLifecycle` | 23.833 | 23.952 |
| `registry` | 0.014 | 0.012 |
| `reports.log` | 23.236 | 0.134 |
| `retirementJournal` | 7.162 | 8.259 |
| `retirementReport` | 0.035 | 0.039 |
| `seatContextUsage` | 0.005 | 0.023 |
| `seatDeployments` | 0.047 | 0.042 |
| `seatFor` | 12.280 | 10.989 |
| `seatTurnOutcome` | 0.012 | 0.013 |
| `settings` | 1.659 | 0.440 |
| `tasks` | 170.121 | 0.318 |
| `workerAsks` | 0.097 | 0.134 |
| `workerCounts` | 27.338 | 30.660 |
| `writeState` | 8.450 | 18.221 |

## Changes and contracts

Seat startup fills shared task, pipeline and role-memory readers cooperatively. Tasks use the normalized read-only list; immutable pipeline bodies receive weak-keyed fingerprints, so unchanged evidence does not reserialize retained history. Alias and linked-machine context is captured once per synchronous pass. Task membership filtering precedes pipeline correlation.

The existing response worker reduces the exact operator summary to worker asks, reads report coverage and produces rule reports. Before sending project liveness to that worker, the Viewer now awaits `completedFileScan()`, preserving cold-start scan admission and observed catalogue refresh. The worker consumes the resulting Viewer-certified persisted generation; a generation change during its await refuses the result. Targeted conversation liveness retains its authority path. Queue and execution share one deadline; expired queued work never dispatches. Existing worker ownership, retirement and cleanup remain responsible for its process. The report helper in `src/lib/monitor/seatTickReports.ts` keeps controller imports outside the worker and resolves the channel cursor before the report transaction, including on a cold worker. New waits carry seat-tick operation and performance-phase labels.

No schema or persisted write format changed. Shared-reader producers are SqliteStateCollection cache publication and its existing revision/context validation; consumers include task list normalization, pipeline list membership/projections, seat gathering/evidence and memory-problem selection. Mutations retain keyed writers. Rule-report production still uses ruleReports and appendBridgeReports; coverage keeps the original manager/project filter, row order, default locale and owed-at semantics. Operator board callers still receive their original parsed representation; only seat agenda reduction consumes its raw body in the worker.

## Verification

The history-flat test shows row decoding and copying stay at zero after warming, with tenfold unrelated task and pipeline history. Existing wake reasons, items and ordering remain covered. The new project-liveness regression verifies cold completion and a new generation on consecutive calls; the existing generation-replacement test still refuses stale worker results.

Focused checks and the touched-tests comparator are run by explicit path through the gate-slot wrapper, with isolated roots. Typecheck, privacy publication, lint, scoped Linux checks and the pre-push comparator are recorded in the stage report. The replay evidence shows the eligible successful wake path with effects stubbed; the after source stays under both specified timing bounds.
