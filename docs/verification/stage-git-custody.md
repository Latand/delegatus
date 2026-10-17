# Stage Git custody

This is the historical verification of #2955, deployed in `917189ae`. On
2026-10-16, [stage push settlement](stage-push-settlement.md) supersedes its
256-commit limit, commit-date predicate and lack of adoption for older
attempts. The implementation and test observations below describe that
earlier revision. Current settlement pages every commit, accepts native
creation evidence or verified base history, and defines a worktree-reflog
fallback for older attempts.

A writable stage can leave its lane checkout behind after committing and pushing
from a detached linked checkout. Settlement now adopts that push before review
when the attempt's native Git hooks recorded every commit in the suffix.
An unproved push is refused, and its refusal stops stage settlement.

| Requirement | Change or diagnosis | Test and evidence |
| --- | --- | --- |
| A: explain the original failure | The preceding read-only audit found a detached linked checkout, a pushed descendant, and an unchanged lane HEAD. On main `5bd026c0`, `commitAndAdoptStageBranch` immediately called `commitPipelineStage` for the lane branch; a clean checkout returned its old HEAD. `collectStageProvenance` observed that same checkout. Publication called a remote-ahead tip divergent. `reconcileTerminalStageHosts` rewrote `lastAt` while publication custody retained the host, changing the whole-row revision. | The detached-push, remote-ahead diagnostic, and parked-custody regressions reproduce those mechanisms on main. See the baseline observations in [readings.json](../../evidence/stage-git-custody/readings.json). |
| B: adopt only this attempt's push | `prepareStageGitGuard` records the launch, checkout, exact starting head and start time before dispatch. The existing author guard records native post-commit receipts and pre-push target evidence. `settleStageAttemptPush` checks the complete suffix on first adoption and interrupted fast-forward replay; recorded candidates absent from or unchanged on the delivery remote refuse settlement. The accepted report records the adopted head. | `engine.ports.test.ts`: tests beginning `attempt Git custody`, including replayed outside, mixed and malformed proofs; absent and unchanged remote tips; a fresh controller process; another attempt; missing receipts; time bounds; dirty files; release, pause, ownership changes; and races before and after fast-forward. Both the 256-commit boundary and its overflow run through native hooks. |
| C: keep parked revisions stable | A reap with an existing envelope preserves it when a pass observes only active hosts, publication custody or hosts outside the selected controller window. Settled hosts and other real transitions still change the row. | `terminalReap.test.ts`: `scheduled parked reap keeps its revision across off-window active hosts` exercises the production controller across repeated ticks and verifies a real host settlement changes the revision. The unscoped custody test and production socket protections remain covered too. |
| D: red on main, green on the change | Regression bodies were written first and copied into scratch exports of main. The implementation was checked in a separate scratch export. | [readings.json](../../evidence/stage-git-custody/readings.json) records commands, per-case baseline failures, final file outcomes, and the source digest. |

The main audit points were `src/lib/pipelines/stageBranch.ts:120`,
`src/lib/pipelines/git.ts:843` and `:873`,
`src/lib/pipelines/stageProvenance.ts:94`, and
`src/lib/pipelines/engine.ts:4731` for the old head. Publication compared it at
`src/lib/pipelines/git.ts:2098`; retry repeated publication at
`src/lib/pipelines/engine.ts:13150`. The reap retained custody at
`src/lib/pipelines/engine.ts:9597`, rewrote `lastAt` at `:9615`, and returned a
change at `:9659`. `src/lib/pipelines/store.ts:31` hashed that changed row.
These line numbers refer to the pinned main commit above.

The launch adapter copies two environment fields into the selected account's
environment. `agentPublicationIdentityEnv` retains those fields when the native
Codex or Claude policy is reapplied, including a restrictive Codex allowlist.
Hook code is static across attempt bindings, so a warmed native launch reuses
the same files without per-attempt synchronous writes or renames. An unbound
launch keeps its existing behavior. Unrelated fixture repositories retain their
original hooks and push behavior. Commit receipts cover the lane
checkout and the launching stage's own scratch directory. The existing reservation callback
runs again after guard preparation, so an activation cancelled during setup
cannot dispatch a native host. A preparation failure marks that reserved launch
failed before dispatch.

Proof files live in a launch-specific state directory. Settlement reads each
file with an 8 KiB bound and inspects at most 256 commits. Every suffix commit
must have its own native receipt and a committer timestamp inside the attempt's
window. The candidate must retain both the pipeline base and its accepted head.
The remote branch, push URL, lane head, cleanliness and delivery authority are
checked before adoption. A remote outage leaves the attempt committing and
retries verification; it cannot accept the stale lane head. A remote change
after fast-forward refuses acceptance and retains the proved local commit.

The existing lane/flow/ownership fence and inherited publication lock still
surround Git settlement. `verifyPassedHeadIntegration` remains unchanged: a
single-parent commit added after review still requires a fresh review. The
new adoption path runs during the producing writable attempt's settlement;
publication recovery retains its reviewed-head checks. Older attempts with no
receipts receive no new authority to adopt remote work. These hooks enforce the
same cooperating-agent boundary as the existing author guard.

The overlapping registry-admission and launch-recovery branches were inspected.
Their modified admission and recovery regions remain outside this change.
The implementation started at `5bd026c067e562af075ce25d838482a3c8b00a3f`.
Current main advanced during verification. It was merged without rebasing at
`d395e7c7324e2653acd37edbbf644814f622deb1`; integration checks use a scratch
export of that merge. The evidence distinguishes the original red samples,
current-main red samples, and integrated results.

Run each file separately from a scratch export, through the installed
`gate-slot.sh`, with private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and
`LLV_STATE_DIR` values:

```sh
bash "$GATE_SLOT" bun test src/lib/pipelines/engine.ports.test.ts
bash "$GATE_SLOT" bun test src/lib/pipelines/engine.recovery.test.ts
bash "$GATE_SLOT" bun test src/lib/pipelines/terminalReap.test.ts
bash "$GATE_SLOT" bun test src/lib/pipelines/git.test.ts
bash "$GATE_SLOT" bun test src/lib/pipelines/engine.settlement.test.ts
bash "$GATE_SLOT" bun test src/lib/pipelines/parkedPublication.test.ts
bash "$GATE_SLOT" bun test src/lib/git/agentHistoryGuard.test.ts
bash "$GATE_SLOT" bun test src/lib/git/agentPublicationIdentity.test.ts
bash "$GATE_SLOT" bun test src/lib/pipelines/stageProvenance.test.ts
bash "$GATE_SLOT" bun test src/lib/performanceSpans.test.ts
```

The evidence also records TypeScript, changed-file lint and publication privacy.
Two managed-admission assertions fail on both main and the change in this
isolated environment; their names and baseline results are retained. Hosted
required checks belong to the subsequent Delegatus publication. No performance
gain is claimed.

Publication repair reproduced both unsubmitted-activation recovery failures on
the accepted commit and confirmed both passed on the merged main base. Their
synthetic checkout had no readable Git HEAD, so guard preparation correctly
failed before dispatch. The fixture now supplies its deterministic HEAD only
for that checkout's native Git read. Both recovery seams also assert that no
guard preparation occurs under the drain and that the released dispatch carries
the persisted launch, starting head and checkout proof. The full recovery file
passes all 103 cases. Production admission, recovery and publication fences are
unchanged by this repair. Its observations are recorded separately in
`publicationRepair` in the evidence file.

Two full pre-push rehearsals cleared the recovery failures and passed types,
lint and privacy. Both stopped when `engine.providerBudget.test.ts` exceeded
its five-minute file deadline; the corresponding main samples completed in
274 and 296 seconds. That file passed alone on the repaired source in
278 seconds. At that point the full publication gate was blocked by that runner
timeout. No test coverage or gate limit was changed to accommodate it.
The Linux backend probe and all 17 scoped Linux test files pass separately.

The publication retry splits the provider-budget cases by family into
`engine.providerBudget.test.ts` (74 cases),
`engine.providerBudgetChains.test.ts` (62 cases), and
`engine.providerBudgetKinds.test.ts` (28 cases). Concatenating their bodies
after removing the imports reproduces the original source byte for byte.
The ordered inventory retains all 164 names. Each file receives the existing
isolated process and five-minute deadline; product code, assertions, fixtures
and hook limits remain unchanged. The full 25-file touched-test selection
passes with no new failures. The comparator retains the failures reproduced
on current main, including their names, in `publicationRetry` in the evidence
file. The normal push hook must judge the final committed tree again.
