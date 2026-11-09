# Claude background turn completion — implementation brief

> Every turn that ends on a launched agent notifies its launcher once, whoever or whatever started the turn.

Originating requirement: [issue #3689](https://github.com/Latand/delegatus/issues/3689), 5 November 2026, latest requirement update 14:18:10 UTC. The 6 November dispatch authorized investigation of recent issues and comments. Its private wording is omitted. The outcome is a self-started Claude background turn reaching terminal state and producing one keyed completion notice for its eligible launcher, preserving existing coalescing and recipient rules.

## Decision and evidence limit

**Implementation brief complete. Proceed with the bounded broker change and regressions below.** The coordinator's 9 November decision accepts attempt 1's controlled replay as proof of the missing-event mechanism. Historical incident frames are unrecoverable for this work. Their absence limits attribution to the original incident and its precise CLI version; it is not an implementation prerequisite. Do not search for those frames again, require their recovery, or run a live Claude/provider capture.

The selected boundary is observed, meaningful main-session assistant activity while the broker has no active delivered turn and no manual-compaction owner. A result, task notification, or system record alone never creates a turn. This is an explicit implementation rule, supported by the replay and current producer documentation; it is not a claim to have recovered the incident stream.

Only this document changes in this stage. No product edit, commit, publication, live message, deployment or installed acceptance is claimed. Runtime lifecycle implementation retains three independent review rounds. Passing this design stage does not finish the parent task.

## Evidence read and freshness

- Assigned checkout: `423bf964ed98d9dde744ad0f2c4f2dbf92ae146b`; source tree `84bc2c5253c55af114b8f4b1ebff4b2d2aeee1df`. Coordinates below refer to this checkout unless marked otherwise.
- GitHub main and local `origin/main` both resolved to `0f5995e7e591d0864df4ff601b37d552e615e8f9` on 9 November. The full issue body and all comments were reread: zero comments. The requirement remains unchanged.
- Read the dispatch matrix, complete D6, shared check contract and overlap notes at `b8c5744b80cfdd21012b932372a844e76d8ed6f8:docs/audits/recent-issue-dispatch-followthrough-2026-11-06.md`. Its historical capture prerequisite is superseded by the coordinator's current decision.
- Read attempt 1's entire document, retained probe, manifest and actual exit/log. Follow-up transcript searches concerned the earlier diagnosis and adjacent implementation ownership only. Opened the adjacent builder's full relevant messages; no incident-stream search was repeated.
- Read broker send/parser/result/compact/restore/exit paths, event validation/projection, controller publication, consumer eligibility, notice insertion and sweep. Existing fixture builders were inspected before choosing regression locations.
- Rechecked open PR file lists, actual broker patches for #2926 and #3749, the native-queue patch of #3355, and current main's #3733 change. Scanned registered, existing non-scratch worktrees for uncommitted changes to the three broker source/test files. An initializing checkout showed temporary deletions; that is not an authored broker patch. No other uncommitted broker change was found in that bounded scan. Future source integration must refresh this observation.

Current primary producer references, read 9 November: the [TypeScript message reference](https://code.claude.com/docs/en/agent-sdk/typescript#sdkassistantmessage) defines assistant envelopes, result UUIDs, nested-agent attribution and optional triggering-message correlation. The [streaming reference](https://code.claude.com/docs/en/agent-sdk/streaming-output#message-flow) shows that one response can produce multiple complete assistant blocks with the same message ID, and multiple messages/tool cycles precede a result. The [origin reference](https://code.claude.com/docs/en/agent-sdk/typescript#sdkmessageorigin) distinguishes injected follow-ups. These are current contracts, not evidence of the missing incident version. Optional newer fields must remain optional.

## Preserved discriminating replay

Attempt 1 drove `FakeClaude.stdout` through the real JSONL parser, `projectEngineHostEvent`, `consumeRuntimeEvent`, `recordSpawnTurnEnded`, the SQLite-backed notice store and `sweepSpawnNotices`. Delivery was a recording port. The two branches used the same assistant/result payload; only `host.send` plus its user echo differed.

| Input | Starts | Terminal events | Deliveries after two sweeps | State/text |
| --- | ---: | ---: | ---: | --- |
| Queued send, echo, assistant, success result | 1 | 1 | 1 | Idle; queued turn ID |
| Same assistant/result without a send | 0 | 0 | 0 | Idle throughout; delta uses `unknown` |
| Requested compact, boundary, result | Not counted | Not counted | Not exercised | Compact resolves; active turn stays null |

The first two cases also repeat a result while idle and assert no extra terminal event. The compact assertion alone did not measure notices or all event counts; the regression must add those assertions.

Retained private evidence: `$LLV_EVIDENCE_DIR/diagnosis/{broker-probe.test.ts,run-probe.ts,probe.log,probe.exit,manifest.json}`. Probe SHA-256: `11926c57d4905486e5a7e809d081aa9a2816e3839742aec676ca625011981abb`. Log SHA-256: `276bfefd4d4851b507cfda96fcf9cf2a5a4c0bc844969f3e55335567166759fa`. The actual result was **2 passed, 0 failed, 10 assertions, exit 0**, Bun 1.4.0. These assertions proved the defect, not a fixed product.

The selected command was `bun run test src/lib/runtime/claudeStreamBrokerHost.compact.test.ts` through the designated wrapper in an isolated source export. That scratch copy temporarily contained only the two diagnostic tests. Preserve every original test when promoting the replay. Attempt 2 verifies the retained evidence; it does not claim a new product test run.

The experiment did not exercise native Claude, a provider, the runtime-host socket, real launcher registry lookup, live delivery or generation races. The builder adds the existing journal/registry boundary fixtures described below. Historical attribution and production installation remain explicit limits.

## Source mechanism

`send` at `claudeStreamBrokerHost.ts:1080–1172` allocates foreground identity from the queued operation and emits `turn-started`. The stream and assistant branches at `:1658–1676` otherwise emit unidentified text. `acceptResult` at `:1731` selects `turnQueue.shift() ?? activeTurnId`; when both are absent, it returns through the compact-declined path. Thus meaningful unqueued work produces no terminal event and no notice obligation.

The same expression would consume a waiting foreground ID if a new background active ID were simply added without changing terminal selection. The fix must settle `activeTurnId` first and remove a queue entry only when that entry actually owns the settled turn.

The downstream path already works for the queued control. `engineHostEvents.ts:434` preserves turn identity; `consumers.ts:84` admits valid non-retired terminal events; `serverConsumers.ts:38` checks the eligible launcher; `spawnNotice/store.ts:134` inserts the `(childConversationId, turnId)` obligation only once. `spawnNotice/sweep.ts:88` derives a stable hashed message key from those same identities. No second notification path is justified.

## Recognition rule and state transitions

Use a small broker-local start helper called before existing delta/item emission. It must not write a delivery receipt, execute a send, parse prose, poll a transcript, or wait on a shared resource.

| Observation | Action when no turn is active | Action during a turn |
| --- | --- | --- |
| A delivered input admitted by `send` | Preserve existing foreground ID and receipt path | Preserve existing queue disposition |
| Valid main-session `stream_event/message_start` with assistant role | Remember one candidate message identity; no start yet | Update message correlation; retain turn ID |
| Candidate's nonempty text delta, nonempty text block, or valid tool-use block | Start background turn before emitting that activity, if no manual compact owns the stream | Emit under current turn; never split at a block/message/tool boundary |
| Complete main-session `assistant` with assistant role and nonempty text or valid tool-use content | Same start rule; works when partial messages are absent | Preserve current turn and partial-text deduplication |
| `system/task_started`, `task_progress`, `task_notification`, init, status, retry, hooks, informational records | No start or completion; task completion alone is bookkeeping | Preserve existing status/retry handling; retain turn |
| User echo, tool-result-only user message, replay or compact summary | No background start; retain delivery matching rules | Keep existing echo/item behavior |
| Child/subagent assistant (`parent_tool_use_id` non-null), error-only/aborted assistant, empty or malformed assistant content | No background start | Retain existing error/item handling without changing the turn boundary |
| Unowned `result`, including success, error and task-notification origin | No invented turn; resolve compact evidence where applicable | Apply the owned-result rule below |

Validate the existing session fence before classification. Treat missing `parent_tool_use_id` as the legacy main-session shape used by the retained fixture; a non-null parent is never evidence to start a parent turn. An orphan text delta without a witnessed assistant message start does not invent a start. Recognized assistant content is the positive evidence: nonempty text or a tool-use block with a nonempty ID and name and an object input. Thinking-only or arbitrary unknown blocks do not establish useful work. A later text/tool block can establish the start.

A `message_start` is a message boundary. Keep its candidate across its content blocks; clear that candidate at message end, result, manual compaction entry and host termination. A tool cycle can introduce another message while the same turn remains active. The complete assistant fallback uses the same helper, so streamed and complete copies cannot create two turns.

Do not require a `task_notification` marker: the proven replay contains none, and a notification need not cause a response. Optional `origin` and triggering-message IDs are correlation evidence when present. `isSynthetic` on an injected user message does not by itself disqualify the assistant response: a genuine background follow-up may have synthetic input. No global ban on synthetic inputs and no text matching for task-notification tags.

### Compaction ownership must outlive promise settlement

Retain an explicit broker-local manual-compaction stream owner from immediately before writing `/compact` until that command's result is consumed or the host terminates. Existing `PendingCompaction.settled` is insufficient: `compact_boundary` resolves the promise before its following result. A timeout likewise records an unverified operation without proving the command stopped. Preserve the command's idempotent promise and evidence deadline.

While this owner exists, assistant/partial frames cannot start a background turn. Consume its boundary/result on the compact path before considering turn termination. A success boundary, a refused compact, an unobserved timeout and a late result all stay outside the turn plane. The result clears this stream owner even if the promise settled earlier. Do not block forever after an observed result, and do not resend a timed-out command.

Automatic `compact_boundary` inside an active turn preserves that turn. An idle automatic boundary alone creates nothing; subsequent genuine assistant work can use the normal start rule. System status and user summary records remain silent. Never install a permanent compact mode merely because a boundary appeared. The builder must test boundary → result → genuine response and active turn → automatic boundary → response → result.

### One identity through completion

At the first qualifying background activity, choose one namespaced ID scoped to the native session. Prefer the first native assistant message ID, shared by its streaming and complete envelopes; hash the session and native ID into a bounded opaque ID. When the legacy complete envelope lacks that ID, use the next durable broker sequence as the session-scoped start token. Persist `turn-started` before emitting output. Never derive identity from final text, task ID, result count or time.

Keep this ID in `activeTurnId` until terminal persistence. Background starts never enter `turnQueue` or `ClaudeDeliveryLedger`. Do not mark a foreground input delivered because a background message appeared. Existing host state then reports active work and the delivery queue's running-turn rules apply naturally.

For an owned result: reject known duplicate/native-mismatched correlation first; select the current active ID; remove the queue head only if it equals that ID; publish one terminal event for that ID; clear its partial/interruption/candidate state; then activate the next actual foreground queue entry using the existing path. A background result must not shift a waiting foreground input. Preserve attention cleanup and idle publication. Success requires `subtype: success` and no `is_error: true`; interrupted acknowledgement/subtype remains interrupted; other terminal result subtypes are errors. Unknown subtypes never become completed work.

A result without an active turn creates no completion, even when it carries `origin: task-notification`. Newer correlated results belonging to another user input must not consume the current turn. The direct uncorrelated legacy stream remains sequential; neither `num_turns` nor arrival time proves which earlier turn a late result belongs to.

### Durable replay and duplicate boundaries

Reuse existing durable event sequence and journal producer key `engine-host:<hostKey>:<seq>`. Reattaching/retrying publication sends the original event and key. The notice identity remains `(child, turnId)` through event consumption, obligation insertion, retries and delivery settlement.

To cover a repeated native result during the next turn and after adoption, retain its native result UUID alongside the terminal event as one optional broker correlation field, `claudeResultUuid`. This is the only proposed event-type extension. It is absent on legacy rows, other engines, restart-generated errors and results without a UUID. Validate a supplied value as a nonempty string of at most 128 characters; a longer native value is omitted, never truncated into a colliding key. Projection deliberately leaves this internal field out of the public runtime payload. No database migration or new store is needed.

Keep only the most recent settled result UUID in broker memory, restoring it from the already-loaded event list, and reject that repeat before touching queue/active state. This gives constant work and space for the immediate duplicate case, including a repeat after a new turn starts. Durable event replay is independently idempotent for every retained turn through the existing journal and notice keys. Do not claim universal deduplication of arbitrary historical native frames: an uncorrelated old result, or an old native UUID outside this immediate replay boundary, has no proven turn binding in the available protocol. Do not broaden this patch into a historical native-frame index.

Retain current main's #3733 recovery behavior: an unmatched persisted start is settled once as error on adoption; a persisted terminal is never re-ended. Repeated adoption must not produce another notice. Native session resume can begin new work with a new observed start; never manufacture a successful continuation from an old unmatched start. Recording a terminal failure must not advance successful publication or delivery evidence.

## Exact implementation files and hunks

First integrate current main through the normal lane process, preserving #3733. This stage does not change branches or merge source. Locate hunks by the symbols below when integration shifts line numbers.

| File | Authorized implementation hunk |
| --- | --- |
| `src/lib/runtime/claudeStreamBrokerHost.ts` | Fields beside `activeTurnId`/`compactions` (`:711–746`): one stream candidate, manual-compact owner and last result UUID. `compact` (`:1218–1281`): retain command ownership independently of settled promise. `acceptMessage` (`:1577–1730`): classification before assistant output, main-session and compact guards, writer-fence check before admitting new background activity (do not reject an already-running result merely because release is waiting for reap). `acceptResult` (`:1731–1768`): duplicate/correlation refusal, active-ID-first settlement, matching queue removal, optional result UUID and existing cleanup. `restore` (`:1468`) reads last result UUID while retaining #3733's recovery semantics. Clear only the new transient fields in existing termination paths; preserve #3733's `endActiveTurn`, failure/release ordering and signal behavior. |
| `src/lib/runtime/engineHost.ts` | `RuntimeEvent` turn-ended arm (`:139`): optional `claudeResultUuid?: string`; no change to required fields, statuses, engine interfaces or other arms. |
| `src/lib/runtime/eventStore.ts` | `validEvent` turn-ended case (`:171`): accept absent correlation; validate a supplied UUID string and its bound. Preserve legacy load/tail-repair semantics and all sequence rules. |
| `src/lib/runtime/eventStore.test.ts` | Extend existing file-ledger round-trip/validation cases for new optional correlation, old rows, malformed values and torn tails. |
| `src/lib/runtime/claudeStreamBrokerHost.test.ts` | Add a background-turn describe block with the retained replay, streamed/non-streamed starts, multiple message/tool blocks, queued-input race, status/identity, immediate duplicate result before/after next start and file-backed restore. Keep all existing tests and #3733 regressions. |
| `src/lib/runtime/claudeStreamBrokerHost.compact.test.ts` | Extend existing FakeClaude compact cases with assistant frames while manual compaction owns the stream, boundary-before-result, refused/timeout/late-result controls, automatic compact during a real turn and result-only bookkeeping. Count starts, terminals and notice obligations, not just `health()`. |
| `src/lib/runtime/structuredDelivery.integration.test.ts` | Extend the current main fixture introduced by #3733 with a genuine unqueued background response. Use real broker, registry, runtime journal, publication/consumer and notice store. Add restart/publication replay and owner/generation refusal controls here rather than writing another driver. |
| `docs/design/issue-3689-diagnosis.md` | Record final implementation/check evidence and any precise supported-protocol limits without erasing this evidence history. |

Keep-list: `engineHostEvents.ts`, `consumers.ts`, `serverConsumers.ts`, `spawnNotice/{store,sweep,production}.ts`, `monitor/seatTick.ts`, `attention/seatAgenda.ts`, `registry.ts`, `structuredRecovery.ts`, `structuredDeliveryQueue.ts`, native queue contracts, SQL schemas, process/signal helpers, account/authentication settings and deployment files. The optional event field is internal correlation only; its producer is this broker, its persisted copy is the existing event store, its restore reader is this broker, and projection consumes only existing terminal fields. Other engines omit it. Old rows default to no correlation. No new audience or payload forwarding is introduced.

Preserve launcher opt-out, contained-stage and self exclusions, retired-flow suppression, legitimate retired-seat recipient routing, 30-second coalescing, result/verdict rendering, stored delivery target/key/text, uncertain receipt reconciliation, queue confirmation and writer claim rules. No extra notice writer, fake send operation, progress row, poller, transcript sweep, scheduler, framework or new UI is authorized.

## Replay promoted to regression

Append the two retained tests to the existing fixtures, adapting helpers to their production builders. Do not replace the original test file. The main regression changes the unqueued expectation from zero to **one start, one terminal, one obligation and one accepted keyed delivery**. The queued control remains one of each. Assert identical non-unknown turn IDs across start, every emitted delta/item, terminal, projected event and notice row. Observe active state before the result and terminal/idle state afterward.

The retained minimal assistant frame has no native message ID; preserve that input as a legacy case. Add documented UUID/message-ID/parent fields in a separate case, plus partial-message and tool-first variants. Add a notification prefix as a separate case; also retain the no-prefix case. Each still produces exactly one turn. Notification-only, system-only, empty assistant, subagent-only and unowned-result inputs each produce zero.

For notice correctness, execute the real projection and consumer twice for the same persisted event, run two sweeps, and inspect `readSpawnNoticeTurn`, the child attempt and delivered request. Require one obligation and the actual `spawnNoticeMessageId(child, turnId)` key. Use a typed eligible child fixture instead of the probe's `as never` cast. Drive an initial foreground completion, advance the fixture clock beyond 30 seconds, then run the background completion in the same conversation: require two distinct keys and the second result's `needs_decision` text. Retain an inside-window coalescing control.

For publication correctness, use `RuntimeJournal` and the existing controller fixture rather than constructing a runtime envelope by hand. Reopen the journal/event store after (a) persisted start, (b) persisted terminal before consumption, (c) inserted obligation, and (d) delivery acceptance with only its reply lost. The last case must reconcile the same request, target and key. A delivery spy by itself cannot prove durable reservation idempotency; use the existing delivery receipt fixture for this assertion.

Use the broker's existing writer fence immediately before new start/result actuation. Exercise a lost claim before input, and change owner or generation while the existing publication/registry/delivery awaits are suspended. Inspect the real enforcing layer after each await; require no stale write or delivery to the successor and a fresh authorized success. Preserve valid replay of a terminal already durably committed under its original identity. The controller's event pump and delivery layer remain verification boundaries: if a hostile fixture reveals a separate downstream defect, record the exact failing hunk for coordination rather than silently modifying the keep-list or claiming the fence passed.

## Acceptance matrix

| Case | Required observation |
| --- | --- |
| Normal foreground and meaningful background | One start and terminal per turn; stable identity; correct state; one keyed notice per eligible settled turn outside coalescing |
| Streamed response, complete response, tool-first response, multiple blocks/messages | Start precedes first meaningful output; one turn until result; no duplicate text caused by fallback |
| Foreground input admitted behind background | Background result settles background ID; queued operation keeps original identity, echo and confirmation; next result settles foreground ID |
| Manual success/refusal/timeout/late result; automatic compact; system bookkeeping | No extra turn, terminal or notice; compact operation retains truthful outcome and idempotency |
| Success, error, interruption and misleading success with `is_error` | Correct terminal status; no successful notice for an errored result |
| Malformed JSON, wrong session and proven child death after background start | Existing fault/release behavior; #3733 settles only identified active work once; no invented queued completion |
| Duplicate immediate result at idle, during next turn, after adoption | No extra terminal; next active turn and queue untouched; same notice key |
| Replayed durable start/end/consumer events, lost delivery answer | One persisted terminal outcome per recognized turn and one notice obligation; same reservation key/target; no new uncertain operation |
| Owner/generation changes and ineligible launcher | Refuse stale actuation; no unauthorized notice; valid new owner succeeds under its own identity |
| Ledger append refusal | No phantom successful completion; preserve durable start for existing recovery; no success claim from in-memory state alone |

## Overlap and integration order

- **#3677 → merged #3733:** main contains `63220341f4`, adding `endActiveTurn`, retaining unmatched starts across dead/unhosted status, and lifecycle regressions. Read its actual diff and keep it. Integrate it before this patch; extend its fixture with unqueued-start coverage. The old document's statement that #3677 has no product diff is obsolete.
- **#2926 / historical #3152:** actual broker patch concerns managed spawning, native PID/signal domain and stop fencing. Main already contains the historical signal work. Preserve it; never transplant the old whole file. No parser hunk belongs to that patch.
- **#3355:** published head `ac447bea65fb88a0245ab6c3aa2c4ec7a232cb9e` remains open; native queue deferral/replay identity is separate. Preserve its operation semantics and run the explicit native-queue file.
- **#3749:** published broker hunks add `assertCurrent` to host options and forward it into managed spawn. The corresponding existing checkout also has an uncommitted `structuredSpawn.ts` change. Preserve those launch-authority hunks; this brief does not own them.

Recheck published and unpublished diffs before product editing and before final review. Serialize any newly overlapping parser/terminal/restore hunk with its owner. No planned source patch was written during diagnosis, so no scratch combined-tree merge or combined-tree test is claimed. The builder must inspect the integrated final tree and retain the adjacent tests.

## Per-file checks and publication

In a fresh scratch export, run each file separately through the designated wrapper using `bun run test <explicit-file>`, fresh logs and actual exit codes. Isolate HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR; pin the Viewer control URL to a closed loopback port and keep evidence outside the worktree. Use the authorized direct-check path. No recorded-check custody, unknown receipt adoption, broad directory sweep, native provider call or live state is part of these checks.

| Explicit test path | What it proves |
| --- | --- |
| `src/lib/runtime/claudeStreamBrokerHost.test.ts` | Baseline-red/fixed-green replay and identity/classifier/queue/lifecycle cases |
| `src/lib/runtime/claudeStreamBrokerHost.compact.test.ts` | Entire original compact suite plus all silence controls |
| `src/lib/runtime/eventStore.test.ts` | Optional field compatibility and file-backed durable replay |
| `src/lib/runtime/structuredDelivery.integration.test.ts` | Actual publication, journal, registry, consumer, notice and recovery boundaries |
| `src/lib/runtime/claudeStreamBrokerHost.nativeQueue.test.ts` | Existing native queue receipts and ownership remain intact |
| `src/lib/runtime/engineHostEvents.test.ts` | Projection keeps the same public event and producer key |
| `src/lib/runtime/consumers.test.ts` | Consumer admission and deferred obligation semantics |
| `src/lib/spawnNotice/sweep.test.ts` | Stable keys, coalescing, recipients, retries and verdict text |

First run the promoted regression unchanged against the recorded base and preserve its failure. Then run the changed source and explicit files above. A current-main prerequisite failure must be compared with that same current main; do not attribute it to this patch. No full suite, build or typecheck is authorized for this diagnostic stage. Builder publication uses required hooks/CI; lifecycle work retains three independent review rounds. A green source campaign remains separate from installed acceptance.

This stage's validation is document/source review, retained-probe digest and exit verification, current requirement/overlap refresh, whitespace review and the repository's privacy gate on this single document. The final gate result is recorded in the stage report and retained evidence.

## Deferred — not currently justified

Transcript-age fallback in seat tick; new agenda asks derived from prose verdicts; notification policy/coalescing changes; broad recovery or native queue redesign; universal historical raw-frame deduplication; full producer-version capture campaigns; automatic retries of uncertain operations; historical backfill; new background pollers; UI changes; paid-provider probes; runtime-host socket campaigns beyond existing isolated fixtures; deployment and installed acceptance. These remain visible scope cuts. The requirement is met by observing a genuine background start and carrying its identity through the existing completion path.


## Implementation evidence — 9 November

The builder integrated current main before editing, retaining #3733. Published
#2926 and #3749 modify launch/signal authority; #3355 modifies native queue
replay. Their actual patches do not overlap this parser/result change. A bounded
scan of existing registered, non-scratch worktrees found no authored uncommitted
changes to the selected source and test files. Missing files in an initializing
checkout were excluded from that authored-change observation.

The implementation admits a background start only at meaningful main-session
assistant content. The broker persists its session-scoped identity and settles
that active identity before advancing a waiting foreground input. Manual
compaction retains stream ownership after boundary or timeout; an already-active
foreground delivery still owns its result, preserving the original compact
regression. Immediate native-result UUID replay is rejected across adoption;
legacy and uncorrelated frames retain the limits stated above. The optional
correlation remains internal to the broker ledger.

The promoted retained replay was run unchanged against the integrated base:
queued control passed; unqueued reply failed because active identity was null
(one pass, one fail, actual exit 1). The first complete broker run passed 188
tests. The first compact run exposed the foreground-result priority regression,
which was corrected. The first integration run exposed a fixture wait that
passed an async predicate to a synchronous helper; the wait now observes the
persisted start before reading health. Its stored notice already carried the
correct background identity. Initial failing logs remain in private evidence.

Checks use separate commands and fresh isolated exports, state, homes and logs.
The integration fixture runs an owned local protocol peer, the production
broker/controller/journal and the notice consumer/store/sweep. Notice delivery
uses the real reservation and receipt path with a fixture recipient engine. It
checks coalescing, opt-out, repeated consumption, journal/host reopening and a
lost acceptance reply under the same key and text. No live/provider delivery or
installed acceptance is implied. No performance improvement is claimed.


Final per-file results (Bun 1.4.0; each listed command has actual exit 0):

| File under `src/lib/` | Passed |
| --- | ---: |
| `runtime/claudeStreamBrokerHost.test.ts` | 189 |
| `runtime/claudeStreamBrokerHost.compact.test.ts` | 12 |
| `runtime/eventStore.test.ts` | 46 |
| `runtime/structuredDelivery.integration.test.ts` | 80 |
| `runtime/engineHostEvents.test.ts` | 25 |
| `runtime/consumers.test.ts` | 5 |
| `spawnNotice/sweep.test.ts` | 24 |

Total: 381 passed assertions-bearing tests in seven files. The explicit
`runtime/claudeStreamBrokerHost.nativeQueue.test.ts` command exited 0 with all
four installed-CLI cases skipped because `LLV_CLAUDE_BINARY` was unset. It is
not native protocol acceptance. The broker and integration suites exercise
queue identity with local fixture peers. Installed acceptance and the three
independent lifecycle reviews remain subsequent stages.

The final refresh found main advanced from `0f5995e7e591` to `9218e06e28c3`
through #3787, changing seat-tick/curation/scanner paths outside this patch.
The issue body timestamp and zero-comment count, #3749 and #3355 heads, and the
bounded unpublished-overlap scan remained unchanged. Tests use the recorded
integrated base and the final source export; no combined-tree test of that later
main commit is claimed. The source change does not alter the keep-list.


Self-review also tightened the existing writer fence for assistant and partial
output: a rejected background start must not leave unidentified output in a
successor's ledger. The native fixture now acknowledges its injected response
after the stdout parser has handled it; owner/epoch replacement then requires
byte-for-byte unchanged broker events. No asynchronous work was added to the
production parsing path. An event-store regression expectation was corrected
to preserve the existing refusal of malformed complete rows.
