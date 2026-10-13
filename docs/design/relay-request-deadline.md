# Relay request deadline and the busy hold

## Originating requirement

Operator, 2026-10-13 about 12:05 UTC, in Ukrainian, relayed by the paired
service's seat:

> «краще більший таймаут якщо на делегатус (до 2хв) і щоб не фолбечіло взагалі
> на селестію, бо зайобує що не знаєш хто відповідає, краще хай буде помилка».

In English: a longer timeout when a request goes to Delegatus (up to two
minutes), no fallback to Celestia at all, because it is annoying not to know
who is answering; an error is better.

The paired service's seat answered our «busy» question the same day (agent
relay, no operator authority of its own):

> hold and keep acknowledging, up to the 120 s window. Don't decline at once.
> While you hold, send a progress step such as «у черзі». […] If you still
> cannot serve by ~110 s, fail or decline explicitly. The chat then gets the
> error right away, without waiting for our sweep. […] The error text is
> generic, «Делегатус не відповів», with a busy variant if you send the busy
> reason.

The pinned specification lists seven install-side behaviours (numbered 1–7
below, the same numbers throughout) that end or silence a request early, and
the per-call bounds to keep. This document places the single request deadline,
designs the hold for the three busy causes, puts every remaining wait on that
deadline, lists what the paired service will observe, and orders the work.
No product file changes here.

## Sources read

| Source | Revision | What was read |
|---|---|---|
| This repository | `main` f275413e (unchanged at the time of writing) | `src/lib/externalRelay/{protocol,compact,runner,store,conversations,progressSteps,ownerRun,poller}.ts`, `src/lib/runtime/structuredSpawn.ts`, `src/lib/agent/autonomousConversation.ts`, `src/lib/selfUpdate/{drain,service}.ts`, `src/lib/viewerInstrumentation.ts`, `docs/design/relay.md` §A.4, §A.6, §A.7, `docs/design/relay-owner-tier.md` §2.2, and the runner, poller, ownerTier and slice 3 tests |
| Paired service | its `main` c661b598 (2026-10-13 11:17 UTC) | `apps/backend/api/schemas/relay_v1.json` (`Progress`, `Request`, `Liveness`, `Completion`), `apps/backend/application/usecase/clones/relay_progress.py`, `apps/backend/domain/entities/relay.py` (`RelayStep`) |
| Paired service's seat, relayed by our seat | 2026-10-13, after the first version of this document | `deadline_at` on the claim (name provisional), a stall window equal to the remaining budget, an interim heartbeat-gap tolerance of about 13 s, and the unchanged list of explicit early outcomes (§1.2) |
| Paired service, its lane for this requirement | open PR #3597 at head 37232a7e, "wait for Delegatus without automatic hosted fallback" | the PR body, and the diff of `relay_v1.json`, `infrastructure/tgbot/config.py`, `domain/entities/relay.py`, `infrastructure/database/repo/relay.py`; `relay_protocol.py` for how refusals reach the wire |

Earlier work: transcript and memory searches found the seat's answer quoted
above and the paired service's progress-steps design ("unknown ids are
ignored"). No earlier design for a request deadline or an install-side hold
exists; `relay.md` §A.6 still says "There is no answer clock".

## 1. What the wire carries, and what the paired service is changing

### 1.1 Today

A claimed `Request` (`src/lib/externalRelay/protocol.ts:149-164`) carries:

| Field | Clock | Meaning |
|---|---|---|
| `claimed_at` | service | when the service handed this lease to us |
| `liveness.heartbeat_interval_s` | duration | how often we heartbeat (2–60) |
| `liveness.stall_window_s` | duration | silence after which the service falls back (10–600) |
| `liveness.claim_window_s`, `ack_window_s`, `poll_freshness_s` | durations | service-side rules; the install reads none of them |
| `input.conversation[].sent_at` | the chat platform's | when each chat message was sent |

There is no request creation time, no answer deadline and no total window
on the wire. `relay.md` §A.6 L1 says the service never ends a request whose
heartbeats keep arriving, and L2 says no install timestamp decides anything.

A heartbeat carries at most one `Progress`. With the descriptor feature
`progress_steps`, the install sends `kind: "step"` with a label from a closed
set: `accepted | thinking | reading_board | working | writing_answer`
(`protocol.ts:305`, `progressSteps.ts:23`). Completions use the enums of
`protocol.ts:313-333`; `declined` / `busy` already exists, with the detail
`chat busy` for a busy chat.

### 1.2 The paired service's lane (PR #3597, not merged)

From its body and diff:

- An answer request has a fixed total deadline at its own `created_at` + 120 s
  (`RELAY_ANSWER_TIMEOUT`). Heartbeats refresh the stall window only inside
  it. After it, claim, heartbeat, tool admission and completion are refused:
  heartbeat and completion answer **409 `lease_lost`**
  (`relay_protocol.py:951-952`, `1022-1023`, reached from the new checks in
  `repo/relay.py`). A sweep every 5 s posts the error.
- Claim, acknowledgement and stall windows all default to 120 s. The claim
  window maximum in its public schema rises from 60 to **120**.
- Automatic fallback becomes silent for relayed requests. A `declined` /
  `busy` completion (and F1b) selects the busy error text, "Delegatus is busy
  right now. No other assistant answered."; other non-answers get "Delegatus
  did not answer. No other assistant answered." An explicit `declined` /
  `handoff` still reaches the hosted assistant.
- Compact requests keep their separate lifecycle and get no 120 s cap.
- While the service has no free slot, or the install is offline, it waits up
  to the window for a claim; it no longer falls back at once.

Settled since, by the paired service's seat (2026-10-13, relayed by our seat;
its lane is still being built):

- The claim will carry `deadline_at` (RFC 3339, UTC) = the request's arrival
  on its side + 120 s. Name and placement are provisional until its PR is
  reviewed (G1, §3).
- The claim's `stall_window_s` will equal the request's remaining budget, so
  the stall rule never cuts a request short of 120 s (G2).
- Until our fixed-rate heartbeats land (item 7), it tolerates gaps between
  heartbeats of up to about 13 s. The largest gap our journal showed in a day
  was 12.4 s, so item 7 now comes early in the order (§5.4, §7).
- Its expectation of what we keep is unchanged: member-limit and definite
  no-capacity declines, the tool-loop budgets, the owner hard cap, the
  per-call technical timeouts and the agent's explicit hand-off come back as
  explicit early outcomes (§4.6).

The pre-claim waiting matters for the install. The service already holds requests
before the claim whenever our poll advertises `free: 0` (drain, full target)
or the chat has a live lease (F7). Requests reach the install-side hold only
through races: a poll opened before a drain began, two Viewer generations
polling during a release succession, a slot advertised free in a poll that
was opened before another claim filled it, or a chat whose previous turn's
lease ended a few milliseconds before our runner released its conversation
record (`runner.ts:617-623` runs after the completion is accepted).

## 2. What the specification asks that the protocol cannot express today

### G1. The request's own start is not on the wire

Specification item 1 asks for 120 s "from the request's own start as the paired
service reports it, never from our local receipt if the protocol carries the
former". The service keeps `created_at` and computes its deadline from it,
but the `Request` carries only `claimed_at`. Under PR #3597 a claim can come
up to 120 s after creation (a request held before the claim), so `claimed_at`
can differ from the start by the whole window.

**Settled with the paired service's seat (2026-10-13, relayed by our seat):**
the claim will carry a new additive field `deadline_at`, an RFC 3339 time in
UTC equal to the request's arrival on the service's side + 120 s. Our single
request deadline counts from it. **The name and its place in the claim are
provisional** until the service's PR is reviewed; the parser below makes a
rename or a move a one-line change.

Every current install already tolerates the field: `requestSchema` is a
stripping `z.object`, so an unknown key is dropped (probe below), and the
service's own `Request` schema has no `additionalProperties: false`. The
install does **not** add it to `requestSchema`: `deadline.ts` reads it from the
raw claim body through one constant path (§3.1), so the field can never make
a request fail validation.

A `deadline_at` keeps the window in one place (the service's
`RELAY_ANSWER_TIMEOUT`), and `deadline_at − claimed_at` is a difference of two
times on the same clock, so clock skew between the hosts cannot move our
deadline (§3.2).

**Fallback.** When the field is absent (an older paired release), unparseable,
already past at the claim, or implausibly far out, the install counts 120 s
from its own receipt of the claim, which is `claimed_at` plus transit time.
The request goes on normally; nothing about the field can refuse it. Two other
anchors were rejected. Reading `claimed_at` against our wall clock gains
nothing over receipt and adds skew. Using the `respond_to` message's `sent_at`
moves the deadline into the past for any message delivered from a backlog,
and mixes in the chat platform's clock.

Consequence of the fallback against an older release that held the request
before the claim: our deadline ends later than the service's. A request we
then hold is expired by the service first, our busy decline gets 409, and the
chat shows the generic error. The chat is not left silent and nothing runs
twice.

### G2. The service's new liveness values are refused by our parser

`livenessSchema` caps `claim_window_s` at 60 (`protocol.ts:41`), for both the
request and the descriptor. A probe on main with a `sampleRequest` whose
`liveness.claim_window_s` is 120:

```
request with claim_window_s=120 parses: false [{"path":["liveness","claim_window_s"],"code":"too_big"}]
request with an extra deadline_at key parses: true kept: false
```

Once PR #3597 is deployed with its defaults, **every** relayed request fails
`requestSchema` and is declined `invalid_request` (`runner.ts:252-262`), which
the service now shows as an error in every chat; descriptor refreshes fail
too (`client.ts:233`). This is outside the seven items. It is the first slice
(S0), and the paired service must not deploy PR #3597 with a claim window
above 60 until S0 runs on this install, or it must set
`RELAY_CLAIM_WINDOW_SECONDS` to 60 or less until then.

The same holds for the stall window. The paired service's seat confirmed that
its claim will send `stall_window_s` equal to the request's remaining budget,
so its stall rule never cuts a request short of its 120 s. A request claimed
in its last ten seconds then carries `stall_window_s` below 10, and our
schema's minimum of 10 (`protocol.ts:44`) would refuse it as
`invalid_request`.

**Shape:** the install reads only `heartbeat_interval_s` and `stall_window_s`.
Keep `heartbeat_interval_s` at 2–60. Accept `stall_window_s` from 1 to 600:
the install uses it only for its local "no acknowledgement for this long"
check (`runner.ts:315-321`) and the delivery fallback (§5.3), and both work for
any positive value. A remaining budget of 0 never arrives, because the service
does not claim an expired request. A small value, which means a claim late in
the window, makes the local check end the run at about the service's own
deadline, which is the right moment; a busy request claimed that late is
declined at once, because its `declineAt` has already passed (§3.2).
Validate the three fields the install never reads as positive integers, so a
service-side window change cannot refuse requests again. Update the schema in
`relay.md` §A.5 to match.

### G3. «у черзі» is not in the closed step set

**Fix:** a sixth step id, `queued`, with `kind: "step"` and the same shape as the
others. The service localises step ids itself (`relay-step` in its locale
files), so the Ukrainian «у черзі» is its text to add with
`RelayStep.QUEUED`. Order is free: on its main,
`relay_progress.py:60-65` turns a step label outside `RelayStep` into
`progress = None` and still accepts the heartbeat, and its schema allows any
one-line label of 1–160 characters for `kind: "step"`. Until the service adds
the id, `queued` heartbeats count as plain heartbeats and show nothing.

Without `progress_steps` in the descriptor (legacy notes), a held request
sends `progress: null`. Notes are free text in the agent's language and the
install does not know the chat's language.

### G4. The window value itself

The 120 s window is not in `liveness`. The install keeps it as a constant
(`RELAY_REQUEST_WINDOW_MS = 120_000`, the operator's number) for the fallback
only, and uses a valid `deadline_at` whenever one is present. No other field
is needed: `declined` / `busy` and its `chat busy` detail already exist.

## 3. The single deadline (item 1)

### 3.1 Where it lives

A new module `src/lib/externalRelay/deadline.ts`:

```ts
/** Provisional until the paired service's PR is reviewed: a rename or a move
    (for example under `liveness`) changes this line only. */
export const RELAY_DEADLINE_PATH = ["deadline_at"] as const;
export const RELAY_REQUEST_WINDOW_MS = 120_000;
export const RELAY_BUSY_DECLINE_MARGIN_MS = 10_000;
export type RelayRequestDeadline = Readonly<{
  receivedAt: number;          // Date.now() when the claim body reached runClaimedRequest
  at: number;                  // the service refuses everything after this (estimate)
  declineAt: number;           // at − margin: the last moment to give up explicitly
  source: "deadline_at" | "receipt";
  fallback: null | "absent" | "unparseable" | "past" | "far";   // why receipt was used
}>;
export function relayRequestDeadline(raw: unknown, receivedAt = Date.now()): RelayRequestDeadline;
export const remainingMs = (d: RelayRequestDeadline, now = Date.now()) => Math.max(0, d.at - now);
```

`runClaimedRequest` creates it as its first statement, from the raw claim
body (so an unparseable claim also has one), and passes the same frozen
object to every consumer: the hold, the store's asynchronous lock wait, the
owner run, and completion delivery. Nothing assigns to it after creation.
`runCompactRequest` receives it only for the invalid-compact path (item 6);
compact requests otherwise keep their own lifecycle, as on the service.

### 3.2 Which clock, and how it is computed

`relayRequestDeadline` reads the value at `RELAY_DEADLINE_PATH` and the raw
`claimed_at`, and never throws:

| Value at the path | Deadline | `fallback` |
|---|---|---|
| missing, or the object has no such path | `receivedAt + 120 s` | `absent` |
| not a string, or not an RFC 3339 time with an offset (the same `z.iso.datetime({ offset: true })` check `claimed_at` uses), or `claimed_at` unreadable | `receivedAt + 120 s` | `unparseable` |
| at or before `claimed_at` | `receivedAt + 120 s` | `past` |
| more than 600 s after `claimed_at` (the protocol's largest stall window) | `receivedAt + 120 s` | `far` |
| otherwise | `receivedAt + (deadline_at − claimed_at)` | `null` |

- Both service times are on the service's clock, so their difference is free
  of skew. "Past" is judged against `claimed_at` for the same reason: judging
  it against our wall clock would let a fast local clock throw away a valid
  deadline. The only error left is the claim response's transit time, which
  makes `at` late by milliseconds to a few seconds; the 10 s margin absorbs
  it.
- A fallback is journaled once per claim as `External relay deadline` with the
  request prefix and the `fallback` word, never the value. An `absent` from an
  older release is expected; the others point at a service defect.
- `declineAt = at − 10 s`. For a window shorter than 10 s it is `receivedAt`.

The clock is `Date.now()`, captured once. Every other liveness comparison in
the runner (stall, heartbeat schedule) already uses it, and the runner and
poller tests drive it through `spyOn(Date, "now")`. An NTP slew moves it by
milliseconds; a wall-clock step would move every existing comparison too and
is out of scope.

### 3.3 What it bounds, and what it does not

It bounds **waits**: the hold (item 2), store-lock contention on the request
path (item 3), an owner launch's admission and an unconfirmed first message
(item 4), and completion retries (items 5, 6).

It does **not** stop an agent that is working. A running child, an owner turn
whose first message landed, and a tool loop keep running under the lease,
the per-target hard cap and the per-call bounds the specification keeps. A
service with the total deadline ends such a lease with 409 at its deadline,
and the existing lease-loss path (`runner.ts:355-363`) cancels the run within
one heartbeat interval. A service without it (L1) still gets answers that take
longer, as today. Stopping running work locally at `at` would also cut runs
that an older service accepts, and is listed under Deferred.

### 3.4 "No path renews the deadline"

`relayRequestDeadline` is called once per claim and returns a frozen object.
The acceptance test drives one held request through acknowledged heartbeats,
step changes, a return to the hold after a drain appears before launch,
lock contention, and failed completion attempts, and asserts that the busy
decline is sent at `declineAt` computed at receipt (within one hold tick) and
that delivery stops at `at`. A second case gives the request a
`deadline_at` 13 s after `claimed_at`, so the production path is exercised
without a test seam: the decline comes about 3 s after receipt. Unit cases in
`deadline.test.ts` cover each row of the §3.2 table, and a runner case sends a
claim whose `deadline_at` is unparseable and one whose value is past: both run
to `answered`, and neither is declined `invalid_request`.

## 4. The hold (item 2)

### 4.1 Where requests are declined busy today

| Cause | Code | Heartbeat before the decline? |
|---|---|---|
| deploy drain | `runner.ts:268`; again at `:427` and at round 1, `:483` | at `:268` none; at `:427`/`:483` yes |
| target concurrency full | `store.ts:254-261` through `runner.ts:301` | none |
| chat already has a running turn | `conversations.ts:58` through `runner.ts:433` | yes |

`advertisedSlots` (`runner.ts:74-94`) advertises `free: 0` for every target
during a drain and stays that way; the service then holds requests before
the claim (§1.2).

### 4.2 New order inside `runClaimedRequest`

1. Create the deadline (§3).
2. Parse; `invalid_request`, `unsupported_kind`, `not_configured` and
   `disabled` decline as today, without a heartbeat.
3. **Acknowledge.** Start the heartbeat sequencer (item 7) and send heartbeat 1
   (`accepted`) before any reservation. Today it comes right after
   `reserveRun`; L3 already requires it before filesystem context and account
   selection, so moving it earlier keeps that rule. An in-memory set of
   in-flight request ids, checked synchronously at entry next to the ledger
   lookup at `runner.ts:205`, makes a duplicate claim of a held request in this
   process return `null` without a heartbeat. The ledger still catches a
   duplicate from another process at reservation (`"duplicate"`).
4. Member limit (`runner.ts:386-408`), owner resolution and the owner
   clarification answer (`:409-428`), then a **definite capacity check**: the
   same `accountManager.resolveHeadlessSpawn` call as `:436-452`, with the
   chat conversation's stored account read without a lock as its preference.
   The selection is read-only (`accounts/manager.ts:606-645` picks and
   returns; it reserves nothing). An exhausted or unavailable pool declines
   `no_capacity` here, with the same `retry_after_s` rule as today. None of
   these needs a slot, so a request that will be refused is never held: each
   comes back as an explicit early outcome (§4.6).
5. **The admission gate** (one function, one loop, §4.3).
6. When the request waited in the gate, re-check the member limit (another
   request of the same member may have been answered meanwhile). This keeps
   the check-then-launch window as short as it is today.
7. Owner custody write, account selection as today (an account exhausted
   while the request was held still declines `no_capacity`; the result of
   this second call is the one used for the launch), launch. The round-1
   drain check stays immediately before the launch; when it sees a drain, it
   releases the run slot and the conversation and returns to the gate. The
   check at `:427` is removed, since the gate covers it.

### 4.3 The gate

```
loop:
  if the lease is lost                    → return null (no completion, as today)
  if this process is releasing holds      → decline busy now (§4.5)
  cause = drain       if activeDrain()
        | chat        if the chat's conversation is running (readConversations, no lock)
        | capacity    if an older capacity waiter for this target exists
        | none
  if cause is none:
    reserveRun (async lock, §5.1)         → "duplicate": return null
                                          → "full": cause = capacity
    if added and a chat conversation is used:
      reserveConversations (async lock)   → null: drop the run row; cause = chat
  if cause is none: leave the hold, steps.observe({}), go on
  enter or update the hold entry (relay, target, chat, cause, deadline)
  steps.observe({ queued: true })
  if now ≥ deadline.declineAt             → decline busy with the cause's detail
  wait until the next tick (1 s, or less to reach declineAt)
```

Waiting by polling once a second keeps the mechanism small. Admission after a
release lags by at most one second, against a window of 120.

Rules:

- **Holding is waiting.** A held request owns no run-ledger row, no
  `markActive` count and no conversation reservation. `reserveRun` counts
  ledger rows against `target.concurrency` (`store.ts:254-261`), so
  execution concurrency can never exceed the limit because of a hold. A chat
  waiter releases its slot (step "drop the run row") because holding a slot
  for a busy chat would block other chats. It cannot reserve the conversation
  first: `sweepConversations` resets any `running` conversation that has no
  ledger row (`conversations.ts:110`).
- **First come, first served per target.** The hold registry
  (`src/lib/externalRelay/hold.ts`, on `globalThis` like the active-run map at
  `runner.ts:58-61`, so module copies share it) orders capacity waiters by
  `deadline.at`. Only the oldest capacity waiter of a target tries
  `reserveRun`. Drain and chat waiters do not block capacity waiters behind
  them.
- **Advertised slots.** `advertisedSlots` subtracts this process's capacity
  waiters for the target, so a poll reopened after a run ends does not hand a
  newer request the slot the oldest waiter is about to take. During a drain
  it still advertises 0.
- **Steps.** `RelayStepObservation` gains `queued?: boolean` and
  `relayStepFor` returns `queued` first when it is set. The 3 s step debounce is
  unchanged, so a hold that clears within 3 s of `accepted` never shows
  `queued`, and the step after admission is `thinking` (or what the run
  reports).
- **Detail and retry hint on the bound's decline** are today's: drain
  `null`, capacity `null`, chat `chat busy`; `retry_after_s` is `null`.
- **Pause or disable during a hold** is not re-read (today's checks also run
  only at the claim); see Deferred.

### 4.4 Interaction with the concurrency limit

| Moment | Ledger rows for the target | `free` advertised | Held entries |
|---|---|---|---|
| A runs (limit 1) | 1 | 0 | none |
| B claimed in a race, full | 1 | 0 | B (capacity) |
| A completes and frees its slot | 0 | 1 − 1 waiter = 0 | B |
| B admitted at its next tick | 1 | 0 | none |

The acceptance test samples the ledger and the stub children through this
sequence with a third request C held behind B, and asserts at most one child
at any sample and the admission order A, B, C.

### 4.5 Drain: what holds, and what the drain's own bound does

A drain is the self-update launch hold (`selfUpdate/drain.ts:18-36`). It
holds the request in the gate. Three endings:

1. **The drain is released, or its waiting bound expires.** The hold waits at
   most `DRAIN_LEASE_MS` (10 min) for quiet and then releases itself as
   `launch-hold-expired` (`selfUpdate/service.ts:1139-1149`). `activeDrain()`
   then returns `null`, so held requests are admitted at their next tick if
   their own deadline has not passed. A request's window (120 s) is far
   shorter than the drain's bound, so most drain-held requests end at the
   request's own bound with `declined` / `busy` about 110 s after the start.
2. **The drain is admitted and this Viewer is demoted.** `onDemoted`
   (`viewerInstrumentation.ts:992-996`) stops the pollers and then ends with
   `process.exit` (`:293-318`). Held requests exist only in memory and the
   successor cannot continue them, so `onDemoted` awaits a new
   `declineHeldRelayRequests(5_000)` right after `stopExternalRelayPollers()`.
   It marks the registry as releasing, which turns every gate into an
   immediate `declined` / `busy` (cause detail), sends those completions in
   parallel, one attempt each with the existing 5 s call timeout, and
   resolves when they settle or after 5 s, whichever is first. Then demotion
   continues and the process exits. The chat gets the busy error at that
   moment, without waiting for the service's deadline.
3. **The process dies without demotion** (crash, kill). Held requests vanish
   without a completion, and the service posts its generic error at its
   deadline. Durable holds are under Deferred.

Holding never delays the exit or the drain. The drain's quiet probe does not
read the external relay run ledger (`selfUpdate/quiet.ts`; its "relay" fields
belong to review flows), and today a running relay child is interrupted at
exit and completed `install_restarted` by the successor's sweep
(`poller.ts:88-143`). The hold's timers are the runner's existing `unref`'d
interval, and the demotion step is bounded at 5 s.

### 4.6 What never waits: explicit early outcomes

The paired service's seat expects these to come back as explicit outcomes as
soon as they are known. None of them enters the hold, and none of their bounds
changes:

| Outcome | When it is sent | Code |
|---|---|---|
| `declined` / `member_limit` with `retry_after_s` | before the hold (step 4), again after a wait (step 6) | `runner.ts:386-408` |
| `declined` / `no_capacity` with `retry_after_s` when a reset time is known | before the hold (step 4), again at the launch (step 7) | `runner.ts:436-452` |
| `declined` / `handoff` (the agent's explicit hand-off) | when the agent decides it | `runner.ts:579-582` |
| tool-loop budgets: 8 rounds, 16 calls, 64 KiB of outputs | during the run, unchanged | `runner.ts:479-480`, `toolLoop.ts` |
| owner hard cap (`failed` / `hard_cap`), live value 30 min | during the run, unchanged | `ownerRun.ts:350` |
| per-call technical timeouts (5 s socket, 25/40 s long poll, 10 s runtime-host RPC, 30 s native engine RPC, 30 s per tool call) | per call, unchanged | the call sites the specification lists |
| `declined` / `not_configured`, `disabled`, `invalid_request`, `unsupported_kind`, `profile_error` | as today | `runner.ts:252-267`, `:526-527` |

Only the three busy causes wait, and only inside the request's own deadline.

## 5. The other waits

### 5.1 Store lock contention (item 3)

`withFileLock` (`store.ts:199-243`) spins with
`Atomics.wait(…, 10)` for up to 5 s (`:203`, `:226-227`). Each slice blocks the
whole Viewer: every request's heartbeats, the poller and HTTP. Then it throws,
and the request fails.

Add `withFileLockAsync(file, action, until)` beside it: the same lock file,
the same stale-owner rule, the same synchronous `action` while held. Between
attempts it awaits a 10 ms timer, which yields the event loop. It gives up
at `min(now + 5 s, until)` with a `RelayStoreBusy` error. Request-path writes
use async variants built on it: `reserveRunAsync`, `dropRunAsync` and the
`changeRun` calls in `runner.ts` that record the owner turn and the child
pid, plus `reserveConversationsAsync` and `releaseConversationAsync`. In the
gate, `until` is `deadline.declineAt`, so contention is one more reason to
stay in the hold; `RelayStoreBusy` there is treated as `capacity` for that
tick. Cleanup in `finally` uses `until = now + 5 s` whatever the deadline,
because releasing a slot is never a request wait.

The synchronous version stays for its other callers (pairing, routes,
switches, the poller sweep, and the owner-cancellation custody writes in
`ownerRun.ts`, whose durability ordering depends on being synchronous); see
Deferred, where lane 8478db36 is named.

Test: a child process creates the lock with its own live identity and
removes it after 1.5 s; a 10 ms interval measures timer lateness while
`reserveRunAsync` waits. The red proof is the same probe around the
synchronous `reserveRun` (lateness ≥ 1.4 s); green requires the largest
lateness under 100 ms and the reservation to succeed after the release.

### 5.2 Owner launch and a queued first message (item 4)

Today `ownerRun.ts:373` kills a launch whose result says
`initialMessage: "queued"` and fails the request. That result means the first
message was not confirmed within `INITIAL_MESSAGE_TIMEOUT_MS`
(`structuredSpawn.ts:66`, the wait at `:435-458`), or a transient staged
failure left durable recovery custody (`:2427-2470`, `:2554`). The spawn
machinery keeps recovering it; the relay gives up 30 s into a 120 s window.
`relay-owner-tier.md` §2.2 chose the kill "so no turn runs later with nobody
to answer". The deadline keeps that guarantee and moves the cut to the bound.

At the owner boundary (no change to `structuredSpawn.ts`, whose 30 s bounds
serve every spawn):

- `runOwnerAgent` takes the deadline. One `unref`'d timer at
  `deadline.declineAt` acts while the first message is unconfirmed. While
  `ports.launch` is still pending it calls `cancel("failed")`, which kills
  because `admitted` is still false (`stopped ??= admitted ? "interrupt" :
  "kill"`) and keeps durable custody for the pending launch. After a `queued`
  result, `admitted` is already true (`:365`), so the timer runs the statement
  `:373` runs today (`stopped = "kill"; cancelStatus = "failed";
  persistStop(); await applyStop()`), at the bound. Either way `done`
  resolves `failed`. This is how "recoverable admission uses the remaining
  shared budget at the owner boundary": a launch started late in the window
  cannot run its own 30 s waits past the request's bound.
- A `queued` result goes on to the observe loop at `:379`.
  `observeOwnerTurn` already reports `running` while the first prompt is held
  (`:109`), and gains `firstMessagePending: boolean` from the same
  held-delivery lookup and the receipt state. When it turns false, the timer
  is cleared and the turn runs under the lease and the hard cap like any
  other. While it is true, the runner maps it to `steps.observe({ queued: true
  })`.
- The completion when the bound fires is `failed` / `agent_error`, the same
  status this path sends today, about 80 s later. A service with the total
  deadline also ends the lease at its own bound; the existing lease-loss path
  then kills the same way.

### 5.3 Completion delivery (items 5 and 6)

Today `finish` stops the heartbeat timer before delivery (`runner.ts:225`), and
`completeRelayRequest` retries until 45 s after the last acknowledgement
(`:168-171`, the default at `:224`, the stall window at `:602`). With
heartbeats stopped that clock no longer moves, and with a 120 s stall
window the service would not notice either.

- `completeRelayRequest(relay, id, body, until: () => number, …)` replaces
  `lastHeartbeat` and `stallMs` with one absolute bound.
- `finish` keeps the heartbeat sequencer running during delivery (regular
  beats, `progress` per the step rules) and stops it once delivery settles.
  A beat that crosses an accepted completion gets 409; the existing handler
  only marks the lease gone and cancels what already ended, and the journal
  records it.
- The runner passes `until = deliveryStart < deadline.at ? deadline.at :
  deliveryStart + stallMs`. The second branch occurs only when a run finished
  after the deadline, which needs a service without the total deadline; it
  keeps the §A.4 rule ("until `stall_window_s` has passed") for that case.
  Delivery never extends the deadline: past `at`, the service answers 409,
  which `completeRelayRequest` already treats as terminal.
- Item 6: the invalid-compact path (`runner.ts:186`) passes `Date.now` as the
  last heartbeat, so the cutoff never ages. It passes `() => deadline.at` now.
- `compact.ts:37` passes `() => heartbeatAt + stallMs`, which is its current
  behaviour unchanged.

The test "an early decline stops heartbeats so failed completions reach the
retry deadline" (`runner.test.ts:268`) encodes the old behaviour and is
rewritten: an early decline keeps heartbeating while its completion fails, and
its retries end at `deadline.at`.

### 5.4 Heartbeat cadence (item 7)

`nextBeatAt = heartbeatAt + interval` (`runner.ts:349`), with `heartbeatAt`
set when the acknowledgement arrives, and a 1 s polling interval that fires
the beat (`:374-381`). Each gap is therefore the interval plus the round trip
plus up to a second of tick lag; the journal showed 20 gaps above 10 s in a
day, the largest 12.4 s.

New schedule: a fixed grid anchored at the send time of heartbeat 1,
`due(k) = anchor + k × interval`. After each beat (acknowledged or failed) the
sequencer arms one `unref`'d `setTimeout` for the next due slot after now. A
failed beat retries after 1 s or at the next slot, whichever is first. Step
changes and the queued step send extra beats and leave the grid alone. The 1 s
interval remains for stall checks and step observation only. The gap between
two sends is then the interval plus timer lateness (milliseconds), whatever
the round trip.

Test: `heartbeat_interval_s: 2`, a test relay that answers heartbeats after
400 ms; over six beats every send-to-send gap is at most 2 050 ms (red today:
2 400 ms to 3 400 ms).

Why this slice comes early: the paired service tolerates heartbeat gaps up to
about 13 s until the grid lands, and our largest gap in a day was 12.4 s. The
same rule applies to every silence the install controls: the hold beats on
the grid, and the delivery keeps beating (§5.3). After S1 lands, no gap the
install causes exceeds the interval plus timer lateness, so the service can
tighten its tolerance when it chooses.

## 6. What the paired service will observe

This table is written for the PR body, so the service's seat can check it
against its lane.

| Case | Today | After this change |
|---|---|---|
| Normal request (free slot, no drain, chat idle) | heartbeat 1 `accepted` after the run slot is reserved; steps; completion | heartbeat 1 `accepted` a few ms earlier (before reservation); otherwise the same steps and completions |
| Heartbeat timing | every interval + round trip + up to 1 s (largest daily gap 12.4 s, under the service's interim ~13 s tolerance) | on a fixed grid every `heartbeat_interval_s` from heartbeat 1, during holds and delivery too |
| Claim during a drain (race with a poll opened before it) | `declined` / `busy` / detail `null`, no heartbeat | `accepted`, then step `queued` (≥ 3 s later, if still held), heartbeats every interval; if the drain ends: `thinking` and a normal run; else `declined` / `busy` / `null` at `declineAt` |
| Target full (race) | `declined` / `busy` / `null`, no heartbeat | the same hold; admitted first-come-first-served when a slot frees; else `declined` / `busy` / `null` at `declineAt` |
| Chat busy (race) | heartbeat 1, then `declined` / `busy` / `chat busy` at once | the same hold; admitted when the chat's turn ends; else `declined` / `busy` / `chat busy` at `declineAt` |
| Held when this Viewer is demoted for a deploy | (not applicable) | `declined` / `busy` with the cause's detail at once, before the process exits |
| Busy and also out of account capacity | `declined` / `busy` (drain, full or busy chat checked first) | `declined` / `no_capacity` with its retry hint at once, after heartbeat 1; never held |
| Member past its limit while busy | `declined` / `busy` when drain or full came first | `declined` / `member_limit` at once, after heartbeat 1; never held |
| `slots[].free` | `concurrency − max(running, ledger rows)` | the same minus this install's capacity waiters for the target |
| Owner launch whose first message was not confirmed in 30 s | `failed` / `agent_error` about 30 s after launch | step `queued` while unconfirmed; a normal answer if it lands and the turn ends; else `failed` / `agent_error` at `declineAt` |
| Completion delivery | heartbeats stop; retries until 45 s (or the stall window) after the last acknowledgement | heartbeats continue until delivery settles; retries stop at the request's deadline |
| Invalid compact claim | `declined` / `invalid_request`, retried without end on transient errors | the same body; retries stop at the request's deadline |
| `declineAt` | — | `deadline_at − 10 s`, mapped through `claimed_at`, when the claim carries a valid `deadline_at`; when it is absent, unparseable, past or implausibly far, 110 s after the install received the claim, and the request is served normally |
| New wire values | — | the step id `queued` (shown once the service adds it to `RelayStep` and its `relay-step` text); the install accepts `claim_window_s` of any positive value and `stall_window_s` from 1 to 600, and reads the provisional `deadline_at` |

Unchanged: every completion outcome and reason enum, `member_limit` and
definite `no_capacity` as explicit early outcomes (both now checked before the
hold and again after it, §4.6), the hand-off, compact requests' immediate `busy` declines, the 3 s step debounce,
poll backoff, the 25/40 s long poll, 5 s socket inactivity, the tool-loop
budgets, and the owner hard cap.

## 7. Order of the changes: the smallest safe slices

Each slice is one commit with its failing-first test, green on its own, in
this order. S0 must also run on the install before the service deploys its
lane (G2).

| Slice | Change | Items | Failing-first test (file) | Depends on |
|---|---|---|---|---|
| S0 | Tolerant `livenessSchema`: the three unread fields any positive integer, `stall_window_s` 1–600; `relay.md` §A.5 schema | G2 | a request and a descriptor with `claim_window_s: 120` parse, and so does a request with `stall_window_s: 4`; each claim runs to `answered` (`protocol.test.ts`, `runner.test.ts`) | none |
| S1 | Fixed heartbeat grid; moved forward because of the service's interim ~13 s tolerance | 7 | the 2 s / 400 ms gap test (§5.4) | none |
| S2 | `deadline.ts` with the provisional `RELAY_DEADLINE_PATH` read from the raw claim; `completeRelayRequest(…, until)`; invalid-compact bound; `relay.md` §A.6 note on the service's total deadline and how the install reads it | 1, 6 | a unit case per row of the §3.2 table and a short window; unparseable and past `deadline_at` claims run to `answered`; an invalid compact claim with completions failing 503 stops at `deadline.at` under a fake clock (red: it never stops) (`deadline.test.ts`, `runner.test.ts`) | S0 |
| S3 | Heartbeat during delivery; delivery bound from the deadline | 5 | a completion failing 503 is retried while heartbeats keep arriving on the grid, and stops at `deadline.at`; the rewrite of `runner.test.ts:268` | S1, S2 |
| S4 | `withFileLockAsync` and the async request-path writes | 3 | the event-loop lateness probe (§5.1) | S2 |
| S5 | Acknowledge before reservation, the in-flight id set, member-limit and definite capacity checks before the gate, the gate with the **capacity** cause, the hold registry, `queued` step, `slots` minus waiters | 2 | per cause test A below; the concurrency/FIFO test of §4.4; a full target with an exhausted pool declines `no_capacity` at once and a member past the limit declines `member_limit` at once, neither held (red today: both `busy`) | S1, S2, S4 |
| S6 | **Chat** cause in the gate (drop the slot on a busy chat) | 2 | per cause test B | S5 |
| S7 | **Drain** cause, the round-1 re-check returning to the gate, `declineHeldRelayRequests` and its call in `onDemoted` | 2 | per cause test C; demotion test D | S5 |
| S8 | Owner boundary deadline and the queued first message | 4 | test E; the rewrite of `ownerTier.test.ts:246` | S2, S5 (`queued` step) |

Per-cause tests (`runner.test.ts`, with the stub CLI and `startTestRelay`; the
short window comes from `deadline_at = claimed_at + 13 s`, so `declineAt` is
3 s after receipt):

- **A (capacity).** Limit 1. A runs. B is claimed: heartbeats `accepted`, then
  `queued`; no ledger row for B; `advertisedSlots` 0. A ends: B is admitted, its
  next step is `thinking`, it answers. A second run of the case keeps A running
  past B's `declineAt`: B completes `declined` / `busy` / `null` within one tick
  of it, and at no sample are two children alive.
- **B (chat).** Chat conversations on, limit 2. A runs in chat X. B for chat X
  holds with `queued` and holds no slot (a request C for chat Y is admitted
  meanwhile). A ends: B runs as the conversation's next turn. Bound variant:
  `declined` / `busy` / `chat busy` at `declineAt`.
- **C (drain).** A drain is written before the claim: `accepted`, `queued`, no
  ledger row, no child. The drain is released: B runs and answers. Bound
  variant: `declined` / `busy` / `null` at `declineAt`, and no child was ever
  started. The poller variant replaces `poller.test.ts:894`: a claim already
  waiting when the drain begins is held.
- **D (demotion).** A held request and a service that never answers
  completions: `declineHeldRelayRequests(500)` resolves within 600 ms and the
  one completion attempt sent was `declined` / `busy`.
- **E (owner).** `launch` returns `initialMessage: "queued"`; `observe` reports
  `firstMessagePending: true` twice and then a started turn that ends with
  text: the request is `answered` and `stop` was never called. Bound variant:
  pending throughout, `stop` called once with `kill` at `declineAt`, completion
  `failed` / `agent_error`. A launch that never returns is also cut at
  `declineAt`.
- **Non-renewal** (§3.4), in the same file.

## 8. Existing tests whose expectations change

| Test | Old expectation | New expectation |
|---|---|---|
| `runner.test.ts:268` "an early decline stops heartbeats so failed completions reach the retry deadline" | one heartbeat; retries end 45 s after it | heartbeats continue during delivery; retries end at `deadline.at` |
| `runner.test.ts:387` "a full target is declined…" | B declined `busy` at once | B held, then served after A |
| `runner.test.ts:908` "relay advertises zero capacity … during drain, then admits after release" | declined `busy` during the drain | held during the drain, then answered after release (same request) |
| `runner.test.ts:1111` "pre-launch capacity and drain declines leave the member's allowance available" | `rq_before_drain` declined `busy` | it returns to the hold and is declined `busy` at a short `deadline_at`; the allowance stays available |
| `poller.test.ts:894` "a claim already waiting when drain begins is declined…" | declined `busy`, no reservation | held, no reservation, `queued` step, then busy at the bound or served after release |
| `ownerTier.test.ts:246` "queued admission is killed…" | killed at once, `failed` | observed; killed at `declineAt` only when still unconfirmed; the refused-launch half is unchanged |

`slice3Runner.test.ts:126` (a compact request on a busy chat) keeps its
immediate `chat busy` decline.

## 9. Checks for the lane

Every file by explicit path, through `scripts/gate-slot.sh`, with a private
`HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` under the stage's
scratch directory and `LLV_VIEWER_CONTROL_URL` pointing at a closed port:

```
bash scripts/gate-slot.sh bun test src/lib/externalRelay/protocol.test.ts
bash scripts/gate-slot.sh bun test src/lib/externalRelay/deadline.test.ts
bash scripts/gate-slot.sh bun test src/lib/externalRelay/runner.test.ts
bash scripts/gate-slot.sh bun test src/lib/externalRelay/ownerTier.test.ts
bash scripts/gate-slot.sh bun test src/lib/externalRelay/toolLoop.test.ts
bash scripts/gate-slot.sh bun test src/lib/externalRelay/poller.test.ts
bash scripts/gate-slot.sh bun test src/lib/externalRelay/store.test.ts
bash scripts/gate-slot.sh bun test src/lib/externalRelay/progressSteps.test.ts
bash scripts/gate-slot.sh bun test src/lib/externalRelay/progressSteps.runner.test.ts
bash scripts/gate-slot.sh bun test src/lib/externalRelay/slice3Runner.test.ts
bash scripts/gate-slot.sh bun test src/lib/externalRelay/conversations.test.ts
```

`progressSteps.runner.test.ts` replays the committed heartbeat capture
(`fixtures/relay_v1/owner-progress-heartbeats.json`). Its bodies stay the same:
the capture excludes timestamps, and the owner run in it never holds. If the
earlier acknowledgement changes it, re-record it as its README says.
Fences: nothing under `src/lib/pipelines`, and `src/lib/mcp/bindings.ts` is
not touched. `src/lib/viewerInstrumentation.ts` gains one awaited call in
`onDemoted`.

## 10. Checked against the requirement

- "більший таймаут … до 2хв": every wait the install controls now ends at the
  request's own two-minute bound (§3, §5), and a busy install waits inside it
  (§4) where it used to decline at once.
- "щоб не фолбечіло взагалі": the service's lane makes fallback silent; the
  install never answers in the service's name, and keeps the explicit
  hand-off, which the specification keeps.
- "краще хай буде помилка": a request that cannot be served is declined
  `busy` at about 110 s, or on demotion at once, which the service shows as its
  busy error immediately (§4.3, §4.5); the owner path fails explicitly at the
  same bound (§5.2).
- The seat's «у черзі»: the `queued` step while held (G3).
- Refusals that need no wait (member limit, definite no capacity, the
  hand-off, the tool-loop budgets, the owner hard cap, per-call timeouts)
  come back at once, so the chat gets those errors as soon as they are known
  (§4.6).
- The specification's acceptance list maps to §7: one failing-first test per
  numbered item, a test per busy cause for both endings with the concurrency
  bound, the non-renewal test, the lateness probe, and the existing suites by
  path.

## Deferred — not currently justified

- **Durable holds across a release succession.** Writing held requests to
  the run ledger with a `held` flag would let the successor continue them,
  but every ledger reader counts rows as slots, and holds there are rare
  races. Demotion declines them `busy` at once (§4.5).
- **Compact requests.** `compact.ts:55`, `:57`, `:63` and `:70` keep their
  immediate `busy` declines; the service keeps compact out of the 120 s cap.
- **Converting every synchronous relay-store lock** (pairing, routes,
  switches, the poller sweep, owner cancellation custody) to the async wait.
  Viewer event-loop stalls belong to lane 8478db36.
- **An explicit failure for running work at about 110 s**, and **stopping it
  locally at the deadline.** The service ends the lease at its own bound and
  posts its error within 5 s; doing it locally would cut 10 s of answer time
  and cut runs that a service without the total deadline accepts.
- **A minimum useful run time before admitting a request late in its window.**
  A request admitted at 105 s gets 15 s; the service's error follows if it
  does not answer.
- **Re-reading pause and disable during a hold.**
- **A legacy-notes «у черзі»** for services without `progress_steps`.
- **Showing held requests on the settings page** (the running count per target
  stays as is; the last progress label shows `queued` raw, like the other step
  ids).
- **Changing `structuredSpawn.ts`'s 30 s admission and first-message bounds.**
  They serve every spawn; the owner boundary applies the request budget
  (§5.2).

## Notes for the paired service's seat

1. Hold the deploy of PR #3597 until this install runs S0 (G2), or deploy it
   with `RELAY_CLAIM_WINDOW_SECONDS` of 60 or less and a stall window that
   never goes below 10. Otherwise every relayed request is declined
   `invalid_request`: a claim window above 60 refuses every request, and a
   remaining-budget stall window below 10 refuses requests claimed in their
   last ten seconds.
2. `deadline_at` (arrival + 120 s, RFC 3339 UTC) is read from the top level
   of the claimed request, the provisional place. Tell us the reviewed name
   and place; on our side it is one constant (§3.1). An absent, unparseable,
   past or far value falls back to our receipt + 120 s and never refuses the
   request (§3.2).
3. Add `queued` to `RelayStep` and a «у черзі» variant to `relay-step`; until
   then those heartbeats show nothing and stay valid (G3).
4. After S1 (the fixed heartbeat grid) runs on this install, the gaps we
   cause are the interval plus milliseconds, so the interim ~13 s tolerance
   can tighten whenever you choose (§5.4).
