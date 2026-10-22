# Proactive work inside full autonomy

Originating requirement — operator, 2026-10-22, approximately 14:06Z, seat voice chat. Public paraphrase: add an optional mode within full autonomy that lets the orchestrator invent and run improvements with clear user value, including quality-of-life work suggested by memory and operator corrections. The recorded user turn arrived at 14:09:03Z. The private wording is intentionally paraphrased for this public document.

Status: policy decided by the operator on **2026-10-22 at 14:48Z**. The five decisions at the end govern this design and its implementation slices. Implementation and live enablement remain separate steps.

## 1. Observed behavior and evidence

### Inspection boundary

Code observations refer to revision `4da1e12922993eb77d31a3555eeae9969eace338`, inspected on 2026-10-22. The assigned checkout was clean at initial inspection; the decision continuation found only this declared draft untracked. The read-only open-pipeline inventory returned 17 lanes; the only returned title concerning proactive autonomy was this design lane. No competing change to this output was present. This stage changes only this document. Historical statements below come from opened conversation records and the self-development task, rather than search fragments alone.

### Full autonomy already has an episode and a work agenda

| Observed fact | Source at the inspected revision |
| --- | --- |
| The base mandate allows initiative on accepted work and proposals. Its boundary says “never start work nobody asked for” and separately protects operator-owned settings, checkouts, accounts and sessions. | `src/lib/orchestrator/prompt.ts:507` |
| Full autonomy is an optional episode on the project’s seat tick settings. It records `startedAt`, deadline, end reason, actor, decisions and report completion. Missing autonomy means off. Settings are stored in the `seat_tick_settings` collection of `state.sqlite`; the JSON filename remains an import/mirror interface. | `src/lib/monitor/autonomy.ts:16`, `src/lib/monitor/seatTickSettings.ts:203`, `src/lib/monitor/seatTickSettings.ts:343` |
| Only the operator enables or extends an episode. The project’s seat can shorten or stop it, with a reason. Wakes must be enabled. The default duration is eight hours; `null` means unlimited. Expiry is evaluated on read. | `src/lib/monitor/autonomy.ts:32`, `src/lib/monitor/autonomy.ts:43` |
| The active overlay replaces asking rules, allows answering forms and moving parked lanes, and already names Inbox work, existing forge issues, maintenance suggestions and the seat’s own findings. It asks the seat to mark new tasks autonomous and keep them small, reversible and reviewed. | `src/lib/monitor/autonomy.ts:73` |
| The overlay forbids other projects, account/spending/worker/role changes, operator settings and sessions, destruction, history rewrites, deletions, closing other work and outside communications. It preserves merge, credit and deploy gates and the accepted release-flow exception. | `src/lib/monitor/autonomy.ts:78` |
| Unaccepted, unblocked Inbox tasks become eligible during autonomy. When there are no open pipelines, running children or unstarted tasks, `autonomy-idle` asks the seat to find work in the recorded source order. Retry guards still apply. | `src/lib/monitor/seatTick.ts:1251`, `src/lib/monitor/seatTick.ts:1315`, `src/lib/monitor/seatTick.ts:1479` |
| An episode overlay is delivered with a wake. The controller tracks `startedAt:updatedAt`; repeat wakes use a short reminder. A rotation or episode edit causes the full overlay to be delivered again. | `src/lib/monitor/seatTickController.ts:1385`, `src/lib/monitor/autonomy.ts:75` |
| The seat’s `monitorPrompt` is a standing note. Operator instruction lines have separate authorship and timestamps; unattributed legacy text remains explicitly unattributed. Active autonomy wakes point to the complete note instead of embedding it. | `src/lib/monitor/seatTickInstructions.ts:13`, `src/lib/monitor/seatTickInstructions.ts:58`, `src/lib/monitor/report.ts:327` |
| A decision log entry requires the active project seat, matching episode start, stable id, decision, reason and undo. Reusing an id for different content fails. Ending the episode owes one report even when wakes are off. | `src/lib/monitor/seatTickSettings.ts:669`, `src/lib/monitor/autonomy.ts:82`, `src/lib/monitor/seatTick.ts:1304` |

**Consequence:** invention has some existing authorization in full autonomy. This proposal adds deliberate, evidence-backed mining of quality-of-life opportunities, with explicit provenance and an allowance. It must reconcile that permission with the base mandate and existing source prompts. A new checkbox alone would leave contradictory instructions.

### The existing control is reachable on desktop and phone

The production entry is `src/app/page.tsx:1`, which renders `Viewer`. The desktop route reaches `Viewer` → `OrchestratorDock` → `OrchestratorPanel` → `IncumbentHeader` → `SeatTickChip` → `SeatTickBody` (`src/components/Viewer.tsx:1814`, `src/components/orchestrator/OrchestratorDock.tsx:221`, `src/components/orchestrator/OrchestratorPanel.tsx:597`, `src/components/orchestrator/IncumbentHeader.tsx:170`, `src/components/orchestrator/SeatTickChip.tsx:151`).

On the phone, the seat card opens `MobileOrchestratorSheet`, whose tick branch mounts `MobileSeatTickSheet` and the same body (`src/components/mobile/MobileSeatCard.tsx:507`, `src/components/mobile/MobileOrchestratorSheet.tsx:188`, `src/components/mobile/MobileSeatTickSheet.tsx:58`). A tick notice on a task also opens that sheet (`src/components/mobile/MobileTaskScreen.tsx:952`). The autonomy subsection already has a toggle, duration selector and shared Save flow (`src/components/orchestrator/SeatTickBody.tsx:811`). These production paths justify extending that subsection. Evidence fixtures and DOM tests are verification callers.

The browser settings route and MCP tool share the authoritative settings module. The route derives the actor from the request, rather than a body-supplied actor (`src/app/api/monitor/seat-tick/settings/route.ts:81`, `src/app/api/monitor/seat-tick/settings/route.ts:120`). The current browser change type carries only autonomy enabled/duration fields (`src/components/orchestrator/useSeatTickSettings.ts:29`).

### Corrections, learned rules and problem reports

There is no observed dedicated correction feed in the inspected paths. A seat can obtain corrections from operator turns in `search_transcripts`, then open the actual surrounding turns with `conversation_messages`. Attributed operator instruction lines provide another source; a standing monitor note can contain stale statements and must be checked against newer turns.

Learned rules live in the `role_memory` collection of `state.sqlite` (`src/lib/memory/roleStore.ts:44`, `src/lib/memory/roleStore.ts:69`). Rules record their stage or seat source and scope (`src/lib/memory/roleTypes.ts:54`). Designated seats receive an orchestrator memory selector; launch delivery observes the memory setting and clean-role rules (`src/lib/memory/roleLaunch.ts:22`, `src/lib/memory/roleLaunch.ts:49`). A seat can also call `search_memory` with a project and query, then open a result by its exact id. Active role-rule searches read the current rule text, including rewrites (`src/lib/memory/mcp.ts:5`, `src/lib/memory/roleSearch.ts:5`).

The native-memory discovery code reads recognized engine instruction files, project memory files, Codex memory summaries and rollout summaries, and skills (`src/lib/memory/sources.ts:55`). These are evidence sources whose age, project and authority need checking. Reading them does not grant permission to rewrite them.

Concrete defects reported by stages or curators already reach the seat as `memory-problem:` signals. Their full evidence is readable with `seat_tick_settings verbose:true problemId=…`; the current signal explicitly asks for operator agreement before task creation (`src/lib/memory/roleProblems.ts:59`, `src/lib/memory/roleProblems.ts:69`, `src/lib/monitor/report.ts:398`). A proactive overlay must explicitly handle that asking instruction within its narrow permission; forbidden work keeps the existing ask.

### Earlier answers, opened and dated

All three seat records below have the indexed transcript title **“You are the Orchestrator. Mode: standard. Safety fences: - Act on Delegatus only through its MCP to…”**. Dates and turn times distinguish them without publishing private transcript paths.

| Record read | What it establishes |
| --- | --- |
| Seat transcript, 2026-10-22, user turn 14:09:03Z | The originating request joins correction capture with optional invention of useful work inside full autonomy. It requests a designable mode, rather than authorizing arbitrary setting or account changes. |
| Seat transcript, 2026-10-21, assistant turn 09:50:53Z and delivered decision record 10:18:41Z | The seat selected recommended answers for the existing self-development plan’s remaining decisions and recorded undo. This concerns an already accepted plan. The answer also distinguished deciding a form from executing its work. |
| Seat transcript, 2026-10-22, opened wake 01:54:02Z; task opened separately | The agenda still names **“Завершити погоджений план самостійного розвитку”** as accepted work with no open lane. The task’s current text and history confirm a nine-scene MVP was approved on 2026-10-09; remaining decisions were selected on 2026-10-21. Its remaining implementation belongs to existing tasks. Its presence is no evidence that a new discovery task should duplicate it. |
| Transcript **“Fix the visual critic’s findings on this pipeline’s branch; refresh the rendered evidence for the touched surfaces…”**, 2026-10-15, user brief 08:47:59Z | Preserves the earlier full-autonomy requirement and the operator’s 05:47Z answers: own findings are a work source after Inbox, existing issues and maintenance; new tasks carry an autonomous mark; releases retain their specified gate exception; one end report returns to the operator. Current code agrees (`docs/design/full-autonomy-mode.md:3`, `src/lib/monitor/autonomy.ts:77`). |

Search procedure: project-scoped `search_transcripts` queries for the exact self-development task title, “самостійного розвитку”, “full autonomy”, “автономии”, and “автономия решения”; unscoped queries for “саморазвития” and “самостійного розвитку”. Search fragments were opened for the 2026-10-21 seat, the 2026-10-22 self-development wake and the earlier autonomy brief; the originating turn was opened in the current seat. The self-development task was corroborated by `list_tasks` with full records. Its complete historical conversation was not reconstructed, so this document makes no claim that every planned slice shipped.

Project-scoped memory searches for “autonomy” and “operator corrections”, and an unscoped “self development autonomy” search, returned no entries. An exact-id search and open found `r_1ac3a404530311a9`, written 2026-10-22 at 14:10:28Z. The correction evidence used here is the operator turn itself. Learned-rule bodies stay out of public text.

## 2. Proposed mode

### Switch and authority

Add `autonomy.proactive.enabled`, default false, to the existing episode. The UI adds one subordinate Toggle inside Full autonomy, sharing its Save action. Suggested copy: **“Invent useful improvements” / “Придумувати корисні покращення”**. Supporting copy states the allowance and source basis in one sentence. The control is available in the autonomy draft; saving an enabled child requires active full autonomy in the resulting server state. There is no new page, top-level mode, chip animation or separate timer.

Only the operator enables this child permission. The project seat can turn it off with a reason and cannot re-enable it, extend its parent episode or increase its allowance. Parent off, expiry or wakes off removes invention authority. A new parent episode defaults the child off; extending an active episode preserves the choice and consumed allowance. Temporarily disabling/re-enabling the child never replenishes it. Server-derived effective state governs every action; a stale prompt or persistent monitor note grants nothing.

Preserve the accepted 2026-10-15 behavior for existing work and directly observed defects. The new child permission covers deliberate mining and inferred improvements: for example, deriving a shorter workflow from repeated corrections. With the child off, the seat can continue accepted work and handle an observed defect under existing authority; it can propose additional improvements through the ordinary decision path. Update the mandate, autonomy overlay, idle agenda and problem-report wording together so this distinction is explicit. A candidate cannot evade the allowance by calling an inferred convenience feature a defect.

### Discovery and scoring

After owed work, inspect sources in the existing priority order: Inbox and accepted tasks, existing forge issues, maintenance suggestions, then the seat’s findings. Within the last category, mine:

- Operator corrections: open the operator turn and enough surrounding conversation to separate a misunderstood request from a new request. Newer answers override older ones.
- Learned rules and memory: search this project first, open matching ids, follow their source pointers and verify the current behavior. A rule describing a practice may justify improving a workflow; it does not automatically justify product code.
- Recurring problem reports: open the full `memory-problem:` evidence and confirm the defect or friction still exists.
- Board patterns: repeated manual retries, recurring parked causes, duplicate asks and unfinished accepted outcomes. Verify individual tasks and lane results; a large count alone proves no user benefit.

Use at most three discovery queries and open at most five source records per discovery pass. Use existing bounded reads, with a cursor for later work. Record a short pass result in the episode decision log: candidate admitted, deferred or no supported candidate. Run at most one discovery pass per project per hour and only after the seat handles owed items. An evidence revision change can inform the next pass; it creates no extra timer or continuous polling. The cheap tick never scans transcripts, opens memory bodies or calls a model.

Every candidate needs a private source reference with title/date or rule/problem id, a present-day code observation or reproduction, a concrete user outcome, one acceptance check, estimated lane scope and an undo description. Keep private text in local task details; repository briefs receive a safe paraphrase and repo-relative evidence.

Score each dimension 0–2: **benefit** (cosmetic preference / removes a repeated step / prevents a failed or lost user action), **recurrence** (one occurrence / two independent occurrences / repeated across dates or tasks), **confidence** (memory only / current code observation / reproduced current behavior), and **effort** (cross-cutting / one normal lane / one small lane). Total 0–8. Auto-start at **6 or above**, with benefit and confidence each at least 1, a clear acceptance check and all scope gates satisfied. This is a reviewable ranking heuristic; it is no measurement of value or savings. One reproduced severe friction can qualify without recurrence. Break ties by stronger current evidence, then smaller scope. Present every other supported candidate in the existing operator decision form, held until the operator answers; base autonomy cannot answer these proposal forms for the operator.

Reject candidates that duplicate an open or completed outcome, contradict a newer correction, or cannot name an observable improvement. Send supported candidates requiring product-direction choices to the operator decision form. Reuse the existing task when an accepted outcome already owns the work. For example, a lingering self-development plan points to completing its remaining approved tasks.

### Allowance and account budget

The operator decided these initial limits on 2026-10-22 at 14:48Z. They are fixed implementation defaults, shown in the supporting copy. Changing them requires a new operator decision.

| Limit | Enforcement and meaning |
| --- | --- |
| Two invented tasks per episode, also at most two per project in a rolling 24 hours | Count each admitted candidate once, including proposals, failures and rejected work. Replays reuse its key. A new episode or a seat rotation cannot replenish the rolling allowance. An unlimited episode still has two tasks until the operator starts another episode. |
| One active proactive lane per project | Includes successors, retries and review/fix activity for the outcome. A parked or paused lane retains its reservation until safely closed, explicitly adopted by the operator, or rejected and confirmed quiescent. No helper agents or sibling pipelines bypass it. |
| Existing project worker limit | Every stage still counts under the ordinary worker and resource admission. Accepted work waiting for capacity takes precedence over proactive work. |
| Account headroom | Before each new model dispatch, require an allowed account with a successful usage observation no older than five minutes and every reported governing session/weekly window below 80% used. Missing governing windows or unknown capacity defer discretionary work. Recheck retries, reseats and successors. Existing credit guards remain decisive. |
| Scope | One small reversible outcome, one normal lane with the project’s existing review budget. A larger discovery becomes a proposal. Runtime-host, deployment machinery, Bun pins, authentication and data migrations require an explicit operator task. |

The 80% threshold is an **admission reserve**. Provider reporting lag and already running calls can consume additional allowance; this design promises no exact monetary or token ceiling. Do not add a guessed currency meter. Use current account selection and usage observations; preserve credit guards (`src/lib/accounts/creditGuard.ts:26`). Automatic selection stays within project bindings. The current selector has an explicit named-account escape (`src/lib/accounts/projectSelection.ts:196`); proactive admission must refuse that escape and must never acquire extra accounts or change tiers to proceed.

The two-task count and single-lane reservation are hard server limits. Keep a bounded allowance row per project in the existing SQLite state mechanism: current episode consumption, admission timestamps from the last 24 hours, and the active task/lane reservation. Prune timestamps outside that window during admission; preserve current-episode consumption separately. A restart reads that row; no counter lives only in a conversation or process.

### Board record, rejection and undo

Use the existing task card and task details. Add a compact, immutable `proactive` provenance field containing episode, candidate key, source references, score and admitted scope hash. Its visible board marker is **“Autonomous improvement” / “Автономне покращення”**. It survives task renaming, notes, status changes, pipeline successors and seat rotation. Keep ordinary task status and color/icon conventions; there is no second candidate board.

Creation must make the task visible through the existing automatic board placement. MCP currently defaults tasks to `unplaced` (`src/lib/mcp/bindings.ts:2170`), and that placement has no visible board position (`src/lib/tasks/types.ts:219`), so a plain create response is insufficient. Read back both task and board visibility before reporting a start. A proposal uses Inbox plus an operator hold so full autonomy cannot immediately consume it as unaccepted Inbox work. Only an authenticated operator acceptance can remove this hold or adopt the proposal; the seat cannot answer its own proposal form to bypass the score, scope or allowance.

The task’s human description says the outcome and why it helps. Details hold the evidence, scoring, acceptance and undo. Log its creation/start in `autonomyDecision` and include its final state in the existing end report. A timed episode ends discovery and new admissions. Work admitted earlier may finish its current owned operation; every later stage dispatch and merge/deploy decision rechecks authority. If no ordinary accepted-work authority exists, pause the lane at the next safe boundary and retain its artifacts for the operator.

Reuse the task’s existing action menu for **“Reject improvement” / “Відхилити покращення”**, shown for this provenance only. It writes an operator rejection first and requests a safe pause of the exact associated lane. An unstarted task becomes Done with its rejection reason. A running one remains visibly stopping/paused until the controller confirms that state; preserve all changes. Release its lane reservation only after owned execution and uncertain effects are reconciled and the rejection fence prevents resume. Hiding a card remains a visibility preference and rejects nothing (`src/lib/tasks/types.ts:240`).

Retain rejection and the stable outcome key on the task. Search rejected outcomes before every admission, including hidden/Done cards; use the existing finding-key mechanism with rejection-aware lookup. Derive the key from the affected product surface and behavior, independently of the display title or memory wording. The server refuses a rejected key across episodes. The seat and reviewer also compare semantically equivalent outcomes; arbitrary paraphrase detection is no server guarantee. Only an explicit operator Reopen/Accept action clears suppression, and a materially changed scope needs fresh acceptance. A failed candidate can be retried within its same reservation and review budget; failure supplies no new task allowance.

Undo follows the effect already reached:

| State | Operator action and retained evidence |
| --- | --- |
| Proposed or queued | Reject it; no launch follows. Reopen is available. |
| Running or review | Reject writes the stop fence, pauses owned future work and retains the worktree/results. No reset, cleanup or deletion. |
| Reviewed, awaiting publication/merge | Reject fences further publication and merge. Reconcile any in-flight operation by its receipt before claiming it stopped. |
| Merged or deployed | Reject prevents follow-on work. Offer an ordinary, reviewed revert task after explicit approval. Describe the observed effect and the undo cost; never promise that deleting a board card reverses released code. |

### Episode prompt draft

Keep the existing forbidden-actions and decision-log clauses. Add this instruction when the child permission is active, with actual allowance and headroom values substituted by the server:

> Proactive QoL is ON for this episode. After owed work, inspect project corrections, learned rules, problem reports and board patterns. Open sources; verify current friction; deduplicate. Score benefit, recurrence, confidence and effort. Start qualifying small reversible work with a named user outcome and check; put other supported candidates in an operator decision form. Use create_task with proactive provenance; record why and undo. Maximum 2 new tasks per episode and per rolling 24h, 1 active lane; account windows must be fresh and below 80% used. Recheck mode, task revision, slots and capacity before every start. A rejection stays rejected until the operator reopens it. Keep all autonomy prohibitions and gates. At expiry/off, fence new dispatch/effects and pause after the current operation. Log proposals and completed work for the end report.

Repeat-wake draft:

> Proactive QoL ON; use the current episode allowance and rejection records.

These are product-authored prompt drafts. Every wake also carries effective remaining allowance or a reason discovery is paused. `seat_tick_settings verbose:true` returns the complete policy. A mode revision invalidates the controller’s delivered-overlay stamp. An inactive reminder explicitly removes the child permission when the parent episode continues.

Prompt sizing observation: an isolated Bun probe called the actual `seatTickWakeMessage` at the inspected revision, using project `viewer`, an eight-hour episode starting at 2026-10-22 00:00Z, an empty `autonomy-idle` agenda with reason “No owed work remains.”, worker limit three, zero running workers and `mandateCarriesContract:true`. Appending two newlines and the exact drafts above changed a fresh wake from **1,413 characters / 1,415 UTF-8 bytes** to **2,272 / 2,274**, and a repeat wake from **506 / 508** to **582 / 584**. This proves headroom for that input only. `boundedSeatTickMessage` preserves the entire reserved tail and can exceed its 4,000-character target when that tail alone is too large (`src/lib/monitor/report.ts:141`); catch-up also has a separate transport path (`src/lib/monitor/report.ts:350`). Before shipping, replace/repack overlapping work-source wording and test maximum instructions, reports, multibyte text and catch-up. Do not enlarge a bound on the strength of this small probe.

### Forbidden work and enforcement boundary

This permission must never change settings, account membership/bindings, spending/credit policy, worker limits, role mappings, operator sessions or unrelated checkouts. The only seat-owned setting action remains reducing its granted authority. It must never delete data, rewrite history, discard work, close another task’s active work, publish public issues/comments/social posts, send outside messages, or act on other projects. It cannot create billing/API-key fallback, relax a review/privacy gate, alter an existing operator decision, or invent a product roadmap. Normal reviewed repository publication and an already authorized project deploy still use their existing gates. The accepted release exception stays exactly as specified for full autonomy; proactive mode adds no release privilege.

Enforce the child switch, quotas, task rejection, revision and account-selection conditions server-side. The server cannot infer whether a natural-language idea is useful or whether the model deliberately omitted an invention label. Evidence quality, scope classification and the forbidden-action policy also require the seat mandate and independent review. This change is no new sandbox for a broadly authorized seat. Do not claim that a prompt makes arbitrary outside actions impossible.

## 3. Implementation contracts and choices

### Shared paths to change together

| Contract | Producers, consumers, defaults and cascades |
| --- | --- |
| Episode setting | Extend `AutonomySetting` and `AutonomyChange` in `src/lib/monitor/autonomy.ts`; normalization, defaults, history, schedule lapse/reset and parent-off paths in `seatTickSettings.ts`; the answer in `seatTickSettingsAnswer.ts`; browser PUT; MCP schema/binding; UI draft/change shape. Older/imported records default the child off. Plain schedule expiry preserves the episode’s actual state. Parent expiry ends the child. No imported actor or caller body can grant permission. |
| Prompt authority | Reconcile `orchestrator/prompt.ts`, `autonomyMandate`, `seatTick.ts` idle reason, `report.ts` reserved tail, controller overlay revision, and `memory/roleProblems.ts` asking text. Full/short overlay, rotation, manual continuation, missing-source and end-report paths use effective server state. Notes never enable the feature. |
| Task scope and provenance | Extend task types, commands, validation/serialization, revision hashing, browser/MCP read projections, automatic placement and action menu. Inspect create/patch/refine, curator changes, linked replication, imports/restores and undo/reopen. Local invention authority and allowance never replicate to another project or installation. Keep private source references local; public text is paraphrased. |
| Launch and subsequent effects | Apply one shared eligibility check at task-to-pipeline creation and every actual stage/spawn dispatch, including HTTP/MCP paths, retries, fail branches, resume/recovery, successors and reseats. Preserve provenance on inherited task links; unrelated task attachments cannot launder it. Recheck before publication, merge and deploy when those rely on proactive authority. A queued launch has no permanent permission to dispatch. |

Concrete entry points for that shared-path inventory are task commands `createTask`/`patchTask` (`src/lib/tasks/commands.ts:350`, `src/lib/tasks/commands.ts:509`), browser task routes and MCP `createBoardTask` (`src/lib/mcp/bindings.ts:2159`), pipeline HTTP creation and MCP creation into `createPipelineFromRequest` (`src/app/api/pipelines/route.ts:173`, `src/lib/mcp/bindings.ts:2383`), `src/lib/pipelines/engine.ts`, and `src/lib/agent/spawnCommand.ts`/`spawnAdmission.ts` behind ordinary spawn, task-spawn and runtime-spawn routes. Before enabling starts, implementation must trace each of those routes to the dispatch check and list any route that answers earlier. The check is a shared function; duplicating policy in each transport is unnecessary.

Task scope is keyed by a content hash over the outcome text, details/acceptance, scope-bearing steps and attachment content identities; position, notes and progress stamps do not change it. Freeze the admitted pipeline specification/graph with that grant. Changing scope under the same task id, restoring older content, editing a linked task, or replacing a brief invalidates the grant; an eligible seat must revalidate within the original reservation, or the operator explicitly accepts the new scope. Ordinary status and note updates retain it. Copying a task creates a new ungranted candidate and consumes allowance if admitted. An explicit operator acceptance transfers execution to ordinary accepted work but preserves its history and original rolling count.

Admission must write candidate/task identity and the allowance reservation atomically in the same state database, using the existing transaction mechanism. A crash cannot create an uncounted task or a consumed slot with no recoverable identity. A timeout retries the same request key and reads back the result. Revalidate the real current parent/child state, seat epoch, task scope/rejection and capacity at dispatch; reading back a previously prepared request proves none of them. Use asynchronous state-lock admission with a deadline and an operation label. Read the single project allowance row and targeted task keys; no whole-store parsing or model work enters the controller loop. Rejection lookup uses keyed reads, and carries no new unbounded in-memory cache.

### Options considered and decided

| Choice | Options and trade-off | Operator decision, 2026-10-22 14:48Z |
| --- | --- | --- |
| Execution | Invent-and-start provides the requested unattended progress. Invent-and-propose reduces execution risk but leaves each useful idea waiting for an answer. | Auto-start qualifying small candidates; keep every other supported candidate in a held operator decision form. |
| Allowance | One task provides a narrow trial. Two allows a second independent improvement after the first settles. Five permits substantially more speculative work. | Two per episode and rolling day, one active lane. |
| Account reserve | Existing exhaustion guards maximize utilization. An additional 80% admission threshold preserves capacity for requested work but can leave available usage idle. | Start with 80%, fresh observations and no extra paid fallback. |
| Off and expiry | Letting all admitted lanes continue spends authority after the episode. Interrupting active commands risks incomplete work. | Fence new dispatch/effects immediately; let the current operation settle, then pause unless ordinary acceptance authorizes continuation. |
| Compatibility | Narrowing all existing autonomy findings would change the 2026-10-15 agreement. Keeping direct defect handling while gating deliberate invention preserves that workflow, with a classification boundary to review. | Preserve direct observed-defect authority; require the child for inferred improvements and systematic mining. |

### Implementation slices and acceptance

1. **Episode flag and authority, one small lane.** Add only the typed child flag, default/normalization, effective read projection, browser/MCP transport and actor validation. No discovery or task launch uses it yet. Acceptance: old/imported records read off; operator enable works only with a valid parent; seat/agent/cross-project enable fails; seat disable works; extension preserves episode identity; parent off/expiry and a new episode cannot revive the child. Exercise the existing `src/lib/monitor/autonomy.test.ts`, `src/lib/monitor/seatTickSettings.test.ts`, and `src/app/api/monitor/seat-tick/settings/route.test.ts` by explicit path.
2. **Allowance and provenance.** Add the bounded allowance row and atomic task admission, rejection-aware candidate lookup, scope hash and safe read projections. Keep starts disabled. Acceptance: third candidate refuses; parallel admissions cannot exceed two; replay creates one visible card; process restart, new episode within 24 hours, hidden/Done tasks and failed outcomes preserve counts; task edits/restores invalidate scope; notes do not. Reject then paraphrase the candidate and confirm it stays suppressed. Test the actual task command/store and allowance transaction with isolated state.
3. **Dispatch, effect and rejection fences.** Connect shared eligibility to every path in the launch contract; implement the server commands for operator rejection and explicit adoption. Acceptance: prepare a start, then independently expire/disable the mode, rotate the seat, reject/edit the task, fill the slot or exhaust allowed capacity before dispatch; each must refuse. After off or expiry, let the current operation settle, then confirm the invented lane is safely paused with new dispatch and effects fenced. Cover recovery, fail-edge, successor, direct spawn, HTTP and MCP entry paths. Test rejection racing publication/merge and reconcile the effect’s actual receipt. Verify preserved artifacts and reopen behavior; no reset or deletion. Critical-runtime changes discovered necessary here require the project’s three review rounds.
4. **Prompt and bounded discovery.** Reconcile authority wording and deliver the drafts plus effective allowance. Start only candidates passing the implemented fences. Acceptance: a scripted seat proposes an unsafe or over-budget candidate and the server refuses it; the current self-development task is reused; stale/conflicting corrections produce a proposal; a valid small friction starts at once with one task and lane; every other supported candidate gets an operator decision form and a hold the seat cannot clear; no evidence gives no task. Fresh usage at exactly 80% or above, stale observations and missing windows refuse new invented-work dispatch; fresh known governing windows below 80% admit it when the other gates pass. Child off preserves today’s observed-defect handling and prevents deliberate invention. Test the negative paths with a deliberately noncompliant script. Inspect fixtures for every tool, result field and actor shape used. Run `src/lib/monitor/autonomy.test.ts`, `src/lib/monitor/report.test.ts` and the explicit affected controller files. Stress reserved tails and catch-up, retain report/forbidden clauses, and record final byte counts.
5. **Shared panel and rendered evidence.** Expose the child Toggle and effective pause/allowance copy in the existing autonomy subsection; use the same Save and task action menu. Update both locale sets. Acceptance: off, active/draft/saved, exhausted, unknown capacity, rejected, ended and saving/error states remain usable on board, dock and phone. Capture with the existing full-autonomy case in `src/components/kanban/kanbanBoard.browser.test.tsx`; extend its fixture rather than adding a driver. Cover 390 and 1440 pixels and 915 between them, dock widths 360/440 and 400 between them, en/uk, light/dark and reduced motion. Inspect text ranges, keyboard/focus, inert sheet background, target sizes and action reachability from task notices. Optimistic changes roll back to the last confirmed state on failure.
6. **End-report rehearsal and enablement.** In isolated state, run a complete episode through two candidates, a rejection, a restart, expiry and a second episode. Acceptance: allowance and suppression survive; one existing autonomy report includes outcomes, deferred/forbidden choices, why and precise undo; off and expiry fence new dispatch and effects, pause invented lanes after the current operation, and preserve their artifacts; accepted work proceeds independently. Ship off by default. Enabling on a live project remains the operator’s explicit action.

Tests/builds/browser checks belong in scratch exports with private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, `LLV_STATE_DIR` and a closed Viewer control URL. Run explicit test paths with the project’s `bun run test` command through the required remote gate and owned gate-slot wrapper. No live-state regression test is part of this plan. A docs-only design needs publication/privacy and whitespace checks; it makes no runtime performance claim.

## Deferred — not currently justified

- A new ideas dashboard, autonomous roadmap or separate discovery agent. The seat, task board and tick already supply the required surfaces and lifecycle.
- Embedding/vector search, a new memory store, or automated rewriting of operator memories. Existing search and curator mechanisms supply evidence.
- Cross-project or cross-install invention, public issue generation, marketing/messages and account optimization. The request grants none of these actions.
- Automatic high-risk migrations, runtime-host changes, infrastructure work or product-direction changes. These remain explicit tasks with their normal review requirements.
- Exact per-episode currency/token limits and automatic budget/tier changes. Admission reserves cannot supply exact provider-side accounting.
- Additional allowance sliders and alternative chip effects. Begin with one child Toggle and fixed limits; reconsider only from observed use.

## Requirement check and document validation

The proposed child mode grants the requested invention and execution authority for improvements grounded in corrections and memory. Current observations precede it; citations identify the existing permission overlap and the earlier accepted self-development work. Scoring, task/worker/account limits, board visibility, rejection and effect-specific undo are defined. Settings/accounts/public communications/deletions remain excluded. The slices begin with a flag-only lane and reuse existing UI and workflow machinery.

Validation for this document: source and primary-record inspection, an isolated prompt-sizing probe, final citation/path checks, whitespace inspection and the repository publication privacy gate on this file. Product tests and browser renders are implementation acceptance, since this stage changes no product surface. Exact check results are reported with the stage.

## Operator decisions, 2026-10-22 14:48Z

Source: the operator’s five answered choices, relayed by the controller in the design-stage decision continuation. The operator accepted every recommendation. These decisions replace the open questions and govern the options and slices above; no policy question remains open.

1. **Execution:** start invented work at once when it qualifies as small and safe. Present every other supported candidate in the existing operator decision form and wait for the answer.
2. **Allowance:** at most **two invented tasks per episode and per rolling 24 hours**, with at most **one active invented lane**. Restarting, rotating the seat or toggling the child permission replenishes neither count.
3. **Account reserve:** stop starting invented work when an account has used **80% of a governing window**, using fresh known observations. Keep the existing credit and account-binding guards. The five-minute freshness bound above is the implementation default.
4. **Off and expiry:** fence new dispatch and effects immediately, let the current operation settle, then pause invented lanes safely with their artifacts retained. Ordinary operator acceptance can authorize later continuation.
5. **Compatibility:** preserve today’s full-autonomy handling of directly observed defects. Gate deliberate invention and systematic mining of inferred improvements behind the child permission.
