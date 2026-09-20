# Role prompt pilot

Status: harness repair; **zero real model trials**. Root owns model admission, visible Viewer sessions, independent review, the nine-cell pilot and seeded-review calibration. Local controls do not complete the task or justify routing changes.

The fixtures execute quota horizon routing, mounted error/retry rows, and sanitize-before-truncate diagnostics. Support closures have source/export hashes. Preparation makes twelve clean repositories: A, B, C and planner per case. Shared task/support/public vectors are identical. Controls are source packaged as `.txt`, copied to actual candidate module paths and executed by the same grader.

Backend candidate execution uses `bwrap --unshare-all --clearenv`, with source, worker entry, interpreter and libraries mounted; private roots and network are absent. UI grading uses the existing kanban browser driver and denies external browser requests. It exercises real touch, keyboard, pending deduplication, failure/reorder identity and successful retry, with geometry/contrast checks and 36 screenshots. Private UI regressions add another 36. An independent reviewer must inspect their pixels.

The UI bundler and Viewer sessions retain their root-managed process permissions. Clean history and prompt instructions do not provide filesystem confinement. Root must verify trial-session restrictions before real workers start; this harness does not sandbox Viewer agents. Keep sealed graders/holdouts, signing key and evidence outside candidate workspaces and reachable Git history. Only root writes the trusted directory. Candidate-supplied evidence must never be copied into it.

## Root commands

Isolate HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME, LLV_STATE_DIR, CODEX_HOME, CLAUDE_CONFIG_DIR and short TMPDIR before imports. Remove inherited live sockets, owner tokens and credentials. Require fresh `MemAvailable >= 8388608 KiB` and one foreground heavy command. Dependencies: locked packages, Git, tar, Bun, bwrap and Chromium (`CHROME_BIN`). Browser listeners bind port 0 and close by their returned handle.

Set `SEALED_ROOT`, `RUN_ROOT`, `CANDIDATES` to persistent directories outside this repository; the local handoff names the existing sealed package. Its contents are absent from the PR. Initial grading verifies both private commitments and never executes reserved holdouts.

```sh
bun scripts/role-eval.ts validate "$SEALED_ROOT"
bun scripts/role-eval.ts prepare "$CANDIDATES" "$SEALED_ROOT"
bun scripts/role-eval.ts init "$RUN_ROOT" "$(git rev-parse HEAD)"
bun scripts/role-eval.ts plan "$RUN_ROOT" "$RUN_ROOT/request.json"
bun scripts/role-eval.ts ingest "$RUN_ROOT" "$RUN_ROOT/receipt.json"
bun scripts/role-eval.ts freeze "$RUN_ROOT" quota-window planner-transcript.json
bun scripts/role-eval.ts grade "$RUN_ROOT" "$SEALED_ROOT" quota-window-A "$CANDIDATES/quota-window-A"
bun scripts/role-eval.ts score "$RUN_ROOT" quota-window-A
```

Preparation/init refuse existing artifacts. Plan validates current dataset bytes and durably reserves one intent/receipt before exporting a Viewer request. Planned, admitted and unknown receipts fence every next request. Replanning yields only the original payload with `recoveryOnly:true`. Root dispatches and recovers through Viewer; the harness never dispatches or schedules models. Ingest forbids outcome regression and changes to key, payload, observed model, conversation or completed head. Every stage needs a fresh conversation.

Initialization persists a unique run ID once; every planner, assessor, builder and reviewer request key includes it. Independent runs remain distinct even with identical workspaces, dataset and harness head. Reopening a run retains its ID, keys and payloads. Preserve older ledgers without a run ID for original-key Viewer readback; initialize a separate run for new work.

Request JSON contains `models`, `identity:{taskId,parentConversationId,src,cwd}` and optional `stage`. Model entries follow `ModelEvidence`; their root-produced discovery file contains `engine`, `runtimeVersion`, `models:[{launchAlias,resolvedModel,effort}]`. Missing supported exact-model evidence blocks planning. Sonnet uses engine `claude`, launch alias `sonnet`, requested/observed model `sonnet-5`; registry labels alone cannot prove runtime identity.

Generate all briefs before candidate work:

1. Plan `stage:{caseId,kind:"planner"}` in the `-planner` workspace. Root dispatches and ingests actual admitted/completed receipts, using the unchanged base as candidate/published head. Export the Viewer conversation to trusted root, newest-first records following `ViewerExport`.
2. Run `freeze` to preserve the exact final planner bytes once. Plan `stage:{caseId,kind:"brief-assessor",briefFile:"briefs/<case>/brief.md"}`. A fresh Astra medium assessor checks each `briefCoverage` field and absence of executable or algorithm-complete handoff, including prose.
3. Ingest assessor receipts and export its transcript. Root writes `briefs/<case>/approval.json` following `BriefApproval`, linking both root-reserved intents, completed receipts, transcript files, frozen hash and coverage rationales. Its final assessment must approve that hash. Keyword detection never establishes no-code compliance.

For candidates omit `stage`, select the next prepared workspace and dispatch the exported payload. Order: quota A/B/C, UI B/C/A, diagnostics C/A/B. B alone appends its verified frozen brief. After terminal readback, ingest the completed candidate and run `grade`.

Plan review with `stage:{caseId,kind:"reviewer",candidateCellId}` and a clean checkout at the completed head. Payloads carry `reviews`, fresh mode, one pass and `diffSource`. Give the reviewer anonymized logs/screenshots without private grader/holdout code; withhold model/arm labels where feasible. Root writes `reviews/<cell>.json` following `ReviewApproval`: reserved reviewer intent/receipt, Viewer transcript, exact head, inspected image hashes, and its audit of the candidate's complete tool/action transcript. Missing audits cannot pass.

Grade exports committed bytes, rejects forbidden-file changes, executes public/private checks, records environment hashes and signs the result. Score verifies the root signature, recomputes bytes and rejects stale candidate/head/dataset/grader bindings. Independent final-head approval is mandatory. Preserve first-attempt failures. Later repairs use separately recorded existing Viewer flows; do not overwrite completed receipts or call repaired results first-attempt correctness.

## Verification and remaining work

```sh
bun test evals/roles/manifest.test.ts evals/roles/isolation.test.ts evals/roles/controls.test.ts evals/roles/scoring.test.ts evals/roles/lifecycle.test.ts
bunx tsc --noEmit --incremental false
bun scripts/role-eval.ts control error-row correct "$CONTROL_EXPORT"
LLV_KANBAN_BROWSER_TEST=1 ROLE_EVAL_CANDIDATE="$CONTROL_EXPORT" ROLE_EVAL_OUTPUT="$OUTPUT" bun test src/components/kanban/kanbanBoard.browser.test.tsx -t 'role evaluation mounted candidate'
```

Lifecycle tests exercise production MCP/SQLite with injected lost acknowledgement and select two existing flow-engine seam tests. The browser command must pass correct source and reject both defective controls. These are local/synthetic checks, with no real model calls.

Root owes nine implementations/reviews, six blind seeded reviews (three clean/three buggy), a real quota review → fix → fresh review calibration, audits, measurements and a reviewed report. Baseline: 32 visible requests (3 planners, 3 brief assessors, 9 builders, 9 reviewers, 6 seeded reviewers, calibration fixer/reviewer). At most one repair/re-review per cell gives a ceiling of 50. Project cap is three including unrelated workers; run one eval worker at a time. Unknown outcomes retain their slot.

Report per-case denominators, first-pass/after-repair outcomes, valid/false/missed findings, admission failures, unknown measurements and separate preparation/calibration overhead. Keep provider usage and tool/build/queue/provider timing separate. Dollars require a verified dated price source. Nine one-off cells remain exploratory; holdouts stay reserved. Completion requires the real pilot, calibration and independent exact-head review of results. No merge/deployment is included.
