# Main MCP, view and ESLint failures

Baseline: `857d34dec`. Each named test file was run separately with fresh
`LLV_STATE_DIR`, `XDG_CONFIG_HOME` and `TMPDIR` roots from `mktemp -d /tmp/...`.
Writer and stdio runs were admitted only with load1 at most 8. The test runner and
its descendants were recorded by PID and process start time; each completed
run had zero surviving children. No serving process was restarted or changed,
and no live conversation was used. The rejected baseline tick is described below.

The earlier child-cleanup review also reproduced the writer and stdio failures
at `bcc0e72a` and `0d54c0f03`, while proving that its owned processes were reaped.
Its conclusion was checked against the current code before this repair.

## Failure, cause and repair

No test was skipped, removed or assigned a larger timeout. Product behavior
stays unchanged. The rows distinguish stale expectations from fixture defects.

| Failure | Root cause class and origin | Fix (file:line) | Evidence |
| --- | --- | --- | --- |
| Writer: HTTP/MCP pipeline creates preserve both writes | Test harness defect after SQLite adoption (`dfa7447e8`, #956/#1870) and bounded delivery writes (`f8b7e62f5`). The JSON import barrier only gates the first process; subsequent writes read SQLite. | `src/lib/mcp/writerConcurrencyChild.ts:52`; `src/lib/mcp/writerConcurrency.test.ts:108` | Baseline `mcp.ready` timeout. Gate the bounded transaction after its first indexed read and keep the creator registry in SQLite; assert both authoritative rows survive and the second writer cannot enter before release. |
| Writer: HTTP pipeline start/MCP pipeline_action serialize | Same SQLite barrier defect | `src/lib/mcp/writerConcurrencyChild.ts:45`; `src/lib/mcp/writerConcurrency.test.ts:108` | Baseline `mcp.ready` timeout. Both transitions must persist as `provisioning` and cannot overlap the held collection lease. |
| Stdio: store reads independent of slow host, lease and HTTP call | Test harness defect after asynchronous close teardown (`286dac678`, #670). Its HTTP stub routes a controller wake through the slow search handler, creating a second snapshot. | `src/lib/mcp/stdio.integration.test.ts:159` | Baseline unexpected second `snapshot`. Route wakes separately; keep exactly one search/snapshot, the subsecond read bound, blocked closes and slow-call telemetry assertions. |
| Stdio: path-only send, late registration and restart | Test harness defect after SQLite adoption and backend resolution (`dfa7447e8`, `05345a9fc`). The parent retains a JSON registry which children have imported and retired. | `src/lib/mcp/stdio.integration.test.ts:489` | Baseline `viewer conversation is unknown`. The parent now writes continuity to the shared SQLite backend; the lost answer and restart still owe exactly one delivery. |
| Stdio: send_message terminal recovery, delayed timeout | Test harness defect: fault injection edits the retired JSON file | `src/lib/mcp/stdio.integration.test.ts:626`, `:1399` | Baseline ENOENT. Remove just this operation's SQLite evidence, assert its absence, retain caller authority and prove terminal receipt recovery survives restart. |
| Stdio: send_message terminal recovery, delayed reset | Same fault-injection defect | Same files and lines | Baseline ENOENT; same retained outcome and one-effect assertions across a killed host. |
| Stdio: spawn_agent terminal recovery, delayed timeout | Same fault-injection defect | Same files and lines | Baseline ENOENT; delete only the target launch receipt and retain independent caller receipts. |
| Stdio: spawn_agent terminal recovery, delayed reset | Same fault-injection defect | Same files and lines | Baseline ENOENT; same terminal identity and one-writer assertions across a killed host. |
| Stdio: send_message queued replay and terminal recovery | Same fault-injection defect | `src/lib/mcp/stdio.integration.test.ts:626`, `:1508` | Baseline ENOENT. Keep original admission replay distinct from the durable terminal lookup after evidence loss. |
| Stdio: spawn_agent queued replay and terminal recovery | Same fault-injection defect | Same files and lines | Baseline ENOENT; preserve exactly one launch, writer and original replay answer. |
| Bindings: graph edit caller and journal | Stale expectation after attributed attention dismissal (`b364b7f0d`). Dismissal now uses the shared authority-gated service. | `src/lib/mcp/bindings.test.ts:2537` | Baseline expects an extra un-attributed graph patch. Inject the dismissal authority/ports and assert successful dismissal plus its caller attribution separately from all five graph patches. |
| Bindings: own-project tick off | Stale expectation after report obligations (`0f5dae610`, #2236) | `src/lib/mcp/bindings.test.ts:3127` | Baseline exact-object mismatch. Assert the exact reminder and owed-report list, and keep the original 300-byte bound on the acknowledgement fields. |
| Bindings: another project's tick | Same stale expectation | `src/lib/mcp/bindings.test.ts:3239` | Baseline 462-byte total versus a 300-byte acknowledgement budget. Independently assert the new report fields and the unchanged acknowledgement budget and attribution. |
| View: materialized spawn path | Stale fixture after mandatory semantic titles (`1738d9be4`, #916) | `src/lib/view/view.test.ts:206` | Baseline title-required refusal. Give the new launch its intended title; retain the complete materialized-path assertions. |
| View: unresolved spawn stub | Same stale fixture | Same file and line | Baseline title-required refusal; retain typed-stub assertions. |
| ESLint crashes on react/display-name | Tool configuration defect: React plugin 7.37.5 uses context APIs removed in ESLint 10 and declares peers only through ESLint 9 | `eslint.config.mjs:2`, `:9`; `package.json` and `bun.lock` | Baseline `getFilename is not a function`. Pin `@eslint/compat` 2.1.1 and adapt the unchanged Next rule sets. Repository lint completes; touched files lint cleanly. |
| Stdio spawn proxy errors: intermittent missing writer effect | Test harness defect: the immediate-effect fixture loses its HTTP answer before deferred spawn work finishes | `src/lib/mcp/receiptStoreProbeChild.ts:184`, `:243`; `src/lib/mcp/stdio.integration.test.ts:1184` | Baseline expected three effects, received two. Hold the proxy answer until deferred work finishes; force a 150 ms writer delay while retaining every proxy status, body shape, replay and restart assertion. Held-effect tests still answer before execution. |
| Stdio send admitted before execution: intermittent in-flight recovery | Test harness defect: the recipient effect log is written before its durable settlement commit | `src/lib/mcp/receiptStoreProbeChild.ts:151`; `src/lib/mcp/stdio.integration.test.ts:968` | A third complete run reproduced an in-flight answer where the test expected settled. Force a 150 ms settlement gap and wait for the marker written after the registry commit; preserve every terminal state, resend and one-delivery assertion. |

The original 300-byte tests measured an acknowledgement before #2236 added
the reporting instructions. Separating those explicitly asserted instructions
from the acknowledgement retains the old size invariant and verifies the new
contract. The slow-read fixture similarly permits only the controller's wake
route alongside the one search route; arbitrary extra HTTP calls still fail.

Bindings register an in-process no-op controller tick (`bindings.test.ts:62`)
so fixture mutations cannot wake the default serving endpoint. The initial
baseline's default tick was rejected with HTTP 401; subsequent bindings runs
use this isolated controller seam.

The view file's existing redaction tests contained credential-shaped literals
and a fixed session identifier that the publication gate rejects when the file
is touched. Those synthetic redaction inputs are now assembled at runtime, and
the synthetic session uses a generated UUID. Every original redaction assertion
remains exercised.

ESLint's removed rule-context APIs are documented in the
[ESLint 10 migration guide](https://eslint.org/docs/latest/use/migrate-to-10.0.0).
The installed compatibility package declares ESLint 10 support and supplies the
removed methods; no configured lint rule is disabled.

## Verification

Baseline results: writer **3 pass / 2 fail**, stdio **22 pass / 9 fail**,
bindings **83 pass / 3 fail**, view **22 pass / 2 fail**. The ninth stdio failure
is the intermittent proxy writer race above. The stdio baseline recorded 272
processes and the writer baseline recorded 12, with zero survivors in both.

Repository `bun run lint` completes with **509 errors / 263 warnings** in
unchanged source, prototypes and tests. The 509 error locations and rule names
are listed in [lint-errors.json](../../evidence/mcp-main-checks/lint-errors.json).
They are outside this repair's source scope. The changed config and all six
changed TypeScript test/fixture files pass a separate lint invocation.

The proxy regression's red path was checked by temporarily removing only the
fixture's deferred-work wait, retaining the forced 150 ms writer delay. The
spawn proxy test failed at its first effect assertion: **expected 1, received
0**. Four recorded processes had zero survivors. The fixture was restored
byte-for-byte before running the complete file.

The first two stdio repeats passed 31/31, while the third exposed the second
race above (30 pass / 1 fail). Its 379 recorded processes had zero survivors.
The effect-only wait was then restored temporarily with the new settlement
delay retained: the targeted send test failed with a legitimate `in-flight`
answer before settlement. Six recorded processes had zero survivors. The
post-commit-marker wait was restored byte-for-byte before the final repeats.

Final results at the committed source, each test file run separately three times:

| File | Pass / fail on each run | Recorded processes (runs 1 / 2 / 3) | Survivors after each run |
| --- | --- | --- | --- |
| `src/lib/mcp/writerConcurrency.test.ts` | 5 / 0, 5 / 0, 5 / 0 | 17 / 14 / 13 | 0 / 0 / 0 |
| `src/lib/mcp/stdio.integration.test.ts` | 31 / 0, 31 / 0, 31 / 0 | 381 / 356 / 351 | 0 / 0 / 0 |
| `src/lib/mcp/bindings.test.ts` | 86 / 0, 86 / 0, 86 / 0 | 2 / 2 / 2 | 0 / 0 / 0 |
| `src/lib/view/view.test.ts` | 24 / 0, 24 / 0, 24 / 0 | 1 / 1 / 1 | 0 / 0 / 0 |

The twelve final runs contain 1,141 process records. Their PID/start-time pairs
were checked again before commit, with zero survivors. Load gates deferred
starts without launching a test whenever writer/stdio load1 exceeded 8.
[verification.json](../../evidence/mcp-main-checks/verification.json) records the
run matrix, timings, start loads, read latencies and regression red paths.

`tsc --noEmit`, touched-file lint, the privacy-publication gate with commit
checking, and `bun install --frozen-lockfile` pass. Repository lint completes
with the explicitly listed out-of-scope diagnostics above. The final diff was
reviewed for unchanged assertions, correct commit barriers, isolated authority,
fenced-file ownership and publication privacy. No fenced source file changed.
