# Seat silence on 14 November 2026

The confirmed incident was a provider quota failure followed by obstructed seat
recovery. The structured host ended the affected turn with an error at
**02:10:12.011 UTC**. Two later deliveries started separate turns, each of which
also ended with a quota error. The retained records rule out a single turn
remaining open for six hours.

The tick subsequently recorded **146 failed checks**, from 02:12:26.420 through
08:31:08.991 UTC, while verifying control history for quota recovery. This
verification scans global retained stop history in pages of 100, advancing only
one page per check. It runs before outstanding-wake reconciliation and ordinary
seat recovery. Useful seat work resumed after an operator message at
08:31:30.521 UTC. The interval from the first quota error to that message was
6 hours, 21 minutes, 18.544 seconds. [Native, Host, Tick, Controls]

The diagnosis stage changed documentation only. The implementation below adds
the protections requested in acceptance items 2 and 3 and reproduces the quota
recovery failure established here.

## Evidence and read boundaries

Acquisition began on 14 November at 09:04 UTC. Private originals, variable
bindings, source revisions, indexed search hits, delivery records and extracted
rows are retained in the stage's private evidence directory. Production reads
used standard file readers and Python's SQLite reader with URI `mode=ro` and
`PRAGMA query_only=ON`. No production store module, application read endpoint,
refresh, checkpoint, signal, message, restart or recovery action was invoked.
The diagnosis stage's only repository output was this report.

The commands and queries below use private variable bindings retained with the
evidence. Bounds are inclusive UTC unless stated otherwise. Source references
identify repository files, with production paths and identities omitted.
Diagnostic source positions refer to the diagnosis revision; implemented
behavior is described under Implemented recovery below.

| Evidence | Exact command or selection | Time coverage and limit |
| --- | --- | --- |
| Journal | `journalctl --user -u delegatus.service --all --since '2026-11-14 02:00:00 UTC' --until '2026-11-14 08:40:00 UTC' --utc --no-pager -o json` | Complete requested window: 15,713 records; exit 0. Multiline restart and adoption messages were read with surrounding records. |
| Native | Plain binary copy and line-by-line `json.loads` of the designated seat's transcript; retain `timestamp >= '2026-11-14T02:00'` and `timestamp <= '2026-11-14T08:40:00Z'` | 329 timestamped records; original retained as well, including records without timestamps. |
| Host | Plain binary copy and line-by-line `json.loads` of the matching structured-host event ledger and Claude delivery ledger | Complete retained ledgers. Host events carry sequence numbers; turn boundaries carry `accountingAt`. Native timestamps locate intervening frames. |
| Tick | `SELECT row_key,value_json FROM state_rows WHERE collection='seat_tick_runs' AND json_extract(value_json,'$.value.project')=? AND json_extract(value_json,'$.value.at') BETWEEN ? AND ?` | Project binding; 02:00:00–08:40:00 UTC; 151 retained decision rows, plus their paired timing rows. |
| Deliveries | `SELECT row_key,value_json FROM registry_rows WHERE collection='heldDeliveries' AND json_extract(value_json,'$.conversationId')=?` | Indexed conversation lookup; 24 retained rows. Admission and delivery timestamps distinguish transport arrival from later tick accounting. |
| Seat | `SELECT value_json FROM state_rows WHERE collection='orchestrator_seats' AND row_key=?`; equivalent keyed reads of settings, plus `SELECT collection,row_key,value_json FROM registry_rows WHERE row_key=?` | Current designation and conversation records used for identity resolution. Current state is not treated as a historical snapshot. |
| Controls | The `outbox` selection in `src/runtime-host/journal.ts:2301`, reproduced directly with the same state, kind, operation-receipt and ordering predicates | Read-time inventory of retained kill, interrupt and stop effects. Full SQL and rows retained privately. Payload admission times separate pre-incident history from later records. |
| Earlier work | Direct FTS queries against the transcript and memory indexes, project-scoped then unscoped; plain reads of matching transcript offsets and memory source files; `git show` of the October fixes | Several phrasings: deafness, seat silence, thirteen-hour silence and the October fix references. The specific audit search also bounded timestamps to 9–13 October, using the index's seconds-based timestamps. |
| Code | `git show "$INCIDENT_RELEASE:$SOURCE_FILE"`; `git diff "$INCIDENT_RELEASE" -- "$SOURCE_FILE"`; numbered source reads | Incident source retained privately. Quota recovery, tick controller, runtime journal, liveness and startup match the investigation checkout. The Claude host changed later; its incident line numbers are explicitly labelled below. |

The nominal memory-opening endpoint records an opened outcome; the normalized
conversation reader resolves through the live registry. Those handlers were
inspected and avoided. The prior-answer searches and openings therefore used
their stored indexes and source files directly.

## Timeline

All entries concern 14 November UTC. Snapshot, arrival, model response and
accounting times are kept separate.

| UTC | Observation | Evidence |
| --- | --- | --- |
| 02:04:58.092 | The old host's last tool result used by restart recovery. The native transcript subsequently contains additional work and a final response at 02:06:00.828; the restart capture was an earlier observation. | Journal, Native |
| 02:05:02.934 | Deployment record, returned by the seat's later deployment-status tool, reports successful settlement. | Native |
| 02:05:06.608 | Startup records its decision to resume the seat whose structured stream was severed. | Journal |
| 02:06:42.875 | Adoption briefly defers because an incumbent still owns the host. | Journal |
| 02:06:49.759 | Host event-cursor recovery selects the durable tail ahead of the registry cursor. | Journal |
| 02:06:53.294–02:07:06.614 | Automatic restart-continuation input reaches the native transcript, performs tools, produces a final response and ends successfully. Re-hosting demonstrably worked. | Native, Host |
| 02:09:20.297 | Tick prepares the deployment-settled snapshot. | Native |
| 02:09:21.377–02:09:22.250 | Host starts its turn; the wake appears in the native transcript at 02:09:21.421 and its registry delivery is confirmed at 02:09:22.250. | Host, Deliveries |
| 02:10:06.159–02:10:11.648 | Four task-update results arrive. All ten tool calls made during this wake have corresponding results. | Native |
| 02:10:11.671–02:10:12.011 | A new model request receives an HTTP 429 quota rejection at 02:10:11.977, with `usage_limit_reached` and no tool call. Host records `turn-ended`, status `error`, at 02:10:12.011, followed by `session-status: idle`. | Native, Host |
| 02:12:26.420–02:43:47.084 | Ten tick checks stop in quota control-history verification. | Tick |
| 02:44:31 | Merge completion time stated in the later worker finish notice. This precedes arrival of the notice. | Native |
| 02:45:57.157–02:45:57.776 | The finish notice starts a new turn. A new request receives the same quota error at 02:45:57.684; the host ends this turn at 02:45:57.696 and returns idle. Delivery is confirmed at 02:45:57.776. | Native, Host, Deliveries |
| 02:46:26.916 | Tick finally credits the deployment wake as landed, although its actual delivery occurred at 02:09:22.250. | Tick, Deliveries |
| 02:46:29.014–02:46:43.258 | Tick prepares another wake, including three waiting lanes and one already waiting 47 minutes. Host starts another distinct turn at 02:46:42.706. Quota rejection arrives at 02:46:43.193; host ends the turn at 02:46:43.226 and returns idle. Delivery is confirmed at 02:46:43.258. | Native, Host, Deliveries |
| 02:48:43.576–08:31:08.991 | Another 136 checks stop in the same quota control-history phase. No further seat tools or substantive model responses occur in this interval. | Tick, Native, Host |
| 08:31:30.494–08:31:42.395 | Operator input starts a new turn, enters the transcript at 08:31:30.521, receives a substantive model response at 08:31:39.706 and invokes a tool at 08:31:42.395. | Native, Host |
| 08:34:28.749 | Tick credits the earlier 02:46 wake as landed. The retained quota obligation is subsequently cancelled because the request was answered or superseded. | Tick, Controls |

## Where progress stopped, and why recovery failed

**The provider rejected the next request after the last successful tool result.**
The native record preserves the structured error class, HTTP status and quota
metadata. The same rejection appears twice more when later deliveries provoke
new requests. The broker receives the corresponding terminal results and
persists error endings. Its incident implementation handles `result` at
`src/lib/runtime/claudeStreamBrokerHost.ts:1857`, maps unsuccessful results to
`error` at incident line 1917, and clears the active turn and emits idle at
incident line 1947. The current equivalents are the result reducers around
`src/lib/runtime/claudeStreamBrokerHost.ts:2581` and `:2654`. [Native, Host, Code]

**Quota recovery then obstructed the rest of the tick.** The causal sequence is:

1. `src/lib/monitor/seatQuotaRecovery.ts:175` recognizes the terminal usage-limit
   notice. At line 301 it creates an obligation for the unanswered request with
   a control cursor starting at zero.
2. At line 321 it checks retained operator controls before testing capacity at
   line 324. `readSeatQuotaControlPage`, line 63, requests up to 100 boundary
   effects without supplying the available conversation filter. Unrelated
   effects advance the cursor. A full page means verification remains incomplete
   at line 76.
3. `stopped`, line 170, persists the advanced cursor, then throws a deferred
   dispatch error at line 172. The 146 decision rows name this exact phase and
   condition. Their 75-second budget annotation is not evidence of a timeout:
   the recorded ages are generally milliseconds, and the explicit cause is
   unfinished pagination.
4. `src/lib/monitor/seatTickController.ts:2005` awaits quota recovery before the
   outstanding-wake reconciliation beginning at line 2013 and host reachability
   at line 2045. A defer exits the check before those paths. This explains both
   long delays in crediting already-delivered wakes.
5. Each later rejected request can replace the quota obligation with a later
   request and restart its control scan at zero. The retained final obligation
   belongs to the 02:46 wake. [Tick, Controls, Code]

The read-time control inventory contains **18,747** eligible effects: **16,311**
have admission timestamps before 02:10 UTC, and **2,373** omit that timestamp.
None belongs to this seat conversation. This is a retained inventory observed
after the incident, not a claimed snapshot of the outbox at 02:10. It
corroborates the code and recorded deferrals: scanning the current inventory
requires approximately 187 full pages before its final partial page. At the
nominal five-minute check interval this is roughly 15.6 hours; even the dated
pre-incident subset needs approximately 164 checks. The observed median gap
between failed checks was 150.552 seconds; faster checks still did not complete
the scan before the operator intervened. [Controls, Tick]

The journal records successful re-hosting and cursor reconciliation. It contains
no matching Claude child/stream failure or runtime-event-ledger failure in the
requested window. Together with three complete host error endings and subsequent
idle statuses, this rules out a lost broker stream as the explanation for the
six-hour episode. The positive failure evidence is stronger than log absence.
[Journal, Host]

## Alternatives and remaining evidence limits

| Hypothesis | Conclusion |
| --- | --- |
| One model request hung from 02:10 until 08:31 | Ruled out: the request failed within a fraction of a second, and the host ended that turn. Two later requests also failed promptly in separate turns. |
| Re-hosting lost the response stream | Ruled out as the cause of this gap: restart continuation completed, and the re-hosted broker recorded later model, tool, quota-error and terminal frames. |
| The finish notice and wake remained behind the same busy turn | Ruled out: each has its own start, native input, quota response, error ending and delivery confirmation. |
| A legitimate long tool call explains the silence | Ruled out for the affected wake: ten calls, ten results, then an explicit provider failure and idle host. No unresolved call remained in that turn. |
| The tick stopped running or was disabled | Ruled out: 146 decisions record the recurring quota-verification failure. The retained settings enable the tick with a 30-minute wake interval, updated before the incident. |
| The ordinary busy-seat gate suppressed recovery | Ruled out as the recorded cause: the failed checks exit in quota recovery before reaching that gate. `seatTurnProgressing` is at `src/lib/monitor/seatTick.ts:390`; the gate is at line 1158. |
| The provider stayed exhausted for the entire gap | Unestablished. Three rejections are proven; a later request succeeds. The reset metadata on those rejections points to a later date, so it does not explain capacity at 08:31. There is no retained provider-side account-change history establishing when or why capacity became usable. |

Historical `get_orchestrator` and `agent_activity` answers for this seat were not
retained in the inspected window. Their exact lifecycle, verification state,
`silentForMs` and `stalledForMs` cannot be reported as observed API values.
Current registry state and a current probe cannot recover those old answers.

The relevant conditional behavior is explicit: a verified idle turn with a live
host returns `waiting / host_alive_turn_idle` before the silence threshold is
considered (`src/lib/lifecycle/liveness.ts:687`); `stalledForMs` is populated only
for `stalled` or `gone` at line 1652. An unverified live turn instead takes the
earlier unverified-evidence branch at line 665. Thus increasing transcript age
alone would not necessarily classify this seat as stalled. A delivered wake
needs its own response obligation. [Code]

The runtime journal's retained session events begin after useful work resumed;
earlier events are absent from that retained selection. The host's durable event
ledger preserves the missing turn boundaries. Raw child stderr is intentionally not
retained by the broker (incident host line 866). Neither gap prevents the quota
diagnosis. They limit claims about historic API projections and provider-side
capacity changes.

## Why the October work did not cover this case

The standing note's reference to the 9 October thirteen-hour silence was traced
to the original conversation on 10 October at 04:52–04:53 UTC. It proposes a
read-only investigation and then says it is awaiting an operator answer. The
retained note repeats that status. Searches of the local transcript and memory
indexes and retained tasks/pipelines did not locate a completed audit of that
specific episode. It supplies historical evidence of silence; it supplies no
verified implemented safeguard for the present quota case. No completed audit
has been silently assumed. [Earlier work]

The shipped October changes were read from their actual diffs:

- The recovered-idle-writer fix reconciles native transcript work with a proven
  closed host turn so that a stale busy projection stops suppressing a wake.
  It addresses turn evidence, without imposing a response obligation after a
  successfully delivered wake.
- The deployment-deafness fix revives a dead seat through the shared composer
  recovery path, with fenced fallback rotation and visible recovery records.
  Its admission depends on a dead host. This incident's re-hosting succeeded;
  quota rejection subsequently left a live, idle host.
- The later October catch-up change, documented in
  `docs/design/seat-tick-catch-up.md:1`, admits a proven completed dead-host tail
  and retains a per-project audit ring. It preserves the decisions used here.
  Its dead-host recovery predicate remains at
  `src/lib/monitor/seatTickController.ts:1817`; quota recovery runs first.

Those changes protect different transitions. None bounds the global control
scan now blocking the tick, and none distinguishes delivered input from useful
response strongly enough to recover this incident.

## Fix plan and proposed bounds

The first implementation step must remove the demonstrated quota-recovery
obstruction. Use the existing conversation-scoped `effectBatch` option
(`src/lib/runtime/client.ts:302`, `src/runtime-host/journal.ts:2305`) and retain
the explicit operator-control tombstone and cursor fences. Capture a finite
control-history watermark so later unrelated activity cannot extend verification
forever. Persist progress across restarts. A pending quota obligation must allow
delivery accounting and a visible recovery/status decision to proceed; it must
continue to fence competing sends of the original request. Do not replay a
possibly executed tool or create another wake identity to bypass uncertainty.

Capacity still needs fresh evidence. Resume the same request through the
existing quota path when eligible. When exhausted or unknown, record the reason,
next eligible time or missing evidence on the board and in the conversation's
readable status. Any replacement must follow existing account and rotation
authorization. A same-account re-host cannot repair exhausted capacity.

**Acceptance 2: host-owned silence deadline.** Propose **15 minutes** without
actual model output or tool activity while a turn is eligible to advance.
This is a recovery threshold, separate from transcript-age display. It allows
substantial reasoning time while bounding a genuine silent transport failure
well below the observed outage. Use one asynchronous deadline per active turn,
with ownership revalidation on expiry; inbound wakes and heartbeat frames do not
reset it. Adoption/re-hosting must reconstruct the deadline from durable progress
instead of granting a fresh unlimited period.

An owned foreground tool still executing, a recorded background task with a
verified live owner and execution deadline, a pending permission/question, or a
documented provider retry deadline suspends eligible-silence accounting. Record
the wait kind and its deadline. A live long tool must remain protected beyond
15 minutes. Reassess when the wait completes or its own deadline expires;
missing ownership evidence needs a visible diagnosis, never an invented tool
completion.

On expiry, record a fixed silence reason in the host ledger and readable
conversation status, request an interrupt, and bound control plus owned cleanup
to **two additional minutes**. Revalidate the turn, generation, writer fence
and operator-control tombstone at every asynchronous boundary. Resume once
through existing recovery only after old ownership has been conclusively
released. Target a terminal or resumed state within **17 minutes plus at most
30 seconds of scheduler allowance** under a responsive controller. If old-owner
cleanup is unconfirmed, record that failure and retain exclusive ownership;
never start a second host beside it. Quota failures should retain their existing
immediate terminal behavior.

**Acceptance 3: delivered-wake response deadline.** Keep transport arrival and
useful response as separate durable facts. Attach one response obligation to
the existing delivered wake and its seat generation. Bind response evidence to
that input's native turn membership. Synthetic provider errors, another input,
and receipt reconciliation do not count as useful answers. Actual model/tool
progress can refresh the progress deadline; a final response settles it.

Let `P` be the configured check interval and `I` the effective wake interval
frozen when delivery occurs. Propose:

`response bound = max(2 × P, min(I, 15 minutes))`

Two check intervals absorb delivery/projection races; the 15-minute cap prevents
an hourly reminder setting from authorizing an hour of deafness. With the
current default `P = 5 minutes` and this seat's configured `I = 30 minutes`, the
bound is **15 minutes**. Detect on the next check, giving a **20-minute** maximum
to begin recovery under that cadence, then the same two-minute control bound.
The 02:46 delivery would consequently require a recorded response or recovery
decision by approximately **03:06 UTC**. This is a proposed bound, not an
existing guarantee.

Evaluate this obligation before quota verification or ordinary busy-seat
suppression can skip it. Respect the same genuine-tool/background waits as the
host deadline, and reconcile with host recovery so only one mechanism owns the
action. Use existing nudge, re-host and rotation rules: preserve the unanswered
request, record a single bounded nudge where justified, confirm release before
re-hosting, and rotate only under existing eligibility. Persist the action and
outcome on the board, including explicit capacity and ownership holds. Operator
stop/off/revocation always wins.

## Required implementation verification

Extend the existing host integration tests in
`src/lib/runtime/claudeStreamBrokerHost.integration.test.ts`, quota tests in
`src/lib/monitor/seatQuotaRecovery.test.ts` and controller delivery/recovery tests.
Use the real broker, persistence and tick entry points for these cases:

- Drive the real Claude broker and event persistence through adoption after a
  restart. Emit model/tool activity, complete the tool, then leave the stream
  open without a result. Advance the silence clock and require the bounded
  terminal/recovery reason. Assert one owner throughout and durable behavior
  across another restart.
- Keep a real owned foreground tool and a recorded background task active past
  the proposed bound. Neither may be interrupted. Test completion, deadline
  expiry, unknown ownership and operator control separately.
- Reproduce this incident through the real host: terminal quota errors after
  tool results, then separate delivered inputs with further quota errors.
  Assert three error endings and idle states, preserving provider cause and
  the original unanswered request.
- Drive the real tick with a delivered, unanswered wake and a live idle host;
  repeat with a genuinely busy silent host. Advance time across the formula's
  threshold. Assert durable board recovery, exactly one authorized action and
  no parallel seat, including after controller restart and uncertain delivery.
- Seed at least the observed scale of unrelated retained stop effects before a
  quota cut. The real conversation-scoped read must reach its answer without
  hundreds of ticks. A matching authenticated operator stop must still fence
  all continuations. Test exhausted, unknown and newly available capacity;
  receipt accounting must proceed in every case.
- Recheck the October dead-host, recovered-idle and catch-up cases. Repeat
  delivery while an earlier recovery is active, and assert side effects and
  durable task/seat state after restart.

The diagnosis stage ran no lifecycle probe or runtime test against production. Document
review and whitespace checks passed. The publication privacy gate returned
`PRIVACY GATE: PASS` with isolated HOME, configuration, state, cache and temporary
directories and a closed local control URL. It ran:

```sh
bun scripts/privacy-publication-gate.ts --require-known-values --check-commits \
  --base "$MERGE_BASE" --paths docs/reports/seat-silent-turn.md
```

The private verdict records the resolved merge base, invocation and exit 0.
No source test was touched by the diagnosis stage. Implementation verification
requires the specified isolated type/lint/publication checks and each touched
test file separately;
changes under the runtime host also require its pinned-runtime rehearsal and
the three review rounds required by the specification. No throughput or latency
improvement is claimed by this report.


## Implemented recovery

The structured Claude, Codex and Copilot hosts now own a **15-minute eligible
silence deadline**. Actual model output and tool activity refresh it. Input
echoes and transport heartbeats do not. An executing foreground call, pending
permission or question, provider retry deadline, or recorded background task
holds recovery. Unknown background ownership produces a readable hold diagnosis.
The existing background reader consumes bounded incremental transcript pages.
The watchdog keeps one timer and bounded tool inventories per host, and stores
its eligible deadline, actual activity and wait identities in a small per-session
checkpoint. Protected waits keep actual activity unchanged. Only the current
writer updates that checkpoint. A restored wait is verified immediately; its
release grants one durable eligible interval across process restarts.
Checkpoint writes coalesce for 30 seconds; adoption retains that fixed allowance
without advancing the checkpoint on repeated restores.

On expiry, the host records `turn-silence-timeout`, ends the turn with an error
and invokes its existing fenced process cleanup. A retained process claim
continues to prevent another host from starting while cleanup is unconfirmed.

The tick separately retains a response obligation when a wake lands. Its bound
is frozen from the preparing check's cadence and wake interval:

`max(2 × check interval, min(wake interval, 15 minutes))`

This is **15 minutes** at the default five-minute check cadence and a 30-minute
wake interval, with detection at the next check. Two check intervals absorb
projection races; the cap limits the effect of long reminder intervals. Response
evidence must belong to the delivered input's turn. Provider error envelopes,
unrelated turns and delivery receipts cannot settle the obligation.

The tick evaluates the response before quota verification and ordinary busy
suppression. An overdue idle seat receives one queued recovery nudge through
the shared composer path. Intent and a stable delivery identity survive a
controller restart. Response tracking resolves the reservation's native operation
and generation, including a recovery admission with a distinct operation ID,
and checks the frozen recovery authorship. The normal dead-host recovery path can re-host it, and
fallback rotation retains its existing gone-host and delivery-uncertainty
fences. An active host retains responsibility for its own deadline. Recovery,
capacity and ownership holds are recorded on the board. Transient provider
errors permit recovery once no quota, authentication or retry owner holds it.

Quota control verification now uses the existing conversation filter and a
finite journal snapshot watermark. It retains its cursor and watermark across
checks and restarts. Pending or unavailable verification fences competing
sends while allowing outstanding delivery accounting to proceed. Authenticated
operator controls and their durable cancellation tombstones retain precedence.

Response recovery reads that same tombstone before detection and through
reservation, re-host and fallback-rotation admission. A newer operator control
retires the response obligation and resolves its board notice. A control that
arrives during awaited admission fences the pending action; the next check
retires the retained obligation.

Quota verification updates its cursor and watermark together under the store
transaction, only when both still match the page's starting scan. A stale page
defers to the newer scan, preserving completed verification after earlier
effects settle or compact. The resulting record remains readable and can
continue recovery when capacity returns.

Fulfillment is monotonic across the original wake and its authorized
continuations. A failed recovery cannot erase an already completed answer.
Generation reads also inspect older bound generations before retaining an
unanswered successor, so normal agenda wakes become available after settlement.
Failures without any completed model answer remain unresolved.

Code takes precedence over four assumptions in the proposed plan. A Claude
re-host already ends an unfinished old turn; Codex can adopt a live native turn
and needs its restored deadline armed explicitly. Native resume history can wrap
a still-running command in a completed item event. The watchdog uses native
item status and buffered completion evidence to reconstruct its tool ownership;
historical output does not renew silence. The existing failure path
ends a silent turn immediately and owns process cleanup; the implementation
uses that path instead of adding the proposed two-minute interrupt phase.
Native background records carry no verified owner execution deadline, so missing
ownership evidence remains an explicit hold. No process completion is invented.
The production incident remains three quota-error endings followed by blocked
recovery, as established above.

The implementation makes no throughput or latency improvement claim. All
lifecycle checks use isolated state and child processes; production was unchanged.

The correctness-review follow-up adds focused coverage for operator control
before detection and during observation, admission, reservation, re-host and
fallback rotation; concurrent quota pages across effect settlement and
compaction; and an original answer racing admission before a recovery fails.
The persisted event reader covers that last ordering in both the same and a
successor generation, alongside failures with no completed answer. The real
tick verifies settlement and the availability of a subsequent ordinary wake.


## Implementation verification

The final source was checked on 14 November 2026 under the pinned Bun 1.4.0.
Each test file ran in its own command with a fresh HOME, XDG configuration,
TMPDIR and `LLV_STATE_DIR`, with `LLV_VIEWER_CONTROL_URL` on a closed loopback
port. Recorded checks ran sequentially through the gate wrapper. Private logs
retain actual exits, runner summaries, file hashes and both baseline observations.

The response, quota, delivery and main controller files, typecheck and monitor
lint were rerun for the correctness-review follow-up. The other rows retain
the implementation-stage results for code unchanged by that follow-up.

The pre-change broker regression reached a real child after adoption, consumed
its tool results and failed because no silence deadline existed. After the
change, the integration file covers silent transport, streamed reasoning, live
foreground and background processes, permissions, provider retry, lost writer
ownership, durable re-adoption and three separate quota-error endings.

| Command or explicit test path | Result |
| --- | --- |
| `bun node_modules/typescript/bin/tsc --noEmit --incremental false` | Pass |
| `bun node_modules/eslint/bin/eslint.js` over the changed TypeScript files | Pass: zero errors, two existing warnings in the six monitor files |
| `src/lib/runtime/turnSilence.test.ts` | 17 pass, including two- and three-process restarts, wait release, writer fencing and adoption/heartbeat clocks |
| `src/lib/runtime/claudeStreamBrokerHost.integration.test.ts` | 8 pass; 6 opt-in subscription cases skipped |
| `src/lib/monitor/seatWakeResponse.test.ts` | 23 pass, including cold indexed reads, successor delivery, authorship conflict, closed-store holds and monotonic fulfillment |
| `src/lib/monitor/seatQuotaRecovery.test.ts` | 53 pass, including 18,747 unrelated retained effects, finite verification, authenticated stop and concurrent scan revisions |
| `src/lib/monitor/seatTickController.delivery.test.ts` | 87 pass; 1 pre-existing assertion failure reproduced twice on the base; all operator-control and answer-race regressions pass |
| `src/lib/runtime/claudeStreamBrokerHost.test.ts` | 257 pass |
| `src/lib/runtime/codexAppServerHost.test.ts` | 387 pass, including native pending-tool restoration, buffered completion and historical-output deadlines |
| `src/lib/runtime/copilotAcpHost.test.ts` | 47 pass |
| `src/lib/monitor/seatTickController.test.ts` | 107 pass, including existing authentication and host recovery paths |
| `src/lib/monitor/seatTickState.test.ts` | 37 pass |
| `src/lib/monitor/seatTickSources.test.ts` | 167 pass |

Every test command used `bun test --timeout=60000` followed by exactly one
listed path. The total is **1,190 passing tests, six skipped cases and one
baseline failure**. The delivery file exits 1 because its existing journal
settlement assertion expects different diagnostic wording. Two fresh base runs
each produced 64 passes and that same failure. The base source is identical to
the merge-base source for all tested files. New recovery regressions all pass.
The native-admission assertion now waits for completed echo processing after
the durable consumed record appears, keeping the same bounded wait. The final
full Claude host file passes all 257 cases. Earlier timing-failure receipts and
the successful base comparison remain retained. Final publication privacy is
reported with the pull request.

## Publication repair

The publication hook also selects sibling test files for every changed source
stem. Its policy file exposed eight regressions in the correctness follow-up.
Full isolated runs of `src/lib/monitor/seatTickController.policy.test.ts` on
the inherited commit and its merge base produced 77 passes / 15 failures and
85 passes / 7 failures respectively. Every introduced case passed on the base.
The eight cases are:

- Shared composer recovery after terminal failure and terminal exit after claim.
- Definitive failed revival with a rotated notice and with a failed notice.
- Retrying an owed failed-revival notice after controller restart.
- Updating the existing production recovery card after restart, with the card
  initially open and initially closed. The earlier runner printed the same
  placeholder name for both variants; their names now distinguish them.
- A composer host appearing during fallback, even when its MCP is healthy.

All eight pin required behavior. The transport return observer settles the
dispatch token before fallback rotation. The new operator-control check had
called a wrapper that also required that token to remain active. It therefore
refused valid fallback and recorded a superseded recovery without attempting
rotation. Replacement admission now calls the original recovery-authority
guard, then rechecks current seat authority and dead-host identity. Dispatch
admission continues to check its token while reserving and re-hosting.
Operator cancellation, a concurrent composer, uncertain delivery and live-host
ownership still fence replacement.

The existing focused cases retain their rotation, notice, board-state and
restart assertions, and additionally check that dispatch has already settled
before rotation. The composer race checks admissibility before the replacement
appears and refusal afterward. No behavioral assertion was relaxed. Main was
merged with a merge commit before renewed verification. The repaired full policy
file has 85 passes and the same seven base failures; all eight regressions pass.
Final hook-selected
comparison, typecheck, lint and publication-privacy results are recorded in the
pull request and retained private check logs; the earlier verification table
above describes the previous implementation-stage runs.


## Final correctness follow-up

A delivered recovery nudge previously left the response obligation in `nudged`
forever. Even conclusive host loss could not reach admission or fallback
rotation. A successful nudge now starts one additional response interval using
the obligation's frozen bound. At the next check after that interval, an
unanswered nudge with a conclusively gone host enters the existing fenced
replacement path. Its handoff retains the original operation and asks the
successor to continue the existing request and results. Rotation outcome and
any failed replacement remain durable board notices. The same recovery key
prevents repeat rotation after restart. Live or busy ownership, unavailable
liveness, delivery uncertainty, quota ownership and operator controls retain
their holds. Fresh answers settle the obligation before replacement.

The Codex adapter also dropped both native reasoning delta notifications, and
the Copilot adapter dropped `agent_thought_chunk`. Their watchdogs consequently
measured silence while the models were still producing reasoning. Both adapters
now forward current reasoning as activity items; those items cannot fulfill a
response obligation. Codex requires the active turn and owned thread, excludes
resume replay and checks the writer fence. Copilot requires the running turn
and matching session, excludes replay and checks the writer fence. Empty
chunks grant no progress. A complete interval without further activity still
expires the host through its existing cleanup path.

Focused checks drive both Codex delta shapes and Copilot thought chunks through
the real host adapters, on fresh and adopted sessions. They prove activity at
minute fourteen protects the host at minute fifteen, leaves the request
unanswered and then expires after a complete silent interval. Negative cases
cover foreign ownership, stale turn identifiers, empty output and lost writers;
resume history stays outside live activity. The tick check starts with a real
delivered nudge, reopens its persisted state, proves the interval boundary and
checks rotation, failed replacement notices, repeated recovery, capacity holds,
operator cancellation and a composer appearing during admission.

The inherited publication-repair source hashes and terminal receipts were
verified before this follow-up. They preserve the eight-case base/head
comparison described above. Final checks renew the hook's complete selected
file list on the committed follow-up, together with types, changed-file lint
and publication privacy. Exact commands, exits and current counts are recorded
in the pull request and retained private evidence. No runtime-host source or
Bun pin changed, and no production action was performed.


## Delayed delivery and Copilot session ownership

Wake preparation and transport arrival carry separate meanings. Settlement now
copies the original preparation timestamp into the response obligation; the
persisted reader validates it and keeps it through restart and nudge updates.
The operator-control fence compares against preparation at every existing
recovery guard, including fallback rotation. A stop recorded after preparation
continues to cancel that request when transport confirms arrival later. Legacy
response rows without preparation proof honor every retained control for that
seat. Legacy outstanding wakes whose age is stamped on first observation retain
an explicit missing-preparation marker; that age stamp cannot authorize recovery.
A newly prepared post-stop wake carries its own timestamp and remains
eligible.

The preparation writer is the ordinary wake admission path in
`src/lib/monitor/seatTickController.ts`. Both immediate settlement and later
receipt reconciliation call `seatTickWakeCommit` in `src/lib/monitor/seatTick.ts`.
JSON and SQLite tick-state readers share `normalizeSeatWakeResponse`; recovery
updates copy the obligation, while seat rotation clears its old identity. No
other producer or default may substitute transport arrival for preparation.
Focused delivery tests settle the real retained wake, reopen its state and
exercise pending, uncertain-nudge and landed-nudge states after cancellation,
plus the post-stop success path and conservative legacy handling.

Every Copilot `session/update` now checks the current session and writer fence
before accepting text, reasoning, tool starts or tool completions. Replay stays
excluded. Foreign or missing session identifiers and lost writer ownership
cannot refresh activity, create waits or clear an owned tool wait. Tests use
fresh and adopted real adapters, inject each unowned update and verify unchanged
retained events and the silence deadline. An owned long tool remains protected
past that deadline; its own completion restarts the full silence interval.
The adjacent permission-request path applies the same session and writer
checks before creating an attention hold, replying cancelled to foreign
requests and writing nothing after losing the writer fence. Focused checks prove foreign permission cannot suspend recovery,
while an owned permission still holds until answered. Two existing permission
fixtures now name their owning session; their cleanup assertions are unchanged.

The eight publication-policy regressions were reproduced again in separate
isolated full-file commands: the inherited commit had 77 passes / 15 failures,
and its original merge base had 85 passes / 7 failures. All eight extra failures
pin required behavior; their existing production repair and assertions remain.
The renewed committed-tree comparator, typecheck, changed-file lint and privacy
publication results are recorded in the pull request. No runtime-host source,
Bun pin or production state changed.

Three exact legacy-row expectations now include the missing-preparation marker
in both outstanding and retired wake records. They retain full equality of the
payload, original key, first-observed timestamp and retention state, and keep
the zero-send and deferred-wake assertions. The first committed comparator
identified only those three newly stored fields as introduced policy failures;
its two other intermittent observations were classified separately as flaky.


## Successor fix for terminal nudge and empty envelopes

The final three review findings have focused regression groups on the inherited
source at `3b68bed8`, followed by the same checks on the repaired source. Their
terminal logs, exact source manifests and final check results are retained in
the stage evidence; the pull request records the final committed-tree verdicts.

A landed nudge whose own native turn conclusively ends without an answer now
uses the existing automatic rotation admission when the incumbent is positively
idle. The bound is **one frozen response interval after the nudge, detected by
the next tick**: 15 minutes plus at most the five-minute check interval at the
default cadence. The normal rotation command revokes predecessor authority and
passes the original request and existing results to its successor. The existing
seat recovery key persists through restart and fences repeat replacement. An
admission held by a newly active turn remains pending under that same key.
No additional recovery mechanism or timer is introduced.

Both the production event reader and reducer require terminal evidence from
the nudge or an authorized continuation; the original failed turn alone grants
no live-owner replacement. Active turns, owned foreground or background work,
permission or question waits, provider retry and quota ownership, uncertain
membership or delivery, operator controls and changed seat or host ownership
retain their fences. Conclusive host loss still uses the existing cleanup
admission. This bound applies while those independent holds are absent.

Agenda delivery is serialized until the previous delivered response obligation
is reconciled, including while it has recent progress. Outstanding receipt
accounting continues. Dispatch admission and fallback authority check that no
response obligation appeared during awaited work. Once the old answer is
reconciled, the next delivered input retains its own identity, preparation time
and frozen bound through restart. Its error-ended turn still triggers recovery.
The optional injected source contract remains unchanged; production installs the
response reader through `defaultSeatTickSources`.

The host watchdog and response reader share the meaningful model-content
predicate. Empty and whitespace message or reasoning envelopes, including empty
content and summary blocks, refresh neither checkpoint. Real text and thoughts
refresh activity; native tool transitions retain their existing ownership
handling. This changes the classification of empty output without changing the
15-minute host deadline or protected waits.

The regression groups are:

| Finding | Test filter and path | Inherited source | Repaired source |
| --- | --- | --- | --- |
| Terminal failed nudge | `terminal failed nudge uses bounded existing rotation` in `src/lib/monitor/seatTickController.delivery.test.ts` | Idle case fails: expected one rotation, observed zero | Recovery at the bound; busy, exclusive work, unknown ownership, uncertain delivery, absent nudge proof, disabled tick and changed turn/seat remain fenced |
| Overlapping wake responses | `serialize a newer agenda wake` in the same file | Fails: a new agenda send starts while the old response is still unresolved | Old answer is reconciled before delivery; new identity and deadline survive restart and recover when unanswered |
| Empty native envelopes | `empty native envelopes preserve both deadlines` and `meaningful native envelopes retain` in `src/lib/runtime/codexAppServerHost.test.ts` | Twelve empty-envelope cases fail: host stays active and response progress moves; three positive controls pass | All fifteen cases pass, including real reasoning, text and a long owned command |

Each filter runs as `bun test --timeout=60000 <path> -t '<filter>'` through the
required gate wrapper. Full lifecycle files run separately with private HOME,
XDG configuration, TMPDIR and state, and the Viewer control URL on a closed
port. TypeScript, changed-file lint, full publication privacy from the merge
base and the pre-push planner's committed-tree touched-test selection complete
the final checks. Existing baseline failures are reported separately by that
comparator. No throughput or latency gain is claimed; production acceptance
belongs to the authorized release owner after merge and deployment.


Main advanced during final verification and was merged before renewed checks.
The merge conflicts were `src/lib/monitor/seatTick.ts`,
`src/lib/monitor/seatTickSources.ts`, `src/lib/monitor/seatTickState.ts` and
`src/lib/monitor/types.ts`. Resolution preserves both decision-form metadata
from main and the frozen response obligation. The added wake/proactive delivery
cases pass both real plan outputs through persisted state, settlement and a
second read, checking that the form cursor and response bound survive together.
