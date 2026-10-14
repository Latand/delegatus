# «працює» on conversations whose agent is gone (2026-10-14)

## Originating requirement

Operator, 2026-10-14 ~07:26 Kyiv, in chat, with a phone screenshot (390 px):

> «Ще баг, показує що працює, і так кілька розмов»

The screenshot is the phone screen of a task in Done: «Готові · 1 агент · 2
пайплайни», the motion line «Працюють · 1», and one agent row with a green
dot, «працює 57:54:29», gpt-6.1-sol, «запущено 57 год тому». That row is
`conversation_a82924a2-f561-4ac2-bdfe-25ac868d4854`, a Codex review attempt
whose launch was admitted 2026-10-11T18:32:14Z.

This is step one of the pinned task: observation only. The live service was
read and never written: registry and state databases were opened read-only,
the served `/api/files` body was read from the Viewer's own response cache,
and liveness came from `agent_activity`, `agent_fleet` and the existing
receipt predicate run from this checkout. Main had not moved past `f5a767e41`
when this was written, so every line anchor below is on that commit.

## Answer in short

- **What the row is.** It has no transcript, and no host died during a turn.
  It is a launch placeholder, `spawn:369b831a-…`, projected from a launch
  receipt that has sat in `path-pending` since 2026-10-11T18:32Z. The agent
  never started: no transcript was ever written, and the registry host entry
  for its session key is `dead` with no process.
- **Why it says «працює».** The server projects every launch placeholder whose
  receipt is not terminal as `activity: "live"`, with no age bound and no host
  check (`src/lib/agent/spawnProjection.ts:391-399`). Every working surface
  reads `activity === "live"` with no turn boundary as a running turn
  (`src/components/turnDuration.ts:44-49`), and the timer counts from the
  launch admission (`src/components/workingSince.ts:62`).
- **Why it never stops.** Nothing moves that receipt to a terminal state. Its
  pipeline was closed the same evening. The sweep that settles never-started
  launches of closed lanes skips every attempt that carries an `agentPath` or
  a `sessionId` (`src/lib/pipelines/engine.ts:9694-9696`), and all eight stuck
  attempts carry the reserved path and session id that older controllers
  copied in before materialization.
- **How many.** Eight conversations on this machine show «працює» today while
  verified liveness has no live row for them. All eight are stage launches
  from 2026-10-11 13:48–18:32Z, in eight pipelines closed that day. They have
  shown «працює» continuously since then: the same eight are in the cached
  `/api/files` bodies of 2026-10-12, 2026-10-13 and 2026-10-14.
- **Fix: server only.** One projection change makes the placeholder row
  agree with the receipt liveness predicate that `agent_activity` already uses
  (`receiptIsLive`, `src/lib/agent/accountLiveness.ts:156`). One sweep change
  settles the stale receipts. The UI selectors stay as they are: they already
  read one server field through one chain.

## 1. Where each surface takes «працює» and the timer

All of them read the same three fields of the served `FileEntry`: `activity`,
`proc` and `lastTurn`. The client has no other liveness input.

| Surface | Code | Field it reads | Why the stuck launch reads «працює» |
|---|---|---|---|
| Phone task screen, agent row: green pulsing dot, «працює 57:54:29» | `src/components/mobile/MobileTaskScreen.tsx:1259-1268` → `ConversationRow` (`src/components/mobile/MobileBoard.tsx:153`, phrase at `:131-132`, pulsing dot at `:182`) → `mobileRowState` (`src/components/mobile/mobileBoardModel.ts:180-183`) | `turnIsRunning(file)`: `activity === "live"` with no `lastTurn`, or `proc === "running"` with an open turn | The placeholder carries `activity: "live"`, `proc: null` and no `lastTurn`, so the first branch holds. The phrase is `mobile2.board.workingFor` |
| The same row's timer | `workingSince` (`src/components/workingSince.ts:54-62`) | With no transcript turn, the launch anchor: `spawn.admittedAt` | `admittedAt` is the receipt's creation, 2026-10-11T18:32:14.608Z. 04:26:43Z minus that is 57:54:29 |
| «запущено 57 год тому» | `launchedAt` (`src/components/mobile/mobileBoardModel.ts:219-225`) | `spawn.admittedAt` | A true fact about the launch. It claims nothing about liveness and needs no change |
| «Працюють · N» on the task (phone task screen and desktop card) | `TaskMotionLine` (`src/components/kanban/TaskMotionLine.tsx:21`) ← `card.working` (`src/components/kanban/kanbanModel.ts:360`, `:769`) ← `isWorkingAgent` (`src/components/workingAgents.ts:28-34`) | `mobileRowState(...).key === "working"` | Same chain. `taskMotion` (`src/lib/tasks/motion.ts:33`) ranks `working > 0` above `done`, so a Done task reads «Працюють · 1». The phantom also keeps the card sorted with the working cards (`kanbanModel.ts:424-426`) |
| Board header «N працюють», column «N працює», sidebar project ●N, Overview, phone project list «N працюють» | `workingAgentCount` / `workingAgentCounts` (`src/components/workingAgents.ts`) | `isWorkingAgent` | Same chain. Today the project «delegatus» shows 11 where 4 are verified working, and «CelestiaCompose» shows 2 where 1 is |
| Desktop card status badge «працює {elapsed}» | `cardStatus` (`src/components/cardStatus.ts:46-52`) | `turnIsRunning` + `workingSince` | Same pair |
| Conversation screen state (phone header, desktop pinned footer) | `src/components/mobile/mobileChatState.ts:141`, `:160`; `src/components/TurnStatusBar.tsx:94-98` | `turnIsRunning` + `workingSince` | Same pair |
| Every other activity dot (sidebar rows, switch cards, branch pane, scheme nodes, chrome sheets) | `activityDot` (`src/components/utils.ts:41-42`) | `activity === "live"` gives the green pulse | The placeholder's `activity` is `"live"` |
| Phone board «У роботі», switch sheet «Працюють» | `mobileRowState(...).section` | Same as the row | Same |

Every surface is one chain over one server field, and that field is wrong for
this row. No client selector disagrees with another one.

## 2. The stored state of conversation_a82924a2

| Record | What it holds |
|---|---|
| Launch receipt `369b831a…` (structured launch, attempt id `pipeline_1d76a67f_review_2`) | `state: "path-pending"`, `artifactLifecycle: "pending"`, a reserved artifact path and session key, no admission owner, no verified host, no pane. Its error field is the staged launch recovery envelope `{phase: "unpublished", checks: 0, reason: "runtime host request timed out"}` with no `stopped` flag, written at 18:32:25Z and never advanced |
| Transcript | None. The reserved rollout file does not exist on disk, so the conversation has no last transcript records: nothing ever ran |
| Registry conversation | One generation with `host: null`; `turn: {state: "unknown", source: "empty"}` |
| Registry host entry for the session key | `status: "dead"`, no structured process, no claim owner, `pendingAction: "spawn"`, owned by this launch |
| First-message delivery | No held delivery and no delivery operation for `spawn_message_369b831a-…`: the first message was never dispatched |
| Pipeline `1d76a67f` | `closed` at 2026-10-11T18:50:44Z. Review attempt 2 is `needs_decision` with `completedAt` set and the error «stage spawn recovery stopped: … runtime host request timed out; original launch retained». The attempt's `agentPath` and `sessionId` equal the receipt's reserved path and key |
| Served `/api/files` row (response cache, 2026-10-14T04:38:53Z) | `path: "spawn:369b831a-…"`, `activity: "live"`, `activityReason: "structured_spawn_binding"`, `proc: null`, no `lastTurn`, `spawn.state: "binding"`, `spawn.admittedAt: 1791743534608` |
| Verified liveness | `agent_activity` targeted on the conversation with `includeGone`: no row. `agent_fleet` for the conversation: zero agents. `receiptIsLive(receipt)` from this checkout: `false` |

The only thing that says «running» is the projection's `activity: "live"`.
The receipt says `path-pending`, a non-terminal state that nothing will ever
move on its own. Two done task cards hold this conversation as a linked
assignment: tasks `c1f9173a…` and `becad6dc…`.

## 3. Why the field stays «running»

### 3.1 The projection has no liveness input

`spawnCard` (`src/lib/agent/spawnProjection.ts:544-633`) builds the
placeholder row with `proc: null` and
`activity: projectedActivity(spawn, receipt.createdAt, nowMs)` (`:598`).
`projectedActivity` (`:391-399`) answers `"live"` for every card state except
`failed` and `recovered`. It reads no host, no process and no age. The card
state comes from the receipt: a `path-pending` receipt with a key and an
artifact path is `binding` (`:121-150`).

The rules that correct a transcript row stop short of this row:

- `projectStructuredFileLiveness` (`src/lib/runtime/livenessProjection.ts`)
  replaces `activity` and `proc` from the verified turn liveness, only for
  transcript paths owned by a live structured host.
- The registry-dead rule in `/api/files`
  (`src/app/api/files/response.ts:513-522`) sets `proc: "killed"` and a
  terminal turn when the host entry is dead, and skips every placeholder
  (`:486`, `if (file.spawn) continue;`).

So a placeholder stays `"live"` for as long as its receipt stays
non-terminal. Five of the eight receipts already carry a recovery envelope
with `stopped: true`, which the projection forwards as
`spawn.recoveryStopped: true`. `projectedActivity` ignores that flag as well.

The server already has the right predicate. `receiptIsLive`
(`src/lib/agent/accountLiveness.ts:156-162`) says a non-terminal launch
receipt is live while its admission owner, its verified host or its registry
entry is live, and otherwise only inside the 5-minute unproven-launch grace.
The lifecycle snapshot behind `agent_activity` uses it
(`src/lib/lifecycle/liveness.ts:700-715`), and so do the reaper
(`src/lib/reaperRuntime.ts:840`) and account liveness. Run from this checkout
over the live registry rows, it answers `false` for all eight receipts. The
board projection is the one reader of these receipts that does not ask it.

### 3.2 Nothing settles the receipt

- Generic staged-launch recovery leaves pipeline launches to the pipeline
  engine (`src/lib/runtime/structuredSpawn.ts:1962`, `:2057`).
- The engine probes only the current attempt of a running or parked lane
  (`recoverWaitingStageLaunches`, `src/lib/pipelines/engine.ts:8046-8068`).
  When recovery ran out on 2026-10-11, `waitForStagedLaunch` tried
  `settleNeverStartedLaunch` (`:8009-8011`). That returned false, one attempt
  recording «database is locked», so the lane parked with «original launch
  retained».
- After the lane closed, only the closed-lane sweep can settle the launch
  (`:9692-9705`). It preselects attempts with
  `!attempt.agentPath && !attempt.sessionId`. That filter came with the sweep
  in `873a81355` (2026-09-21). Since `56dc06f96` (#2764, 2026-10-12),
  `neverStartedLaunch` (`:7908-7927`) accepts an attempt that carries the
  reserved path and id, once it proves that exact artifact absent. The
  preselection was not widened to match, so the sweep never hands such an
  attempt to it. All eight stuck attempts carry the reserved `agentPath` and
  `sessionId`.

Everything `failNeverStartedStageSpawnNow` (`src/lib/agent/registry.ts:7073`)
checks before it settles is true for all eight: no first-message delivery
row, reserved artifact absent, host entry `dead` with no process and no claim
owner, and the entry's operation id names this launch. None of the eight
closed pipelines has an unresolved termination survivor. The sweep would
settle them if it reached them.

The 2026-10-11 cause, a runtime host that timed out or was unavailable while
these launches started, is a separate incident and stays out of this task.

## 4. How many conversations show «працює» today

Method: the `/api/files` body the Viewer cached at 2026-10-14T04:38:53Z (651
rows) was run through this checkout's own selectors (`isWorkingAgent`,
`mobileRowState`, `turnIsRunning`) at 04:39:54Z. The result was compared with
`agent_activity` (04:40:04Z, then targeted per conversation at 04:51Z) and
with `receiptIsLive` over the live registry rows.

- 14 rows read «працює».
- 6 are transcript rows. All 6 are `running`, `verified: true` in
  `agent_activity`, and they are correct.
- **8 are launch placeholders.** None has an `agent_activity` row, even with
  `includeGone`. `receiptIsLive` is false for each, its host entry is `dead`,
  and no transcript exists. Their timers read 58–63 hours.
- The cached bodies of 2026-10-12T05:32Z and 2026-10-13T02:08Z hold the same
  eight placeholders as working. In none of the three bodies is a transcript
  row shown working without a verified running host. A host that dies during
  a transcript turn already reads «вбито» / «зупинено», through `proc:
  "killed"` from `livenessProjection.ts`.
- Nine task cards hold one of the eight: seven Done and two Assigned.

| Conversation | Launch | Pipeline · stage · attempt | Admitted (2026-10-11, UTC) | Recovery envelope | Lane closed (UTC) |
|---|---|---|---|---|---|
| `conversation_f1dbeb61-a388-4433-83c6-0d9a603777d3` | `6b2921ba` | `2fc4e7e8` · review · 1 | 13:48:29 | unpublished, 0 checks, never stopped | 14:19:02 |
| `conversation_fcc1f905-12cb-492d-a7f3-1a9dcd641994` | `24f4c0e3` | `01e9febe` · build · 5 | 16:34:42 | stopped after 0 checks | 18:32:15 |
| `conversation_e75c6e03-b4ff-460c-836b-d72b11b88b63` | `d5833f99` | `56658137` · fix · 2 | 16:42:37 | stopped after 2 checks | 19:47:16 |
| `conversation_89b1875a-2425-4542-85b5-d1864909d73f` | `27c4933c` | `73d507a0` · review · 4 | 16:50:27 | stopped after 0 checks | 18:35:12 |
| `conversation_5d23613a-f204-4b93-b2f3-fdd527eb06fd` | `4daa783c` | `b6e70d8f` · build · 3 | 16:56:45 | stopped after 0 checks | 18:32:14 |
| `conversation_f13c42ba-a6bc-4e58-9a5d-4ad857897c91` | `cfc47094` | `77856ee5` · build · 3 | 17:00:27 | stopped after 0 checks | 18:32:12 |
| `conversation_e7719ad5-77f1-424f-b7f2-fe745ed9a696` | `d9cefd2a` | `16a86666` · build · 3 | 17:05:05 | unpublished, 0 checks, never stopped | 18:32:11 |
| `conversation_a82924a2-f561-4ac2-bdfe-25ac868d4854` | `369b831a` | `1d76a67f` · review · 2 | 18:32:14 | unpublished, 0 checks, never stopped | 18:50:44 |

All eight receipts are `path-pending` with `artifactLifecycle: "pending"`.
All eight host entries are `dead` with no process. All eight attempts are
`needs_decision` with `completedAt` and the reserved `agentPath`/`sessionId`.
Seven belong to the project «delegatus» and one (`56658137`) to
«CelestiaCompose».

## 5. Fix plan

**Server only.** No UI file changes. The client chain (`turnIsRunning` →
`mobileRowState` / `isWorkingAgent` / `cardStatus` / `workingSince`, and
`activityDot`) already reads one server field. A client-side cap on a
placeholder's age would be a second liveness rule, and the browser cannot see
a host process anyway.

**The one place the truth comes from:** the server's receipt liveness
predicate `receiptIsLive` (`src/lib/agent/accountLiveness.ts:156`), which the
lifecycle snapshot behind `agent_activity` already uses for launch receipts.
For transcript rows the matching authority is already in place
(`projectStructuredFileLiveness` and the registry-dead rule), so placeholder
rows are the only gap.

### Change 1: a placeholder is «live» only while its launch is (projection)

`src/lib/agent/spawnProjection.ts`:

- `projectLaunchConversations` takes a `LivenessProbe` (default
  `livenessProbe()` from `src/lib/agent/accountLiveness.ts`) and passes it to
  `spawnCard`. That keeps the projection testable with a fake process table,
  as `artifactProbe` already is.
- For a non-terminal receipt, `activity` is `"live"` only when
  `receiptIsLive(snapshot, receipt, probe)` holds. Otherwise the row takes the
  quiet reading by age that `projectedActivity` already applies to terminal
  cards and `livenessProjection.ts` applies to transcripts: `"recent"` under
  15 minutes, then `"idle"`. It also gets an `activityReason` that says why
  (a machine reason, never UI text), and `proc: "killed"` when the receipt's
  host entry recorded a process that is now gone (the rule
  `livenessProjection.ts:104-123` uses), else `null`.
- `spawn.state` keeps reporting the receipt. Change 2 owns the move to
  `failed`.

Effect: with no UI change, every surface in §1 stops at once. The row reads
the words the UI already uses for a conversation whose host is gone:
«готово · 2 дн» on the phone row, «без руху» as the desktop member state, a
grey dot, no timer, and no share of «Працюють · N». A launch still inside its
first five minutes, or one whose host or admission owner is alive, stays
«працює» as today.

### Change 2: the closed-lane sweep reaches every never-started launch (record)

`src/lib/pipelines/engine.ts:9694-9696`: the preselection keeps attempts with
a `launchId` that are not `failed` and have no verdict, and drops
`!attempt.agentPath && !attempt.sessionId`. It may narrow to attempts whose
receipt is `starting` or `path-pending`. `neverStartedLaunch` keeps its own
proof for the reserved path (that exact artifact absent, the same path as the
receipt). `failNeverStartedStageSpawnNow` keeps its fence: no host, artifact
absent, first message never dispatched.

Effect on this machine: on the next controller tick the eight receipts become
`failed` with «stage launch never started: pipeline closed». Their dead
entries drop the pending spawn action, and the receipts, being terminal and
older than 24 hours, leave the board (`retiredTerminalReceipt`,
`spawnProjection.ts:55-60`). The task cards lose the phantom row and the
«Працюють» line. The stage history stays on each pipeline's stage chip and
past attempts, where a failed stage launch is already shown
(`kanbanModel.ts:710-715`). Nothing is spawned, resumed or restarted. Settled
rows leave the preselected set, so the sweep stays bounded like the history
reads of #2761 and #2831.

### Tests, failing first

1. `src/lib/agent/spawnProjection.test.ts`: a registry snapshot with a stage
   launch receipt in `path-pending`, the unpublished recovery envelope (one
   case `stopped: true`, one never probed), its host entry `dead` with no
   process, admitted 58 hours before `now`. Feed the projected `spawn:` row,
   beside one live transcript row, to the real `turnIsRunning`,
   `isWorkingAgent`, `mobileRowState`, `cardStatus`, `workingSince` and
   `activityDot`. On the base commit the placeholder is `"live"` and working.
   After the fix it is quiet, and `workingAgentCount` equals the
   `agent_activity` live count. Controls that stay «працює»: a receipt
   admitted two minutes ago with no host evidence, and one whose host process
   the fake probe reports alive.
2. `src/lib/pipelines/engine.recovery.test.ts`: a closed pipeline whose
   attempt is `needs_decision` with `completedAt` and the reserved
   `agentPath`/`sessionId`, its receipt `path-pending` with the unpublished
   envelope, its host entry dead, the artifact absent. One controller pass
   leaves the receipt `failed`, starts no spawn and no resume (assert the
   spawn port was never called), and a second pass changes nothing. On the
   base commit the receipt stays `path-pending`.
3. A transcript row whose host died during its turn, through the same
   selectors, as a guard that stays green. That is the shape the pinned
   acceptance names. It is already correct today; the observed case is the
   launch whose host died before its first turn, which test 1 reproduces.

### Rendered check

Add a case to each existing driver; write no new driver:

- desktop: a `describe` block in
  `src/components/kanban/kanbanBoard.browser.test.tsx` over
  `issue1695Evidence.fixture.tsx`;
- phone: a case in `src/components/mobile/issue1671Evidence.browser.test.tsx`
  over `issue1671Evidence.fixture.tsx`, opening the task screen
  (`[data-phone-task-body]`).

The fixture task holds one dead placeholder and one live transcript. Build the
dead row by running `projectLaunchConversations` over a registry fixture with
a dead host entry, so the frame shows the fix's own output and no hand-written
`activity` value. At 1440 px and 390 px, assert «Працюють · 1», exactly one
green dot and one running timer, and on the dead row no «працює», no green
dot and no timer. Record the readings under `evidence/` with a name that is
not an issue number, and close every browser.

### Checks for the build stage

Run touched test files by path with `bash scripts/gate-slot.sh bun test
<file>`, under an isolated HOME, XDG, TMPDIR and `LLV_STATE_DIR`, with the
Viewer control URL pinned to a closed port. Then `tsc`, eslint on touched
files, and the privacy gate with the fingerprints environment.

### Fences

Lane `96ee6724` (#2829, closing a lane never fails on an unavailable runtime
host) edits `src/lib/pipelines/engine.ts` in `drainPipelineCloses` and
`patchPipeline` (around lines 11113–11150 and 12793–12840 of its worktree).
Change 2's hunk at 9694 does not overlap them. The two lanes share the file,
so rebase before pushing.

## Options considered

| Option | Verdict |
|---|---|
| UI only: cap a placeholder's «working» by age in `turnIsRunning` or `mobileRowState` | Rejected. It adds a second liveness rule on the client, the client cannot see a host, and the receipts stay unsettled |
| Record only (Change 2 alone) | Not enough. A lane parked with «original launch retained» keeps its receipt non-terminal on purpose, for retry-stage, and the row would read «працює» for the whole park |
| Projection reports a launch with no live host as `spawn.state: "failed"` | Rejected for now. It would make a settlement decision in the read model, and for an operator's own launch it would offer Retry while the server refuses it because the receipt is not failed |
| **Change 1 + Change 2** | Recommended. One predicate the server already trusts decides «live», and the stale records settle through the existing settlement path |

## Check against the requirement

«показує що працює, і так кілька розмов»: eight conversations, one mechanism.
Change 1 makes every listed surface agree with verified liveness at read time,
including a lane still parked on a retained launch. Change 2 settles the
records that caused it, without resuming anything, so the rows leave the task
cards and the «Працюють · N» counts drop to what `agent_activity` reports.

## Deferred — not currently justified

- The 2026-10-11 runtime host timeouts that stranded these launches. They are
  a separate incident, and its receipts and journals are retained.
- The spinning «Під’єднання хоста» launch chip inside the placeholder's own
  conversation view. It is a launch state and not a «працює», dot or timer
  surface. Change 2 removes it for closed lanes; in a parked lane it is the
  retained launch the operator retries.
- Time-only transitions and the `/api/files` projection cache key. The key
  moves with the scan generation and the registry transaction count
  (`src/app/api/files/operatorProjection.ts:228-286`). Host death and
  settlement both write the registry. The 5-minute grace boundary is
  time-only, like the existing 15-minute terminal boundary, and behaves the
  same way.
- Dead host entries that keep `pendingAction: "spawn"` and are rewritten
  daily (five of the eight were touched at 2026-10-14T04:29Z). Change 2
  clears the action for these eight; whatever rewrites them is not a liveness
  surface.
