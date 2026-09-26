# Parallel intake for the orchestrator seat: many asks at once, none lost

## Originating requirement

Operator request, 2026-09-26 06:33Z, dictated into the Delegatus project's
orchestrator seat chat (epoch 212) and pinned to this lane (paraphrased in
English):

> One more feature. It is inconvenient that one orchestrator can only take one
> request from me at a time. It will get worse once team work starts. Even now,
> when I want to throw in many tasks, I need the orchestrator to keep working
> while I ask it other things in parallel, without it forgetting the earlier
> ones. And the new things should start in parallel so no time is lost. Not
> necessarily started: at least an issue or a task should be created. Ask Fable
> how best to do this and tell me what he thinks.

Every `file:line` below is at main `b7708903d`. Nothing but this document was
written by this stage: no code, no test, no state, no issue.

## Decision in one paragraph

The seat does not lose asks because it is slow. It loses them because every ask
sent to a busy seat **interrupts the running turn**. That is the default of the
composer, of `send_message_to_orchestrator`, of the bridge directive and of the
seat tick's own wake, and the delivery queue already knows a second policy,
`queue`, that holds a message until the host is idle and then delivers it in
order. The recommendation is to make `queue` the delivery policy for every
message addressed to a designated seat, keep the existing stop button as the one
explicit interrupt, and show each waiting ask in the composer with its place in
line. That is a one-week slice with no new process, no new store and no second
queue. The second slice makes intake visible and checkable: an "asks" projection
over the receipts the Viewer already keeps, so the composer and the seat card
say for each ask whether it is waiting, in work, captured on the board, or
answered without a task. An intake agent beside the seat, several seats per
project and per-person threads are not justified by the requirement and are
listed under deferred with the reason.

## 1. How an ask reaches the seat today

| Entry | Path | Policy at delivery | What the seat sees |
| --- | --- | --- | --- |
| Composer on the seat card | `queueSubmit` in `src/components/TmuxComposer.tsx:2589` puts the draft in the client outbox first (`src/components/conversation/outbox.ts:5-19`), then sends with `policy = options?.policy ?? "interrupt-active"` (`TmuxComposer.tsx:2721`). The only other policy the composer can send is `steer-if-active`, offered by the steer action (`TmuxComposer.tsx:4139`), and a Claude host refuses it (`claudeStreamBrokerHost.ts:566` declares `supportsSteer = false`). | interrupt-active | A user message; if a turn was running, `[Request interrupted by user]` first. |
| `send_message_to_orchestrator` (any agent, the voice gateway) | Resolves the seat and calls the plain send (`src/lib/mcp/bindings.ts:3764-3813`). The schema carries no policy (`src/lib/mcp/server.ts:3754-3759`), so the structured request falls to the default `interrupt-active` (`src/lib/runtime/structuredMessageDelivery.ts:192`, `:1250`). | interrupt-active | Same. |
| `bridge_directive` (voice gateway) | An ordinary `send_message` with a derived id (`src/lib/bridge/directive.ts:1-45`); no policy field (`server.ts:3730-3737`). | interrupt-active | Same, with a `[bridge ref=N]` trailer when it answers a report. |
| Seat tick wake | `deliverConversationMessage` (`src/lib/monitor/seatTickController.ts:1213`, `:1496`) enqueues a structured send with no policy (`src/lib/delivery.ts:735-737`). The tick is meant to skip a seat whose turn is progressing (`src/lib/monitor/seatTick.ts:342-353`), but that check reads the registry, and the transcripts below show six wakes that landed as interrupts anyway. | interrupt-active | `Seat tick — <project>. Why you were woken: …`, once per wake, at most one wake per interval. |
| Worker results | Never a direct message: a lane's outcome reaches the seat as an item in the next wake. | n/a | Inside the wake. |

What the delivery queue does with a running host, per policy
(`src/lib/runtime/structuredDeliveryQueue.ts:1135-1150`):

- `interrupt-active` with an active turn: interrupt that turn, wait for idle,
  deliver as a new turn.
- `steer-if-active`: join the running turn on Codex (`codexAppServerHost.ts:1279`);
  refused on Claude with `unsupported-steering` (`structuredDeliveryQueue.ts:1131-1134`).
- `queue`: hold the message, come back on the next pass, deliver when the host
  reads idle. Messages of one conversation are held in event order, so a
  backlog drains oldest first, one turn per ask. The policy is accepted by the
  runtime command parser (`src/lib/runtime/commands.ts:169`) and the runtime
  HTTP route (`src/lib/runtime/http.ts:309`). No caller sends it today.

The composer already renders a held send: the amber `queued` receipt state
(`TmuxComposer.tsx:1461-1468`) and the `очікують: N` counter over pending
receipts (`TmuxComposer.tsx:621`, `src/lib/i18n/uk.ts:2620`).

## 2. What the seat transcripts show

Method: the five most recent seat transcripts of this project (epochs up to 212,
2026-09-23 05:37Z to 2026-09-26 06:33Z) were read from disk with a scratch
script. A user record that is not a tool result is an incoming message; it is
an operator ask unless it starts with `Seat tick`. An ask "interrupted a turn"
when the record before it is a tool result, an assistant record whose stop
reason is not `end_turn`, or a `[Request interrupted by user]` marker. Turn
length is the time from the message to the next assistant `end_turn`. Bursts
count asks that arrived within five minutes of the previous ask.

| Seat window (Kyiv day) | Operator asks | Wakes | Asks that interrupted a turn | Wakes that interrupted a turn | Asks within 5 min of the previous | Reply p50 / max (s) |
| --- | --- | --- | --- | --- | --- | --- |
| 23.09 08:37 – 24.09 15:26 | 76 | 36 | 4 | 3 | 27 | 43 / 573 |
| 24.09 15:32 – 25.09 01:17 | 31 | 17 | 5 | 1 | 17 | 66 / 168 |
| 25.09 01:22 – 08:51 | 12 | 15 | 1 | 1 | 2 | 82 / 150 |
| 25.09 08:52 – 22:32 | 10 | 28 | 2 | 0 | 4 | 86 / 444 |
| 25.09 22:33 – 26.09 09:33 | 17 | 19 | 2 | 1 | 7 | 41 / 121 |
| **Total** | **146** | **115** | **14 (10 %)** | **6** | **57 (39 %)** | |

Turn lengths over the same five seats, from any incoming message to the seat's
`end_turn`:

| Turns | n | p50 | p75 | p90 | max |
| --- | --- | --- | --- | --- | --- |
| started by an operator ask | 133 | 54 s | 87 s | 150 s | 573 s |
| started by a wake | 111 | 60 s | 108 s | 172 s | 1570 s |

Four episodes, all in the seat chat, that show what the numbers mean:

- **24.09 21:31Z.** The operator asks whether the request to launch a critic
  reached the agent. The seat answers that nothing reached the agents and that
  it misread the earlier ask; then, corrected, it discovers it had answered
  about the wrong lane. One ask, two turns, one wrong critic launched and
  stopped.
- **24.09 22:13Z – 22:21Z.** Two asks 71 seconds apart (a prompt rule about
  task colours, then card ordering on the desktop). The second interrupts the
  seat mid-turn on the first. Seven minutes later a third ask interrupts a
  push the seat was doing for a stage skip. All three were eventually handled,
  each after its own interruption.
- **25.09 01:05Z.** The operator's own words: do the tasks you were doing
  above, if I interrupted you and you did not finish. The seat lists four
  unfinished tails and picks them up. A wake interrupts that turn 53 seconds
  in.
- **26.09 08:13Z – 08:18Z.** A 6 500-character ask to launch the sign-in lane.
  The seat spends two minutes on unrelated checks, creates four tasks at
  08:15, launches the lane at 08:17:15, and is interrupted by the next ask at
  08:17:20 before its second launch. It recovers in the following turn. When
  the originating request of this document arrived at 09:33Z, the seat's first
  tool call was `create_task`, 13 seconds after the message.

Two conclusions the numbers support:

1. **Interruption, not waiting, is the loss.** The seat answers an ask in
   under a minute at the median because it delegates; the operator rarely waits
   long. But one ask in ten cuts a running turn, a wake does the same six times
   in three days, and the transcript then depends on the model noticing what it
   was doing. The operator has already had to say "finish what I interrupted".
2. **Bursts are the normal case.** Four asks in ten arrive within five minutes
   of the previous one. Any design that treats the second ask as a correction
   of the first is wrong most of the time.

## 3. Prior work to build on or retire

- **`docs/design/command-intents.md`** ("accept at once, run from a queue") is
  about *mutations* answering `busy` while a pipeline lease is held, with slice
  1 merged behind `LLV_PIPELINE_ACTIVATION_DRAIN` (board task "Команди без
  «busy»", `af91d17a`). It explicitly defers a second message queue and says
  the existing delivery queue is the executor for sends (its "Runtime,
  messages, seats" row). This document agrees: the message queue already
  exists; the change is which policy the seat's callers ask for. Nothing here
  reopens command intents.
- **`docs/design/orchestrator-group-chat.md` §3.4** already specifies that a
  message to a *working* member is delivered through the same queue and shows
  the receipt advancing `queued (№2) → delivered`. That is the rendering this
  document reuses for the seat.
- **Bridge asks** (`src/lib/bridge/asks.ts`) are the other direction, seat →
  operator: one open ask per project, derived at read time from the report log
  with no store of its own. The intake projection in slice 2 copies that shape
  (derive, do not store) for operator → seat.
- **#1497** (Viewer-native sign-in, per-message authorship) and **#634**
  (shared workspace with owned agent tasks) fix the team model: a browser
  session names the person, every message carries an author. Intake composes
  with them (section 6) and needs nothing from them to ship.
- **#1844** (task states and reasons) and **#2162** (built-in board
  maintenance) own what the board says about a task once it exists. Intake ends
  where a task exists; it does not redefine task status.
- `search_transcripts` was queried in six phrasings, project-scoped and
  unscoped ("parallel intake", "many asks queue", "interrupt-active seat
  message lost", and Russian equivalents). No earlier design of operator → seat
  intake exists; the hits were the command-intents lane and the delivery-queue
  repairs of #1792 and #1983, both consistent with section 1.

## 4. Options weighed

| Option | Cost | Failure modes | What the operator sees |
| --- | --- | --- | --- |
| **A. Queue-first delivery to the seat** (recommended first slice). Designated-seat messages carry `policy: "queue"`; interrupt only through the stop button. | A policy value on four callers; one composer default; tests. No new process, store or prompt machinery. RAM 0. | A correction waits for the running turn: p50 54 s, p90 150 s, max 573 s measured. The stop button then send covers the urgent case. | Each waiting ask as an amber `queued №n` bubble; the seat answers them oldest first, one reply per ask. |
| **B. Ask projection: every operator ask durable and checkable** (second slice). Derive from the existing send receipts and the turn each ask started which task the seat created or updated in that turn. | A read-time projection like `bridge/asks.ts`, one composer chip, one seat-card badge. No store: receipts and task revisions already exist. | Attribution by turn misses a task the seat creates two turns later; the badge then over-reports until the seat links it. A dropped receipt reads as "unknown", never as "captured". | Per ask: `queued → in work → task «title» / answered without a task`; on the seat card: `N asks without a task`. |
| **C. Intake agent beside the seat** that triages and creates tasks while the seat works. | One more live host per project (170–310 MB RSS per Claude host measured on this machine), a second context reading the same asks, its tasks re-read by the seat. | It lacks the seat's context: two of the four episodes above are the *seat* misreading which lane an ask concerned; a triage agent misreads more often. The board-maintenance trial already produced 3 wrong changes in 11 (#2162). Two writers on one board. | Tasks appear a few seconds sooner than under A (the seat's own capture took 13 s). |
| **D. Several seats per project with task ownership.** | Doubles seat RAM and context; two seats reading one worktree and one lane set; rotation, wake, reports and bridge asks are all per project seat today (`asks.ts` "ONE open ask per PROJECT"). | Split context: neither seat knows the other's lanes; both answer the same wake. | Two chats to watch. |
| **E. Per-person threads in team mode.** | A thread model the product does not have; the seat's value is one context. | Cross-thread asks about the same lane conflict silently. | Several chats per project. |

A is chosen because it removes the measured loss with the smallest change. B is
chosen as the second slice because it is what makes "none lost" a claim the
operator can check rather than trust. C, D and E are deferred (section 8).

## 5. Recommendation and slices

### Slice 1 — queue-first delivery to the seat (this week)

Scope:

1. **Policy.** Every message addressed to a designated seat is sent with
   `policy: "queue"`:
   - the composer, when `isDesignatedManagerConversation(cardId, project)`
     holds (the predicate already sits on the send path, `TmuxComposer.tsx:2730`);
   - `send_message_to_orchestrator` (`bindings.ts:3801-3806`), which forwards to
     the plain send with the policy set;
   - `bridge_directive`, through the same send;
   - the seat tick wake, in `deliverConversationMessage`'s structured enqueue,
     so the six measured wake interrupts cannot recur whatever the registry
     says about the turn.
   Plain `send_message` to a worker keeps `interrupt-active`; a message to a
   lane agent is usually a correction and the operator expects it to land now.
2. **Interrupt stays explicit.** The stop button (`TmuxComposer.tsx:4200-4210`)
   ends the turn; the next queued ask then starts. No new control.
3. **Composer.** A held send renders as it does today (`queued`, amber) with its
   place in line: the outbox is serial and the server receipt says `queued`, so
   the position is the index among this conversation's admitted-but-undelivered
   receipts. No new state.
4. **Mandate, one line.** On an ask that names work, the seat's first action in
   that turn creates the task or appends to the existing one, then does the
   rest; a backlog is answered one ask per turn, oldest first, each with its own
   short reply. This is a complement, not the mechanism: slice 2 is what makes
   it observable.
5. **Tests**, by path, under isolated state: the delivery queue holds three
   `queue` sends against an active host and delivers them oldest first once the
   host is idle (`structuredDeliveryQueue.test.ts`); the composer sends `queue`
   for a designated seat and `interrupt-active` for a worker
   (`TmuxComposer.nativeQueue.dom.test.tsx` has the fixture shape at `:566-576`);
   `orchestratorTools.test.ts` for the MCP path; the seat-tick controller's
   deliver port records the policy.

Not in slice 1: batching several queued asks into one turn (deferred), any
change to task status, any change to bridge asks.

Rollback: the policy value is per caller; restoring `interrupt-active` on any
one of them is a one-line revert with no state to migrate.

### Slice 2 — the ask projection (next week)

An ask is an operator message admitted to the seat. Its record already exists:
the send receipt with `operationId`, admission time and terminal status. What
is missing is the read that answers "was it captured". Define it at read time,
in the shape of `bridge/asks.ts`:

- **Waiting:** receipt `queued`, host busy. **In work:** receipt
  `turn-started` and the turn not ended. **Answered:** the turn ended.
- **Captured:** a `create_task`, `update_task` or `create_pipeline` the seat
  issued during the turn that this ask started. The MCP layer knows the calling
  conversation and the host knows the turn; the task revision carries the
  write time. No new field on the task is needed for the first version; a
  later version may record `askId` on the task for exactness.
- **Answered without a task:** the turn ended with no such write. This is
  normal for questions ("what are the agents doing?") and is shown, not
  flagged.

Surfaces: a chip under the operator's bubble in the seat composer
(`queued №2`, `in work`, `task «…»` linking to the card, `answered`), and a
badge on the seat card, `N asks without a task`, that clears when the seat
links them. The badge is the operator's check on "none lost"; the seat's wake
can carry the same count so the seat clears it itself.

### Slice 3 — team composition (after #1497 lands)

Nothing in slices 1–2 depends on who sent the ask. Once a message carries an
author, the ask projection shows the author on the chip and the badge groups by
person; the seat's capture writes "asked by <name>" into the task details, and
reports name the asker. The queue stays one FIFO per seat: a project has one
seat and one board, and two people's asks about the same lane must be seen in
order by one context. Per-person threads remain deferred.

## 6. What the operator sees, end to end

- Types three asks in a row while the seat is mid-turn: three amber bubbles,
  `queued №1`, `№2`, `№3`; the running turn finishes; the seat answers the
  first, creates its task, then the second, then the third. No
  `[Request interrupted]` in the transcript.
- Wants to override the running turn: presses stop, then sends. Same gesture as
  today's stop.
- Comes back an hour later: the seat card says `2 asks without a task`; each
  bubble in the chat says which task it became.
- In team mode: the same, with a name on each chip and in each task.

## 7. Cost and failure summary

- Tokens: unchanged. The seat reads each ask once, as now, but no longer
  re-reads an interrupted turn to reconstruct it.
- RAM: zero new processes. (For comparison, the deferred intake agent would be
  one more live host at 170–310 MB RSS.)
- One owner per file: unchanged; the seat remains the only writer of its
  tasks.
- Failure mode of slice 1: a seat whose turn hangs holds its queue. The stop
  button and the existing dead-host recovery (`structuredDeliveryQueue.ts:1088-1105`)
  cover it; a hung turn is already the seat tick's `stalled` reason.
- Failure mode of slice 2: over-reporting "without a task" when the seat links
  an ask later. The badge is advisory; nothing blocks on it.

## 8. Deferred — not currently justified

- **Intake agent beside the seat (option C).** Reconsider only if, after
  slice 1, the measured queue wait for a burst exceeds what the operator accepts;
  the measured capture inside the seat's own turn is 13 seconds.
- **Several seats per project (option D)** and **per-person threads (option
  E)**. Reconsider with #634 if a project genuinely has two independent
  streams of work with separate boards.
- **Batched delivery of a backlog into one turn.** Would let the seat triage
  five asks in one context read. It muddies per-ask receipts and turn
  attribution, which slice 2 relies on; revisit once slice 2 shows the drain
  cost.
- **Automatic task per operator message.** Rejected: 146 asks in three days
  include questions and comments; the board would fill with noise the
  maintainer then deletes.
- **A store for asks.** Not needed while the projection derives from receipts
  and task revisions; add `askId` on the task only if attribution by turn
  proves too loose.
- **Steer-if-active for Codex seats.** Codex can join a running turn, but an
  ask is new work, not a steer, and one policy for both engines keeps the
  composer honest.

## 9. Validation against the originating requirement

The operator asked for four things. "Keep working while I ask other things":
slice 1 stops the ask from interrupting the turn. "Without forgetting the
earlier ones": the queue is durable and ordered, and slice 2 shows each ask's
fate. "At least a task or issue created, so no time is lost": the seat captures
in its own turn today (13 s measured) and slice 2 makes a missed capture
visible; a task created seconds sooner by a second agent is not worth a second
writer. "It gets worse with team work": slice 3 composes with #1497 without
changing the queue. Nothing the operator asked for needs a new process, a new
store, or a change to task states.
