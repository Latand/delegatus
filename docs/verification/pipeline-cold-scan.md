The controller aborts reconciliation when the shared scanner has no complete generation. This also makes MCP project resolution report a non-retryable tool failure before it can resolve a project.

## Step one: observation before the fix

The deployment ledger names `40451576b3eece32dbfd1d6b87e8a2f9846f1905` as the serving release, promoted at 2026-10-12 23:37:40Z; the previous release `8f1cfd53081315f07780328c46e0d9c2278a153e` was promoted at 23:05:39Z. The deployed versions of the throw site and controller caller were checked with `git show`.

Read-only `journalctl --user -u delegatus.service` observations:

| UTC window on 2026-10-12 | Scan-phase incomplete failures | Watchdog incomplete failures | Tick HTTP-500 log occurrences |
| --- | ---: | ---: | ---: |
| 22:00:55–23:00:55 | 0 | 0 | 0 |
| 23:05:39–23:35:04 | 17 | 14 | 6 |
| 23:37:40–23:44 (observation still ongoing) | 9 | 3 | 3 |

These are log occurrences, with different windows from the original report. The stack points to `.next/server/chunks/85097.js`. No live process or state was changed.

### Throw site and callers

- `src/lib/scanner/scanCache.ts`: `fileScanRefreshPromise` rejects a returned snapshot whose `complete` is false (line 553 on the observed base). The legacy-refresh and pinned-refresh paths enforce the same contract at lines 492 and 638. The rejected generation is never published as a completed snapshot.
- `src/lib/scanner/index.ts`: `scanFiles` returns complete only when discovery and every selected entry's derivation are complete. Unreadable/changing transcripts and incomplete tail rows can invalidate the whole snapshot. A scan being slow alone does not explain a returned `complete: false`.
- Tick: `POST /api/pipelines/tick` → `flowPipelineController().tick` → `runCycle` → `controllerFileScan` → `completedFileScan` → `fileScanRefreshPromise`. `runCycle` rethrows the scan-phase failure; Next answers 500. The remote signalling client then logs its rejected tick.
- Watchdog: `startFlowPipelineControllerRuntime` → controller poll → the same scan phase; its catch logs reconciliation failure.
- MCP: orchestrator project resolution calls `dependencies.completedFileScan()` when aliases, seats, caller and registry cannot resolve the requested name. Its pre-receipt admission hook receives a plain Error; `createMcpToolService` returns `tool_failed`, `retryable: false`.

### Changes in the release range

#2762 changed archive/history readers, projection passes and startup costs, including scanner pin-family projections. It did not change the three incomplete-scan throw sites or the controller's rejection policy. #2801 added owner-approved group-history tools, #2800 changed task-card presentation, and #2792 added verified automatic-release preparation after the serving release. The observed caller policy is present at the serving commit and at this pipeline's base. The isolated reproduction establishes that policy as the bug; it does not claim to prove which production transcript made the observed generation incomplete.

### Isolated reproduction

Ran the unchanged production build at pipeline base `81589bce79f96127a7db188d4f378f24e382f9e2` using `next start -H 127.0.0.1 -p 0`, under the owned gate runner, with a private HOME, XDG config, TMPDIR, Claude task root and state. The fixture used the existing `buildRegistryPerformanceDataset`: 30,036 registry rows, 27,836 archived, 320 synthetic transcripts. It left no completed scan snapshot on disk. Synthetic workers were disabled. Only the run's recorded child PID was stopped.

One selected transcript ended in an unfinished JSONL row; this exercises the real worker's incomplete derivation without changing scanner code or injecting a mock scan. Server readiness took 255 ms after the 5,407 ms dataset seed. Four successive tick requests answered **500**, taking **5,400 / 1,064 / 1,114 / 1,151 ms**. The private Viewer log reported the same `filesystem scan incomplete` scan-phase exception and compiled chunk as production.

Repairing only that synthetic row made all four subsequent ticks answer **202** (the existing success status), taking **1,666 / 28 / 19 / 15 ms**. The repaired phase lasted 2,729 ms; the full run lasted 17,121 ms. This is a causal reproduction of the incomplete-generation caller policy. The production entry that made the scan incomplete remains unidentified.

This observation was committed and published in the draft PR before the regression tests or product fix were written.

## Fix and regression evidence

`completedFileScan({ wait: false })` starts or joins the shared generation and keeps it alive independently of the caller. It serves an existing completed snapshot once catalog membership is confirmed; a changed membership defers the read until its new generation completes. Without one it returns a typed incomplete-inventory error; failed, incomplete snapshots remain unpersisted. Unexpected scan errors are retained and propagated on the next read. The default waiting contract and the archive/history implementations are unchanged.

The controller defers the scan-dependent flow phase, records that deferral in its journal, and continues pipeline settlement and the independent sweeps. Successful ticks answer 200. The MCP completed-scan adapter returns `scan_incomplete`, `retryable: true`, `retryAfterSeconds: 5`, with “still scanning, retry in 5 s”. Admission and fresh binding preserve that pre-dispatch refusal without claiming a receipt; the same request key can be retried. Targeted reads keep their existing signalled catalog budget and fallback.

Failing-first checks on the unchanged implementation:

- `src/lib/pipelines/coldScan.test.ts`: the held generation prevented a response within the 250 ms observation window; an incomplete generation threw `filesystem scan incomplete`.
- `src/lib/mcp/coldScan.test.ts`: the production binding and recovery service returned `tool_failed`, `retryable: false`, for an orchestrator send.

After the fix, the tests prove 200 while the generation is held, useful pipeline work, deferred flow work, resumption after completion, preservation of unrelated scanner failures, retryable send and ordinary admission, rejection of an old snapshot while new catalog membership is being derived, no claimed receipt or control write, and normal same-key validation after completion.

## Production build cold-start verification

The rebuilt Viewer ran under the owned gate runner with a fresh private HOME/XDG/TMPDIR/state and a port assigned by `next start -p 0`. The same dataset contained 30,036 rows, 27,836 archived and 320 transcripts. Dataset seed: **4,748 ms**. Server readiness after seed: **256 ms**.

| Phase | Requests | HTTP status | Durations, ms |
| --- | ---: | --- | --- |
| Unfinished synthetic JSONL row | 4 | all 200 | 2,639 / 9 / 13 / 9 |
| Repaired row, scan still running | 4 | all 200 | 11 / 9 / 12 / 10 |
| Complete snapshot available | 4 | all 200 | 484 / 25 / 17 / 17 |

The initial request includes route loading. A complete **320-file** snapshot was persisted **1,044 ms after repair**. The full run took **14,266 ms**, including four deliberately spaced incomplete-phase requests. **Zero tick 500s; zero incomplete-scan phase/watchdog failure lines.** The private journal instead records the scan-dependent phase being skipped. The run stopped only its recorded child PID. No deployment was performed.

## Checks

All test files ran by explicit path, each with private state, HOME, XDG and temporary roots, through `scripts/gate-slot.sh`:

- Controller cold-scan regressions: 3 pass; MCP cold-scan regressions: 2 pass (send, ordinary admission and changed catalog membership); tick route: 1 pass; controller: 9 pass.
- MCP server: 89 pass; orchestrator send recovery: 6 pass; files route: 131 pass.
- Real scanner cache: 17 pass, 2 failures also present on base `81589bce79f96127a7db188d4f378f24e382f9e2`. The project's baseline comparator reports **0 new failures**. The two pre-existing failures concern persisted Codex tail rereads and multi-megabyte warm starts.
- Production build and MCP bundle: pass. Full TypeScript and touched-file ESLint pass; the publication gate also verifies them.

Registry archive/index/projection code from #2762 is unchanged. The same large-history fixture completes through the real scanner and production routes; the existing files and receipt checks preserve their behavior. Voice reads, voice memory, and gate/CI implementation were left untouched.
