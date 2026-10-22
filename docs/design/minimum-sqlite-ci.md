# Minimum SQLite CI failures

## Observation (2026-10-22)

The five reported jobs contain two timing assumptions in test code. Three
children exit successfully and emit a successful state-admission diagnostic;
their parents require empty stderr. The other two jobs lose a workflow writer
while its fixture resolves role defaults outside async admission.

Read each original log with
`gh api repos/{owner}/{repo}/actions/jobs/JOB_ID/logs`.

| Run | Job | Failing case | Observed cause |
| --- | --- | --- | --- |
| 39682318489 | 119507618061 | Persisted conversation text after restart | Exit 0; `catalog.search.open` logs success after 74.7 ms; empty-stderr assertion fails. |
| 39682318489 | 119513814179 | Two workflow writers | `StateLockDeferredError` at `state.marker` while reading `role_presets`; child exits unsuccessfully. |
| 39716599771 | 119620374757 | 64 MiB memory archive after restart | Exit 0; `memory.delivery` logs success after 55.6 ms; empty-stderr assertion fails. |
| 39716599771 | 119627809320 | Reference schema upgrade in a fresh process | Exit 0; `state.schema` logs success after 72.1 ms; empty-stderr assertion fails. |
| 39716599771 | 119633910917 | Two workflow writers | `StateLockDeferredError` at `state.marker` while reading `role_presets`; child exits unsuccessfully. |

`src/lib/blockingWaits.ts:recordBlockingWait` emits state-write diagnostics
after 50 ms, including successful operations with a single attempt and zero
backoff. Elapsed time includes filesystem work and scheduling. Successful
stderr output therefore varies with runner timing.

The workflow fixture calls `normalizeTemplate`, which resolves a missing
fixer through `loadRoleDefinitionsOrDefaults`, `loadRoleOverrides` and
`LegacyDocumentStore.readExisting`. Its marker probe reaches `readStateImport`
and `stateLockAttempt`. The fixture's existing `workflows.open` admission
covers only the later workflow read. A competing process can make the earlier
marker read defer.

## Runner and SQLite boundaries

`.github/workflows/platform-tests.yml:minimum-sqlite` runs explicit files
sequentially on Ubuntu with Bun 1.4.0 at the observed revision. Each file gets
a fresh runner-temp HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR. The Bun
test preload further isolates temporary files. Cross-process writers within
one case deliberately share a database.

The job builds upstream SQLite 3.39.4 and substitutes it through
`minimumSqlite.preload.ts` in the collecting test process. Child fixtures use
Bun's native SQLite. The affected state, memory-delivery and catalog admission
paths use a zero busy timeout; the state and catalog stores also enable WAL.
`waitForStateLock` owns asynchronous retry. Increasing
SQLite's busy timeout would change that contract. The failures provide no
evidence of a 3.39 locking or WAL incompatibility.

The first log's disk-full lease probes and locked-database probes occur inside
passing `stateLeaseRecovery.test.ts` cases. Its malformed
`storage-incidents.json` message belongs to the passing unreadable-incident
case in `durability.test.ts`. The log has no disk-free measurement, so it
cannot establish the runner's remaining capacity. These messages come from
explicit fault tests with separate state roots from the failed restart case.

An earlier repair in `src/lib/mcp/bindings.test.ts` already recognizes
structured state-write diagnostics from successful children. The restart
tests here accept successful state-write diagnostics, plus async `waiting`
records followed by success with the same process, call site, subject and
operation id. They reject unmatched waits, every unsuccessful exit, refusal,
malformed record and unexpected stderr line.

## Regression coverage

`src/lib/state/stateChildResult.fixture.ts` checks results for the conversation
restart, memory archive and reference-upgrade children. Their persisted-row,
byte-bound, schema and content assertions still run. Its controls in
`minimumSqlite.test.ts` use the real diagnostic producer with a supplied 75 ms
duration, and test rejected stderr and exit statuses separately.

`src/lib/state/hotStateStores.sqliteChild.ts` admits template normalization
through `waitForStateLock` before loading and saving workflows. The regression
in `hotStateStores.sqlite.test.ts` holds an exclusive rollback-journal lock
across the real child's marker read. It releases only after the child's
complete diagnostic record arrives, then checks the committed workflow row.
The unmodified fixture exits with the same marker deferral as the CI logs.
The existing two-writer tests still check both rows and exactly two revisions.

## Publication follow-up

After publication, record the new pull request's Platform tests run id and
minimum-sqlite job id. Re-run that job at least three times with
`gh run rerun RUN_ID --job JOB_ID`, recording each attempt's job id and result
with `gh api repos/{owner}/{repo}/actions/runs/RUN_ID/attempts/ATTEMPT/jobs`.
Re-running either historical run above exercises its original revision and
cannot establish stability of the published fix.
