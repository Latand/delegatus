# Seat tick wakes that advance nothing (#3912)

## Requirement

On 2026-11-12, around 06:07 UTC, the operator asked for an analysis of
orchestrator seats repeatedly waking while accepted work remained untouched.
The requested alternatives were autonomous progress within the mandate, or a
tick setting that waits for the operator to return. Source: issue #3912.
The correction later that morning explicitly extended the analysis to seats
running on every engine. This report paraphrases those private instructions.

This is an analysis and a proposed design. It changes no product code.
Source references below name `dfc99dce25`; evidence has a common exclusive
cutoff of **2026-11-12 06:10 UTC**. The correction was investigated on
2026-11-12, with source reads between 07:05 and 07:30 UTC.

**Finding.** Both engines show wakes that repeatedly inspect blockers and
report status without advancing work. In this project, Claude recorded no
work transition on **155 of 265 owed wakes (58.5%)**. Codex recorded none on
**79 of 91 (86.8%)**, with another two outcomes unresolved. The longest
confirmed runs were 49 Claude wakes over 10 hours 10 minutes and 38 Codex
wakes over 4 hours 22 minutes. These are observations of different periods,
mandates and workloads; they establish a shared failure class. They do not
establish an engine performance ranking.

The known November 12 case remains confirmed: five successive task wakes
held nine existing tasks and created one held task, with no lane started.
The corrected proposals preserve a baseline for each delivered wake, flag
repeated parking or unchanged work, and make waiting change the tick.

## 1. Sources, coverage and method

### 1.1 Census before sampling

The earlier version selected four projects with recent journal wakes and
searched their Claude transcripts. Its assertion that Codex seats were
absent was wrong. The corrected census starts from current seats and
revocations in `orchestrator-seats.json`, using each record's engine,
activation, revocation, transcript and project. The lineage list supplies
conversation membership but does not itself contain engine fields.

The common observation window is **2026-11-09 00:00 through 2026-11-12
06:10 UTC**. Every retained seat record overlapping that window is included.
This includes seats that received no wake. There are 56 recorded
conversations in 12 projects: 29 Claude and 27 Codex, covering 57 ownership
intervals. One C conversation was designated twice and is counted once;
each wake still joins to the epoch in force at its time. Fifty-four transcripts
are readable; 46 contain sampled wakes. Eight readable conversations have
no wake in the window; two Claude transcripts are unavailable.

Codex discovery covers the default sessions root and managed account session
roots, including retained roots described by
`src/lib/accounts/codex.ts:546` and registered by
`src/lib/scanner/roots.ts:80`. The default root contains a November 11 Codex
seat in project D; the managed roots contain the earlier seats. A directory
restricted to Claude projects misses both. No additional engine occurs in
the overlapping seat records.

Engine attribution comes from the seat record and the transcript format,
checked against `conversation_messages`. Journal wake rows join to those
records by project and seat epoch. The journal examples examined do not
carry a separate top-level engine field; worker stage engine fields describe
workers and cannot establish the seat's engine. Error rows with no seat epoch
remain unattributed.

### 1.2 Coverage by project and engine

Project letters identify kinds of cases without publishing project names.
A is this repository. Counts include every readable wake in the common
window, including catch-up wakes and both autonomy-overlay wordings.

| Project | Claude conversations / waking / wakes | Codex conversations / waking / wakes | Wake bounds, UTC |
| --- | --- | --- | --- |
| A | 10 / 10 / 295 | 8 / 7 / 91 | Codex: 11-09 00:09–11:26; Claude: 11-09 11:38–11-12 06:05 |
| B | 6 / 6 / 114 | 2 / 0 / 0 | Claude: 11-10 20:46–11-11 20:17 |
| C | 2 / 2 / 184 | 0 / 0 / 0 | Claude: 11-09 11:08–11-11 06:59 |
| D | 4 / 4 / 79 | 11 / 11 / 37 | Codex: 11-09 07:01–11-11 10:33; Claude: 11-09 14:58–11-12 00:52 |
| E | 2 / 1 / 6 | 4 / 4 / 38 | Codex: 11-09 00:02–13:12; Claude: 11-09 13:45–17:05 |
| F | 1 / unavailable / unknown | 0 / 0 / 0 | Transcript unavailable |
| G | 1 / 0 / 0 | 0 / 0 / 0 | Readable; no sampled wake |
| H | 1 / 0 / 0 | 0 / 0 / 0 | Readable; no sampled wake |
| I | 0 / 0 / 0 | 1 / 0 / 0 | Readable; no sampled wake |
| J | 1 / 0 / 0 | 0 / 0 / 0 | Readable; no sampled wake |
| K | 0 / 0 / 0 | 1 / 1 / 7 | Codex: 11-09 10:00–17:00 |
| L | 1 / unavailable / unknown | 0 / 0 / 0 | Transcript unavailable |
| **Total** | **29 / 23 / 678 observed** | **27 / 23 / 173 observed** | **851 observed wakes** |

These are bounded historical observations. Zero sampled wakes does not prove
that a seat was absent, healthy or idle throughout its lifetime. The missing
F and L transcripts prevent a complete transcript census for those two seats;
the retained recent journals contain quiet/error checks rather than landed
wakes for them. Their earlier behaviour remains unmeasured.

All 295 A/Claude wakes and all 91 A/Codex wakes contain an autonomy overlay.
B/Claude has 38 of 114. The other sampled groups have none. Matching only the
short unchanged-overlay wording caused the earlier undercount.

### 1.3 Primary records and limits

| Source | Use and bound |
| --- | --- |
| Native Claude and Codex transcripts | Wake payload, complete call arguments, call results, assistant replies and usage records; only records before the common cutoff |
| `conversation_messages` and `search_transcripts` | Opened the earlier author and check conclusions, cross-checked both native formats, the known case and Codex examples |
| `search_memory` | Project and cross-project searches for earlier idle/recovery explanations; no earlier engine-complete analysis found |
| Seat store | Census, ownership intervals and engine attribution; read on the correction pass |
| MCP receipt store | Read-only lookup by original tool/request key when Codex printed a projection instead of the full result; 150 supplemental envelopes, including reads |
| Delivery-progress store | Original operation/key and timestamped engine-echo/delivery records; later reads credit only effects dated before the common cutoff |
| Per-project tick journal | Check, wake and landing evidence; bounded rings retain 500 records, whose oldest timestamp moves as new checks arrive |
| Source at the stated revision | Existing admission, reminder, hold, retry and landing behaviour |

No command from a transcript was executed. The parser reads JSON and
statically inspects JavaScript call arguments; it never evaluates transcript
code. Analysis scripts run in stage scratch. Live stores are opened read-only;
no settings, tasks, conversations or services are changed.

### 1.4 Per-wake classification

A wake starts with the seat-tick header, after removing the transport marker.
Both header forms occur: a separate `Wake reasons` line and reasons following
a semicolon on the first line. Calls and replies belong to that wake until
the next user message, excluding tool-result envelopes. Both engines follow
this boundary. Duplicate usage envelopes are deduplicated independently.

An **owed wake** carries any of `unstarted-task`, `overdue-task`, `worker-ask`,
`stalled`, `own-lane-settled`, `unmerged-pr`, `permission-request` or
`autonomy-idle`. An interval or event-only wake is neutral for the denominator.

The outcome partition is applied in this order:

1. **Work transition:** a successfully admitted lane or worker; an applied
   stage, decision, publication or merge transition; a task newly done or
   assigned, a hold lifted, or an unheld task created; a delivered worker
   instruction; a confirmed requested delivery/deploy; or a successful manual
   Git/forge repair. A reserved worker launch is an admission, with execution
   still pending. A transition measures recorded action. Completion and compliance with the
   mandate require separate assessment.
2. **Unknown:** no confirmed transition, with an unresolved potentially
   consequential write/send. Queued acceptance and timeouts alone earn no
   progress credit. Original-key delivery records can resolve a send even
   when its first reply was lost. Unresolved operations stay unknown.
3. **Hold only / date only / mixed parking:** task holds and/or due-date
   changes, allowing accompanying task notes, reports and decision-log notes.
   A published form, lane closure or other separate state write instead puts
   the wake in bookkeeping.
4. **Other bookkeeping:** successful forms, escalation, lane closure,
   annotations, reports or settings notes, with no work transition.
5. **No write:** reads and reply, including refused mutations and reporting
   calls that explicitly stored nothing.

Refused actions, empty `changedFields`, and replayed acknowledgements earn no
new transition. Full arguments identify targets; truncation is permitted only
for displayed excerpts. Shell reads such as PR checks or log tails earn no
write. A successful check rerun is a manual repair.

The aggregate table asks whether **any work transition** occurred in a wake
that carried owed work. It is an upper bound on responsiveness to the listed
items: action elsewhere can coexist with neglect of the wake's agenda.
Section 2.3 separately matches visible item IDs to actual structured write
targets. Missing/truncated bullets and work mentioned only in prose receive
no invented item-level attribution.

A **confirmed no-transition run** contains consecutive owed wakes classified
as parking, bookkeeping or no-write. An advance or unknown outcome on any
wake breaks it, including a neutral wake; a neutral wake without either
neither extends nor breaks it. Duration is last minus first wake timestamp.
Runs describe wake handling and can cross rotations or intervening operator
messages. They do not establish inactivity between wakes, a blocked item's
invalidity, or operator absence elsewhere.

## 2. Results and engine comparison

### 2.1 Outcomes on owed wakes

| Project / engine | Owed | Work transition | Hold only | Date only | Mixed parking | Other bookkeeping | No write | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A / Claude | 265 | 110 | 17 | 20 | 1 | 38 | 79 | 0 |
| A / Codex | 91 | 10 | 1 | 0 | 0 | 43 | 35 | 2 |
| B / Claude | 47 | 33 | 2 | 0 | 0 | 3 | 8 | 1 |
| C / Claude | 23 | 9 | 0 | 0 | 0 | 9 | 5 | 0 |
| D / Claude | 52 | 25 | 5 | 1 | 0 | 13 | 5 | 3 |
| D / Codex | 29 | 22 | 0 | 0 | 0 | 2 | 5 | 0 |
| E / Claude | 6 | 4 | 0 | 0 | 1 | 1 | 0 | 0 |
| E / Codex | 9 | 2 | 1 | 0 | 0 | 3 | 0 | 3 |
| K / Codex | 6 | 5 | 0 | 0 | 0 | 1 | 0 | 0 |
| **Claude total** | **393** | **181** | **24** | **21** | **2** | **64** | **97** | **4** |
| **Codex total** | **135** | **39** | **2** | **0** | **0** | **49** | **40** | **5** |

Every row partitions its denominator. Of 528 owed wakes across both engines,
220 show a transition, 299 show none, and nine remain unknown. Unknowns are
excluded from confirmed no-transition runs. Some initially uncertain sends
were delivered according to their original operation records; those earn
credit. Others have no such evidence. Repeated attempts under one original
key can leave more than one wake unknown without proving multiple deliveries.

The distinction between projects is substantial. In D, Codex transitions on
22 of 29 owed wakes, frequently delivering a bounded instruction to an
existing reader or worker. In A, it transitions on 10 of 91. D provides a
counterexample to interpreting A as an engine-wide inability to act.

### 2.2 Confirmed runs of four or more owed wakes

| Project / engine | Runs | Wakes in runs | Total elapsed hours | Longest |
| --- | ---: | ---: | ---: | --- |
| A / Claude | 11 | 103 | 20.03 | 49 wakes, 10 h 10 min |
| A / Codex | 3 | 72 | 7.68 | 38 wakes, 4 h 22 min |
| B / Claude | 1 | 5 | 1.09 | 11-11 03:38–04:43 |
| D / Claude | 1 | 4 | 0.62 | 11-10 20:59–21:36 |
| Other measured groups | 0 | 0 | 0 | No qualifying confirmed run |

A/Codex runs, all on November 9:

| Start–end, UTC | Owed wakes | Outcome mix |
| --- | ---: | --- |
| 00:09–04:31 | 38 | 24 bookkeeping, 14 no-write |
| 04:51–07:27 | 28 | 8 bookkeeping, 20 no-write |
| 09:48–10:30 | 6 | 6 bookkeeping |

The first two runs cross seat rotations. The wakes keep listing exhausted
review budgets, uncertain previous launches and paused lanes. The seat rereads
primary history and records why it retains each blocker. These reads can be
necessary for a safe recovery. Repeating them without resolving the blocker,
choosing another authorized item or changing the tick reproduces the idle
failure. No Codex turn in A changes cadence during this window.

A/Claude runs: 11-09 21:12–22:42 (9); 11-09 23:05–11-10 09:15 (49);
11-10 09:52–10:40 (5), 12:57–13:45 (4), 14:10–14:35 (4),
14:55–16:10 (4); 11-11 05:03–05:50 (5), 06:48–07:42 (6),
22:25–23:32 (6); 11-12 03:20–04:22 (5), 04:47–06:05 (6).
A successful repair on a neutral wake breaks a run; this corrects the earlier
method that ignored movement on neutral wakes.

For cost context, the A/Codex 38-wake run contains 208 distinct cumulative
usage increments, 70,074 output tokens and 31,870,916 replayed input tokens.
The A/Claude 49-wake run contains 79 model requests, 19,007 output tokens and
22,492,069 input tokens. Codex usage increments come from changes in the
provider cumulative totals; duplicate snapshots add nothing. Claude requests
are deduplicated by model message ID. Input includes cache reads; Codex cached
input is already part of input and is not added again. These are native usage
observations, without a monetary-cost or cross-engine efficiency claim.

Across A, confirmed no-transition owed wakes account for 390 Claude requests
and 250,304 output tokens, and 437 Codex usage increments and 155,844 output
tokens. Unknown wakes are excluded from those costs.

### 2.3 What happened to the visible agenda items

The following table counts complete `[task]` and `[ask]` bullets by their
structured target, retaining full call arguments and successful effects.
Other includes notes, closure or escalation. A successful action on an
unrelated item earns no item-level credit. Delivery instructions lacking a
provable item link likewise receive no direct target attribution.

| Project / engine / item | Listings | Transition targeting item | Hold | Date | Other targeted write | Unknown | No targeted write |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A / Claude / task | 529 | 15 | 38 | 59 | 2 | 1 | 414 |
| A / Claude / ask | 149 | 25 | 0 | 0 | 16 | 0 | 108 |
| A / Codex / ask | 100 | 0 | 0 | 0 | 0 | 0 | 100 |
| B / Claude / task | 25 | 2 | 18 | 2 | 0 | 0 | 3 |
| B / Claude / ask | 24 | 12 | 0 | 0 | 4 | 0 | 8 |
| C / Claude / ask | 3 | 2 | 0 | 0 | 0 | 0 | 1 |
| D / Claude / task | 35 | 5 | 14 | 16 | 0 | 0 | 0 |
| D / Claude / ask | 16 | 2 | 0 | 0 | 1 | 0 | 13 |
| D / Codex / task | 31 | 1 | 4 | 1 | 2 | 0 | 23 |
| D / Codex / ask | 7 | 0 | 0 | 0 | 1 | 0 | 6 |
| E / Claude / task | 13 | 1 | 11 | 1 | 0 | 0 | 0 |
| E / Claude / ask | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| E / Codex / task | 6 | 0 | 5 | 0 | 1 | 0 | 0 |
| E / Codex / ask | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| K / Codex / task | 4 | 3 | 1 | 0 | 0 | 0 | 0 |
| K / Codex / ask | 2 | 1 | 0 | 0 | 0 | 0 | 1 |

This narrower matching replaces the earlier substring-based item totals.
The 149 A/Claude asks include every complete visible ask bullet, including
catch-up payloads. The table's units are listings, so a repeated item appears
more than once. A/Codex has unstarted work in 30 wakes' reasons but no complete
`[task]` bullets; its task response rate cannot be inferred from zero bullets.

A/Claude lists 55 distinct asks, of which 17 occur on at least three wakes;
the maximum is 15 listings. A/Codex lists 20, of which 13 occur at least
three times; the maximum is 13. Repeated asks and unstarted-work reasons are
shared across engines even when their rendered item mixes differ.

### 2.4 Where the engines differ in this sample

| Behaviour | Claude | Codex |
| --- | --- | --- |
| Parking in A | 17 hold-only, 20 date-only and one mixed owed wake | One hold-only owed wake; repeated reads and annotations dominate |
| Repeated replies | A has 19 seat-authored replies repeated across three exact texts; three provider quota notices are excluded | No final reply repeats three times in any sampled group; changing wording still accompanies long unchanged runs |
| Repeated asks | A has 17 asks listed at least three times | A has 13; none of its 100 complete ask listings receives a direct targeted write in that wake |
| Recovery uncertainty | Some sends begin uncertain; original-key delivery records resolve several | Particularly visible in D; recovering those deliveries changes many apparent idle wakes into confirmed instructions |
| Mandate overreach | Successor work rejected by the operator; direct Git/forge repairs from the seat shell | Added an unnecessary login prerequisite in K, then removed it |
| Cadence in A | No cadence change across 295 wakes; two monitor-note edits, plus decision-log writes | No cadence change across 91 wakes; decision-log writes did not slow the tick |

An exact-text repetition detector would miss the Codex A runs. A detector
based on consequential state transitions covers both. A rule that treats all
holds as wrong would also misclassify legitimate external dependencies in
other projects.

## 3. The known case: November 12, 04:40–06:05 UTC

### 3.1 Per-wake evidence

Full autonomy was active, with a worker limit of 30. The directive lanes from
the preceding evening had merged by 04:22, apart from one parked on an
operator question. No other lane was running in this project during the
known idle window. The previous board-maintenance report counted 196 open
tasks, including 115 inbox tasks. A standing instruction visible in the wakes
called for filing and fixing accepted defects within the available capacity.

| Wake, UTC | Listed | Recorded outcome | Progress on listed work |
| --- | --- | --- | --- |
| 04:35, preceding boundary | Three unstarted tasks, two asks | Closed an already merged lane and marked its task done | Completion acknowledged; three unstarted tasks untouched |
| 04:47 | Research-lane ask, its thirteenth listing | Escalated to the operator | Handed over |
| 05:02 | Interval, two old-lane signals | Reads/reply | Neutral |
| 05:15 | One unstarted task, waiting 993 hours | One hold | None |
| 05:27 | Two unstarted tasks, retirement signal | Two holds | None |
| 05:40 | One unstarted task | One hold | None |
| 05:52 | Four unstarted tasks, repeated signal | Four holds and a new held defect task | None |
| 06:05 | One unstarted task | One hold | None |

Nine existing tasks and one new task were held. The existing tasks shared a
reason that treated an earlier pause as a blanket ban on new lanes and dated
it November 11. All ten lacked an expiry. The task holds were authored by the
seat, despite their operator-wait kind; that kind does not establish that the
operator set each hold.

The seven wakes from 04:47 through 06:05 contain 14 model requests, 5,504
output tokens and 4,339,994 input tokens. Measured from each wake timestamp
to its last assistant record, their durations are 9.073, 2.652, 7.560,
10.336, 8.540, 21.915 and 7.480 seconds: **median 8.540 seconds**.
Around 06:07 the operator intervened; at 06:08 the seat lifted four holds and
created six lanes. Those response timestamps explain the intervention and
are outside the measured idle window.

### 3.2 How the interpretation spread

On November 9 the seat launched nine successor lanes; the operator rejected
that expansion around 21:07. A subsequent form answer paused successor work
with named exceptions and requested watch/report behaviour while the
operator drove their own tasks. The persisted pause reason retained the time
of day without the date. The November 10 successor treated a brief request
to continue as insufficient to reverse the form answer.

By November 12 the seat read that earlier answer as a project-wide ban on
new lanes, including accepted unstarted tasks, and misdated it November 11.
The date loss is a plausible contributor; the records establish the missing
date and later misdating, without proving the model's internal cause.
A prose instruction passed through rotations without a machine-checkable
scope or release condition.

The 49-wake overnight run establishes silence in A until the operator's
09:06 answer. It establishes no wider operator inactivity: other project
transcripts contain operator messages and decisions during that run.
Whether the earlier activity-qualified instruction still applied therefore
remained ambiguous. Waiting at full cadence was observable independently.

### 3.3 Existing code that permits the loop

- `src/lib/orchestrator/prompt.ts:227` directs the seat to hold items it
  cannot complete, and describes the tick controls. The record shows two
  monitor-note changes during A/Claude, at 11-10 13:19 and 22:47; neither
  changes cadence. The latter shared a call with a decision-log write.
- `src/lib/monitor/seatTickReminders.ts:32` treats a noted, unexpired or
  open-ended hold as a blocker. Its unstarted filter at line 117 then omits
  the task. Holding each fresh page removes those tasks from future reminders.
- `src/lib/monitor/seatTickSources.ts:1749` includes hold and update time in
  the board fingerprint. `src/lib/monitor/seatTick.ts:1495` allows unseen
  pages through the retry guard, and line 1496 permits worker asks at their
  interval. Repeated parking and changing pages can keep producing wakes.
- `src/lib/monitor/seatTickReminders.ts:139` renders a pause reason without
  its persisted pause date. The later seat cannot date that reason from the
  reminder line alone.

## 4. Patterns, including the opposite failure

**Parking instead of starting.** A/Claude has 38 owed wakes whose only
consequential changes are task parking: 17 holds, 20 dates, one mixed.
A/Codex has one such wake. The Codex A failure usually preserves an existing
blocker and appends a fresh explanation instead of creating a new hold.
A hold can be warranted: a missing external reply, an explicit operator
pause, or a delivery whose original outcome is still unknown requires a
recorded stop. The failure is repeatedly waking for that same unresolved
condition without a next action or an adjusted schedule.

**Status as a substitute for action.** Claude A has verbatim repetitions.
Codex A varies its final wording while repeatedly reporting unchanged board
counts, retained blockers and no new launches. Its first run spends 38 wakes
rereading those states. Text similarity is useful audit evidence but is an
incomplete production signal.

**The same ask returns.** Both engines repeatedly receive parked asks.
One Claude ask appears 15 times over approximately 13.6 hours, including
three listings after its PR had merged through a batch. The research ask
appears 13 times over approximately 5.7 hours before escalation at 04:47.
Codex's repeated asks concern retained review and uncertain-launch blockers.
Retry-guard exemption makes recurrence possible; it proves no fault in a
particular hold. The seat still owes either a supported next action or an
explicit waiting policy.

**An instruction widens across rotations.** The known Claude case turns a
situational successor-lane pause into a general prohibition. Codex A also
carries earlier workspace and recovery restrictions through rotations;
this audit establishes repeated blocking decisions, without enough evidence
to declare those original restrictions revoked. The shared design need is
an instruction whose scope and release condition survive rotation.

**Waiting leaves cadence unchanged.** Neither engine's A wakes change the
tick interval or disable it. The existing retry fingerprint measures board
changes, including holds and annotations, rather than advancement of the
work presented by a wake.

**Old events return.** Fourteen Claude A replies between 11-09 12:34 and
11-11 13:55 identify already handled lane events. Codex E also receives
signals for historical lanes whose PRs are already merged. A prior issue,
#1285, concerns a historical terminal-event backlog. This report has not
proved that the two engines' examples share one cause.

**The opposite failure remains real.** Counting transitions must never
reward violating the operator's mandate:

| Kind and time, UTC | Observation | Assessment |
| --- | --- | --- |
| A / Claude, 11-09 daytime | Nine successor lanes, subsequently rejected by the operator | Scope expansion; the later correction then contributed to excessive waiting |
| A / Claude, 11-09 through 11-12 | Ten successful shell call invocations closing/reopening PRs, including paired close/reopen operations; other shell edits to PR metadata and successful check reruns | Crosses the seat's MCP-only operating boundary; ten counts invocations, not individual close/reopen operations |
| A / Claude, 11-11 19:17 | Shared-checkout backup ref written | Direct Git mutation outside that boundary |
| A / Claude, 11-12 01:45 | Merged main into a lane branch in a temporary checkout, then submitted its push | Successful local merge is a repair; a background push submission alone proves no remote publication |
| K / Codex, 11-09 11:00–11:31 | Added an authentication-only prerequisite to an authorized desktop-login stage; the worker showed that prerequisite could not precede the real connection; the seat removed it on the next ask wake | Extra requirement blocked the requested action; recorded movement includes imposing and undoing it |

No comparable confirmed Codex Git/forge mutation from its own shell was
found in the sampled wake turns. That bounded observation grants no broader
compliance verdict. The K example shows why a transition counter needs the
mandate alongside it: more transitions can represent avoidable rework.

**Adjacent failure: no landed wake.** At the common cutoff, B has 206
error/refused journal records among 211 records since 11-11 19:58, covering
209 distinct check IDs. D has 82 error records since 11-12 00:54. These use
a record denominator; a check and its landing can share a check ID. Such
failures belong to the silent-tick class tracked by #2695 and #3905. A seat
with no delivered turn cannot be assigned an idle-response outcome.

## 5. Proposals grounded in the current storage and write paths

### 5.1 Detector over records: retain the delivered baseline

The current `itemsShown` field is a cumulative cache of up to 2,000 recent
versions (`src/lib/monitor/types.ts:1161`). It cannot recover one wake's
items or their previous state. `seatTickWakeCommit`
(`src/lib/monitor/seatTick.ts:2254`) merges new versions into that cache and
clears `outstandingWake`. Adding a counter alone cannot supply the detector.

The smallest sufficient addition is one bounded assessment record per
project, plus a baseline attached to the outstanding wake:

1. **Preparation:** `seatTickWakeCommitPlan` at `seatTick.ts:2127` already
   determines which complete bullets survive the frozen-text bound. Preserve
   each owed item's kind, stable target, reason kind and pre-send fields
   beside that delivery plan: task status, ownership, hold and due date;
   lane stage/attempt/state; ask identity and escalation/answer state.
   Include the seat engine/epoch and original wake key. Versions alone are
   insufficient. Preserve these fields unchanged on retries.
2. **Landing:** `seatTickWakeCommit` retains the visible baseline before
   clearing the outstanding wake, using the complete-bullet visibility
   filtering at `seatTick.ts:2433`. A send refused before delivery earns no
   assessment. An uncertain landing remains unknown until the original
   delivery settles. Capture the baseline before sending: seat actions can
   precede the journal's landing by roughly two minutes.
3. **Assessment:** after the seat turn settles, compare those targets with
   current task, lane, ask and delivery records. Resolve through existing
   operation receipts. Read held/done targets by their retained IDs even
   after they disappear from the open agenda. Missing rows or unreadable
   evidence are unknown; disappearing from the agenda proves no advance.
4. **Retention:** keep the outstanding baseline and the last delivered
   assessment until evaluated, then retain only its bounded summary and
   counters. Use a fixed maximum of 256 item references for assessment;
   oversized catch-up deliveries are marked incomplete and cannot increment
   or reset the counter. The normal page default is five items
   (`seatTick.ts:146`); catch-up payloads can exceed it. Rotation preserves
   project-level counts and records the new epoch. The tick controller owns
   this state; no transcript scan, whole-store read or unbounded history is
   added to each check.

Classify a retained item as advanced, handed over, parked, unchanged or
unknown. Lane admission, a real stage/attempt transition, task completion or
a confirmed answer is advance. Hold/date-only changes are parking. A recorded
escalation is handover. An unrelated note, a replayed receipt and a refused
retry earn no advance. Preserve legitimate hold reasons for the operator's
interpretation. A recorded external dependency can explain a no-advance run
without granting the detector authority to release it.

An assessment with any advanced owed item resets `wakesWithoutAdvance`.
All parked/unchanged items increment it; handover-only assessments neither
increment nor reset it. Unknown or incomplete assessments freeze the count
and show an evidence-gap label. A new operator message resets the run.
Only an effective cadence/autonomy change resets policy state; annotation
or decision-log writes cannot erase the detector's history. Record the wake
key already assessed so repeated checks cannot increment it twice.

At three, use the existing `SeatTickCard` path with a proposed `no-advance`
kind. Show the run length, parking/unchanged counts, reasons, engine,
autonomy, available worker slots and the recorded blockers. It is advisory
and refuses no operation. Preserve the current retry guard: its different
fingerprint semantics protect against repeated unchanged reasons.

**Known-case replay:** assess the 05:15, 05:27 and 05:40 wakes after their
turns. All four listed tasks become held with no lane; count three is visible
at the 05:42 check. The earlier handover does not increment it. For Codex A,
the first three wakes at 00:09, 00:16 and 00:26 show no owed advancement;
the next completed assessment would display the same card. Exact historical
check timing for that earlier period is outside the retained journal ring.

### 5.2 Tick behaviour: require an explicit waiting policy

At count three, the next wake states the run and asks the seat to choose
within its existing authority: advance an accepted item within capacity, or
set the tick's waiting policy with a reason and release/recheck condition.
It cannot treat this instruction as permission to release an operator pause,
repeat an uncertain send under a new key or invent additional work.

`seat_tick_settings` already supports `untilMinutes`, `wakeIntervalMinutes`
and `enabled: false`. Non-default settings require a reason; omitted
`untilMinutes` leaves them in force until explicitly changed. Disabling the
tick also ends an active autonomy episode
(`src/lib/monitor/seatTickSettings.ts:752`); re-enabling the tick does not
restore that episode. Prefer bounded slower cadence when preserving autonomy
is intended, and read the effective settings back. A bounded delay needs a
recheck time. Waiting for an operator return also needs a defined wake path:
an operator message still
reaches the conversation, and that turn must re-enable a tick it disabled.
A disabled tick sends no return-triggered wake by itself. Persist that obligation
with the waiting reason so rotation carries it forward; merely promising an
automatic return-triggered wake overstates the existing controls.

If count six is reached and no explicit waiting policy has been chosen,
back off only repeated unchanged/parking reminders of the involved kinds.
Double the interval per further assessment, capped at two hours, and put the
reason in the card and next wake. Apply it to new pages of the same reason
kind too. New lifecycle settlements, a permission request, a delivery outcome
or another changed actionable item keep their normal urgency. An operator
message, real advancement or explicit effective cadence choice clears the
backoff. Decisions and delivery uncertainty retain their original guards.

**Known case:** the first reminder would be in the 05:52 wake; the sixth
count is not reached before the operator intervenes. **Codex A:** the first
38-wake run would trip the card and later backoff despite its varied reply
text and few new holds. **Claude overnight:** the 49-wake run likewise trips
both. Exact counterfactual wake savings require a scheduler replay with the
above exceptions; the earlier claim of six remaining wakes is withdrawn.

### 5.3 Rule changes within the existing controls

1. **Accepted work and scope:** distinguish accepted tasks from proposed
   successor work in the autonomy overlay and seat mandate. The operator
   chooses the authority and exceptions; the seat may execute accepted work
   within them and propose new outcomes. A pause records its date, affected
   items, allowed actions and release condition. A scope change requires the
   operator's authority; an idle detector cannot broaden it.
2. **A wait has an observable end:** use `postponed` or `limit` with `until`
   for timed waits. `src/lib/tasks/hold.ts:31` preserves expiry only for
   those kinds; operator/external holds discard it. For an external or
   operator wait, name the dependency and put the recheck in the tick's
   waiting policy. Verify the stored hold after writing it. A blanket demand
   for `until` on every existing hold kind would fail today.
3. **Waiting changes scheduling in the same turn:** when the seat decides
   all permitted work must wait, it records that condition and sets cadence
   or suspension. Reports and new holds alone do not discharge this duty.
4. **No invented prerequisites:** an implementation precaution that blocks
   an already authorized action needs evidence of necessity or an operator
   decision. K's authentication-only requirement would have failed this
   check before it was added; protection of other sessions remained valid.
5. **Date the reminder:** render the existing pause timestamp beside the
   reason, and retain the original instruction date through rotations.
   The known case would have displayed November 9 rather than allowing a
   dateless reason to be interpreted as a November 11 instruction.

### 5.4 Acceptance for a future implementation

| Case | Required observation |
| --- | --- |
| Known Claude hold sequence | Card after three assessed wakes/four parked tasks at approximately 05:42; next wake states both choices |
| Codex A blocker/status sequence | Three unchanged owed assessments trip the same card despite unique prose and no new holds |
| Hold followed by form publication or lane closure | Outcome records both effects; never mislabelled hold-only |
| Refused retry and lost send answer | Refusal earns no advance; original-key confirmed delivery earns it; unresolved delivery freezes assessment |
| Successful check rerun or local merge | Audit recognises the actual repair while separately marking the seat's authority violation |
| Cumulative cache, rotation and a second page | Compare only retained delivered items; previous pages and note writes cannot reset the count |
| Action before landing, crash/retry and duplicate check | Frozen pre-send baseline survives; credit/increment once per original wake |
| Held/done item leaves the open list | Fetch its retained target; disappearance alone never earns progress |
| Oversized catch-up or unreadable source | Incomplete/unknown label; bounded storage and no fabricated verdict |
| Valid operator/external hold | Preserve the pause, explain dependency and change waiting policy; no forced launch |
| New urgent event during backoff | Lifecycle/permission/delivery change still wakes normally |
| Tick disabled while waiting | Later operator turn restores ticking explicitly; autonomy stays ended unless explicitly authorized again; rotation retains the obligation |
| K's added prerequisite | Keep the authorized requested action possible; prevent the extra blocking condition |

### 5.5 Smaller investigations

A merged PR left a merge-stopped ask visible for hours; reconcile the lane's
stored merge/closure evidence before repeating the ask. Old events appeared
again after rotations; reproduce the epoch/acknowledgement path on each
engine before attributing a shared cause. Both findings justify narrow
investigation, with no implementation prescribed by this report.

## 6. Choices when implementation is scheduled

These choices do not block the read-only analysis.

- **Thresholds:** recommend a card at three assessed no-advance wakes,
  backoff from six, capped at two hours. Treat unknowns separately.
- **Activity-qualified operator instructions:** recommend keeping an explicit
  pause until the operator releases it, with an explicit waiting policy.
  Automatically expiring it after an assumed absence risks unauthorized work;
  project-local silence cannot establish that absence.
- **Direct repairs:** recommend a bounded worker/merger role for Git and
  forge repairs, with board evidence. The seat remains inside its stated
  tool boundary. Git-only repositories need equivalent local task/lane
  transitions; missing GitHub access must not block the detector.

## 7. Deferred — not currently justified

- A model judging every reply: record comparisons cover both engines and
  avoid making prose similarity the criterion.
- Automatically releasing holds, rejecting writes, or launching tasks from
  the tick: those would add authority the requirement does not grant.
- Historical claims beyond the common window, and behaviour in the two
  unavailable transcripts: the present census names those limits.
- Monetary-cost estimates or an engine ranking: native usage and differing
  mandates do not support either.
- Fixing quota/check failures themselves: their detection is adjacent;
  #2695 and #3905 track the silent-tick class.
- An exact claim about saved wakes under backoff: needs the actual scheduler
  replay and event/unknown-outcome exceptions.

Codex is included in the analysis and is no longer deferred.

## 8. Corrections and reproducibility

The check stage's findings were applied together with the engine extension:

| Earlier defect | Correction |
| --- | --- |
| Attempts counted as success; uncertain sends counted as advances; successful check reruns missed | Inspect outcomes, no-op/replay fields, original-key delivery records and shell results; regenerate the partition and runs |
| Inputs cut at 600 characters | Retain complete structured arguments and targets; regenerate item tables; ten successful close/reopen shell invocations |
| Hold-only mixed with forms/closures; reads classified as bookkeeping | Exclusive partition in 1.4, applied before generating tables |
| Cumulative `itemsShown` treated as a per-wake baseline | Explicit preparation, landing, retained fields and bounded assessment in 5.1 |
| Autonomy undercount | A/Claude 295, B/Claude 38; A/Codex 91 |
| Known-case median reported as 37 seconds | Seven timestamp deltas, median 8.540 seconds |
| Journal totals beyond the stated cutoff; records confused with checks | Exclusive 06:10 cutoff; B 206/211 records, 209 check IDs; D 82 error records |
| One monitor-note change claimed | Two, counted field by field even when sharing a decision-log write |
| Operator inactivity inferred globally | Limit the observation to silence in A; other projects contain contemporaneous operator activity |

To reproduce without executing transcript content:

1. Read current and revoked seat records. Select ownership intervals
   overlapping the common window; enumerate engines before opening paths.
   Resolve aliases within each project and deduplicate conversation paths.
   Include missing and zero-wake histories in the coverage inventory.
2. Parse native message records, removing only the structured transport
   marker. Recognise both tick-header forms and join journal epochs to seat
   engines. Ignore duplicate Codex `event_msg` message copies.
3. Assign tool calls/results and replies to the next non-tool-result user
   boundary. Preserve complete arguments. Statically inspect nested Codex
   tool calls; do not evaluate their JavaScript. Recover projected replies
   through exact original receipt keys and timestamped delivery records.
4. Apply 1.4. For the item table, match complete visible bullets of the form
   `- [task]` or `- [ask]`, a full target ID and the separator, to structured
   mutation targets. Count each listing, retaining catch-up bullets. Validate
   partition sums per project and engine before computing totals and runs.
5. Derive Claude usage once per message ID and Codex usage from changed
   cumulative input/output totals, subtracting the preceding snapshot.
   Measure durations from the wake to its last assistant record. Match
   journal timestamps to checks; do not count a delivery row as another
   independent check.
6. Apply the public-text scan to the whole document. Keep private target and
   transcript identifiers out of the published report.

Validation: the nine project/engine outcome partitions reproduce from the
read-only extraction and sum to their denominators. The known-case hold
sequence, refused retry, successful check rerun, mixed form/hold wake and
unresolved sends were checked separately. Whole-document manual privacy
review and the repository privacy-publication gate passed in isolated
scratch. No runtime test or build was run for this document-only change.
