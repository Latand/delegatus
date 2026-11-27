# Legatus: build plan after prototype round 2

Status: build plan, epic #4485. Code read at main `54802a6f` (2026-11-26).
Line references are to that commit unless another commit is named. The
accepted prototype is `docs/design/legatus/prototype/` at `c0f7da57` and
`docs/design/legatus/needs-you-restructure.md` at `564ab2b0`. Both sit on the
prototype lane's branch, which main does not contain yet; read them with
`git show c0f7da57:<path>`.
The in-chat research is `docs/investigations/in-chat-ui.md` at `54ad5dae` on the
research lane's branch.

## Originating requirement

The operator, 2026-11-25 (epic #4485): the design is roughly right, so begin
with a prototype, run the work as lanes, and open the issue and its
sub-issues. The design (private, kept outside the repository) defines
Legatus: one agent above every project orchestrator on every linked machine.
The orchestrators act as project managers. Legatus does the operator's own
work: it decides what the seats would bring to the operator, debugs Delegatus,
and keeps the machines loaded near 75–80 %.

Three principles from the operator bind every slice: Legatus has no direct
prohibitions, and a trust model built on shadow answers stands in for them;
operator and Legatus decisions never mix, and every record names its author;
text the operator typed by hand weighs most.

Operator answers that settle the shape (paraphrased, never reopened here):

| Date | Source | Decision |
|---|---|---|
| 2026-11-25 | operator, on the prototype's phone sheet | No decision-memory surface. Remembered decisions go into the existing role memory. #4487 and design §2.6–§2.8 move onto it, with no new decision store and no new UI. |
| 2026-11-26 | prototype round 1 (`pr_9ba6aecd`) | Orchestrators as a card grid. The phone's Legatus row shows a state dot and one question counter. «It's mine» and «Change» are 44 px text buttons. Legatus decides without proof: it takes the recommended option and weighs it itself. The operator sees a plain list of Legatus's decisions, with at most one line of reasoning from memory, collapsed by default. «Needs you» holds only the forms where the operator is really needed. |
| 2026-11-26 | operator, via the operator terminal | Every form shows an answer timer with its own deadline; after it Legatus decides by itself; the timer is good-looking, noticeable and animated. |
| 2026-11-26 | prototype round 2 (`pr_1fddb110`) | «Needs you» always opens the Legatus column: one list, no separate panel (variant 2). The ring's colour follows the minutes left only: accent, warning from 15 min, danger in the last 5, a pulse in the last minutes. «+30 min» is one tap; «Cancel» leaves «Restore the timer». At the deadline Legatus takes the recommended option; a draft counts only after «Answer». «Answered for you» carries no counter. |
| 2026-11-26 | operator, on the prototype review | Consider OpenAI-style interactive UI in chat. The investigation recommends a one-form pilot; this plan carries it as slice 7. |

The design's own open choices (R1–R13) were accepted with the design; this
plan takes each recommended option where a slice needs it and names it there.

**Earlier answers.** `search_transcripts` (project-scoped, then unscoped,
several phrasings) and `search_memory` found the prototype, critic and
publish lanes and no earlier build plan. The issue bodies #4485–#4494 are the
pre-prototype cut; this plan re-cuts them.

## How to read a slice

- **Engine.** UI on Claude Opus. Backend on Codex with the current registry
  model on a subscription account. Secret-adjacent or refusal-prone parts
  (remote access wrappers, provider spend) on Claude Opus.
- **Size.** S: under about 400 changed lines, one subsystem. M: 400–1200
  lines or two subsystems. L: larger, or a hot path or shared contract.
- **Checks.** Each lane runs the test files it touches, by path, with
  isolated `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` (AGENTS.md).
  No full suite, `tsc` or build unless its brief names one.
- **Rendered evidence.** Only through the existing drivers: the kanban board
  driver (`src/components/kanban/kanbanBoard.browser.test.tsx`, one
  `describe` over `issue1695Evidence.fixture.tsx`, `LLV_KANBAN_BROWSER_TEST=1`),
  the phone driver (`src/components/mobile/issue1671Evidence.browser.test.tsx`,
  `LLV_SWIPE_BROWSER_TEST=1`) and the conversation window driver
  (`src/components/conversation/conversationWindow.browser.test.tsx`,
  `LLV_CONVERSATION_BROWSER_TEST=1`). No new driver file and no file named
  after an issue. The prototype's own `LLV_LEGATUS_PROTOTYPE` cases stay on
  its branch; the build draws the product components and compares against the
  prototype frames in the evidence folder.
- **Widths.** #4486 names 390, 768 and 1440. Every state of a UI slice renders
  at 1440, 1000, 768, 560 and 390, in uk and en, light and dark, with real
  values in every field.

## Order and parallelism

| # | Slice | Issue | Engine | Size | Depends on | Runs in parallel with |
|---|---|---|---|---|---|---|
| 1 | «Needs you» counts only waiting forms | new, under #4485 | Claude | M | — | 2, 3, 13, 14a |
| 2 | Legatus seat, preset, own tick and wakes | #4488 | Codex | L | — | 1, 3, 13, 14a |
| 3 | Legatus remembers through role memory | #4487, re-scoped | Codex | M | — (2 for live use) | 1, 2, 4, 5 |
| 4 | Legatus screen, sidebar group, one «Needs you» list | #4486 build, #4490 UI | Claude | L | 1, 2 | 3, 5 |
| 5 | Answer timer and Legatus decision log, backend | new, under #4485 | Codex | L | 2 | 3, 4 |
| 6 | Answer timer on every form, UI | new, under #4485 | Claude | M | 4, 5 | 8 (rebase), 9 |
| 7 | In-chat form pilot | new, under #4485 | Claude | M | 5, 6 | 8, 9, 10 |
| 8 | «Answered for you» list | #4490, #4487 UI part | Claude | M | 3, 4, 5 | 6 (rebase), 7, 9 |
| 9 | Legatus decides; its own form; the project switch | #4490 | Codex | L | 3, 5 | 6, 7, 8 |
| 10 | Shadow answers, agreement, trust | #4489 | Codex | L | 9 | 11, 12 |
| 11a | Deploy green main with rollback | #4491 | Codex, 3 review rounds | L | 9 | 10, 11b, 11c, 12 |
| 11b | Read-only SSH diagnostics | #4491 | Claude Opus | M | 9 | 10, 11a, 11c, 12 |
| 11c | Issues in this repository | #4491 | Codex | M | 9 (10 for gating) | 10, 11a, 11b, 12 |
| 12a | Detectors | #4492 | Codex | L | 2 (9 for actions) | 10, 11, 12b, 12c |
| 12b | Capacity governor | #4492 | Codex | M | 2, 9 | 10, 11, 12a, 12c |
| 12c | Spend tracking and runaway CI | #4492 | Claude Opus | M | 2, 9 | 10, 11, 12a, 12b |
| 13 | Prerequisites: measure first | #4493 | Codex | S–M | — | everything |
| 14a | Avatar, icons, author mark | #4494 | Claude | S | — | everything |
| 14b | Telegram daily digest | #4494 | Codex | M | 8, 9 | 10, 11, 12 |

Waves when slots allow: {1, 2, 3, 13, 14a} → {4, 5} → {6, 8, 9} → {7, 10,
11a–c, 12a–c} → {14b}. Slices 6 and 8 both edit `DecisionColumn.tsx`; run
them together only if 8 rebases on 6 before its review.

---

## Slice 1 — «Needs you» counts and lists only waiting forms

**Goal.** The header's number is the number of decision forms that wait for
the operator. On 2026-11-26 that was 9 of 646; 631 were unacknowledged
«Done» items (`needs-you-restructure.md` §1.3). Every surface that names the
list says «Needs you» / «Потрібні ви».

**Today.** `Viewer.tsx:1118` builds the queue with `buildNeedsYouQueue`
(`src/components/attention/attentionQueue.ts:61-74`: conversations,
pipelines, forms through `prototypeReviewNotices`, the update decision), and
`Viewer.tsx:1125` adds `doneItems.length`. The panel draws `DoneSection`
(`AttentionPanel.tsx:263`) and so does the phone sheet
(`MobileAttentionSheet.tsx:210`). The column's tab says `decisions.tab`
(`DecisionColumn.tsx:165`) and its strip `decisions.waiting` (`:203`).

**Changes.**
- `waitingCount = needsYou.length`. The done feed keeps projecting for the
  cards and the deploy and limit fault sounds (`doneItems.ts`, `useWorkCues`).
- The queue keeps `prototype` and `update` entries. Conversation and pipeline
  waits stay only for a project with no designated seat
  (`src/lib/attention/routing.ts:111`, `:124` already route a seated
  project's waits to its seat); slice 9 hands seatless projects to Legatus.
  Questions in the operator's own sessions, stuck deliveries and failed
  launches leave the button and stay on their cards' state lines.
- `DoneSection` leaves both panels; form rows lose «Dismiss», «Dismiss all»
  and Undo, since a form is answered or withdrawn in the column.
- One name in uk and en for the header, the panel head, the column tab, the
  strip and the phone seat chip. At zero the header button stays, muted, with
  no number.
- The panel and the phone sheet stay until slice 4 replaces them with the
  Legatus column. This is sequencing only: it lets the count fix ship before
  the Legatus screen exists.

**Data and protocol.** None on the server.

**Tests.** These assert the old count or the Done section and must change:
`Viewer.needsYou.dom.test.tsx`, `AttentionPanel.dom.test.tsx`,
`MobileAttentionSheet.dom.test.tsx`, `doneItems.hidden.dom.test.tsx`,
`needsYouPanel.test.ts`, `attentionQueue.test.ts`; the onboarding walk's
«"Needs you" counts what waits on you» step reads the same queue. New case:
631 done items, 9 forms and a seated project's worker question give 9 on the
header, the tab title, the panel head and the phone badge; a seatless
project's worker question still counts; the fault sounds still fire.

**UI states.** Kanban driver: the header island at N and at zero, the panel
with form rows only. Phone driver: the ⚠ badge and its sheet. States normal,
empty, busy.

**Overlaps.** #4508 adds a `secret-request` queue kind (a form under this
rule: it counts) in `attentionQueue.ts`, `AttentionPanel.tsx`,
`MobileAttentionSheet.tsx`, `needsYouPanel.ts`; #4143 adds a refusal reason
(it follows the worker rows); #4444 and #4521 edit `Viewer.tsx`. Rebase after
#4508 and replay its tests.

---

## Slice 2 — Legatus seat, role preset, own tick and event wakes (#4488)

**Goal.** Legatus runs as the seat of a service project on each install,
with its own tick and event wakes, and never drives another seat's clock.

**Reuse.** Seats already allow no path (`seatRecords.ts:67`); designation
intents with idempotent replay (`seats.ts:576-620`); the orchestrator preset
as the model (`src/lib/roles/defaults.ts:242-267`); tick settings
(`seatTickSettings.ts:110-144`), the wake fence, coalescing
(`docs/design/seat-inbox-coalescing.md`), auto-rotation, host recovery and
handoff notes; seat messages through the seat channel.

**Data and protocol.**
- Service project key `legatus:<installId>`, from `readSelf`
  (`src/lib/links/self.ts:22-27`), minting the local identity when the
  install was never linked. It canonicalizes to itself, takes no alias or
  succession, has no board, and stays out of the rail's project sections.
- Role preset `legatus` beside `orchestrator`: Codex, effort high (design
  R12a), capabilities for any project's tick settings and seat messages.
  Later slices add their own capabilities.
- `SeatTickSettingsActor.kind` gains `legatus` (`seatTickSettings.ts:84`),
  derived on the server when the caller is the current Legatus seat; every
  tick change it makes is logged with that author.
- Legatus's own tick: 30 min by default, 5 min minimum (R13a). Event wakes:
  `legatus-question` (a form starts waiting in any project, raised where seat
  rounds and task rounds are saved) and `operator-launch`. Detector events
  come in slice 12.
- One clock per seat: a Legatus message to a seat is an agenda item for that
  seat's next ordinary wake; an urgent one goes as a queued delivery, which
  the seat tick counts as the wake. Legatus never writes another seat's
  wake schedule beyond its interval and on/off.
- Start: the Legatus screen offers one «Start Legatus» action while no seat
  exists (slice 4). An upgraded install starts no agent on its own. This
  plan picks that default because it is reversible and matches how a project
  seat is designated today.

**Tests.** Designation and replay for the service key; a Legatus change to
project X's interval leaves a history row with author `legatus`; a Legatus
message to a busy seat adds no seat turn; one unconfirmed Legatus wake at a
time; a form published in any project wakes Legatus once, coalesced. Tests
that designate a Legatus seat use a fresh state directory per file and a
project key of their own, so the seat store fixture's shared ids never carry
a Legatus seat into another test.

**UI states.** None; slice 4 draws the seat.

**Overlaps.** #4306 (`seatTickSettings.ts`), #4517 (`seatTickController.ts`,
`seatTickSources.ts`), #4479, #4268, #4167, #3762 and #3805
(`roles/defaults.ts`).

---

## Slice 3 — Legatus remembers through role memory (#4487, re-scoped)

**Goal.** What Legatus knows of the operator's past decisions comes from the
existing role memory. The operator's hand-typed answers enter it first, and
the author of every rule stays visible.

**Cut from #4487.** The `operator_decisions` store, the `decision_history`
tool, a separate ingest pass, the backfill review form and every
decision-memory surface (operator, 2026-11-25).

**Reuse.** Rule sources already name their author kind: stage, seat, import,
operator, conversation (`src/lib/memory/roleTypes.ts:56-106`). The operator's
own root conversation writes project and machine rules
(`roleStore.ts:357-360`); operator corrections carry `operatorCorrection`
(`roleTypes.ts:120`); kept rules get a reserved band in selection
(`roleSelect.ts:26`); a cross-project role scope exists
(`roleStore.ts:153-155`); the curator's pass
(`src/lib/memory/curation/run.ts`, preset `defaults.ts:389-396`); the
delivery ledger (`deliveryLedger.ts`).

**Changes.**
- Legatus reads `readableScopes(project, "legatus")` and the cross-project
  `legatus` scope at start and rotation, as seats do
  (`docs/design/orchestrator-role-memory.md`), and `search_memory` per form.
- Legatus leaves lessons through the seat writer: `SeatRuleSource.roleId`
  widens to `"orchestrator" | "legatus"` (`roleTypes.ts:71-77`, writer
  `roleStore.ts:346-348`). Its rules read as Legatus's in the rules window.
- The curator's brief gains the operator's answered forms and the operator's
  messages to Legatus since its last pass, bounded (50 per pass, newest
  first), typed text first, then non-recommended clicks, then recommended
  clicks. The curator writes abstract rules into the `legatus` scope (or the
  form's project scope) with a new source `{ origin: "decision", project,
  reviewId | messageRef, author }`.
- The server sets `author`: `typed` only when the rule's cited quote is a
  literal substring of the round's `comment`, `customText` or
  `originalReply` and the round was decided by the operator or a member
  (`src/lib/prototypeReview/types.ts:83`), or of a message with operator
  origin; `voice` when that message came by the voice channel; otherwise
  `clicked`. A round decided by an agent, a seat or Legatus is refused as
  evidence.
- Selection puts typed operator rules in the kept band (`roleSelect.ts:26`).
- A Legatus decision may cite one rule (slice 8's «Why» line). The server
  accepts the id only if the rule is active, readable for Legatus in that
  project, and was delivered to or opened by that Legatus conversation (the
  same ledger check stages use, `roleStore.ts:382`).

**Tests.** An agent claiming an operator author is stored with its own
source; a quote that is not literal yields `clicked`; a replayed pass writes
nothing new; evidence from a Legatus-decided round is refused; a Legatus
lesson lands in the `legatus` scope; citing an undelivered rule is refused;
privacy hints still run on every new rule.

**UI states.** None new. The existing rules window shows the new source.

**Overlaps.** #4306 (`roleStore.ts`).

---

## Slice 4 — Legatus screen, sidebar group, one «Needs you» list (variant 2)

**Goal.** The prototype's Legatus surfaces on real data, and a press on
«Needs you» opens Legatus's column from every screen.

**Reuse** (the prototype mounts each; README table at `c0f7da57`):
`ProjectRail` Overview row (`ProjectRail.tsx:406-419`, `MarkColumns`
`:141`), `MobileProjectSheet` (`:316-328`), `KanbanSeat`
(`KanbanSeat.tsx:51`) → `OrchestratorPanel` (`OrchestratorPanel.tsx:180`) →
`OrchestratorConversation` (`:32`), `MobileSeatCard` (`:120`), `DecisionList`,
`DecisionTabs`, `DecisionColumn`, `DecisionStripLine`
(`DecisionColumn.tsx:45`, `:148`, `:172`, `:191`), `DecisionSheet`
(`DecisionSheet.tsx:24`), `ReportLog` (`ReportLog.tsx:96`), the card parts
(`CardStateLine`, `SeatTickChip`, `EngineBadge`, `WorkerLimitChip`,
`KanbanMenu`) and `AttentionIsland` (`AttentionIsland.tsx:40`).

**Changes.**
- Sidebar system group after Overview, desktop and phone: **Legatus** (the
  word then the Landmark mark, bold when selected; columns: waiting forms
  across projects and orchestrators working on all machines; Legatus's tick
  dot in the age slot; no menu, pin, rename or drag) and **New agent** (an
  action with the accent `MessageSquarePlus`, no columns; it opens the launch
  window of its own lane, and today's board launch until that lands).
- The Legatus screen: the board's header bar with only the needs-you island;
  `KanbanSeat` of the Legatus seat titled «Legatus»; under its header the
  state and next wake, the CPU and RAM gauge against the 75–80 % band, and
  the closed «How far Legatus decides alone» disclosure; the chat; the
  decisions column with «Needs you N», «Reports» and «Answered for you»
  (slice 8 fills the last); the orchestrator grid.
- The incident line and the trust disclosure render only when their data
  exists (slices 12a and 10). The driver draws them from fixture data now.
- Orchestrator grid: one collapsed `.kb .card` per seat on any machine (one
  row on a desktop, as many 220 px columns as fit, two cards on a phone, then
  «All N (M more)»); a stalling seat first; a remote card has the remote look,
  a static dashed tick with a lock, and opens that machine's own Delegatus; a
  local card opens the project's board with its seat. Its count badge is
  named «Needs you N» for a screen reader.
- «Needs you», from any screen, opens the Legatus screen with its column on
  «Needs you N», every project's forms in one list; the phone's ⚠ opens the
  Legatus `DecisionSheet`. `AttentionPanel`, `MobileAttentionSheet` and their
  dismissal code go with their tests. Toasts and phone notices stay.
- One author badge component with a word on it: «Legatus», «Orchestrator»,
  «You · typed». `source()` in `DecisionCard.tsx:37-43` gains a source word
  for Legatus's forms.
- The not-started state with «Start Legatus» (slice 2).

**Data and protocol.**
- Cross-project decisions: `operatorDecisions` (`read.ts:119-140`) without
  the project filter, behind `scope=all` on the existing workspace route
  (`src/app/api/projects/decisions/route.ts:7-12`), filtered by the
  workspace principal exactly as the project read is. `useOperatorDecisions`
  (`useOperatorDecisions.ts:28`) takes it and polls only while the column is
  visible (`DECISIONS_POLL_MS`, `:10`). Counts keep coming from the board
  read, which already carries every project's seat notices
  (`src/app/api/files/response.ts:970`).
- Orchestrators: one read of active seats (`seats.ts:1013`) with health
  (`src/lib/orchestrator/health.ts`), tick settings, the worker limit view and
  open form counts, plus linked peers' seats from link board presence
  (`src/lib/links/boardPresence.ts`) as remote cards. Bounded by seat count.

**Tests.** The rail's Legatus row, the header island, the column tab and the
phone ⚠ show one number; a press opens the column from a project board and
from Overview; the cross-project read refuses what the project read refuses
and hides projects outside the member's workspace; a remote card's menu
opens the peer; `DecisionColumn.dom.test.tsx` covers the cross-project list.

**UI states.** Kanban driver, a `describe` for the Legatus screen over
`issue1695Evidence.fixture.tsx`: normal, empty, busy, incident and
not-started, each with chat, decisions (all folded), needs (pressed from a
project board) and form. Phone driver: the switcher's Legatus row, the seat
card, the sheet, the chat screen. Readings: counters equal, the list holds N
rows, no «Done» text anywhere, phone targets of 44 px.

**Overlaps.** #4508 (`DecisionColumn.tsx`, `DecisionCard.tsx`,
`useOperatorDecisions.ts`, `KanbanSeat.tsx`, both attention panels): rebase
after it and run `git merge-file` over the planned edits first. #4444 and
#4371 (`KanbanSeat.tsx`, `MobileSeatCard.tsx`, `OrchestratorPanel.tsx`),
#4319 (`ProjectRail.tsx`).

---

## Slice 5 — Answer timer and the Legatus decision log (backend)

**Goal.** Each form Legatus can answer carries its own deadline, set by
Legatus. At the deadline Legatus takes the form's recommended answers under
its own name. The operator extends, cancels and restores the timer in one
tap. Every Legatus decision lands in one bounded log.

**Which forms get a timer.** A form Legatus can settle with recommendations
alone: questions only and no variants (a variant has no recommended flag,
`types.ts:13-19`); exactly one recommended option per question, which
publication already enforces (`src/lib/prototypeReview/input.ts:16-28`); no
native association (autonomy is refused there, `decision.ts:244`, `:250`);
no secret request (#4508); owned by this install; the project's Legatus
switch on; a Legatus seat on this install. Every other form says that only
the operator can answer it.

**Data and protocol.**
- A local `deadline` record per review id, kept out of the replica
  (`replica.ts:32`; older linked installs reject unknown round fields,
  `input.ts:21`): `{ at, basis, state: running | cancelled, remainingMs?,
  extendedMs, history[≤ 20]: { at, by, action: set | extend | cancel |
  restore } }`, written under the round's decision lock (`decision.ts:200`).
- `set_form_deadline { reviewId, at, basis }`, for the current Legatus seat
  only (caller attribution as `seatProject` does, `http.ts:93-97`); `at`
  between now + 5 min and now + 7 days; refused on a cancelled timer and on a
  form without a timer.
- Operator actions on the existing route: `POST /api/projects/decisions`
  `{ reviewId, deadline: extend | cancel | restore }`, behind the same
  operator check (`http.ts:253-258`, agent credentials and the spawn
  capability refused). Extend adds 30 minutes; cancel stores the time left;
  restore re-arms now plus that time, as the prototype's toggle does.
- The per-project switch's storage: `SeatTickSettings.legatus { enabled,
  updatedAt, setBy, why }`, absent meaning on (R6a); only the operator
  changes it. It acts only while this install has a Legatus seat, so every
  existing fixture without one stays on today's path.
- One clock for the nearest armed deadline, re-armed on each change and read
  back at boot, beside the delivery worker (`deliveryWorker.ts:237-240`). A
  fire touches the expired forms only; nothing scans the store per tick.
- The deadline decision: `decidePrototype` (`decision.ts:236`) with a new
  context `{ kind: "legatus", conversationId, via: "deadline" }` beside
  `autonomous-seat` (`:55`), `skip: true` taking `recommendedAnswers`.
  Existing guards keep any operator answer: an in-process decision on a
  decided round is refused (`:308`), and so is a round no longer waiting
  (`:245-247`). `decidedBy` gains `{ kind: "legatus", conversationId, via? }`
  (`types.ts:83`); the delivery text names Legatus (`decision.ts:61-65`).
- Delivery by kind of form: a seat's own form goes to that project's seat
  (`decision.ts:313`); a question-only task round goes to the project's seat
  with its task header; a Legatus form goes to Legatus (slice 9); a project
  without a seat keeps the answer saved in `waiting-seat`; another install's
  round never arms.
- The Legatus decision log: a bounded state collection (2,000 rows or 90
  days) holding only Legatus's own decisions: `{ id, at, project, machine?,
  reviewId?, taskId?, subject, chosen, afterDeadline?, ruleId?, mine?,
  changed? }`, written in the same mutation as the decision. Read
  `GET /api/legatus/decisions?before=&limit=50`, operator only, returning
  the cited rule's words and date. «It's mine»
  (`POST /api/legatus/decisions/<id>/mine`, operator only) sets `mine` and
  keeps the cited rule (`keptByOperatorAt`, `roleTypes.ts:143`); the record
  stays Legatus's. «Change» on a form decision is the operator's amendment
  through the existing changed-decision path (`decision.ts:301-322`).
- View contract, fixed here so slice 6 can start on fixtures:
  `OperatorDecisionView.timer: { state: "running" | "cancelled", at,
  remainingMs?, extendedMs, basis, takes: [{ questionId, label }] } |
  { state: "operator-only" }`; the same `state` and `at` on
  `PrototypeReviewNotice` (`types.ts:194-212`) for counts and order; the
  round view exposes `author: operator | legatus | seat` (the view hides
  `decidedBy` today, `types.ts:163`).

**Tests.** A deadline fires once and decides with the recommended answers,
author Legatus, also after a Viewer restart (same message key); an operator
answer a moment earlier wins and the fire changes nothing; an unsent draft
changes nothing; extend, cancel and restore are recorded with the operator;
an agent credential or the spawn header is refused on every timer action and
on «It's mine»; a caller other than the Legatus seat is refused by
`set_form_deadline`; each delivery kind above reaches its recipient, and a
round owned elsewhere never arms; the replica carries no deadline; with
10,000 decided rounds and 3 armed, a fire reads 3; the log stays bounded and
pages newest first.

**UI states.** None; slice 6 draws them.

**Overlaps.** #4508 (`types.ts`, `http.ts`, `useOperatorDecisions.ts`).

---

## Slice 6 — Answer timer on every form (UI)

**Goal.** The prototype's timer on the real forms, folded rows, strip and
phone chip.

**Reuse.** `DecisionCard` (`DecisionCard.tsx:152-205`, questions at `:226`),
`DecisionRow` (`:102`), `DecisionRecord` (`:278`), `DecisionStripLine`
(`DecisionColumn.tsx:191-207`), `MobileSeatCard`'s chip, the browser drafts
(`src/components/prototypeReview/decisionDrafts`), the accent, warning and
danger tokens. The prototype's `TimerRing` (fixture at `c0f7da57`,
`prototype.fixture.tsx:992-1008`) is the reference.

**Changes.**
- One row above the questions: the ring, the time left in words, «+30 min»
  and «Cancel». The line under it names the outcome («at 12:10 Legatus picks
  «…»»), adds «you extended it by 30 min» once extended, and «your draft
  counts only after «Answer»» while the card holds an unsent answer.
  Cancelled: «No deadline» with «Restore the timer». A form without a timer:
  «Only you can answer this», with no ring.
- Tone by minutes left on one scale: accent above 15, warning from 15,
  danger in the last 5 with a soft pulse; under `prefers-reduced-motion`
  nothing moves and only the colour changes. The countdown runs from the
  server's `at` on the client clock and re-reads on every poll.
- Folded rows: two lines, author badge with «project · machine» and «blocks
  work», then the title with a small timer at its end («extended» once
  extended).
- Every list runs soonest deadline first and «No deadline» last, replacing
  `newestDecisionsFirst` (`DecisionColumn.tsx:35`); the column opens the
  soonest form.
- Out of the column's sight, the strip and the phone seat chip carry the
  nearest deadline in its tone («next deadline in 4 min»); the chip shows no
  number.
- «Withdraw the form» moves into the open card's footer under «Answer», and
  an orchestrator's one-question form shows its options straight under the
  timer (prototype README, "Still missing").
- The project switch «Legatus decides for this project» in the tick panel's
  autonomy section (`SeatTickAutonomy`, `SeatTickBody.tsx:908-914`).

**Tests.** `DecisionColumn.dom.test.tsx`: order by deadline, the actions'
requests, the draft line only with a held draft, the operator-only state,
the reduced-motion class, unchanged counts after an extension.

**UI states.** Calm (41 and 52 min), last 15 minutes (12), last minutes (3),
extended, cancelled and operator-only, each open and folded; the strip and
the phone chip with the nearest deadline; reduced motion emulated (no ring
animates) and allowed (exactly the danger rings pulse). Kanban and phone
drivers at every width, language and theme.

**Overlaps.** #4508, #4261 (`SeatTickBody.tsx`).

---

## Slice 7 — In-chat form pilot

**Goal.** The operator expands one question-only form at its settled tool
row, in the conversation that asked it, and answers it there with the same
timer. The Legatus column stays the main surface (`in-chat-ui.md`,
Recommendation).

**Reuse.** The settled row's pointer (`FeedItem.tsx:359`, target
`DecisionPointer.tsx:27-39`, the button `:117-131`); `DecisionCard`,
`DecisionQuestions` (`src/components/prototypeReview/DecisionQuestions.tsx:45`)
and `DecisionRecord`; draft retention; the operator POST and background
delivery (`http.ts:253-278`); the one-round read (`decisionsUrl(project,
review)`, `useOperatorDecisions.ts:12`); slice 6's timer row.

**Changes.**
- The pointer gains «Answer here» beside «in the column». It expands only
  when the round, read through the workspace-scoped GET, is a taskless
  question-only form that still waits and whose saved
  `source.conversationId` (`types.ts:126`) is the conversation on screen.
  Otherwise the pointer stays as it is, or the read-only record shows.
- The inline first answer carries `expect: "waiting"`, checked inside the
  persisted mutation (`decision.ts:241`). A round decided meanwhile (column,
  Telegram, deadline) answers 409 with the saved outcome, and the card shows
  that record; it never turns into an amendment.
- One cache per review id for the column, the sheet and the inline card, so
  an answer in one closes the others.
- No new dependency: no ChatKit runtime, no MCP Apps host, no iframe.

**Tests.** Forged assistant text, a lookalike server name and a fabricated
tool result render the ordinary row; another workspace's review id and an
agent-credential POST are refused; a withdrawn or expired round shows its
record; a simultaneous column answer gives 409 and the record; a double
click saves once; a refused save keeps the draft; Claude and Codex
transcripts both work, live and after reload.

**UI states.** Conversation window driver: the pointer, the expanded card
with its timer, the draft line, the sent receipt and the conflict record; by
keyboard and touch; every width, language and theme; scroll and focus kept;
the composer still usable; production JS and CSS bytes compared with the
base.

---

## Slice 8 — «Answered for you»: Legatus's decisions as a plain list

**Goal.** A log the operator may read and never has to clear.

**Reuse.** `DecisionTabs` (`DecisionColumn.tsx:148-170`) and the phone
sheet's tabs; slice 5's log read and actions; slice 4's author badge.

**Changes.**
- The tab «Answered for you» after «Needs you N» and «Reports», with no count.
- One compact row per decision, newest first: the «Legatus» badge, the time,
  `project › card` (or the machine when no card exists) and «Why ›»; what was
  decided; «Chosen: …» («Chosen after the deadline: …» with a timer mark),
  then «It's mine» and «Change» as quiet text buttons, 44 px under a coarse
  pointer and nowhere else on any surface.
- «Why» is closed by default. Open, it adds one line: the cited rule's words
  and date, or «The form's recommended option».
- «Change» opens a form decision prefilled for the operator's amendment; on
  a decision without a form it puts a draft naming that decision into the
  Legatus composer, so the change the operator types is the operator's own.
- In Legatus's chat each decision is one line («Decided · project › card:
  …», or «Decided after the deadline …») ending in «in the list ›». The line
  is a feed row merged by time from the open log read into Legatus's feed;
  the transcript is untouched.

**Tests.** No count on the tab; every row has the badge; every «Why» starts
closed; the two buttons exist only here; «Change» opens the right surface.

**UI states.** `answered` (every «Why» closed), `answered-why` (one open),
empty («Nobody has answered anything for you yet»), busy (seven rows, two
after the deadline, two without a memory line), and the chat lines; kanban
and phone drivers at every width, language and theme.

---

## Slice 9 — Legatus decides for the orchestrators; its own form; the project switch (#4490)

**Goal.** Legatus answers what seats would bring to the operator, asks
through its own form where it is unsure, and the project switch means
"Legatus decides here".

**Reuse.** Slice 5's `legatus` context; taskless publication
(`input.ts:30-41`, `http.ts:113-118`); Telegram post and answer
(`telegramPost.ts:263`, `telegramAnswer.ts:35`, the owner actor
`decision.ts:218-221`); the autonomy record and overlay (`autonomy.ts:16-29`,
`:94-103`); attention routing (`routing.ts:111`, `:124`).

**Changes.**
- `legatus_decide { reviewId, answers | skip, ruleId? }` for the Legatus
  seat on any project, replacing the own-project check of the seat context
  (`decision.ts:244`); refused for a native association or a secret request;
  writes the decision under Legatus's name and a log row.
- Legatus's own form: the Legatus seat publishes taskless forms filed under
  the project they are about; the round's source names the Legatus
  conversation; the answer goes to Legatus; the card has no precedents,
  weights, confidence or class (round 1).
- Telegram: Legatus's forms post through the existing path and state the
  deadline and the option Legatus takes; the owner's text reply decides as
  the operator with `originalReply`.
- With the switch on, the seat asks and Legatus answers: the seat's
  autonomy overlay stops, the 8/12/24 h episode control goes
  (`SeatTickBody.tsx:16`), a running episode ends at its `until`, and the
  snake ring (`SeatTickSwitch.tsx:135-170`) means the switch is on. The
  operator's switch-off is the operator's decision, and slice 3's curator
  brief carries it into memory.
- Legatus owns seatless projects' waits and the seats' own «blocked»
  reports, so those leave the button (completing slice 1's fallback).
- Until slice 10, Legatus chooses between answering now and setting a
  deadline by its own judgement; slice 10 supplies the measured default.

**Tests.** A Telegram reply is recorded as the operator's with its text; a
deadline default is authored by Legatus; silence never changes an author (a
seven-day-old Legatus decision is still Legatus's); a seat of another
project cannot use Legatus's context; a native association is refused; a
Legatus form's answer reaches Legatus; with the switch off no deadline arms
and `legatus_decide` is refused for that project. `src/lib/monitor/autonomy.test.ts`
and `src/lib/mcp/autonomy.test.ts` cover the overlay change; their fixtures
enter the new path only where they designate a Legatus seat.

**UI states.** The switch and the snake ring in the tick panel; a Legatus
form in the column and in chat; kanban and phone drivers.

**Overlaps.** #4261 (`SeatTickBody.tsx`), #4508.

---

## Slice 10 — Shadow answers, agreement and trust (#4489)

**Goal.** Legatus learns where it may decide at once. Trust picks between
answering now and asking with a deadline, and sets how long the deadline
runs.

**Data.** An append-only, sealed `legatus-predictions` collection: `{ id,
reviewId, questionId, class, choice, confidence, at, digest }`, refused once
the round has a decision. Agreement per class and key with the weights of
design R3a (typed 1.0, a non-recommended click 0.9, a recommended click 0.6,
accept-all 0.5), a 30-day half-life, double weight on contested questions
and on an operator change of a Legatus action, the Wilson lower bound at
z = 1.28 with effective n ≥ 5, and the R2a thresholds 0.6 / 0.8 / 0.9 for
reversible and irreversible classes. A level rises after three passes above
its threshold and falls at once on an operator change; two changes in seven
days cap it at "proposes" for seven days; an explicit operator rule is a
floor, and when agreement drops below 0.6 Legatus asks in a form whether the
rule still stands. No prediction shows before the operator answers (R9a).

**UI.** The data behind slice 4's closed «How far Legatus decides alone»
line: classes per level and the 30-day agreement. Kanban and phone drivers
render the disclosure closed and open with real counts, every width,
language and theme.

**Tests.** A prediction after the answer is discarded; three disagreements
lower the level; an override lowers it at once; a rule floor holds; a
fabricated review id and a Legatus record presented as the operator's are
refused.

---

## Slice 11 — Legatus duties (#4491)

**11a. Deploy green main with rollback** (Codex, L, three review rounds:
deploys and the runtime host are high risk). The Legatus seat becomes this
install's deploy caller (`src/lib/orchestrator/seatDeployments.ts`); automatic
updates stay on (`src/lib/selfUpdate/auto.ts`,
`docs/design/self-update-auto.md`); a 30-minute watch after each deploy
reads loop pauses (`viewerLoopMonitor.ts:100`), start errors and host health;
a regression rolls back to the previous release
(`src/runtime-host/hostRelease.ts:33-41`) and opens a fix lane through the
Delegatus seat. Acceptance: a regression inside the window gives a rollback
and a fix lane; an automatic update that turned itself off comes back after
the fix. Each install deploys itself; there is no remote deploy.

**11b. Read-only SSH diagnostics** (Claude Opus, M). One key per machine; the
remote side admits only a forced-command wrapper with an allowlist, each
command under `timeout`, `nice` and `ionice`; the target comes from the link
registry. Installing the key is a one-time operator action Legatus proposes
in its form (R10a). Acceptance: the remote refuses a command outside the
list and stops a long one by its own timeout.

**11c. Issues in this repository** (Codex, M). `issue_report`'s approval
gate accepts Legatus as author for this repository at the class's trust
level; a privacy hint from the check turns the case into a Legatus form.
Acceptance: without hints and at "decides alone" the issue publishes; with a
hint it becomes a form.

---

## Slice 12 — Detectors, capacity governor, spend (#4492)

**12a. Detectors** (Codex, L). In the five-minute check that calls no model
(`seatTick.ts:57`, child stalls `:476-492`): memory leak from the heap series
(`src/lib/heapSeries.ts:6-28`), disk headroom, loop lag
(`viewerLoopMonitor.ts`), a hung or silent seat, an auth failure at host
start, account limits. Each finding is a Legatus wake event with one incident
and one lane per problem; it fills slice 4's incident line.

**12b. Capacity governor** (Codex, M). Worker limits
(`src/lib/operator/workerLimit.ts:71-113`) with a new actor kind `legatus`
(`:12-17`); signals from CPU pressure (`src/lib/runtime/cpuPressure.ts:30`),
available memory and swap, `/proc/stat` and hwmon; the design's raise, hold,
lower and critical table; heavy gates serialised through `gate-slot.sh`. A
limit the operator set stays. It fills slice 4's load gauge.

**12c. Spend tracking and runaway CI** (Claude Opus, M: it reads provider
billing). AI credits (`src/components/AccountSpendCredits.tsx`), task spend,
CI minutes from the forge API; a daily pace above three times the 30-day
median, or a month forecast above the budget the operator names, raises an
incident and a Telegram message; runaway CI runs are cancelled. Acceptance:
a simulated runaway produces the alert and the cancellation.

---

## Slice 13 — Prerequisites (#4493): measure before building

- **Container self-publication.** The 900-second limit in the issue predates
  the current budgets (`src/lib/pipelines/gateBudget.ts`: 15, 25, 30 and 45
  minutes) and the remote gate runner (`docs/design/remote-gate-runner.md`).
  Run 24 hours of lanes on the constrained machine and build only the gap the
  run shows.
- **Cross-machine seat messages already exist**
  (`src/lib/links/seatMessages.ts:1-2`, durable one-hop messages over the
  linked-board exchange). Verify that a message to a seat on another linked
  machine is accepted and delivered; Legatus-to-Legatus messages use the same
  class (R4a).
- **Memory across installs.** Role memory moves with its sources through the
  install transfer (`src/lib/transfer/`); check that the new `decision`
  source keeps its author, and add replication only if that check fails.

---

## Slice 14 — Identity and Telegram (#4494)

**14a. Avatar, icons, author mark** (Claude, S). A crested-helmet costume in
the existing costume rules (`src/components/brand/roleCostumes.ts:83-181`,
`RoleAvatar.tsx:29`), a `--rf-legatus` token beside the others
(`src/styles/roleFrames.css:34`) at 3:1 or better in both themes, the Landmark
icon for Legatus's cards, a 14 px mark beside the badge word. Until it lands,
slice 4 uses the Landmark. Acceptance: readable at 14, 18, 26 and 64 px in
both themes.

**14b. Telegram daily digest** (Codex, M). One message a day, edited in
place: Legatus's decisions with links, forms waiting with their deadlines,
spend and trust changes once slices 10 and 12c exist. A reply is recorded as
the operator's typed text. Acceptance: a quiet day sends nothing.

---

## Shared files and open pull requests

| Open PR | Files it shares with this plan | Slices that rebase after it |
|---|---|---|
| #4508 secret input | `Viewer.tsx`, `AttentionPanel.tsx`, `MobileAttentionSheet.tsx`, `attentionQueue.ts`, `needsYouPanel.ts`, `DecisionCard.tsx`, `DecisionColumn.tsx`, `useOperatorDecisions.ts`, `KanbanSeat.tsx`, `prototypeReview/types.ts`, `prototypeReview/http.ts` | 1, 4, 5, 6, 9 |
| #4444 board first screen | `Viewer.tsx`, `KanbanSeat.tsx`, `MobileSeatCard.tsx`, `OrchestratorPanel.tsx` | 1, 4 |
| #4371 seat transcript | `MobileSeatCard.tsx`, `OrchestratorPanel.tsx` | 4 |
| #4319 chat relationships | `ProjectRail.tsx`, `FeedItem.tsx` | 4, 7 |
| #4143 destructive guard | `attention.ts`, `attention/decision.ts`, `operatorAsk.ts` | 1 |
| #4261 seat header overlaps | `Viewer.tsx`, `SeatTickBody.tsx` | 6, 9 |
| #4306 tick settings reads | `seatTickSettings.ts`, `roleStore.ts` | 2, 3, 5 |
| #4517 disk self-care | `seatTickController.ts`, `seatTickSources.ts` | 2, 12a |
| #4521 relay tasks | `Viewer.tsx` | 1 |
| #4479, #4268, #4167, #3762, #3805 | `roles/defaults.ts` | 2 |

Each slice that shares a file with an open branch runs `git merge-file` on
scratch copies of the base and both sides with its planned edits before it
starts, and runs the other branch's tests on the combined tree.

## Deferred — not currently justified

- The `operator_decisions` store, the `decision_history` tool, a separate
  ingest pass, the backfill review form, and any decision-memory tab, filter
  or strike-out control (operator, 2026-11-25).
- Precedents, weights, confidence, trust level or class on a form, in chat or
  in the list (round 1).
- A separate needs-you panel (round 2, variant 2).
- A counter on «Answered for you» (round 2).
- ChatKit, an MCP Apps host, iframe widgets and interactive history in chat;
  a second slice of the pilot waits until the first proves itself
  (`in-chat-ui.md`, Deferred).
- Paging «Answered for you» past the log's bound.
- Removing the «Done» store and projector; withdrawing stale forms (a Legatus
  duty once slice 9 exists).
- Remote control of other machines beyond read-only diagnostics and the link;
  changing another machine's tick from a remote card; creating a seat
  automatically where the operator launched an agent; a second Legatus card
  on Overview; voice summaries; Legatus editing code itself; a separate
  "chronicler" role (design's own deferred list).
- Changing the board's "only who waits for me" filter: it keeps its
  card-level reasons.

## Validation against the requirement

- A meta-orchestrator doing the operator's work: slices 2, 9, 11 and 12 give
  it a seat, decisions, duties and detectors.
- No direct prohibitions, a trust model through shadow answers: slices 9 and
  10; the only refusals are platform facts (native association, secrets).
- Operator and Legatus decisions never mix: `decidedBy` names Legatus
  (slice 5), rule sources name their author and the server sets it from
  proof (slice 3), «It's mine» marks a record without changing its author
  (slices 5 and 8).
- Hand-typed text weighs most: literal-quote proof and the kept band in
  selection (slice 3), the R3a weights (slice 10).
- Remembered decisions live in the existing role memory, with no new
  surface: slice 3.
- «Needs you» holds only real questions, one list, opening the Legatus
  column: slices 1 and 4.
- A plain list of Legatus's decisions, one collapsed memory line: slice 8.
- A timer on every form, its own deadline, Legatus deciding after it, a
  noticeable animated ring: slices 5 and 6; forms Legatus may not answer say
  so in words.
- OpenAI-style interactive UI in chat: slice 7, with the column kept as the
  main surface.
