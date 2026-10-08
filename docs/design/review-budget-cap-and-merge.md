# Review budget: at most 5 rounds per gate, and a spent budget merges

## Originating requirement

The operator wrote this in the seat chat on 2026-10-09 at about 02:35 Kyiv time, after #2555 reached nine review rounds. Verbatim, in Russian:

> «9 раундов дохуя — это вообще не должно быть почкового хуя, там вообще это случилось? Холд 3 раунда, максимум 5, какого хуя надо до 9 расти, ну непонятно. У нас всё равно должно после максимального количества раундов сразу мерджить. А все остальные проблемы находить потом.»

In English: nine rounds is far too many and should never happen. Hold at 3 rounds, 5 at most; there is no reason to grow to 9. After the maximum number of rounds the lane should merge right away, and every remaining problem is found later.

The pinned specification turns this into five outcomes:

1. A cumulative cap: 3 rounds by default, never more than 5.
2. A spent budget completes the lane and merges it.
3. The kept findings become one follow-up task.
4. The mandate says the same thing.
5. The spent budget is visible on the card and in `list_pipelines`.

Each section below names the outcome it serves.

## How it happened

Lane bc8e99e8 (#2555) had a review gate with `maxRounds: 2`. The seat granted `continue-review` `addRounds` several times. Every path that grants rounds checks each value on its own against `MAX_FAIL_EDGE_ROUNDS = 9` (`src/lib/pipelines/limits.ts:18`), and nothing adds the grants up.

When a terminal gate's re-check fails, the lane parks in `needs_decision` at `src/lib/pipelines/engine.ts:3465-3474`. The merge queue admits only `completed` lanes (`src/lib/forge/autoMerge.ts:565`), so "Merge when the review passes" never ran. Lanes d2d49fe8 (#2537) and bc8e99e8 (#2555) are both parked this way today, and so is one lane of another project. A `list_pipelines` read at design time showed exactly these three.

## Where things are (current `main`, 419c0f67b)

### Round validation (outcome 1)

| Path | Where the value is checked | Bound used |
|---|---|---|
| `create_pipeline` stages, and draft and started-lane stage edits | `normalizeStages`, `engine.ts:8341-8349`. The default comes from `DEFAULT_FAIL_EDGE_ROUNDS` = `DEFAULT_REVIEW_ROUNDS` = 3 (`limits.ts:19`, `reviewHistory/limits.ts:3`) | 1..9 |
| `add-stage` | `engine.ts:10493-10557`, through `replaceStartedStages` / `replaceDraftStages` → `normalizeStages`. `replaceStartedStages` passes every stored stage as `preserved` (`engine.ts:8729-8731`) | 1..9 |
| `set-edge` (fail) | `engine.ts:10665-10669`. A fail edge freezes once traversed (`engine.ts:10655-10658`), so it never carries grants | 1..9 |
| `continue-review` | `engine.ts:9873-9876` (shape), and the grant is appended at `engine.ts:9921-9933` | `addRounds` 1..9 per call, no running total |
| `convert-legacy-review` | `legacyReviewDefinition.ts:255-257` (`reviewLimit`) | 1..9 |
| MCP schemas | `mcp/server.ts:3425` (stage `onFail.maxRounds`), `:3713` (set-edge), `:3726` (addRounds) | `.max(MAX_FAIL_EDGE_ROUNDS)` |
| UI inputs | `components/pipelines/StageEdgeControls.tsx:104,109`, `PipelineEditor.tsx:250` | `max={MAX_FAIL_EDGE_ROUNDS}` |
| Stored-record decode | `store.ts:458-469` (`isFailEdge`), `store.ts:608` (`pipelineGraphError`, also used by edits) | 1..9 |

The effective budget is `failEdgeMaxRounds` (`failEdgeBudget.ts:76-82`): `onFail.maxRounds` plus the sum of every grant. Every displayed n/max reads it, and so does the routing decision (`engine.ts:3485`).

### The terminal re-check that parks (outcomes 2 and 3)

- Under `advance`, a spent budget hands the last findings to the fix once (`engine.ts:3504-3522`). That fix's pass returns to a terminal gate (`next: null`) with `activatedBy.budgetRecheck` (`passSuccessor`, `engine.ts:2994`, `3036-3052`).
- `routeFailedAttempt` (`engine.ts:3444`) handles a failed re-check at `3465-3474`. A reviewed failure with a passed fix builds `reviewPending` (`terminalReviewPendingFromAttempt`, `engine.ts:3148-3166`) and calls `park(…, { kind: "review-budget" })`. Anything else (a host that died before a verdict, `reviewed = false`) parks with a plain detail.
- A blocked reviewer parks earlier, at `engine.ts:4025-4027`. A `needs_decision` routed as a fail reaches `routeFailedAttempt` with `parkOnExhaustedBudget = false` (`engine.ts:4033-4040`).
- `reconcileTerminalReviewPending` (`engine.ts:3168-3180`) runs on every controller cycle (`engine.ts:8164`). It rebuilds `reviewPending` for an older park that lacks it.
- Completion itself is inline in `advancePipeline` (`engine.ts:2977-2989`). It clears the engine task note, sets the cursor to null, `state = "completed"`, sets `stateDetail` and `closedAt`, and reopens a settled terminal reap.

### Merge admission (outcome 2)

- `mergeEligible` (`forge/autoMerge.ts:97-121`): at least one review stage ran, and each one's latest attempt passed, was skipped or accepted, or has `budgetSpent` with a passed fix of those findings. A failed terminal re-check meets none of these, so a lane completed that way would not be admitted until this changes.
- `sweepAutoMerge` (`autoMerge.ts:562-590`) admits a `completed`, not-hidden lane when the setting is on, when it closed after the setting changed (`closedAt >= changedAt`), and when it has `lastPassedCommit`, `mergeEligible` and one PR. It writes `merge = newMerge(…)` with `state: "queued"`. `stepLane` (`:403`) waits for checks and merges.
- `scheduleAutoMerge` (`autoMerge.ts:737-751`) runs the merge sweep and then the task-finish sweep on every controller cycle (`pipelines/controller.ts:116`). It runs whatever the projects' settings are.
- `laneFinishedForTasks` (`autoMerge.ts:623-630`): the lane completed, and if its project merges and it has a PR, that PR merged.

### Creating a task idempotently (outcome 3)

- `createTask` (`tasks/commands.ts:341`) is a pure command. A `clientRequestId` is looked up in `recentCreates` and replays the same task (`commands.ts:352-361`). Receipts persist in `tasks.json` and are capped at `RECENT_CREATES_CAP = 100` (`commands.ts:39`).
- `mutateTasksFile` (`tasks/store.ts:690`) writes tasks and receipts under the task lock.
- Precedent for a system-written card: board maintenance `createCard` (`boardMaintenance/run.ts:109-117`). It uses the `clientRequestId` `board-maintenance:<runId>`, `placement: "unplaced"`, `allowBoardOverflow: true`, and the text in `operatorLocale()`.
- Precedent for exactly-once work across two stores: `sweepTaskFinishes` (`autoMerge.ts:648-697`). It writes the task first and the pipeline record second, each under its own lock. A crash between the two leaves a task that the next pass only records.
- A task has no field that links it to another task (`tasks/types.ts:179-276`). A lane is linked to its tasks through `pipeline.taskIds`, and the original task's card draws the lane's row (`PipelineBlock`).

### Seat wake

`isUnstarted` (`monitor/seatTick.ts:266-273`) counts only `assigned` cards. An inbox card counts as open work (`seatTick.ts:295`) but adds no reason to wake. The comment at `seatTick.ts:1340-1348` says inbox work waits for the operator to move it to assigned.

### The mandate (outcome 4)

- `ORCHESTRATOR_PROMPT_VERSION = 41` (`orchestrator/prompt.ts:95`).
- Merge bar paragraph: `prompt.ts:456`. Review paragraph: `prompt.ts:463`. Risk budget sentence: `prompt.ts:464`.
- Version and fingerprint tests: `prompt.test.ts:82-124` (version and stale list) and `prompt.test.ts:150-172` + `226-238` (`PROMPT_FINGERPRINTS`; add the new version's entry and never rewrite an old one).
- Envelope test: `prompt.test.ts:755-783`. The delivered default must stay under `MAX_STRUCTURED_TEXT_BYTES - 2_600` = 29 400 bytes (`runtime/structuredContent.ts:40`). The test comment records 29 379, which leaves about 21 bytes.
- Pinned phrases:
  - `prompt.test.ts:453` (`fail parks with "budget spent: N findings left"`)
  - `prompt.test.ts:847-849` (merge-bar phrases)
  - `prompt.test.ts:913-916` (the risk sentence, which is also pinned in the two skills by `prompt.test.ts:918-928`)
- Tool descriptions that state the parking rule: `mcp/server.ts:3204`, `:3215`, `:3428`, `:3703`, `:3726`, and the shape text at `engine.ts:8260`.

### Surfaces (outcome 5)

- `list_pipelines` rows carry `stateDetail`: full rows at `listProjection.ts:249`, compact rows at `listProjection.ts:305`, clamped.
- The card's muted line under the chain is `UnreviewedNote` (`components/pipelines/PipelineBlock.tsx:332-337`), rendered at `:730` and `:1013`. Its keys are `pipelineBlock.unreviewedFix` in `i18n/en.ts:2408` and `i18n/uk.ts:2366`.

## Design

### Outcome 1: one cumulative cap of 5

1. In `src/lib/pipelines/limits.ts`, add `export const MAX_REVIEW_ROUNDS = 5;`. Its comment says this is the most rounds a gate may hold in total: `maxRounds` plus every `continue-review` grant. Keep `MAX_FAIL_EDGE_ROUNDS = 9`, and make its comment say it is the most a *stored* edge may hold. Records written before this change are valid at up to 9. The store decode (`store.ts:466`, `:608`) keeps reading it. Lowering it to 5 would make `isFailEdge` reject every stored lane with 6 to 9 rounds when the store loads.
2. In `normalizeStages` (`engine.ts:8341-8349`), refuse `maxRounds > MAX_REVIEW_ROUNDS` unless `preservedStage?.onFail?.maxRounds === maxRounds`. That exception lets a stored stage keep its value through an `add-stage` or draft edit of its lane. A new or changed edge is capped. The violation reads `stage <id> onFail maxRounds may be at most 5 (default 3)`, and `expected` reads `integer 1–5 (default 3)`. Update `STAGE_ON_FAIL_SHAPE` (`engine.ts:8260`) to say 1–5.
3. In `set-edge` (`engine.ts:10667`), compare against `MAX_REVIEW_ROUNDS`. The edge is untraversed here, so it has no grants and the total is `maxRounds`. Reason: `maxRounds may be at most 5 per review gate (default 3)`.
4. In `continueReview`, after `review` is resolved (`engine.ts:9907`), compute `have = failEdgeMaxRounds(pipeline, review)`. If `have + req.addRounds > MAX_REVIEW_ROUNDS`, answer 409, `field: "addRounds"`:
   - `review budget is at most 5 rounds per gate, grants included: <stage> has <have>; <addRounds> more would make <total>`
   - when `have >= 5`: `review budget is at most 5 rounds per gate, grants included: <stage> already has <have>, so no more rounds can be granted`

   Check it before the grant is appended, and after the replay lookup at `9879-9886`, so a replay of an accepted grant still answers. Lowering the per-call shape bound at `9874` to `MAX_REVIEW_ROUNDS` is the same check for a single call.
5. In `legacyReviewDefinition.ts:255`, cap `reviewLimit` at `MAX_REVIEW_ROUNDS`, with the existing `limit-out-of-range` refusal.
6. Set the MCP schemas `server.ts:3425`, `:3713` and `:3726`, and the UI inputs `StageEdgeControls.tsx:104,109` and `PipelineEditor.tsx:250`, to `MAX_REVIEW_ROUNDS`. Edit the describe strings to say "default 3, at most 5 per gate, grants included".

What counts as a round stays what `maxRounds` already counts: a failing review that sends findings to the fix. Under `advance`, the terminal gate's one re-check of the last fix is that last fix's review: it sits outside the budget count and produces the findings outcome 3 files. A gate at 5 therefore runs at most 5 fixes. The doc names this so that nobody counts reviewer turns and reads 6 as a breach.

### Outcome 2: a spent terminal gate completes, then merges like a pass

1. Extract `completePipeline(pipeline, now, detail)` from `advancePipeline` (`engine.ts:2977-2989`) unchanged, and call it there.
2. Change the re-check branch in `routeFailedAttempt` (`engine.ts:3465-3474`):

   ```ts
   if (attempt.activatedBy?.budgetRecheck) {
     const pending = reviewed ? terminalReviewPendingFromAttempt(pipeline, stage, attempt) : null;
     if (pending && parkOnExhaustedBudget) {          // a plain fail verdict
       completeSpentReview(pipeline, stage, attempt, now);
       return true;
     }
     …park exactly as today…
   }
   ```

   `completeSpentReview` does three things:
   - It sets `pipeline.reviewBudgetSpent = { stageId, attempt: attempt.n, findings: attempt.verdict.findings.length, head: pipeline.lastPassedCommit, at: now }`.
   - It deletes any stale `reviewPending`.
   - It calls `completePipeline` with the detail `budget spent: N findings → follow-up after merge`.

   `routeFailedAttempt` gets the time as one new trailing parameter. Its main caller at `engine.ts:4033` already holds `ports`, and the historical caller at `5922` passes `reviewed = false` and never reaches this branch.

   These cases still park as they do today:
   - a reviewer that answered `needs_decision` (its findings route as a fail with `parkOnExhaustedBudget = false`)
   - a blocked reviewer (`engine.ts:4025`)
   - a host that died without a verdict

   In each, the reviewer did not deliver a judged set of findings, or asked the operator.

   The lane's head does not move: the re-check is a read-only review of the fix, and the fix already published its head. So remote-branch publication has nothing left to do.
3. Add to `mergeEligible` (`autoMerge.ts:106-118`) one accepted case for a stage's failed latest attempt:

   ```ts
   const spent = pipeline.reviewBudgetSpent;
   if (spent?.stageId === stage.id && spent.attempt === latest.n) continue;
   ```

   Nothing else in admission changes. The setting gate, `closedAt >= changedAt`, the one-PR rule, required checks green, the one-lane-per-repository queue and `retry-merge` all apply as they do to a passed lane. With the setting off, the lane completes and the merge sweep skips it (`autoMerge.ts:572`). The seat's existing "PR left open by a lane that finished" wake (`seatTick.ts:1322`) brings it to "PR ready: <url>" as it does today.
4. Types and store. Add `reviewBudgetSpent?: PipelineReviewBudgetSpent` to `Pipeline` (`types.ts`, beside `reviewPending` at `:1039`), and validate it in `isPipelineShape` (`store.ts:843` area) the way `reviewGrants` and `taskFinishes` are validated. The findings are not copied: they stay on the re-check attempt's `verdict.findings`, which is the record "nothing is lost" refers to.

### Outcome 3: one follow-up task, created exactly once

1. A new module `src/lib/pipelines/budgetFollowUp.ts` exports two things:
   - `budgetFollowUpInput(pipeline, mergedHead, locale)`, which builds the `createTask` input.
   - `fileBudgetFollowUp(pipeline)`, the production task write.

   The task input:
   - `project: pipeline.project`, `placement: "unplaced"`; status `inbox`, the default for a create.
   - Text in `operatorLocale() ?? "uk"`, built from the lane title's first line, cut to fit `TASK_TEXT_LIMIT`:
     - `Зауваження після рев’ю: <lane title>`
     - `Review follow-up: <lane title>`
   - Details in English, the agent-facing context:
     - the lane id, the original task id(s), the review stage and attempt, the merged head, and the PR when there is one
     - then every finding verbatim, one per line, in order
     - If the findings would pass `TASK_DETAILS_LIMIT` (20 000 characters), they are copied whole in order up to the limit, and one last line says `findings K–N: get_pipeline <lane> stageId <stage> attempt <n>`. No finding is cut mid-text.
   - `clientRequestId: review-budget-follow-up:<pipelineId>:<stageId>:<attempt>`
   - Dependencies `{ explicit: true, allowBoardOverflow: true }`, the board-maintenance precedent: a system card that must stay visible.
2. Add a sweep, `sweepBudgetFollowUps(ports)`, in `autoMerge.ts` beside `sweepTaskFinishes`. It is chained after it in `scheduleAutoMerge` (`autoMerge.ts:745-748`) through a new optional port, `fileFollowUp`, wired in `productionAutoMergePorts`. For each lane that has `reviewBudgetSpent` and no `reviewBudgetSpent.followUp`, and that is finished:
   - "finished" means `laneFinishedForTasks(pipeline, ports)`, or `state === "closed"`, because a lane closed after completing still owes its follow-up
   - the merged head is `pipeline.merge?.mergedHead ?? pipeline.lastPassedCommit`
   - the sweep calls `fileFollowUp`, which runs one `mutateTasksFile(createTask(…))`
   - it then records `followUp = { taskId, title, at }` under the pipeline lock with `ports.mutate`, skipping the write if a `followUp` is already there
   - it rewrites `stateDetail` to `budget spent: N findings → follow-up «<title>» (<taskId 8>)`

   This is the task-finish sweep's order: the task first, the record second, never both locks at once. A crash or a lost pipeline write between them leads to a replay on the next pass, under the same `clientRequestId`, of the same task. The receipt is persisted in `tasks.json`, so the replay survives a restart. A lane that already has `followUp` is never visited again, so a follow-up the operator deletes later is not recreated.
3. Waiting for `laneFinishedForTasks` puts the head that actually merged into the task when the project merges. It also means a worker who picks up the task branches from a `main` that contains the code the findings are about. While a merge waits (checks running, or `merge.state blocked`), the card says "follow-up after merge". The findings are on the lane record the whole time.
4. The link from the original task is the lane row on the original task's card, which names the follow-up by its title (outcome 5). The follow-up's details name the original task id. No task-to-task field is added.
5. Seat wake. The task is created in **inbox**, as the specification says. In the current tick, an inbox card is open work that wakes nobody: the operator's move to assigned starts it. Once moved, it wakes the seat exactly like any other unstarted (assigned) card. This change adds no wake mechanism. The seat-tick lane (#2346, 58e782ee) owns that file. Inbox is also the safe default for a second reason: a follow-up the seat picked up by itself would run its own reviewed lane. That lane could spend its own budget and file its own follow-up, which is a chain no operator started. If the operator wants the seat to start these on its own, it is a one-word change (`status: "assigned"` at create). See open question Q2.

### Outcome 4: the mandate (v41 → v42)

Edit only the merge-bar and review paragraphs. The board-maintenance paragraph belongs to lane 64e94078. Proposed text:

- `prompt.ts:456`, Merge bar:
  - Replace `A pull request is ready when its lane's reviews passed on its final head, or spent their budget with the last fix passed and you have read the findings they kept; the project's required checks are green; and you have read its body.` with `A pull request is ready when its lane's reviews passed on its final head or spent their budget, the project's required checks are green, and you have read its body. A spent budget's kept findings become a follow-up task.`
  - Replace `Delegatus merges a completed lane whose reviews passed, or spent their budget with the last fix passed, once its checks settle green, and nobody reads a spent budget's kept findings first; never merge …` with `Delegatus merges a completed lane whose reviews passed or spent their budget once its checks settle green; never merge …`.
- `prompt.ts:463`: replace `a terminal gate (next:null) re-checks once, pass completes, fail parks with "budget spent: N findings left".` with `a terminal gate (next:null) re-checks once and completes either way; a fail completes as "budget spent".`
- `prompt.ts:464`: keep the sentence the two skills pin, and append `Never more than 5 per gate, grants included.`

Measured with `wc -c` on the paragraphs: the merge bar goes from 1 235 to 1 142 bytes, and the review and risk lines go from 836 to 877, so the change is 52 bytes shorter. The envelope test keeps its room without editing its bound.

Then do the following:
- Bump `ORCHESTRATOR_PROMPT_VERSION` to 42.
- Add `42: "<sha256>"` to `PROMPT_FINGERPRINTS`.
- Extend the version test's history comment (v42: a review gate holds at most 5 rounds, and a spent budget completes, merges and files its findings as a follow-up).
- Add `expect(orchestratorMandateStale(41)).toBe(true)`.
- Repoint the pinned phrases at `prompt.test.ts:453` and `847-849` to the new text.
- Add `expect(…).toContain("Never more than 5 per gate, grants included.")` beside `:914`.

Version reconciliation with lane 64e94078: both lanes bump from 41. Whichever merges second merges `origin/main` before its review and takes the next number, with a fingerprint over the combined text. The fingerprint test fails until that happens. That is the intended guard.

Edit the tool descriptions too, to say the same thing in fewer words: replace "fail parks with the number of findings left" / "a fail parks with budget spent: N findings left" with "fail completes as budget spent; its findings become a follow-up task", and state the 5-round total. The places are `server.ts:3204`, `:3215`, `:3428`, `:3703` and `:3726`, plus `engine.ts:8260` and the `reviewPendingDetail` / `taskStatusNote` texts where they name the terminal case.

### Outcome 5: visible as budget spent

- `list_pipelines`, full and compact, already carries `stateDetail`:
  - `budget spent: N findings → follow-up after merge`, then
  - `budget spent: N findings → follow-up «<title>» (<id8>)`

  No new list field is needed.
- On the card, extend `UnreviewedNote` (`PipelineBlock.tsx:332`) with a reader `pipelineReviewBudgetSpent(pipeline)` in `failEdgeBudget.ts`, beside `pipelineCompletedUnreviewed`. It renders the same muted `pb-unreviewed` line with `data-pipeline-budget-spent`:
  - en `pipelineBlock.budgetSpent`: `Review budget spent · {count} findings → follow-up «{task}»`, and `pipelineBlock.budgetSpentPending`: `… → follow-up after merge`
  - uk: `Бюджет рев’ю вичерпано · {count} зауважень → задача «{task}»` / `… → задача після мерджу`, with the plural forms of `pipelineBlock.unreviewedFix`

  `pipelineCompletedUnreviewed` returns null for these lanes, because the review stage's latest attempt is the re-check and carries no `budgetSpent`. So the two lines never both show.
- Rendered evidence goes through the existing drivers. Add one `describe` case to `src/components/kanban/kanbanBoard.browser.test.tsx`, over `issue1695Evidence.fixture.tsx` with a completed budget-spent lane. Add one case to `src/components/mobile/issue1671Evidence.browser.test.tsx` for the phone. Both cover the pending and the filed variant, in uk and en, at the drivers' existing viewports. Do not add a new driver.

### Migration of stored lanes

- **Rounds.** Stored edges with 6 to 9 rounds still load (`MAX_FAIL_EDGE_ROUNDS` stays 9 for decode), run as stored, and display n/max as today. Their stored value survives edits to their lane (`preserved` exception). Every further grant is refused once the total is 5 or more. Nothing is rewritten.
- **Lanes parked on a failed terminal re-check** (three today: bc8e99e8, d2d49fe8, and one lane of another project with no PR). `reconcileTerminalReviewPending` (`engine.ts:3168`) changes from "rebuild `reviewPending`" to "complete as budget spent". When the lane is in `needs_decision` and `terminalReviewPendingFromAttempt` returns a pending for its current attempt with a plain `fail` verdict, it calls the same `completeSpentReview`. The pending comes from the stored `reviewPending` or from the attempt, and the same `currentTerminalReviewPending` guard used today applies. So stored lanes and new ones take the same path, on the first controller cycle after deploy. A paused lane whose `pausedState` is `needs_decision` completes after its resume. With the merge setting on, the two Delegatus lanes enter the merge queue.
  - If a merger already merged the PR, the sweep records `merged` / `by: "outside"` from the forge cache (`autoMerge.ts:583-590`).
  - If a merger pushed a head of its own, `stepLane` blocks on the head outside the chain, and the seat reads `merge.state blocked` as usual.
  - Each lane files its follow-up once it has finished.
- Alternative considered: leave stored parks alone and complete only new ones. That needs a manual action that does not exist (`accept-head` is refused outside `needs_review`), and it would leave exactly the two lanes the operator complained about parked. Rejected.
- After this change, the terminal branch of `continue-review` (`engine.ts:9897-9949`) is reachable only for a parked record that no controller cycle has seen yet. It stays as it is. Retiring it is deferred.

## Failing-first tests

Run each file by path, never a directory sweep, under a private state root:

```sh
T=$(mktemp -d) && mkdir -p "$T/state" "$T/home" "$T/tmp" && \
LLV_STATE_DIR="$T/state" HOME="$T/home" TMPDIR="$T/tmp" LLV_VIEWER_CONTROL_URL=http://127.0.0.1:9 \
  bun test <file>
```

Each test below fails on `main` and passes after the change.

### `src/lib/pipelines/engine.test.ts`

1. **Cap on create.** `create_pipeline` with `onFail.maxRounds: 6` → 400, with the violation on `stages[i].onFail.maxRounds` naming 5. With 5 → accepted. When omitted → stored 3.
2. **Cap on add-stage.**
   - A new stage with `maxRounds: 6` → 400.
   - On a started lane seeded with a stored stage at `maxRounds: 7`, adding an unrelated stage → accepted, and the stored stage still reads 7.
3. **Cap on set-edge.** A fail edge with `maxRounds: 6` → 400 and the plain reason. With 5 → applied.
4. **Cumulative cap on continue-review.**
   - A `needs_review` lane at `maxRounds: 3`: `addRounds: 2` → accepted; then `addRounds: 1` → 409, `field: "addRounds"`, with the reason naming the total.
   - A seeded lane at `maxRounds: 2` with grants totalling 7 (the bc8e99e8 shape): `addRounds: 1` → 409 "already has 9".
   - A replay of the first, accepted grant still answers `replayed: true`.
5. **A spent terminal gate completes.** A terminal gate at `maxRounds: 1` goes review fail → fix pass → re-check fail. The test expects:
   - `state: "completed"` and `closedAt` set
   - `stateDetail` starting `budget spent: 1 findings`
   - `reviewBudgetSpent` naming the re-check attempt
   - the re-check's `verdict.findings` intact
   - no park note on the linked task
6. **What still parks.** The same lane, where the re-check answers `needs_decision` with findings, or `blocked`, or dies without a verdict → `needs_decision` as today.
7. **Granted lanes end the same way.** A lane in flight on a terminal grant whose final granted re-check fails → completed.
8. **Migration.** A seeded record parked on a failed terminal re-check, both with `reviewPending` and in the older shape without it (the fixture at `engine.test.ts:21430-21441`). One controller cycle → completed with `reviewBudgetSpent`. A paused copy completes after resume.

Existing tests whose expectation flips from "parks" to "completes": `engine.test.ts:12593`, `:13059`, `:13093`, `:13280`, `:14367` (the `budget spent: 2 findings left` rows) and `:21430`. The terminal-grant tests at `:13140-13160` and `:21050-21411` reach the park by running the engine. They seed the parked record directly instead, as `:21430` does, and assert that the grant's final failing re-check completes.

### `src/lib/pipelines/store.test.ts`

9. A stored record with `onFail.maxRounds: 9` and grants still loads, and a `reviewBudgetSpent` with a bad shape is rejected like any other bad field.

### `src/lib/pipelines/legacyReviewDefinition.test.ts`

10. A `reviewLimit` of 6 → `limit-out-of-range`.

### `src/lib/forge/autoMerge.test.ts`

11. `mergeEligible` is true for a completed lane whose terminal gate's latest attempt is the recorded budget-spent re-check. It is false for the same attempts without `reviewBudgetSpent`.
12. With the setting on (changed before `closedAt`), the sweep writes `merge.state: "queued"` for that lane. With the setting off, no merge record.

### `src/lib/pipelines/budgetFollowUp.test.ts` (new, beside the module)

13. **Exactly one task.** A finished budget-spent lane: one sweep creates one inbox task in the lane's project, with:
    - the lane-derived title in the operator's locale
    - details carrying each finding verbatim, the merged head, the lane id and the original task id

    It records `followUp`, and `stateDetail` names it. A second sweep changes nothing.
14. **Retries and restarts.**
    - The first `ports.mutate` throws after the task write. The next sweep finds the same task through the receipt, records it, and the store holds one follow-up.
    - The same test again, reloading `tasks.json` from disk between passes, shows that the restart keeps one task.
15. **Waiting for the merge.** With the setting on and the PR not merged → no task, and the detail says "after merge". After `merge.state: "merged"` → the task names `merge.mergedHead`.
16. **Overflow.** 50 findings of 2 000 characters each → whole findings up to the details limit, then the `get_pipeline` pointer line.

### `src/components/pipelines/PipelineBlock.dom.test.tsx` (or the existing PipelineBlock DOM test)

17. A completed budget-spent lane renders `data-pipeline-budget-spent` with the count and the follow-up title (filed) or "after merge" (pending), in uk and en, and no `unreviewedFix` line.

### `src/lib/orchestrator/prompt.test.ts`

18. The version is 42, with the v42 fingerprint, `orchestratorMandateStale(41)` true, the new phrases present, `fail parks with "budget spent` absent, and the envelope test still green with its bound unchanged.

Then the project's own gates: pre-commit (privacy with the fingerprints, eslint) and pre-push (types, changed-file lint, touched tests against the merge base). Run the privacy gate locally before every push.

## Open questions for the operator

**Q1. Should a finding's severity ever stop the merge?** As designed, a spent budget merges whatever the kept findings are, P0 included, because the requirement says to merge after the maximum and find the rest later. Nothing is built for a severity hold.
- Options:
  - (a) never hold; the follow-up carries every finding
  - (b) a kept P0 holds the merge in `merge.state blocked` with the reason "P0 finding kept: …", and the seat or the operator decides
- **Recommendation: (a).** It is what the quote asks for, and a reviewer's P0 on its final re-check is visible on the card and in the follow-up. If (b) is wanted, it is one check in `mergeEligible` plus a reason text, done as its own task.

**Q2. Should the follow-up wake the seat right away?** The specification says the task goes to inbox and that the seat is woken for it like any unstarted task. In the current tick, inbox cards wake nobody, and only assigned ones count as unstarted.
- Options:
  - (a) inbox; the operator's move to assigned starts it
  - (b) create it assigned, so the seat picks it up on its next wake
- **Recommendation: (a)**, as designed, because (b) lets one spent budget start another reviewed lane with nobody choosing it. Switching is one word at create.

## Deferred — not currently justified

- **Retiring the terminal `continue-review` branch** and its UI choice. This covers `engine.ts:9897-9949`, `failEdgeBudget.ts:16-32`, `stagesModel.ts:154` and `pipelineBlockModel.ts:205,253`. After the migration no live record reaches it. Remove it one release later, once no stored park remains. Doing it now would touch six files of grant machinery that in-flight granted lanes still use (`terminalReviewGrantForAttempt`).
- **A deterministic follow-up task id.** The `clientRequestId` receipt covers retries and restarts. A twin would need more than 100 creates between a task write and its record, which happen in one sweep pass.
- **A clickable link** from the card's budget-spent line to the follow-up task. The line names it by title.
- **Seat-tick and board-report wording** for budget-spent lanes (`seatTick.ts:1322`, `boardReportRun.ts:194`). Lane 58e782ee owns the tick, and `stateDetail` already says it.
- **Capping legacy review flows** (`roundLimit`, where 0 means unlimited). Seats no longer create them (mandate v30), and the requirement concerns pipeline review gates.
- **Counting the terminal re-check as a sixth round.** The re-check is the review of the last fix, and it supplies the follow-up's findings. Folding it into the 5 would cut one real fix from every budget.
- **An ADR.** The decision is reversible by a constant and one branch.
