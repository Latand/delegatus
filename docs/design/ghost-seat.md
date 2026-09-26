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

Operator decision on the first draft, 2026-09-26, pinned to the build lane and
paraphrased in English by the seat (the operator's words were in Ukrainian):

> The ghost's work appears in the seat's own conversation feed, live: its
> messages and its tool calls, like any turn, drawn "ghostly" (lighter, dashed,
> clearly the orchestrator's parallel self), not in a separate transcript
> sheet. The seat chat is becoming a team chat: several people (with the
> signatures from the sign-in work) and possibly several orchestrators or
> ghosts. Reply blocks from different participants can fill at the same time
> and interleave; everything stays in one conversation. Each participant's
> turn is its own block anchored at the message it answers, blocks stream in
> parallel without scrambling each other, and a finished ghost block collapses
> to a one-line result with links, expandable. Desktop and phone.

Every `file:line` below is at main `b7708903d`, except the sign-in references,
which are at the head of PR #2243 (`docs/design/sign-in-and-team.md`, in
progress). Nothing but this document was written by this stage: no code, no
test, no state, no issue.

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
for Claude seats, with the ghost's turn shown live inside the seat's own feed as
a block of its own, anchored at the ask, and collapsing to one line when it ends;
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
  askId, ask: { text, images: [], sender: null | { memberId, name, color, initials } },
  artifactPath, forkRecordCount,
  startedAt, expiresAt, endedAt, outcome: null | "done" | "timeout" | "host-died" | "seat-rotated",
  touched: { taskIds: [], pipelineIds: [], conversationIds: [] },
  result: null | { line, finalText }, note: null }
```

The record is also what the seat's feed draws the ghost's block from (section
6): `ask` is the block's head (the operator's message, with the sender the
team recorded for it, PR #2243 §6.7), `artifactPath` and `forkRecordCount`
tell the feed which transcript to read and where the ghost's own rows begin
(everything before that count is the seat's copied history), and `result` is
the one line the finished block collapses to, with `touched` as its links.

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
  behaviour (queue when that ships, interrupt today). The ask never enters the
  seat's transcript: the seat's feed shows it as the head of the ghost's
  block, read from the deputy record (section 6), so the operator sees their
  message where they sent it while the seat's own turn keeps streaming under
  it.
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
2. Write the deputy record as pending (`askId`, the ask with its sender,
   epoch, expiry). From this moment the seat's feed draws the block's head;
   the composer's own pending row retires on the route's acknowledgement,
   exactly as a delivered receipt retires it today.
3. Fork: `forkClaudeHistory` from the seat's newest generation into the seat's
   project directory under a new session id; record the path as the ghost
   conversation's generation with parent = seat, role `ghost`, and membership
   in the **seat's own task** (the seat-only task of #1841), so no placeholder
   card is minted. Write `artifactPath` and `forkRecordCount` (the source
   line count the copy reports) into the record.
4. Launch the structured host with `resume`, the seat's account, model,
   effort and MCP grant set (cache prefix), `allowSubagents: false`.
5. Deliver one message: the side ask (with images) followed by the parallel
   note from section 4.
6. Mark the record active; answer the caller with the ghost's conversation id
   and the trace id.

**End.** On the ghost's `end_turn`: release the host, end the record with
`done`, compose the note, queue it to the seat, and write `result` (the one
line the block collapses to, built from `touched` and the final message's
first line) so the feed collapses the block. The transcript stays on disk
under the seat's project directory and remains readable by id through
`conversation_messages` and searchable through `search_transcripts`; that is
the audit trail.

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

**Reaching the feed.** The seat read model the panel already polls
(`get_orchestrator` and the panel's seat state) gains `deputies`: the live
record and the last ten ended ones for the active seat. `OrchestratorConversation`
(`src/components/orchestrator/OrchestratorConversation.tsx:50`) and the phone's
`BranchPane` (`src/components/BranchPane.tsx:474`) pass them to `LogFeed`; a
feed with no deputies renders byte-identically to today.

**Cleanup.** Hosts are released at end, expiry, or sweep; the record keeps
`outcome`. Transcripts are kept 30 days, then removed by the existing
maintenance sweep (a new rule keyed on `role: ghost` and `endedAt`). A block
whose transcript is gone still draws its head and its collapsed line from the
record; only "expand" is unavailable, and says so.

## 6. UI: the orchestrator's parallel self, in the seat's own feed

Tokens and sizes from `docs/design/viewer-design-system.md` (`--text-label`
11 px for chips and captions, 600 weight for chip text, roles from §1.5,
motion from §1.6: `--motion-base` 200 ms with `--ease-standard`, static under
`prefers-reduced-motion`, at most one attention animation on screen). The
seat's conversation is `LogFeed` inside `OrchestratorConversation` on the
desktop and inside `BranchPane` on the phone (`MobileFocusView.tsx:613`);
both mount the same feed, so everything below is one component set drawn in
one list, and the phone differs only where §3.4 of the design system already
makes it differ (no avatar column, 12 px gutter, full-width rows).

### 6.1 The feed as a team chat: participants and blocks

Today the feed is one keyed list of rows in transcript record order
(`LogFeed.tsx:1136-1262`), followed by three tail sections in a fixed order:
launch chips, the operator's pending messages, then the seat's live turn
(`tailOrder.ts`). Every assistant row is implicitly the seat's, every human
row is the operator's, and the sign-in work adds a sender line above human
rows that names the member who sent it (PR #2243, `SenderLine.tsx`: avatar dot
in the member's colour plus the name, 11 px, above the bubble, aligned with
it).

The team-chat model adds one concept, the **block**, and one rule for how
blocks sit in the list:

- A **participant** is whoever produced a row: a person (a team member, or
  the anonymous operator on a solo install), the seat, or a ghost of the seat.
  Every row already names its participant somewhere (the sender line, the
  engine caption); the block makes the assistant side explicit too.
- A **block** is one participant's answer to one message: the message it
  answers (its *head*) and the rows that answer it, in that participant's
  transcript order. The seat's own answers are blocks whose head is the
  operator's row and whose body is what the feed renders today; nothing
  changes for them in this slice, they stay the flat list, and a "seat block"
  exists only in the model. A ghost's answer is a block that is *drawn*: its
  head is the ask (from the deputy record, section 4), its body is the
  ghost's rows.
- **Ordering.** A block is placed once, at the position of its head, and
  never moves: it goes after the last seat row whose instant (`transcriptInstant`,
  `src/components/feed/transcriptOrder.ts`) is at or before the block's
  `startedAt`, and after any undated rows immediately following that row.
  Everything the seat writes later is dated later and lands below the block.
  Inside a block, rows keep their own transcript's record order and are never
  re-sorted by timestamp against the seat's rows. Two blocks started at
  different instants sit in start order; slice 1 has at most one ghost block
  live, but the placement rule already handles several.
- **Resuming.** A block pinned at its head splits the seat's own answer: the
  seat keeps writing, and its next row lands under a foreign ask, where it
  would read as the answer to that ask. So the first seat row after a block,
  or after a run of blocks, carries one caption line naming the seat head it
  continues: «Оркестратор · далі до «Проглянь чергу рев'ю і…»» /
  "Orchestrator · continuing «Go through the review queue…»", the head's
  first words cut at a word. A new seat head in between answers itself and
  needs none (`resumedSeatRows`, `deputyPlacement.ts`). While a ghost
  streams, the seat's own live turn carries «Оркестратор» above its rows too,
  so two live streams never read as one. On the phone every seat prose row
  already has a header naming the engine («Claude · 12:33»), so the seat
  keeps that one name there: a resuming prose row folds the continuation
  into its own header («Claude · 12:33 · далі до «…»»), a resuming tool row
  and the live turn carry a line of the same shape (glyph, «Claude»), and no
  seat row shows two speaker names stacked. The live turn is named what its
  settled row will be.
- **Growth.** A block grows only at its own end. The seat's live turn stays
  the last tail section, so with a ghost live the reader sees the ghost's
  block filling in the middle of the list and the seat's answer filling at
  the bottom, each in its own place. The viewport keeps the row the reader is
  on through the existing anchoring (`data-feed-key` on every row,
  `LogFeed.tsx:1529-1553`, and the residual compensation in
  `PrependViewport`); rows inside a block carry the same attribute, keyed by
  the ghost's conversation id, so a block growing above the reader's row
  compensates like a "show earlier" reveal and a block growing below it moves
  nothing. The magnet (following the tail) keeps following the seat's tail;
  the ghost's block is never the tail.
- **Live rows.** A ghost's in-flight rows come from the runtime store the
  feed already reads for the seat, keyed by the ghost's conversation id
  (`useRuntimeSessionForConversation`, `src/hooks/useRuntime.ts:201`), and
  are rendered by the same `LiveTurnRows` with the same eight-row bound and
  the same claim handoff to canonical rows (`LIVE_TURN_VISIBLE_ROWS`,
  `LiveTurnRows.tsx:80`). The canonical rows come from a second `useLogTail`
  on the ghost's `artifactPath`, with everything before `forkRecordCount`
  dropped (that prefix is the seat's own history, already on screen). One
  block, two sources, the handoff the feed already has.

This is the whole model the requirement's "team chat" needs, and it is small
on purpose: no second list, no per-participant column, no re-sorting by clock.
Several people already fit (their rows are heads of seat blocks, each with its
sender line); several orchestrators or ghosts fit as more drawn blocks, each
with its participant caption; the deferrals in section 9 say what is not
built for them yet.

### 6.2 The ghost block, live

```
   ┌ (seat rows continue above)
   │  Olena ● 12:39                                             ← sender line (team only)
   │                        ┌──────────────────────────────────────┐
   │                        │ Add a task: reviewer for #2244 …      │  ← the ask, ordinary user bubble
   │                        └──────────────────────────────────────┘
   ┆ ◌ Оркестратор · паралельне я · 12:39   ● працює       ▾      ← block caption
   ┆   ⚙ MCP · viewer  create_task «Reviewer for #2244» · task ✓   ← live tool row, unchanged shape
   ┆   ⚙ MCP · viewer  list_pipelines · ok
   ┆   Створив задачу і прив'язав до лейна #2244; …▍                ← streaming prose
   │ (seat's own rows continue below; seat's live turn at the tail)
```

- **Head.** The ask is the ordinary human message row (`UserMessageRow`,
  `--color-user` fill, `--radius-surface`, sender line in a team), drawn from
  `record.ask`. It is the only part of the block that is not "ghostly": the
  person really said it. Its meta line says where it went: «→ ◌ паралельне я»
  / "→ ◌ parallel self" with the outline mark, after the sender in a team, so
  the ask never reads as one more message to the seat.
- **Caption.** One 11 px line, `text-muted`, that names the participant the
  way the phone's prose caption does (`FeedItem.tsx:158-162`): the seat's
  engine mark drawn as an **outline** (the mark in `text-secondary` inside a
  1.5 px dashed ring, `border-strong`, transparent fill) where the seat's own
  rows carry the filled circle; then «Оркестратор · паралельне я» / "Orchestrator
  · parallel self", the start time, and the state: a static dot plus «працює»
  while live (green `success`; the dot does not pulse, §1.6), or the outcome
  when ended. A chevron at the right end is the expand/collapse control,
  44 px tall on coarse pointers. On the desktop the caption sits in the
  `ml-9` chrome column of §3.4 so it reads as one line of quiet activity
  beside the seat's own.
- **Edge.** The body hangs from a 1.5 px **dashed** left edge in
  `border-strong` running from the caption to the block's last row, in the
  avatar column on the desktop (the seat's rows have no edge there) and at the
  gutter on the phone. That edge is what makes the block one thing and makes
  it read as the seat's parallel self: the same mark, the same grammar of
  rows, drawn in outline.
- **Rows.** Tool rows and MCP rows are the feed's own `ToolLine` and
  `LiveMcpRow`, unchanged, with their entity chips (task, lane, conversation)
  the same as everywhere. Prose is the feed's prose row with its avatar
  replaced by the outline mark and its text in `text-secondary` where the
  seat's is `text-primary`; on the phone its caption names the parallel self
  where the seat's rows name the engine. The streaming caret is drawn in
  `secondary` ink, so the accent caret belongs to the seat's own live turn.
  Nothing is dimmed by opacity: `text-secondary` clears the
  4.5:1 floor on every surface (§1.5), and a whole block at 60 % opacity
  would not. "Lighter" is the outline mark, the secondary ink and the dashed
  edge; "dashed" is the edge and the ring; "clearly the parallel self" is the
  caption.
- **Bound.** A live block shows at most `LIVE_TURN_VISIBLE_ROWS` in-flight
  rows plus the streaming prose; older steps fold into the feed's existing
  «N попередніх кроків» line. The canonical rows replace them as the ghost's
  transcript flushes, as they do for the seat.
- **No composer.** The ghost takes no second message. The block has no input;
  the seat's composer stays the one composer, and a message typed while a
  ghost runs goes to the seat as today (or, with «Запитати паралельно» again, to a
  new ghost once the first has ended, since slice 1 allows one at a time).

### 6.3 The ghost block, finished

When the record ends, the block collapses (200 ms, `--motion-base`) to its
head plus one line:

```
   │                        ┌──────────────────────────────────────┐
   │                        │ Add a task: reviewer for #2244 …      │
   │                        └──────────────────────────────────────┘
   ┆ ◌ Оркестратор · паралельне я · 12:41 · ✓ створив задачу «Reviewer for #2244» [T-318] · прив'язав до [#2244]   ▸
```

- The line starts with the participant's name, in the same words as the
  expanded caption: «Оркестратор · паралельне я» / "Orchestrator · parallel
  self" on the desktop, «Паралельне я» / "Parallel self" on the phone, where
  the ask's meta line right above already says «→ паралельне я».

- The line is `record.result.line`: the outcome as the note to the seat says
  it, in the UI language, with `touched` rendered as the same entity chips the
  MCP rows use (`describeMcpCall` links, `src/lib/mcp/presentation.ts`), so a
  task, a lane or a conversation the ghost touched is one click away. When the
  ghost only answered, the line is the first line of its final message,
  truncated at 120 characters, and expanding shows the whole answer.
- The chevron expands the block back to its full body (the canonical rows
  from the ghost's transcript); the state is per block and per mount, and a
  block the operator expanded by hand does not re-collapse. A block that
  ends while the pointer or focus is inside it waits until they leave before
  collapsing, so the answer is never pulled from under the reader.
- `timeout`, `host-died` and `seat-rotated` draw the line in the `warning`
  role with the outcome named («не встиг за 15 хв», «хост зупинився», «місце
  змінилось»), and the expanded body shows what the ghost had done. The text
  of such a line is the last thing the ghost said, often mid-sentence, so it
  is prefixed «останній крок:» / "last step:" in muted ink and reads as ended. A record
  with no transcript on disk expands to one quiet line saying the transcript
  was removed.
- The collapsed line stays in the feed for as long as the head does: it is
  the requirement's "small trace", kept where the ask was made. Nothing else
  lists it.

### 6.4 Desktop and phone

Both render the same rows; the differences are the ones §3.4 already fixes.

| | Desktop (1440, seat dock and conversation pane) | Phone (390) |
| --- | --- | --- |
| Head | user bubble at `BUBBLE_MEASURE`, sender line above at the same width | bubble at 86 % width, sender line 14 px avatar |
| Caption | in the `ml-9` chrome column; mark 16 px in a 20 px dashed ring | full width from the 12 px gutter; mark 16 px, ring 20 px; the line is 44 px tall as the tap target |
| Edge | 1.5 px dashed, in the avatar column, from caption to last row | 1.5 px dashed at the gutter, rows indented 12 px past it |
| Rows | `ToolLine` and `LiveMcpRow` as today; prose at `READING_MEASURE`, live and settled at the feed's 13 px | same rows, full width, prose at 15 px as the phone's own prose |
| Collapsed line | one line captioned «Оркестратор · паралельне я»; the result keeps its own width so the chips follow its last word (at most 12 px after it), chevron at the right | caption («Паралельне я») on the first line with the chevron, the result on up to two lines under it, the chips on the line after; the whole line is the target |
| Seat rows beside a block | the continuation line is the seat's only name (its rows show the avatar) | one name per row: the continuation folds into the prose row's own «Claude · 12:33» header; live prose at the settled row's 15 px |
| Collapse motion | 200 ms height, static under reduced motion | same |

Measurements the rendered evidence has to show (section 7): at 390 px the
caption's title keeps a `basis-[10rem]` so two chips wrap under it and the
title keeps its width (the `LiveMcpRow` rule, `LiveTurnRows.tsx:270-275`); the
collapsed line's expand target is 44 px on the phone and its result shows
whole in both languages; the chips of one block's MCP rows share a left edge
within 2 px; the chips read in the interface language; no row of the block
overlaps the seat's rows above or below while both stream; the dashed edge
spans exactly the block.

### 6.5 The seat head and the seat card

The feed is the ghost's home, so the head and the card carry only a pointer
to it. Desktop (`OrchestratorPanel.tsx:530-605`): while a ghost runs, the
seat's avatar gains the outline twin at its lower right (70 % size, 60 %
overlap, the same dashed ring as the caption's mark), and a chip in
`accent-soft` beside the state badge reads «паралельно · <ask, 40 chars>» with
a static dot; clicking it scrolls the feed to the block. When the ghost ends,
the twin and the chip go; the block's collapsed line is the trace. Phone
(`MobileSeatCard.tsx:55-125`): the mark gains the same twin and the now line
reads «працює · і паралельно: <ask>»; a tap opens the seat conversation, where
the block is. No second screen, no row in any list, no separate transcript
sheet.

### 6.6 Composer

"Ask in parallel" («Запитати паралельно») is a secondary action beside Send
in the seat composer's action menu, where steer already lives
(`TmuxComposer.tsx:4139`), enabled only while the seat is busy, with a one-line
hint the first time. Keyboard: `Ctrl/⌘+Shift+Enter`. The message leaves the
composer as any message does; its pending row retires when the route
acknowledges the record, and the block's head takes its place at the same
list position (the pending row was in the outbox tail section; the head is
placed by the rule in 6.1, which for a message sent "now" is the same spot).
In a team the head carries the member's sender line because the record
stores the sender the route resolved (PR #2243 stamps both send routes).

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
5. The ghost block in `LogFeed`: `deputies` in the seat read model and the
   prop path through `OrchestratorConversation` and `BranchPane`; a pure
   placement helper (block position from `startedAt` against the seat's
   rows, beside `tailOrder.ts`); the block component (head from the record,
   caption, dashed edge, live rows through a second runtime-session read and
   `LiveTurnRows`, canonical rows through a second `useLogTail` skipping
   `forkRecordCount`, the collapsed line with entity chips, expand and
   collapse); the outline engine mark. Desktop head twin and chip; phone
   seat-card twin and now line; composer action.

Not in slice 1: automatic trigger, Codex seats, several ghosts at once, the
Previous-seats trace list, the primed-fresh fallback, transcript retention
sweep (ghosts are few; add it with slice 2), and drawn blocks for the seat's
own answers or a second orchestrator (section 9).

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
- Block placement helper tests (pure, beside `tailOrder.test.ts`): a block
  lands after the last seat row dated at or before `startedAt` and after the
  undated rows that follow it; seat rows dated later stay below it; the
  position is stable when later rows arrive; two blocks sit in start order;
  an empty feed places the block first; a ghost whose transcript is missing
  still yields a head and a collapsed line.
- `LogFeed` DOM tests (the `conversationWindow` harness): with a live deputy
  the ask row, the caption and the ghost's live rows render inside one block
  keyed by the ghost's id while the seat's delta stays the last tail section;
  a canonical ghost row claims its live twin; rows before `forkRecordCount`
  never render; the block collapses on `endedAt` to `result.line` with one
  chip per `touched` id, and not while the pointer is inside it; expand
  restores the rows; `timeout` draws the warning tone; a feed with no
  deputies renders the same DOM as before.
- `OrchestratorPanel` and `MobileSeatCard` DOM tests for the twin mark, the
  chip that scrolls to the block, and the now line.
- Rendered evidence as one `describe` block in
  `src/components/kanban/kanbanBoard.browser.test.tsx` and one case in
  `src/components/mobile/issue1671Evidence.browser.test.tsx`, at 1440 px and
  390 px, in uk and en: a ghost running beside a main-seat turn, two
  interleaved blocks, and a finished collapsed block. Measured: the caption's
  title does not collapse beside two chips (`basis-[10rem]`); the collapsed
  line's target is 44 px on the phone; no ink of the block overlaps a seat
  row (union of text rects, clipped by overflow ancestors); the dashed edge
  spans the block's first to last row; every ask's meta line names the
  parallel self and the seat row after every block names the head it
  continues; the first chip sits at most 12 px after the result at 1440 and
  the result shows whole at 390; no row inside a block is captioned with the
  bare engine name on the phone; the chips of one block share a left edge;
  the uk chips are Ukrainian; the two live carets differ and the seat's live
  turn names its participant; the collapsed line names the ghost in the
  caption's or the ask's words; on the phone no seat row carries two speaker
  names, the seat's live turn is named what its settled rows are, and live
  and settled prose share one size. The PNGs go under
  `~/Pictures/delegatus-review/ghost-seat/`, never into the repository.
- `scripts/privacy-publication-gate.ts --base <merge-base>` before push.

Rollback: the deputy branch in attribution is behind the record's existence;
with no `deputies` entries every path is byte-identical to today.

### As built (slice 1)

The slice follows sections 4 to 7 with these differences, each recorded where
it lives:

- **The deputy record has a file of its own**, `state/orchestrator-deputies.json`
  (`src/lib/orchestrator/deputies.ts`). The seats reader refuses a schema it
  does not know, so bumping the seats file would make an older build read every
  seat as absent. ADR 0002 records the authority decision.
- **The record also keeps `forkBytes`**, the size of the copy. The canonical
  rows of a block come from `GET /api/orchestrator/ghost?askId=`, which reads
  the deputy's transcript from that byte offset. A second `useLogTail` cannot
  skip `forkRecordCount`: its window start counts from its own first read, from
  the end of the file, so it never knows a line's index in the file.
- **A fork or launch that never started ends as `failed`**, beside the four
  outcomes of section 5, so the seat is free for the next ask at once.
- **`ask.images` is a count.** The pictures go to the deputy's host with the
  ask; the record does not copy them.
- **The seat's `allowSubagents` is copied as it is.** The disallowed tools are
  part of the prompt's tool list, so forcing it off on a seat that allows it
  would miss the seat's cache.
- **Deputies reach the feed through a client store** the seat poll already
  fills (`src/components/orchestrator/seatDeputies.ts`), read by `LogFeed` for
  its own conversation, with an optional `deputies` prop for fixtures. Every
  surface that mounts the seat's feed draws the blocks without a prop threaded
  through it.
- **The sender line** draws when the record carries a sender. The team work
  (PR #2243) is not merged, so the route records none yet.

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
| Feed cost of the block | One more tail subscription and one more runtime-session read for the seat's feed while a deputy record is on screen; both are the feed's existing primitives, bounded by their caps (`TAIL_CAP`, eight live rows). With no deputies, no extra work. |
| Block scrambles the reader | Placement is computed once and pinned; rows carry `data-feed-key`; the block never becomes the tail. A growing block above the reader compensates like a reveal. |

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
- **Drawn blocks for the seat's own answers.** The model in 6.1 treats them
  as blocks, but drawing a caption and an edge on every seat answer adds chrome
  to the most-read rows in the product for no decision the operator makes
  today. Draw them when a second orchestrator shares the chat and the reader
  needs to tell two seats apart.
- **Several orchestrators in one conversation.** The block model and the
  placement rule already fit them (a participant key per seat, a caption per
  block); what is missing is the routing (which seat a message is for) and the
  read model (a conversation with more than one seat). That is a design of its
  own once the team work has landed.
- **A separate transcript sheet for the ghost.** The first draft opened the
  ghost's transcript in the conversation sheet; the operator's decision keeps
  everything in the one feed, and the expanded block shows the same rows.
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
the orchestrator": section 5's seat-ref exclusion and the collapsed line in
6.3, kept where the ask was made. "Shown beautifully, clearly as the
orchestrator's parallel self": 6.2, the seat's own mark in outline, the dashed
edge and the caption, in the seat's own feed.

The operator's decision on the draft: "in the seat's own conversation feed,
live, its messages and its tool calls": 6.1's live rows through the runtime
store and `LiveTurnRows`, 6.2's rows. "Lighter, dashed, clearly the parallel
self, not a separate sheet": 6.2 and the deferral in section 9. "Several
people and possibly several orchestrators, one conversation": 6.1's
participants and blocks, with the sender line from PR #2243 on every head.
"Each participant's turn its own block anchored at the message it answers,
streaming in parallel without scrambling": the placement and growth rules in
6.1. "A finished ghost block collapses to a one-line result with links,
expandable": 6.3. "Desktop and phone": 6.4. Nothing here adds a second seat,
a second queue, a second list, or a new process kind beyond the structured
host that already exists.
