# Retry of an undispatched stage keeps its successful publication receipt

## Originating requirement

Accepted autonomous finding, 2026-11-07. The authorization behind it is private
and is not reproduced here. The outcome it accepted, as written in the pinned
specification:

> an undispatched same-head stage retry preserves its matching successful
> publication evidence, without duplicate publication or weakened safety.

Acceptance, condensed from the same specification:

1. A supported retry of an explicitly undispatched attempt at an unchanged
   actual source HEAD keeps the matching successful publication receipt (its
   identity, result and SHA), `publishedCommit`, delivery owner and epoch,
   historical attempts, UNKNOWN evidence and fixed review budgets.
2. A replayed retry starts at most one fresh logical attempt and does not
   republish the unchanged head. No gate is reported as passed unless it ran.
3. A changed actual HEAD, a pending, running or unknown publication, a stale
   owner or epoch, a mismatched SHA or result, or uncertain prior execution keeps
   today's invalidation or refusal.
4. Isolated regressions built like production: red on the old code and green on
   the final code for the accepted case. Counterexamples drive the real
   producer and consumer boundaries.
5. The change is limited to retry and publication metadata plus their existing
   focused tests. Three fixed review rounds apply.

## Observations (fresh `origin/main` d4096460, 2026-11-07)

Current main does **not** satisfy the outcome. The serving release has the
same defect in the same code; only line numbers moved.

- `src/lib/pipelines/engine.ts:17947-17953`, inside `patchPipeline`'s
  `retry-stage` branch for a non-review stage, runs right before
  `resetStageForRetry`:

  ```ts
  if (pipeline.delivery?.operation?.state === "settled") {
    recordSettledPublicationFailure(pipeline, attempt, ports);
    delete pipeline.delivery.operation;
    pipeline.publishedCommit = null;
  }
  ```

  `recordSettledPublicationFailure` (`engine.ts:5199`) records only refusals:
  `settledPublicationRefusal` (`engine.ts:5084`) returns `null` for
  `result.ok === true` with `remote: "published"`. A successful receipt is
  therefore deleted without any history. The code has been this way since #2426,
  which turned an earlier blanket clear into this block. Its comment
  (`An internal review retries on the clean local head it holds…`) no longer
  describes what the block does.
- The publication consumer already knows how to reuse a receipt. When a stage
  passes at an unchanged head (`engine.ts:6360`, `unchangedHead`),
  `queuePipelinePublication` (`engine.ts:5009-5031`) checks
  `deliveryOwnerError` first. It then calls `settledPublicationForHead`
  (`src/lib/pipelines/publicationEvidence.ts:7`, added in #3328). That helper
  accepts only the lane's own owner, the current epoch, a `settled` operation
  whose `sha` equals the head, and `result.ok` with `remote: "published"` and
  the same `sha`. When the helper finds a receipt, nothing is pushed and no
  remote read happens. When it finds none, a new `pending` operation is
  reserved, the pre-push hook runs again and the head is pushed again.
- The retry therefore causes the duplicate publication the outcome forbids.
  After the retry deletes the receipt, the fresh attempt passes at the same head
  and `settledPublicationForHead` finds nothing. The lane re-reserves,
  re-runs the hook and re-pushes a head that was already published.
- Other consumers of the kept record, read for this design:
  - `remoteActionFence` reads only `operation.id`.
  - The controller pass's `publicationSucceeded` and its interrupted or
    unreachable cleanups (`engine.ts:14396-14446`) need a committing cursor
    with an accepted pass, a refused result or `remote: "unreachable"`. A
    retried stage reset to `pending` meets none of these.
  - `parkPipelineState` (`engine.ts:3357`) touches `passedStage` only on a
    committing cursor.
  - `stagePullRequest.ts:151` compares `publishedCommit` and `operation.sha`
    with the head it is about to accept.

  Every consumer compares the receipt's SHA, owner and epoch with the head and
  owner it is about to act on. A kept receipt can never vouch for a different
  head.
- Branches in the same handler that already behave correctly stay as they are:
  - The committing-pass publication retry (`engine.ts:17850-17854`) clears only
    `settledPublicationRefusal`.
  - The unreachable producer-repair branch (`engine.ts:17836`) and
    `resolve-decision` (`engine.ts:16555`) are different outcomes with their own
    contracts.
  - The `review-loop` remote retry (`engine.ts:13576-13589`) verifies the
    remote branch and re-reserves publication on purpose.
- A real producer of an undispatched attempt exists. Role-memory or privacy
  preparation fails inside `spawnRunStage` before the spawn loop
  (`engine.ts:8288-8370`). The error propagates to `tickRunStage`'s
  `park` (`engine.ts:10267`). The attempt then holds no `launchId`,
  `conversationId`, `sessionId`, `agentPath`, `paneId`, `activation`,
  `spawnCalls` or `retiredLaunches`, and the registry holds no receipt under
  `clientAttemptId(pipeline, stage, attempt)` (`engine.ts:2911`).
  `spawnCalls` is written and persisted before every spawn call
  (`engine.ts:8409-8426`). The test "corrupt role memory remains a visible
  launch refusal" (`engine.rolePrivacy.test.ts:1173`) drives this producer from
  a corrupt `role_memory` row.
- Such an attempt reaches the clearing block. It is not `unstartedPending`. It
  is not `unreservedSpawnRetry`, unless its error starts with `stage spawn`. It
  is not a receipt retry, because it has no `launchId`. It is not a review loop.

Searches: project-scoped and unscoped transcript and memory searches for this
retry case found only the different completed-failed-stage-with-changed-prompt
outcome, which is out of scope. No earlier design covers it.

## Decision: keep the receipt as the active `delivery.operation`

The receipt must stay **active** in `pipeline.delivery.operation`, with
`publishedCommit` kept beside it. Moving it into historical evidence would not
meet the outcome. `queuePipelinePublication` reads only the active operation,
so an archived copy would still lead to a second push. Keeping it active is
exactly the state the lane would have had if the undispatched attempt had never
been parked, and #3328 already made that state the normal path.

Keeping it does not weaken changed-head invalidation. Invalidation that
matters happens at consumption: `settledPublicationForHead` and the
`sha`/`requestKey` match in `queuePipelinePublication` refuse any other head,
owner or epoch, and the commit path re-reads the real worktree head
(`engine.ts:6320-6360`) before it compares. The retry-time HEAD check below only
narrows when the receipt is kept. It is not the authority.

## Predicate

Keep the receipt only when **every** condition below holds, evaluated
synchronously at one point after the last `await` in the retry branch. In any
other case run today's block unchanged.

1. **Matching successful evidence:**
   `settledPublicationForHead(pipeline, pipeline.lastPassedCommit) !== null`
   and `pipeline.publishedCommit === pipeline.lastPassedCommit`. This covers
   owner, epoch, operation SHA and result SHA. Also require
   `pipelinePublicationHoldsHost(pipeline) === false`, the production custody
   reader's proof that publication has settled. A successful result with
   `uncertain: true`, or an executor whose `finished` is absent or false, keeps
   custody and cannot be reused. Pending, running, refused, `unreachable` and
   `unavailable` results also fail the combined predicate. Both checks run
   before the HEAD read and again after it yields.
2. **Current owner:** `deliveryOwnerError(pipeline,
   pipelineDeliveryLookup({ ...pipeline.delivery.target, active: true }) ??
   pipeline) === null`, the same expression `queuePipelinePublication` uses.
3. **Proven undispatched run attempt:** `stage.kind === "run"`, and the
   attempt holds:
   - no `launchId`, `conversationId`, `sessionId`, `agentPath`, `paneId`,
     `flowId`, `report`, `verdict`, `activation`, `cloud` or `controllerWait`;
   - no entries in `runtimeSwitches` or `retiredLaunches`;
   - `spawnCalls` that is `undefined` or `0`.

   In addition, `agentRegistry().pipelineSpawnHistory(clientAttemptId(pipeline,
   stage, attempt))` must return an empty list. A throw counts as unproven. The
   registry read covers writers that did not count calls, the same inventory
   that `unreservedStageRetryRefusal` and `reconcileClosedAttemptLaunches`
   already trust.
4. **Unchanged actual HEAD:**
   `await currentPipelineBranchHead(pipeline, ports.exec)`
   (`src/lib/pipelines/git.ts:1581`) returns `{ ok: true, sha }` with
   `sha === pipeline.lastPassedCommit`. The worktree must be clean and on the
   pipeline or delivery branch. A failed read, a dirty worktree, another branch
   or another SHA means the receipt is cleared as today.

Ordering: run a cheap prefilter (condition 1) first, so lanes with nothing to
keep never pay for the git read. Then `await` the HEAD read. Then evaluate
conditions 1–4 again with no `await` before the keep or delete effect. The
retry mutation holds the `pipelines.open` store lock that every delivery
transaction also takes, so no store writer can change the row during the read.
The second evaluation still keeps the owner check next to the effect, as the
project's custody rules require. The worktree can still move after the read.
The commit-path comparison catches that, as described above.

The predicate adds no new refusal. A retry that fails it behaves byte for byte
as today.

## Implementation plan (one builder, `src/lib/pipelines/engine.ts` only)

1. Next to `unstartedPendingAttempt` (`engine.ts:7762`), add one small pure
   helper. A suitable name is `undispatchedRunAttempt(pipeline, stage,
   attempt): boolean`. It implements condition 3, including the guarded
   registry read.
2. In the `retry-stage` branch (`engine.ts:17945-17953`), replace the stale
   comment and the unconditional block with the four-condition decision above.
   It sits at the same position, after `validateRetryReceipt`/`claimSpawnRetry`
   and before `cancelProviderStageRetry`. Code that has to run afterwards
   (`unreservedStageRetryRefusal`, `resetStageForRetry`, `recordHandLaunch`)
   stays unchanged. On keep, change nothing in `delivery`, `publishedCommit` or
   `publicationRecovery`. On clear, run the existing three statements.
3. Leave `publicationEvidence.ts`, `resetStageForRetry`, `newAttempt`, review
   budgets, the review-loop remote retry, `resolve-decision`, the
   producer-repair branch and the MCP layer unchanged.

## Tests (add to `src/lib/pipelines/engine.settlement.test.ts`, beside the #3328 reuse cases at about line 2227)

Use the existing `harness`, `publishHarness`, `create`, `PUBLISH_STAGES` and
`REMOTE_BRANCH` from `engine.fixture.ts`, and the real refusal producer from
`engine.rolePrivacy.test.ts:1173`. Insert a role-memory rule through
`roleMemoryCollection(true)!.boundedPatch`, then corrupt that row in the
isolated `state.sqlite`. Do not assemble attempt fields by hand.

Accepted case, "retry of an undispatched read-only stage keeps the published
receipt and publishes nothing again":

1. Drive `build` to pass and settle publication, as the #3328 test does. Assert
   that the operation is `settled` with `{ ok: true, remote: "published", sha:
   box.passedSha }`.
2. Once the operation has settled and `review` has no launch yet, corrupt the
   role-memory row. Tick until `review` attempt 1 is parked as
   `needs_decision`, with `stateDetail` containing `role memory could not be
   read`, `launchId` null and no growth in `h.spawnInputs`. Then repair the
   row.
3. Take a `structuredClone` of the lane and record `box.remoteReadAttempts()`
   and the number of `push:` entries in `box.order`.
4. Call `patchPipeline(id, { action: "retry-stage", expectedStageId: "review",
   expectedAttempt: 1 }, h.ports)` and expect no error. Assert that:
   - `delivery.operation` deep-equals the clone's;
   - `publishedCommit === box.passedSha`;
   - `delivery.ownerId` and `delivery.epoch` are unchanged;
   - `publicationRecovery` and `stages` deep-equal the clone's;
   - every attempt of `build` deep-equals the clone's.
5. Send the identical call again. It must not add an attempt; today it is
   refused or does nothing. Tick: exactly one new spawn input and `review`
   attempt 2 exist.
6. Finish attempt 2 with `pass`. The lane completes,
   `delivery.operation.id` is unchanged, `remoteReadAttempts()` is unchanged
   and no new `push:` appears.

On d4096460 this case must fail at step 4 (operation `undefined`,
`publishedCommit` `null`). The builder records that red run.

Counterexamples (one `test.each`, the same setup up to step 3, then one change
before the retry). Settled counterexamples assert today's clearing behavior
(`delivery.operation` is `undefined` and `publishedCommit` is `null`). Pending
and running operations remain untouched. A mismatched operation epoch is
rejected by store validation before retry and leaves the stored record intact.

- `moved-head`: `box.setLocalHead(<other sha>)`.
- `dirty-worktree`: `box.setDirty(true)`.
- `spawn-called`: make `h.ports.spawnAgent` throw a non-transient error once,
  so the attempt parks with `spawnCalls >= 1` and no `launchId` (uncertain
  prior execution).
- `owner-replaced`: hand the target to a second lane through
  `takeoverPipelineDelivery`, as `publicationRecovery.test.ts:21-36` does.
  The retry clears, and the lane can no longer publish under the old epoch.
- `refused-receipt`, `unreachable-receipt`, `pending-receipt`: set the
  operation to the refused result, `remote: "unreachable"` and `state:
  "pending"` respectively, using the #3328 variant edits. Expectations: the
  refused result is cleared and recorded in `publicationRecovery`; the
  unreachable result is cleared; the pending receipt stays unchanged. These
  behaviors were observed on the base through `patchPipeline`, before draining
  publication. The fixture's convenience wrapper also drains pending
  publication, so the retry assertions use the exported engine operation.
- `uncertain-success`, `executor-unfinished`: persist the existing successful
  receipt with `result.uncertain = true` or `executor.finished = false`.
  Confirm the production custody reader holds it. Retry must clear that
  receipt and `publishedCommit`. Drive the replacement attempt through its
  pass; completion must use a new publication operation after a new remote
  observation. Historical attempts and the fixed review budget stay intact.

Proof that the post-await check matters: in the accepted case, wrap the
harness `exec` so that the `rev-parse HEAD` call made by
`currentPipelineBranchHead` during the retry inserts a registry spawn receipt
under the attempt's base key. Use the test registry the fixture installs. The
retry must then clear. Show that this test fails with the second evaluation
removed (keeping only the prefilter), and record that run.

No new MCP claim is made, so no MCP test is needed. `pipeline_action`
forwards to `patchPipeline`, and its `clientRequestId` handling is unchanged.

## Checks for the build and review stages

Each command runs on its own, through `scripts/gate-slot.sh`, without
`--record`, with a private HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR`,
and with `LLV_VIEWER_CONTROL_URL` on a closed loopback port. Keep a fresh log
for each command, and record the revision, start and end times and the real
exit code.

- `bun run test ./src/lib/pipelines/engine.settlement.test.ts` on the branch.
- The same file on a scratch export of d4096460 with only the new tests
  applied. The accepted case must be red.
- `bun run test` once per file, each file in its own command:
  `./src/lib/pipelines/publicationEvidence.test.ts`,
  `./src/lib/pipelines/engine.publication.test.ts`,
  `./src/lib/pipelines/parkedPublication.test.ts`,
  `./src/lib/pipelines/publicationRecovery.test.ts`,
  `./src/lib/pipelines/engine.rolePrivacy.test.ts`,
  `./src/lib/pipelines/remoteActions.test.ts`. Compare failures with the same
  file on d4096460, and treat failures shared with main as notes.
- `bunx eslint` on the two changed files, `bunx tsc --noEmit` on a fresh
  scratch export, `git diff --check`, and the privacy publication gate on the
  changed files with the fingerprint settings the hook uses.
- Normal pre-push at publication. `engine.ts` is in the 25-minute publication
  budget family.

## Overlap with open work (read 2026-11-07)

- #3728 changes `set-src` at the top of `patchPipeline`.
- #3742 changes spawn privacy correlation around `engine.ts:8223` and `9054-9694`.
- #3710 changes `engine.ts:15342-15729`.
- #3668 adds an integration-decision renewal at the start of `patchPipeline`
  for `retry-stage`.
- #3663 changes `engine.ts:8185-8204` and adds retry tests in
  `engine.missingWorktree.test.ts`.
- #3734 touches no pipeline file.

None of these edits the retry clearing block, `settledPublicationForHead` or
`engine.settlement.test.ts`, so their behaviour and hunks are kept. The builder
reruns this inventory before editing.

## Deferred — not currently justified

- The `review-loop` remote retry (`engine.ts:13576`) also clears a successful
  receipt. Review loops are retired for new definitions, and that path
  deliberately verifies the remote and republishes.
- Undispatched attempts that hold a `launchId` with a failed receipt
  (`roleMemoryRetrySafe` or `neverBegan`). They have their own receipt-based
  recovery, and the accepted case does not need them.
- Archiving cleared successful receipts into `publicationRecovery`. This adds no
  safety and is not needed for the outcome.
- MCP-level replay tests. The MCP layer is unchanged.
- Any live retry, adoption or recovery of an existing lane. Merging this source
  change does not authorize one.
