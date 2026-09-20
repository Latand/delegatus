> Product requirement: messages sent to an agent should arrive promptly, and answers should render from the first streamed delta. The structured host uses JSON-RPC. A deployment with a small state feels immediate; the measured deployment has substantial publication delay. One outgoing message also changes presentation repeatedly as delivery progresses. The design should keep one stable message row with a clear confirmation state.

Source: product requirement and bounded measurements recorded on 2026-09-20.

This document preserves the original measurement and design record. References to the measurement stage and its capture restrictions describe that earlier investigation. Slice 1 implements only the acknowledgement change; browser capture, admission and message-row work remain separate slices.

# Send latency and message states

## 1. Measurements and their limits

Observed on 2026-09-20, approximately 15:43–15:54 UTC. Historical source references below are at `a641fd597a2691c9f3dc7a710db9cc1943f6e0cf`. Checkout HEAD and the local `origin/main` reference agree. Both serving container image tags identify that revision. The journal reports session-host metadata schema version 1 and `session_host_metadata_ready=1`. This establishes that indexed selection is available on the serving release; it does not independently establish the exact 15:17 cutover minute supplied in the assignment.

| Observation | Result | What it establishes |
|---|---:|---|
| Recent send A: reservation → user transcript record | **3,519 ms** | The engine had recorded the input by this point |
| Send A: user transcript record → journal `delivered` | **8,507 ms** | Delivery reporting lagged already-recorded input |
| Send A: reservation → durable delivery-record completion | **13,229 ms** | Registry settlement elapsed time, including delayed reporting |
| Send A: first canonical assistant message → first journaled assistant delta | **4,691 ms** | The first published delta was already behind canonical assistant text |
| Send A: reservation → first journaled assistant delta | **16,678 ms** | Combined admission, engine work and publication delay; no browser paint timestamp |
| Full snapshot GET, 15:47:36.202 UTC | **2,854.8 ms; 11,666,824 bytes; HTTP 200** | One successful loopback request |
| Summary snapshot GET, 15:51:38.453 UTC | **788.9 ms; 7,017,545 bytes; HTTP 200** | One successful browser-bootstrap-shaped request; headers at 764.7 ms |
| Runtime SSE, starting 15:52:11.136 UTC | **15 events in 7,942.3 ms** | The production push path worked during this bounded observation |
| Journal timestamp → SSE HTTP reader, those 15 events | **31.8 / 85.8 / 1,118.3 ms min / median / max** | Post-journal transport observation; excludes rendering and pre-journal delay |
| Structured timeout emissions, 15:37:00–15:47:00 UTC | **33** | The supplied “about four per ten minutes” does not describe this window |

The three largest measured delay exposures to remove are **8.507 s of stale delivery reporting, 4.691 s of late first-delta publication, and a 2.855 s global snapshot request**. They overlap, come from different observation boundaries, and must not be added into a promised improvement. The snapshot request is an independent probe; it supplies no timed subspan of send A. Neither reporting gap proves that all of its duration has one cause.

### Collection method

Production was read through bounded container logs, two successful snapshot GETs, one SSE GET lasting under eight seconds, SQLite connections opened with `mode=ro`, and a bounded transcript tail. An exploratory `/api/health` GET returned 404 in 9.2 ms and supplies no health evidence. No production send, process control, configuration change, state repair or application store constructor was used. No messages were sent to other agents.

The historical-send fallback was used. This session has an active structured turn and no browser submission observer; a self-send on the normal `interrupt-active` route would interfere with that turn without supplying the missing browser timestamps. Send A is a recent completed `send`, with one delivery attempt and `interrupt-active` policy. Its browser-versus-MCP origin is not recoverable from the retained command fields inspected here. Consequently it supports the common structured delivery path. Browser POST timing remains unmeasured.

Correlation used the delivery record's operation, conversation and turn identities, journal sequence and native assistant item identity. In memory, the reserved input was confirmed inside the native user envelope. No input, assistant text, account identity or machine path is reproduced. The transcript read was limited to 786,432 bytes; the returned complete-line tail was 780,662 bytes from a 10,797,082-byte transcript. Its timestamps record producer events; filesystem visibility times were not measured.

SQLite observations were short, indexed or bounded by a recent sequence range. Initial schema inspection determined column names. Event reconstruction read sequence 9,220,800 through 9,221,700, then narrowed to the first relevant events. No full transcript parse or long sampling loop was performed. Base SQLite file sizes below exclude WAL files.

**Evidence gap:** browser submit, HTTP response arrival, raw host notification arrival and first browser paint were not timestamped. No 390 px or 1280 px screenshots were captured. Section 4 is explicitly a source-derived rendering inventory, with no claim that its descriptions are inspected screenshots or that its durations are browser dwell measurements. These missing acceptance measurements require a retry; this document is not evidence that the full measurement contract passed.

### Corrected timeout comparison

The earlier `docs/audits/agent-path-latency-2026-09.md`, read from local branch `pipeline/viewer-measured-latency-and-contention-a-665935af`, reported append p50 **3,893 ms** and snapshot p50 **10,205 ms** for **timeout emissions** in 12:15–12:50 UTC. They were not medians of all successful append/snapshot calls. Its isolated SQL experiment reduced the sum of three selection-query medians from 1,030.08 to 77.56 ms. That experiment supports the index mechanism; it cannot establish the current end-to-end gain.

The current fixed ten-minute window contains 64 log lines and 33 matches of `request timed out method=(\S+) elapsedMs=(\d+)`. Secondary queue/synchronization errors were excluded from that count. An initial rolling read found 39 timeout-related lines; the structured fixed-window count replaces that preliminary figure.

| Method | Timeout count | Minimum ms | Median ms | Maximum ms |
|---|---:|---:|---:|---:|
| append | 17 | 3,192 | 4,860 | 5,686 |
| snapshot | 7 | 10,000 | 10,380 | 13,727 |
| effect-batch | 3 | 3,192 | 5,096 | 5,591 |
| native-queue-read | 3 | 3,192 | 3,194 | 3,198 |
| command | 1 | 3,267 | 3,267 | 3,267 |
| operation-transition | 1 | 3,216 | 3,216 | 3,216 |
| operation-projection-ack | 1 | 3,675 | 3,675 | 3,675 |

The bounded runtime-host log read returned no lines. Successful RPC durations are not logged in these records. Ordinary socket calls have a 3,000 ms deadline; snapshots have 10,000 ms (`src/lib/runtime/client.ts:125`, `:15`). Timers firing substantially later also establish delayed timer service in the Viewer. Assigning all elapsed time to runtime-host SQL would be unsupported.

### Previous work checked

Transcript searches used “journal index,” “snapshot latency,” “send render latency,” “liveTurn delta slow,” and “agent-path-latency,” project-scoped and unscoped. The first project-key guess returned nothing; subsequent scoped searches used the discovered canonical project. The journal-index review's 14:40:35 UTC final message was read through `conversation_messages`. It supports selection compatibility and invalidation review, and expressly says its review was code inspection. Its mechanism was checked against current `journal.ts:2492` and the live metadata-ready flag.

The earlier latency audit was then read from the local branch above after its remote-tracking reference proved absent. Its global append-consumer coupling still exists at `src/runtime-host/host.ts:43` and `:107`. Searches for a prior liveTurn/slow-delta solution returned no relevant answer. A separate continuation review hit concerns restart recovery and is not evidence for this send path. Earlier original-key/outbox work remains a constraint: acceptance does not prove engine delivery, and an uncertain result never authorizes a fresh-key resend.

## 2. Send A: hop table

All times are UTC on 2026-09-20. “Unobserved” means no timestamp exists in the inspected evidence; it does not mean zero latency. Rows are ordered by actual evidence time rather than forcing the requested hops into a serial narrative.

| Hop | Timestamp | Measured interval | Source boundary and interpretation |
|---|---|---:|---|
| Browser submit and optimistic placement | Unobserved | Unobserved | `src/components/TmuxComposer.tsx:3771` → `:2465`; queue submission stores the local message before dispatch |
| Browser starts POST `/api/runtime/send` | Unobserved | Unobserved | `src/components/conversation/OutboxDispatcher.tsx:38`; `src/hooks/useRuntime.ts:339`; `src/app/api/runtime/send/route.ts:8` |
| Admission resolves target | Unobserved | Unobserved for A | `src/lib/runtime/structuredMessageDelivery.ts:755` awaits a global snapshot before finding one session; independent full GET measured 2,854.8 ms |
| Delivery record reserved | 15:44:33.156 | Reference t=0 | `structuredMessageDelivery.ts:1053`, `registry.holdDelivery`; `createdAt` |
| Delivery record assigned | 15:44:33.320 | **164 ms** after reservation | Reservation's `assignedAt`; no separate lock-wait instrumentation |
| Runtime command committed as `queued` | 15:44:35.215 | **2,059 ms** after reservation | `structuredMessageDelivery.ts:1137`; `src/runtime-host/host.ts:112`; journal receipt seq 9,221,221. This uses the `command` RPC; its journal append is internal |
| POST returns accepted | Unobserved | Unobserved | `src/lib/runtime/http.ts:314`/`:317`: held/queued returns 202 after durable admission. HTTP acceptance follows reservation on this route |
| Queue transitions to `delivering` | 15:44:35.406 | **191 ms** after queued | `src/lib/runtime/structuredDeliveryQueue.ts:1074`; receipt seq 9,221,223. This precedes the engine call and its ownership fence |
| First native user transcript record | 15:44:36.675 | **1,269 ms** after delivering; **3,519 ms** after reservation | Native user response record; reserved input matches its envelope. The host has consumed the input by this record |
| Host-state publication in journal | 15:44:45.130 | **8,455 ms** after native user record | `src/lib/runtime/structuredDeliveryController.ts:507`, `:1116`; `session-status` seq 9,221,228. Publication time does not establish when the host first became ready |
| First canonical assistant message | 15:44:45.143 | **8,468 ms** after native user record | Native assistant response record, phase `commentary`; same item identity as the subsequent journal `agentMessage`. This is the first assistant text; final-answer completion follows later |
| Runtime journal says `delivered` | 15:44:45.182 | **9,776 ms** in delivering; **8,507 ms** after user record | `structuredDeliveryQueue.ts:1191`; receipt seq 9,221,229 |
| Journaled turn-start event | 15:44:45.213 | **31 ms** after delivered | `structuredDeliveryController.ts:1133`; seq 9,221,230. It can trail actual native execution |
| Registry records delivery completion | 15:44:46.385 | **1,203 ms** after journal delivered; **13,229 ms** after reservation | `structuredDeliveryController.ts:715` then `:733`; durable record's `deliveredAt` |
| User item published by host-event pump | 15:44:47.599 | **10,924 ms** after native user record | `structuredDeliveryController.ts:1139`; journal item seq 9,221,232 |
| First raw assistant delta from structured engine | Unobserved | Unobserved | `src/lib/runtime/codexAppServerHost.ts:3696`; the event ledger sequences it, but this projection preserves no raw arrival timestamp |
| First assistant delta appended/published in runtime journal | 15:44:49.834 | **4,691 ms** after canonical assistant record; **16,678 ms** after reservation | `structuredDeliveryController.ts:1139`; `src/lib/runtime/engineHostEvents.ts:278`; seq 9,221,242 |
| Browser receives delta; first text paints | Unobserved | Unobserved | `src/lib/runtime/sse.ts:33` → `src/hooks/runtimeBus.ts:144` → `src/components/runtime/runtimeModel.ts:574` → `src/components/LogFeed.tsx:828` |

Journal `occurred_at` and `recorded_at` coincide for these projected events. `projectEngineHostEvent` does not forward an engine arrival timestamp, so equality cannot prove zero upstream delay. `journal.ts:1732` advances the published sequence in the transaction; commit, compaction and waiter notification follow at `:427`. The timestamp does not separately time those operations.

### Serial work and removable waits

1. **Admission:** target ownership → full runtime snapshot → reservation under account mutation lock → command → queue kick. Durable reservation, payload identity and writer fencing must remain ordered before engine dispatch. A keyed session read can replace the full snapshot. Attachment bytes must remain durable before the reservation references them. Unrelated conversation lookups can proceed independently.
2. **Queue:** `DELIVERY_DRAIN_COALESCE_MS=25` (`structuredDeliveryController.ts:69`) coalesces wakes; the explicit admission path calls `drainAfterAdmission` (`:836`). Its 25 ms timer is not automatically added to every send. Drain failures back off to `DELIVERY_DRAIN_MAX_BACKOFF_MS=1,000`. The observed queued interval was 191 ms, so removing a 25 ms coalescer alone cannot explain seconds of delay.
3. **Engine delivery:** claim → `delivering` → optional interrupt/turn-boundary handling → engine send → receipt transition → registry projection. Selected queue/steer/interrupt semantics are required behavior. Reporting latency must not be reported as provider latency. Preserve ordering within a conversation; unrelated conversations should not await its engine turn.
4. **Output publication:** each event waits for `client.append` before the controller takes its next event (`structuredDeliveryController.ts:1130`). The runtime host commits the event, then awaits the shared consumer queue before answering (`host.ts:101`, `:107`). The consumer queue can contain unrelated orchestration work (`:43`). This is an avoidable dependency for already-durable output events. Retry sleeps are an unnamed **100 ms** at `structuredDeliveryController.ts:1142`, after the failed RPC deadline. Keep producer-key idempotency while changing acknowledgement timing.
5. **Rendering:** an already-delivered input or assistant delta must not wait for registry settlement, receipt wording, a board rescan or transcript replacement. Current code already contains transcript/assistant causal settlement (`TmuxComposer.tsx:1884`); preserve it and verify all entry paths actually adopt it.

## 3. How output reaches the feed

There are two independent SSE paths. No WebSocket is used in the inspected browser feed path.

| Path | Mechanism | Added waits and measured evidence |
|---|---|---|
| Structured live output | Engine JSON-RPC notification → sequenced engine event ledger → controller's per-host event pump → runtime journal → `/api/runtime/stream` → runtime store → live feed row | Serial append acknowledgement described above; server waits for journal events and wakes on publication. Current SSE probe: journal timestamp to HTTP reader median 85.8 ms, max 1,118.3 ms |
| Canonical transcript | Transcript write → `fs.watch` → bounded tail read → log SSE → `useLogTail` → feed parse and identity reconciliation | `src/lib/logTailStream.ts:52`, `:156`: normal catch-up delay **0 ms**; actual I/O/parse/paint time unmeasured |
| Transcript watcher recovery | Periodic stat when watching fails or misses growth | `DEFAULT_RESTAT_MS=5,000` (`logTailStream.ts:10`); phase-dependent wait up to one interval plus work |
| Browser log transport fallback | Batched log polling when SSE unavailable | `POLL_MS=1,200`; reconnect debounce **300 ms**, prompt reconnect **40 ms** (`src/hooks/logBus.ts:6`, `:17`) |
| Runtime initial connection/reset | Fetch summary snapshot, then open cursor SSE | `runtimeBus.ts:31`, `:270`; measured bootstrap-shaped GET **788.9 ms**, 7.0 MB |
| Runtime degraded transport | Snapshot poll after connection degradation | `DEGRADE_AFTER_MS=15,000`; `FALLBACK_POLL_MS=10,000`; SSE retry **60,000 ms** (`runtimeBus.ts:46`) |
| Runtime store notification | Accumulate changes over one notification timer | `SUBSCRIBER_NOTIFY_MS=16` (`runtimeBus.ts:56`); approximately 0–16 ms scheduling exposure, excluding a blocked main thread and paint |

The runtime server's **15,000 ms heartbeat** bounds the idle waiter duration (`sse.ts:5`, `:33`). Browser runtime reconnect backoff is **500–8,000 ms**, and silence detection is **20,000 ms** (`runtimeBus.ts:41`). Likewise, the log stream's 15-second heartbeat is not its normal output cadence.

The SSE probe began at the current SQLite published sequence and read at most 256 events for a seven-second target window, ending in 7.942 seconds because of a blocking read. It observed nine items, three limit events, one receipt, one session-status and one edge event. It observed no assistant `delta`; do not label its median “delta-to-screen.” First event arrival at 1,329.7 ms includes waiting for a new event.

**A live assistant delta can reach the screen before any transcript rescan.** `LogFeed.tsx:304` resolves the runtime session by conversation identity, `runtimeModel.ts:574` appends delta text, and `LogFeed.tsx:828` builds the live rows independently of `useLogTail`. `liveTurnHandoff.ts` reconciles canonical item identities. The measured send shows the reverse race: canonical assistant text preceded the first journaled delta by 4.691 seconds. Building another live-output transport would duplicate an existing mechanism; remove upstream blocking and prove the existing path.

## 4. Outgoing-message rendering inventory

### Capture status

The existing appropriate driver is `src/components/conversation/conversationWindow.browser.test.tsx`, using `conversationWindowEvidence.fixture.tsx` and the shared `issue1695BrowserHarness.ts`. Its current cases exercise queued launch, receipt-delivered, transcript retirement and failure surfaces. It does not provide a configurable fake-host sequence covering one ordinary message's entire lifecycle.

It writes `.artifacts/issue-1793` and `evidence/issue-1793` at lines 51–52 and 77, while the shared harness writes a bundle at `issue1695BrowserHarness.ts:20`. This task permits writing only this document and prohibits other repository edits. Adding the missing case or running its unmodified output-writing setup would exceed that explicit fence. It was therefore inspected without execution. The checkout has no local `node_modules` or build; a resolution probe did find React, Playwright and Tailwind in the existing package cache, so missing packages are not established as the blocker. No browser process or fake host was started.

**There are no captured screenshots to describe.** The following descriptions specify source-predicted frames for the required 390 px phone and 1280 px desktop capture. They are not substituted for rendered evidence. A retry should allow temporary capture artifacts and one case in this existing driver, while retaining this document as the only committed output. Recommended default: capture from an isolated export of the post-#1934 revision, with a fake host and no production credentials.

### Inventory and duration evidence

Receipt state and outbox state are different layers. A successful send need not visibly paint every intermediate receipt. React batching and a fast transcript echo can skip states entirely. The durations below describe backend evidence or timer rules; typical browser dwell times remain unmeasured.

| Rendering/condition | Component and source | Duration evidence | User value |
|---|---|---|---|
| Newly submitted, locally queued bubble; clock and cancel | `TmuxComposer.tsx:2465`; `OutboxBubbles.tsx:128`, `:223` | Until dispatcher can run; no fixed poll in `OutboxDispatcher.tsx:38`; browser dwell unmeasured | Immediate placement is essential; queue internals are noise |
| Sending/delivering bubble; amber spinner | `OutboxBubbles.tsx:86`, `:112`; dispatcher changes outbox state | Send A's journal delivering interval was 9.776 s, but this does not determine the bubble's duration | One quiet progress affordance is sufficient |
| Accepted hold while waiting for host | `OutboxBubbles.tsx:68`, `acceptedHeld && delivering` | Until receipt/host resolution; no measured sample | Reason is useful when inspected; a new bubble style adds noise |
| Account-switch hold | `OutboxBubbles.tsx:73`, `switchHold` and pending entry | Account migration duration; unmeasured | Useful reason, same progress location |
| Waiting for turn, host, or handover; clock, warning/danger text and elapsed wording | `OutboxBubbles.tsx:87`; `deliveryWait.ts:131` | Send A queued 191 ms. Other sends may legitimately wait for an active turn. `DELIVERY_WAIT_TICK_MS=15,000`; no population median | Turn-boundary choice matters; repeated elapsed/status redraws add noise |
| Outcome unknown; warning triangle | `OutboxBubbles.tsx:63`; `deliveryUncertain` | Until authoritative receipt/echo/recheck. Parked receipts also cross `DELIVERY_UNCERTAIN_MS=30 min`; age does not prove non-delivery | Preserve uncertainty and recovery; avoid treating a timeout as definite failure |
| Failed or missing attachment; danger reason, retry/cancel or recovery control | `OutboxBubbles.tsx:120`, `:207`, `:235` | Until explicit recovery; unmeasured | Actionable failure is informative |
| Delivered but awaiting echo; muted delivered label | `OutboxBubbles.tsx:126`; `outbox.ts:286` | Send A's user echo predates delivered; this frame could be skipped. Fallback retention: `OUTBOX_DELIVERED_TTL_MS=10 min`; `OUTBOX_MTIME_GRACE_MS=2,000` | Success wording is redundant after causal arrival |
| Canonical user bubble replaces local bubble; chip gone, copy control present | `outbox.ts:1616`; `LogFeed.tsx:1082`; `FeedItem.tsx:219` | Until history leaves view; replacement time unmeasured | Stable message is the required final presentation |
| Receipt summary/disclosure beside composer; accepted/queued/delivering/unknown and attempt history | `TmuxComposer.tsx:1853`, `:429`, `:695`, `:4217` | Driven by receipts and the 15-second wait clock; visibility also depends on filtering and disclosure | Diagnostics belong behind one message's detail affordance; avoid a second routine status surface |

Source-predicted phone frames: the local bubble has a **75%** maximum width, desktop-style horizontal padding and **0.8 opacity** (`OutboxBubbles.tsx:180`). Its transcript replacement uses **86%**, 12 px horizontal padding, 9 px vertical padding and mobile text sizing at full opacity (`FeedItem.tsx:230`). This is an 11-percentage-point width-cap change; the actual pixel delta depends on the feed's inner width and message length. It must not be reported as 42.9 measured pixels at a 390 px viewport. Local attachment counts can also change into canonical attachment previews. Long canonical input uses a disclosure after 500 characters (`FeedItem.tsx:220`), introducing another potential geometry change.

Source-predicted desktop frames: both bubbles cap at 75%, but the local bubble still has 0.8 opacity and a status line. The canonical message has full opacity and its copy control. Even without a width change, opacity, status-line height and controls can change. Failure actions use 24 px controls with a 44 px coarse-pointer override (`OutboxBubbles.tsx:214`); viewport width alone does not prove touch target size. The retry capture must emulate touch for the phone and inspect overflow, overlap, readable reasons and control bounds.

## 5. Why state size matters

| Cost | Current evidence | Scaling |
|---|---|---|
| Runtime session selection | 5,516 metadata rows: 892 active-status and 4,624 inactive; index ready | Historical JSON host extraction has been removed from selection. All active-status bodies plus 128 inactive bodies are still selected and parsed (`journal.ts:2492`) |
| Snapshot construction/transport | Summary: 1,020 sessions, 113 attentions, 74 operations, 2,689 edges, 52 deployments | Selected session bodies, receipts, edges and deployments determine serialization and transfer work. Session portion alone was 5,207,597 bytes |
| Snapshot cache | `journal.ts:1073` invalidates on ordinary database changes | More active event writers reduce cache reuse. Full and summary scopes have distinct caches |
| Registry materialization | 9,551 conversations, 6,468 entries, 2,196 held deliveries, 8,269 receipts | `sqliteRegistryStore.ts:322` reuses a revision cache; on a miss, `:752` materializes all collections. Row caching helps parsing but does not make every full projection a keyed read |
| Per-event projection | Journal base file 313,487,360 bytes; registry base file 99,618,816 bytes | Delta/item handling rewrites the relevant session projection; larger retained session bodies add work. File size alone does not measure active working-set cost |
| Retained event replay | `published_seq - anchor_seq = 20,000`; replay max 128 events (`journal.ts:1090`) | Bounded event tail; ordinary snapshot does not replay the entire journal |
| Shared consumers | Global promise chain in `host.ts:43` | Sensitive to event traffic and consumer duration across conversations, even when the next event is a small delta |
| Browser parsing/rendering | Multi-megabyte summary; frame notification 16 ms | JSON parse and store installation scale with payload; feed work also depends on visible history, markdown and mounted panes. No browser CPU profile was collected |
| Fixed waits | 25 ms coalescing, 100 ms retry sleep, 16 ms notification; degraded 1.2/5/10 s paths | Independent of database size; their frequency can rise when overloaded paths fail |

The summary's remaining sections measured 267,525 bytes of attentions, 38,473 bytes of operations, 898,763 bytes of edges and 604,844 bytes of deployments. These are compact UTF-8 JSON field sizes from one response. Active-status projection count is not a count of verified live OS processes.

The small-state server report is consistent with cheaper snapshots, fewer registry invalidations and less consumer contention. It is not a controlled comparison: no observations from that server were available. Hardware, event rate, browser state and network can also differ. The recommendation follows measured unnecessary work on this server and does not depend on state size being the sole cause.

## 6. Target design

### One message, one row

Use the current durable outbox identity and receipt machinery. Create the message row synchronously at submit, in its final conversational position, with the same user-bubble renderer, width, opacity, markdown, attachment presentation and controls that its canonical form will use. Reserve the small progress slot so removing it causes no reflow.

| User-visible state | Appearance and behavior | Internal facts retained |
|---|---|---|
| Message present, confirmation pending | Final-looking bubble plus one quiet, stable progress affordance; accessible description says confirmation is pending | local submission, reserved, pending, accepted hold, queued, delivering, recovering, unknown |
| Arrival confirmed | Same row and body; progress affordance clears | Matching transcript echo, matched assistant-turn proof or authoritative delivered receipt |
| Proven failure requiring action | Same row/position; concise reason plus exactly one primary action | Refused/rejected or safely failed delivery; retain original operation and payload |

Keep transport state as evidence under the affordance's disclosure. Do not display accepted → queued → delivering → delivered as successive routine labels. Uncertain delivery remains pending confirmation; a transport timeout never becomes “not sent.” When automatic recovery cannot establish fate, the quiet affordance offers **Check status** using the original identity. After proven failure, select the one useful action: **Retry** for safe same-operation replay, **Reattach** for missing bytes, or **Edit** for a correctable refusal. A true unresolved outcome must preserve payload and identity across remounts.

Reconcile a canonical echo into the existing row's key. Bind the existing client-message/idempotency key to its operation, turn and native item identities as evidence arrives. Keep existing occurrence/watermark protection for historical records that lack a durable identity; identical text alone must never merge two submissions. Preserve author provenance and selected context. Do not replace the whole node when the transcript catches up.

The message enters the feed immediately for keyboard, send-button, quick reply and completed voice submission. Attachments may require preparation and upload, but their pending bytes belong to the same row. Remote/MCP/bridge sends have no local browser submit; their durable admission event creates the row when observed, with the same rendering. A closed client reconciles through the existing snapshot/receipt path when opened. Native queue, steer, interrupt, inject and legacy paths keep their semantics; a queued-next-turn choice cannot promise immediate engine consumption, and injection cannot promise an answer.

### Render the first host delta

Retain the existing runtime SSE and liveTurn projection. After durable journal publication, acknowledge eligible engine-event appends without making the producer wait for unrelated orchestration consumers. Run consumers from their existing durable cursor and preserve startup replay. Keep explicit command/projection barriers where their callers require them. Inspect every append caller before changing its acknowledgement contract; a caller that requires downstream completion needs an explicit barrier.

Maintain per-producer ordering and idempotent retry. The implementation should first remove the unnecessary consumer wait for event kinds with no orchestration effect; then measure whether the same producer is still blocked behind an earlier terminal event. Do not silently skip or reorder that terminal event. A general durable-append acknowledgement for engine publications is the recommended default if caller tests show they require only commit.

Apply the first nonempty assistant delta to the existing stable response identity and schedule its paint within one frame. Transcript arrival enriches/reconciles that row using existing native-item claims. It must neither suppress unseen live text nor briefly render both copies. Provider inference time remains external to this UI target: “render at once” starts at first host output arrival.

### Proposed success targets

For a warm visible feed, healthy live host and small text send: submit → user bubble **≤ one frame**, server admission **p95 <250 ms**, raw host delta → first visible text **p95 <100 ms** on loopback. Maintain one user row throughout; zero body width/opacity/position changes across nonfailure receipts. Measure these targets with background state shaped like production. Report provider wait, intentional turn-boundary wait, upload time and restart recovery separately. These budgets are proposed acceptance criteria and have not been demonstrated here.

## 7. Ranked slices and ownership

At inspection, PR #1934 is **open**, head `031f6ac80a978a4ac0d6cd529b069afbfaf4532a`, and has no merge timestamp. Its changed-file list includes the composer, outbox bubbles, conversation browser fixture/driver, delivery wait model, runtime hook, HTTP admission, structured message delivery, registry and SQLite store. Dependency extends beyond the two composer files mentioned in the assignment. Recheck its final merged diff before implementation.

| Rank / slice | File fence | Expected gain and acceptance | Parallel work |
|---|---|---|---|
| 0. Close measurement gaps | Existing `conversationWindow.browser.test.tsx` and fixture; narrow timestamp hooks at existing submit/admission/engine/SSE/paint boundaries | No latency gain. Capture one fake-host message at 390 and 1280 through success, queued-turn, held-host, lost acknowledgement and safe failure; record state transitions, stable row identity and frame timestamps. Required to turn the inventory into rendered evidence | Timing schema and read-only backend analysis can proceed now. Driver/composer changes wait for #1934 |
| 1. Release output publication from shared consumer completion | `src/runtime-host/host.ts`, existing host tests; `src/lib/runtime/structuredDeliveryController.ts` only if producer-side changes are necessary | Addresses the measured **4.691 s stale first-delta exposure**, and may reduce delayed receipt/host publications. No promised full recovery of that interval. Test a deliberately slow unrelated consumer: committed output publication and producer progress remain prompt, consumer replay still settles exactly once | Independent of the #1934 files. One owner for controller changes; preserve explicit operation projection fences |
| 2. Make admission read one conversation | `src/lib/runtime/client.ts`, `contracts.ts`, `src/runtime-host/host.ts`, `journal.ts`; after #1934, `structuredMessageDelivery.ts`, `http.ts`, `registry.ts`, `sqliteRegistryStore.ts` and focused tests | Remove the global snapshot dependency measured independently at **2.855 s full / 0.789 s summary**, plus avoid population-sized registry work on the narrow path. Do not promise those exact savings per send. Hold response shape constant for the target conversation as unrelated state grows; target p95 admission <250 ms | Keyed RPC design/tests can proceed alongside slice 1, but both touch `host.ts`: assign one owner or land its small RPC change first. Admission/registry integration follows #1934 |
| 3. Unify user-row presentation and echo adoption | After #1934: `TmuxComposer.tsx`, `conversation/outbox.ts`, `OutboxBubbles.tsx`, `LogFeed.tsx`, `feed/FeedItem.tsx`, existing `liveTurnHandoff.ts` only as needed; existing browser driver/fixture; affected locale sets | Remove routine status churn and the phone's 75%→86% cap change. Causal arrival can clear progress during the measured **8.507 s** interval when the delivery receipt was stale. Existing echo retirement already does part of this; the expected gain is consistent coverage and stable rendering; engine execution time is unchanged | Can run alongside backend work after #1934 and after agreeing row/operation identity. Keep all shared composer files in one lane |
| 4. Reduce remaining bootstrap payload only if still material | `journal.ts`, snapshot route, `runtimeBus.ts`, focused snapshot/store tests | Current browser bootstrap is **7.0 MB / 788.9 ms** in one probe. Prefer narrow fields and existing summary semantics; measure exact bytes and reconnect time before choosing further scope | Shares journal/host files with slice 2: sequence integration. It is optional if the warm-send and first-delta goals pass |

The measurement retry needs narrowly authorized temporary capture outputs. It must reuse the existing driver, isolate HOME/config/state/provider homes, bind fake services to port 0 and clean up only its own recorded process handles. It must not exercise sends against an user conversation. The current stage did not create that infrastructure.

For the hop trace, record monotonic durations within each process and UTC stamps for correlation. Carry operation and native item identities without bodies. Required marks: submit, HTTP start/response, reservation commit, command commit, engine write/ack, engine delta received, event published, browser event received and first painted text. Measure host commit separately from append-response/consumer completion. Do not derive one mark from another or copy journal time into raw-engine time. This can be a bounded diagnostic mode over existing drivers, with no tracing service.

## 8. Decisions and deferred scope

Recommended defaults for unresolved choices:

- Preserve the existing send policy chosen by the user. The normal browser route currently defaults to `interrupt-active`; speeding delivery does not authorize silently changing queued messages into interrupts.
- Keep one quiet confirmation affordance and hide routine receipt vocabulary. Treat uncertainty as pending verification, preserving original-key recovery. Use proven failure plus one action for the exceptional appearance.
- Reuse SSE, outbox storage and native identity reconciliation. Add a small shared bubble view and a bounded row projection only where current components cannot share presentation.
- Require the missing browser capture and raw-host/paint marks before claiming the performance targets. A historical receipt trace cannot establish a browser median or viewport correctness.

### Deferred — not currently justified

- A replacement WebSocket transport, a second transient output bus, a new durable message database, a general state-machine framework or an external tracing service. Existing primitives cover the requirement.
- Global timer reductions or longer RPC timeouts. The largest observed spans are seconds; removing the 16 ms notification batch first has little evidentiary support, and extending timeouts hides pressure.
- Broad journal retention changes, deleting histories, account-state cleanup or restarts. The new metadata index is active, and the event tail is bounded. Those actions are outside this task and require separate evidence and authority.
- Parallel sends within one conversation or reordered event publication. They would change semantics and weaken delivery evidence.
- Full redesign of legacy terminal rendering, voice generation latency, pipeline orchestration or every board projection. Carry the same message presentation contract through their existing entry points; expand work only when a measured path fails it.

No ADR is added: these recommendations use existing storage and transports and can be implemented in reversible slices. The acknowledgement-contract change needs focused caller/recovery proof before landing.

## 9. Validation against the originating requirement

The proposed design directly serves immediate placement, prompt engine delivery and first-delta rendering: narrow the send admission read, remove output's shared-consumer dependency, and keep one stable message row with a quiet progress affordance. Real failure retains a reason and one action. The old transport and original-key safety guarantees remain available.

Measured production delivery/publication lag, current-state scale and source-derived visual differences are documented. The required complete browser hop trace and phone/desktop fake-host capture remain **unfulfilled**. This stage must not claim pass for those acceptance criteria. The next attempt has an exact driver, bounded measurement marks, file fences and recommended defaults; no user product decision is needed.


## 10. Slice 1 implementation and caller audit

The implementation is based on `bf08a6cc781f2a1aa101f599828ca20c85c52dad`, which includes the bounded deployment list (#1941) and staged launch recovery (#1940). It changes the runtime host acknowledgement contract for a closed list of engine publications. The controller continues awaiting every append in producer order and retrying the same event identity.

At that base, `structuredDeliveryController.ts:1130-1143` waits for each append before advancing the engine iterator. `host.ts:101` commits through `RuntimeJournal.append`, then `host.ts:107` waits for `consumeExclusive`; `host.ts:43-50` serializes all consumers on one promise chain. `journal.ts:426-442` commits the event and projections and notifies journal waiters before returning. A slow unrelated workflow consumer therefore delays the producer even after its output is published.

The fast acknowledgement applies only to `append`, session scope, a `codex-app-server` or `claude-broker` producer with an `engine-host:` event key, no operation ID or effect, and one of:

- `turn-started`, `delta`, `item`, `attention`, `attention-resolved`, `limits`;
- `voice-transcript`, `voice-chunk`, `native-queue-changed`;
- `voice-delivery-progress`, `voice-delivery-acknowledged`.

These kinds have no orchestration effect in `consumeRuntimeEvent`. The host enqueues their consumption on the existing FIFO before acknowledging the committed journal event. The host durably registers the orchestration consumer before accepting publications. Completion checkpoints and its contiguous cursor commit together; duplicate detection and startup replay use that cursor. A rejected consumer promise keeps the existing diagnostic and recovery behavior.

`turn-ended`, its normalized terminal aliases, unknown kinds, session-status publications, all `operation` calls, and events carrying operations or effects keep their existing consumer barrier. Terminal wakeup still happens exactly once immediately after a new terminal commit. A producer waiting for that terminal acknowledgement still waits before its next event. This conservative interpretation preserves event identity and order throughout the change; no skip, parallel producer pump or fresh-key retry is introduced.

### Every append entry point checked

Line references in this table identify the base above. Internal journal writes are distinguished from host RPC calls because they do not use the changed acknowledgement path.

| Caller | Publication and decision |
|---|---|
| `src/lib/runtime/client.ts:152` | Generic `append` RPC adapter: signature and response unchanged; eligibility is checked in the host |
| `src/lib/runtime/structuredDeliveryController.ts:1139` | Sequential engine-event pump: the listed publications acknowledge after commit; terminal events retain their barrier; the same projected event is retried after transport failure |
| `src/lib/runtime/structuredDeliveryController.ts:200` | `publishStructuredHostProjection`, called at lines 528 and 556: session-status then files revision; retains its barrier and ordering |
| `src/lib/runtime/structuredDeliveryController.ts:963` | Fallback session-status projection: retains its barrier |
| `src/lib/runtime/structuredSpawn.ts:983` | Dead-spawn session-status projection: retains its barrier; source unchanged |
| `src/lib/agent/spawnCommand.ts:1150` | Legacy spawn lineage `edge.created`: retains its barrier |
| `src/lib/session/titleEvents.ts:44` | Ordered title update and files revision: retains both barriers |
| `src/lib/runtime/filesRevision.ts:23` | Serialized files-revision publication: retains its barrier |
| `src/runtime-host/hostRehearsalRun.ts:221` | Direct append RPC for rehearsal session-status seeding: retains its barrier |
| `src/lib/runtime/client.ts:153`; `src/app/api/runtime/operations/route.ts:21`; `src/lib/agent/spawnCommand.ts:1102` | `operation` shares the host branch; generic operation and legacy spawn intent retain their barriers |
| `src/runtime-host/host.ts:62` | Consumer-produced flow/workflow/task projection: direct journal append and recursive consume stay inside the consumer barrier |
| `src/runtime-host/legacyScheduler.ts:40` | Direct journal files revision: unchanged |
| `src/lib/runtime/fixtures/releaseHandoverIncumbent.ts:26-27`, `failedLegacyBufferProjection.ts:30`, `packagedStartupSeed.ts:205`, `composerPayloadRuntime.ts:185` | Fixture adapters and seeds append directly to private journals; unchanged |

Other `.append` matches write engine event stores, buffers, DOM nodes or form data. Test append calls exercise the journal or host APIs above. Commands, operation transitions and explicit `operation-projection-ack` fences remain unchanged.

### Local verification

The initial regression test deliberately occupied the orchestration queue with a 500 ms unrelated workflow consumer. Before the fix the delta acknowledgement took **501.96 ms** and the prompt-ack assertion failed. With the fix the same test took **2.05 ms** and passed while the unrelated consumer was still running. These are single local test observations, independent of the historical production timings in sections 1-3.

The tests also verify both producer kinds and every allowlisted kind, retention of terminal/operation/unknown-event barriers, exactly one ordered checkpoint per event despite same-key retry, a serial producer holding its next turn until terminal projection, and a process killed after acknowledgement but before consumption. Reopening that private SQLite journal recovers its events in sequence; another recovery and producer retry create no second event or checkpoint. Existing journal tests cover consumer failure recovery and terminal projection behavior.

### Durable consumer retention continuation

The authorized continuation includes `src/runtime-host/journal.ts` and its tests. The earlier two-event retention regression reproduced after merging current main: a blocked consumer lost its workflow event and acknowledged deltas before restart.

Each registered consumer now has a durable contiguous completion cursor. Registration starts at the retained anchor and never resets an existing cursor. The host registers orchestration before accepting writes. Every newly committed event lies beyond those cursors and is therefore retained as soon as its append transaction commits. The registration persists independently of the host object, so startup writes before host reconstruction respect the same obligation.

Compaction stops at the slowest registered cursor and keeps a contiguous, hash-verified tail. The event window can grow while a consumer is blocked; it shrinks on compaction once all consumers release the prefix. No timeout or size cap discards unconsumed events. A consumer must be registered before publications it needs are admitted; registration cannot restore data removed before registration or upgrade.

An event's completion checkpoint and cursor advancement use one SQLite transaction. Recursive projection completion can leave holes, so advancement stops before the earliest uncheckpointed event. Ordered, paginated recovery skips durable completions. The host also checks the cursor on a retried producer receipt after compaction removed its individual checkpoint. Existing consumer side-effect idempotency and quarantine behavior are unchanged.

The repeated local slow-consumer experiment measured **500.67 ms before** on current main's host and **0.51 ms after** with durable retention. Both runs used the same 500 ms consumer and isolated state. These are local append-acknowledgement observations; they do not establish browser paint latency or the later slices' performance targets.

Crash coverage now includes acknowledged output and a pending terminal event under a two-event window. A second process-level test registers consumers A and B, advances A through 140 events while B stops after event 2, and compacts on every write. After killing that child by its own process handle, a startup append occurs before consumer re-registration; B receives events 3 through 141 exactly once in order across recovery pages. A second reopen confirms no pending replay. An injected cursor-update failure proves the corresponding completion checkpoint rolls back, and an out-of-order completion cannot release a gap. A compacted terminal retry after restart does not call its consumer again.

Verification used one test file per invocation, each with an isolated home/config/state root. On Bun 1.3.3, the 19 host/journal and adjacent retention files passed **244 tests**, including all **88** tests in `journal.test.ts`. The additional `nativeQueueJournal.test.ts` crashed Bun before an assertion, reproduced with current main's unmodified host/journal and the official baseline binary. The complete 20-file focused set passed on an isolated Bun 1.4.0 binary: **245 tests, zero failures**. The runtime pin is unchanged.

`bunx tsc --noEmit` exited **0**. `NODE_OPTIONS=--max-old-space-size=8192 bun run build` exited **0**, including the MCP bundle. The local privacy gate and diff whitespace check passed. Self-review covered registration durability, transaction rollback, cursor holes, compaction boundaries, duplicate retry and crash replay; no new source findings remained.
