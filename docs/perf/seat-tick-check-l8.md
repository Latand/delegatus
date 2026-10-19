# Seat check L8 replay

The complete copied-state check passes the 100 ms loop bound and the 50 ms synchronous-source bound in all six after runs. Raw per-source calls, synchronous entry times, awaited wall times, load averages and timestamps are in `evidence/perf/seat-tick-check.json`.

## Conditions

`scripts/probe-seat-tick.ts` implements the M4 T9-check adapter. Both sides used Bun 1.4.0 and the same immutable seed restored to the same private path. The base was `7ac695acc0ce`; source fingerprints identify each measured tree. The seed was copied at 2026-10-18T23:49:48.556286+00:00. No controller ran against live state.

There were 243 hot pipelines (30,598,219 JSON characters), 990 archived pipelines (118,732,125), 2,494 tasks (9,939,576), 4,003 role-memory rows (16,649,217), and a 33,193,663-byte summary. The observed fleet was five live agents, two running; copied registry statuses separately reported 39 live/idle and nine live. Per-run load averages accompany every sample.

HOME, XDG_CONFIG_HOME, TMPDIR, CODEX_HOME and LLV_STATE_DIR were private. The control URL used a verified closed loopback port. NODE_ENV=test prevents an imported inbox from resolving outside the sandbox. gh and dispatch effects were stubbed; transcript evidence was suppressed in parent and worker. Date.now was fixed at the seed timestamp; performance timers remained real. Module imports, inert summary/catalogue decoding and the registry scale count precede run 0. Task, pipeline and memory lists start cold.

The copied state conservatively returns an error because child-ledger evidence was omitted. Both sides produce the same error verdict, empty reasons and zero items on every run. This measures the complete check through that evidence gap; deterministic controller tests cover wake content and dispatch. It makes no production overlap-per-hour claim.

## Complete check

All values are milliseconds. Wall time includes asynchronous work; loop interval is the largest interval observed by the 1 ms timer, including the final continuation.

| Run | Before wall | After wall | Before loop | After loop | Before largest sync entry | After largest sync entry |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 7536.61 | 7033.11 | 800.68 | 55.05 | 329.20 | 24.74 |
| 1 | 1243.02 | 830.99 | 611.84 | 38.12 | 219.39 | 18.29 |
| 2 | 1221.01 | 735.12 | 599.83 | 38.09 | 219.49 | 18.05 |
| 3 | 1228.87 | 804.19 | 609.27 | 37.12 | 215.30 | 17.88 |
| 4 | 1308.45 | 807.00 | 645.05 | 39.00 | 225.21 | 17.25 |
| 5 | 1256.56 | 797.25 | 627.97 | 37.11 | 223.11 | 17.63 |

## Sources

Maximum synchronous entry per source across the six runs. Async continuations are additionally bounded by the complete-check loop measurement. A dash means the source did not exist or its branch was gated out. All six individual samples and awaited times remain in the JSON artifact.

| Source | Before ms | After ms |
| --- | ---: | ---: |
| `appendRecord` | 0.792 | 0.739 |
| `diskPressure` | 0.084 | 0.077 |
| `latestDeployment` | 0.180 | 0.176 |
| `lifecycleJournal` | 4.092 | 3.933 |
| `liveness.conversation` | 16.191 | 10.674 |
| `liveness.project` | 0.719 | 0.208 |
| `maintenanceRuns` | 3.864 | 4.184 |
| `memoryProblems` | 126.076 | 1.176 |
| `now` | 0.008 | 0.015 |
| `pipelines` | 102.609 | 0.437 |
| `prepareRead` | — | 9.371 |
| `readState` | 4.499 | 3.784 |
| `recordDeploySnapshots` | 0.263 | 0.259 |
| `recordRuleReports` | 329.198 | 0.142 |
| `refreshLifecycle` | 15.437 | 14.284 |
| `registry` | 0.015 | 0.008 |
| `reports.log` | 24.399 | 0.125 |
| `retirementJournal` | 5.051 | 4.985 |
| `retirementReport` | 0.033 | 0.034 |
| `seatContextUsage` | 0.004 | 0.005 |
| `seatDeployments` | 0.049 | 0.046 |
| `seatFor` | 15.989 | 11.250 |
| `seatTurnOutcome` | 0.012 | 0.013 |
| `settings` | 1.255 | 0.408 |
| `tasks` | 101.227 | 0.276 |
| `workerAsks` | 0.094 | 0.102 |
| `workerCounts` | 21.500 | 24.742 |
| `writeState` | 9.027 | 6.368 |

## Changes and contracts

Seat startup fills shared task, pipeline and role-memory readers cooperatively. Tasks use the normalized read-only list; immutable pipeline bodies receive weak-keyed fingerprints, so unchanged evidence does not reserialize retained history. Alias and linked-machine context is captured once per synchronous pass. Task membership filtering precedes pipeline correlation.

The existing response worker reduces the exact operator summary to worker asks, reads report coverage and produces rule reports. Project liveness consumes the Viewer-certified persisted scan generation; generation changes refuse the result. Targeted conversation liveness retains its existing authority path. Queue and execution share one deadline; expired queued work never dispatches. Existing worker ownership, retirement and cleanup remain responsible for its process. New waits carry seat-tick operation and performance-phase labels.

The lifecycle journal remained below 5 ms and is unchanged. Archived pipelines were gated out of this replay; their cold reader now uses the same cooperative shared-list preparation, with existing selection and ordering.

No schema or persisted write format changed. Shared-reader producers are SqliteStateCollection cache publication and its existing revision/context validation; consumers include task list normalization, pipeline list membership/projections, seat gathering/evidence and memory-problem selection. Mutations retain keyed writers. Rule-report production still uses ruleReports and appendBridgeReports; coverage keeps the original manager/project filter, row order, default locale and owed-at semantics. Operator board callers still receive their original parsed representation; only seat agenda reduction consumes its raw body in the worker.

## Verification

History-flat and wake-equivalence tests were written before the implementation. The original source copied 22 rows at the smaller history and 202 at tenfold history; the replacement decodes and copies zero warm task/pipeline rows. Existing wake reasons, items and order remain covered. Additional tests cover immutable evidence replacement, cold-read refusal/retry, peer writes, worker restart, malformed input, queue expiry and scan-generation races.

Focused command: `bun test src/lib/monitor/seatTickSources.test.ts src/lib/state/sqliteStateStore.readCache.test.ts src/lib/scanner/filesResponseWorker.test.ts` — 152 pass, zero failures. These commands run through the gate-slot wrapper with isolated roots. Final typecheck, touched-tests comparison and publication-gate results are recorded in the stage report.
