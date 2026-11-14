# Host stops and unconfirmed hosts

Read-only diagnosis of outcome 1. Source revision: `fe4d96e4`. Date: 2026-11-14. All times are UTC.

The installed system has two separate failures: a historical closed lane is absent from the controller's work queue despite retaining a host obligation; other finished lanes retain living native processes after accepted stops and unsuccessful retirement attempts. The two reported stage-start incidents were ended by the seat's explicit kills: their identity-bound stop receipts name those operations, and the native roots exited in under a second after SIGTERM. The exact outcomes of the six automatic requests are no longer retained.

No process was signalled, stopped or retried. No suite, build, typecheck, deployment or registry helper was run. Only this report was written as a worktree output; no commit or staging was performed.

## Evidence and limits

Both originating board tasks were read whole with `get_task` before other investigation. Their corrected account supersedes the initial suggestion that a helper killed the first tree. The requirement is paraphrased here: finished agents must stop within a bound or retain a definite reason; provably absent hosts must converge to confirmation while living work remains protected.

| Evidence | Read time, query or command, and scope |
| --- | --- |
| Board inventory | 17:53–17:54: `list_pipelines(project=<full project key>, state=["completed","closed"], includeClosed=true, compact=false, limit=100, cursor=<preceding nextCursor>)`, through all 23 pages. 178 lanes; 29 carry 62 unconfirmed host references. |
| Full lane records | 17:54–17:55: `get_pipeline(pipelineId=<selected lane>, full=true)` for eight affected lanes, plus the two incident lanes. Selection covers lane creation dates November 2, 5, 13 and 14, six completed and two closed lanes. Every outstanding host in those eight lanes was included: 23 references. |
| Current process identity | 17:55:10–17:55:35: inline Python reads of the addressed registry rows and `/proc/<recorded number>/stat`, current kernel boot record and PID namespace. Compared the recorded start token with stat field 22. No signal-zero probe or process-control API was used. |
| Registry and lane state | 17:54–18:04: Python `sqlite3.connect(path.as_uri()+"?mode=ro")`, followed by `PRAGMA query_only=ON`. Keyed SELECTs from the registry's `registry_rows`, termination generation/owner tables, and the state's `state_rows`, `pipeline_tick_work`, `pipeline_controller_work`, `pipeline_attempt_refs` and `sqlite_master`. No application registry instance was constructed. |
| Termination evidence | 17:55–17:56: streamed both retained `host-termination-journal.ndjson` files, matching addressed session keys; read identity-derived stop/exit receipt files beneath `host-exits`. Those filenames are derived exactly as `src/lib/runtime/hostExit.ts:28` specifies. |
| Missing operation history | 17:56–17:57: SELECTs from the runtime journal's `operations` by each incident conversation and each of the six deterministically derived automatic operation keys, and by the two explicit operation keys. No rows remain. The retained `events` window then started at 17:13:25.736, later than both incidents. Absence does not establish a former outcome. |
| Retirement observation | 17:53: `deployment_status(kind="host-retirement", project=<full project key>, limit=100)` refused project attribution. The caller's stored `projectOwnership` is null despite its launch profile recording the project; `src/lib/mcp/bindings.ts:6871` requires the former. No second API request was made. |
| Retirement fallback | 17:57–18:00: read the complete stored report, all three result arrays, and its journal; joined conversations to every terminal lane's stored attempts and independently checked memberships. Latest snapshot read at 18:00:21: sweep 17:59:24.831–17:59:43.434. This covers the whole stored report without an API page boundary. The earlier 17:54 snapshot was also read whole. |
| Earlier answers | 17:53–17:57: several project-scoped and unscoped `search_transcripts` and `search_memory` queries. Opened the acceptance transcript with `conversation_messages(transcriptPath=<hit>, kinds=["message"], roles=["assistant"])`; checked its findings against current rows. Relevant memory searches returned no prior repair; an unrelated hit was discarded. Memory hit opening appends an outcome, so that mutation was omitted. The paused refusal-diagnosis design was read from Git. |
| Concurrent changes | 17:54–18:00: `gh pr diff 4029 --repo <repository>`, changed-file and test-diff inspection; `git diff <merge-base> <paused refusal-reason branch>`. Source references below are to the assigned revision, except where explicitly identified as proposed changes. |

The production read handlers were inspected first. Lane reads select stored records (`src/lib/mcp/bindings.ts:6366`, `:6542`); retirement status reads a bounded report and opens its registry read-only (`src/lib/runtime/structuredHostRetirementStatus.ts:28`, `:180`). Search queries read their existing indexes; memory opening would write (`src/app/api/search/memory/route.ts:36`). The explicit task reads were performed first as required by the brief.

Private bindings and identity values are deliberately omitted. The tables identify subjects by lane kind, creation date, stage and attempt count. Record filenames and line numbers allow the installation owner to reproduce the joins without publishing process numbers, conversation keys or account details. Journal line references address the unrotated file as read; rotation can move these records.

## 1. Sample of completed and closed lanes

**Confirmed:** 22 sampled roots are alive, with exactly the recorded start token and kernel boot identity; one root is absent and belongs to an earlier kernel boot. Each reference resolves to one recorded generation. For the living roots, the recorded identity is the structured host's native process tuple; for the absent root it is the retained exit-process tuple. These are native agent roots, distinct from the Viewer process holding the writer claim.

All 22 living roots have no retained stop or exit receipt. Twenty-one have captured process-tree records; one has no matching termination-journal record. A capture is persisted before actuation, so it establishes an attempted preparation, not a sent signal (`src/lib/runtime/structuredHostControl.ts:641`). The journal itself records capture, withdrawal and settlement, rather than every signal.

The stored-result timestamp below is the lane record's timestamp, **not** a signal time. For completed lanes the result is in `unconfirmedHosts`; their full records have no separate close report. For both closed lanes the same outstanding references remain in `closeReport.stillRunning`. Journal references are to `host-termination-journal.ndjson`.

| Lane kind and creation date | Stage / attempt | Recorded-root comparison at observation | Stored result and timestamp | Journal lines |
| --- | --- | --- | --- | --- |
| completed investigation lane, Nov 14 | investigate / 1 | alive; same start and boot | queued; unconfirmed; 2026-11-14 14:55:15.612 | 8782 |
| completed four-host lane, Nov 14 | build / 1 | alive; same start and boot | queued; unconfirmed; 2026-11-14 14:27:22.312 | 8768 |
| completed four-host lane, Nov 14 | review / 1 | alive; same start and boot | queued; unconfirmed; 2026-11-14 14:33:37.913 | 8781 |
| completed four-host lane, Nov 14 | fix / 1 | alive; same start and boot | queued; unconfirmed; 2026-11-14 15:18:21.989 | 8789 |
| completed four-host lane, Nov 14 | review / 2 | alive; same start and boot | queued; unconfirmed; 2026-11-14 15:25:13.021 | none |
| completed five-host lane, Nov 14 | build / 1 | alive; same start and boot | queued; unconfirmed; 2026-11-14 11:26:22.717 | 8519, 8938 (3 records) |
| completed five-host lane, Nov 14 | review / 1 | alive; same start and boot | queued; unconfirmed; 2026-11-14 11:39:20.601 | 8538, 8954 (3 records) |
| completed five-host lane, Nov 14 | fix / 1 | alive; same start and boot | queued; unconfirmed; 2026-11-14 12:06:32.509 | 8543, 8964 (3 records) |
| completed five-host lane, Nov 14 | review / 2 | alive; same start and boot | queued; unconfirmed; 2026-11-14 12:17:59.966 | 8554, 8972 (3 records) |
| completed five-host lane, Nov 14 | fix / 2 | alive; same start and boot | queued; unconfirmed; 2026-11-14 12:30:03.111 | 8563, 8979 (3 records) |
| completed two-host lane, Nov 14 | build / 1 | alive; same start and boot | queued; unconfirmed; 2026-11-14 02:19:02.248 | 7499, 8867 (14 records) |
| completed two-host lane, Nov 14 | review / 1 | alive; same start and boot | queued; unconfirmed; 2026-11-14 02:30:33.691 | 7505, 8873 (14 records) |
| completed four-host lane, Nov 13 | fix / 1 | alive; same start and boot | queued; unconfirmed; 2026-11-14 00:34:47.143 | 7321, 8837 (17 records) |
| completed four-host lane, Nov 13 | fix / 2 | alive; same start and boot | queued; unconfirmed; 2026-11-14 00:45:11.971 | 7333, 8851 (17 records) |
| completed four-host lane, Nov 13 | review / 1 | alive; same start and boot | queued; unconfirmed; 2026-11-14 00:51:29.937 | 7379, 8853 (16 records) |
| completed four-host lane, Nov 13 | review / 2 | alive; same start and boot | queued; unconfirmed; 2026-11-14 01:53:40.099 | 7491, 8861 (14 records) |
| closed four-host lane, Nov 13 | review / 3 | alive; same start and boot | control unavailable; stillRunning; 2026-11-14 01:16:48.619 | 7296, 8842 (18 records) |
| closed four-host lane, Nov 13 | review / 4 | alive; same start and boot | control unavailable; stillRunning; 2026-11-14 01:16:48.619 | 7383, 8856 (16 records) |
| closed four-host lane, Nov 13 | fix / 3 | alive; same start and boot | control unavailable; stillRunning; 2026-11-14 01:16:48.619 | 7287, 8829 (18 records) |
| closed four-host lane, Nov 13 | fix / 4 | alive; same start and boot | control unavailable; stillRunning; 2026-11-14 01:16:48.619 | 7373, 8847 (16 records) |
| completed two-host lane, Nov 5 | fix / 4 | alive; same start and boot | queued; unconfirmed; 2026-11-14 11:05:34.094 | 8377, 8936 (4 records) |
| completed two-host lane, Nov 5 | verify / 3 | alive; same start and boot | queued; unconfirmed; 2026-11-14 11:17:09.787 | 8528, 8945 (3 records) |
| closed earlier-boot lane, Nov 2 | build / 1 | absent; earlier boot | control unavailable; stillRunning; 2026-11-02 13:31:26.316 | 1034, 1197 (7 records) |

For each of the 22 living roots, signal identity, signal time and signal answer are **unknown**: no identity-bound signal receipt remains, and the lane result records acceptance or control unavailability. The repeated capture records for the older living roots span hours, with no corresponding retained signal receipt or successful retirement. Their first and last capture timestamps are available on the cited lines.

The earlier-boot build root has stronger evidence: the stop receipt records an explicit kill via SIGTERM at **November 2, 14:35:32.373**, followed by native exit code zero at **14:35:32.395**. Its journal's final capture is line 1197. It has no surviving generation, pending action or captured survivor in the current row.

| Requested shape | Count established in the 23-host sample | What the evidence permits |
| --- | --- | --- |
| Never signalled | 0 established; 22 have no retained first-party signal receipt | Those 22 are compatible with refusal before a first signal. Historical external signals and lost records cannot be excluded. |
| Kill queued and never executed | 0 established | 18 living references retain initial queued-acceptance results. Their eventual executor outcomes are unavailable; queued acceptance alone cannot establish permanent non-execution. |
| Signalled a replaced host while its native child tree survived | 0 established | No sampled record proves this shape. The 22 current roots match their original start identities and have one recorded generation. Historical writer replacement is a separate fact and is unavailable. |
| Retirement refused for a standing clause | 0 established for these sampled references in the pinned latest report | They are outside that report's individual refusal entries. This does not imply that their predicates pass or that no earlier refusal occurred. |
| Successfully exited, lane confirmation missing | 1 established | Earlier-boot build root, with matching stop/exit evidence and an absent current process. |
| Exact historical cause unresolved | 22 | Includes the 18 queued results and four control-unavailable results; do not count these as mutually proven causes. |

These are deliberately evidence counts rather than an exhaustive assignment to four assumed causes. All 23 references have a stated result or gap. The eight-lane selection is purposive, covers 23 of 62 outstanding references, and does not support population percentages for causes. Only the full 178/29/62 inventory generalises to the whole project. The earlier acceptance observed 61 living roots across the full population; this investigation independently rechecked the sampled 22 and the absent root.

**Confirmed code-level obstacle:** terminal reaping excludes references already placed in `unconfirmedHosts` (`src/lib/pipelines/engine.ts:12911`), and subsequent reconciliation only proves death; it sends no stop (`:12759`). A five-round reap can therefore settle its attempt budget while leaving living unconfirmed hosts. Their eventual termination depends on another existing authorised teardown or the retirement sweep. This distinction explains why a settled reap timestamp does not establish that its hosts exited.

**Instrumentation needed:** retain a bounded, identity-bound stop outcome with admission, executor claim, first effect, exact refusal clause and tree-confirmation times on the lane obligation. Keep it until the lane reference settles, independently of general operation-history retention.

## 2. The two stage-start refusals

**Confirmed:** both blocked launches name the same conversations and native trees subsequently named by the explicit stop/exit receipts. The first tree was captured at **15:52:17.835** (journal line 8760); the second at **15:47:13.564** (line 8755). Each held a native engine, a code-mode host and two MCP processes.

The retained waiting-attempt records show three automatic requests per incident. For the first incident their final recorded observation was **15:53:06.047**; for the second it was **16:01:36.705**. The report times around 15:57 and 16:02 are later observations of those refused launches. The first two request times, their exact executor claims and their final operation receipts are unavailable.

| Automatic request | Target and required wait | Retained result |
| --- | --- | --- |
| First, in each incident | Latest earlier settled attempt's conversation, generation, transcript and launch receipt; own stable operation key for try one. For a hosted idle session: conditional kill carrying its revision and writer claim. | Per-request operation history unavailable. No retained automatic signal receipt. |
| Second, in each incident | Same conversation selected again after a fresh tree check; distinct stable key for try two, at least five seconds after the preceding recorded result. The idle fence is read afresh. | Per-request operation history unavailable. No retained automatic signal receipt. |
| Third, in each incident | Same selection and conditional protocol under try three's key. | Final waiting-attempt record reports queued acceptance without confirmed termination; its recorded times are given above. |

The actual selection and durable try keys are defined at `src/lib/pipelines/engine.ts:9408`, `:9459`, `:9500`. The retained final error selects the queued-control branch. It does not prove all three requests progressed to the same executor state.

The queued commands address a conversation and session key. They carry no frozen list of captured process identities; the executor resolves and fences the process tuple at actuation. The captured tree also feeds the launch gate's residency check. Consequently, the six requests' actual signal targets cannot be reconstructed from the waiting-attempt records alone.

The automatic path first protects live work, reads the runtime session and, for a hosted idle session, submits `onlyIfIdle` (`engine.ts:1512`, `:1548`). Its confirmation loop observes registry residency and the operation receipt for **1.5 seconds**, at 250 ms intervals with an eight-poll ceiling (`:1132`, `:1404`). Every request may have additional I/O time; this is not a total end-to-end deadline. The outer launch gate spends one of three tries when the tree still runs, then parks. The local signal ladder's 400 ms grace and three-second default are reached only after actuation is authorised.

The explicit conversation kills omit the idle revision/writer-claim fence and automatic retirement claim. They still use recorded process identity, generation, custody, branch-host protection and the existing tree ladder. The controller explicitly disables the runtime-release shortcut for idle-only kills; an explicit kill can use the registered host's release path (`src/lib/runtime/structuredDeliveryController.ts:1446`, `:1456`). This is a real protocol difference. The records do not prove which automatic guard prevented progress.

| Incident | Explicit acceptance observed by seat | Identity-bound SIGTERM | Native root exit | Signal to root exit | Whole captured tree |
| --- | --- | --- | --- | --- | --- |
| First | 15:58:14, second precision | 15:58:24.077 | 15:58:24.124, code zero | 47 ms | Alive at 15:58:23; all absent by 15:59:46. After the recorded signal, whole-tree absence is bounded above by 81.923 s. |
| Second | 16:04:50, second precision | 16:04:55.769 | 16:04:56.079, code zero | 310 ms | Alive at 16:04:42; all absent by 16:05:35. After the recorded signal, whole-tree absence is bounded above by 39.231 s. |

The explicit operation is named in each stop receipt; there is no prior active stop in either receipt. Their subsequent controller captures are journal lines **8773** at 15:58:23.798 and **8784** at 16:04:55.310. At the current read both registry rows are dead and their captures are empty.

**Refuted as an established explanation:** that a helper's manual signal ended the first tree, or that the native roots needed roughly a minute to honour SIGTERM. **Confirmed:** the explicit requests waited approximately ten and six seconds before their recorded signals, longer than the automatic confirmation window. **Unknown:** whether the automatic requests failed a guard, remained queued, lost an executor, or completed an unrecorded partial path. A larger wait alone is not an evidenced repair.

The first incident lane's later explicit close has settled, with no remaining unconfirmed references; the other incident lane remains at a review decision and has no close report. Neither fact reconstructs the six old operation receipts.

**Minimum missing evidence:** one bounded stop record linking each automatic request's admission, claim, idle-fence validation or refusal, first signal and completion. To measure the full tree, retain the ladder's final identity census and its timestamp alongside the existing native-root exit receipt.

## 3. The earlier-boot host and the limit of #3970

**Confirmed cause of current non-convergence:** the closed earlier-boot lane is not enrolled in controller work. Its authoritative row has `controller_active=0`, one outstanding host, a settled close with one `stillRunning` entry, and no termination-proof checkpoint. Both `pipeline_tick_work` and `pipeline_controller_work` contain **no row for it**. Its attempt references exist, including an explicit unconfirmed-host reference. This is selection failure before the proof runs.

The process proof already accepts a demonstrably different kernel boot and verifies all generation, scope and captured-identity dependencies (`src/lib/pipelines/hostTermination.ts:11`, `:61`). Current addressed reads show a dead registry row, absent native root, different kernel boot, one generation, no pending action, no other owner in the termination index and no survivors.

#3970 also removed a stale `controller_active` filter **when a scheduler-selected key is supplied** (`src/lib/state/sqliteStateStore.ts:3505`). That helps selected lanes. It cannot select an obligation missing from `pipeline_tick_work`.

There are two relevant initialisation limits:

- `installPipelineControllerSchedule` returns once its existing trigger is found, unless a policy refresh is requested; its bulk seed runs only on installation or refresh (`src/lib/state/pipelineControllerSchedule.ts:15`, `:50`).
- The reference-index upgrade re-enrols terminal rows only when there is **no closeTeardown** (`src/lib/state/pipelineControllerReferences.ts:222`). This lane has a settled closeTeardown.
- Scheduler acknowledgement can remove a queued key when `controller_active` is false and no other controller-work row exists (`src/lib/state/sqliteStateStore.ts:2358`). The authoritative outstanding-host obligation is stronger than that stale optimisation.

**Unknown historical detail:** whether this particular queue entry was never seeded or was later removed by acknowledgement. The present missing selection and the startup exclusions are established; assigning one past deletion would need a retained scheduler decision.

The smallest repair is a versioned, fenced recovery of outstanding terminal obligations into the existing queue, and an acknowledgement condition that checks the same durable obligation predicate. The process-proof implementation should be reused. Confirmation must clear both lane and close-report copies (`src/lib/pipelines/engine.ts:12835`, `:12865`) before existing cleanup can proceed. Cleanup still has its own retention and activity conditions (`src/lib/pipelines/laneFinish.ts:32`); this investigation makes no claim that scratch was deleted.

## 4. Retirement sweep: scope, refusals and stuck conditions

The supported status tool refused before returning a report, even with the full key. The complete stored report provides the requested data; API pagination itself could not be exercised by this caller. The cause is the caller's absent project-ownership field, rather than proof that the project has no retirement results. No authority was edited.

For the latest complete snapshot read at 18:00:21, the sweep evaluated **289** subjects, deferred **224**, retained **57** individual refusals, attempted **8** unsuccessful retirements and retired **0**. The fair cursor advanced without wrapping; **281** candidates remained unvisited by this pass's termination batch. Evaluated subjects and visited actuation candidates are different counts.

| Clause or outcome | Whole installation | Hosts belonging to completed/closed project lanes | Interpretation |
| --- | ---: | ---: | --- |
| transcript-idle | 26 | 0 | Correct standing recency condition for those reported subjects: transcript activity remains within the configured one-hour interval. Repeated activity may legitimately renew it. No reported terminal-lane subject can be attributed to it in this snapshot. |
| turn-settled | 23 | 0 | A recorded live turn is a correct standing reason. An undetermined central projection is a conservative hold whose liveness cause remains unknown. Do not reinterpret unknown as idle. |
| seat-free | 6 | 0 | Correct protection for a standing seat; terminal lane membership elsewhere would not cancel it. No terminal-lane subject matches here. |
| events-flushed | 1 | 0 | Correct safety predicate; the recorded progress is stuck, as detailed below. It is outside this project's terminal lanes. |
| handoff-queue-drained | 1 | 0 | Correct queue protection; no terminal-lane subject matches here. |
| scope target changed, termination failed | 8 | 4 hosts in 3 terminal lanes | Refusal is required when authority changes. The report does not identify which subcondition changed, so a genuine replacement and self-invalidated preparation remain distinguishable unknowns. |

Terminal-project attribution joins every full stored attempt of the 178 project lanes, with an independent membership check, because the status API's projectOwnership-only filter is unavailable. Whole-installation totals must not be substituted for terminal-lane counts. The nonterminal stale-cursor subject is attributed through its recorded launch project.

The four terminal-lane failure records are `host-retirement-report.json`'s `failed[0]`, `failed[2]`, `failed[4]` and `failed[6]` in the snapshot finishing **17:59:43.434**. The preceding report finishing **17:54:16.648** contained two terminal-lane failures in its different eight-target batch. This demonstrates advancing batches, not a census of every possible standing refusal. The journal retains aggregate refusal counts and individual failed targets; it discards individual refusal targets (`src/lib/runtime/structuredHostRetirementStatus.ts:77`). The earlier report cited in the task therefore cannot be retrospectively split by terminal-lane membership from the journal alone.

**Confirmed stuck progress outside the terminal-lane cohort:** one project's idle host still has stored event cursor **141**, versus durable event tail **215**. Its registry row was last updated **November 12, 16:35:46.189**; the durable event file was last written **16:36:22.721** that day. The same comparison remains in the later report. This is a stale cursor, not evidence of current model activity. Its event backlog/adoption repair owner is **unknown**. Preserve the guard and record the last attempted flush, owner, error and target cursor; replay only through the existing event-persistence path.

**Confirmed incomplete preparation cleanup:** the sweep persists captured trees with `recordStructuredTerminationSurvivors` and supplies no withdrawal callback (`src/lib/runtime/structuredHostRetirement.ts:1321`). The generic ladder invokes withdrawal only if such a callback exists and it refused before an effect (`src/lib/runtime/structuredHostControl.ts:873`). The stage/control paths already supply transactional capture withdrawal. Captured survivors block a host's own claimed writes and later adoption (`src/lib/agent/registry.ts:9712`, `:9768`). Repeated capture-only evidence on 21 sampled living hosts is consistent with this obstruction. Which exact authority field first caused each failed retirement is **unknown**; the capture records do not preserve that decision.

The sweep's generic error combines claim owner/epoch, writer epoch, scope identity, missing process and a newly evaluated retirement verdict (`src/lib/runtime/structuredHostRetirement.ts:1306`). It should retain the first failed subcondition and before/after custody evidence before any behavioural change is selected.

## 5. Code map at the assigned revision

| Path | Deciding source |
| --- | --- |
| Stage-start gate selects prior settled writers, protects unsettled attempts, persists three spaced tries and parks after exhaustion | `src/lib/pipelines/engine.ts:9408`, `:9451`, `:9461`, `:9475` |
| Hosted idle writer gets a conditional kill; an orphaned or unhosted writer can use recorded-identity termination | `src/lib/pipelines/engine.ts:1512`, `:1530`, `:1540`, `:1548` |
| Conversation action validates conversation/transcript ownership, protects shared branch hosts and dispatches structured control | `src/lib/conversation/actions.ts:104`, `:134`, `:150` |
| Structured kill command records operator/agent origin, session key and optional idle fence; runtime journal admission precedes queued response | `src/lib/runtime/structuredControls.ts:551`; `src/runtime-host/journal.ts:807`, `:878` |
| Queue claims an idle kill before actuation, checks health, invokes termination and records delivered, failed or queued after exception | `src/lib/runtime/structuredDeliveryQueue.ts:3724`, `:3756`, `:3774`, `:3793` |
| Controller revalidates idle session, durable executor claim, queued work, pipeline activity, seat and writer custody | `src/lib/runtime/structuredDeliveryController.ts:1281`, `:1294`, `:1320`, `:1382` |
| Controller binds the recorded root and scope; automatic kills retain fresh authorisation before signals; explicit kill can release the owned adapter | `src/lib/runtime/structuredDeliveryController.ts:1414`, `:1422`, `:1446` |
| Shared tree ladder captures identities, verifies identity/custody after waits, sends TERM then KILL and confirms the tree/scope before registry retirement | `src/lib/runtime/structuredHostControl.ts:494`, `:641`, `:675`, `:718`, `:764`, `:820`, `:853` |
| Native Codex adapter fences its child start identity, records signal intent and escalates under its release timer | `src/lib/runtime/codexAppServerHost.ts:3876`, `:3897`, `:3920`; durable receipt implementation `src/lib/runtime/hostExit.ts:105`, `:160` |
| Confirmation wait used by stage stop | `src/lib/pipelines/engine.ts:1394`, `:1404`: queued acceptance is not termination; registry residency and operation status are re-read under the short observation window. |
| Passive dead-host reconciliation and final checkpoint fence | `src/lib/pipelines/engine.ts:12766`, `:12810`, `:12831`; `src/lib/pipelines/hostTermination.ts:61`, `:189`. Proof visits bounded generation/identity pages and validates source custody again before persistence. |
| Completed-attempt reap, live-work checks and round exhaustion | `src/lib/pipelines/engine.ts:12889`, `:12969`, `:12989`, `:13011`. Five-second sweep budget, five rounds, existing idle-stop port. |
| Explicit close freezes host obligations, runs bounded teardown and retains outstanding evidence | `src/lib/pipelines/engine.ts:15652`, `:15685`, `:15794`, `:15822`, `:15966`. Ten-second close budget, at most sixteen selected hosts per scoped pass. |
| Later cleanup remains fenced by host confirmation and settled activity | `src/lib/pipelines/laneFinish.ts:32`. |

Signal intent is persisted before the signal and can be withdrawn when no signal was sent (`hostExit.ts:105`; `codexAppServerHost.ts:3931`). A retained stop plus matching native exit provides stronger evidence than capture alone. Per-host stop slots preserve the prior active receipt, but they do not supply a complete queue-execution history.

## 6. Concurrent work to preserve

**PR #4029 remains open** at the read, with 21 changed files. Its diff adds a turn-silence watchdog to the three native host adapters, including emit, resume/adoption and release paths; retains deadlines across adoption; protects foreground tools, background work, attention, provider retries and replaced writers. It also adds delivered-wake response ownership and recovery to seat-tick/quota paths. Existing host failure/release remains its termination route.

This lane should keep changes in the scheduler, pipeline stop obligation, shared controller/ladder and retirement sweep where possible. Avoid adding a second silence timer, rewriting native host emit/release handling, or treating synthetic terminal events as process death. If a host adapter change becomes necessary, re-read that PR's latest diff and preserve its original-turn, tool ownership and writer-fence checks. Its tests cover restoration, late native completions and replacement writers; reuse those seams for any unavoidable overlap.

**Paused refusal-reason lane:** its five-file diff changes `structuredDeliveryController.ts`, `structuredDeliveryQueue.ts`, their queue/rebind tests and its design document. It returns an allowlisted coded refusal while preserving the guards; both queue consumers require `outcome === true` before declaring termination. It retains legacy hostless/operator behaviours. The design already records historical idle-stop failures whose boolean callback lost the deciding guard.

Reuse that bounded refusal vocabulary and strict boolean-success handling. Reapply only the relevant current hunks; the paused branch predates the assigned tree. Do not copy the branch wholesale, relax a guard, or claim that preserving a reason repairs termination. Its proposed diagnostic coverage does not identify which guard failed in the two incidents and does not address this sweep's separate generic scope-target error or scheduler enrolment.

## Ranked causes and smallest safe build sequence

1. **Confirmed: missing scheduler enrolment prevents historical confirmation.** The earlier-boot process is already gone; its lane has no tick work despite an outstanding durable obligation. Repair this first. It requires no signal-policy change.
2. **Confirmed: queued acceptance outlives the caller's observation and can exhaust its launch budget.** The 1.5-second observer does not cover the observed six-to-ten-second admission-to-signal interval. The automatic requests' eventual execution/refusal cause is unknown, so extending a sleep is insufficient.
3. **Confirmed: failed retirement preparation can retain a capture fence; exact first failing authority predicate is unknown.** Live roots and repeated captures persist for hours. Reuse capture withdrawal and the existing signal ladder; establish the exact changed dependency before making a predicate exception.
4. **Confirmed: exhausted terminal reap leaves living references to passive reconciliation and the sweep.** Their identity proof correctly refuses to confirm living roots. Repair the existing retry owner rather than weakening the proof.
5. **Confirmed separate stuck cursor:** one open/nonterminal subject has a days-old flush cursor. It does not explain the sampled terminal cohort. Its replay/adoption cause remains unknown.

| Small change | Implementation boundary and required regression |
| --- | --- |
| Restore historical work selection | Version the existing fenced schedule backfill to enrol terminal outstanding obligations, including settled closes with stale inactive flags. Make acknowledgement retain such obligations. Regression in `src/lib/pipelines/unconfirmedHosts.test.ts` plus the existing state-controller integration seam: start from an older on-disk row with inactive flag and no queue row; reopen through production initialisation, run bounded controller passes, and require both outstanding copies to clear and existing cleanup eligibility to advance. The same fixture with a living identity must stay unconfirmed. Reopening again must preserve queue progress. |
| Preserve the exact stop refusal and phases | Integrate the paused lane's allowlisted outcomes into current controller/queue seams. Retain bounded per-obligation timestamps and the existing operation key, identity and owner through lane settlement; record refusal subclauses for sweep authorisation too. Regression in `src/lib/runtime/structuredDeliveryQueue.test.ts` and `src/lib/runtime/structuredDeliveryRebind.test.ts`: real producer and consumer with a blocked/claimed request, executor replacement and restart; require a precise durable terminal answer and no truthy-refusal success. Include capture, pre-signal refusal and signal-attempt distinctions. |
| Give a queued stage stop one bounded owner | Persist its original operation on the waiting attempt; reconcile it across ticks and restart instead of spending three independent tries while earlier work remains unobserved. Use asynchronous waits under one explicit overall deadline. A proposed initial contract is 30 seconds from accepted stop to confirmed tree exit or a definite recorded queue/authority/partial-termination reason; validate that choice against measured executor phases. Live work remains a named standing refusal. Regression in `src/lib/pipelines/severedStageRetry.test.ts` through real stop/control seams: delayed consumption beyond 1.5 seconds, full queued work, restart, lost response, then successful original request; assert one authorised actuation, no concurrent replacement stage and finite final status. Do not merely change an error message or sleep duration. |
| Repair the sweep's preparation lifecycle | First reproduce the newly recorded failed subcondition in isolation. Use the existing capture receipt and withdrawal callback for a stop refused before its first effect; allow only explicitly owned preparation changes through later custody checks. Keep captures after any possible signal or release. Regression in `src/lib/runtime/structuredHostRetirement.paging.test.ts` and `src/lib/runtime/structuredHostControl.test.ts`: idle living native tree really exits through existing termination; a refused preparation resumes its writer; replacement, new turn, seat designation, delivery or background work introduced at each await blocks further signals. |
| Ensure live outstanding references have an existing retry owner | Keep the bounded fair sweep or teardown obligation responsible until termination or a specific standing refusal. Reconcile its original accepted operation before another attempt; retain a per-host backoff/cursor, without scanning global operation history. Regression in `src/lib/pipelines/terminalReap.test.ts`: exhaust the initial budget, restart, let the original queue settle, and require real process-tree exit and removal of outstanding references. With an enduring seat or task, retain the host and its exact reason. |
| Resolve stale event persistence only after ownership is established | Instrument the cursor's last attempted flush, expected tail, error and current owner. Reproduce adoption of an idle host with a durable tail ahead of its registry cursor, then use the existing persistence/replay path. Regression in the existing host-event persistence/adoption tests: advance the cursor after durable replay, preserve unreadable/foreign ownership, and keep the events-flushed refusal until proof is complete. This work can remain separate from terminal-host convergence if the measured subject remains outside it. |

Every behavioural repair needs a base-failing regression before implementation is accepted. All lifecycle files must run separately in owned runners against private HOME, XDG configuration, temporary and state roots, with Viewer control directed to a closed port. Exercise real request producers and consumers, not only injected boolean outcomes.

Mandatory shared adversarial cases: a reused process number with another start identity is never signalled; the old obligation may settle only after all its generations/scopes/survivors are proven gone, while the replacement host remains live and unconfirmed under its own identity. Replace the owner before dispatch and after every await. A live turn, seat, held delivery, queued handoff or background task keeps the host. Missing namespace or process evidence remains unknown. Per tick, use bounded selected attempts, generation pages and addressed operation reads; no global stop-history walk.

The build stage owns touched-path tests, TypeScript, lint, the privacy gate from the merge base and the committed-tree pre-push touched-tests selection, with zero new failures against main. This diagnosis ran none of those suites. Its report-only privacy check is recorded below. Three independent runtime review rounds and installed acceptance remain downstream obligations.

Report-only validation: `CI=1 bun scripts/privacy-publication-gate.ts --require-known-values --base origin/main --paths docs/reports/host-stop-and-unconfirmed-hosts.md` passed at 18:04 UTC, exit zero. `CI=1` disables the optional fingerprint cache's disk writes. `git diff --check -- docs/reports/host-stop-and-unconfirmed-hosts.md` found no whitespace errors. The final text was reread for private identities, process numbers and home paths. No lifecycle check was run.

Installed acceptance should repeat the full terminal-lane inventory, count exact recorded identities still alive, and require every remaining outstanding host to have a current standing reason or an owned bounded stop. A falling count alone cannot establish safe reconciliation.
