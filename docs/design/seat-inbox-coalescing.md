# Seat inbox: what arrives while the orchestrator is busy reaches it as one message

## Originating requirement

The operator, 2026-10-16, dictated in Russian into the orchestrator seat's chat
(journal admission 13:10:27 UTC). The message opened with text the operator
pasted from the seat panel; the requirement is its closing paragraph,
verbatim:

> «Смотри, какая хуйня: я отвечал тебе на эти все, э-э, вопросы очень быстро. А
> ты их получил очень поздно, и только после того, как оркестратор ответил в
> самом конце каждый раз. Я думаю, что это неправильно. У нас должен быть
> общий... у нас должна быть общий буфер сообщения, который наполняется, у
> которого есть какой-то определённый размер, или таймер, по которому, вот,
> срабатывает цик-цик, или, э-э, или, например, как. Это я отвечаю на
> сообщение, то оно сразу может ставиться на в. На отправку, и если, например,
> до оркестратора это сообщение ещё не дошло, и как бы, как бы не прошло ещё,
> не прошла ещё отправка по какой-то причине, и мы можем дополнить её другими
> сообщениями, нужно в эту очередь положить новые сообщения. Всё, что
> касается... всё, что новое приходит. То есть, и всё это, ну, как
> конденсировать в одном сообщении. Ну, соответственно, там же есть лимит
> какой-то, его нужно проверить, но. Это всё должно быть не отдельными
> сообщениями приходить, а вот в тот момент, когда ему наконец-то дошло, чтобы
> туда пришло, ему сразу всё вместе. Сможешь как-то это продумать?»

In English: I answered all these questions very quickly, and you received them
very late, each one only after the orchestrator had replied at the very end.
That is wrong. There should be one shared message buffer that fills up, with
some size, or a timer that fires. When I answer, the answer is queued for
sending at once; if it has not reached the orchestrator yet, we can add other
messages to it. Everything new that arrives goes into that queue and is
condensed into one message. There is some limit, and it has to be checked. At
the moment the orchestrator can finally take it, everything arrives together.

**One difference from the brief.** The pinned specification says the six
answers were given "within about a minute each". The seat's decision records
say all six were decided within 9.3 seconds, 12:59:39.3–12:59:48.6 UTC (§2).
The design does not depend on the spacing.

**Reading of «конденсировать».** This design reads it as "put into one
message": each message keeps its exact words. Rewriting or summarising would
lose words the seat must act on (each of the six answers carried a 64-hex
digest the seat had to quote back to publish the right report). Summarising is
listed under Deferred.

## The result in one paragraph

On a Claude seat, every message that arrives while the seat is busy already
waits in one durable, ordered place: the runtime journal's queued operations
for the seat's conversation. The defect is the hand-over. A Claude seat takes one queued
operation per turn, because the delivery queue writes one input per engine
call and the next one waits for that turn to end. The design changes only
that hand-over: when the seat's turn ends, the queue hands every eligible
queued message to the seat as **one** user message, in the order they were
sent, each under a one-line header, within the same 32,000-byte bound that
every single message has today. Each message keeps its own operation, key and
receipt, and each settles `delivered` with the same turn. Operator chat rides
in the same combined message and never waits more than the remainder of the
turn that is running. Delivery still goes to the current seat only, through
the dispatch gate of the seat-single-channel design. Nothing changes in the
runtime host or the journal schema. Codex seats already take mid-turn messages
by steering and are left as they are. Worker and stage conversations are left
as they are: in seven days of records, 6 of 3,600 of their sends waited behind
another, against 122 of 1,883 on seats.

Contents: §1 prior work · §2 the 2026-10-16 records · §3 today's path for
every input (acceptance 1) · §4 engine limits · §5 the design (acceptance 2) ·
§6 seats only or every conversation (acceptance 3) · §7 operator decisions
(acceptance 4) · §8 build plan, tests and measurement (acceptance 5) ·
Deferred · §9 validation against the quote · §10 notes.

Every `file:line` is at `02f9301fc` (the base of this lane, main at its start).
Times are UTC on 2026-10-16 unless stated.

## 1. Prior work

- **Task 5ea0ff8f, #2694, #2741, #2742.** The operator asked on 2026-09-11 for
  native queued sending to Claude, "like Codex". #2694 enabled writing a
  follow-up to the Claude CLI's stdin during a turn. #2741 found that the CLI
  can combine two queued inputs into one replay frame with one canonical UUID,
  which left a phantom active turn in the broker; the containment set
  `supportsQueuedSend = false` (`src/lib/runtime/claudeStreamBrokerHost.ts:646-649`,
  `docs/verification/claude-queued-send-containment.md`). #2742 is open: it
  asks for an authoritative per-input identity before native batching returns.
  The design below does its own batching: Delegatus writes one input, so the
  CLI never has to combine anything (§5.6).
- **Active-turn steering** (`docs/design/active-turn-steering.md`, 2026-09-29).
  Agent and seat notices use `steer-or-queue`: on Codex they steer into the
  running turn, on Claude they wait in the Viewer's durable queue for idle.
- **Claude busy sends** (`docs/verification/claude-busy-send-no-interrupt.md`,
  2026-10-15). After the operator saw their extra instructions arrive as a tool
  rejection («Я просто пытаюсь отправить дополнительные инструкции… хотя я
  просто докидываю контекст», seat chat 2026-10-15 13:38 UTC), the Claude
  broker declared `sendWaitsForRunningTurn`
  (`src/lib/runtime/claudeStreamBrokerHost.ts:650-654`). An operator chat sent
  to a busy Claude seat now waits for the turn and starts the next one. The
  same document records that the CLI also accepts a frame mid-turn and adds it
  at the next model request, which #2742 keeps disabled.
- **Delivery state** (`docs/design/delivery-state.md`). Queued rows show in the
  composer's delivery disclosure; resolved receipts render nothing.
- **Seat single channel** (lane 95a3552c, `docs/design/seat-single-channel.md`
  on branch head `a36c4a7ff`, build stage running). Every delivery meant for a
  project's orchestrator resolves its target at dispatch to the current seat,
  with the verdict asked per effect in `drainTarget` and again at the engine
  call. §5.10 composes with it.
- Searches: `search_transcripts` project-scoped and unscoped in English and
  Russian ("coalesce queued messages into one turn seat busy batch",
  "несколько сообщений одним сообщением пачкой оркестратору", "The user doesn't
  want to proceed … interrupt operator message Claude busy"); `search_memory`
  ("queued messages batch one turn orchestrator interrupt claude busy"). No
  earlier design of coalescing exists. The hits were this lane, #2742's own
  work and the 2026-10-15 interrupt incident.

## 2. What happened on 2026-10-16, from the records

Sources, all read-only: the seat-decisions store in `state.sqlite` (decision
and dispatch times), the runtime journal's `operations` rows (admission and
terminal times, policy, key), `message_receipt` for each of the six operations
(phase history), and the seat transcript through `conversation_messages`. Ids
are shortened.

### 2.1 The six answers

| Form | Decided | Ingress | Journal admission | Dispatched | Engine echo | Decided → seat read |
|---|---|---|---|---|---|---|
| D | 12:59:39.336 | 12:59:39.490 | 12:59:43.775 | 13:06:52.622 | 13:06:55.079 | 7 min 15.6 s |
| C | 12:59:41.218 | 12:59:41.360 | 12:59:43.801 | 13:07:10.340 | 13:07:12.797 | 7 min 31.4 s |
| E | 12:59:43.251 | 12:59:43.437 | 12:59:46.309 | 13:07:25.328 | 13:07:27.516 | 7 min 44.1 s |
| B | 12:59:44.687 | 12:59:44.819 | 12:59:46.340 | 13:07:44.410 | 13:07:46.832 | 8 min 2.0 s |
| F | 12:59:47.057 | 12:59:47.217 | 13:00:40.317 | 13:08:13.313 | 13:08:14.912 | 8 min 27.7 s |
| A | 12:59:48.644 | 12:59:48.872 | 13:00:40.358 | 13:08:30.651 | 13:08:31.798 | 8 min 42.9 s |

Each was a `send` with policy `steer-or-queue` and key
`prototype-decision:<review id>` (`src/lib/prototypeReview/decision.ts:147-150`,
`:187`), 624–643 bytes of text, 3,813 bytes for all six.

### 2.2 The seat's timeline

| UTC | Record | What it shows |
|---|---|---|
| 12:58:30 | spawn notice "Agent finished: …" (`c42ae311`, admitted 12:58:17.7) starts a turn | the seat is busy until its last assistant record at 13:00:17 |
| 12:58:43–12:58:54 | the seat publishes the six forms A–F | |
| 12:59:39–12:59:48 | the six answers are decided and reach ingress | §2.1 |
| 13:00:01.2 | an operator chat message (composer, `interrupt-active`) is admitted | |
| 13:00:16 | the answers note `awaiting-turn` | the seat's turn is still running |
| 13:00:17–13:03:07 | the seat is idle; four answers and the operator chat are queued, F and A are still being admitted (13:00:40) | receipts show three cycles of `evidence-unreadable` ("the delivery journal could not be listed: runtime host request timed out") and `wake-lost`, 13:01:03–13:05:14. The Viewer was stalled; lane 035e847f investigates it |
| 13:03:07 | the operator chat from 13:00:01 is delivered first and starts a turn (to 13:04:01) | it passed the answers admitted before it (§3.2) |
| 13:03:44 | seat-tick wake admitted (`queue`) | |
| 13:03:51.7 | a second operator chat is admitted; delivered 13:04:39 (turn 13:04:32–13:06:13) | it also passed the answers |
| 13:06:52.6–13:08:30.7 | the six answers are dispatched **one per turn** | each turn ran 10–22 s; the gaps between a turn's last record and the next dispatch were 3.5, 4.4, 8.2, 17.4 and 6.2 s |
| 13:09:04 | the seat-tick wake from 13:03:44 is delivered | 5 min 20 s after admission |
| 13:09:17 | a deputy end note is delivered (admitted 13:09:05.9) | |
| 13:10:27 | the operator's requirement | |

Ten inputs reached ingress between 12:59:39 and 13:09:06 (six answers, two
operator chats, one seat-tick wake, one deputy note). The seat read them in
**ten turns**, 13:03:07–13:09:17; their journal receipts carry ten distinct
turn ids, each the operation's own id.

### 2.3 The same shape twice more the same day

- **12:24:26–12:26:13**, seven sends (two spawn notices, three form answers,
  two voice directives) were admitted within 1 min 46 s and delivered one at a
  time, each a separate send and so a separate turn (§3.2), from 12:25:05 to
  12:33:11. The last was read 6 min 57 s after its admission. (Journal rows
  read at about 13:30; the journal has compacted them since.)
- **11:54:51–11:54:52**, nine form answers were admitted to the seat of that
  time and waited `awaiting-turn`. All nine were failed at 12:04:59.6–12:05:02.2
  with "accepted for delivery but never executed; the delivery journal has
  fenced it…" (`SEND_LOST_REASON`, `src/lib/runtime/sendSettlement.ts:106-107`),
  deadline policy `settlement-window`, 10 min 7–10 s after admission. A send
  that rests longer than `SEND_SETTLEMENT_WINDOW_MS` (10 minutes,
  `sendSettlement.ts:136`) while its recipient's turn is not running is ended
  by the next receipt query (`sendSettlement.ts:595-607`, fenced at
  `:487-510`), and the form-answer worker queries every 3 s. A serial queue
  leaves exactly such idle moments between turns. The operator's retries of these
  answers are the messages that then reached a revoked seat (seat-single-channel
  design §2).

### 2.4 How often it happens

Read-only over the retained delivery-progress records (5,562 operations,
ingress 2026-10-09 13:44 → 2026-10-16 13:40 UTC). A conversation counts as a
seat when it received a seat-tick wake. A send "waited behind another" when it
reached ingress before the previous delivered send to the same conversation
was delivered.

| Conversations | Delivered sends | Waited behind another | Runs | Longest run | Ingress → delivered for those that waited |
|---|---|---|---|---|---|
| 38 seats | 1,883 | 122 | 62 | 14 | p50 123 s, p90 402 s, max 592 s |
| 3,239 others | 3,600 | 6 | 6 | 2 | |

## 3. Today's path for every input (acceptance 1)

### 3.1 Every kind of input that reaches a seat

"Waits" says where the message sits while the seat is mid-turn on a Claude
seat (the current seat is Claude Opus). Codex differences are in §3.4.

| Input | Producer and policy | Waits while the seat is mid-turn | Own turn because |
|---|---|---|---|
| Operator chat | composer, `interrupt-active` by default (`src/components/TmuxComposer.tsx:3595`, sealed to the runtime route at `:3622-3624`), admitted by `enqueueStructuredMessage` (`src/lib/runtime/structuredMessageDelivery.ts:1340`, policy default `:2056`) | journal row `queued`; the drain holds it because the host declares `sendWaitsForRunningTurn` (`src/lib/runtime/structuredDeliveryQueue.ts:1946-1948`) and the host is not idle (`:1986-1992`) | §3.2. It also jumps earlier follow-ups (§3.2, rule 3) |
| Form answers, first send | `decision.ts:147-150`, `steer-or-queue`, key `:187`; recipient chosen at `:286`, `:295`; a background worker sends, polling every 3 s while in flight (`src/lib/prototypeReview/deliveryWorker.ts:31`, `:165`) | journal row `queued`, `awaiting-turn` (`structuredDeliveryQueue.ts:1986-1992`) | §3.2 |
| Form answers, redelivery and Retry | `decision.ts:151-157` (`handleRuntimeRetry`, same key); seat succession `:349-362` | same | §3.2 |
| Seat-tick wakes (lane events, stage reports, worker asks, child terminals, PRs, deploys) | `src/lib/monitor/seatTickController.ts:1948-1951` (redispatch `:1133`), `queue`. Reasons: own lanes `src/lib/monitor/seatTick.ts:1341`, lane events `:1346`, worker asks `:1356` and `:1876`, child terminals `:1363`, stage events `:1906`; five items per wake (`:144`), the rest held back (`:1549-1558`) | the tick does not wake a seat whose turn is progressing (`seatTick.ts:56-60`); a wake already admitted waits as a journal row | §3.2. The wake itself is already a digest of many events |
| Voice directives (companion) | `src/lib/voiceCompanion/deliveryPaths.ts:34-39`, `steer-or-queue` | journal row | §3.2 |
| `bridge_directive` (voice gateway over MCP) | `src/lib/mcp/bindings.ts:3999`, `steer-or-queue` at `:4081` | journal row | §3.2 |
| Relays from other seats | `send_message_to_orchestrator` (`bindings.ts:5235`) and `send_message` with a relay project (`bindings.ts:1724-1731`) → `/api/orchestrator/message`, `steer-or-queue` (`src/app/api/orchestrator/message/route.ts:67`); linked-machine seat messages `src/lib/links/seatMessageDelivery.ts:41` | journal row | §3.2 |
| Worker asks | seat-tick items (above); a worker's own `send_message` (`bindings.ts:1709-1731`, `steer-or-queue`); `ask_orchestrator_in_parallel` answers through a deputy, whose end note is `src/lib/orchestrator/deputySweep.ts:114` (`steer-or-queue`) | journal row | §3.2 |
| Stage reports | `stage_report` settles the stage; the seat hears of it through seat-tick lane events (`seatTick.ts:1346`, `:1906`) | in the tick's agenda, then as one wake | the wake is one turn |
| Agent-finished notices | `src/lib/spawnNotice/sweep.ts:175-184`, `steer-or-queue` | journal row | §3.2 |
| Board report, auto-rotation nudge | `src/lib/orchestrator/boardReportRun.ts:68`, `src/lib/monitor/seatAutoRotation.ts:239`, both `steer-or-queue` | journal row | §3.2 |
| Telegram replies to seat reports | `src/lib/telegram/bot/reportReplies.ts:41`, `queue`, operator origin | journal row | §3.2 |

### 3.2 Why each one becomes its own turn on a Claude seat

1. **One engine call writes one input.** `ClaudeStreamBrokerHost.send` writes
   one stream-json `user` frame per `QueueEntry` and names the turn after the
   entry (`src/lib/runtime/claudeStreamBrokerHost.ts:994-1061`). The CLI's
   `result` ends that turn (`:1611-1640`).
2. **The drain hands over one entry, then waits.** The drain reads host health
   for each effect (`structuredDeliveryQueue.ts:1883-1889`). The first queued
   message on an idle host is sent (`:2185`) and starts a turn. The next effect
   reads a host that is no longer idle and stops at `:1986-1992`, and
   `blockRest` marks every later message `awaiting-turn`. The next pass runs
   when the turn ends, and takes one more. Because `supportsQueuedSend` is
   `false` (`claudeStreamBrokerHost.ts:649`), nothing is written to the CLI
   during the turn. This is deliberate (#2741 containment).
3. **Operator chat jumps the line as a turn of its own.** A queued
   `queue`/`steer-or-queue` message is held while a later operator
   `interrupt-active` send to the same conversation is still queued
   (`structuredDeliveryQueue.ts:1970-1985`). On a Claude host the operator's
   message does not replace any turn; it waits for idle and then starts its
   own turn first. On 2026-10-16 this put two operator chats, two turns, ahead
   of the six answers (§2.2).

### 3.3 What the existing queue already does

- **Durable and ordered.** Each input is one journal operation with one outbox
  row; the drain lists effects in `eventSeq` order and groups them per
  conversation (`structuredDeliveryQueue.ts:965-1060`). `delivering` is a
  compare-and-set from `queued`/`pending` (`:2054-2066`), so no executor can
  write a message twice.
- **Claude.** Follow-ups wait in the journal until idle; each is confirmed by
  its own replay echo (`claudeStreamBrokerHost.ts:1503-1530`) and completed by
  its own result. Operator chat waits for the turn (since 2026-10-15).
- **Codex.** See §3.4.
- **Receipts and UI.** Every operation has its own receipt, delivery-progress
  record and composer disclosure row (`docs/design/delivery-state.md`).
- **Seat ticks** already coalesce machine events: one wake carries up to five
  items and a count of the rest, and only one wake is outstanding per seat
  (`seatTickController.ts:745-931` retires older ones).

What is missing is a hand-over of several queued messages at once.

### 3.4 Codex seats

- `steer-or-queue` messages steer into a running turn (`turn/steer`,
  `structuredDeliveryQueue.ts:1919-1923`, `:2171-2183`). Codex drains all
  pending steered input before its next model request
  (`docs/design/active-turn-steering.md` §2.3), so messages that arrive during
  a turn already reach the model together, inside that turn.
- `queue` messages (seat-tick wakes, Telegram replies) become entries in
  Codex's own queue at admission (`src/runtime-host/journal.ts:763-773`).
  Codex starts exactly one queued entry per idle thread
  (`codex-rs/ext/queue/src/service.rs:405-470` at tag `rust-v0.162.1`, the
  installed `codex-cli 0.162.1`), so each still costs a turn.
- Operator chat interrupts a running Codex turn (`interrupt-active`, no
  `sendWaitsForRunningTurn`), which is the operator's stated preference for
  their own messages on Codex (#1629).

## 4. Engine limits, verified

| Bound | Value | Evidence |
|---|---|---|
| Delegatus text envelope per structured message | 32,000 UTF-8 bytes, enforced before storage | `src/lib/runtime/structuredContent.ts:35-40`, `:49-54` |
| Images per structured message | 16 images, 10 MiB each, 18 MiB raw in total, 24 MiB encoded per request | `src/lib/runtime/runtimeImageStore.ts:21-24` |
| Claude broker stdout frame | 24 MiB + 256 KiB; the CLI replays each input on stdout (`--replay-user-messages`, `claudeStreamBrokerHost.ts:882-883`) and a larger frame fails the host | `claudeStreamBrokerHost.ts:364-365`, `:1457-1462` |
| Claude Code CLI 2.1.296, one stdin frame | no limit found up to 8,388,608 characters | probe P below |
| Anthropic Messages API | 32 MB per request; 1M-token context for the Opus models; the seat's policy `claude-opus-1m` recommends rotation at 500,000 tokens | Anthropic API reference as bundled with Claude Code; `get_orchestrator` during this stage reported the seat at 503,307 tokens |
| Codex app-server, `turn/start` and `turn/steer` | 1,048,576 characters summed over all input items; refused with `input_too_large` | source at `rust-v0.162.1`: `codex-rs/protocol/src/user_input.rs:10`, `codex-rs/app-server/src/request_processors/turn_processor.rs:503-521`, `:572`; the refusal text is present in the installed binary |

**Probe P** (2026-10-16 about 13:45 UTC). The installed Claude Code 2.1.296 ran
with `-p --input-format stream-json --output-format stream-json --verbose
--replay-user-messages`, a private HOME, Claude config directory, TMPDIR,
XDG_CONFIG_HOME and LLV_STATE_DIR under this stage's scratch directory, a
synthetic credential, non-essential traffic disabled, and `ANTHROPIC_BASE_URL`
on a loopback server on port 0 that answered every `/v1/messages` call with a
one-line stream. No account, credential store or external service was
contacted. The probe stopped its own child by the PID it recorded.

| Case | Written | Observed |
|---|---|---|
| A | one frame, three text blocks, 30,021 characters | one model request (99,203 bytes) whose last user message held the three texts plus one block the CLI adds; one `result`; one replay echo carrying the three blocks |
| B | one frame, 1,048,576 characters | the text reached the model request intact (1,110,218 bytes); before it the CLI sent a separate request carrying a 6,361-character instruction that begins "CRITICAL: Respond with T…" (inferred: its own context compaction, since the fixture model id was unknown to it); one `result` |
| C | one frame, 8,388,608 characters | intact (8,450,250-byte request); one `result` |

Conclusions used below:

- A combined message is one stdin frame with several content blocks, and the
  CLI treats it as one user turn with one replay echo and one result (case A).
- Neither engine limits the combined message near the sizes that occur. The
  binding bound is Delegatus's own 32,000 bytes (§5.5). Large inputs do cost the
  seat context, and case B shows the CLI reaching for compaction.

## 5. The design (acceptance 2)

### 5.1 The inbox is the queue that exists; the change is the hand-over

The per-seat inbox the operator describes is the set of journal operations
queued for the seat's conversation. It is already durable, ordered, fenced
against double delivery and visible in the UI. A second store would duplicate
all of that. The change is in `drainTarget`: on a coalescing host, when the
seat is idle, the drain hands over the whole run of eligible queued messages in
one engine call.

### 5.2 Which messages join

A queued effect joins the hand-over when all hold:

- the target conversation is the **current seat** of a project (§6). The
  in-memory index #2952 built for `orchestratorRecipientRefusal` already holds
  each conversation's `activeSeatEpoch` and `revokedSeatEpoch`
  (`src/lib/orchestrator/seats.ts:216-221`) and is read with one `stat` and one
  map lookup (`:1433-1446`); a small accessor answers "active seat" from it,
  never with a file read per pass. An index that is not ready joins nothing,
  and delivery falls back to today's one-by-one;
- the host declares a new capability `coalescesQueuedInput` (only
  `ClaudeStreamBrokerHost`);
- `kind: "send"` with policy `queue`, `steer-or-queue`, or `interrupt-active`
  on a host that waits for the turn (`structuredDeliveryQueue.ts:1946-1948`);
- no `onlyIfIdle` fence (restart continuations stay alone, as today) and no
  named `turnId` fence;
- the effect passed every per-effect check the drain already makes before the
  `delivering` transition: update hand-off, retired conversation, account
  switch hold, kill boundary, host health, and the seat verdict of §5.10.

Injections, explicit steers, controls and native-queue commands never join.
They keep their own paths and their positions in the drain.

### 5.3 When the combined message goes

Today's drain is already woken by the turn-ended event, so the hand-over
happens at the first pass after the seat's turn ends. A message that reaches an
idle seat goes at once, alone, exactly as today; messages that arrive during
that turn go together at its end.

A size bound decides how many messages go; it never triggers one. On Claude,
anything written during a turn either interrupts it (read as a tool refusal,
2026-10-15) or needs the #2742 identity work (§5.9).

A gather timer is an operator decision (§7, Q1). The recommendation is no
timer: the 2026-10-16 bursts all arrived while the seat was busy, an idle-seat
burst costs at most one extra turn (the first message alone, the rest
together), and a timer delays every lone operator message.

### 5.4 Composition, order and dedup

- **Order.** Journal `eventSeq` order, which is the order of admission, the
  order the drain already uses. Operator chat keeps its chronological place:
  being in the same message is what keeps it from waiting (§5.8).
- **One frame, one part per message.** The combined input is one stream-json
  `user` frame. For each message, in order: a header text block, the message's
  images, the message's own text block. The text is each message's exact text.
- **Headers** (agent-facing, written by Delegatus, one short line each):

  ```
  [Delegatus] 6 messages arrived while you were working. They follow in the order they were sent.
  [1/6 · from the operator · sent 12:59:39 UTC]
  ```

  The author label comes from the admitted `origin`: the operator (a member
  acting as operator counts as the operator), an agent with its role, or a
  Delegatus role such as the seat tick. The time is the receipt's
  `admittedAt`. The header sits in its own text block; a message whose own
  text begins with the header pattern gets a leading quote mark, so a sender
  cannot forge a header for another author.
- **Dedup.**
  1. The same idempotency key is one journal operation already; a replay never
     adds a second member.
  2. Seat-tick wakes: the tick keeps one outstanding wake per seat and retires
     older ones (`seatTickController.ts:745-931`), and lane 95a3552c withdraws
     a revoked epoch's wake. A combined message therefore carries at most one
     wake.
  3. Two members with the same origin and the same content digest: the later
     one is carried as its header plus "same text as 2/6". Both settle
     `delivered`.

### 5.5 Size bound and overflow

- **Bound per combined message:** 32,000 UTF-8 bytes of text, headers
  included; at most 16 images, 18 MiB raw. These are today's per-message
  bounds (§4), so a combined message is never larger than a single message the
  seat already accepts. Codex accepts 1,048,576 characters and the Claude CLI
  passed 8,388,608; the bound is kept for the seat's context (case B) and the
  broker's stdout frame.
- **Past the bound:** members are packed in order, each combined message as
  full as the bound allows. Filling in order this way gives the fewest
  messages possible while keeping order. Members that do not fit stay `queued`
  and lead the next combined message at the next turn end, with whatever
  arrived meanwhile.
- **A member too large to share** (its text plus a header over 32,000 bytes)
  goes alone with no header, exactly as it would today.

The observed bursts were 3,813 bytes (six answers), 7,522 bytes (the 12:24
wave) and, with the two operator chats, the seat tick and the deputy note of
13:00–13:09, 9,182 bytes. Each fits in one message.

### 5.6 Per-message identity and receipts

The order of steps for one hand-over, inside the conversation's existing lane:

1. Each member passes its own `queued → delivering` compare-and-set
   (`structuredDeliveryQueue.ts:2054-2066`), with its own progress phase. A
   member whose transition fails (settled, withdrawn, taken by another
   executor) drops out before anything is written.
2. The queue composes the batch from the members that transitioned: id
   `inbox_<first 32 hex of sha256 of the member operation ids in order>`, text,
   images, and a part layout (operation id, origin, text range, image count per
   member).
3. A new controller port `bindDeliveryBatch(batchId, members)` records the
   membership on each member's delivery record through the registry's off-loop
   writer, next to `bindDeliveryGeneration` (`structuredDeliveryQueue.ts:2040-2052`,
   `src/lib/runtime/structuredDeliveryController.ts:930-935`). If it cannot be
   written, every member goes back to `queued` and nothing is sent.
4. One `host.send(batchEntry)`. The broker records the entry and its part
   layout in its delivery ledger and writes one frame.
5. One receipt settles every member through the existing `settleSendOutcome`
   (`structuredDeliveryQueue.ts:2215-2304`): `delivered` with the batch's turn
   id. The Claude broker confirms the batch by its replay echo, whose content
   digest is the batch's (`claudeStreamBrokerHost.ts:535-569` joins text
   blocks and collects images in order, so the per-part layout does not change
   the digest).

This differs from #2742's native batching. There the CLI combines several
inputs it was given separately, and the broker cannot tell which echo belongs
to which input. Here Delegatus writes one input, the CLI echoes that input,
and the membership was recorded before the write. No text match ever confirms
a member.

Each member keeps its operation id, idempotency key and receipt:
`message_receipt` answers `delivered` for each, the form-answer worker sees
`sent` (`decision.ts:76-81`), the spawn-notice sweep sees its notice
delivered, and the seat tick sees its wake delivered. Delivery progress shows
"handed over in one message with N others" on each member.

### 5.7 Failure and recovery

| Outcome of the one host call | Every member |
|---|---|
| refused before any write (`stale-turn`, `dead-host`, a refusal from `authorize`) | back to `queued`, as for a single send today (`structuredDeliveryQueue.ts:2277-2292`) |
| refused for a reason that fails a single send | that same terminal state |
| thrown after the write, outcome unknown | `uncertain` through `terminalizeUnverified` (`:2271`); absorbing, never resent |
| Viewer restart while members are `delivering` | the existing reconciliation of `delivering` rows, keyed by the batch binding: the broker ledger shows the batch confirmed → all `delivered`; otherwise all `uncertain` |

The blast radius of an unknown outcome grows from one message to the batch.
The same evidence that settles one message settles the batch, and an
`uncertain` member answers `resend: "verify-first"` as today.

### 5.8 Priority: operator chat

An operator chat that arrives during a turn joins the next combined message,
at its chronological place, and is read when the running turn ends. The worst
wait is the remainder of one turn; it never waits behind other queued
messages, because they all go in the same turn. On a coalescing host the hold
of `structuredDeliveryQueue.ts:1970-1985` is no longer needed and is skipped:
it exists so that an operator replacement leads, and here nothing is replaced
and nobody is behind anybody.

Interrupting the turn is excluded by the operator's own words of 2026-10-15
(their extra instructions were read as a cancellation). The explicit Stop
control is unchanged.

### 5.9 Mid-turn steering

- **Codex seats:** unchanged. Steering already puts every message that
  arrives during a turn into that turn, at the next model request, which is
  earlier than any turn-end hand-over could be.
- **Claude seats, this design:** the combined message goes at turn end.
- **Claude seats, a possible phase 2** (operator decision Q2): write the
  current combined message into the running turn once, as one frame; the CLI
  adds it at the next model request ("The user sent a new message while you
  were working", observed 2026-10-15). At most one such frame per turn; the
  rest waits for the next. This needs the broker to own a turn by its result
  boundary with two inputs inside it, which is the #2742 work and the failure
  #2741 contained. It is a separate lane, built and tested against #2742's
  acceptance list, and it changes nothing in §5.1–§5.8.

### 5.10 The current seat only

Batching composes with the seat-single-channel design (lane 95a3552c):

- the seat verdict is asked per member at the drain, before its `delivering`
  transition; a member for a revoked seat never joins and is withdrawn and
  redirected by that design's rotation pass;
- `authorize()` runs once at the engine call for the batch; a revocation
  landing between composition and the write sends every member back to
  `queued`, and the rotation pass then moves them;
- messages the rotation pass redirects to the new seat are new operations
  queued at that seat, and join its next combined message.

The build of this design lands after lane 95a3552c's build, because both edit
the dispatch region of `drainTarget` (§8, step 0).

### 5.11 What the operator sees

- **The seat's feed** shows each message as it does today: its own bubble, its
  own author, its own text. The transcript row is one user record; the broker
  ledger's part layout lets `claudeMessageProvenance`
  (`src/lib/runtime/claudeMessageProvenance.ts`) return one author per part,
  and the feed parser splits the row at the recorded ranges. Without the
  split, the row would be attributed as one author and an agent relay could
  read as the operator's words (#1117). The headers are agent-facing and are
  not rendered.
- **The composer disclosure** keeps one row per queued message; they resolve
  together.
- **Timing** is the visible change: answers given during a turn appear
  together at the start of the next one, and the seat answers them in one
  reply.

No new control, label or panel.

### 5.12 Hot path

The hand-over runs inside the conversation's existing delivery lane and adds
one composition (linear in the members) and one registry write per combined
message, through the off-loop writer. The eligibility check is a map lookup.
Per project rules, any new asynchronous step is labelled for the loop monitor
(`delivery.inbox-batch`). No speed claim is made.

## 6. Seats only, or every conversation (acceptance 3)

**Recommendation: seats only.**

- The requirement names the orchestrator.
- The need is concentrated there: 122 of 1,883 seat sends waited behind
  another in seven days; 6 of 3,600 sends to 3,239 other conversations did
  (§2.4).
- Stage conversations carry pipeline-owned turns: severed-turn continuations
  sent with an idle gate (`src/lib/pipelines/engine.ts:1973-1990`, `:2928-2932`)
  and stage settlement read from turn boundaries. Merging a pipeline
  continuation with a seat note would change what a stage turn is, for a case
  that occurs about once a day.

The gate is one predicate (the seat index), so widening later is a one-line
change after the seat measurement in §8 holds.

## 7. Decisions for the operator (acceptance 4)

The design is complete on the recommended answers; each answer changes a
parameter or adds a lane. Short options for one decision form, each with
"Other" allowed:

**Q1. When does the combined message go?**
- a) When the orchestrator finishes its current turn; no timer *(recommended)*
- b) Also wait 3 seconds when the orchestrator is idle, so a quick series
  arrives together (every lone message is 3 seconds later)

**Q2. A message that arrives while a Claude orchestrator is working:**
- a) Goes in the combined message at the end of the current turn *(recommended
  now)*
- b) Also give it to the orchestrator during the turn, as added context, the
  way Codex already works (a separate lane after the Claude identity work,
  #2742)

Interrupting the turn is not offered: on 2026-10-15 the operator asked for
added instructions not to be read as a cancellation.

**Q3. Who gets combined messages?**
- a) Orchestrators only *(recommended)*
- b) Every agent, workers and stages included

The size limit needs no decision: §4 gives the numbers, and §5.5 keeps today's
per-message bound.

## 8. Build plan (acceptance 5)

### Step 0. Base and neighbours

Rebase on main after lane 95a3552c's build merges (it edits the dispatch
region of `structuredDeliveryQueue.ts`, `structuredDeliveryController.ts:973-980`,
`sendSettlement.ts` and `decision.ts`). Recheck the open diffs of lanes
1b51a08a (`structuredDeliveryController.ts`, startup) and d4d6f817 (Codex host,
Claude broker tests) before touching those files. Nothing here touches
`src/runtime-host/**`, `bin/**` or the `Dockerfile`; if a step turns out to
need the journal, stop and say so, because the runtime host takes three review
rounds.

### Step 1. Tests first, red on main

All by explicit path through `scripts/gate-slot.sh`, each with a private HOME,
XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR`, and `LLV_VIEWER_CONTROL_URL` on a
closed port.

1. **The acceptance case** in `src/lib/runtime/structuredDeliveryQueue.test.ts`:
   a host declaring `sendWaitsForRunningTurn`, `supportsSteer: false`,
   `supportsQueuedSend: false` and `coalescesQueuedInput: true`, a seat
   conversation, a running turn; admit six `steer-or-queue` answers, an
   operator `interrupt-active` chat and a seat-tick `queue` wake; end the
   turn. Expect one `host.send` with eight parts in admission order, eight
   receipts `delivered` with one turn id, and no interrupt. **Red on main:**
   eight sends, eight turns, and the operator chat first.
2. **The real CLI**, a new mode in the opt-in
   `src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts` (its loopback
   harness, `:14-104`, is the probe of §4): hold the first turn's response,
   admit six messages through the real journal and queue, release. Expect two
   user turns in total, two `result`s, one replay echo with the six parts, six
   receipts `delivered`, zero `interrupt` control requests. **Red on main:**
   seven turns.
3. **Bounds:** three 15,000-byte members → two combined messages, the third
   waiting for the next turn end; 17 one-image members → 16 and 1; one
   31,990-byte member goes alone without a header.
4. **Failures:** a refusal before the write → all `queued`; a throw after the
   write → all `uncertain` and no second write; one member's `delivering`
   compare-and-set lost → excluded; `bindDeliveryBatch` unwritable → nothing
   written, all `queued`.
5. **Restart:** members `delivering` with a binding; a ledger with the batch
   confirmed → all `delivered`; without → all `uncertain`.
6. **Dedup:** two members with the same origin and digest → the second carried
   as a reference, both `delivered`.
7. **Scope:** a non-seat conversation with three queued sends → three turns,
   as today; a Codex seat → steering unchanged; an unknown seat index →
   one-by-one.
8. **Current seat:** with lane 95a3552c's gate, a revocation between
   composition and the write → all `queued`, nothing written.
9. **Feed:** `src/lib/runtime/agentRecordAuthors.test.ts` and the provenance
   tests return one author per part; the parser test splits the row.

### Step 2. The composer

New `src/lib/runtime/inboxBatch.ts`, pure: eligibility of a run, ordered
packing within the bounds, headers and their escaping, dedup, batch id, part
layout. Unit tests beside it.

### Step 3. The host

`src/lib/runtime/engineHost.ts`: the `coalescesQueuedInput` capability and an
optional `parts` layout on `QueueEntry`. `src/lib/runtime/claudeStreamBrokerHost.ts`:
write the blocks per part, record the layout in the ledger, confirm by the
batch's echo as today.

### Step 4. The queue

`src/lib/runtime/structuredDeliveryQueue.ts`, `drainTarget`: accumulate members
that passed their checks and transitions, flush at the first ineligible effect
or the bound, settle every member from the one receipt; skip the operator hold
of `:1970-1985` on a coalescing host. `structuredDeliveryController.ts`: the
seat predicate and `bindDeliveryBatch` port; the registry writer beside
`bindDeliveryOperationGenerationOffLoop` in `src/lib/agent/registry.ts`.
Delivery progress: the "handed over with N others" detail.

### Step 5. Attribution

`src/lib/runtime/claudeMessageProvenance.ts`, `agentRecordAuthors.ts` and
`src/components/feed/parse.ts`: per-part authors and the split.
`conversation_messages` keeps one record per transcript row and adds the
per-part authors to it.

### Step 6. Checks and rendered evidence

Touched test files by path; `bunx tsc --noEmit`; changed-file ESLint; the
privacy gate from the merge base. Rendered evidence through the existing
conversation-window driver
(`src/components/conversation/conversationWindow.browser.test.tsx`), one
`describe` block: a seat transcript with one combined row of an operator chat,
two form answers and an agent relay renders four bubbles with their authors,
in en and uk, light and dark, at desktop width and 390 px. No new driver.

### The measurement that proves it

Both numbers come from records that already exist; the procedure is a
read-only query, run the same way before and after.

- **Turns per N inputs.** For each run of sends that waited behind another on
  a seat (§2.4's definition), count the distinct receipt turn ids. Main on
  2026-10-16: the ten inputs read 13:03:07–13:09:17 carried ten turn ids; the
  12:24 wave, seven inputs, seven sends. Acceptance: inputs that wait through one turn
  share one turn id per bound-sized message.
- **Latency from send to seat read.** Ingress (delivery progress `ingressAt`)
  to engine echo (`engineEchoAt`). Main: §2.1 (7 min 15.6 s to 8 min 42.9 s,
  of which about 2 min 50 s was the Viewer stall) and §2.4 (p50 123 s, p90
  402 s, max 592 s for 122 sends over seven days). Acceptance: within one
  combined message, the last member's latency exceeds the first's only by
  their difference in ingress time; the seven-day p90 is reported against
  402 s, with the deploy, the load (seat count and sends per day) and the
  window stated beside it.
- **Replay estimate (inferred from the 2026-10-16 records).** On the same
  timeline with the stall unchanged, the first pass that could deliver
  (13:03:07) would have handed over the 13:00:01 chat and the six answers as
  one message: the answers read 3 min 20–30 s after they were given, and the
  ten inputs of §2.2 in about three turns.

## Deferred — not currently justified

- **A gather timer at an idle seat** (Q1-b). Adds latency to every lone
  message to save at most one turn per idle-seat burst.
- **Claude mid-turn delivery** (Q2-b). Needs #2742's identity and
  result-boundary work.
- **Worker and stage conversations** (Q3-b). 6 waits in 3,600 sends; pipeline
  turn accounting at stake.
- **Codex idle batching** (one `turn/start` with several items). Steering
  already joins messages into the running turn; the idle case is rare.
- **Codex `queue` messages through steering** (seat-tick wakes, Telegram
  replies). Deferred by `docs/design/active-turn-steering.md` §6 for the
  tick's fence accounting.
- **Cross-producer duplicates**: a form answer carried both as a message and
  as a "saved operator answer" item of a seat-tick wake (#2957), or a child's
  "Agent finished" notice and the tick's child-terminal item. Their contents
  differ, and settling which copy wins belongs to those producers.
- **Summarising or rewriting messages.** The seat must act on exact words.
- **A larger bound for combined messages.** Today's bound already holds every
  observed burst, and a larger input costs the seat context.
- **A separate inbox store.** The journal already is one.
- **The Viewer stall of 13:00:17–13:03:07** (lane 035e847f) and **the
  10-minute settlement window** (§2.3). Coalescing shortens the tail that
  exposed answers to the window; the window itself is unchanged.

## 9. Checked against the requirement

| The operator's words | Where the design meets them |
|---|---|
| «я отвечал… очень быстро. А ты их получил очень поздно… только после того, как оркестратор ответил в самом конце каждый раз» | §3.2 names the cause; §5.3 hands over everything queued at the first turn end; §8 measures it |
| «общий буфер сообщения, который наполняется» | §5.1: the seat's queued journal operations, with everything new appended in order |
| «у которого есть какой-то определённый размер, или таймер» | §5.5 (size: 32,000 bytes, fewest messages past it); §5.3 and Q1 (timer) |
| «если… до оркестратора это сообщение ещё не дошло… мы можем дополнить её другими сообщениями» | §5.2: every message still queued joins the next hand-over |
| «всё это… конденсировать в одном сообщении» | §5.4: one user message, each message's exact words under its own header |
| «там же есть лимит какой-то, его нужно проверить» | §4: verified numbers for Delegatus, the Claude CLI and API, and Codex |
| «в тот момент, когда ему наконец-то дошло… ему сразу всё вместе» | §5.3 and §5.6: one engine call, one turn, every receipt settled together |

## 10. Notes

- **Two forms with identical answers** (13:17:20 and 13:18:47) were two rounds
  the seat published twice, so they are different messages and are not
  deduplicated.
- **The seat-tick wake read at 13:09:04 was prepared at 13:03:44.** A combined
  message brings stale wakes forward but does not refresh them; the header's
  time shows their age.
- **Codex native-queue claim** rests on the source at the installed tag; no
  Codex probe was run for this design.
- **Evidence made from:** worktree base `02f9301fc`; live records read
  read-only (no writes, no test sweeps) on 2026-10-16 13:20–13:50 UTC; the
  probe in the stage's scratch directory, removed with it. Main has since
  moved three commits, to `7b9a0f863` (#2966, #2969, #2968); none of them
  touches a file cited here by line.
