# Seat check L8 replay

The complete copied-state check passes the 100 ms loop bound and the 50 ms synchronous-source bound in all six after runs. Raw per-source calls, synchronous entry times, awaited wall times, load averages and timestamps are in `evidence/perf/seat-tick-check.json`.

## Conditions

`scripts/probe-seat-tick.ts` implements the M4 T9-check adapter. Both sides used Bun 1.4.0 and the same immutable seed restored to the same private path. The base was `7ac695acc0ce`; source fingerprints identify each measured tree. The seed was copied at 2026-10-18T23:49:48.556286+00:00. No controller ran against live state.

There were 243 hot pipelines (30,598,219 JSON characters), 990 archived pipelines (118,732,125), 2,494 tasks (9,939,576), 4,003 role-memory rows (16,649,217), and a 33,193,663-byte summary. The observed fleet was five live agents, three running; copied registry statuses separately reported 39 live/idle and nine live. The fleet observation marked its catalogue stale. Per-run load averages accompany every sample.

HOME, XDG_CONFIG_HOME, TMPDIR, CODEX_HOME and LLV_STATE_DIR were private. The control URL used a verified closed loopback port. NODE_ENV=test prevents an imported inbox from resolving outside the sandbox. gh and dispatch effects were stubbed; transcript evidence was suppressed in parent and worker. Date.now was fixed at the seed timestamp; performance timers remained real. Module imports, inert summary/catalogue decoding and the registry scale count precede run 0. Task, pipeline and memory lists start cold.

The copied state conservatively returns an error because child-ledger evidence was omitted. Both sides produce the same ledger-gap failure code, error verdict, empty reasons and zero items on every run. This measures the complete check through that evidence gap; deterministic controller tests cover wake content and dispatch. It makes no production overlap-per-hour claim.

## Complete check

All values are milliseconds. Wall time includes asynchronous work; loop interval is the largest interval observed by the 1 ms timer, including the final continuation.

| Run | Before wall | After wall | Before loop | After loop | Before largest sync entry | After largest sync entry |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 7236.15 | 8193.05 | 751.48 | 67.36 | 341.75 | 35.48 |
| 1 | 1206.01 | 1015.75 | 594.34 | 62.65 | 212.73 | 22.55 |
| 2 | 1191.15 | 947.99 | 580.29 | 57.63 | 217.65 | 30.88 |
| 3 | 1187.71 | 985.08 | 585.57 | 51.61 | 213.73 | 21.70 |
| 4 | 1284.20 | 801.63 | 641.37 | 42.95 | 219.73 | 20.51 |
| 5 | 1237.73 | 818.11 | 606.66 | 47.49 | 213.11 | 19.85 |

## Sources

Maximum synchronous entry per source across the six runs. Async continuations are additionally bounded by the complete-check loop measurement. A dash means the source did not exist or its branch was gated out. All six individual samples and awaited times remain in the JSON artifact.

| Source | Before ms | After ms |
| --- | ---: | ---: |
| `appendRecord` | 0.866 | 1.327 |
| `diskPressure` | 0.086 | 0.123 |
| `latestDeployment` | 0.179 | 0.196 |
| `lifecycleJournal` | 3.742 | 5.295 |
| `liveness.conversation` | 15.501 | 12.103 |
| `liveness.project` | 0.673 | 0.149 |
| `maintenanceRuns` | 3.563 | 4.554 |
| `memoryProblems` | 121.232 | 0.912 |
| `now` | 0.006 | 0.007 |
| `pipelines` | 95.644 | 0.564 |
| `prepareRead` | — | 9.889 |
| `readState` | 3.955 | 3.844 |
| `recordDeploySnapshots` | 0.274 | 0.388 |
| `recordRuleReports` | 341.747 | 0.169 |
| `refreshLifecycle` | 14.705 | 16.182 |
| `registry` | 0.006 | 0.017 |
| `reports.log` | 21.316 | 0.210 |
| `retirementJournal` | 5.087 | 5.670 |
| `retirementReport` | 0.036 | 0.038 |
| `seatContextUsage` | 0.004 | 0.012 |
| `seatDeployments` | 0.049 | 0.045 |
| `seatFor` | 16.152 | 13.947 |
| `seatTurnOutcome` | 0.012 | 0.037 |
| `settings` | 0.519 | 0.692 |
| `tasks` | 94.029 | 0.699 |
| `workerAsks` | 0.097 | 0.123 |
| `workerCounts` | 21.231 | 35.476 |
| `writeState` | 6.995 | 12.857 |

## Changes and contracts

Seat startup fills shared task, pipeline and role-memory readers cooperatively. Tasks use the normalized read-only list; immutable pipeline bodies receive weak-keyed fingerprints, so unchanged evidence does not reserialize retained history. Alias and linked-machine context is captured once per synchronous pass. Task membership filtering precedes pipeline correlation.

The existing response worker reduces the exact operator summary to worker asks, reads report coverage and produces rule reports. Project liveness consumes the Viewer-certified persisted scan generation; generation changes refuse the result. Targeted conversation liveness retains its existing authority path. Queue and execution share one deadline; expired queued work never dispatches. Existing worker ownership, retirement and cleanup remain responsible for its process. The report helper in `src/lib/monitor/seatTickReports.ts` keeps controller imports outside the worker and resolves the channel cursor before the report transaction, including on a cold worker. New waits carry seat-tick operation and performance-phase labels.

The lifecycle journal peaked at 5.30 ms after the change and is unchanged. Archived pipelines were gated out of this replay; their cold reader now uses the same cooperative shared-list preparation, with existing selection and ordering.

No schema or persisted write format changed. Shared-reader producers are SqliteStateCollection cache publication and its existing revision/context validation; consumers include task list normalization, pipeline list membership/projections, seat gathering/evidence and memory-problem selection. Mutations retain keyed writers. Rule-report production still uses ruleReports and appendBridgeReports; coverage keeps the original manager/project filter, row order, default locale and owed-at semantics. Operator board callers still receive their original parsed representation; only seat agenda reduction consumes its raw body in the worker.

## Verification

History-flat and wake-equivalence tests were written before the implementation. The original source copied 22 rows at the smaller history and 202 at tenfold history; the replacement decodes and copies zero warm task/pipeline rows. Existing wake reasons, items and order remain covered. Additional tests cover immutable evidence replacement, cold-read refusal/retry, peer writes, worker restart, malformed input, queue expiry and scan-generation races.

Focused command: `bun test src/lib/monitor/seatTickSources.test.ts src/lib/state/sqliteStateStore.readCache.test.ts src/lib/scanner/filesResponseWorker.test.ts` — 153 pass, zero failures. These commands run through the gate-slot wrapper with isolated roots. The isolated production build and compiled worker checks pass: ordered asks, malformed input, outside-directory refusals, certified liveness, durable reports and restart deduplication. The same build on the base also passes. Final typecheck, touched-tests comparison and publication-gate results are recorded in the stage report.
