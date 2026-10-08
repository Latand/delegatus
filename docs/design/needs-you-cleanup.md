# Board cleanup reads and clears «Чекають на вас»

Status: design. Written against `main` at `419c0f67b` (2026-10-09). File and
line references are to that commit. This stage wrote only this document.

## Originating requirement

Operator, 2026-10-09 about 02:25 Kyiv, voice-dictated into the Delegatus
project's orchestrator seat chat, with a screenshot of the desktop
«Чекають на вас · 13» panel (delegatus 4: two «Прототип готовий» rows for
tasks whose later prototype rounds were already decided, #2537 parked on a
spent review budget that the seat had already handed to the merger, the
seat's own question report; CelestiaCompose 8; bonavita-odoo-dev 1).
Verbatim, as the seat pinned it:

> Вот эту хуйню, кхм, чекают на вас, э-э, там где можно зняты. Надо, чтобы
> была возможность, когда чистится доска, чтобы можно было и каким-то
> инструментом проверить вот это тоже, что там есть, и почистить, чтобы там
> убрать оттуда ненужное. Чтобы там оставалось только актуальное.

In English, condensed: when the board is cleaned, a tool must be able to see
what that panel holds and clear what is no longer needed, so only what is
current stays.

What the seat found the same night, from its transcript: it cleared #2537
with a pipeline target and the two prototype tasks with task targets; the
answer named the tasks' conversations and lanes and said nothing about the
prototype rounds, and the seat had no way to see whether the rows were gone.
It asked the operator to check and press «Зняти» by hand.

The pinned outcomes, in short: (1) a bounded seat read of exactly the rows
the panel shows for one project, computed by the panel's own code, each row
with the evidence the server already holds about whether it still asks
anything; (2) `dismiss_attention` clears every kind of row, a waiting
prototype round included, with an optional one-line reason the read returns
beside who cleared it, undo intact, no UI change; (3) the board maintenance
report gets a «Чекають на вас» section, rows that ask nothing first; (4) one
mandate paragraph tells the seat to walk it; (5) authority unchanged. The
#2608 class (an older undecided round counted as waiting) is fixed by #2625
and is not re-fixed here.

## Decision in one paragraph

The panel's rows come from one pure function, `buildNeedsYouQueue`
(`src/components/attention/attentionQueue.ts:59`), over the operator's
`/api/files?view=summary` representation. The read runs that same function on
that same representation inside the Viewer, keeps the project's entries and
adds evidence from stores the server already holds. It is offered as the read
form of `dismiss_attention`: called without `target`, the tool answers the
project's rows, each carrying the exact `target` that clears it. That follows
the established read-when-no-change pattern of `seat_tick_settings`,
`auto_updates`, `role_presets` and `account_project_binding`, so the
maintainer can read and still cannot clear. `dismiss_attention` gains two
target kinds it lacks today (`report` and `prototype`), a documented
`reasonId` on conversation targets and `laneMovedAt` on pipeline targets, a
task target that also covers the task's waiting prototype round, and an
optional `reason` stored on the record each subject already keeps. The
board maintenance report (`src/lib/orchestrator/boardReport.ts`) gets a
section 9 from the same read, rows with evidence that they ask nothing first.
The mandate's board-report paragraph gains one clause naming
`dismiss_attention` and pays for it by trimming its own words, so the
delivered default stays inside the structured envelope (v42).

## 1. The one module

`buildNeedsYouQueue(files, pipelines, now, closing, decision, tasks)` at
`src/components/attention/attentionQueue.ts:59-71` is the panel's only source:

- `src/components/Viewer.tsx:982` computes `needsYou` from it, over
  `files` (the polled payload after `withoutArchivedPredecessors`,
  `Viewer.tsx:295-309`), `pipelines` and `tasks` from `useFiles`
  (`Viewer.tsx:251,256`), the self-update feed's `auto.decision`
  (`Viewer.tsx:969-970`) and the closing set.
- The desktop panel takes `queue={needsYou}` (`Viewer.tsx:1523`) and cuts it
  into project sections with `needsYouSections`
  (`src/components/attention/needsYouPanel.ts:34-48`).
- The phone sheet takes `shellEntries` (`Viewer.tsx:1304`), which is the same
  `needsYou` filtered by `attentionEntryProject` (`Viewer.tsx:1284-1287`),
  and cuts it with the same `needsYouSections`.

The browser polls `/api/files?view=summary` (`src/hooks/useFiles.ts:101-107`).
That representation is cached per scope in the files route
(`src/app/api/files/route.ts:393-516`, scope key from
`projectionScopeKey(pinnedPath, summary, agent)`), and a dismissal already
changes its key through `hotStateSignature("attention_dismissals", …)`
(`route.ts:249`).

## 2. Every row kind, and whether `dismiss_attention` clears it today

`buildNeedsYouQueue` emits four entry kinds; a conversation entry carries one
reason from `undismissedReason` (`src/components/attention.ts:272-366`).

| Row kind | Produced at | Panel prints | Cleared by `dismiss_attention` today? |
|---|---|---|---|
| `decision` with a report (the seat's question report) | `attention.ts:278-282` (`askReason`, `:258-270`); several open asks of one seat become several rows at `attention.ts:392-399`; the asks come from `openBridgeAsks` (`src/lib/bridge/asks.ts:183-196`) | report's first line, «Питання» (`decision.ts:102-104`) | **Hidden, never resolved.** The MCP schema has no `report` target (`src/lib/mcp/server.ts:4046-4057`; `parseDismissalTarget(…, { allowSubjects: false })` at `bindings.ts:6417`). A conversation target on the seat writes a record with no `reasonId` (`dismissals.ts:388-389`), which covers every clocked reason raised at or before it (`attention.ts:229-235`), so the row leaves the panel. The report log keeps the question open, because only a `report` subject reaches `resolveReports` (`dismissals.ts:512-517`); the panel's own Dismiss sends one (`needsYouPanel.ts:118`). The two surfaces disagree after an agent's clear. |
| `question`, `plan` | `attention.ts:283-296` | the question's header or «Plan to approve» | **Yes, when clocked.** Same by-time cover. A question whose `askedAt` does not parse is `clocked: false` (`attention.ts:287-293`) and is never covered by an agent's record. |
| `permission` (structured host request) | `attention.ts:300-312` | tool, command and reason | **Yes, when clocked** (same rule, `:303-308`). |
| `permission` (pane-scraped prompt) | `attention.ts:314-316` | «Permission prompt» | **Yes** (always clocked). |
| `delivery` (message not delivered for 30 min) | `attention.ts:318-335` | «Message not delivered» | **Yes.** `raisedAt` is at most now when the row shows. |
| `launch` (an operator launch that failed before it ran) | `attention.ts:336-348`, `failedOperatorLaunch` `:145-152`; the row's path is a `spawn:` placeholder projected only by `/api/files` (`response.ts:304-309`) | the receipt's first error line | **Unproven, probably no.** The binding resolves the target's project with `entryForPath` over the completed scan (`bindings.ts:6117-6121`), which carries no `spawn:` placeholder, so the call is expected to throw before anything is written. The first failing test below settles it. |
| `memory` (a host killed for memory in the last 24 h) | `attention.ts:349-355` | stage or role | **Yes.** |
| `ask` («Asks you») | `attention.ts:358-362` | the agent's sentence | **Yes.** |
| `lane-decision` (`needs_decision`) | `needsDecisionPipelineRows`, `src/components/mobile/mobileBoardModel.ts:320-335`, through `pipelineAsks` `:345-347`; kind at `src/components/attention/needReason.ts:82` | `needsYouLaneLine` (`needsYouPanel.ts:52-55`) | **Yes.** A pipeline or task target stamps `dismissedAt` (`dismissals.ts:480-509`, engine `setPipelineDismissal` `engine.ts:11322-11338`); `pipelineHiddenFromBoard` (`mobileBoardModel.ts:356-359`) then drops the row until the lane moves. |
| `lane-review` (`needs_review`, review budget spent) | same as above | «Review budget spent · ‹stage›» | **Yes**, same path. This is how #2537 left the panel. |
| `prototype` (a task's round waiting for a choice) | `prototypeReviewNotices`, `src/lib/prototypeReview/model.ts:52-63`, pushed at `attentionQueue.ts:68` | «Прототип готовий» and the task title | **No.** No dismissal subject names a round (`dismissalTypes.ts:39-63`); a task target expands to assignments and lanes only (`dismissals.ts:394-403`); `prototypeReviewNotices` reads no dismissal; the panel refuses it too (`needsYouPanel.ts:113,123`). This is the row the seat could not clear. |
| `update` (the self-update drain overran and waits for «deploy now / keep waiting») | `attentionQueue.ts:69`; the decision exists only while the drain overran and is neither admitted nor answered (`src/lib/selfUpdate/service.ts:402`) | the update decision card | **No.** It has no subject; the panel refuses it (`needsYouPanel.ts:112`); only `decideDrain` ends it (`service.ts:1115-1120`). |

A lane whose automatic merge stopped (`lane-merge`, `needReason.ts:97-111`)
marks its card and is not a panel row: `needsDecisionPipelineRows` reads only
`needs_decision` and `needs_review` (`pipelineBlockModel.ts:26,31`). It stays
out of the read for that reason.

## 3. The read: `dismiss_attention` without a target

### 3.1 Why this tool

- `board_snapshot` (`bindings.ts:4968-5025`) lists conversations from the
  raw completed scan: no bridge asks, dismissals, owed deliveries, permission
  requests, memory kills or launch placeholders, which `/api/files` adds
  (`response.ts:238-852`), and no lanes, rounds or update decision. It is open
  to every caller, workers included.
- `operator_snapshot` composes one view over the same raw scan
  (`src/lib/view/collect.ts:35-87`) with a strict per-view schema.
- A separate read tool would be a second name for the same subjects and the
  same authority. Bundling read and clear in one tool gives the seat each
  row's `target` in the shape the same tool accepts, which is the "check, then
  clear" the operator asked for.

Read-when-no-change is an existing pattern: `MUTATING_TOOL_READ_FIELDS`
(`src/lib/mcp/toolAllowlist.ts:311-315`) lets a maintainer or an issue
reporter call `seat_tick_settings`, `auto_updates`, `role_presets` and
`account_project_binding` as reads. `dismiss_attention` joins it with fields
`["target", "undo", "reason"]`, so a call carrying none of them is a read and
a call carrying any of them is a write. Receipts behave as for those tools: a
replayed `clientRequestId` answers the first result, so each read takes a
fresh key (the description says so).

### 3.2 Where it is computed

The MCP process cannot rebuild the `/api/files` projection, so the binding
asks the Viewer, like `read_prototype_review` does (`bindings.ts:7043-7045`):

1. **Shared projection read.** The scan-and-project sequence of the files
   route's `GET` (`route.ts:557-603`, minus `markBoardViewed`, the task-board
   migration and the 304 path) moves into
   `src/app/api/files/operatorProjection.ts` as
   `operatorBoardRepresentation(): Promise<FilesBody>`. It asks for the scope
   the browser polls (`summary: true`, no pin, `agent: false`), so a warm
   cache answers it, and `GET` calls the same function. An internal call
   carries no capability header, so it is the operator's representation,
   prototype summaries included (`response.ts:938-941`).
2. **The pure projection.** `src/lib/attention/needsYouRead.ts`:

   ```ts
   export function needsYouEntries(body: FilesBody, decision: AutoView["decision"], now: number, project: string): MobileAttentionEntry[] {
     const queue = buildNeedsYouQueue(withoutArchivedPredecessors([...body.files]), body.pipelines, now, [], decision, body.tasks);
     return needsYouSections(queue, project)
       .filter((section) => canonicalOrchestratorProject(section.project) === project)
       .flatMap((section) => section.entries);
   }
   ```

   The order is the panel's section order. `closing` is empty: it is a
   browser-only transient. When two raw keys fold to one canonical project
   the panel draws two sections and the read joins them; that is the only
   difference, and it is stated in the answer as `sections: n` when `n > 1`.
3. **Row text.** The title and line expressions at
   `src/components/attention/AttentionPanel.tsx:285-286` (and the prototype and
   update rows at `:281` and `:343`) move into a pure
   `needsYouRowText(t, entry)` in `needsYouPanel.ts`, which the panel calls
   unchanged and the read calls with `translate` for the operator's locale
   (`src/lib/i18n/core.ts:22`, `operatorLocale()`). The panel renders the same
   strings as before. The phone sheet decorates a decision with its role
   (`MobileAttentionSheet.tsx:328-330`); the read uses the desktop words.
4. **Evidence and the cleared list** (§4, §5.5) come from server stores in
   the same module, behind a `NeedsYouEvidencePorts` interface so the pure
   part is testable.
5. **Route.** `POST /api/attention/needs-you` with `{ project, kinds?, full?,
   cursor? }`, in `src/app/api/attention/needs-you/route.ts`. It refuses
   cross-origin requests, resolves the caller with `callerConversationId`
   (`src/lib/agent/operatorAuthority.ts`, as `prototypeWorld.caller` does at
   `src/lib/prototypeReview/world.ts:21-24`), and applies `permitNeedsYouRead`
   (§6) before it reads anything. The update decision is read from the
   self-update service's own view, the value its GET answers.
6. **Binding.** `dismissAttentionTool` (`bindings.ts:6413-6431`) branches:
   no `target` → check `permitNeedsYouRead` in-process first (the two-phase
   pattern of `dismissThroughService`, `bindings.ts:6373-6389`), then
   `viewerControlForCall(control, context).post("/api/attention/needs-you",
   …)` with the caller's capability, and redact the answer
   (`redactPayload`).

### 3.3 Parameters

```ts
dismiss_attention: z.object({
  clientRequestId,
  target: <today's union, plus report and prototype, §5.1>.optional(),
  undo: z.boolean().optional(),
  reason: z.string().max(200).optional()
    .describe("One line saying why: stored with the dismissal and returned by the read beside who cleared it."),
  /* read form */
  project: z.string().min(1).optional()
    .describe("Read form. Defaults to your seat's project; the operator's own session names one."),
  kinds: z.array(z.enum(NEEDS_YOU_ROW_KINDS)).optional(),
  full: z.boolean().optional(),
  cursor: z.string().optional(),
}).passthrough()
```

`NEEDS_YOU_ROW_KINDS` = the twelve kinds of §2 (`decision`, `question`,
`plan`, `permission`, `delivery`, `launch`, `memory`, `ask`, `lane-decision`,
`lane-review`, `prototype`, `update`), the vocabulary
`ConversationReasonKind` and `LaneReasonKind` already use
(`dismissalTypes.ts:18,22`) plus the two queue kinds. `undo` or `reason`
without `target` is refused (`INVALID_TARGET`).

### 3.4 Answer

```ts
interface NeedsYouAnswer {
  project: string;
  at: string;                 // server clock
  count: number;              // rows on the panel for this project
  staleCount: number;         // rows whose evidence suggests nothing is asked
  rows: NeedsYouRow[];        // panel order
  cleared: ClearedRow[];      // §5.5; newest first, at most 20
  omittedCount: number;       // rows past this page
  nextCursor?: string;        // id of the last row returned
  unavailable?: string[];     // evidence sources that could not be read
}

interface NeedsYouRow {
  id: string;                 // the panel entry id
  kind: NeedsYouRowKind;
  title: string;              // ≤ 90 chars, what the panel prints first
  line: string;               // ≤ 160 chars, the panel's second line
  since: string | null;       // ISO, needsYouEntrySince (needsYouPanel.ts:57-62)
  taskId: string | null;
  subject: { conversationId?: string; pipelineId?: string; stageId?: string; reportSeq?: number; reviewId?: string; decisionId?: string };
  target: DismissTarget | null;  // pass back unchanged to clear exactly this row; null for update
  stale: boolean;             // a hint (§4); never acted on by the server
  evidence: string[];         // compact: "code: text", at most 4, each ≤ 140 chars
}
```

`full: true` adds `path`, and turns `evidence` into
`{ code, stale, at, detail, source }` objects. Bounds: 40 rows by default
(`limit` is not offered; `kinds` narrows instead), and a 24 KB answer like the
list tools; past either, `omittedCount` and `nextCursor` say so and the next
page starts after that id. The seat's own panel row (its question report) is
included: it is on the operator's panel.

Each row's `target`:

| Kind | `target` |
|---|---|
| conversation kinds except a report | `{ kind: "conversation", conversationId, path, reasonId }` (the reason id the panel drew, so only that reason is covered, as the panel's own Dismiss does at `needsYouPanel.ts:119-125`) |
| `decision` with a report | `{ kind: "report", seq }` |
| `lane-decision`, `lane-review` | `{ kind: "pipeline", pipelineId, laneMovedAt }` (`drawnLaneMovement`, so a lane that parked again after the read answers `changed`) |
| `prototype` | `{ kind: "prototype", taskId, reviewId }` |
| `update` | `null`, with the evidence line `answer-only: the operator chooses deploy now or keep waiting` |

## 4. Staleness evidence the server already holds

Each code is a fact with its time. `stale` is true when any code in the
"suggests nothing asked" column holds. Nothing is removed automatically.

| Kinds | Code | Holds when | Source the server already has | Suggests nothing asked? |
|---|---|---|---|---|
| all conversation kinds | `operator-wrote` | the operator's newest message to this conversation was admitted after `since` | reply-suggestion admissions, read the way `questionEvidence` reads them (`src/lib/bridge/service.ts:104-131`) | yes |
| all conversation kinds | `later-turn` | a turn started after `since` | `FileEntry.lastTurn.startedAt` (`src/lib/types.ts:281`) | yes |
| all conversation kinds | `ended` | the process ended (`proc` `done` or `killed`) or the registry's liveness says the host is gone with the turn settled | `FileEntry.proc` (`types.ts:231`); `productionLivenessSources` (the read `agent_activity` uses) | yes |
| all conversation kinds | `task-done` | the task holding the conversation is done | task store (`task.assignments`) | yes |
| all conversation kinds | `lane-moved` | the conversation is a stage of a lane that completed, closed, or moved after `since` | `durableLineage.memberships` (`types.ts:314`), `laneMovedAt` (`src/lib/pipelines/laneMovement.ts`) | yes |
| `launch` | `relaunched` | the same task gained an assignment after the failure | task store | yes |
| `memory` | `resumed` | a turn started after `memoryKill.at` | `lastTurn` | yes |
| `decision` (report) | `seat-reported` | the same seat filed later reports after this question: count and the newest one's class and summary | bridge log, `log.reports` by `targetSeatConversationId` and `seq` (`src/lib/bridge/asks.ts:131-174`) | context |
| `decision` (report) | `expires` | when the 2 h TTL retires it | `BRIDGE_ASK_TTL_SECONDS` (`src/lib/bridge/types.ts:60`) | context |
| `lane-decision`, `lane-review` | `pr-merged`, `pr-closed` | the lane's pull request is merged or closed, as last read | work links in the same representation (`response.ts:943`; `WorkLink.state`, `checkedAt` at `src/lib/forge/workLinks.ts:33-48`) | yes |
| `lane-decision`, `lane-review` | `merge-queued` | `pipeline.merge.state` is live or `merged` | `PIPELINE_MERGE_LIVE_STATES` (`src/lib/pipelines/types.ts:1084-1086`) | yes |
| `lane-decision`, `lane-review` | `newer-work` | a pipeline filed under the same task was created after the lane parked, or the task gained an assignment after it (the seat handing the lane to a merger run lands here) | pipelines and tasks stores; the predicate the board report already uses (`newerLane`, `boardReport.ts:321-323`) | yes |
| `lane-decision`, `lane-review` | `task-done` | every task the lane is filed under is done | task store | yes |
| `lane-decision`, `lane-review` | `detail` | the first line of `stateDetail` | the pipeline | context |
| `prototype` | `later-round-decided` | a later round of the task was decided (after #2625 such a row stops showing; the code still answers for a summary from a linked board or an older poll) | `prototypeRoundsSuperseded`, `currentPrototypeSummary` (`src/lib/prototypeReview/model.ts:36-50`) over the task's full rounds | yes |
| `prototype` | `lane-moved-past` | the pipeline that published the round (`round.source.pipelineId`, `stageId`, `types.ts:64`) started a later stage after the round, or ended | pipelines store | yes |
| `prototype` | `task-done` | the task is done | task store | yes |
| `prototype` | `elsewhere` | the round belongs to a linked board and cannot be decided here | `task.prototypeReviewReplica` | context |
| `update` | `blockers` | the turns the drain waits on | `decision.blockers` | context |

A source that cannot be read (forge cache never filled, liveness timed out)
is listed once in `unavailable`; its codes are absent, so a missing source
never makes a row look stale.

## 5. Dismissal of every kind

### 5.1 Targets

`DismissalTarget` (`src/lib/attention/dismissalTypes.ts:43-51`) and the MCP
schema gain:

- `{ kind: "report", seq }`: the subject the panel already sends. Through MCP
  the binding reads the report's project from the bridge log and checks it
  with `permitAttentionDismissal` before the write, and passes it on so
  `resolveBridgeAsks` runs with `inProject` (its fence exists at
  `src/lib/bridge/store.ts:1028-1053`; the production port calls it without
  one today, `dismissals.ts:549`).
- `{ kind: "prototype", taskId, reviewId }`: new (§5.2).
- `reasonId` on a conversation target, documented. `parseSubject` already
  reads it (`dismissals.ts:321`); the schema states it.
- `laneMovedAt` on a pipeline target, documented. `parsePipeline` already
  reads it (`dismissals.ts:304-307`).
- A task target with no `subjects` also expands to the task's waiting
  prototype round (`subjectsOf`, `dismissals.ts:394-403`). That is the call
  the seat made that night; it now clears what the card shows. The operator's
  card always names its subjects, so its behaviour does not change.

A failed-launch row: when `entryForPath` misses and the path is a
`spawn:<launchId>` placeholder, the binding takes the project from the launch
receipt the registry holds, the same receipt `projectLaunchConversations`
projects the placeholder from (`response.ts:304`).

The `update` row stays answer-only. It exists only while a drain has overrun
and nobody has chosen (`service.ts:402`), so it is never stale, and the only
way to end it is a deploy choice that belongs to the operator. The read says
so on the row, and a `dismiss_attention` naming it is refused with
`UPDATE_NEEDS_ANSWER`.

### 5.2 The prototype round's record

Stored in the `attention_dismissals` collection beside conversation records,
with subject `prototype:<reviewId>`:

```ts
interface AttentionDismissalV1 {
  ...                      // unchanged fields (dismissals.ts:52-68)
  kind?: "conversation" | "prototype";   // absent reads as conversation
  taskId?: string;         // prototype records
  note?: string;           // §5.3
}
```

Why there and not on the round in the task store: the collection is already
in the files projection key (`route.ts:249`), retention and capacity already
apply, undo is a delete, and a round on the task is linked-board metadata
(`prototypeRoundMetadata`, `model.ts:6-14`) whose writes bump the task's
`updatedAt`; a caller's attribution would cross to another installation.
Keyed by the round id, a newer round is a different subject and asks again by
itself.

The service writes it when the round is the task's waiting round
(`currentPrototypeSummary(…).waitingReviewId === reviewId`), and answers
`alreadyClear` otherwise. `overlayAttentionDismissals` skips non-conversation
records.

The projection carries it to the board without UI: `withPrototypeReviewSummaries`
(`src/lib/prototypeReview/read.ts`) sets
`PrototypeReviewSummary.waitingDismissal?: { at, by }`
(`src/lib/prototypeReview/types.ts:93-100`) when a record covers
`waitingReviewId`. One predicate,
`prototypeWaitsOnOperator(summary) = !!summary.waitingReviewId && !summary.waitingDismissal`
in `model.ts`, replaces the three reads of `waitingReviewId` that raise
needs-you: `prototypeReviewNotices` (`model.ts:55-56`), the desktop card
(`src/components/kanban/kanbanModel.ts:672`) and the phone card
(`src/components/mobile/phoneKanbanModel.ts:165`). The review itself stays
open on the task and can still be decided.

### 5.3 The reason

`reason` on the call, one line, trimmed, at most 200 characters, passed
through `redactMonitorText`; a line break is refused (`INVALID_REASON`). It
is stored on the record each subject already keeps:

| Subject | Field |
|---|---|
| conversation, prototype | `AttentionDismissalV1.note` (`dismissals.ts:52-68`) |
| pipeline | `Pipeline.dismissedNote` beside `dismissedBy` (`src/lib/pipelines/types.ts:1015-1019`), written by `applyPipelineDismissal` (`engine.ts:11296`) and cleared on undismiss |
| report | `BridgeResolvedAskV1.note` (`src/lib/bridge/types.ts:270-276`), kept by `normalizeResolvedAsks` |

The attribution stays in `by`, which only the server writes. The answer
echoes `reason`. No surface renders it: the card keeps its «Cleared · ‹who›»
line as it is.

### 5.4 Undo

Unchanged for the existing subjects. A prototype undo deletes its record. An
undo clears the note with the record.

### 5.5 The cleared list

The read returns what the panel would show if nothing had been dismissed and
that is covered now, the same "cleared while still live" the card already
draws (`needReason.ts:88-90,110`):

- conversation reasons whose `attentionReason(file).dismissal` is set
  (`attention.ts:250-254`), with `note` from `attentionDismissalIndex`
  (`dismissals.ts:188`);
- lanes for which `pipelineHiddenFromBoard` holds;
- report questions in state `resolved` (`asks.ts:164-165`) still inside the
  TTL and on the current seat;
- prototype rounds with `waitingDismissal`.

```ts
interface ClearedRow { id; kind; title; taskId; cleared: { at: string; by: DismissedBy; note: string | null }; undo: DismissTarget }
```

## 6. Authority

| Caller | Read | Dismiss |
|---|---|---|
| Operator's own root or gateway session | any project | any project |
| The project's designated seat | its project | its project |
| Another project's seat | refused, `NEEDS_YOU_READ_NOT_PERMITTED` (cross-project) | refused, `DISMISS_NOT_PERMITTED` (unchanged) |
| Maintenance run (`agentRole` `maintainer`) | its run's project | refused by `permitMaintainerTool` (`maintainer_tool_refused`), and by `permitAttentionDismissal` as a worker |
| Worker, issue reporter, unidentified | refused | refused (unchanged) |

`permitNeedsYouRead(authority, seats, maintainer, project)` goes in
`toolAllowlist.ts` beside `permitAttentionDismissal` (`:217-229`): it admits
what `permitAttentionHandoff` admits, plus a maintainer whose run's project is
`project` (`maintainerCallerOf`, `src/lib/boardMaintenance/guard.ts`). The
route repeats the check for a capability caller.

## 7. The report section

The board maintenance report is composed by `composeBoardReport`
(`src/lib/orchestrator/boardReport.ts:297-560`) from facts gathered in
`gatherBoardReportFacts` (`src/lib/orchestrator/boardReportRun.ts:293`), in
the Viewer, once per seat epoch (`seatCommand.ts:345`).

- `BoardReportFacts` gains `needsYou: NeedsYouAnswer | null`. The gather calls
  the same read in-process (§3.2 steps 1, 2 and 4, no route, no authority:
  it is Delegatus reporting to the seat) inside the report's source timeout
  (`BOARD_REPORT_SOURCE_TIMEOUT_MS`, `boardReportRun.ts:31`); a failure is a
  gap named `needs-you` in the header.
- A new section after GitHub, so sections 1–8 keep their numbers and tests:

```
9. Waiting for you (5; 3 with evidence they no longer ask) — the operator's «Чекають на вас» for this project. Read it again with dismiss_attention (no target) before you clear; each row there carries its target.
- prototype round <reviewId> on task <taskId> «<title>», 2 d: a later round of this task was decided 1 d ago
- lane-review <pipelineId> «<title>», 1 d: another lane on its task started 20 h ago; merge waiting-checks
- prototype round <reviewId> on task <taskId> «<title>», 3 d: the lane that published it moved past design
- decision report <seq> from this seat «<first line>», 3 h: this seat filed 4 reports since
- question in conversation <conversationId> «<title>», 5 h: no evidence
```

  Rows with `stale` first, then panel order; full ids; each row ≤ 200
  characters; the reason is the first two evidence texts. With no rows the
  section prints `9. Waiting for you: none.` A failed read prints
  `9. Waiting for you: unavailable (<reason>).`
- Caps: 10 rows. In the byte-cut order (`boardReport.ts:539-555`) it is cut
  to 3 rows after section 5, and to none just before section 3 goes to none.
  The `empty` test counts it.
- `BoardReportCounts` gains `waiting` and `waitingStale`.

## 8. The mandate paragraph

`ORCHESTRATOR_BOARD_REPORT_DIRECTIVE` (`src/lib/orchestrator/prompt.ts:252-253`),
current text (716 bytes):

> Each time you are seated, Delegatus makes one read-only pass over this board
> and sends it after your first turn, headed "[Delegatus] Board maintenance
> report". Your first turn gives status and leaves the board walk to it; later
> wakes still make their own pass. Take its sections in order and re-read each
> item before you change it. You alone change this board: close items one by
> one with the reason, and a card marked "ask first" only when the operator
> agrees. Offer its suggested issues with suggest_replies and start none
> unasked; where it finds no recorded priority, say so once and never ask for
> labels or fields. Cover an unavailable section or a missing report with your
> own reads.

New text (725 bytes):

> Each time you are seated, Delegatus sends a read-only board pass after your
> first turn, headed "[Delegatus] Board maintenance report". Your first turn
> gives status and leaves the board walk to it; later wakes still make their
> own pass. Re-read each item, section by section, before you change it. You
> alone change this board, one by one with the reason: close items (a card
> marked "ask first" only when the operator agrees) and clear Waiting-for-you
> rows that ask nothing with dismiss_attention. Offer its suggested issues with
> suggest_replies and start none unasked; with no recorded priority, say so
> once and never ask for labels or fields. Cover a missing section or report
> with your own reads.

The clause "one by one with the reason" now governs both closing and
clearing, and "rows that ask nothing" leaves every row that still asks. The
phrases `prompt.test.ts:557-561` pins are kept.

Envelope: measured on this commit, the delivered default is 29 379 bytes
against the test bound `MAX_STRUCTURED_TEXT_BYTES - 2 600` = 29 400
(`prompt.test.ts:755-786`, `src/lib/runtime/structuredContent.ts:40`). The
edit adds 9 bytes, to 29 388; the test's comment records the new figure. The
bound itself does not move.

Versioning:

- `ORCHESTRATOR_PROMPT_VERSION` 41 → 42 and the v42 fingerprint is added to
  `PROMPT_FINGERPRINTS` (`prompt.ts:95`, `prompt.test.ts:149`).
- The directive is recognized by its heading (`prompt.ts:572`), so a stored
  mandate carrying v41's exact text would keep it at its next delivery. The
  v41 text joins a `SHIPPED_BOARD_REPORT_DIRECTIVES` list replaced by exact
  match in `orchestratorMandateWithRoleTable` (`prompt.ts:616-634`), the
  mechanism the clock section and the greeting use. A reworded section is
  left alone, as today.
- Lane afc9c5cc (seat auto-rotation) may also bump the version or spend
  envelope bytes. Whichever merges second takes the next number and
  re-measures; the implementation merges `origin/main` before each review.

## 9. Files

| File | Change |
|---|---|
| `src/app/api/files/operatorProjection.ts` (new) | `operatorBoardRepresentation()`; `route.ts` `GET` calls it |
| `src/lib/attention/needsYouRead.ts` (new) | `needsYouEntries`, row and cleared projections, evidence, `readNeedsYou(project, ports)` |
| `src/app/api/attention/needs-you/route.ts` (new) | the read route |
| `src/components/attention/needsYouPanel.ts` | `needsYouRowText`; `AttentionPanel.tsx` calls it |
| `src/lib/attention/dismissalTypes.ts`, `dismissals.ts` | `prototype` subject and target, `note`, task expansion, record `kind`/`taskId` |
| `src/lib/mcp/server.ts`, `bindings.ts`, `toolAllowlist.ts`, `presentation.ts` | schema, read branch, report and launch project resolution, `permitNeedsYouRead`, `MUTATING_TOOL_READ_FIELDS`, description |
| `src/lib/pipelines/types.ts`, `engine.ts` | `dismissedNote` |
| `src/lib/bridge/types.ts`, `store.ts` | resolved ask `note`; `inProject` from the service |
| `src/lib/prototypeReview/types.ts`, `model.ts`, `read.ts` | `waitingDismissal`, `prototypeWaitsOnOperator` |
| `src/components/kanban/kanbanModel.ts`, `src/components/mobile/phoneKanbanModel.ts` | call `prototypeWaitsOnOperator` |
| `src/lib/orchestrator/boardReport.ts`, `boardReportRun.ts` | section 9 and its fact |
| `src/lib/orchestrator/prompt.ts` | the paragraph, v42, shipped-text replacement |

## 10. Failing-first tests, by seam

Each runs by path with `LLV_STATE_DIR`, `HOME` and `TMPDIR` under the OS temp
root and `LLV_VIEWER_CONTROL_URL` on a closed port.

1. **Projection** (`src/lib/attention/needsYouRead.test.ts`, new). One
   fixture representation holds every kind of §2 in two projects: a seat with
   two open report asks, a question, a plan, a structured and a scraped
   permission, an uncertain delivery, a failed `spawn:` launch, a memory kill,
   an «Asks you» mark, a `needs_decision` and a `needs_review` lane, a waiting
   prototype round, and an update decision. `needsYouEntries(...).map(id)`
   equals `needsYouSections(buildNeedsYouQueue(...), project)` for that
   project, in order; kinds map as §2; the other project's rows are absent.
   Red today: the module does not exist.
2. **Evidence** (same file): each code of §4 on a minimal fixture, its
   `stale` value, and an unreadable source listed in `unavailable` with no
   code; a row with only context codes is not stale.
3. **Row text** (`src/components/attention/needsYouPanel.test.ts`):
   `needsYouRowText` answers what `AttentionPanel.dom.test.tsx` already
   asserts for each kind, in `en` and `uk`.
4. **Route** (`src/app/api/attention/needs-you/route.test.ts`, new): a stubbed
   representation gives the rows of seam 1; a worker capability, another
   project's seat and an unidentified capability get 403 with nothing read; a
   maintainer of the project and the seat get rows.
5. **MCP** (`src/lib/mcp/dismissAttention.test.ts`): the read form answers the
   route's rows; each row's `target` clears exactly that row (two asks of one
   seat: clearing one leaves the other; the report log marks it resolved); a
   prototype round is cleared and comes back with `undo`; a task target
   clears the task's waiting round; a newer round after a cleared one shows
   again; `reason` round-trips into the read's `cleared` with `by`, and undo
   drops it; a failed launch row is cleared (red today: project resolution
   throws); an `update` row is refused with `UPDATE_NEEDS_ANSWER`; a worker,
   the maintainer and another project's seat are refused with nothing
   written; `reason` with a line break is refused.
6. **Policy** (`src/lib/mcp/toolAllowlist.test.ts`): `permitMaintainerTool`
   admits `dismiss_attention` with none of `target`, `undo`, `reason` and
   refuses it with any; the `permitNeedsYouRead` matrix of §6.
7. **Service** (`src/lib/attention/dismissals.test.ts`): prototype subject
   write, undo, `alreadyClear` for a round that is not waiting; `note` stored
   and redacted; a report subject outside the caller's project is refused.
8. **Lane note** (`src/lib/pipelines/engine.test.ts`): `dismissedNote` stamped
   with the dismissal and cleared by undismiss.
9. **Report note** (`src/lib/bridge/store.test.ts`): a resolved ask keeps its
   note through `normalizeResolvedAsks` and loses it on undo.
10. **Model** (`src/lib/prototypeReview/model.test.ts`,
    `src/components/kanban/kanbanModel.test.ts`,
    `src/components/mobile/phoneKanbanModel.test.ts`): a covered round raises
    no notice and no card needs-you; the review still reads as waiting.
11. **Projection key** (`src/app/api/files/route.test.ts`): a prototype
    dismissal changes the representation and the summary carries
    `waitingDismissal`.
12. **Report** (`src/lib/orchestrator/boardReport.test.ts`,
    `boardReportRun.test.ts`): section 9 lists stale rows first, caps at 10,
    is cut in the stated order under the 6 000-byte bound, prints `none` and
    `unavailable`; the gather calls the read and turns a failure into a gap.
13. **Mandate** (`src/lib/orchestrator/prompt.test.ts`): v42 fingerprint; the
    directive names `dismiss_attention` and keeps the pinned phrases; a stored
    mandate with v41's text gets the new text once and the old one is gone; a
    reworded section is kept; the envelope test passes with its bound
    unchanged.
14. **Schema** (`src/lib/mcp/schemaParity.test.ts`, `server.test.ts`): optional
    `target`, the new fields and target kinds, the description.

## 11. Checked against the requirement

- "каким-то инструментом проверить … что там есть": `dismiss_attention`
  without a target answers exactly the panel's rows for the project, from the
  panel's own function over the operator's own representation (§3), with the
  evidence the server holds (§4).
- "и почистить … убрать оттуда ненужное": every kind the panel shows can be
  cleared by the row's own target, the prototype round and the report question
  included; the update decision is the one exception, because it is never
  stale and ending it is the operator's deploy choice (§5.1).
- "когда чистится доска": the board maintenance report lists the panel with
  rows that ask nothing first (§7), and the mandate tells the seat to clear
  them one by one with the reason (§8).
- "Чтобы там оставалось только актуальное": rows that still ask stay; a
  dismissal covers what was read, and anything newer asks again (§5).
- Authority is the existing gate; the maintainer reads and cannot clear (§6).
  No component changes what it draws.

## 12. Deferred — not currently justified

- **A «Зняти» on prototype rows in the panel.** The operator asked for the
  seat's tool, and the pinned specification says no UI change. The row still
  opens the review.
- **Dismissing the update decision.** It ends by itself when the drain is
  admitted and asks only the operator's deploy choice.
- **The maintainer listing panel rows on its own.** It may read them; adding a
  step to its scaffold spends scaffold bytes for a list the seat's report
  already carries.
- **A count of panel rows in the seat tick's wake.** The wake belongs to lane
  58e782ee, and the seat can read the panel whenever it walks the board.
- **Rendering the reason** on the card or in the panel.
- **Forge reads at read time.** The read uses the cached work-link state and
  says when it was checked.
- **A `lane-merge` row.** The panel does not show it; it stays a card reason.

## Notes

- Risk: `operatorBoardRepresentation` must not run the task-board migration or
  `markBoardViewed`; both are writes or presence side effects of the browser's
  poll, and the read must leave state untouched.
- The phone sheet decorates a decision row with its role; the read uses the
  desktop words. Both are the same reason.
- If two raw project keys fold to one canonical project, the panel draws two
  sections and the read joins them (§3.2).
