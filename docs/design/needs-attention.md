# Needs attention: why a card needs you, and how it stops

## The requirement

Source: the pinned specification of this pipeline, 2026-09-24. The operator's
ask arrives here already paraphrased in English, and it is quoted as the
pipeline carries it:

> Operator ask (2026-09-24, paraphrased): (1) The "needs attention" / "needs
> you" state is too blunt. Research every reason something enters it today
> (conversations, tasks, pipelines, agent request_attention, failed
> assignments, due dates, pending questions, waiting input, parked or
> needs_decision lanes, and so on), and make it more deliberate: each reason is
> named on the card, and reasons that do not really need the operator stop
> raising it. (2) The operator can clear the state with one click on the card
> (desktop and phone), without having to send a prompt; the same dismissal is
> available to agents through a Viewer MCP tool (a new action or a field on an
> existing tool; one durable path, attributed to who dismissed it). A dismissed
> item comes back only when something new happens that needs the operator. (3)
> On the phone, an agent's request_attention must not take over the screen or
> move the operator's view; it shows as a quiet notice/badge the operator can
> tap to go there. Desktop behaviour stays as it is unless the design shows a
> problem.

Acceptance, from the same specification: this document; an implementation
with unit tests for the reason model and the dismissal (UI and MCP); a DOM test
that a `request_attention` on the phone layout leaves the current screen in
place; before/after phone renders at 390 px from a seeded home, saved under
`~/Pictures/delegatus-review/needs-attention/`; `tsc`, the touched tests by
path, and `bun run build` with an isolated config root.

Everything below was read on `main` at the merge of #2107.

## 1. How "needs you" is decided today

There are two independent authorities and several readers.

**Conversations.** `attentionId(file, now)` in `src/components/attention.ts:121`
is the one identity. It returns a signal-scoped id or null, and every
conversation surface reads it: the kanban member state through `mobileRowState`
(`src/components/mobile/mobileBoardModel.ts:158`), the desktop island and toast
through `buildAttentionQueue` (`src/components/Viewer.tsx:728`), push
(`src/lib/push.ts:192`), the project rail count (`src/components/projectModel.ts:208`),
the card status word (`src/components/cardStatus.ts:40`), the seat
(`src/components/orchestrator/seatState.ts:554`), the phone chat state
(`src/components/mobile/mobileChatState.ts:134,142`) and the Overview on the
phone (`src/components/mobile/overviewPhone.ts:97`). The words come from
`decisionText` (`src/components/attention/decision.ts:68`).

**Pipelines.** A lane in `needs_decision` or `needs_review` asks the operator.
That is `pipelineNeedsYou` (`src/components/pipelines/pipelineBlockModel.ts:26`).
The phone subtracts the lanes the operator hid (#1671) with
`pipelineHiddenFromBoard` (`src/components/mobile/mobileBoardModel.ts:339`), read
in `asks` (`src/components/mobile/phoneKanbanModel.ts:143`) and
`needsDecisionPipelineRows` (`mobileBoardModel.ts:313`).

**Cards.** A kanban card needs you when a member does or a lane does
(`src/components/kanban/kanbanModel.ts:438-440`). A member needs you when its
row state is `waiting`, `stalled` or `limit` (`kanbanModel.ts:196,278`).

## 2. Reason inventory

What the operator sees is described for the desktop kanban card (the only
desktop board since #1695) and the phone kanban card (#2072).

| # | Reason | Where it is decided | What the operator sees today |
|---|---|---|---|
| 1 | Orchestrator's open bridge ask (`bridge_report` class `blocked`/`question`, within its TTL) | `attention.ts:86` `openBridgeAsk`, first in `attention.ts:128` | Desktop: amber card edge and a bare "needs you" in the foot (`KanbanCard.tsx:272,278`). Phone: "Decision" badge (`mobileBoardModel.ts:108`). Island/toast: "Awaiting decision" (`decision.ts:74`). |
| 2 | Pending question (`AskUserQuestion`) | `attention.ts:130` | Desktop: bare "needs you". Phone: "Question" badge. Toast: the question's header (`decision.ts:80`). |
| 3 | Pending plan (`ExitPlanMode`) | `attention.ts:130` (`pendingQuestion.kind === "plan"`) | Desktop: bare "needs you". Phone: "Plan" badge. Toast: "Plan to approve" (`decision.ts:77`). |
| 4 | Rate-limit wall, scraped from a tmux pane | `attention.ts:131`, set only by `src/lib/scanner/waitingInput.ts:70` | Desktop: bare "needs you". Phone: "Limit" badge with the reset time (`mobileBoardModel.ts:145-155`). |
| 5 | Waiting input: a permission or choice prompt scraped from a tmux pane | `attention.ts:134`, set only by `src/lib/scanner/index.ts:336` and `observe.ts:98` | Desktop: bare "needs you". Phone: "Question" badge. Toast: "Permission prompt" (`decision.ts:83`). |
| 6 | Owed message delivery older than 5 minutes (`DELIVERY_WAIT_ATTENTION_MS`) | `attention.ts:60,138`; projected from the registry's held deliveries at `src/app/api/files/response.ts:398-409,555-557` | Desktop: bare "needs you". Phone: "Needs attention" badge. Toast: "Message not delivered" (`decision.ts:84`). |
| 7 | Stalled: turn open, no transcript write for 180 s, process running, under 2 h old | `attention.ts:68,140`; the 180 s rule is `src/lib/scanner/activity.ts:443-445` | Desktop: red card edge (`KanbanCard.tsx:271-272`) and bare "needs you". Phone: red "Stalled" badge (`mobileBoardModel.ts:143`). |
| 8 | Lane parked in `needs_decision` | `park()` at `src/lib/pipelines/engine.ts:1457`, 47 call sites (stage verdict `needs_decision`, fail-edge budget spent, spawn failures, rate-limit park, missing verdict, review flow paused, …) | Desktop: amber lane block with the state word and `stateDetail`; the foot's "needs you" is suppressed while a lane says it (`KanbanCard.tsx:270,278`). Phone: pipeline state chip (`MobileKanban.tsx:219-220`). |
| 9 | Lane parked in `needs_review`: the review budget is spent and the head is unreviewed (#1938) | `parkForReview` at `engine.ts:2217-2241` | Same as #8. |
| 10 | Lane `paused` | `PIPELINE_ATTENTION_STATES` at `src/components/pipelines/pipelineModel.ts:143`, read by `PipelineStrip.tsx:216,615` | Warning tone on the retired scheme board's pipeline strip only (`PipelineStrip` is mounted only by `src/components/scheme/nodes.tsx`). `pipelineNeedsAttention` (`pipelineModel.ts:171`) has no production caller. |
| 11 | Task with a failed assignment | `src/components/scheme/taskStacks.ts:53` | Nothing on the kanban. It only keeps the task full-size on the scheme canvas (`ProjectDashboard.tsx:1013`). |
| 12 | Open task past its due date | `taskStacks.ts:54-57` | Same as #11. |
| 13 | Engine-native child with a reason, a failed spawn or a killed host | `src/components/scheme/subagentTray.ts:244` | Promotes the child to a full node beside its parent on the scheme canvas. It is a placement rule, and no count reads it. |
| 14 | Structured-host approval, permission or question on the runtime bus | `src/components/runtime/runtimeModel.ts:860-869` | Shown inside the conversation (`ConversationAttention.tsx:124`) and on the scheme node's state (`nodes.tsx:1801`). It never reaches `attentionId`, so no card, count or badge sees it. |
| 15 | An agent's `request_attention` | `src/lib/mcp/bindings.ts:4546-4640` | Desktop: the view moves to the target and a Back chip names the reason (`AttentionHost.tsx:494-510`). Phone: nothing at all (section 6). |

The feed's own question card ("Needs you · 4m", `src/components/feed/QuestionCard.tsx:510,611`)
is the question itself, inside the conversation. It is out of this inventory:
a dismissal does not answer a question, so the card stays until the question is
answered.

### Defects found on the way

- **The desktop ignores the phone's Hide.** `kanbanModel.ts:438` and
  `KanbanCard.tsx:270` read the lane state alone, while the phone
  (`phoneKanbanModel.ts:143`), the ⚠ sheet (`mobileBoardModel.ts:326`) and the
  group hide (`src/lib/tasks/groupHide.ts:166-167`) honour `dismissedAt`. A lane
  hidden on the phone still marks its desktop card and counts in the desktop
  header.
- **Stalled outranks a question.** `mobileRowState` checks `stalledAttention`
  before `attentionId` (`mobileBoardModel.ts:142-159`). An unregistered session
  that has been quiet for 180 s with an `AskUserQuestion` open is shown as
  "Stalled" rather than "Question". Once stalled stops raising the state
  (below), that order would hide real questions, so the order changes with it.
- **The desktop card never names its reason.** The foot says "needs you"
  (`kanban.activityNeeds`, `KanbanCard.tsx:278`) whatever the reason, and a
  member tile carries only the `needs` class (`KanbanCard.tsx:132-137`).

## 3. Which reasons stay, change or go

| # | Reason | Verdict | Why |
|---|---|---|---|
| 1 | Bridge ask | **Stays.** Named "Decision · ‹role›". | The orchestrator said in as many words that it cannot continue without the operator. |
| 2 | Pending question | **Stays.** Named by its header, else "Question". | The agent is blocked on an answer. |
| 3 | Pending plan | **Stays.** "Plan to approve". | Same. |
| 4 | Rate-limit wall | **Goes** from needs-you. The row keeps its "Limit · resets 16:40" state and amber dot, without the edge or the count. | Nothing waits on the operator: the wall lifts on its clock, and quota reseat already moves conversations. It is also pane-scraped, so under the no-tmux policy (#1161) structured conversations never raise it. A lane parked on a limit (#8) stays, because the engine does not resume it by itself. |
| 5 | Waiting input | **Stays.** "Permission prompt". | A keypress is owed. This only happens in legacy pane sessions. |
| 6 | Owed delivery | **Changes.** It raises the state only at `DELIVERY_UNCERTAIN_MS` (30 min) or when the record is `delivery-uncertain`. Named "Message not delivered". | Under 30 minutes it is ordinary long-turn latency: #1213's longest successful wait was 21 minutes, and it arrived (`src/components/runtime/deliveryWait.ts:62-81`). The composer offers Retry and Discard only at 30 minutes, so that is when there is something to do. |
| 7 | Stalled | **Goes** from needs-you. The row keeps its "Stalled" word and red dot, without the edge or the count. | The 180 s rule fires on any long tool call, such as a build or a test suite. Delegatus-hosted conversations replace it with turn liveness (`src/lib/runtime/livenessProjection.ts:83-85`), and a severed host reads `proc: killed`, so `stalledAttention` never fires for them. What is left is unregistered terminal sessions, where three quiet minutes is not a request. |
| 8 | Lane `needs_decision` | **Stays.** "Decision · ‹stage›", with the existing `stateDetail` line under it. | `park()` runs only where the engine will not continue by itself. |
| 9 | Lane `needs_review` | **Stays.** "Review budget spent · ‹stage›". | The head is unreviewed, and only a person or the orchestrator can add rounds. |
| 10 | Lane `paused` | **Goes.** Remove `paused` from `PIPELINE_ATTENTION_STATES` and delete the dead `pipelineNeedsAttention`. | Someone paused it on purpose, and nothing is asked. |
| 11, 12 | Failed assignment, overdue | **Unchanged.** They are scheme placement rules, never a needs-you reason. | Neither raises the state today. Adding a "Launch failed" reason is new scope (see Deferred). |
| 13 | Engine child promotion | **Unchanged.** Its `attentionId` half follows the new model by itself. | It is a placement rule. |
| 14 | Structured-host approvals | **Changed by #2215** for Claude tool permission requests; other approvals unchanged. | Claude's safety check asks even under bypass, and an unanswered request held two stages for an hour each. See "Structured permission requests" below. |
| 15 | `request_attention` | Section 6. | |

## 4. The reason model

There is still one authority per subject, and it now says why.

- `src/components/attention.ts` gains
  `attentionReason(file, now): ConversationReason | null`. It returns
  `{ kind: "decision" | "question" | "plan" | "permission" | "delivery", since,
  id, header?, dismissal }`, in the order `attentionId` uses today, minus the
  rate limit and the stalled tier, and with the delivery bound at 30 minutes.
  `attentionId` becomes `attentionReason(...)?.id` for an undismissed reason, or
  null. The id strings stay byte-identical, so the push dedupe
  (`push-sent.json`) and the cycle pointer survive. `buildAttentionQueue` keeps
  one tier (`blocked`), because the `stalled` tier no longer exists, and the
  `attentionExpiries` entries for stalled go with it.
- `decisionText` (`decision.ts:68`) reads the reason's kind and loses its
  rate-limit and stalled branches.
- `mobileRowState` checks `attentionReason` right after `killed`, then
  `stalled`, `limit`, `held`, working and so on. `NEEDS` (`mobileBoardModel.ts:80`)
  and `NEEDS_STATES` (`kanbanModel.ts:196`) become `{"waiting"}`. `stalled` and
  `limit` rows move to the `working` section, next to `held`, because their
  turn is still open or held. `mobileChatState.ts:134` reads `stalledAttention`
  directly, so the chat header still says "Stalled".
- One shared lane predicate, `pipelineAsks(pipeline)`, is
  `pipelineNeedsYou(pipeline) && !pipelineHiddenFromBoard(pipeline)`. It lives
  beside `pipelineHiddenFromBoard`, and `kanbanModel.ts:438`,
  `KanbanCard.tsx:270` and `phoneKanbanModel.ts:143` all read it. That closes
  the desktop/phone split.
- `KanbanCard` gains `reasons: NeedReason[]`, ordered by `since`. The list
  holds every member's `ConversationReason` and every asking lane as
  `{ kind: "lane-decision" | "lane-review", pipelineId, stageId, since:
  laneMovedAt }`. `needsYou` becomes `reasons.length > 0`. It also gains
  `cleared: Cleared[]`: reasons that are still live and are dismissed, with who
  dismissed them and when. The phone's `PhoneNeed` (`phoneKanbanModel.ts:43`)
  becomes `card.reasons[0]` read through the attention rank. It no longer
  re-derives anything.
- One label function, `needLabel(t, need)` (`src/components/attention/decision.ts`),
  is shared by the desktop foot, a member tile's title and the phone's lane
  chip. A conversation's reason carries its role when the evidence names one,
  and a lane's carries the stage it stopped on. It reuses the badge words
  where they exist (`mobile2.board.badgeDecision`, `badgePlan`, `badgeQuestion`,
  `attention.decisionPermission`) and adds en and uk keys under `needs.*` for
  the owed message, the two lane reasons and "Cleared · ‹who› · ‹age›". The
  island rows and the toast keep `decisionLine`, which now reads the reason's
  kind.

**On the card.** Desktop: the foot's bare "needs you" becomes the first
reason's label, with "+N" when there are more, and a Dismiss control (✓, 28 px,
labelled "Dismiss: stop flagging this card until something new"). A member
tile's `needs` class stays, and the tile's title attribute names its reason.
Phone: the badge already names conversation reasons (a permission prompt now
reads "permission prompt" rather than "a question"), so a lane's chip becomes
"needs a decision · ‹stage›", and the card gets a 44 × 44 Dismiss at the end
of its badge line. The card's own button and the Dismiss sit side by side in
one frame, so neither covers the other (#699). Both surfaces show a cleared
card with a muted "Cleared · ‹who› · 2m" line and an Undo beside it. It stays
for as long as the dismissed reason is live. That line is how the operator
sees that an agent cleared something. A loose phone row that is stalled or at
its limit keeps its phrase ("stalled · 37m", "main resets 16:40") in its tone,
without the edge or the badge.

## 5. Dismissal

### What a dismissal is

A dismissal says: *the operator has seen the reasons this subject carries up to
this instant; stop flagging them.* It changes nothing else. No question is
answered, no lane moves, no message is dropped, and the card keeps its column.

### Storage

Each subject kind keeps the record it already has, and one module owns both,
`src/lib/attention/dismissals.ts`:

- **Conversation.** A new document collection, `attention-dismissals`, in
  `state.sqlite`, built exactly like the reply-suggestions store
  (`src/lib/suggestions/store.ts`, a `LegacyDocumentStore`). Its legacy file is
  `attention-dismissals.json`, used only as the rollback mirror. It is
  registered in `src/lib/state/legacyCollections.ts` beside the suggestions
  entry. It holds **one record per durable conversation id** (or per
  transcript path, for a terminal session the registry never adopted), and a
  new dismissal replaces the old one:

  ```ts
  interface AttentionDismissalV1 {
    conversationId: string;
    at: string;              // server clock, ISO
    by: DismissedBy;
    reason: ConversationReason["kind"];  // what was on screen, for the record
    reasonId: string | null; // that reason's attentionId: the one reason the record covers; null for an agent's call
    operationKey?: string;   // MCP idempotency
  }
  type DismissedBy =
    | { kind: "operator"; surface?: "desktop" | "phone" }
    | { kind: "manager" | "agent" | "gateway"; conversationId: string | null; role: string | null };
  ```

  `DismissedBy` for an agent is the server-derived `AttentionRaisedBy`
  (`src/lib/attention/types.ts`, "AttentionRaisedBy"), so the caller cannot
  assert it. Records older than 30 days are pruned on write, and the collection
  is capped at 2 000 conversations, oldest dismissal first. A record whose
  conversation the registry forgot is left to those two bounds: it can only
  cover reasons that started before it, so it costs nothing while it waits.
- **Pipeline.** The existing `pipeline.dismissedAt` (#1671,
  `src/lib/pipelines/types.ts:751`) stays the storage, because the phone queue,
  the group hide and the seat monitor (`src/lib/monitor/seatTickSources.ts:586,635,742`)
  already read it with the right meaning. It gains `dismissedBy?: DismissedBy`.
  The engine's `dismiss` now stamps `now` every time instead of keeping the
  first instant (`engine.ts:7569`, `pipeline.dismissedAt ?? ports.now()`). That
  makes the undismiss-then-dismiss sequence in
  `MobileRowActions.tsx:46-53` unnecessary, so it goes.
- **Task card.** No record. Dismissing a card dismisses every subject on it,
  and those dismissals live as described above.

### Reaching the board

`/api/files` projects the conversation's record onto its latest generation,
`file.attentionDismissal = { at, by }`, next to `stuckDelivery` at
`response.ts:555-557`. `hotStateSignature("attention-dismissals", …)` joins the
projection key at `src/app/api/files/route.ts:183-192`, so a dismissal
invalidates the cached payload the way a task or pipeline write does. The
pipeline payload already carries `dismissedAt`.

On the click's side, `src/components/attention/dismissalOverlay.ts` layers a
dismissal over the polled rows at the one place the Viewer reads them, so the
card, the phone's ⚠ count and the queue stop flagging it in the same frame. It
covers what the card drew and nothing newer, even when the device's clock runs
behind the server's: a conversation's mark names the reason it drew, and a lane
that moved since the card drew it is not drawn over. The server's own instant
replaces it when the request answers, and the layer retires once the poll
carries it, or after 30 seconds. A refusal takes the layer off and says why.

### What brings an item back

This is the same rule as the phone's Hide and the group hide, "hidden until
something newer", and it is kept in one place:

- **Conversation.** A dismissal hides what its maker saw, and nothing newer.
  - A card's dismissal names the reason it drew (`reasonId`, its attention id)
    and covers that id alone. The card may be stale: a phone that has just
    woken can still show question Q1 after Q1 was answered and Q2 asked, and a
    tap then must not clear Q2. It is equally why a dismissal of one reason
    never covers an owed message that turns `delivery-uncertain` later, whose
    start time is its admission and would otherwise read as older than the
    dismissal. The ids are unique per signal (`toolUseId`, the ask's id, the
    prompt's and the message's start instants), so the same one never comes
    back and a new one always does.
  - An agent's dismissal names no reason: it is compared by time. It covers a
    reason whose start is at or before `at`. Every kept reason carries its own
    start time: `bridgeAsk.at`, `pendingQuestion.askedAt`, `waitingInput.since`,
    and `stuckDelivery.since` bounded at 30 minutes, whose instant is
    `since + 30 min`. A reason whose time does not parse is never covered by
    time, so an unreadable clock never hides a new signal. One limit remains
    on this path: `stuckDelivery` does not say when a message turned
    `delivery-uncertain`, so an uncertain message counts from its admission,
    and an agent's dismissal made after the admission but before the message
    turned uncertain covers it. Closing that needs the delivery record to carry
    the instant it turned uncertain. The operator's cards are not affected,
    because they name the reason.
  - A conversation holds one record, so a newer dismissal replaces an older
    one. If an older reason resurfaces from under a newer one that was also
    cleared (an owed message cleared, then a question cleared and answered), it
    flags again. That errs toward showing the operator something twice.
- **Pipeline.** `pipelineHiddenFromBoard` stays as it is: the lane comes back
  once `laneMovedAt(pipeline)` (`src/lib/pipelines/laneMovement.ts`) passes
  `dismissedAt`, meaning a round started, ended, or a verdict was re-read. The
  engine stamps `dismissedAt` with its own clock, so a card's dismissal also
  says which movement it drew: the card and the phone swipe send
  `laneMovedAt` with the lane. A lane that moved after that (it parked again
  between the last poll and the tap) is not stamped. The service answers it as
  `changed`, and the engine checks the same thing again under its own lock.
  The surface then puts the lane back at once and says it changed. An agent
  sends no movement and clears the lane as it stands.
- **Undo** deletes the conversation record, or runs the pipeline's
  `undismiss`. A dismissal that already came back needs no undo.

### One path for the click and the agent

- **Service.** `dismissAttention(target, by, { undo?, operationKey? })` in
  `dismissals.ts`. Its target is `{ kind: "conversation", conversationId | path }`,
  `{ kind: "pipeline", pipelineId }` or `{ kind: "task", taskId, subjects? }`.
  A task expands to `subjects` when the caller names them. The card sends
  exactly the members and lanes it drew as needing the operator, which is "what
  the operator saw", the rule the group hide uses. Otherwise it expands to the
  task's live assignments plus the pipelines whose `taskIds` include it. A card
  no task owns sends `{ kind: "subjects", subjects }`, which only the
  operator's route accepts. The answer is `{ dismissed: Subject[],
  alreadyClear: Subject[], changed: Subject[], at, by }`. A subject with
  nothing to dismiss (a lane that asks nothing or is already cleared, an undo
  of nothing) goes in `alreadyClear`, a lane that moved since the card drew it
  goes in `changed`, and neither is an error. A conversation is always
  recorded: the record names the reason the card drew, or says what was seen
  up to now, and cannot hide anything that starts later.
- **Route.** `POST /api/attention/dismissals`, with body
  `{ target, undo? }`, is the operator's (`by: { kind: "operator", surface }`).
  Both cards call it, and so does the phone's swipe action (now "Dismiss" on
  both conversation and lane rows, replacing the lane-only "Hide").
- **MCP.** One new tool, `dismiss_attention`, over the same service:

  ```ts
  dismiss_attention: z.object({
    clientRequestId,
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("conversation"), conversationId: z.string().optional(), path: z.string().optional() }),
      z.object({ kind: z.literal("pipeline"), pipelineId: z.string() }),
      z.object({ kind: z.literal("task"), taskId: z.string() }),
    ]),
    undo: z.boolean().optional(),
  })
  ```

  Authority is the gate `request_attention` and `suggest_replies` already use
  (`src/lib/attention/callerAuthority.ts:68`, then the project half of
  `permitAttentionHandoff`): the operator's own root or gateway session, or the
  target project's designated orchestrator seat. A worker is refused with
  `DISMISS_NOT_PERMITTED` and nothing is recorded, so a stage agent cannot
  clear its own question off the operator's board. The call is idempotent by
  `clientRequestId`: the record carries the operation key, and a replay answers
  the first result. `pipeline_action`'s existing `dismiss`/`undismiss` calls the
  same service behind the same gate, so its write is attributed too and a
  worker can no longer clear a lane off the board through it. It stays as an
  alias because callers already use it. The pipeline route's `dismiss` and
  `undismiss` (the phone's pipeline screen) go through the same engine stamp
  and are attributed to the operator.

  I chose a new tool over a field on an existing one because each existing
  tool is scoped to one subject kind (`conversation_action`, `pipeline_action`,
  `update_task`). Spreading one operation over three of them would give three
  argument shapes for one write.

## 6. `request_attention` on the phone

**What main does.** The phone is already never moved. The server never directs
a handoff at a phone or a phone-sized window (`src/lib/attention/eligibility.ts:77-82`,
applied in `src/lib/attention/service.ts:219-229`). The phone's host withholds
its device id (`AttentionHost.tsx:153`) and polls rows only
(`src/components/overlay/useAttentionOffers.ts:336-348`). The DOM test
"mobile never moves its board" (`AttentionHost.dom.test.tsx:490`) holds it.

The phone also shows nothing, and that is the defect. With only the phone open,
the tool fails with `NO_ACTIVE_VIEW` (`bindings.ts:4559-4565`). With a desktop
tab left visible elsewhere, which counts as `active` for as long as it
heartbeats (`src/lib/view/presenceStore.ts:33,227`), that desktop moves and the
operator on the phone learns nothing.

**The design.** Desktop is unchanged: it still moves immediately and still
shows the Back chip. The phone gets a notice and never a move:

- **Server.** `eligibility.ts` adds
  `noticeCapablePresence(facts)`: visible, active, and in the phone layout
  (`device.kind === "mobile"` or `mobileLayoutViewport`). In
  `requestAttention`, when `resolveDirectedAttentionView()` is null and a
  notice-capable session exists, the request is recorded with
  `delivery: "notice"` and no `directedAt`. The call returns at once,
  `{ attentionId, delivered: "notice", handoff: null }`, without the arrival
  wait (which could only time out). With neither kind of view, the answer is
  still `NO_ACTIVE_VIEW`. The tool description gains one sentence: "On a phone
  the request shows as a notice; the phone's view never moves." The record's
  TTL (`OFFER_TTL_MS`, 10 min) ends a notice like any unanswered request.
- **Read.** The rows-only read the phone already makes every 4 s
  (`/api/attention?records=only`) also answers `notices`. These are the
  root-agent requests of the last `OFFER_TTL_MS` that are not `declined` or
  `superseded`, each as `{ id, reason, target, raisedBy.role, createdAt }`.
  That includes ones a desktop followed, because presence cannot tell which
  screen the operator is looking at. No new poll is added.
- **Phone UI.** There is no banner and nothing in flow. The bar's ⚠ badge gets
  a small accent dot while an unseen notice exists, and the badge shows the dot
  alone when nothing needs the operator. Its count stays the needs count. The ⚠
  sheet (`MobileAttentionSheet`) lists notices in a "From your agents" section
  above the queue: the reason, the target's title, the age and who asked. A tap
  goes there through the handlers the sheet's rows already use
  (`Viewer.tsx:1190-1203`: `openOverOverview`, `jumpToItem`,
  `mobileNav.push({ kind: "pipeline" })`, plus the task screen). × clears a
  notice on this phone. That is local storage keyed by request id, which is
  enough for a record that ends in 10 minutes. Opening the sheet marks the
  notices it shows as seen, and the dot goes out.

The phone never posts to the request, so a desktop can still follow it.

## 7. The slice

1. Reason model: `attentionReason`, `pipelineAsks`, `mobileRowState` order,
   `NEEDS`/`NEEDS_STATES`, `decisionText`, `paused` out of
   `PIPELINE_ATTENTION_STATES`, `pipelineNeedsAttention` deleted, delivery at
   30 minutes.
2. Card reasons: `KanbanCard.reasons` and `cleared`, `needLabel`, the desktop
   foot, the phone badge and chip, and the en and uk keys.
3. Dismissal: the store, `/api/files` projection and key, the service, the
   route, the MCP tool with authority and idempotency, `dismissedBy` and the
   stamp change in the engine, the Dismiss controls, Undo, and the phone swipe
   action.
4. Phone notice: `noticeCapablePresence`, the notice record and answer, the
   `notices` read, the badge dot and the sheet section.

**Tests, by path:**

- `src/components/attention.test.ts`: every reason's kind and id. A rate limit
  and a stalled session raise nothing. A delivery raises at 30 minutes and not
  at 29. A question beats stalled. A dismissal that names a reason hides that
  reason alone: a question asked after a stale card was drawn, and an owed
  message that turned uncertain after a dismissal of another reason, both
  still flag. One that names none hides a reason whose start is at or before
  `at`, and a newer question comes back.
- `src/components/mobile/mobileBoardModel.test.ts`,
  `src/components/kanban/kanbanModel.test.ts`,
  `src/components/mobile/phoneKanbanModel.test.ts`: a lane hidden on the phone
  no longer marks the desktop card. `reasons` and `cleared` are populated.
  Stalled and limit rows are in `working`.
- `src/lib/attention/dismissals.test.ts`: replace, prune, undo, attribution,
  the pipeline stamp, a lane that moved after the card drew it answered
  `changed` and not stamped (also when it moves under the engine's lock), the
  task expansion with and without `subjects`, target validation, and the
  `/api/files` projection of the record.
- `src/lib/pipelines/engine.test.ts`: a second `dismiss` stamps its own
  instant and records who made it, and a stamp that names a movement older
  than the lane's last one writes nothing.
- `src/lib/mcp/dismissAttention.test.ts`, beside the `request_attention`
  cases: a worker is refused with nothing written, the seat and root are
  admitted, a seat of another project is refused, a replay by
  `clientRequestId` gives one record, `alreadyClear` is returned rather than
  an error, and `pipeline_action` dismiss is the same write behind the same
  gate.
- `src/components/kanban/KanbanDismiss.dom.test.tsx`: the foot names the
  reasons, one click on Dismiss posts the card's drawn subjects, the card
  shows "Cleared · …" with Undo at once, Undo flags it again, a newer question
  comes back, and a refused dismissal puts the flag back.
- `src/components/attention/dismissalOverlay.test.ts`: the click's layer, its
  clock-skew guard, the server's instant, undo and its bound, a lane that
  parked again after it was drawn, and a `changed` answer taking the layer off.
- `src/components/attention/AttentionHost.phoneNotice.dom.test.tsx`: a notice
  on the phone layout, delivered while a conversation screen is open, leaves
  the nav stack's top screen and the scroll position unchanged, adds no
  `[data-mobile2-banner]`, lights the badge dot, the sheet lists it and puts
  the dot out, a tap opens the target, and × clears it on this phone.
- `src/lib/attention/service.test.ts`, `eligibility.test.ts` and
  `src/lib/mcp/requestAttention*.test.ts`: only a phone gives a notice record
  and no wait. No view at all, or a hidden phone, is still `NO_ACTIVE_VIEW`.

**Renders.** A new case in the existing phone driver,
`src/components/mobile/issue1671Evidence.browser.test.tsx` (gated by
`LLV_SWIPE_BROWSER_TEST=1`), over the fixture's `?needs=1` scene at 390 × 844
from a seeded home. It renders a card for each reason, a cleared card, the
loose stalled and walled rows, a Dismiss, the ⚠ sheet with a notice, and a
chat screen with a notice arriving. `LLV_NEEDS_PHASE=before` renders the same
scene on a checkout without the change and gates nothing, so the two phases
are one scene's before and after. PNGs go to
`~/Pictures/delegatus-review/needs-attention/`, and the after readings to
`evidence/needs-attention/phone.json`. No new driver is written.

**Gates.** `tsc`, the files above one path at a time under an isolated
`LLV_STATE_DIR`/`XDG_CONFIG_HOME`, `bun run build` with an isolated config root,
and the privacy gate from the merge base.

## 8. Checked against the requirement

- (1) Every reason is listed with its source (section 2). Each kept reason is
  named on both cards (section 4). The ones that do not wait on the operator
  (rate limit, stalled, a short delivery wait, paused) stop raising the state
  (section 3).
- (2) Dismissal is one click on either card and one MCP tool. Both go through
  one service that writes one durable record per subject, attributed on the
  server. An item comes back only when a reason newer than the dismissal
  appears (section 5).
- (3) The phone is still never moved. A `request_attention` now reaches it as
  a badge dot and a sheet row the operator can tap, and desktop behaviour is
  unchanged (section 6).

## Structured permission requests (#2215)

Claude Code sends a `can_use_tool` control request over the stdio prompt
channel even under `--permission-mode bypassPermissions` when its safety check
flags a command (`decision_reason_type: "safetyCheck"`,
`classifier_approvable: false`). The structured host lists each pending one in
its state (`pendingPermissions`: tool, command excerpt, `decision_reason`), and
the registry keeps it on the conversation's host row. Every request is answered
by someone:

- **Unattended** conversations — a pipeline stage, or any delegated spawn
  (recorded delegation depth above zero) that is not an orchestrator seat —
  have no operator composer. The delivery controller's permission guard
  (`src/lib/runtime/permissionGuard.ts`) denies the request at once. The deny
  message is the engine's `decision_reason` verbatim followed by "No one can
  approve this here; rewrite the command so it does not need permission.", and
  the turn continues. The denial is recorded on the stage attempt
  (`permissionDenials`) and in the lifecycle journal (`permission_denied`).
- **Attended** conversations — the operator's own sessions and orchestrator
  seats — raise a `permission` reason in `attentionReason`, named by tool,
  command and reason, with Allow once and Deny on the Needs-you row and in the
  conversation's card. A request nobody answers in ten minutes is denied the
  same way as an unattended one, with `mode: "timeout"`. The headline runs to
  hundreds of characters, so on the phone sheet it takes a line of its own that
  ends in an ellipsis and the meta line under it keeps the age and the model;
  the desktop popover row already truncates its decision line. The rendered
  readings (390 and 430 px phone, 1280 px desktop, light and dark) are in
  `evidence/needs-attention/permission-row.json`, from the "permission row"
  case of the phone driver.
- **Answering from outside the browser**: `conversation_action` has a
  `permission` action with `decision: "allow" | "deny"` and an optional
  `requestId` (the oldest pending request by default). `dialog-key` stays the
  terminal-dialog control and keeps refusing structured hosts, which have no
  terminal to press a key in.
- **Activity**: `agent_activity` reports such a turn as `waiting` with reason
  `permission_request` and the request itself, and the seat wake lists it as a
  `permission` item. `provider_throttled` is reported only when the host itself
  saw the CLI retry a provider error (`system`/`api_retry`); the account's
  usage-endpoint 429 no longer labels anyone's turn.

AskUserQuestion and ExitPlanMode also arrive as `can_use_tool`. They are
questions, so the transcript's pending question surfaces them and they have no
timeout; an unattended conversation still gets an immediate deny, because
nobody could answer it there.

## Asks you: an agent that asks in prose

Most agents that need the operator say so in words ("say go and I'll merge")
and raise no structured signal. `docs/research/attention-classifier.md`
measured that case and chose a narrow slice, built here:

- **Opt-in, per installation.** "Asks you" in the board's ⋯ menu and the
  phone's ⋯ sheet, off by default (`state/asks-you-settings.json`, written only
  by the operator through `PUT /api/asks-you`). Its hint says that, while it is
  on, the last message of each agent's turn goes to Jev on OpenRouter, and it
  shows this month's spend against the cap (USD 1 by default). Without an
  OpenRouter key (`OPENROUTER_API_KEY`, or the `openrouter-api-key` file in the
  config directory) it cannot be turned on and names where the key goes.
- **What is sent.** The Viewer's classifier clock (`src/lib/asks/controller.ts`)
  reads the last scan every 15 s. For each conversation Delegatus knows whose
  turn has ended, except engine subagents, pipeline stages and review flows, it
  takes the last text of the turn (never a tool call) and sends it once
  (deduplicated by message id) with the evaluation's redaction and clipping.
  Stage endings, bodies under 30 characters, engine errors, repeated bodies,
  messages older than 30 minutes and messages from before the switch turned
  on are never sent. The call is the research's "Jev V2" at a 0.85 threshold
  with a 2 s timeout and no retry. A failure, a timeout, a missing key or a
  spent cap leaves the message unclassified and changes nothing else.
- **The reason.** A message at or over the threshold is stored in
  `state/operator-asks.json`, and `/api/files` stamps it on the conversation as
  `operatorAsk`. `attentionReason` returns it as the `ask` kind, below every
  structured reason: «asks you · ‹role›» on the card, the agent's sentence on
  the phone card and in the toast. It clears when a newer turn starts (the
  operator or anyone wrote to the agent), when the agent writes again or is
  working, on Dismiss, and for every card at once when the switch goes off.
- **The report log.** Each ask is one Viewer-authored line in its project's
  report log, placed by time among the orchestrator's reports: «‹agent› asks
  you: ‹the sentence›», the agent's name linking to `#c=<conversation>`. It is
  no bridge report: nothing relays, speaks or posts it, and the orchestrator's
  Bridge reports switch does not hide it.

The rendered readings (the card, the log line and the switch at 1440 and 390,
en and uk) are in `evidence/asks-you/`, from the "asks you" case of the kanban
driver and the "Asks you" case of the phone driver.

## Deferred: not currently justified

- **Other structured-host approvals (#14) as a reason.** Codex and Copilot
  approvals on the runtime bus would become a `permission` reason the same way.
  They are rare under the bypass-approvals policy, and the conversation already
  shows them.
- **Structured park causes.** A `parkCause` enum stored by `park()` across its
  47 call sites, so a lane reason can say "fail-edge budget spent" or "rate
  limited until 16:40" without reading prose. For now the `stateDetail` line
  under the reason covers it.
- **Delivery reason only for the operator's own messages.** An agent's
  `send_message` to a busy worker can still raise the operator's state at 30
  minutes. The held-delivery record would need to carry its sender.
- **The phone's queue arrival banner reflows the screen.**
  `ArrivalBanner` (`src/components/attention/AttentionToast.tsx:83-142`) sits
  in flow under the bar (`MobileShell.tsx:133-136`). When a conversation starts
  waiting, it pushes the open screen down by at least 44 px, then pulls it back
  up when it collapses 6 s later. It is triggered by a conversation's own wait,
  never by `request_attention`, so it is outside (3) as written. If the jump the
  operator saw was this one, the fix is to give it the notice treatment from
  section 6.
- **Dismiss from the desktop island's popover rows.** The card is where the
  requirement puts the click.
- **"Launch failed" (#11) as a named reason** on the kanban card.
