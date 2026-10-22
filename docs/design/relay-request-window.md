# Owner relay request window

The 2026-10-22 requirement gives an owner relay request ten minutes on the
Delegatus side. A ready answer is sent immediately. The service's absolute
`deadline_at` remains authoritative, including a shorter remaining window.
The service changes its own total wait separately.

## Observation before implementation

The stage started at `d89efd14`. Before editing production code, the following
timers and their callers were read. These references describe that revision;
the lease transport in PR #3192 is a prerequisite for implementation.

| Timer | Source at the starting revision | Effect on ten-minute work |
|---|---|---|
| Receipt fallback: 120 s; valid absolute service deadline unchanged | `src/lib/externalRelay/deadline.ts:5`, `:15` | Absent or malformed deadlines leave only two minutes for admission and delivery retries. |
| Busy decline reserve: 10 s | `src/lib/externalRelay/deadline.ts:6`, `:30` | Holds end at 110 s under the fallback. Keep a bounded delivery reserve as the window grows. |
| Capacity, drain and chat holds: one-second asynchronous rechecks through `declineAt` | `src/lib/externalRelay/runner.ts:296`, `:612`, `:683` | The shared deadline, rather than another fixed hold timeout, limits waiting. Holds take no execution slot. |
| Claim/store contention and reply-chain admission | `src/lib/externalRelay/runner.ts:257`, `:632` | These consume the same absolute request budget; later phases must receive its remaining time. |
| Claim long poll: min(25 s, max_wait_s) + 15 s | `src/lib/externalRelay/poller.ts:353` | Before claim receipt; does not cap an executing request. |
| Initial heartbeat, recurring heartbeat and lease expiry | `src/lib/externalRelay/runner.ts:446`, `:452`, `:489`; `src/lib/externalRelay/protocol.ts:41` | Service controls heartbeat cadence (2–60 s), acknowledgement and stall windows (1–600 s). HTTP calls allow 5 s. A stale acknowledged heartbeat, 404 or 409 `lease_lost` cancels work. No total renewal-count cap. PR #3192 moves transport to its independently scheduled helper. |
| Owner turn hard cap: target minutes (default 30, configurable 1–240) | `src/lib/externalRelay/store.ts:472`; `src/lib/externalRelay/runner.ts:784`; `src/lib/externalRelay/ownerRun.ts:617` | A target configured below ten minutes cuts otherwise healthy owner work. A larger cap currently allows execution beyond the request deadline. |
| Owner host liveness: 30 min stall classification | `src/lib/externalRelay/ownerRun.ts:269`, `:338` | Longer than the request window; terminal host failure can still end a turn. |
| First owner message/admission cutoff | `src/lib/externalRelay/ownerRun.ts:618` | Uses `declineAt` until first-message delivery; confirmed execution clears this admission timer. |
| Owner guidance: reply in about two minutes | `src/lib/externalRelay/ownerRun.ts:94` | Encourages an early answer despite available service time. |
| Owner observation: every 2 s; authorization every 100 ms | `src/lib/externalRelay/ownerRun.ts:627`, `:704` | Polling intervals, with no shorter total answer budget. |
| Host setup: initial message 30 s, admission transport retries 30 s, durable setup 5 min | `src/lib/runtime/structuredSpawn.ts:77`, `:83`, `:92` | Per-launch failure detection. Healthy, delivered work clears setup; these are separate from execution time. |
| Tool index: min(30 s, remaining request time) | `src/lib/externalRelay/toolIndex.ts:42` | One lookup phase; failure falls back to existing tool guidance. |
| Tool loop: 8 rounds, 16 admitted calls, 330 s per pending logical operation; 30 s per HTTP call | `src/lib/externalRelay/toolLoop.ts:9`, `:68`, `:110`, `:117` | These bound individual tool operations and call count, rather than the whole owner turn. They stay unchanged. |
| Owner tool response wait: 20 s; close drain: 30 s | `src/lib/externalRelay/ownerServiceTools.ts:118`, `:128` | `in_progress` permits the same batch to be polled again; not an execution cutoff. |
| Inbound media: min(30 s, request remainder, media expiry); PDF validation 5 s; image validation 3 s | `src/lib/externalRelay/mediaInput.ts:87`, `:175`, `:200`, `:237` | Per-file limits remain; all files also consume the request window. |
| Attachment staging: 60 s; upload: min(30 s/file, request deadline minus 3 s) | `src/lib/externalRelay/attachments.ts:39`, `:277` | A failed upload drops that attachment. Text delivery remains possible. |
| Group history: 4 s including DNS/body, with one poll turn for a late event-loop timer | `src/lib/externalRelay/historyDeadline.ts:23`; `src/lib/externalRelay/ownerHistory.ts:86` | One history read fails readably; the owner can continue. |
| Completion: 5 s per POST; retry backoff 1–5 s through the request deadline | `src/lib/externalRelay/runner.ts:143`, `:166`, `:211` | First delivery is immediate; no wait until the window ends. |
| Stop/recovery: 1 s per control/observation, three attempts, 250 ms between attempts; retry while custody is owed | `src/lib/externalRelay/ownerRun.ts:424`, `:489`, `:601` | Cleanup must retain unconfirmed execution custody. It must not prevent a readable request-timeout completion. |

### Journal evidence, 2026-10-22 UTC

Read the local service journal from 00:00 through 15:35, reconstructing each
multiline relay record, and the paired service API journal available from
13:46 through 15:30. Read only answer-record timing, outcome and delivery
metadata to distinguish accepted answers from failed deliveries. No live
request or message was sent during observation.

The timed owner failure was claimed at 09:16:08.332. Heartbeats 1–15 were
acknowledged; the last acknowledgement was 09:17:59.818. Heartbeat 16 received
HTTP 409 `lease_lost` at 09:18:09.153, 120.821 s after claim receipt. The
answer record ended at 09:18:12.345 as `lease_lost`, with no delivery. The
observed terminating event was the service's lease refusal, which cancels
the owner run in the runner. Its timing agrees with the service's known
120-second total window. The historical service transition reason is absent
from the retained API container journal, so that agreement alone cannot
prove which service transition expired it.

There were no new claims in 15:00–15:35. The latest failed owner request
before the originating report ran 14:32:49.113–14:32:56.278 and completed
`failed:agent_error`, accepted by the service; it did not hit a time budget.
The 14:57 request completed successfully at the service at 14:57:51.191,
before its 14:57:51.757 heartbeat 409. Its recorded answer is accepted.
That 409 is a completion race covered by PR #3192. These records do not
identify which earlier request the operator meant by the reported failure.


## Implementation

`src/lib/externalRelay/deadline.ts:5` now sets the fallback to 600 seconds.
It still reads the raw optional `deadline_at` before schema stripping and
preserves valid absolute timestamps. Absent, malformed and past values retain
the same classifications; a past claim still declines immediately. The shared
fallback also applies to ordinary answer requests and invalid compact claims.
Valid compact requests keep their separate lifecycle.

The ten-second busy reserve stays fixed and leaves room for completion
POSTs with their existing five-second per-call timeout. Existing capacity,
drain and chat holds therefore extend to 590 seconds under the fallback.
They retain their one-second asynchronous rechecks, deadline ordering and
zero execution-slot usage. First-message admission uses the same reserve.

Owner launch, continuation guidance and execution all receive the remaining
request budget. An ordinary target cap below ten minutes cannot shorten an
owner request. Ordinary restricted agents retain their configured cap.
The owner's prompt asks for an answer as soon as its outcome is ready and
explains the ten-minute total and possible earlier service deadline.

The runner also owns a timer at the absolute request deadline. It initiates
cancellation and completes `failed` / `hard_cap` with a fixed readable detail,
without waiting for stop recovery. Unconfirmed execution custody remains in
the run ledger. The late result cannot send another completion. The lease
helper merged from PR #3192 continues renewing until completion; its cadence,
five-second HTTP calls and service-supplied stall expiry are unchanged. Its
guardian checks owner identity every second and release ownership every two
seconds, with one-second shutdown escalation (`bin/helper-lease.mjs:35`).
Those checks end a helper when its owner ends; they impose no elapsed
request lifetime.

The deadline producer is the poller's raw claimed request; the fallback
producer is `relayRequestDeadline`. Consumers are the runner's claim and
admission locks, capacity/drain/chat holds, owner first-message admission,
owner execution and continuation, inbound media, tool-index hydration,
attachment upload and completion retries. `runOwnerAgent` also resolves the
same fallback when invoked directly without a precomputed deadline. Invalid
compact completion uses it; valid compact execution does not. No persistent
schema, service wire field or per-call timeout changes.
