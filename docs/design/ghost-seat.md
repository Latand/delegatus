# Ghost orchestrator: an ephemeral fork of the seat for one side ask

## Originating requirement

Operator correction, 2026-09-26, given in the Delegatus project's orchestrator
seat chat after reading `docs/design/parallel-intake.md` (branch
`docs/design-drafts-2026-09-26`, which recommended a delivery queue so asks stop
interrupting the seat), and pinned to this lane. Paraphrased in English by the
seat; the operator's words were in Ukrainian:

> That missed the idea. While the orchestrator seat is busy, I send a side ask.
> Delegatus starts a temporary "ghost" of the orchestrator next to it: ideally a
> fork of the seat's session, so it has the same context, and it has all the
> seat's permissions (board, tasks, pipelines, agent control). The ghost
> receives only that side message, plus a note that its main self is working in
> parallel in conversation X, so it does not redo or contradict that work. It
> does just that one job quickly (often: capture the ask as a task or issue,
> answer a question, launch or adjust a lane), then disappears. It leaves
> nothing in the conversation lists; at most a small trace near the orchestrator
> on the board (what it did, with links). While it runs it is shown beautifully,
> clearly as "the orchestrator's parallel self" rather than a separate agent.

Every `file:line` below is at main `b7708903d`. Nothing but this document was
written by this stage: no code, no test, no state, no issue.

## Decision in one paragraph

Build it as a **deputy**: a short-lived conversation that is a byte-for-byte
fork of the seat's transcript, launched under the seat's account, model and
tool grants, whose MCP calls are attributed to the seat while its deputy record
is live, and which is never a seat itself. Forking is the right primitive
because the seat's value is its working memory, and the fork costs almost
nothing while the seat is busy: the seat's prompt cache is warm by definition,
so the ghost's first request reads the seat's 617 000 cached tokens at the
cache-read price. A fresh session primed with the monitor note and a board
snapshot is the fallback for a seat whose fork cannot be made, and is deferred.
Authority is one new record beside the seats file, read by the same attribution
fold that already labels a caller "manager": the ghost's reports, task writes
and lanes carry the seat's identity, the seat tick never wakes it, a rotation
kills it, and a queued note to the seat when the ghost ends is how the main self
learns what happened. The first slice is the explicit "ask in parallel" control
for Claude seats, with the desktop chip and trace and the phone's in-feed card;
automatic spawning on every busy ask, Codex seats and several ghosts at once are
deferred with reasons.

## 1. Prior work

- `search_transcripts` in five phrasings, project-scoped then unscoped ("ghost
  seat parallel self", "fork orchestrator disabled policy", "parallel intake
  queue seat busy", "fork session same context", and the Ukrainian
  equivalents): the only design hit is the predecessor
  `parallel-intake.md` lane (2026-09-26), whose measurements this document
  reuses (146 operator asks in three days, 14 interrupted a running turn, 39 %
  arrived within five minutes of the previous one, seat turn p50 54 s, p90
  150 s, max 573 s). No earlier design of a forked orchestrator exists. The
  other hits are role scaffolds repeating "forks are disabled".
- **Why forks are disabled for orchestrator launches.** The orchestrator role
  preset says "Use fresh empty sessions with src lineage; forks are disabled"
  in its scaffold and carries "Fresh empty sessions only; forks are disabled"
  as a safety fence (`src/lib/roles/defaults.ts:55`, `:58`, since
  `c9876d0f8`). The reason is operator feedback recorded in memory: a forked
  worker "carries your context and gets confused; it does not do the actual
  task it was meant to". That rule governs a seat spawning *workers*, whose job
  differs from the seat's. The ghost is the inverse case: its job is exactly
  "be me for one message", so the context is the whole value of the ghost.
  The rule stays for workers; the ghost is a seat operation and never goes through
  `spawn_agent`, whose schema has no fork field at all
  (`src/lib/mcp/server.ts:3270-3300`; `src` is lineage only, `:2993`).
- **Forks that exist today** are the account-migration successors (#889, #708)
  and the explicit "resume here" branch of a superseded round (#383,
  `src/app/api/session/supersedence/route.ts:17`). Section 2 builds on the
  first.
- **Seat-only tasks and seat refs (#1841)** already keep the seat's own
  conversation off the board bands and out of the phone list; section 5 rides
  that exclusion, so no hidden flag is needed.
- **Child final messages in the wake (#1881, #1465)** already carry a settled
  child's last 600 characters to the seat; section 4 uses that as the backstop
  behind a direct note.
- `docs/design/orchestrator-handoff-compaction.md` bounds what a rotation
  hands over (history 4 096 B, predecessor report 6 000 B). Those caps size the
  deferred "primed fresh session" variant in section 3.

## 2. How a fork works today

### Claude

| Piece | Where | What it does |
| --- | --- | --- |
| CLI flag | `claude --help`: `--fork-session` "When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)" | The CLI's own fork. It needs a prompt to write anything (`src/lib/accounts/migration/provider.ts:1549-1552`), which is why Delegatus does not use it. |
| Delegatus fork | `forkClaudeHistory`, `src/lib/accounts/migration/safeHistoryCopy.ts:404-416` | Copies the source transcript line by line, rewriting every top-level `sessionId` to the successor id, under a hash-validated source and a receipt for idempotent replay. "`claude --resume <successor>` then loads the whole conversation on its own: no launch, no prompt, no CLI turn." |
| Launch form | `structuredClaudeLaunchForm`, `src/lib/runtime/structuredSpawn.ts:1073-1090` | A session is resumed only when its transcript exists on disk; the broker then passes `--resume <id>` (`src/lib/runtime/claudeStreamBrokerHost.ts:741`) with the same `-p --input-format stream-json` shape every structured host uses (`:713-745`). |
| Recognition | `accountMigrationHostArgv`, `src/lib/scanner/process.ts:176-182` | A run carrying `--fork-session` is the migration worker and is left out of the resources list so a bulk kill cannot interrupt it. A Delegatus fork carries no such flag; it is an ordinary structured host. |
| System prompt | `claude --help`: `--system-prompt-snapshot on` (default) | The rendered system prompt is recorded on the conversation's first request and "every later request and resume sends the record as-is". A copied transcript carries the seat's snapshot, so the fork runs under the seat's own system prompt without the caller restating it. |

Consequence for the ghost: a Claude ghost is `forkClaudeHistory` from the
seat's transcript into the **same project directory** (so `--resume` finds it
under the seat's cwd), followed by the ordinary structured launch with
`resume`. Both halves exist and are tested; what is new is a caller that is
not a migration.

### Codex

`thread/fork` is a first-class app-server method (`src/lib/accounts/codexAppServer.ts:371-378`,
`docs/design/codex-api-update/METHOD-CATALOG.md:13`), used by the migration's
`createCodex` path (`provider.ts:1580-1660`: recover an earlier fork, detect a
stale one, re-fork). The registry adopts a `forked_from_id` artifact as
**provider history** of its source (`src/lib/agent/registry.ts:555-561`,
`:3336-3366`; `src/lib/types.ts:164-168`) so a fork nobody recorded never mints
a lookalike conversation. A Codex ghost would call `thread/fork`, record the
returned thread as its own generation with `forkIntent: "user-branch"`
(`registry.ts:816-821`), and resume it through `codexAppServerHost`'s
`thread/resume` (`src/lib/runtime/codexAppServerHost.ts:1470-1481`). Two facts
are unverified and keep Codex out of the first slice: whether a forked thread
resumes with the seat's turn context intact (the #1332 paginated-thread
fallback, `:1780-1791`), and how much of the seat's context OpenAI's cache
reuses across threads. Both are one cheap observation each at implementation
time.

## 3. What a fork costs, measured on the live seat

The Delegatus project's seat at epoch 212, read through `get_orchestrator` and
the transcript file on disk, 2026-09-26 morning:

| Measure | Value |
| --- | --- |
| Transcript | 11.98 MB, 2 014 lines, 89 operator/assistant messages, 624 tool calls, 0 compactions |
| Context on the newest turn | 617 111 tokens of a 1 000 000 window (62 %); rotation already advised at 500 000 |
| Newest turn's usage | `cache_read_input_tokens` 616 326, `cache_creation_input_tokens` 783 (all `ephemeral_1h`), `input_tokens` 2 |
| Claude structured hosts alive on this machine | 6, RSS 221 to 313 MB each (`ps`); Codex app-servers 105 to 182 MB |

Cost of one Claude ghost, in order of size:

1. **RAM: one more host, about 290 MB**, for the ghost's lifetime (minutes).
   Same as any worker. This is the only cost that scales with concurrency.
2. **Tokens on the first request.** Prompt caching is a prefix match
   (tools, then system, then messages), model-scoped and isolated per
   workspace; reads cost about 0.1× the input price and a write 2× for the
   one-hour TTL the seat already uses. The ghost's transcript is the seat's
   bytes, its system prompt is the seat's snapshot, and it launches with the
   same model, effort and MCP grants, so its first request is a **cache read
   of ~617 000 tokens plus the new message**. A read refreshes the entry, and
   the seat is busy when a ghost starts, so the entry is warm by construction.
   Under the claude.ai subscription both seats run on, this is usage-window
   consumption; a miss would consume roughly ten times
   more window than a hit (617k at full price plus the 2× write) and is the
   one thing the launch must not cause. Cache breakers to guard: a different
   MCP server set (`mcpServers` grant), a different model or effort, a
   different account, or any edit to the copied history.
3. **Latency.** In the seat's own transcript, the time from an incoming
   message to the first assistant record is p50 4.6 s, p90 9.5 s on cache hits
   (n = 251 turn starts with >300k read). Only two turn starts wrote more than
   50k tokens (a miss); one took 12.9 s. Too few to quote a miss latency; the
   hit numbers are what a ghost should see.
4. **Disk: 12 MB per ghost**, kept for audit (section 5).
5. **Fork itself:** a streamed file copy with a hash; milliseconds.

**The cheaper equivalent, sized.** A fresh session primed with what the seat
knows: mandate 26 302 B and role table 2 320 B (from the seat record), monitor
note 12 896 B (`seat_tick_settings`), a compact board snapshot, and the seat's
last few turns bounded like a handoff (6 000 B). About 50 to 70 KB, roughly
15 000 to 20 000 tokens, all uncached. It costs the same RAM, more window than
a cache-hit fork (20k full-price tokens against 617k at 0.1× is close to
break-even, and every later turn of the ghost is cached either way), and it
loses exactly the thing the operator asked for: the seat's working memory of
what it did in the last ten minutes. `parallel-intake.md` §2 shows the *seat*
misreading which lane an ask concerned twice in four episodes; a primed
stranger does worse. It is deferred (section 9), kept as the fallback for a
seat whose transcript cannot be forked.

## 4. Authority: the seat's power without a second seat

### What "the seat's authority" is today

Manager identity is decided from durable designation records only:
`authorizedManagerSeats` (`src/lib/orchestrator/authority.ts:88-107`) admits
one conversation per project, fails closed on a revocation at an epoch ≥ the
seat's (`:100-102`), and `callerAttributionFrom` folds it into the label
`manager | agent | gateway | unidentified` (`src/lib/mcp/bindings.ts:867-877`).
Being a manager "is NOT a tool-availability gate" (`authority.ts:21-25`): every
session holds the whole MCP surface, so the ghost can already create tasks,
launch lanes, message agents and read the board as any agent can. What the
label changes is short:

| Surface | Where | Manager effect |
| --- | --- | --- |
| Reports | `bridgeReport`, `bindings.ts:2605-2680` | The manager's report takes the orchestrator shape and is mirrored to the project's Telegram chat; any other caller's report keeps a visible attribution prefix. |
| Deploy | `bindings.ts:2511-2547` | Only the designated seat of the project may deploy. |
| Directive self-relay | `bindings.ts:3025-3052` | A directive addressed to the seat by the seat is refused. |
| Seat tick settings, retirement, reply suggestions | `bindings.ts:3364-3370`, `:4309`, `:5415` | Resolve the caller's project through its seat. |
| Archive | `server.ts:3024` | Requires the operator root or a designated seat. |
| Pipeline decisions | `src/lib/pipelines/engine.ts:6870`, `:6945`, `:7081` | `resolve-decision`, `continue-review` and `accept-head` accept an agent only when it is the pipeline's `srcConversationId`. |
| Seat tick | `src/lib/monitor/seatTickController.ts:1001`, `:1232`, `:1403` | Wakes `seatFor(project).active` and nothing else. |

### The deputy record

Add to `state/orchestrator-seats.json` (schema version bump) a `deputies`
list beside `seats`, `revocations` and `history`
(`src/lib/orchestrator/seats.ts:139-148`):

```
{ project, seatConversationId, seatEpoch, deputyConversationId,
  askId, startedAt, expiresAt, endedAt, outcome: null | "done" | "timeout" | "host-died" | "seat-rotated",
  touched: { taskIds: [], pipelineIds: [], conversationIds: [] }, note: null }
```

Rules, in the order the authority module already uses:

1. **A deputy is never a seat.** `seats[project]` is untouched; `nextSeatEpoch`
   does not move. `authorizedManagerSeats` is unchanged. A new
   `deputyPrincipal(conversationId)` returns the seat a live deputy stands for
   when, and only when, that seat is still the project's active seat **at the
   same epoch**, the deputy has no `endedAt`, and `now < expiresAt`. A rotation
   mints a strictly newer epoch (`seats.ts:32-36`), so every deputy of the old
   epoch dies with it, the same ABA rule that kills a predecessor returning
   from pause.
2. **Attribution.** `callerAttributionFrom` gains one branch: a caller that
   `deputyPrincipal` maps to a seat is labelled `manager` with
   `conversationId` = the **seat's** id and `via: { deputy: <ghost id> }`.
   Every surface in the table above then treats the ghost as the seat with no
   change of its own: its report is the orchestrator's report and reaches
   Telegram; its `seat_tick_settings` write resolves the seat's project; the
   directive self-relay check refuses it too (correct: it *is* the
   orchestrator); deploy is refused by a separate rule (below). The ghost's own
   id is kept in the record and in every audit row (`setBy`, report origin,
   pipeline `triggeredBy`) so nothing it did is unattributable.
3. **Owner of what it creates is the seat.** A pipeline the ghost creates gets
   `srcConversationId` = the seat, so the seat can answer its decisions after
   the ghost is gone (`engine.ts:6870`); a task it creates records the seat as
   creator and the ghost as actor. This is the "one owner per task/lane" rule:
   the seat owns everything, and a ghost is one of the seat's hands.
4. **What a deputy may not do.** Deploy (`deploy_exact_sha`) and
   `rotate_orchestrator` are refused with a named code
   (`deputy_cannot_deploy`, `deputy_cannot_rotate`): both are the one gated
   operation and the one identity change, and a five-minute self should do
   neither. `create_pipeline` and `spawn_agent` are allowed; that is the
   "launch or adjust a lane" the requirement names.
5. **The seat tick never wakes a deputy** because it only ever wakes the
   active seat; nothing to change, one test to add.
6. **Expiry is hard.** `expiresAt` = start + 15 min. A ghost still running at
   expiry is interrupted, its record ended with `timeout`, and its note says
   what it had done. A dead host is swept the same way (`host-died`).

### Avoiding conflicts with the main seat

The main seat is mid-turn while the ghost works. Two mechanisms, no lock:

- **The note the ghost starts with** names the seat's current work: the last
  operator message the seat is answering, the lanes in an open state with their
  stage and owner, and the tasks the seat touched in the last ten minutes (all
  from durable state). The ghost's mandate is one paragraph: do this one ask;
  do not touch those lanes or tasks; if the ask is about them, capture it as a
  task and say so, leaving the seat's work to the seat; end your turn when
  done; you have no next turn.
- **The seat learns at the end of its own turn.** When the ghost's turn ends,
  the Viewer composes a bounded note from the record ("Your parallel self
  handled: <ask>. Created task T, launched lane P (links). Final message:
  <600 chars>") and sends it to the seat with delivery policy `queue`
  (`src/lib/runtime/structuredDeliveryQueue.ts:1135-1150`), so it lands as the
  seat's next turn, after the running one, with the running turn untouched. The seat's
  next scheduler wake carries the same through the child ledger (#1881), since
  the ghost is spawned with the seat as parent; that is the backstop for a
  note that failed to deliver.
- **Task and pipeline writes carry a revision** (`update_task` acknowledges
  `revision`, `pipeline_action` requires `expectedRevision`), so a seat and a
  ghost writing the same record cannot silently clobber each other; the second
  writer is refused and re-reads. Nothing new is needed there.

## 5. Lifecycle

**Trigger.** Two entry points, one path:

- *Explicit* (slice 1): an "Ask in parallel" action on the seat composer,
  offered only while the seat's turn is genuinely progressing
  (`seatTurnProgressing`, `src/lib/monitor/seatTick.ts:342-353`, the same
  verdict `agent_activity` gives). The plain send keeps the parallel-intake
  behaviour (queue when that ships, interrupt today).
- *Automatic* (deferred): a per-project setting "side asks run in parallel
  while the seat is busy". Deferred because a second writer on the board
  should start from a deliberate gesture until the trace has proven itself.

**Route.** `POST /api/orchestrator/ghost` `{ project, text, images,
clientRequestId }`, and the MCP tool `ask_orchestrator_in_parallel` for the
bridge and the voice gateway (both go through the same command). Steps, each
durable before the next, replayable by `clientRequestId` the way seat
designation is (`seats.ts:41-49`):

1. Read the active seat; refuse with `seat_not_busy` when its turn is not
   progressing (the plain send is right then), with `deputy_limit` when a
   deputy is already live for this seat (slice 1: one at a time).
2. Write the deputy record as pending (`askId`, epoch, expiry).
3. Fork: `forkClaudeHistory` from the seat's newest generation into the seat's
   project directory under a new session id; record the path as the ghost
   conversation's generation with parent = seat, role `ghost`, and membership
   in the **seat's own task** (the seat-only task of #1841), so no placeholder
   card is minted.
4. Launch the structured host with `resume`, the seat's account, model,
   effort and MCP grant set (cache prefix), `allowSubagents: false`.
5. Deliver one message: the side ask (with images) followed by the parallel
   note from section 4.
6. Mark the record active; answer the caller with the ghost's conversation id
   and the trace id.

**End.** On the ghost's `end_turn`: release the host, end the record with
`done`, compose the note, queue it to the seat, and update the trace. The
transcript stays on disk under the seat's project directory and remains
readable by id through `conversation_messages` and searchable through
`search_transcripts`; that is the audit trail.

**Hidden from lists, still auditable.** The ghost is added to `SeatRefs`
(`src/lib/tasks/groupHide.ts:37-47`) as a `deputies` set, and
`isSeatConversation` (`:52-57`) answers true for it. That single change keeps
it out of the kanban bands and mirrors (`kanbanModel.ts:485-497`, `:551`),
keeps the seat's task seat-only (`seatOnlyTask`, `:66-80`), and keeps it off
the phone's rows, which already never list the seat's own conversation
(`src/components/mobile/MobileBoard.tsx:311`); the desktop dashboard reads the
seat path the same way (`src/components/ProjectDashboard.tsx:466-467`). The
scanner must also rank ghost transcripts below live ones for the recency cap,
as it does for archived migration predecessors
(`src/lib/scanner/discover.ts:482-490`), so a week of ghosts cannot churn
live conversations out of the feed.

**Cleanup.** Hosts are released at end, expiry, or sweep; the record keeps
`outcome`. Transcripts are kept 30 days, then removed by the existing
maintenance sweep (a new rule keyed on `role: ghost` and `endedAt`).

## 6. UI: the orchestrator's parallel self

Tokens and sizes from `docs/design/viewer-design-system.md` (`--text-label`
11 px for chips, 600 weight for chip text, surface tokens from
`src/styles/tokens.css`); the seat's own mark and engine tint from
`OrchestratorPanel`'s `seat-head`. One animated element per view, 150 to
300 ms ease-out on enter and shorter on exit, static under
`prefers-reduced-motion`; nothing pulses forever.

### Desktop: the seat head

The seat head (`src/components/orchestrator/OrchestratorPanel.tsx:530-605`) is
the mark, the avatar `av`, «Оркестратор», the project, the `StateBadge`,
Previous seats, and the incumbent row. The ghost lives **inside that head**, and
the head is its only home:

- **While it runs.** A second avatar of the same engine tint, 70 % size,
  overlapping the seat's avatar at its lower right by 60 %, with a 1.5 px
  dashed ring where the seat's is solid: the same self, drawn lighter. Beside the
  state badge a chip in `accent-soft`: a small live dot, then «паралельно ·
  <ask, 40 chars>». Hover names the ask in full; click opens the ghost's
  transcript in the conversation sheet (read-only composer: the ghost takes no
  second message). The seat's own composer and badge are untouched, so the
  operator can keep talking to the main self.
- **When it ends.** The chip resolves in place into a trace line under the
  head, one row, 11 px: a check mark, «Паралельно 12:41», then the outcome as
  the note said it, with links rendered as the same PR/issue/task chips the
  cards use («створив задачу “…”», «запустив лейн #2244»). The line stays
  until the seat's next report, or until dismissed; its × is a 44 px target.
  Timeout and host death use the warning tone and say so.
- **The record.** The Previous seats popover (`PreviousSeats.tsx`, #1841)
  gets a second section, «Паралельні запити», listing the last ten traces
  with their links and a «Відкрити транскрипт» row each. That is the place an
  operator reads what ghosts did last week; nothing else lists them.

### Phone: the seat card and the seat conversation

The phone's seat card (`src/components/mobile/MobileSeatCard.tsx:55-125`) is
the mark, «Оркестратор» with a state badge, a now line and the context meter.
While a ghost runs, the mark gains the same offset lighter twin and the now
line reads «працює · і паралельно: <ask>». A tap still opens the seat
conversation, where the ghost appears **inside the feed** as a Viewer-authored
card at the point of the ask (the mandate card's family,
`docs/design/delegatus-brand.md` §2 row 6): «Паралельний двійник узяв цей
запит» with the live dot, then, on completion, the outcome and its link chips.
The operator sees the result where they asked, with no second screen and no
row in any list. The trace chips are 44 px tall; the card is not swipeable.

### Composer

"Ask in parallel" is a secondary action beside Send in the seat composer's
action menu (where steer already lives, `src/components/TmuxComposer.tsx:4139`),
enabled only while the seat is busy, with a one-line hint the first time. The
sent bubble carries a «паралельно» chip that becomes the link to the trace.
Keyboard: `Ctrl/⌘+Shift+Enter`.

## 7. First slice

Scope, in one lane:

1. `deputies` in the seats file; `deputyPrincipal`; the `callerAttributionFrom`
   branch; `deputy_cannot_deploy` and `deputy_cannot_rotate`; pipeline
   `srcConversationId` and task creator resolved through the principal.
2. `POST /api/orchestrator/ghost` and the MCP tool, Claude seats only, one
   live deputy per seat, 15 min expiry, `forkClaudeHistory` into the seat's
   project directory, structured launch with `resume`, the ask plus the note.
3. End handling: host release, record, queued note to the seat, trace.
4. `SeatRefs.deputies`, `isSeatConversation`, scanner demotion of ghost
   transcripts, membership in the seat task.
5. Desktop head chip and trace line; phone seat-card twin and in-feed card;
   composer action.

Not in slice 1: automatic trigger, Codex seats, several ghosts at once, the
Previous-seats trace list, the primed-fresh fallback, transcript retention
sweep (ghosts are few; add it with slice 2).

Tests, by path, under isolated state:

- `src/lib/orchestrator/authority.test.ts`: a deputy resolves to its seat;
  not after rotation (older epoch); not after `endedAt`; not after
  `expiresAt`; never when the seat is revoked.
- `src/lib/mcp/bindings` attribution tests: deputy caller labels `manager`
  with the seat's id and `via.deputy`; `bridge_report` from a deputy takes the
  orchestrator shape; `deploy_exact_sha` and `rotate_orchestrator` refused
  with the named codes; `bridge_directive` self-relay refused.
- `src/lib/pipelines/engine.test.ts`: a lane created by a deputy has the seat
  as `srcConversationId`; the seat resolves its decision after the deputy
  ended.
- `src/lib/accounts/migration/safeHistoryCopy.test.ts`: fork into the same
  project directory, receipt replay, size bound.
- Ghost route test: refused when the seat is idle; refused when a deputy is
  live; record written before the fork; a crash between record and launch
  replays on the same `clientRequestId` without a second fork or host.
- `src/lib/runtime/structuredDeliveryQueue.test.ts`: the end note carries
  policy `queue` and lands after the running turn.
- `src/lib/monitor/seatTick.test.ts`: a live deputy is not woken; the ghost's
  final message reaches the next wake as a child item.
- `src/lib/tasks/groupHide.test.ts`: a task whose live assignments are the seat
  and its deputy is still seat-only.
- `OrchestratorPanel` and `MobileSeatCard` DOM tests for chip, trace, twin
  mark and the in-feed card; rendered evidence as one `describe` block in
  `src/components/kanban/kanbanBoard.browser.test.tsx` and one case in
  `src/components/mobile/issue1671Evidence.browser.test.tsx`, at 1280 px and
  390 px, measuring that the chip does not collapse the seat title
  (`basis-[10rem]` rule from the flex-1 lesson) and that the trace line's ×
  is 44 px.
- `scripts/privacy-publication-gate.ts --base <merge-base>` before push.

Rollback: the deputy branch in attribution is behind the record's existence;
with no `deputies` entries every path is byte-identical to today.

## 8. Cost and failure summary

| | |
| --- | --- |
| RAM | +1 host, about 290 MB, for minutes; bounded to one per seat in slice 1. |
| Tokens | First request: cache read of the seat's context (~617k at 0.1×) plus the ask; later requests cached as any turn. A cold fork (seat idle > 1 h, different model, different grants) costs a full read plus a 2× write and is refused by the `seat_not_busy` rule in practice. |
| Latency to first token | p50 4.6 s, p90 9.5 s measured on the seat's cache hits. |
| Disk | 12 MB per ghost, kept 30 days. |
| Ghost misreads the seat's work | Bounded by the note and by revisions on every write; the seat sees the trace on its next turn and can undo. |
| Ghost hangs | 15 min expiry, interrupt, `timeout` outcome, note still sent. |
| Seat rotates mid-ghost | Epoch check kills the deputy's authority at once; its remaining calls are refused as an unattributed agent; the trace says `seat-rotated`. |
| Note never lands | The child ledger carries the final message to the next wake (#1881). |
| Wrong project or wrong account | The ghost inherits the seat's account and project from the seat record; nothing is chosen by the caller. |

## 9. Deferred, not currently justified

- **Automatic ghost on every busy ask.** The requirement allows it
  ("automatically when the seat is busy, or by an explicit control"). Start
  explicit: the burst pattern (39 % of asks within five minutes of the last)
  would spawn several ghosts a minute and the operator has said a wrong
  second writer costs more than a short wait. Reconsider after the trace has
  shown a month of correct ghosts.
- **Primed fresh session.** Sized in section 3; loses the working memory the
  operator asked for. Keep as the fallback for a seat with no forkable
  transcript.
- **Codex seats.** `thread/fork` exists; the resume-with-context and cache
  behaviour are unverified. One observation each, then a slice of their own.
- **Several ghosts at once.** RAM is the bound; add a per-seat cap setting
  once one ghost is trusted.
- **A lock or claim table for tasks and lanes.** Revisions and the note cover
  one ghost. Reconsider only with concurrency.
- **A general "fork any agent" control.** The workers rule stands
  (`defaults.ts:58`); this design is specific to the seat.
- **A deputy that outlives its ask** (a standing second seat). Rejected by the
  requirement ("then disappears").
- **ADR.** The deputy branch in attribution is the one hard-to-reverse
  decision here (a non-seat conversation speaking as the seat); record it as
  an ADR in the implementing lane, with sections 4 rules 1 to 4 as its body.

## 10. Validation against the originating requirement

"Ideally a fork of the seat's session, so it has the same context": section 2,
a byte-for-byte fork under the seat's system prompt, cache-warm. "All the
seat's permissions": section 4, manager attribution through the deputy record,
with deploy and rotate as the two named exceptions. "Receives only that side
message, plus a note about its main self": section 5 step 5. "Does just that
one job quickly, then disappears": one turn, host released on `end_turn`,
15 min ceiling. "Nothing in the conversation lists; at most a small trace near
the orchestrator": section 5's seat-ref exclusion and section 6's trace line
and in-feed card. "Shown beautifully, clearly as the orchestrator's parallel
self": the lighter twin of the seat's own mark inside the seat head, with no
card of its own. Nothing here adds a second seat, a second queue, or a new
process kind beyond the structured host that already exists.
