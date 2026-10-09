# Review budgets are chosen at creation; spent budgets merge

## Corrected requirement

The operator corrected outcome 1 on 2026-10-09 at about 08:50 Kyiv:
pick the review rounds when creating the gate, using the role or mandate default
when none is supplied. Afterwards the budget can decrease and never grows.
There is no global five-round ceiling. The existing finite schema bound remains
1–9 and the default remains 3.

Outcomes 2–5 remain: a spent terminal review completes, the project merge setting
and required checks govern its merge, the last kept findings become one follow-up
task, and the board and `list_pipelines` distinguish budget spent from a clean pass.

## Budget admission

- `limits.ts` keeps `MAX_FAIL_EDGE_ROUNDS = 9` as the schema bound.
  `engine.ts` validates creation and stage additions against it. Drafts may edit
  their budget within that bound; persisted records reload unchanged.
- `continueReview` refuses every new `addRounds` grant with a plain creation-time
  reason, before any grant, cursor or state write. Existing receipts still replay;
  stored historical grants retain their routing and cumulative accounting.
- `set-edge` preserves the existing budget when omitted. Once the lane has started,
  an existing gate can only keep or lower `maxRounds`. Its edge cannot be cleared
  and recreated to obtain a larger budget. A newly added stage chooses its own
  budget when created.
- After traversal, the fail target and exhaustion policy remain frozen evidence.
  A budget-only decrease succeeds without changing the cursor or attempt records.
  An omitted exhaustion policy preserves the existing one. Bound attempt
  definitions retain the original evidence; future routing reads the lowered
  stage budget.
- `override-stage` accepts runtime and prompt edits. `maxRounds` there is refused
  as an unsupported field; budget edits use `set-edge`.
- MCP schemas and descriptions, legacy conversion and editor inputs share the
  finite schema bound. The started gate's numeric control permits decreases even
  when its target and exhaustion controls are frozen. The board offers no new
  continuation grant.

A round keeps its existing meaning: a failing review sends findings to a fix.
Under `advance`, the last fix receives one terminal re-check. That final check
supplies the findings filed by the completion path and does not grant more rounds.
An explicit `stop-after-fix` still waits for the operator; `park` still stops
before the fix. A true decision verdict or missing verdict remains a decision.

## Completion and merge

`completeSpentReview` records the final verdict, its findings count, the head and
its attempt in `reviewBudgetSpent`, clears stale review-pending metadata and
completes the lane. Nested gates settle their owed returns before completing.

`mergeEligible` admits a completed spent-budget lane. `sweepAutoMerge` still
requires the project setting, the recorded head and green required checks. With
merging off the lane completes with its pull request ready. With merging on it
joins the existing merge queue. No setting or check is bypassed.

## One follow-up task

`budgetFollowUp.ts` preserves every final finding verbatim in one inbox task in
the same project. Details name the lane and merged head; the title comes from the
lane. The original task links to the follow-up and the lane retains its verdict.
When merging is enabled filing waits for merge; when disabled it follows lane
completion. The stored task provenance and deterministic request key let retries
and restarts recover the same task even after create-receipt eviction.

The seat sees the follow-up as unstarted work. This change uses the existing
seat wake contract and leaves rotation, board maintenance and update drain alone.

## Mandate and visible state

The merge bar accepts passed reviews and spent budgets on green checks. The
review paragraph says: “Pick rounds at creation; they never grow. A spent budget
merges; its findings go to a follow-up task.” The default remains 3 and the risk
selection guidance remains intact. The creator chooses the finite budget without
an additional approval for values above three.

The corrected text bumps mandate v42 through v43 to v44, adds each fingerprint
without rewriting history and retains the delivered-envelope bound. Reconcile the next
version after merging any parallel mandate change.

Cards and `list_pipelines` show completed with
`budget spent: N findings → follow-up <task>`, or the pending follow-up state.
A historical stopped lane reports that its budget cannot increase.

## Verification

Focused failing-first checks cover creation above five, draft edits and reload,
new-grant refusal with no mutation, started untraversed increases, traversed
lowering with frozen target/exhaustion and unchanged evidence, and the
clear/recreate bypass. Historical fixtures exercise stored grants and replay.
Other focused checks cover merge-setting admission and required checks, one
follow-up across retries/restarts/receipt eviction, schema/UI consistency,
mandate version/fingerprint/envelope and rendered desktop/phone surfaces.

Tests use exact paths with isolated state, home and temp roots and a closed
Viewer control port. Publication runs the local privacy, types, changed-file
lint and touched-test gates. Rendered evidence uses the shared kanban driver.
