# Runtime snapshot audit and implementation

2026-10-15. Read-only production investigation; source is main at
`45d25ac796d5824713c9fb57d65f57efea61041b`. All file:line references below
refer to that commit unless explicitly marked as a proposed change.

The request is to find every full runtime snapshot reader, measure the cost
on a read-only copy, and specify a reduction that preserves caller behavior.
The audit sections below record the original investigation and payload
experiments. The implementation and paired replay are recorded at the end.
Production configuration, deployment and release approval remain separate.

The strongest first change is to replace population reads by the values their
callers consume. The copied journal produces an **8,914,925-byte full body**
and a **5,154,049-byte summary**. Pipeline liveness fields for the same 830
sessions occupy **98,721 bytes**. In an isolated eight-request burst, the
unmodified client spends **904–1,039 ms parsing 48 full replies**, versus
**7–12 ms** for that projection. Main already forwards HTTP snapshot bodies
without parsing them in the Viewer. Internal object-returning callers remain.

An individual full parse took a median **10.47–11.74 ms** in the serial
experiment. These measurements establish repeated parsing/allocation cost;
they do not attribute the historical 17.840-second loop gap to one JSON parse.

## Evidence scope and limits

The brief names the production journal. The existing read-only procedure in
`docs/investigations/viewer-load-stall-2026-10-13.md:232` also names the user
service journal, selected `/proc` fields, and SQLite backup from a read-only
source. Those were the production access paths used here. No production HTTP
or runtime socket request, profiler, test, signal, startup import, or database
write was issued. In particular, the self-update HTTP read was avoided because
its service snapshot can perform work.

The serving Viewer and host processes point at release `781ecd4c3348`.
Their process start times were 2026-10-15 **00:28:23.200Z** and
**00:28:21.580Z**, respectively; these are process birth observations. The
launcher forwards their output into the service journal, so the journal's
launcher PID does not distinguish the two children. `role` and log sites do.
The source tree's HEAD and origin/main were identical; `git ls-remote origin
refs/heads/main` also returned the pinned SHA at approximately 05:13Z.
`git diff 781ecd4c3348 HEAD` confirms snapshot client, journal, socket, HTTP
route and bus code are unchanged between serving release and audited main.
Pipeline engine and structured-spawn code have other intervening changes;
their inventory below uses main.

Prior work was searched before choosing a measurement:

- Project-scoped transcript queries `runtime snapshot parse` and
  `"snapshot" "journalctl"`, followed by unscoped `"593"`. The search
  reported that common words were ignored; the numeric query recovered the
  relevant investigation. `conversation_messages` opened that transcript's
  2026-10-14T23:43:16.106Z conclusion. The short conversation ID supplied in
  the brief did not resolve, so the indexed transcript path was used. Private
  transcript paths and message bodies are excluded from this document.
- Project-scoped memory query `snapshot parse` had no relevant result.
  Unscoped `runtime snapshot` returned the September runtime-host burst and
  startup-adoption investigations. The relevant memory result was opened by
  ID. It pointed to synchronous snapshot collection and earlier keyed-read
  work; both were checked against current code.
- PR #2905 was read with `gh pr view 2905 --json
  title,state,headRefOid,files` and `gh pr diff 2905`. At observation it was
  open at `45a4277a2b356c106c8226422f7858d54d2cdf7b`. It overlaps
  `client.ts`, `filesRevision.ts`, `host.ts`, `journal.ts`, and `socket.ts`:
  it adds scalar `files-revision` plus timing spans. Its already-completed
  metadata/parse experiments also agree with the scale measured here.

The production log has a material coverage limit. `recordBlockingWait`
logs only samples at least **250 ms** (`src/lib/blockingWaits.ts:64`,
`:99`). `snapshot-transfer` measures first decoded chunk to the beginning
of parsing; it includes delays in scheduling the receiving Viewer
(`src/lib/runtime/client.ts:393`, `:401`). It excludes host collection before
first byte and includes neither a caller label nor request scope in these
records. Encoded success replies return before this instrumentation
(`client.ts:361`). Consequently:

- Logged snapshot bytes and counts are **lower bounds for decoded requests**.
  They omit fast decoded requests, encoded HTTP forwarding, unsuccessful
  partial transfers, and any unlogged calls from other processes.
- Summed transfer durations include overlapping waits and cannot be called
  CPU time, parse time, network bandwidth, or elapsed process blockage.
- Per-caller rates cannot be recovered from these logs. The table supplies
  exact code triggers and any independent durable count available. Historical
  attribution would require telemetry that did not exist. More access to the
  same journal would not supply it.
- No snapshot-parse log at or above 250 ms appears in the examined windows.
  This does not measure cumulative parse time or subsequent garbage collection.

## Production counts

Half-open UTC windows are used when reducing journal timestamps. MB here
means 1,000,000 bytes. Exact queries and collection times are below.

| Window | Slow decoded transfers | Logged bytes | Logged MB/min | Transfer duration sum / maximum | Snapshot parse logs >=250 ms | Loop gaps >=1 s / maximum |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| 2026-10-14 21:54:19–23:29:19, 95 minutes; earlier release | 559 | 3,900,953,885 | 41.063 | 825.951 s / 19.929 s | 0 | 331 / 17.840 s |
| 2026-10-15 00:28:32–05:09:00, 280.467 minutes; current process | 294 | 2,039,098,352 | 7.270 | 574.948 s / 17.869 s | 0 | 407 / 13.309 s |
| 2026-10-15 04:39:00–05:09:00, 30 minutes; current process | 32 | 222,479,938 | 7.416 | 41.972 s / 5.102 s | 0 | 44 / 3.760 s |

The earlier 95-minute window has frame sizes 4,931,732–9,269,156 bytes,
median 5,573,953; the current 30-minute window has
5,140,742–8,986,621 bytes. The earlier peak is 28 logged transfers in one UTC
minute. There are 396 slow host collections in the earlier window and five
in the current 30-minute window; the latter total 1,297.2 ms and peak at
267.3 ms. No serialization sample reaches the log threshold.

The supplied approximate “593 / 912 s / 95 minutes” could not be reproduced
as that exact interval. Extending the first query to 23:35:00Z yields 608
transfers and 896.721 s; the 593rd completes at 23:34:05.164Z with a cumulative
877.689 s. The original conclusion gives approximate bounds rather than the
exact reduction query. Its qualitative 5–9 MB observation is corroborated;
this audit uses the explicit bounds above for numerical claims.

At 22:05:15.874269Z the log contains a 17,840 ms gap with an empty operations
list. At 22:05:16.013473–16.023549Z it logs append and two wait timeouts at
17,988–17,998 ms. The timer is still at `client.ts:336`; ordinary RPCs have
a 10-second deadline (`deadlines.ts:9`), snapshots 30 seconds (`:13`), and
`waitEvents` uses its requested hold plus one second (`client.ts:204`).
This is evidence of late timer execution. It supplies no snapshot caller or
causal stack for that gap.

One caller can also be counted from durable events. The frozen journal
retains all 20,000 sequences 4,706,043–4,726,042, covering
00:43:19–05:10:45Z. In 04:39:00–05:09:00Z it contains **38**
`files.revision` events with producer `structured-spawn-materialized` and
zero `session-title` revisions/title events. That producer is written only
by `filesRevisionEvent` (`src/lib/runtime/filesRevision.ts:6`); each successful
publication awaits a summary snapshot first (`:23`). Thus this caller alone
completed at least **1.267 snapshot reads/minute**, including requests absent
from the slow log. The event producer does not identify which of its four
upstream callers triggered a publication. Failed reads or reads whose append
failed are also absent. Applying the frozen summary size to those 38 reads
would be 6.529 MB/min including framing; that is a fixed-data estimate, not
measured historical bytes. Do not add it to the overlapping log lower bound.

The two release windows have different loads and threshold censoring. Their
rates are observations, not a before/after performance comparison. The last
30 minutes also fail the brief's separate calm-window expectation; this audit
does not approve release 1.13.0.

## Request-path inventory

Sizes below name response bodies on the frozen data: **F** = 8,914,925 bytes;
**S** = 5,154,049 bytes; **T** = summary with full voice bodies for one selected
session, between S and F for this data. Each ordinary successful RPC frame
adds 66 bytes with a 36-character request ID and newline. The HTTP route adds
two small Viewer members and may gzip the result at level 6
(`src/lib/http/gzipBody.ts:33`). HTTP compressed wire bytes were not captured.
Request payloads are small method/ID envelopes with an optional voice scope.

All `snapshot()` paths share `UnixRuntimeHostClient.snapshot` at
`src/lib/runtime/client.ts:194`, host dispatch at
`src/runtime-host/host.ts:146`, and `RuntimeJournal.snapshotJson` at
`src/runtime-host/journal.ts:1416`. Ordinary success decoding is the
synchronous `JSON.parse(frame.slice(0, newline))` at `client.ts:402`.

| Caller and file:line | Trigger / frequency in main | Payload / parsing process | What the caller actually consumes |
| --- | --- | --- | --- |
| HTTP snapshot entry, `src/app/api/runtime/snapshot/route.ts:14` | Every admitted GET; `view=summary` or `voiceFor` selects the scope (`:25`, `:31`). Source-visible callers follow below; arbitrary external/manual callers and their rate are not identified by the journal. | Default F, summary S, voice T; encoded forwarding when available. | Adds `structuredHostsEnabled` and `structuredStartup` to the encoded body. Normal path consumes no session records. |
| Tab-wide runtime bus, `src/hooks/runtimeBus.ts:33`, `:242`, `:306`, `:478`, `:517`, `:593` -> `src/app/api/runtime/snapshot/route.ts:34` | Cold join, reconnect/resume, cursor reset, revision gap, manual recheck; degraded fallback every 10 s/tab. Reconnect backoff 0.5–8 s, degraded mode after 15 s, SSE retry 60 s, hidden suspension 30 s. Subscriber singleton per tab. Actual tab/reconnect count unavailable. | S; Viewer uses encoded bytes, browser parses `response.json()`. Fallback contract without `snapshotBytes` parses in Viewer. | Complete runtime store: cursor, epoch/health, files revision, sessions/voice references, attentions, operations, edges, flows, workflows, tasks, deployments, plus startup/structured-host flags. `src/components/runtime/runtimeModel.ts:432` installs it. |
| Voice hydration, `src/hooks/useCodexRealtime.ts:211` -> same route with `voiceFor` | On deferred body/revision recovery for a conversation; in-flight deduplication by body identity; active recovery backs off 1–30 s (`:245`). | T; encoded through Viewer, browser parses whole population. | One matching session's revision, voice bodies, omitted-body marker and acknowledged delivery IDs (`:215`). |
| Optional deployment pill, `src/components/runtime/DeploymentStatusPill.tsx:23` | Initial load and every 3 s, only desktop with explicit build flag and runtime bus disabled. Default flag is off. | F if route available; Viewer encoded, browser decoded. | `deployments` only (`:31`); latest status. If the runtime plane is disabled, route returns 503 before asking the host. |
| Files invalidation, `src/lib/runtime/filesRevision.ts:20` | Every queued publication; one serialized read/append pair. At least 38 successful reads in the sampled 30 minutes. | S; Viewer decoded. | One integer: `filesRevision`. |
| Upstream: host projection, `src/lib/runtime/structuredDeliveryController.ts:248` | Every call to `publishStructuredHostProjection`, after appending the projection. This includes host status/materialization changes. | Via files invalidation above. | Monotonic files invalidation after the projection. |
| Upstream: terminal delivery, `src/lib/runtime/structuredDeliveryController.ts:1033` | When a terminal delivery changes its registry projection. | Via files invalidation above. | Immediate files invalidation for the board's delivery state. |
| Upstream: attention reconciliation, `src/lib/attention/reconcileController.ts:61` | Changed attention sweep; controller interval 60 s, initial delay 30 s (`:15`). | Via files invalidation above. | Files invalidation; no snapshot records. |
| Upstream: asks, `src/lib/asks/controller.ts:81` | New ask announcement; sweep every 15 s after 60 s initial delay (`:19`). | Via files invalidation above. | Files invalidation; no snapshot records. |
| Title publication, `src/lib/session/titleEvents.ts:43`, called by `src/app/api/session/title/route.ts:92` | Each durable title set/clear; best-effort runtime publication. Zero matching committed events in the sampled 30 minutes; attempted requests unknown. | S; Viewer decoded. | `filesRevision` for a title notification plus files bump. |
| Pipeline activity, `src/lib/pipelines/engine.ts:1707` | When a pass/action asks `conversationAgentActive`. Shares one lazy promise per `defaultPipelinePorts` instance (`:1373`); affirmative dead/unhosted/conflict clears it (`:1719`). Controller runs on signals and 30 s watchdog (`controller.ts:87`, `:390`), with multiple passes possible. No fixed one-request-per-tick bound. | F; Viewer/controller process decoded. | Find one session; `host`, `turn`, `attentionIds`, preserving unknown vs active vs dead. |
| Pipeline interrupted-turn check, `src/lib/pipelines/engine.ts:1732` | Per interruption/recovery check; same lazy promise. Stop logic can construct a fresh ports instance (`:1650`). | F; shares previous row's read when same ports object. | Matching session's host/turn/attention axes; then separate ledger/liveness evidence. |
| Pipeline epoch, `src/lib/pipelines/engine.ts:1852` | Recovery/restart checks; same lazy promise as previous two rows. | F; controller decoded. | `runtime.hostEpoch` only. |
| Unpublished launch retry proof, `src/lib/pipelines/engine.ts:1578` | Conditional failed prepublication launch check, after keyed operation checks. Fresh read outside the shared promise. | F; controller decoded. | `retentionFloorSeq`, `snapshotSeq`; then at most 64 event pages to prove admission and absence of message/native start through a fixed cursor. |
| Update quiet/readiness probe, `src/lib/selfUpdate/instance.ts:657` -> `quiet.ts:313` | Each eligible `probeQuiet`; auto tick every 60 s plus immediate startup (`service.ts:281`), final/admission rechecks, drain and explicit update/restart actions (`:617`, `:640`, `:740`, `:947`, `:971`, `:1023`, `:1067`). Eligibility may skip a tick. | F; Viewer decoded. | Session identities/paths/cwd and host/turn axes; writer status/claim, native claims and revisions through owner census (`instance.ts:402`, `:467`). Separate keyed session, producer cursor, and event reads remain necessary. |
| Legacy deployment-list negotiation, `src/lib/runtime/client.ts:313` | Only after exact unsupported-method response to `viewer-deployment-list`; capability memoized per socket generation. Each subsequent old-host page needs a snapshot. Modern host supports the keyed list. | F; caller process decoded. | `deployments`, paged/compacted locally. Timeouts and domain errors do not activate this fallback. |

The following compatibility branches are also snapshot paths. Production's
`UnixRuntimeHostClient` implements `readSession`, so the missing-method
branches below are not taken by that client. An old host rejecting
`session-read` does not make the JavaScript method disappear.

| Compatibility caller | Frequency if exercised | Payload | Consumed result |
| --- | --- | --- | --- |
| `src/lib/runtime/startup.ts:1422`, `readStartupRuntime` | Once per startup signal read with an embedder lacking `readSession`; 30 s caller deadline. | F | Sessions and recent operation receipts used for running/pending/admitted work. |
| `src/lib/runtime/structuredSpawn.ts:609`, `reconcileStructuredSpawnReplay` | Per unresolved receipt without keyed reads; failed receipts may share the pass promise below. | F | Matching session identity and host evidence, combined with separately read launch/message operations. |
| `src/lib/runtime/structuredSpawn.ts:1401`, `failedReceiptSnapshot` | At most one lazy full read for failed receipts per `recoverPendingStructuredSpawns` pass; only used by the preceding compatibility branch. | F | Session recovery evidence. |
| `src/lib/runtime/structuredSpawn.ts:1405`, `registeringSessions` | At most one lazy read per recovery pass without keyed reads (`:1441`). | F | IDs whose session host is `registering`. |
| `src/lib/runtime/structuredSpawn.ts:1114`, stale spawn reconciliation | Per qualifying transport-less receipt without keyed reads. | F | Presence of one conversation's session before declaring the launch absent. |
| `src/lib/runtime/structuredDeliveryController.ts:1513`, hostless settlement | One read per nonempty bounded sweep without keyed reads; reused by the pending batch. | S | Session revision and host/turn claims before fenced settlement. |
| `src/lib/runtime/structuredDeliveryController.ts:1958`, completion | One optional read per startup completion without keyed reads. | F | Sessions used only to avoid redundant historical fallback publication. Failure permits redundant publication, never new authority. |

Two host-local reads do not cross the socket or incur a Viewer JSON parse:
`src/runtime-host/main.ts:240` reads `runtime.hostEpoch` once on the faulted,
nonwritable startup branch; `src/runtime-host/legacyScheduler.ts:37` reads
`filesRevision` when legacy scan evidence changes. Legacy cadence is 15 s
(`src/lib/runtime/legacyScheduler.ts:16`). These call `journal.snapshot()`
directly and construct the whole projection, bypassing the encoded cache.

Validation-only callers are separate from serving traffic:
`candidatePerformanceRun.ts:689` requests a snapshot plus receipt sequentially
then sleeps 500 ms (`:82`); `candidateRuntimeHost.ts:168` polls the candidate
HTTP summary at 500 ms intervals up to 120 s, using only `structuredStartup`;
`hostRehearsalRun.ts:456` repeatedly requests snapshot-sized replies to test
handover and disconnected peers. `bootstrapMcpHealthProbeAdmission.ts:14`
answers a tiny synthetic deployment snapshot for its private probe; it is not
another reader of the production journal. Explicit test and render-fixture
callers were excluded from production rates. Registry/store/self-update
methods also named `snapshot` are different APIs.

## Payload composition and isolated measurements

One SQLite online backup was made through a `mode=ro`, `query_only=ON` source
handle at **05:10:45.918–05:10:46.390Z**. The destination was made read-only.
Its SHA-256 remained
`c007679d30971a5ce25f8ae06a9b0ea85a6c423f931b04e2c2b525282ce43db9` after the
experiments. Source files were exported using `git archive HEAD` into a
private scratch root. The installed release's dependencies were linked only
in that export after verifying byte-identical `bun.lock` hashes.

The copy has 5,490 session entities (311,161,603 JSON characters), including
702 hosted, 4,418 dead, and 370 unhosted. Its metadata schema and ready markers
are both `1`, all 5,490 metadata rows exist, and none has a missing/mismatched
entity checkpoint. The ready-index selection was therefore explicitly used.
No immediate-post-open fallback timing is mixed into these results.

`journal.ts:3065` includes all active sessions and the newest 128 inactive
sessions; the fixture consequently returns 830 sessions. Terminal deployments
are capped at 50 and terminal-session edges expire after seven days (`:79`).
Summary removes voice response text inside SQL, retaining delivery metadata
and `voiceDeliverySnapshotRevision`. It does not make other collections small.

| Component | Full bytes | Summary bytes |
| --- | ---: | ---: |
| Complete body | 8,914,925 | 5,154,049 |
| Sessions array | 7,812,169 | 4,051,293 |
| Sum of session `voiceDeliveries` values | 4,940,075 | 1,146,449 |
| Sum of session `recentReceipts` values | 1,250,995 | 1,250,995 |
| Edges array, 2,807 entries | 943,153 | 943,153 |
| Attentions array, 91 entries | 107,160 | 107,160 |
| Recent operations, 100 entries | 52,157 | 52,157 |

Per-field sums exclude field names/separators and are not additive with their
parent arrays. Flows, workflows, tasks and deployments are empty here. The
snapshot cache retains full and summary representations, invalidates on
connection writes and edge expiry, and does not retain targeted voice bodies
(`journal.ts:1416`). A cache hit saves host collection/encoding; each decoded
client still parses the returned bytes.

All timings below use Bun **1.4.0**, serial heavy commands through the required
gate, isolated HOME/config/TMPDIR/state and a closed Viewer control port.
The audit's cgroup had no CPU quota and a 5 GiB memory ceiling; the shared
ancestor ceiling was about 106.6 GiB. Approximately 99.6 GiB was available at
capacity observation. Production and other agents remained active, so timer
maxima include scheduler noise. No CPU affinity or exclusive-host claim is
made.

### Serial parsing

Each of three rounds warms five parses, then measures 40 parses with a 10 ms
yield between them. The expression is the client's actual
`JSON.parse(frame.slice(0, newline))`; framing is included. A 5 ms timer runs
alongside it. Results are three independent round percentiles, not percentiles
of averaged values. The full object result is consumed without retaining a
history of results. No forced GC runs between samples.

| Frozen representation | Body bytes | Parse p50, ms, rounds 1 / 2 / 3 | Parse p95, ms, rounds 1 / 2 / 3 | Maximum parse, ms |
| --- | ---: | --- | --- | ---: |
| Full | 8,914,925 | 10.841 / 11.740 / 10.473 | 13.882 / 15.636 / 13.540 | 17.231 |
| Existing summary | 5,154,049 | 9.244 / 7.392 / 7.358 | 13.195 / 9.395 / 9.076 | 13.883 |
| Pipeline axes projection | 98,721 | 0.188 / 0.113 / 0.161 | 0.253 / 0.199 / 0.292 | 0.326 |
| Owner-evidence projection | 654,501 | 0.920 / 1.212 / 1.320 | 1.587 / 1.429 / 1.520 | 4.868 |
| Cursor/epoch/files metadata | 119 | 0.005 / 0.012 / 0.005 | 0.017 / 0.016 / 0.015 | 0.041 |

Axes preserve every selected session's `conversationId`, `host`, `turn` and
`attentionIds`, plus the metadata. Owner evidence preserves those fields and
`artifactPath`, `sessionKey`, `activeTurnId`, `cwd`, `revision`, `writerStatus`,
`writerClaim`, `nativeTurnClaims`. Missing optional fields remain missing.
These are payload experiments. No new endpoint or behavioral-equivalence
verdict is claimed. An initial 350,602-byte census sketch omitted writer
evidence; its timing was excluded and the corrected projection above was
measured separately.

Across 120 full parses, synchronous parse time totals **1,394.95 ms**; summary
totals **1,005.53 ms**, axes **20.30 ms**. Full/summary timer-lateness maxima
are 17.259/13.933 ms. The axes run has an 8.953 ms timer outlier despite a
0.326 ms maximum parse; timer lateness cannot automatically be assigned to
the measured parse. Metadata max lateness is 0.268 ms.

### Actual client/socket burst

An owned child runs the unmodified `serveRuntimeHost` with a handler returning
the frozen `PreserializedJson` body. The parent uses the unmodified
`UnixRuntimeHostClient` through an owned private Unix socket. This isolates
receiving/decoding from host database collection. Each round has three warm
requests, then six bursts of eight concurrent requests with 25 ms between
bursts: **48 measured replies**, repeated three times for every arm.
The child PID is recorded and it closes on its own stdin quit command after
requests complete; no production process or listener is involved.

| Response / client method | RPC p50, ms, three rounds | RPC p95, ms, three rounds | Main-thread parse total per 48, ms | Max timer lateness, ms, three rounds |
| --- | --- | --- | --- | --- |
| Full / `snapshot` | 352.3 / 338.1 / 305.2 | 462.9 / 470.0 / 424.8 | 1,038.8 / 1,006.5 / 903.9 | 61.72 / 80.04 / 57.79 |
| Summary / `snapshot` | 151.3 / 143.5 / 165.1 | 201.3 / 191.2 / 226.7 | 529.4 / 545.5 / 607.8 | 45.11 / 29.41 / 36.80 |
| Full / `snapshotBytes` | 243.1 / 177.2 / 181.1 | 280.9 / 218.6 / 246.6 | 0 / 0 / 0 on successful encoded path | 8.10 / 7.39 / 4.91 |
| Axes / `snapshot` | 1.9 / 1.6 / 1.9 | 3.1 / 3.2 / 4.3 | 8.8 / 7.2 / 12.0 | 1.32 / 1.47 / 0.57 |

Full burst parse p95 is 28.1–29.1 ms, larger than isolated serial parsing.
Client completion also includes UTF-8 decoding, string assembly, socket
scheduling and allocation. Those costs are outside the parse span. The
encoded arm has the same large transfer and still assembles bytes; it is the
existing HTTP forwarding mechanism, not a new optimization implemented here.

At a deliberately fixed **six replies/minute**, the same raw RPC frames cost
53,489,946 bytes/min full, 30,924,690 summary, or 592,722 axes. Axes reduce
body bytes by 98.893%; summary reduces them by 42.186%. Six/minute is a
workload definition for comparison, not an inferred production rate.

### Worker control

A single warmed Bun Worker receives a transferred copy of full UTF-8 bytes,
decodes/parses them and sends either the full object or only axes back.
Three rounds of 40 requests include the parent byte copy and result transfer;
each is separated by a 10 ms yield. Worker startup is excluded.

| Return policy | Round-trip p50, ms, three rounds | Round-trip p95, ms, three rounds | Parent timer p95, ms, three rounds | Maximum parent timer lateness, ms |
| --- | --- | --- | --- | ---: |
| Full parsed object | 56.21 / 58.38 / 56.62 | 66.85 / 67.18 / 63.01 | 4.87 / 6.13 / 6.44 | 13.23 |
| Axes only | 19.19 / 19.73 / 19.65 | 23.19 / 23.29 / 24.31 | 1.06 / 1.53 / 1.95 | 4.71 |

Off-thread parsing helps parent responsiveness, but whole-object transfer
adds substantial latency and allocation. A worker that owns the decoded
model and answers narrow reads is a more useful fallback than returning the
entire parsed population. Neither experiment models a long-lived, multi-GiB
Viewer heap or establishes GC causality for a production gap.

## Proposed implementation order and contracts

1. **Use scalar and keyed reads for internal control.** Integrate with
   #2905's `files-revision` method; do not reimplement its overlapping hunks.
   Route both files invalidation and title publication through it. Preserve
   existing append order and the publication queue. A separate atomic bump
   would change a write contract and needs its own concurrency proof.
   Supply bounded metadata for epoch and retry-proof cursor/floor reads.
   The floor and sequence must come from one consistent read; preserve the
   current fixed upper cursor used by the retry proof. For pipeline liveness,
   prefer a bounded batch of requested session axes, with single-flight reuse
   for one pass. A keyed read must preserve the current display-selection
   semantics or explicitly prove equivalence: `readSession` can return old
   inactive rows omitted by the population snapshot (`journal.ts:1339`).
   Unknown, absent, dead, conflict, attention and transport failure must remain
   distinct. The existing plain `readSession` also carries voice bodies, so
   replacing every full request by a full keyed body is an incomplete design.

2. **Give update readiness a typed owner-evidence projection.** Preserve the
   census's identity bindings, writer epochs/marks, native admissions, missing
   history behavior, row revisions and its later keyed rechecks. Keep the same
   population and ordering initially. The 654,501-byte experiment is a sizing
   target, not proof that an incomplete or stale projection may authorize
   restart. Keep all ownership/settlement decisions in the existing logic.

3. **Scope voice recovery and deployment display.** Add a keyed voice-body
   read preserving delivery ordering, acknowledgment tombstones, revision
   coverage and unknown-body behavior; return the selected conversation only.
   Replace the optional pill's full fallback with the existing bounded
   deployment list/read API. Keep raw encoded forwarding and asynchronous gzip
   for callers that genuinely need the HTTP projection.

4. **Reuse cursor/delta infrastructure where it preserves repair semantics.**
   The browser already has SSE backed by `waitEvents` and 128-event replay
   pages (`src/lib/runtime/sse.ts:26`, `journal.ts:1441`). Healthy streaming
   does not require a ten-second snapshot poll. Reconnect currently takes a
   fresh snapshot deliberately: it can repair a missing session even when the
   cursor did not advance (`runtimeBus.ts:478`). A cursor-only shortcut must
   retain that repair path. A versioned smaller baseline followed by deltas
   needs epoch/schema/selection identity, an atomic snapshot cursor, contiguous
   revisions, deletion/retirement tombstones, bounded page bytes, and reset
   below retention floor. Apply a complete baseline atomically; preserve the
   previous visible model while resynchronizing. Do not substitute a host cache
   keyed only by TTL for authoritative controller evidence.

5. **Move remaining large parse work off-thread only if measurements justify
   it.** Prefer one bounded, owned worker that retains its model and returns
   small projections. Bound queued bytes and generations, honor aborts, and
   discard obsolete responses. A streaming baseline could lower peak memory,
   but chunk boundaries alone do not make a final `JSON.parse` incremental.
   Adding a second streaming protocol before using the existing scalar/keyed
   and event APIs is not justified by this audit.

New capabilities must negotiate per host generation. Only the exact
unsupported-method refusal may select a compatibility path; timeout,
malformed reply, ID mismatch, size refusal and domain rejection retain their
meaning. Keep the 64 MiB last-resort response ceiling (`client.ts:21`), finite
new page/batch limits, and existing deadline policy.

Connection safety is mandatory across all variants. The listener attaches
`socket.on("error", ...)` before writes (`src/runtime-host/socket.ts:60`),
aborts on close (`:62`), settles once (`:73`), and checks destroyed/ended
connections before replying (`:76`). Client abort/deadline/error paths settle
once and destroy their socket (`client.ts:341`). A write failure must remain
confined to its connection. Worker failure must also reject only the owned
work and leave host/Viewer process authority intact.

The state-DB lock, heap and MCP-writer lanes remain separate. This audit edits
only this document. #2905 already owns instrumentation and the files scalar
seam described above. None of the reductions here proves that those other
sources of long pauses have been fixed.

## Before/after acceptance method

Use the **same backup, interpreter, readiness state, selected population,
clock/edge-expiry boundary and request schedule** for base and candidate.
Keep the source copy read-only. If the candidate needs migrated state, derive
two private working copies from that one backup and record their transformations.

First run serial and eight-concurrent transport measurements above, with
three rounds per variant. Record response bytes, requests, UTF-8 decoding,
parse span, projection/install time, total RPC time, timer lateness, allocation
or heap growth and GC evidence separately. Never call request wall time parse
time. Use a common workload duration for bytes/minute; burst completion time
is not a minute-rate denominator. Include cold/ready, ready/cache-hit,
dirty-one-session rebuild, many dirty sessions and retained-history growth.
The preexisting ready metadata path must be confirmed before labeling a run
steady state. Browser gzip bytes are an additional metric, distinct from raw
host-to-Viewer frame bytes.

Then drive identical timestamped isolated events and caller actions against
base and candidate. Include files/title changes, pipeline liveness/recovery,
quiet probes, tab joins/reconnects, voice hydration and degraded polling. Keep
an oracle of the exact values each old caller observed: full store equivalence
for browser consumers; narrow values for scalar/axes readers; complete owner
evidence and decisions for update admission. Count every request by a bounded
caller label, scope, method and generation. Report successes, failures,
cancellations and cache hits without recording IDs or user bodies. This
supplies total bytes/minute and attribution missing from today's journal.

Exercise unchanged cursor, missed entity at unchanged cursor, retention-floor
reset, host epoch change/rollback, wrong schema, out-of-order concurrent replies,
truncated and split UTF-8 frames, oversized frames, disconnect midway through
a large answer, abort, worker death, old-host unsupported method, and ordinary
RPC rejection/timeout. Distinguish fixture failures from product regressions.
Keep any fallback fail-safe and bounded; a missing read cannot become evidence
of a dead host or a quiet release window.

Suggested component targets to validate, not achieved acceptance claims:
metadata under 1 KiB; axes below 128 KiB at this fixture size; no full population
read on ordinary files/title invalidation or one-session liveness; parse p95
below 5 ms for the bounded internal projections; lower aggregate bytes/minute
and loop-gap count under identical mixed load with no decision/output change.
The measured transport axes control is already below these component bounds,
but no candidate mixed-workload or production after-run exists in this stage.

For implementation, run touched tests by explicit path with fresh isolated
HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR under the OS temp root and
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`, through the prescribed gate.
Relevant existing seams include `src/lib/runtime/client.test.ts`,
`filesRevision.test.ts`, `src/runtime-host/journalSnapshotBounds.test.ts`,
`journal.sessionRead.test.ts`, `src/app/api/runtime/snapshot/route.test.ts`,
`src/hooks/runtimeBus.test.ts` and the specifically affected pipeline/quiet
tests. Add behavioral cases where the new contract changes a seam; do not run
whole runtime directories. Any host implementation change also requires
`bun scripts/verify-runtime-host.ts --runtime <pinned-bun>` in private state,
including succession and abandoned large replies, plus the project's required
runtime/Bun and privacy CI gates. The audit itself changes no executable code.
Only after deployment can the separate calm 30-minute production window be
assessed with the new request counters and passive journal observations.

## Commands and reproducibility

Private inputs contain production data and are excluded from publication.
`$PRIVATE` denotes the owned scratch root, `$SOURCE` the live journal path read
from the runtime process's whitelisted environment, `$TREE` this checkout,
and `$GATE` the installed gate path supplied by the stage. No secret value was
read into an argument or printed. Commands were run through `rtk proxy`.

| Evidence | Execution UTC bounds, 2026-10-15 | Command / query |
| --- | --- | --- |
| Source/history | 05:08–05:16 | `git rev-parse HEAD origin/main`; `git ls-remote origin refs/heads/main`; `git diff 781ecd4c3348 HEAD -- src/lib/runtime src/runtime-host src/lib/pipelines/engine.ts`; `rg -n 'snapshot\(|snapshotBytes\(|api/runtime/snapshot' src scripts`; transcript/memory queries described above; PR view/diff described above. |
| Production journal, first two windows | 05:09:42.223–05:09:42.472 | `journalctl --user -u delegatus.service --utc --since '2026-10-14 21:54:19 UTC' --until '2026-10-14 23:29:19 UTC' --output=json --no-pager`; same command with `2026-10-15 00:28:32 UTC` and `2026-10-15 05:09:00 UTC`. |
| Approximate-count cross-check | 05:12:13–05:12:14 | Same journal command with `2026-10-14 21:54:19 UTC` and `2026-10-14 23:35:00 UTC`. |
| Current 30-minute window | 05:13:04–05:13:05 | Same journal command with `2026-10-15 04:39:00 UTC` and `2026-10-15 05:09:00 UTC`. |
| Process identity/capacity | 05:09:32–05:13:05 | `systemctl --user show delegatus.service -p MainPID -p ActiveState -p ControlGroup -p ExecMainStartTimestamp`; enumerate only its descendants; `readlink /proc/$PID/{exe,cwd}`; read stat/start ticks and boot time; whitelist state/journal/role/port fields from environ; read own/ancestor cgroup limits and `/proc/meminfo`. |
| Backup/export | 05:10:45.918–05:10:47.275 | Python SQLite `connect('file:'+source+'?mode=ro', uri=True)`; `PRAGMA query_only=ON`; `source.backup(destination,pages=256,sleep=.01)`; chmod destination 0400; `git archive HEAD`; compare `sha256sum bun.lock` with dependency donor. |
| Frozen payload generation | 05:11:51.953–05:11:53 | Isolated `bash "$GATE" bun audit-generate.ts`, invoking the exported main read methods as described below. |
| Serial parse and worker controls | 05:12:43.478–05:13:05.450 | Isolated `bash "$GATE" bun audit-parse.ts`; five warmups/40 samples/three rounds, then worker controls. |
| Client/socket bursts | 05:14:38.557–05:14:56.991 | Isolated `bash "$GATE" bun audit-transport.ts`; unmodified client/server, frozen responses, 3 warmups + 6 x 8 requests/round, three rounds/arm. |
| Corrected owner projection | 05:15:20.735–05:15:22.246 | Isolated `bash "$GATE" bun audit-census.ts`; same serial parse schedule, corrected field set. |
| Durable event counts/checksum | 05:13–05:16 | Queries below against the one read-only backup; SHA-256 recheck. |

Journal reduction parses each JSON line, uses `__REALTIME_TIMESTAMP` for the
half-open window and parses the JSON following `[blocking-wait] ` or
`[viewer loop-gap] `. Group by `site`; sum `durationMs`; extract frame size
with `(\d+) bytes` from `subject`; divide summed bytes by the exact window
minutes. Use nearest-rank percentiles (`ceil(n*p)-1` after ascending sort).
Count `gapMs >= 1000` separately. No message-body grep count is treated as
all requests.

The copy queries were:

```sql
PRAGMA query_only=ON;
SELECT kind, count(*), sum(length(state_json)) FROM entities GROUP BY kind;
SELECT key,value FROM journal_meta WHERE key IN
  ('published_seq','anchor_seq','host_epoch','files_revision','health',
   'session_host_metadata_schema_version','session_host_metadata_ready');
SELECT count(*) FROM entities e LEFT JOIN session_host_metadata m ON e.id=m.id
 WHERE e.kind='session' AND (m.id IS NULL OR m.checkpoint_seq!=e.checkpoint_seq);
SELECT min(seq),max(seq),min(created_at),max(created_at),count(*) FROM events;
SELECT kind,producer_kind,count(*) FROM events
 WHERE kind IN ('files.revision','title.updated')
   AND created_at >= :start_ms AND created_at < :end_ms
 GROUP BY kind,producer_kind;
```

`:start_ms`/`:end_ms` are UTC epoch milliseconds for
2026-10-15T04:39:00Z/05:09:00Z. Row `length` above counts JSON characters;
wire/body counts use `Buffer.byteLength` and are bytes.

For the frozen payload, import `RuntimeJournal` from the scratch source export
after setting isolated environment. Its constructor performs writes, so it
was deliberately bypassed. The following setup uses its actual read methods
against the read-only connection and a verified ready index:

```ts
const db = new Database(copy, { readonly: true, strict: true });
db.exec("PRAGMA query_only=ON");
const journal = Object.create(RuntimeJournal.prototype);
Object.assign(journal, {
  db, now: () => Date.parse("2026-10-15T05:10:46.389Z"),
  sessionHostMetadata: { ready: true, excludedChanges: 0 },
  snapshotCaches: new Map(), snapshotCacheHits: 0, snapshotRebuilds: 0,
});
const full = journal.snapshotJson();
const summary = journal.snapshotJson([]);
if (JSON.stringify(journal.snapshot()) !== full) throw Error("parity failed");
```

This is a read-only harness, not a supported journal construction API.
No constructor, migration, secret-key loader, consumer or maintenance timer
ran. Collection+serialization, measured once, took 195.858 ms full and
242.724 ms summary; these single generation observations are not parse
benchmarks. Full/summary body hashes respectively:

```text
36beeb3fd87455dcfc03fe8a220ce75119040b9edc20c4e4849bc7d4181a6df3
fb08237db8df9de7da2dfbf3bef89ec7020caede57b292965940698172940d21
```

The serial timing kernel, with a persistent input frame and consumed result,
was:

```ts
// requestId is a fixed 36-character synthetic ID.
const frame = `{"id":${JSON.stringify(requestId)},"ok":true,"result":${body}}\n`;
const newline = frame.length - 1;
// Five warmups; then 40 samples per round, three rounds.
const started = performance.now();
const value = JSON.parse(frame.slice(0, newline));
parseSamples.push(performance.now() - started);
sink += value.result.snapshotSeq;
await sleep(10);
// Parallel timer: every 5 ms, record max(0, now - previousTick - 5).
```

The transport child returns `{ id: request.id, ok: true,
result: new PreserializedJson(body) }` through the real socket server; it
does not query any database. Reset the existing blocking-wait diagnostic
samples after warmup and collect their parse/transfer totals after each
round. Encoded successes have no parse sample because that path returns
before JSON parsing. Worker input is `new Uint8Array(fullBytes).buffer`,
transferred with `postMessage`; its callback runs `TextDecoder.decode` then
`JSON.parse`, and returns either the parsed object or the axes projection.
Parent timing begins before copying input bytes and ends on the matching
worker reply. All worker and socket children were owned and closed.

Documentation validation at 05:22Z passed the local privacy gate with the
committed known fingerprints and explicit document path:

```sh
# In the isolated source export, with the same isolated environment as above:
bash "$GATE" bun scripts/privacy-publication-gate.ts \
  --repository "$TREE" --require-known-values \
  --paths docs/perf/runtime-snapshots.md
# In the declared checkout:
git diff --no-index --check /dev/null docs/perf/runtime-snapshots.md
git status --short --ignored
```

The fingerprint-file environment variable points to the exported committed
`scripts/privacy-known-value-fingerprints.json`. The first privacy run flagged
the synthetic request ID in the illustrative kernel; that literal was removed
and inspection passed. File:line targets were checked for existence and line
bounds. The only changed worktree output is this document; nothing was staged
or committed. No executable source or tests changed, so no product test suite
or runtime-host promotion rehearsal was run for this documentation stage.
The read-only backup and raw experiment records remain private for the
candidate's identical-data replay; their scratch location is in the stage
handover, outside this publication artifact.

## Implementation: narrow internal reads (2026-10-15)

The candidate implements the first two steps above. The internal readers in
the table now ask for metadata, session activity, or restart ownership evidence
through `snapshotRead: { version: 1, kind, conversationIds? }` on the existing
snapshot RPC. `src/lib/runtime/snapshotReads.ts` defines and validates the
contract. `src/runtime-host/journal.ts` selects the fields in SQLite before
JSON decoding; `src/runtime-host/host.ts` sends their serialized response.

| Scope | Values retained | Consumers |
| --- | --- | --- |
| `metadata` | Schema, published sequence, retention floor, host epoch/health, files revision | Pipeline retry proof; title publication |
| `activity` | Metadata plus conversation ID, host/turn axes and attention IDs; optional selection of at most 64 IDs | Pipeline epoch, activity and interrupted-turn decisions |
| `owners` | Metadata plus conversation ID, session key, artifact path, cwd, host/turn, active turn, revision, writer claim/status and native turn claims | Self-update quiet probes and owner census |

The metadata and selected population share one SQLite read transaction. All
scopes preserve the full snapshot's selected population: active sessions plus
the same newest 128 inactive sessions. Filtering requested IDs happens after
that limit and matches the published `conversationId`, including stored rows
whose journal scope has a different ID. An old inactive session omitted by
the full snapshot stays absent; owner census keeps its existing later keyed
reads for missing ownership records. Optional fields preserve absence and explicit null, including native
custody evidence. Full and summary reads use the same selection helper.

Pipeline ports share one pending activity population read for their lifetime,
preserving the original single population read across all session checks.
An epoch check uses that same observation, including when epoch is asked first.
Affirmative dead/unhosted/conflict evidence clears those
reads so a later check can observe adoption during the pass. Absent rows and
failed reads keep their existing unknown outcomes. Title publication still
appends the same title and files-revision events in the same order.

The host caches one encoded population per activity/owner scope, invalidated
by its own journal write witness and SQLite's peer-commit `data_version`.
Optional selected activity reads retain no cache by ID. Metadata reads query
only journal metadata. A test commits a
peer write between metadata reads to verify the cursor, floor, epoch and
population cannot come from different transactions.

Compatibility uses the existing method: an older host ignores `snapshotRead`
and returns its voice-summary snapshot, which the client projects locally.
Each response carries its own shape/version; there is no capability cache to
survive a host switch. A refusal, timeout, abort, malformed frame or invalid
projection stays a failed read and never requests a second full population.
Older clients still receive their existing full or voice-summary response
from the new host. The socket's connection error handling is unchanged.

PR #2905 merged during this implementation. Its files-revision RPC and timing
spans occupy separate hunks and remain intact; files invalidation uses that
scalar after integration. Title publication uses this bounded metadata read.
The state database lock, heap and MCP writer lanes' implementation files were
inspected and left unchanged by this lane. Browser snapshot forwarding,
voice hydration and browser delta/cursor work remain at their existing
contracts. No worker or long-lived decoded population cache is introduced.
The inventoried embedder fallbacks without keyed reads and the legacy
deployment-list fallback still read full populations. Existing modern
clients already take their keyed paths; old hosts retain the compatibility
cost until upgraded.

### Paired replay method

`scripts/benchmark-runtime-snapshots.ts` takes the audit's single read-only
backup, a `git archive` export of audited main, and a new private output
directory. It verifies the backup hash before and after, makes a separate
working copy for each variant, and loads the actual baseline and candidate
journal and client classes. The journal constructor is bypassed using the
audit harness above; its companion metadata coverage is checked before use.
The clock, source rows, SQL mutations and request schedule are identical.

Collection timings cover metadata unavailable/ready, warm caches, one and 64
changed rows, and 500 additional retained dead rows. Every stage compares the
caller-visible values with a fresh full snapshot and with the other variant.
Full snapshot cold rebuilds alternate on the original immutable backup after
both collection campaigns, to check the shared selection refactor. Collection
numbers include SQL selection, decoding the selected
projection and serialization. They exclude socket transfer and Viewer parsing.

The transport replay runs a child socket server with frozen bodies produced
by those journal methods. Each variant uses its actual client. There are
three paired rounds, alternating before/after, with six bursts of eight reads
at 0, 10, 20, 30, 40 and 50 seconds in a 60-second window: four activity,
three metadata and one owner read per burst. Warmup is excluded. The main
process records the existing synchronous parse span and a 5 ms timer's
lateness. RPC wall time includes decoding, framing and projection validation.
All children close through their owned stdin channel and are awaited.

This is an offered load of 48 independent reads/minute. It measures transport
and parsing separately from database collection, excludes production caller
frequency and pipeline read coalescing, and makes no production GC or
18-second-stall attribution. The oracle also checks the unchanged full
snapshot, including browser/voice fields. Browser actions themselves are
outside this internal-read replay. Raw payloads and database copies remain
private; only aggregate measurements are published.


### Candidate before/after results

The final paired replay finished at 2026-10-15T06:15:54.819Z under Bun 1.4.0,
with 58 matching oracle comparisons and an unchanged backup checksum. Each
arm completed all 144 measured requests. Counts below exclude warmup and
use the fixed 48 reads/minute offered load; the three round values stay
separate. There were no measured request failures or cancellations.

| Metric, three rounds | Before | After |
| --- | ---: | ---: |
| Raw snapshot RPC bytes/minute | 360,223,800 | 6,215,088 |
| Main-thread parse total, ms/minute | 1060.1 / 1021.1 / 1176.8 | 13.6 / 15.8 / 15 |
| Parse p95, ms | 32.6 / 32.9 / 39.2 | 1.5 / 1.9 / 1.8 |
| Maximum 5 ms timer lateness, ms | 61.75 / 78.5 / 59.87 | 1.89 / 9.06 / 4.29 |
| Timer gaps ≥50 ms per minute | 1 / 2 / 1 | 0 / 0 / 0 |
| RPC p95, ms | 487.46 / 450.6 / 563.63 | 7.36 / 8.96 / 9.49 |

Raw frame traffic falls **98.27%**. The three candidate parse totals are
**13.6–15.8 ms/minute**, compared with **1,021.1–1,176.8 ms/minute** before.
The body sizes are 184 bytes for metadata, 98,786 bytes for all 830 sessions'
activity fields, and 639,624 bytes for ownership evidence. Baseline metadata
uses its 5,154,049-byte voice summary; activity and ownership use the
8,914,925-byte full body. Framing adds 66 bytes per reply in both variants.
The 5 ms timer reports scheduling lateness, including machine contention;
its gaps are not attributed exclusively to parsing.

The collection table gives the median sum of metadata, activity and owner
reads in that order over three repetitions. Baseline ownership reuses the
full body just built for activity; candidate activity and ownership have
separate encoded caches. Clearing caches precedes every non-cached sample.

| Journal state | Before collection + encoding, ms | After collection + encoding, ms |
| --- | ---: | ---: |
| Metadata unavailable | 2606.73 | 1235.14 |
| Metadata ready, cold caches | 408.00 | 145.94 |
| Metadata ready, warm caches | 0.06 | 0.19 |
| One session changed | 478.90 | 125.83 |
| 64 sessions changed | 447.33 | 102.37 |
| 500 more retained dead rows | 464.29 | 116.70 |

Full-snapshot controls return the same 8,914,925 bytes and hash on both sides.
Their three cold rebuilds took 201.49 / 293.55 / 216.13 ms before and
303.71 / 281.01 / 202.29 ms after. The final code retains the original direct
population query shape; these noisy samples establish no full-read speedup.
The first candidate added a redundant selected-ID join for every population
read; the final code uses that join only for explicitly selected IDs.
The final activity population is shared across all pipeline session checks,
matching the old pass reuse while preserving published identity semantics.

The measurement process had no cgroup CPU quota and a 5.5 GiB memory ceiling;
the shared ancestor ceiling was approximately 106.6 GiB. Other work remained
active. CPU and heap deltas are retained in the private report and are not
used as GC or retained-heap evidence.

Reproduce with the same private backup and baseline export under isolated
state and the supplied gate:

```sh
bash "$GATE" bun scripts/benchmark-runtime-snapshots.ts \
  "$BACKUP" "$BASELINE_TREE" "$NEW_PRIVATE_OUTPUT"
```

The output directory must be new. It holds private payloads and database
copies as well as `report.json`; only aggregate results belong in publication.

### Verification and operational boundary

Behavioral coverage includes every narrow scope against the full snapshot,
the inactive history cap, a published conversation ID differing from its
journal key, metadata readiness, ownership fields and legacy absent/null
custody, local and peer cache invalidation, and a peer commit inside a read.
Real socket tests cover old/new response shapes, malformed frames and
projections, split UTF-8, cancellation, timeout and single-request refusal.
Production pipeline ports verify shared activity/epoch reads, same-pass
adoption after death, unknown/unavailable evidence and title event order.
The ownership decision matrix exercises the new owner projection through
`ownerCensusReader` and quiet admission. Pipeline snapshot fixtures supply the
complete current envelope and use the valid `hosted` axis.

The final focused run passed 24 tests across `snapshotReads.test.ts` in the
host and client, `journalSnapshotBounds.test.ts`, `journal.sessionRead.test.ts`
and `pipelines/runtimeReads.test.ts`. The final Bun 1.4.0 host rehearsal
completed succession in 519 ms: both the stable listener and runtime socket
answered 27/27 requests, each with 13 abandoned callers, over 15 seconds.

All checks use explicit test paths and isolated HOME, XDG_CONFIG_HOME,
TMPDIR and LLV_STATE_DIR with `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`.
Heavy checks use the supplied owned gate. The runtime-host rehearsal starts
private generations and listeners, with no request to the serving host.
Types, changed-source lint, whitespace and the local privacy gate are required
before publication; hosted runtime/Bun checks judge the proposed integration.

The initial regression comparison found two existing failures in
`src/lib/selfUpdate/quietFallback.test.ts`, for an earlier generation's live
busy turn after a successor settles, both visible and behind the history cap.
They reproduced on the audited baseline. Their assertions remain unchanged.
The release's calm 30-minute production window is assessed after an approved
deployment and is not claimed by this isolated implementation.
