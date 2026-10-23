# Conversation catalog startup measurement

On 2026-10-23, three paired fresh-process samples reduced median time from Viewer process spawn through the first catalog body from **2,928.3 ms to 2,059.9 ms** (29.7%). The first summary request fell from **101.9 ms to 19.2 ms**. Each response contained the same 183 transcript paths and 350,989 bytes.

| Measurement | Base median (range), ms | Candidate median (range), ms |
| --- | ---: | ---: |
| First document request through body | 2,616.9 (2,473.2–2,674.0) | 1,889.6 (1,865.9–2,376.0) |
| First summary request through body | 101.9 (79.6–109.6) | 19.2 (14.3–71.6) |
| Process spawn through summary body | 2,928.3 (2,729.2–2,929.2) | 2,059.9 (2,031.5–2,651.5) |
| Initial summary cache state | miss, miss, miss | bootstrap, bootstrap, bootstrap |

## Cause and change

At base `134a29c6`, `src/lib/viewerInstrumentation.ts:1058` awaited attention reconciliation inside board preparation. `src/lib/attention/reconcileController.ts:75` supplies the fresh operator board as its source, and line 140 awaits it. This rebuilt the catalog before readiness even when a validated persistent summary was available. Paired baseline Server-Timing reported a 1,386.1–1,510.4 ms scan. The startup journals show the overlapping scanner/controller work; operation durations overlap and cannot be added together.

`src/lib/viewerInstrumentation.ts:858` now publishes readiness before starting refinement. The production callback at line 1064 retains the startup barrier, authority checks, and the `attention.reconcile` monitoring label. Retirement still joins the work; a rejected refinement logs its failure. Tests hold the refinement across readiness and retirement, and exercise its rejection.

The existing persistent summary supplies the response. Its writer, schema, bounds, validation, streaming, and replacement policy stay as implemented in `src/lib/scanner/summaryBootstrap.ts` and `src/app/api/files/operatorProjection.ts:654`. Missing or invalid artifacts use the existing first-build path. No second cache was added.

`src/hooks/useFiles.ts:708` recognizes server bootstrap responses. The incoming snapshot at line 785 stays cached, unloaded, and uncertified through incomplete 200/304 replies until a current generation arrives. It cannot become a certified persisted browser snapshot or certify another scope. A refusal clears it. The existing translated “updating” state in `src/components/ProjectDashboard.tsx:2212` shows its provisional status.

## Procedure and limits

Both production builds used base `134a29c63d68d6934d6222c89d5103df3ab4721c`, Bun 1.4.0, Next 16.4.1, and identical dependencies. The candidate includes the source changes whose SHA-256 values are recorded in [the evidence](../../evidence/conversation-catalog-startup.json). Base and candidate used the identical repaired profile driver. `scripts/profile-reopen.ts:396` follows the application's delegated conversation link handler for in-app navigation; assigning the hash had exercised the cold resolver and timed out during calibration. The driver also pins its control URL to a closed loopback port and disables telemetry.

The existing `scripts/profile-reopen.ts` seeded 183 transcripts across ten projects, with 12-record and 12,000-record targets (5 kB and 4,800 kB in the final fixture). The browser run used Chrome for Testing 151.0.7922.34, desktop 1280×800 and phone 390×844. Cold opens, reloads, in-app returns, and appended rows completed; appended rows retained the first row node. This final browser run has one sample per case and establishes behavior. It does not establish a general reopen speed improvement.

After that run, one fresh-process warmup per build preceded the measured sequence **base, candidate, candidate, base, base, candidate**. Each process received one document request followed by one summary request, without a browser or concurrent writer. Each run waited for fresh refinement before stopping its own server. Transcript content, path, size, and mtime hashes matched across all eight runs. Each build had a validated saved artifact available at startup. Samples ran at 15:17:53–15:18:10 UTC; raw UTC stamps, load observations, build IDs, and every sample are in the evidence.

All runs used private HOME, XDG, state, provider, and temporary roots. The built-server comparison ran through the local admission wrapper after the remote measurement environment showed heavy memory/swap pressure. Required tests, types, and lint ran through `gate-remote`. Earlier three-sample browser and restart measurements remain in the evidence, including a 71.4-second cold-open outlier and a 20.6-second append. Their journal's largest loop gap was 51,458 ms. Those runs do not support an overall startup comparison. The paired comparison above supplies that comparison. Remaining paired startup loop gaps reach 864 ms on base and 829 ms on candidate; startup still has other work.

[Journal diagnostics](../../evidence/conversation-catalog-startup.journal.jsonl) retain loop-gap, performance-summary, and blocking-wait records, including their partial/unavailable attribution fields.

## Checks

The build, profile, probe, typecheck, lint, and importer commands have their exit codes and explicit test paths recorded in the evidence. Temporary device and process UUIDs are replaced with stable fixture labels in the published records; timing values are preserved.

| Check | Exit and outcome |
| --- | --- |
| Local baseline and candidate production builds | 0 each |
| Final built-server browser profile and paired restart probe | 0 each |
| Remote importer campaign, 52 explicit files | 45 files exit 0; six exit 1; one exit 124 |
| Project comparison gate against base for the seven red files | 0: zero new failures, 20 existing assertions and one existing runner timeout |
| Final remote snapshot tests | 0: 12 passed |
| Final remote typecheck | 0 |
| Final remote ESLint on all five touched TypeScript files | 0: zero introduced errors |

`src/lib/links/boardSync.test.ts` did not finish in the initial 900-second run or the comparison gate's 300-second runs on either revision. Its test outcome remains incomplete. The project gate accepts the matching runner failure as pre-existing; it is not counted among passing files. An initial typecheck caught a new test's partial fixture assertion; that assertion was corrected before the final checks and measurement. No workflow was edited.
