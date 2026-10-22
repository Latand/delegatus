# Sound events audit

Requirement, 2026-10-21, private operator brief (paraphrased): rebuild the sound scheme from actual Delegatus usage. Inventory the events and their frequency, make each sound convey meaningful work, and retain the existing typing effect. This document completes the event audit in acceptance 1. The private dictation is not reproduced in this public document.

No earlier completed frequency audit was located in the bounded project and cross-project transcript and memory searches used for this audit.

Code examined: `3e6ca3c16dbd31e7e19b5bc807d8f93b7584cd25`. All source locations below refer to that revision. The audit covers this machine's retained local history across projects and engines. Product source, settings and live state were left unchanged. The only worktree output is this document.

## Windows and units

Every interval includes its start and excludes its end. All clocks and hour labels are UTC. The primary window W is seven complete 24-hour periods ending at the last completed UTC hour available during extraction.

| Key | Start, inclusive | End, exclusive | Hours | Use |
| --- | --- | --- | ---: | --- |
| W | 2026-10-14 17:00 | 2026-10-21 17:00 | 168 | Durable attempts, launches, forms, delivery records, transcripts, sampled limits and voice records |
| C | 2026-10-21 12:00 | 2026-10-21 17:00 | 5 | Seat controller checks; the combined retained ring spans this whole interval |
| Q | 2026-10-18 12:00 | 2026-10-21 17:00 | 77 | Quota-probe operation log; the rotated predecessor starts at 11:44 on October 18 |
| B | 2026-10-19 10:00 | 2026-10-21 17:00 | 55 | Bridge reports; the retained report ring starts at 09:23 on October 19 |
| X | 2026-10-20 18:00 | 2026-10-21 17:00 | 23 | External relay claims and outcomes, within their 24-hour terminal retention |
| R | 2026-10-21 16:35 | 2026-10-21 17:00 | 0.416667 | Fine-grained runtime journal; its oldest retained event is at 16:34:43 |

Mean/h is the observed count divided by every wall-clock hour in that row's window, including quiet hours. Max/10 s and Max/60 s are the largest counts in any rolling interval of that length. They express burst counts; divide them by 10 or 60 for events/second. Busiest hour is a UTC clock hour, with the earliest hour selected on a tie. R contains only a 25-minute slice of one hour: its hourly mean is a normalization, and its last column explicitly reports the partial slice. It supplies no full-hour maximum.

A count is exact for the retained records selected by its method. A lifetime occurrence total can be larger where records were deleted, overwritten or capped. Those limits are stated below. No table is a count of sounds actually heard: browser focus, mounted panes, mute, autoplay and dropped overlapping cues are not retained as playback history.

## Collection and reconstruction

Database capture used ordinary file reads, without opening a live SQLite connection. For each database, copy the main file and any WAL into stage scratch, compare inode, size and modification time before and after (the five primary database captures also compare change time), and retry a changing capture. Open only the accepted scratch copy, recover its copied WAL there and require `PRAGMA quick_check` to return `ok`. No checkpoint, VACUUM, application-store import, API refresh or test suite ran against live state. Small JSON and NDJSON inputs were copied or read as fixed byte prefixes. The extraction's database snapshots were taken from 17:24:08 through 17:24:29 UTC; all counts exclude occurrences at or after 17:00.

| Method | Primary records, filters and timestamp |
| --- | --- |
| A | `state_rows`, collections `pipelines` and `pipelines_archive`: deduplicate by pipeline id, current row wins. Walk `runs[].attempts[]`, exclude `historical`; deduplicate by pipeline, stage and attempt number. Starts use `startedAt`; settlements use `completedAt` and the retained attempt state. A repair start additionally requires `activatedBy.edge == fail`. A start names controller activation into spawning; host readiness can follow later. |
| AR | Same pipelines, `stageReports[]`: unique pipeline plus report sequence, grouped by status, at the report's own `at`. Replaced submissions remain submissions. They can precede publication/provenance checks and later settlements. |
| AP | Same attempts, `providerRecoveries[]`: unique attempt plus recovery position; use each entry's `at`, `action` and structured condition kind. Current code retains the last eight entries per attempt. |
| P | Pipeline fields `createdAt`, `closedAt`, latest `pausedAt`/`resumedAt`; unique pipeline. These last two fields provide the latest retained occurrences, so earlier pause cycles are a lower bound. Publication rewrite records use their own `requestedAt` or `answeredAt`. |
| G | `registry_rows` plus `registry_archive`: deduplicate by collection and row key, highest archive id first and current row wins. Receipt admission uses `createdAt`; a failed launch uses `failureReporting.failedAt` only. Generations use `generations[].createdAt` and generation id. The orchestrator subset requires the stored role. |
| T | Scratch activity database `activity_turns`: unique host plus turn key; starts use `start`, ends use `end`; engine and role are stored classifications. These are transcript-derived work intervals, including their last observed ends. They do not establish success for each answer. No history pull or refresh was requested. |
| F | Task `prototypeReviews[]` plus collection `seat-decisions`, deduplicated by review id. Forms use `createdAt`, answers use `decision.at`, and answer dispatch uses `decision.delivery.dispatchedAt`. Task births use `createdAt`; retained Done entries use current `doneAt`. Earlier answered amendments and undone Done entries can be overwritten. |
| AT | Collection `attention`, request `value.id`: `createdAt` for creation and `stateChangedAt` for its last retained transition. This includes navigation/focus requests. Its last state does not reconstruct every offer, acceptance or dismissal. |
| S | Combined and per-project seat audit NDJSON, unique project, seat epoch, `at` and verdict. Restrict to C, split by verdict or delivery outcome. A queued wake, a confirmed landing and a seat turn are separate records of related work. |
| BR | Collection `bridge_reports`, unwrap `v`; require a report class, unique report id, use its own `at`. Exclude metadata, retired-id markers and acknowledgments. Restrict to B. |
| M | Pipeline `merge`: require `state == merged`, unique pipeline, use stored `mergedAt`; blocked observations use `blockedAt`. Counts describe pipeline merge confirmations. A batch can account for several pipelines. The merge code sometimes substitutes its confirmation time when the forge supplies no merge time; these records cannot establish a more precise remote action clock. |
| D | Checkout deployment ledger: unique deployment id; admission uses `createdAt`, a terminal outcome uses the ledger's `updatedAt`. Count final `succeeded`, `failed`, and `rolled-back` separately. The runtime-host deployment table was empty on this checkout installation and contributes no rows. Build/apply history uses its own `at`, grouped by kind and outcome. |
| DP | Scratch `delivery_progress.record_json`: unique operation for admissions at `admittedAt`; phase records use operation plus retained history position and that entry's `at`. Changed detail can append another record of the same phase. Delivered, failed and uncertain are recorded settlements, and queued/checking/dispatching are progress records. They do not count unique turns. |
| L | Lifecycle journal, unique event id, by `type` and original event `at`. The ring holds 2,000 rows and has already discarded 38,915 earlier sequences. All W rates from L are lower bounds. Reconstruct A, M and D from their primary records instead of treating their L subset as the week total. |
| QP | Both operation-log generations, retain each complete line in Q; split `action` and `result`, timestamp `ts`. Only quota probes occur in these retained files. Error includes cache/transcript/unavailable provenance; it does not establish exhaustion. |
| LH | Sampled limits history `series`, ordered by `t`: count a positive-to-zero remaining transition as observed exhaustion and zero-to-positive as observed recovery. Deduplicate by series and sample time; omit `unattributedCodexSeries`. Several series can describe one account, so this counts series crossings. Reset time lies between samples. |
| TG | Scratch Telegram bot `messages`, unique chat and message id retained only inside the reader, timestamp `date` in seconds, grouped by direction and kind. Confirmed sends use `sends.sent_at`, unique caller and request key. Multiple messages and polls can belong to one send. Failed rows lack a failure clock: their table row explicitly counts the admission cohort at `created_at`. |
| XR | External relay request ledger, unique request id: `claimedAt` for claims, `terminalAt` for answered/failed outcomes, restricted to X. These are local completion records; they do not independently prove destination delivery. |
| V | Voice transcript JSONL, latest row per session and record id, timestamp `session_start.data.createdAt + atMs`. The correction writer can replace a record, so tools count retained final records, split by final status, rather than every streaming revision. Session-start and session-end records supply call boundaries. Request `data.states[]` supplies status snapshots timed by its own `atMs`; repeated status entries remain separate retained observations. |
| VE | Stored voice session event rings, unique session plus event id, timestamp session `createdAt + event.atMs`. Confirmation requests and confirmations use their explicit types. Other ring rows are retained observations; older events in long calls have fallen out. |
| J | Scratch runtime journal `events`, unique sequence; timestamp `occurred_at`, restrict to R. Group by `kind`, or for item rows by `phase`, item `type` and `status`. Item start and completion are separate events, and delta rows are chunks. Receipts are protocol transitions and may repeat for one operation. |
| TR | Native transcript scan, described with its coverage and results below. Count engine-issued calls by engine plus call id; collapse copied/migrated history carrying that identity. Use record `timestamp`. Count only structured records and explicit error flags; ignore message bodies as evidence of a merge, deploy or failure. |

Counts classify rows as retained at extraction, then filter by the source event clock. Mutable fields were not restored to an earlier version at the window cutoff, so counts of current-state fields are retrospective observations and cannot reproduce a board snapshot at that cutoff.

The registry and activity index contain Claude and Codex records; no Copilot conversation or activity file is retained. Copilot emitters are included in the source inventory, and no Copilot usage rate is inferred.

The database and journal totals are aggregate observations across projects. Project labels, account labels, transcript locations, destination identities, message bodies, tool arguments and secrets are excluded from the output. Repository-relative source locations below are the code references required by the audit.

## Agent, seat and pipeline activity

| Event and emission site | Method | Window | Count | Mean/h | Max/10 s | Max/60 s | Busiest UTC hour: count |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Launch admission recorded; `src/lib/runtime/structuredSpawn.ts:2684` | G | W | 3,942 | 23.46 | 3 | 9 | 10-15 13:00: 72 |
| Dated launch failure; `src/lib/tasks/launchMembership.ts:372` | G | W | 159 | 0.95 | 3 | 7 | 10-15 13:00: 11 |
| Conversation generation created; `src/lib/agent/registry.ts:7383` | G | W | 3,600 | 21.43 | 4 | 9 | 10-15 14:00: 61 |
| Orchestrator launch admission; `src/lib/runtime/structuredSpawn.ts:2684` | G, role subset | W | 315 | 1.88 | 3 | 6 | 10-20 08:00: 8 |
| Claude work interval begins; `src/lib/runtime/claudeStreamBrokerHost.ts:1073` | T | W | 4,933 | 29.36 | 11 | 29 | 10-15 09:00: 114 |
| Claude work interval ends; `src/lib/runtime/claudeStreamBrokerHost.ts:1649` | T | W | 4,934 | 29.37 | 11 | 29 | 10-15 09:00: 115 |
| Codex work interval begins; `src/lib/runtime/codexAppServerHost.ts:4336` | T | W | 2,766 | 16.46 | 4 | 10 | 10-15 05:00: 45 |
| Codex work interval ends; `src/lib/runtime/codexAppServerHost.ts:4408` | T | W | 2,759 | 16.42 | 9 | 14 | 10-15 14:00: 48 |
| Orchestrator work interval begins; `src/lib/runtime/claudeStreamBrokerHost.ts:1073` | T, role subset | W | 2,729 | 16.24 | 4 | 5 | 10-16 12:00: 52 |
| Pipeline created; `src/lib/pipelines/engine.ts:12228` | P | W | 666 | 3.96 | 2 | 5 | 10-16 12:00: 20 |
| Stage attempt activates; `src/lib/pipelines/engine.ts:7689` | A | W | 2,896 | 17.24 | 4 | 10 | 10-15 14:00: 52 |
| Stage settles passed; `src/lib/pipelines/engine.ts:5237` | A | W | 1,700 | 10.12 | 3 | 4 | 10-21 11:00: 30 |
| Stage settles failed; `src/lib/pipelines/engine.ts:3209` | A | W | 875 | 5.21 | 8 | 10 | 10-15 17:00: 22 |
| Dated stage settlement needing a decision; `src/lib/pipelines/engine.ts:2607` | A | W | 155 | 0.92 | 7 | 11 | 10-20 12:00: 15 |
| Stage settles skipped; `src/lib/pipelines/engine.ts:10701` | A | W | 21 | 0.12 | 2 | 2 | 10-20 11:00: 3 |
| Repair attempt activates after a fail edge; `src/lib/lifecycle/projector.ts:76` | A | W | 730 | 4.35 | 3 | 4 | 10-15 17:00: 14 |
| Stage report submits pass; `src/lib/pipelines/engine.ts:15210` | AR | W | 1,773 | 10.55 | 11 | 18 | 10-16 12:00: 33 |
| Stage report submits fail; `src/lib/pipelines/engine.ts:15210` | AR | W | 676 | 4.02 | 2 | 3 | 10-20 11:00: 14 |
| Stage report submits needs_decision; `src/lib/pipelines/engine.ts:15210` | AR | W | 102 | 0.61 | 1 | 1 | 10-20 09:00: 6 |
| Latest retained pause; `src/lib/lifecycle/projector.ts:43` | P | W | 17 | 0.10 | 4 | 5 | 10-17 13:00: 5 |
| Latest retained resume; `src/lib/lifecycle/projector.ts:56` | P | W | 15 | 0.09 | 4 | 4 | 10-20 06:00: 4 |
| Pipeline closed; `src/lib/pipelines/engine.ts:12978` | P | W | 639 | 3.80 | 3 | 4 | 10-16 14:00: 14 |
| Board maintenance launched; `src/lib/boardMaintenance/run.ts:170` | run launchedAt | W | 36 | 0.21 | 1 | 1 | 10-20 12:00: 2 |
| Board maintenance succeeded; `src/lib/boardMaintenance/run.ts:209` | run endedAt | W | 35 | 0.21 | 1 | 1 | 10-20 13:00: 2 |
| Board maintenance failed; `src/lib/boardMaintenance/run.ts:209` | run endedAt | W | 1 | 0.01 | 1 | 1 | 10-21 14:00: 1 |

Stage starts, generation creation and launch admissions describe different boundaries. Their counts differ because work can wait, fail before a host starts, resume a prior conversation or continue through another generation. The registry additionally retains 68 failed launch receipts without a failure timestamp; they are excluded from the dated failure rates. Report submissions and eventual stage settlements also differ: the controller can refuse publication after an agent reports pass.

The activity index overlaps at least one observed work interval for 158.73 of W's 168 hours (94.48%). Its peak is 26 concurrent indexed intervals. This measures retained transcript work spans; gaps inside a span and host liveness require different evidence. It explains why a global activity indicator can be almost continuous on this machine.

## Seat checks and recovery conditions

| Event and emission site | Method | Window | Count | Mean/h | Max/10 s | Max/60 s | Busiest UTC hour: count |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Seat check decides to wake; `src/lib/monitor/seatTickController.ts:1846` | S | C | 20 | 4.00 | 1 | 1 | 10-21 12:00: 7 |
| Seat check confirms an earlier wake landed; `src/lib/monitor/seatTickController.ts:1260` | S | C | 20 | 4.00 | 1 | 2 | 10-21 12:00: 7 |
| Seat check stays quiet; `src/lib/monitor/seatTickController.ts:1311` | S | C | 59 | 11.80 | 2 | 5 | 10-21 16:00: 23 |
| Seat check records an error; `src/lib/monitor/seatTickController.ts:1311` | S | C | 237 | 47.40 | 3 | 6 | 10-21 15:00: 62 |
| Seat check is refused; `src/lib/monitor/seatTickController.ts:2330` | S | C | 30 | 6.00 | 1 | 1 | 10-21 13:00: 8 |
| Seat check finds no seat; `src/lib/monitor/seatTickController.ts:1311` | S | C | 11 | 2.20 | 1 | 1 | 10-21 15:00: 4 |
| Wake transport accepts queueing; `src/lib/monitor/seatTickController.ts:1994` | S | C | 19 | 3.80 | 1 | 1 | 10-21 12:00: 7 |
| Wake delivery confirmed; `src/lib/monitor/seatTickController.ts:1281` | S | C | 20 | 4.00 | 1 | 2 | 10-21 12:00: 7 |
| Wake reports seat rotation; `src/lib/monitor/seatTickController.ts:1917` | S | C | 1 | 0.20 | 1 | 1 | 10-21 15:00: 1 |
| Provider recovery waits; `src/lib/pipelines/engine.ts:2838` | AP | W | 72 | 0.43 | 7 | 10 | 10-20 12:00: 13 |
| Provider recovery continues; `src/lib/pipelines/engine.ts:2838` | AP | W | 20 | 0.12 | 1 | 2 | 10-20 07:00: 4 |
| Provider recovery relaunches; `src/lib/pipelines/engine.ts:2838` | AP | W | 3 | 0.02 | 1 | 1 | 10-16 18:00: 1 |
| Provider recovery parks; `src/lib/pipelines/engine.ts:2838` | AP | W | 42 | 0.25 | 7 | 10 | 10-20 12:00: 13 |
| Recovery records authentication required; `src/lib/pipelines/engine.ts:2838` | AP condition | W | 5 | 0.03 | 2 | 2 | 10-21 13:00: 3 |
| Recovery records usage limit; `src/lib/pipelines/engine.ts:2838` | AP condition | W | 2 | 0.01 | 1 | 1 | 10-15 05:00: 2 |
| Recovery records transient provider condition; `src/lib/pipelines/engine.ts:2838` | AP condition | W | 42 | 0.25 | 1 | 2 | 10-20 07:00: 8 |
| Recovery records host death; `src/lib/pipelines/engine.ts:2838` | AP condition | W | 6 | 0.04 | 1 | 2 | 10-16 18:00: 2 |
| Recovery records another condition; `src/lib/pipelines/engine.ts:2838` | AP condition | W | 82 | 0.49 | 14 | 20 | 10-20 12:00: 26 |

Recovery actions and conditions are two classifications of the same retained entries. Their rows must not be added together. Seat audit errors are controller observations, so repeated checks can describe one unresolved condition. C was selected to avoid comparing per-project 500-row rings of different ages. The wake reason vocabulary additionally distinguishes lane events, unmerged pull requests, stalled work, autonomy idle/ended, unstarted tasks, intervals, child terminals, settled owned lanes, release settled/blocked, maintenance, deploys, permission requests, worker questions and disk pressure (`src/lib/monitor/types.ts:228`). Those reasons can coexist on a single wake.

## Questions, attention, reports and tasks

| Event and emission site | Method | Window | Count | Mean/h | Max/10 s | Max/60 s | Busiest UTC hour: count |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Decision/listening/prototype form created; `src/lib/prototypeReview/store.ts:94` | F | W | 154 | 0.92 | 3 | 6 | 10-16 12:00: 10 |
| Retained latest form answer; `src/lib/prototypeReview/decision.ts:318` | F | W | 150 | 0.89 | 6 | 6 | 10-16 12:00: 10 |
| Form answer dispatch recorded; `src/lib/prototypeReview/decision.ts:339` | F | W | 150 | 0.89 | 6 | 6 | 10-16 12:00: 10 |
| Focus or navigation attention request; `src/lib/attention/store.ts:320` | AT | W | 22 | 0.13 | 1 | 2 | 10-15 14:00: 2 |
| Request last retained state is expired; `src/lib/attention/store.ts:428` | AT | W | 22 | 0.13 | 1 | 1 | 10-20 06:00: 2 |
| Bridge report appended; `src/lib/bridge/store.ts:883` | BR | B | 493 | 8.96 | 10 | 11 | 10-20 06:00: 21 |
| Completed bridge report; `src/lib/bridge/store.ts:883` | BR | B | 328 | 5.96 | 10 | 11 | 10-20 06:00: 18 |
| Status bridge report; `src/lib/bridge/store.ts:883` | BR | B | 157 | 2.85 | 2 | 2 | 10-21 11:00: 8 |
| Blocked bridge report; `src/lib/bridge/store.ts:883` | BR | B | 6 | 0.11 | 1 | 1 | 10-19 17:00: 1 |
| Question bridge report; `src/lib/bridge/store.ts:883` | BR | B | 1 | 0.02 | 1 | 1 | 10-20 12:00: 1 |
| Failed bridge report; `src/lib/bridge/store.ts:883` | BR | B | 1 | 0.02 | 1 | 1 | 10-21 16:00: 1 |
| Retained task created; `src/lib/tasks/commands.ts:461` | F | W | 872 | 5.19 | 14 | 14 | 10-15 13:00: 31 |
| Retained current Done timestamp; `src/lib/tasks/completion.ts:32` | F | W | 798 | 4.75 | 60 | 60 | 10-19 08:00: 73 |
| Pipeline records a task move to Done; `src/lib/lifecycle/projector.ts:115` | A taskFinishes | W | 222 | 1.32 | 2 | 2 | 10-14 20:00: 8 |

A decision form, a stage parked for a decision, an agent question, an attention offer and a Telegram poll can describe the same operator obligation. `attention` is also used for moving to a surface, so its creation count cannot establish the number of unanswered questions. All 22 requests born in W have expired as their last retained state; intermediate acceptance and return events are unavailable from these rows. The latest-answer count cannot reconstruct every answer amendment.

Task creation is retained for surviving rows. Current Done timestamps can disappear when a task reopens. Arbitrary moves between other board columns, task edits, dismissals and linked-board acknowledgments have revision/current-state records without a complete timestamped transition log. They are inventoried as unmeasurable events below.

## Merges, publication and deployments

| Event and emission site | Method | Window | Count | Mean/h | Max/10 s | Max/60 s | Busiest UTC hour: count |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Pipeline merge confirmed; `src/lib/forge/autoMerge.ts:552` | M | W | 271 | 1.61 | 3 | 3 | 10-18 10:00: 7 |
| Latest merge-blocked observation; `src/lib/forge/autoMerge.ts:420` | M | W | 7 | 0.04 | 1 | 1 | 10-15 01:00: 1 |
| Publication summary rewrite requested; `src/lib/pipelines/engine.ts:4446` | P | W | 2 | 0.01 | 1 | 1 | 10-20 14:00: 1 |
| Publication summary rewrite answered; `src/lib/pipelines/engine.ts:4446` | P | W | 2 | 0.01 | 1 | 1 | 10-20 14:00: 1 |
| Checkout deployment admitted; `src/lib/selfUpdate/deployments.ts:24` | D | W | 76 | 0.45 | 1 | 1 | 10-15 13:00: 2 |
| Checkout deployment succeeded; `src/lib/selfUpdate/deployments.ts:30` | D | W | 71 | 0.42 | 1 | 1 | 10-15 13:00: 2 |
| Checkout deployment failed; `src/lib/selfUpdate/deployments.ts:30` | D | W | 2 | 0.01 | 1 | 1 | 10-21 15:00: 1 |
| Checkout deployment rolled back; `src/lib/selfUpdate/deployments.ts:34` | D | W | 3 | 0.02 | 1 | 1 | 10-15 17:00: 1 |
| Release build completed; `src/lib/selfUpdate/service.ts:1928` | D history kind | W | 75 | 0.45 | 1 | 1 | 10-15 13:00: 2 |
| Release build failed; `src/lib/selfUpdate/service.ts:1928` | D history kind | W | 2 | 0.01 | 1 | 1 | 10-21 15:00: 1 |
| Release apply completed; `src/lib/selfUpdate/service.ts:2213` | D history kind | W | 71 | 0.42 | 1 | 1 | 10-15 13:00: 2 |
| Release apply fell back; `src/lib/selfUpdate/service.ts:2213` | D history kind | W | 4 | 0.02 | 1 | 1 | 10-15 17:00: 1 |
| Viewer restart completed; `src/lib/selfUpdate/service.ts:1245` | D history kind | W | 3 | 0.02 | 1 | 1 | 10-16 17:00: 1 |

Merge records cover both automatic and externally observed/batch landings (`src/lib/forge/autoMerge.ts:552`, `:637`, `:813`, `:860`, `:920`). They count pipeline confirmations, so a batch can produce simultaneous confirmations. Deployments reconcile checkout and runtime-host backends (`src/lib/runtime/deploymentLedger.ts:175`). This installation's checkout ledger supplies the measured outcomes. Build, apply, deployment success and the projected lifecycle event overlap. A build completion alone does not establish a serving release. The four apply fallbacks and three rolled-back deployment rows have different recorded boundaries and are reported separately.

Intermediate build, candidate verification, admission, draining, handoff, adoption and serving-health events are emitted by `src/runtime-host/deployment.ts:343` and checkout self-update state. Their current ledger is overwritten as the deployment advances. Terminal outcomes above have retained dates; counts of every intermediate phase are unavailable from that ledger. CI check rollups similarly retain current observations rather than a timestamped history of every pending/pass/fail edge.

## Delivery, limits and errors

| Event and emission site | Method | Window | Count | Mean/h | Max/10 s | Max/60 s | Busiest UTC hour: count |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Message delivery admitted; `src/lib/runtime/deliveryProgress.ts:55` | DP | W | 6,613 | 39.36 | 10 | 15 | 10-15 14:00: 97 |
| Queue phase record; `src/lib/runtime/deliveryProgress.ts:153` | DP | W | 6,661 | 39.65 | 7 | 18 | 10-15 14:00: 99 |
| Startup phase record; `src/lib/runtime/deliveryProgress.ts:153` | DP | W | 221 | 1.32 | 3 | 12 | 10-16 00:00: 64 |
| Waiting for a host; `src/lib/runtime/deliveryProgress.ts:153` | DP | W | 125 | 0.74 | 8 | 28 | 10-16 20:00: 61 |
| Waiting for the current turn; `src/lib/runtime/deliveryProgress.ts:153` | DP | W | 880 | 5.24 | 12 | 14 | 10-21 12:00: 58 |
| Conversation busy phase; `src/lib/runtime/deliveryProgress.ts:153` | DP | W | 61 | 0.36 | 9 | 9 | 10-16 11:00: 10 |
| Host recovery phase; `src/lib/runtime/deliveryProgress.ts:153` | DP | W | 176 | 1.05 | 8 | 28 | 10-16 20:00: 61 |
| Checking evidence phase; `src/lib/runtime/deliveryProgress.ts:265` | DP | W | 13,173 | 78.41 | 12 | 30 | 10-15 14:00: 194 |
| Dispatch phase record; `src/lib/runtime/deliveryProgress.ts:265` | DP | W | 15,356 | 91.40 | 20 | 86 | 10-21 11:00: 404 |
| Engine echo recorded; `src/lib/runtime/deliveryProgress.ts:359` | DP | W | 6,505 | 38.72 | 8 | 10 | 10-15 14:00: 96 |
| Delivery settles delivered; `src/lib/runtime/deliveryProgress.ts:344` | DP | W | 6,506 | 38.73 | 6 | 10 | 10-15 14:00: 96 |
| Delivery settles failed; `src/lib/runtime/deliveryProgress.ts:344` | DP | W | 82 | 0.49 | 9 | 9 | 10-15 06:00: 10 |
| Delivery settles uncertain; `src/lib/runtime/deliveryProgress.ts:344` | DP | W | 33 | 0.20 | 2 | 2 | 10-21 09:00: 3 |
| Delivery evidence unavailable; `src/lib/runtime/deliveryProgress.ts:265` | DP | W | 554 | 3.30 | 13 | 25 | 10-16 17:00: 56 |
| Lost wake observation; `src/lib/runtime/deliveryProgress.ts:265` | DP | W | 1,909 | 11.36 | 13 | 25 | 10-16 11:00: 79 |
| Interrupting phase record; `src/lib/runtime/deliveryProgress.ts:265` | DP | W | 10 | 0.06 | 1 | 1 | 10-15 14:00: 3 |
| Account switch waits for turn end; `src/lib/runtime/deliveryProgress.ts:265` | DP | W | 12 | 0.07 | 1 | 3 | 10-17 14:00: 8 |
| Account switch failed observation; `src/lib/runtime/deliveryProgress.ts:265` | DP | W | 76 | 0.45 | 2 | 3 | 10-17 14:00: 17 |
| Delivery waits for update drain; `src/lib/runtime/deliveryProgress.ts:265` | DP | W | 3 | 0.02 | 1 | 1 | 10-18 18:00: 1 |
| Limit series crosses into exhaustion; `src/lib/limitsHistoryStore.ts:128` | LH | W | 3 | 0.02 | 1 | 1 | 10-15 21:00: 1 |
| Limit series recovers above zero; `src/lib/limitsHistoryStore.ts:128` | LH | W | 3 | 0.02 | 1 | 1 | 10-15 22:00: 1 |
| Quota probe with live provenance; `src/lib/events.ts:79` | QP | Q | 22,233 | 288.74 | 18 | 30 | 10-18 15:00: 420 |
| Quota probe with non-live provenance; `src/lib/events.ts:79` | QP | Q | 4,167 | 54.12 | 6 | 11 | 10-20 07:00: 122 |

Delivery retention is about seven days and each operation keeps at most 128 phase entries (`src/lib/runtime/deliveryProgress.ts:127`). The copied database records 5,971 phase entries dropped over its retained records. W therefore gives lower bounds for this family, especially near its start. Counts of checking, dispatching or wake-lost records can exceed the number of deliveries because the same operation revisits them. Admission and settlement windows are independently selected; their difference is not a queue length or failure percentage.

Quota probes run frequently while observed exhaustion is rare. Provider authentication failure, exhausted capacity, a transient request error, a launch failure, a failed shell tool and a failed review each have separate evidence above or below. An error result from a shell command can be expected investigative work. This audit makes no claim that all failed tools require the operator.

## Telegram and external relays

| Event and emission site | Method | Window | Count | Mean/h | Max/10 s | Max/60 s | Busiest UTC hour: count |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Confirmed bot send transaction; `src/lib/telegram/bot/store.ts:734` | TG sends | W | 1,052 | 6.26 | 7 | 17 | 10-16 12:00: 24 |
| Outbound text message; `src/lib/telegram/bot/outbound.ts:108` | TG messages | W | 1,030 | 6.13 | 7 | 15 | 10-16 12:00: 24 |
| Outbound decision poll; `src/lib/telegram/bot/reviewPolls.ts:159` | TG messages | W | 302 | 1.80 | 11 | 15 | 10-20 01:00: 15 |
| Outbound photo; `src/lib/telegram/bot/store.ts:734` | TG messages | W | 18 | 0.11 | 5 | 5 | 10-20 13:00: 5 |
| Outbound document; `src/lib/telegram/bot/store.ts:734` | TG messages | W | 9 | 0.05 | 1 | 1 | 10-16 08:00: 2 |
| Failed send rows, dated by admission; `src/lib/telegram/bot/store.ts:682` | TG cohort | W | 64 | 0.38 | 1 | 2 | 10-20 13:00: 5 |
| External relay request claimed; `src/lib/externalRelay/store.ts:403` | XR | X | 30 | 1.30 | 2 | 2 | 10-21 12:00: 6 |
| External relay completion answered; `src/lib/externalRelay/store.ts:437` | XR | X | 26 | 1.13 | 2 | 2 | 10-21 12:00: 5 |
| External relay completion failed; `src/lib/externalRelay/store.ts:437` | XR | X | 2 | 0.09 | 1 | 1 | 10-20 19:00: 1 |

The bot database query for `direction == in` returns zero retained messages in W. Its incoming-message writer exists at `src/lib/telegram/bot/store.ts:521`. This observation cannot establish absence of inbound Telegram traffic: personal-account reads, incoming report replies, poll answers and external relay ingress use additional paths. Report-reply handling (`src/lib/telegram/bot/reportReplies.ts:88`) and poll answer handling (`src/lib/telegram/bot/reviewPolls.ts:159`) eventually write form answers, which F counts once. Telegram send confirmation proves the bot recorded a transport receipt; XR counts local relay outcomes. They must not be summed as delivered operator notifications.

Failed send rows preserve an admission clock rather than a failure clock. Their count and burst columns describe requests admitted in W whose retained state is failed. The time distribution of the actual failures is unknown.

## Voice activity

| Event and emission site | Method | Window | Count | Mean/h | Max/10 s | Max/60 s | Busiest UTC hour: count |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Retained voice call begins; `src/lib/voiceCompanion/transcriptRecord.ts:72` | V | W | 7 | 0.04 | 1 | 1 | 10-16 12:00: 2 |
| Retained voice call ends; `src/lib/voiceCompanion/admission.ts:189` | V | W | 6 | 0.04 | 1 | 1 | 10-16 12:00: 3 |
| Voice call closes by operator; `src/lib/voiceCompanion/admission.ts:189` | V | W | 3 | 0.02 | 1 | 1 | 10-14 19:00: 1 |
| Voice call closes at cap; `src/lib/voiceCompanion/liveSession.ts:905` | V | W | 2 | 0.01 | 1 | 1 | 10-16 12:00: 2 |
| Voice call closes after transport loss; `src/lib/voiceCompanion/liveSession.ts:795` | V | W | 1 | 0.01 | 1 | 1 | 10-15 13:00: 1 |
| Retained operator utterance; `src/lib/voiceCompanion/liveSession.ts:327` | V | W | 278 | 1.65 | 4 | 9 | 10-16 12:00: 96 |
| Retained companion reply; `src/lib/voiceCompanion/liveSession.ts:327` | V | W | 248 | 1.48 | 3 | 8 | 10-16 12:00: 88 |
| Retained voice delegation; `src/lib/voiceCompanion/liveSession.ts:374` | V | W | 63 | 0.38 | 2 | 4 | 10-16 12:00: 23 |
| Retained voice tool record; `src/lib/voiceCompanion/liveSession.ts:566` | V | W | 123 | 0.73 | 4 | 8 | 10-16 12:00: 40 |
| Retained voice tool final status done; `src/lib/voiceCompanion/liveSession.ts:595` | V | W | 104 | 0.62 | 4 | 8 | 10-16 12:00: 27 |
| Retained voice tool final status failed; `src/lib/voiceCompanion/liveSession.ts:615` | V | W | 19 | 0.11 | 3 | 8 | 10-16 12:00: 13 |
| Voice commentary/handoff record; `src/lib/voiceCompanion/liveSession.ts:722` | V | W | 164 | 0.98 | 7 | 10 | 10-16 12:00: 57 |
| Retained voice request; `src/lib/voiceCompanion/admission.ts:195` | V | W | 20 | 0.12 | 2 | 2 | 10-15 13:00: 7 |
| Report passed into voice; `src/lib/voiceCompanion/admission.ts:210` | V | W | 54 | 0.32 | 2 | 2 | 10-15 13:00: 14 |
| Retained request enters confirmation wait; `src/lib/voiceCompanion/admission.ts:197` | V state history | W | 3 | 0.02 | 1 | 1 | 10-16 12:00: 2 |
| Retained voice request enters queue; `src/lib/voiceCompanion/admission.ts:207` | V state history | W | 20 | 0.12 | 1 | 2 | 10-15 13:00: 7 |
| Retained voice request records delivered; `src/lib/voiceCompanion/admission.ts:207` | V state history | W | 17 | 0.10 | 1 | 1 | 10-15 13:00: 7 |
| Retained partial transcript snapshots; `src/lib/voiceCompanion/admission.ts:247` | VE | W | 2,972 | 17.69 | 50 | 158 | 10-16 12:00: 1072 |
| Retained session ready event; `src/lib/voiceCompanion/liveSession.ts:263` | VE | W | 3 | 0.02 | 1 | 1 | 10-16 07:00: 1 |
| Retained session closed event; `src/lib/voiceCompanion/liveSession.ts:931` | VE | W | 6 | 0.04 | 1 | 1 | 10-16 12:00: 3 |
| Retained confirmation-required event; `src/lib/voiceCompanion/admission.ts:197` | VE | W | 2 | 0.01 | 1 | 1 | 10-14 19:00: 1 |
| Voice delegation confirmation recorded; `src/lib/voiceCompanion/admission.ts:501` | VE | W | 2 | 0.01 | 1 | 1 | 10-14 19:00: 1 |

The call record is the source for settled utterances and call boundaries. Partial transcript snapshots and speech-level samples occur many times for one utterance. Their event rings are bounded, and browser playback acknowledgments are separate from generated speech. Voice tool rows can be corrected in place; their stored final timestamp is used. A recorded reply or handoff does not prove its complete audio reached the speaker.

The voice event contract includes readiness/closure (operator, tool, cap, limit, transport, error), speech start/stop, transcript delta/final/snapshot, response start/generated/cancelled/failed, playback start/level/stop, tool call/result, delegation confirmation/retarget/send/settlement, report/answer, usage/context update and errors (`src/lib/voiceCompanion/contract.ts:92`). The session-event ring and durable request history give different coverage: three request-state entries await confirmation while only two confirmation-required events survive. Likewise seven call starts coexist with three surviving ready events. The method table keeps these series separate.

## Fine-grained runtime stream

| Event and emission site | Method | Window | Count | Mean/h | Max/10 s | Max/60 s | Busiest UTC hour: count |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| Runtime turn begins; `src/lib/runtime/codexAppServerHost.ts:4336` | J | R | 18 | 43.20 | 2 | 4 | 16:35–17:00 slice: 18 |
| Runtime turn ends; `src/lib/runtime/codexAppServerHost.ts:4408` | J | R | 22 | 52.80 | 2 | 4 | 16:35–17:00 slice: 22 |
| Assistant/reasoning text chunk; `src/lib/runtime/codexAppServerHost.ts:4341` | J | R | 1,606 | 3854.40 | 128 | 430 | 16:35–17:00 slice: 1606 |
| Reasoning item begins; `src/lib/runtime/codexAppServerHost.ts:4376` | J | R | 977 | 2344.80 | 17 | 68 | 16:35–17:00 slice: 977 |
| Agent message item begins; `src/lib/runtime/codexAppServerHost.ts:4376` | J | R | 212 | 508.80 | 7 | 17 | 16:35–17:00 slice: 212 |
| Codex command item begins; `src/lib/runtime/codexAppServerHost.ts:4376` | J | R | 697 | 1672.80 | 19 | 63 | 16:35–17:00 slice: 697 |
| Codex MCP item begins; `src/lib/runtime/codexAppServerHost.ts:4376` | J | R | 208 | 499.20 | 20 | 47 | 16:35–17:00 slice: 208 |
| Codex file-change item begins; `src/lib/runtime/codexAppServerHost.ts:4376` | J | R | 19 | 45.60 | 2 | 5 | 16:35–17:00 slice: 19 |
| Codex image-view item begins; `src/lib/runtime/codexAppServerHost.ts:4376` | J | R | 46 | 110.40 | 6 | 11 | 16:35–17:00 slice: 46 |
| Codex sleep item begins; `src/lib/runtime/codexAppServerHost.ts:4376` | J | R | 62 | 148.80 | 3 | 6 | 16:35–17:00 slice: 62 |
| Tool completion explicitly failed; `src/lib/runtime/codexAppServerHost.ts:4376` | J | R | 69 | 165.60 | 4 | 10 | 16:35–17:00 slice: 69 |
| Provider limits snapshot arrives; `src/lib/runtime/codexAppServerHost.ts:4413` | J | R | 881 | 2114.40 | 15 | 60 | 16:35–17:00 slice: 881 |
| Operation receipt transition; `src/runtime-host/journal.ts:1062` | J | R | 471 | 1130.40 | 21 | 62 | 16:35–17:00 slice: 471 |
| Session/host status update; `src/lib/runtime/structuredDeliveryController.ts:640` | J | R | 86 | 206.40 | 4 | 11 | 16:35–17:00 slice: 86 |
| Agent lineage edge recorded; `src/runtime-host/journal.ts:2957` | J | R | 12 | 28.80 | 1 | 2 | 16:35–17:00 slice: 12 |
| File catalog revision changes; `src/lib/runtime/filesRevision.ts:9` | J | R | 90 | 216.00 | 5 | 13 | 16:35–17:00 slice: 90 |
| Provider continuation cancellation record; `src/lib/pipelines/engine.ts:3146` | J | R | 1,958 | 4699.20 | 52 | 205 | 16:35–17:00 slice: 1958 |

R's 22 retained turn endings all report the normalized outcome `completed`. Other terminal outcomes are emitted by the Codex, Claude and Copilot hosts: error, interruption and host-loss restoration (`src/lib/runtime/codexAppServerHost.ts:3550`, `:4408`; `src/lib/runtime/claudeStreamBrokerHost.ts:1391`, `:1649`; `src/lib/runtime/copilotAcpHost.ts:714`, `:1003`). Claude also emits completed assistant and user frames; Codex emits paired item starts/completions. Delta and item counts are consequently engine/protocol dependent.

The 471 receipt transitions in R split into kill (queued 70, delivering 34, failed 40), send (queued 140, delivering 139, delivered 18, failed 1), and spawn (queued 15, delivered 13, failed 1). These are transition rows, not 471 independent requested actions. No receipt rows for steer, inject, interrupt, answer, compact, native-queue or reconfigure survive in R. Those operation kinds exist at `src/lib/runtime/contracts.ts:75`.

Runtime attention and attention resolution have zero retained R rows. Their active emitters are `src/lib/runtime/codexAppServerHost.ts:3053`, `:4284`, `src/lib/runtime/claudeStreamBrokerHost.ts:1582`, `:1596`, and `src/lib/runtime/copilotAcpHost.ts:891`, `:654`. Approval, tool permission, question and heuristic waiting are distinct attention kinds (`src/lib/runtime/contracts.ts:73`). Voice transcript/chunk and voice-delivery progress/acknowledgment also have zero R rows, with emitters at `src/lib/runtime/codexAppServerHost.ts:4223`, `:2769`, `:2939` and the event contract at `src/lib/runtime/eventStore.ts:155`. Flow/workflow/task-state and drift events are part of the open event vocabulary (`src/lib/runtime/contracts.ts:112`); none occur in this retained runtime slice. Zero within R gives no weekly absence claim.

## Lifecycle vocabulary coverage

The product's fixed lifecycle vocabulary contains 25 event types (`src/lib/lifecycle/vocabulary.ts:35`). The table below accounts for each type, including the zero-row types. L counts the surviving 2,000-row ring over W and is a lower bound. Its per-hour and burst metrics should be used only as evidence of retained traffic. The reconstructed rows above provide broader coverage for stages, merges, deployment and deliveries.

| Event and emission site | Method | Window | Count | Mean/h | Max/10 s | Max/60 s | Busiest UTC hour: count |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| spawn_failed; `src/lib/tasks/launchMembership.ts:372` | L | W | 0 | 0.00 | 0 | 0 | none |
| stage_waiting; `src/lib/lifecycle/projector.ts:165` | L | W | 10 | 0.06 | 1 | 1 | 10-21 08:00: 3 |
| stage_relaunched; `src/lib/lifecycle/projector.ts:165` | L | W | 5 | 0.03 | 1 | 1 | 10-21 08:00: 2 |
| stage_started; `src/lib/lifecycle/projector.ts:156` | L | W | 440 | 2.62 | 2 | 4 | 10-21 11:00: 52 |
| stage_resumed; `src/lib/lifecycle/projector.ts:60` | L | W | 2 | 0.01 | 1 | 1 | 10-20 21:00: 1 |
| stage_paused; `src/lib/lifecycle/projector.ts:51` | L | W | 2 | 0.01 | 1 | 1 | 10-20 22:00: 1 |
| stage_completed; `src/lib/lifecycle/projector.ts:189` | L | W | 270 | 1.61 | 3 | 4 | 10-21 11:00: 30 |
| stage_failed; `src/lib/lifecycle/projector.ts:189` | L | W | 123 | 0.73 | 4 | 5 | 10-21 11:00: 13 |
| stage_blocked; `src/lib/lifecycle/projector.ts:176` | L | W | 43 | 0.26 | 2 | 2 | 10-21 03:00: 5 |
| review_verdict; `src/lib/lifecycle/projector.ts:194` | L | W | 0 | 0.00 | 0 | 0 | none |
| repair_ready; `src/lib/lifecycle/projector.ts:87` | L | W | 92 | 0.55 | 2 | 2 | 10-21 11:00: 8 |
| deploy_ready; `src/lib/lifecycle/projector.ts:232` | L | W | 0 | 0.00 | 0 | 0 | none |
| deploy_succeeded; `src/lib/lifecycle/projector.ts:232` | L | W | 7 | 0.04 | 1 | 1 | 10-20 07:00: 2 |
| deploy_failed; `src/lib/lifecycle/projector.ts:232` | L | W | 0 | 0.00 | 0 | 0 | none |
| delivery_held; `src/lib/lifecycle/projector.ts:205` | L | W | 0 | 0.00 | 0 | 0 | none |
| delivery_delivered; `src/lib/lifecycle/projector.ts:205` | L | W | 844 | 5.02 | 3 | 8 | 10-20 09:00: 82 |
| delivery_expired; `src/lib/lifecycle/projector.ts:205` | L | W | 21 | 0.12 | 1 | 1 | 10-20 11:00: 4 |
| agent_stalled; `src/lib/lifecycle/projector.ts:328` | L | W | 0 | 0.00 | 0 | 0 | none |
| agent_gone; `src/lib/lifecycle/projector.ts:342` | L | W | 0 | 0.00 | 0 | 0 | none |
| agent_resumed; `src/lib/lifecycle/projector.ts:356` | L | W | 0 | 0.00 | 0 | 0 | none |
| project_moved; `src/lib/projects/succession.ts:119` | L | W | 0 | 0.00 | 0 | 0 | none |
| pipeline_merged; `src/lib/lifecycle/projector.ts:107` | L | W | 18 | 0.11 | 1 | 1 | 10-20 21:00: 2 |
| task_finished; `src/lib/lifecycle/projector.ts:119` | L | W | 30 | 0.18 | 2 | 2 | 10-21 12:00: 4 |
| permission_denied; `src/lib/runtime/permissionDenials.ts:167` | L | W | 17 | 0.10 | 1 | 1 | 10-21 02:00: 3 |
| subagent_policy_violation; `src/lib/runtime/codexSubagentDetection.ts:148` | L | W | 0 | 0.00 | 0 | 0 | none |

`review_verdict` is projected only for a stage whose kind is `review-loop` (`src/lib/lifecycle/projector.ts:34`). Reviewer agents running ordinary `run` stages contribute stage report pass/fail events instead. `repair_ready` is the fail-edge handoff time, while repair activation is its later stage start. A blocked publication-text rewrite can emit `stage_blocked` independently of the attempt's terminal state. The same event type therefore needs its originating record to establish meaning.

## Current audio and the kept typing effect

The entry graph starts at `src/app/page.tsx:1` and renders `Viewer` at `:19`. Viewer mounts `useAgentChimes` at `src/components/Viewer.tsx:445`, `AttentionHost` at `:1967`, project UI at `:1918` and the voice companion at `:2012`. The source import walk reaches all current audio modules. Rendered calls also confirm the cue-producing hooks and controls below are mounted. No disconnected audio module is used as evidence for an event.

| Existing sound or control | Live trigger and emission site | History available |
| --- | --- | --- |
| Kept typing effect: `tool-tick-1.mp3` through `tool-tick-8.mp3` | `src/lib/audio/cues.ts:56` chooses a random slice of one typing master. `src/components/LogFeed.tsx:885` mounts `useToolActivityCues`; its scan requests playback at `src/hooks/useToolActivityCues.ts:51`. `src/lib/audio/toolCues.ts:35` chooses typing for ordinary tools. | TR counts source tool calls. Mounted-pane exposure and playback are unrecorded. This identifies the retained effect from the code's explicit live-typing intent at `src/lib/audio/cues.ts:47`. |
| `viewer-mcp.mp3` | A tool event carrying the Viewer MCP marker takes the other branch at `src/lib/audio/toolCues.ts:36`. Server aliases are recognized at `src/lib/mcp/presentation.ts:41`. | Direct Viewer calls are counted separately by TR. Nested calls shown inside an orchestration are not individually recorded executions. |
| `attention.mp3` | A live agent becomes waiting/question (`src/hooks/useAgentChimes.ts:90`, `:103`, `:207`); an attention offer at `src/components/overlay/useAttentionOffers.ts:373`; direct acceptance at `src/components/attention/AttentionHost.tsx:340`. | F, AT, L and J describe overlapping source obligations. Browser transition counts are unavailable. |
| `failure.mp3` | A pane transitions into stalled; mapping at `src/lib/audio/cues.ts:122`, detector at `src/hooks/useAgentChimes.ts:102`. | Stalled is a pane/liveness interpretation. Stage failures alone do not reconstruct it. |
| `success.mp3` | Returned agent transition (`src/lib/audio/cues.ts:121`); enabling sound previews it at `src/components/SoundToggle.tsx:52`. | Successful turn/stage records overlap; preview count is unavailable. |
| `launch.mp3` | A child first links into the observed tree (`src/hooks/useAgentChimes.ts:104`) or draft launch result (`src/components/DraftAgentPane.tsx:650`). | G counts launch/generation records. A late-resolved parent link can ring without a new process. |
| `voice-call-loop.wav` | `src/lib/audio/loopAsset.ts:15`; Viewer/call settings and live call ownership select whether the loop runs (`src/lib/audio/app.ts:151`, `:180`). Speech ducks it through `src/lib/audio/app.ts:195`. | Browser loop playback time is unavailable. Its eligibility includes a user setting and call connection, so its presence cannot establish agent work. |
| Synthesized dictation warning/stop | `src/hooks/useDictation.ts:596` and `:243`, using `src/lib/chime.ts:143` and `:149`. | These client microphone boundary events are not durably recorded. |
| Synthesized companion connect/disconnect | `src/lib/voiceCompanion/cues.ts:64`; called after connection at `src/lib/voiceCompanion/liveAdapter.ts:127` and disconnect at `:297`. | V has call starts/ends; actual browser connection cue counts are unavailable. |
| Master switch and levels | Desktop menu `src/components/ProjectDashboard.tsx:2132`, phone/header `src/components/headerMenu/HeaderMenu.tsx:337`. Preferences at `src/lib/audio/prefs.ts:19` are device-local; default cue volume 0.4, music 0.05 and music disabled at `:47`. | Changes, focus/background state, volume choices and device counts are unrecorded. |

The tool scanner suppresses loaded history on its first scan, except running calls, and uses source-line progression for newly appended calls (`src/lib/audio/toolCues.ts:78`). Nested command groups are traversed at `:45`. The cue player remembers 2,048 event identities, caps concurrent voices at three, lets a higher tier displace a lower tier and drops refused events without backlog (`src/lib/audio/cuePlayer.ts:77`, `:83`, `:132`). Agent and tool cascades use 220 ms staggering (`src/hooks/useAgentChimes.ts:20`, `src/lib/audio/toolCues.ts:72`). Every event identity is spent before mute/transport checks. Consequently source counts cannot recover played, blocked, muted, deduped or dropped totals.

`src/lib/chime.ts` remains reachable for the shared context, panning and dictation. Its older lifecycle tone definitions have no current lifecycle call site: `useAgentChimes` uses `playCue`. The typing effect is the eight tool-tick assets identified above. Native speech/TTS audio is distinct from these work cues: `src/components/feed/SpeakButton.tsx:103` and `src/hooks/useCodexRealtime.ts:127` have live consumers.

## Native transcript counts

TR read 3,582 retained transcript files, 13,316,690,308 bytes and 2,224,251 records as fixed byte prefixes. The inventory used the copied registry's generation paths and the copied activity file index; exact filesystem names remain private. Recent files were selected by modification time at or after W's start and records were filtered again by their own timestamps. Missing registry/index locations and any malformed/truncated prefix are reported in the coverage notes. Copied records sharing an engine-issued call id count once. Tool arguments and result bodies are not used as occurrence claims. The aggregate prefix-manifest SHA-256 is `a5a6001de768ed384d531551af3a753e57ab8c141c48144bdd66ad94f3d95071`.

| Event and emission site | Method | Window | Count | Mean/h | Max/10 s | Max/60 s | Busiest UTC hour: count |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| All structured model-issued tool calls; `src/components/feed/parse.ts:3617` | TR | W | 274,213 | 1632.22 | 52 | 129 | 10-15 14:00: 3614 |
| Calls without a direct Viewer MCP identity; `src/lib/audio/toolCues.ts:35` | TR | W | 255,907 | 1523.26 | 52 | 116 | 10-14 19:00: 3389 |
| Direct Viewer MCP calls; `src/components/feed/parse.ts:564` | TR | W | 18,306 | 108.96 | 25 | 106 | 10-21 01:00: 1204 |
| Claude model-issued tool calls; `src/components/feed/parse.ts:3715` | TR | W | 71,945 | 428.24 | 47 | 112 | 10-15 14:00: 1745 |
| Codex model-issued tool calls; `src/components/feed/parse.ts:3617` | TR | W | 202,268 | 1203.98 | 19 | 79 | 10-15 07:00: 2901 |
| Codex orchestration outer calls; `src/components/feed/parse.ts:1392` | TR subset | W | 184,526 | 1098.37 | 18 | 79 | 10-15 07:00: 2449 |
| Claude tool results explicitly marked error; `src/components/feed/parse.ts:3535` | TR | W | 2,640 | 15.71 | 5 | 9 | 10-16 13:00: 58 |
| Claude API retry/error records; `src/lib/runtime/claudeStreamBrokerHost.ts:1573` | TR | W | 4 | 0.02 | 1 | 2 | 10-15 08:00: 2 |
| Claude API error assistant records; `src/lib/runtime/claudeStreamBrokerHost.ts:1573` | TR | W | 12 | 0.07 | 3 | 5 | 10-21 13:00: 9 |
| Claude compaction boundaries; `src/lib/runtime/claudeStreamBrokerHost.ts:1573` | TR | W | 2 | 0.01 | 1 | 1 | 10-16 12:00: 1 |
| Codex explicit aborted-turn records; `src/components/feed/parse.ts:3361` | TR | W | 74 | 0.44 | 9 | 10 | 10-15 06:00: 15 |
| Codex explicit error records; `src/components/feed/parse.ts:3361` | TR | W | 0 | 0.00 | 0 | 0 | none |

Coverage: 10,147 registry/index transcript locations existed during inventory and 77 were missing. Of those present, 3,582 files had modification times at or after W's start. The scan reports 0 files missing at read time, 0 invalid JSON lines, 1 partial final lines and 0 files shrinking during a prefix read. Inherited/copied records with identical call ids are deduplicated. W statistics cover retained readable structured records; deleted history, unrecognized formats and native calls inside dynamically executed orchestration remain outside that count.

Codex `functions.exec` records count one outer model-issued tool invocation. Its statically displayed nested `tools.*` calls have no independent execution receipt in the native transcript (`src/components/feed/parse.ts:1392`). A textual reference to a Viewer tool inside that code does not establish a Viewer MCP execution. Direct Viewer MCP calls are identified using the feed's recognized server aliases; all other outer calls remain in the ordinary-tool series. Error rows count explicit flags or typed records; result text is never searched for words that suggest failure.

## Busiest observed tool hour

The busiest retained tool hour is 2026-10-15 14:00 UTC, with 3,614 outer model-issued calls. The following five-minute bins preserve the observed within-hour shape for the next lane's busy-hour simulation. All columns are aggregate counts. Stage settlements and decision forms use W's same source clock. Merge confirms and deployment settlements retain the timing qualifications in methods M and D.

| Minute in hour | Ordinary tools | Direct Viewer MCP | Stage starts | Stage pass | Stage fail | Stage needs decision | Forms raised | Merge confirms | Deploy succeeded |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 00–05 | 319 | 9 | 2 | 1 | 0 | 0 | 0 | 1 | 0 |
| 05–10 | 418 | 24 | 6 | 2 | 1 | 1 | 0 | 0 | 0 |
| 10–15 | 327 | 20 | 5 | 2 | 0 | 0 | 0 | 0 | 0 |
| 15–20 | 265 | 33 | 3 | 4 | 0 | 0 | 1 | 0 | 0 |
| 20–25 | 314 | 11 | 3 | 3 | 1 | 0 | 0 | 0 | 0 |
| 25–30 | 312 | 20 | 6 | 2 | 3 | 0 | 0 | 0 | 0 |
| 30–35 | 265 | 7 | 1 | 2 | 1 | 0 | 0 | 1 | 0 |
| 35–40 | 242 | 27 | 3 | 5 | 0 | 1 | 0 | 0 | 0 |
| 40–45 | 245 | 25 | 4 | 2 | 0 | 0 | 0 | 1 | 0 |
| 45–50 | 277 | 21 | 4 | 3 | 0 | 1 | 0 | 0 | 0 |
| 50–55 | 181 | 14 | 4 | 0 | 2 | 0 | 0 | 1 | 0 |
| 55–60 | 223 | 15 | 11 | 3 | 8 | 0 | 0 | 0 | 1 |

Reduced class/timestamp-series SHA-256: `1761a0a0d7be44de7159d4e3a941a916a4a3436d0ad30efbc8fa30cd3df4c3ba`. The series carries no message bodies, arguments or destination identities; only this digest and aggregates are published. The source databases and raw private prefixes remain in stage scratch and are not repository artifacts.

## Events whose lifetime frequency is unavailable

These are emitted events with incomplete or absent occurrence history. The method for each is to inspect its producer and query its retained store/event kinds in W (or R for runtime events). `Unknown` means the necessary clock or history was never retained; it must remain unknown when sizing the later design. A zero-row query is reported explicitly where a retained stream exists.

| Event family | Emission or consumer site | Count and rate result |
| --- | --- | --- |
| Permission/approval/question opens, answers, cancellation and expiry | `src/lib/runtime/codexAppServerHost.ts:3053`, `:4284`; Claude `src/lib/runtime/claudeStreamBrokerHost.ts:1582`; Copilot `src/lib/runtime/copilotAcpHost.ts:891` | J: 0 opens and 0 resolutions in R; 0/h, burst 0, no busiest slice. Weekly opens and browser dialogs unknown. L retains 17 denials in W, counted above. |
| Agent stalls, host gone, activity resumed | `src/lib/lifecycle/projector.ts:328`, `:342`, `:356` | L: 0 retained W rows for each; retained mean and bursts 0, no busiest hour. Whole-window incidence unknown after journal eviction. Current liveness does not restore past transitions. |
| CPU/worker/memory admission wait, drain and capacity release | `src/lib/pipelines/engine.ts:7684`; `src/lib/pipelines/types.ts:529`, `:535`; `src/lib/runtime/structuredSpawn.ts:101` | Current wait state and bounded recovery entries are insufficient for a complete timestamped history. Unknown incidence, per-hour/burst rates and busiest hour. AP and DP count the retained related records explicitly. |
| Account switching, reseating, usage reset-credit redemption and auth repair | `src/lib/events.ts:102`; `src/app/api/accounts/codex/reset-credits/route.ts:123`, `:136`; `src/lib/accounts/reseat.ts:68` | Operation log contains 0 rows of these kinds in Q; retained rate and bursts 0, no busiest hour. Migration intents and current assignments do not reconstruct every transition. AP/DP/LH give separately named observations. |
| Pipeline end, publication gate refusal/retry/repair, merge-check pending/red/green | `src/lib/pipelines/engine.ts:5249`, `:2607`; `src/lib/forge/autoMerge.ts:420` | Stage settlements, reports, publication rewrite and recorded merge blocks are counted above. Complete edge histories for these broader states are unknown because latest state and bounded repairs replace prior state. |
| Deployment intermediate phases and health/release succession | `src/runtime-host/deployment.ts:343`; `src/lib/selfUpdate/deployments.ts:34` | D dates admissions and terminal outcomes. Complete phase-edge frequency is unknown; a current terminal record cannot establish each phase it traversed. |
| Board moves/edits, dismissal/return, linked-board propagation and team connection changes | `src/lib/tasks/store.ts:60`, `:832`; `src/lib/attention/store.ts:397`; `src/lib/team/events.ts:81` | Retained births, current Done and focus requests are counted. Revision markers and current snapshots lack a complete event clock. Unknown other frequencies. |
| Voice cap/limit/transport/error closure, speech start/stop, playback/mute/interruption and context changes | `src/lib/voiceCompanion/contract.ts:92`; `src/lib/voiceCompanion/liveSession.ts:728`, `:931`; `src/lib/voiceCompanion/liveAdapter.ts:71` | V dates operator, cap and transport closures above. VE contains 0 retained error events in W; this gives no lifetime absence claim. Browser-local and overwritten event frequencies unknown. |
| Native realtime voice transcript/chunk, handoff and delivery acknowledgment | `src/lib/runtime/codexAppServerHost.ts:4223`, `:2769`, `:2939`; `src/lib/runtime/codexRealtimeTranscript.ts:150` | J: 0 of these kinds in R, normalized rate and bursts 0, no busiest slice. The per-host ledger inventory contains 8,757 files and about 16.24 GB. Its event contract carries a sequence without a required absolute timestamp (`src/lib/runtime/engineHost.ts:104`), so those files cannot independently place every voice edge inside W. Companion call counts remain a separate measured series. |
| Dictation begin/end/warning and transcription failure; TTS play/pause/finish/error | `src/hooks/useDictation.ts:243`, `:596`; `src/components/feed/SpeakButton.tsx:222`; `src/components/feed/ttsSession.ts:464` | Client-only event history is absent. Counts, hourly/burst rates and busiest hour unknown. Server text generation and audio creation do not prove playback. |
| Relay ingress/reconnect/retry/suppression, bot transport errors and incoming personal-account activity | `src/lib/externalRelay/store.ts:403`, `:437`; `src/lib/telegram/bot/outbound.ts:131`; `src/lib/telegram/bot/store.ts:521` | XR/TG cover retained claims, terminal completions and bot messages. Current delivery state and opaque personal-account responses do not provide a complete event series. Other rates unknown. |
| Generic HTTP error, browser offline/reconnect, autoplay failure and sound preference changes | `src/lib/audio/app.ts:209`; `src/lib/audio/cuePlayer.ts:132`; `src/lib/audio/prefs.ts:98`; `src/components/SoundToggle.tsx:47` | No complete durable event series for this audit. Counts, hourly/burst rates and busiest hour unknown. No synthetic zero is assigned. |

This coverage boundary is part of acceptance 1's evidence. Adding counters, retaining more private history or running an active telemetry session would change the authorized read-only scope. None is proposed as a prerequisite for the later sound prototype.

## Overlap and meaning for the next lane

The event families form several overlapping sequences. A model tool call can produce an item start, text deltas, an item completion, a failed result and another model call. A stage can submit pass, fail publication, settle blocked and then start a repair. One decision can produce a form, stage park, attention offer, bridge report and several Telegram polls. A wake can be queued, confirmed landed and followed by a new orchestrator turn. A release can complete its build, apply, serving checks, deployment settlement and lifecycle projection.

These sequences account for the different totals. Adding table rows together would inflate a future cue rate. Source timestamps describe what the machine emitted or recorded; they contain no retained account of what was visible or audible on each browser. The next lane can use the measured distributions and the explicit coverage limits to choose sounds and insertion points.

## Reproduction and checks

To repeat the count without a live-state writer, make stable main/WAL copies into the stage's assigned scratch directory as described above. Use Python's standard-library `sqlite3`, JSON and datetime readers on those copies. Resolve source roots from the installed configuration privately; publish only source-kind labels and aggregates. Do not import Delegatus stores to discover history: store initialization can migrate state.

The core selection for stage counts is:

```sql
SELECT collection, row_key, value_json
FROM state_rows
WHERE collection IN ('pipelines_archive', 'pipelines');
```

Decode those selected rows, let `pipelines` replace the archive row of the same id, walk each nonhistorical attempt, and emit `(class, unique-key, source-time)` according to the method table. Apply the same representation to every other source. Keep unique keys inside the reader. Publish only the aggregate:

```python
from collections import Counter

def aggregate(times_ms, start_ms, end_ms):
    times = sorted(t for t in times_ms if start_ms <= t < end_ms)
    def peak(width_ms):
        left = best = 0
        for right, stamp in enumerate(times):
            while times[left] <= stamp - width_ms:
                left += 1
            best = max(best, right - left + 1)
        return best
    hours = Counter(t // 3_600_000 for t in times)
    maximum = max(hours.values(), default=0)
    busiest = min((h for h, n in hours.items() if n == maximum), default=None)
    return (len(times), len(times) / ((end_ms - start_ms) / 3_600_000),
            peak(10_000), peak(60_000), busiest, maximum)
```

The burst interval is `(stamp - width, stamp]`; hour bins are `[hour, hour + 1h)`. This handles simultaneous events, exact boundary timestamps, empty categories and ties consistently. Retain the timestamps only in private scratch. A later extraction can differ because the live primary records and bounded histories change; the aggregate document is the published result of this capture.

Legacy flow and workflow collections are absent from the state snapshot, and their legacy JSON stores are absent as well (`src/lib/flows/store.ts:184`, `src/lib/workflows/store.ts:24`). Their retained-record count in W is zero, with retained mean/bursts zero and no busiest hour. This establishes no older lifetime absence.

Validation: every queried scratch database passed `PRAGMA quick_check`; table counts and rates were recomputed from the reduced timestamp series; source references and audio reachability were checked against the pinned revision. No product tests or builds are needed for this documentation-only audit. The explicit-file publication privacy gate (`bun scripts/privacy-publication-gate.ts --require-known-values --paths docs/design/sound-events-audit.md`, with the committed fingerprint file and isolated HOME/config/state/temp roots) and `git diff --check` pass. No suites ran.

| Snapshot kind | SHA-256 of recovered scratch database |
| --- | --- |
| state.sqlite | `348b884389644b8fafc89b55ca90c647cc60f73c20191d7ce737fb70436a810e` |
| agent-registry.sqlite | `4191e9fef4e30b2b87c860fe127c15d0939b583af3e49a5e603425f1c7e2418e` |
| runtime journal | `f586203771d8588c79d26ebb13eba6b69e286b568e2f7270fbe67c4d26dd7324` |
| delivery-progress.sqlite | `d8b540eac311c1400bc32fcbb4bfa8056006d5971c956d359ad3d9a7525abde5` |
| mcp-receipts.sqlite | `639e599e184c216aa166ad1b7864a80c7abea8d864faa432c94d5081cd1154b7` |

## Deferred — not currently justified

Acceptance 2–5 belong to subsequent lanes: a sound map, insertion-point critique, synthesized palettes, listening prototype, rendered media and the operator form. This stage makes no irreversible design decision and needs no ADR. Product instrumentation, history-retention changes, source changes, playback experiments, live-state writes and production restarts are outside this audit.
