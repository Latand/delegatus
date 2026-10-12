Originating requirement. Operator, 2026-10-12 about 05:40 UTC, chat to the orchestrator seat, Russian, verbatim:

> Проверь агентов: может, другие стоят. Если хоть одно подтвердится, что они стоят, а ты не в курсе, это нужно исправлять, чтобы ты всегда был в курсе, когда они стоят. Каким-то простым инструментом. Чтобы я понимал, когда они стоят, когда не стоят. Реально. По активности.

The observed defect pinned with the task (2026-10-12 05:45:29Z, `agent_activity`
liveOnly compact): the answer carried `catalog:"stale"`, `evidence:"pending"`,
`unverifiedCount:19` and seven `stalled` rows. `conversation_4440e2e0` (lane
82239c67 refresh) read `silentForMs 17,482,029`, stalled, while its transcript's
newest record was a tool call at 05:45:19Z; `conversation_d3242679` (lane
9cc08503 refresh) read 17,479,455, stalled, newest record 05:45:19Z; the seat
itself read busy/stalled 17,466,497 while it was working. Several working agents
sat in 50–55 s sleep/wait loops on long checks.

# Agent activity tells the truth: working, waiting on a check, or idle N minutes

Written against `main` at `a8e005428`. Every file:line below is on that commit.

## Summary

| Question | Answer |
| --- | --- |
| Why 4.8 h? | The seat's MCP server process last refreshed its in-memory catalog on its previous `agent_activity` call at 00:54:06Z. At 05:45:28Z the catalog wait ran past its 650 ms budget, so the rows came from that 00:54 catalog, and the 800 ms answer budget was spent before the tail reads started, so **19 rows, every stalled one among them, had no transcript tail read**. Silence fell back to the catalog row's file mtime: 05:45:29Z − 00:54:07Z = 17,482 s. A live host plus a busy turn plus silence over ten minutes is `stalled`. |
| Codex rotation? | Not the cause here: both named rollouts were the files their hosts were writing. A rotated rollout or a resumed session can still produce the same kind of false stall through the old file's catalog row (§1.5), so the fix covers it. |
| A second false stall on the board | The scanner calls any open turn whose file has been quiet for 180 s `stalled` (`activity.ts:442-446`). The card's «ПРАЦЮЄ» badge then disappears and the phone row turns red, under every agent running a check longer than three minutes. |
| Fix | (1) Silence and the stall verdict come only from a tail read in this call. A row without one says `unverified` and never `stalled`. (2) Tails of the hosts the registry names are read in parallel with the catalog wait, so a slow catalog no longer costs running agents their verification. (3) One conversation, one row, read from the file its host is writing. (4) One shared classifier gives each running agent one of three states. The card, the phone row, `agent_activity` and the seat tick all use it. (5) The seat tick wakes the seat on a verified «стоїть» of 10 min or more. |
| Verdict | pass. No question changes the design; the thresholds come from the operator's own words and the pinned acceptance. |

## Was this solved before?

`search_memory` found the seat's own note from the same morning
(`agent-activity-stale-verify-tail`): "agent_activity can report false
multi-hour stalls (catalog stale / evidence pending); verify idleness by the
transcript tail". It names the symptom and gives no cause. `search_transcripts`
(project scope) for "agent_activity catalog stale false stalled projection" and
"waiting on a check sleep loop agent idle seat wake" found the 2026-10-03 lane
that bounded catalog membership refreshes (PR #2491), which explains why an MCP
process refreshes its catalog only when called, and the #860 work that
introduced the answer budget (`liveness.ts` header comments). Nobody had
connected the two. No earlier design proposed a three-state activity model.

## 1. The cause, with evidence

### 1.1 What happened in the seat's process

`agent_activity` runs inside the agent's own MCP server process
(`src/lib/mcp/bindings.ts:6201`, sources from `productionLivenessSources`,
`bindings.ts:1288`). Every agent session has its own MCP process, and that
process holds its own scanner catalog slot (`globalFileScanSlot`, `scanCache.ts:795`).

1. The slot refreshes only when someone in that process reads it.
   `completedFileScan` (`scanCache.ts:1015-1041`) returns the slot's snapshot
   and, if five minutes have passed, starts a deferred background scan. An MCP
   process that nobody calls never refreshes anything.
2. The seat's MCP log (`~/.cache/claude-cli-nodejs/<seat cwd>/mcp-logs-viewer/`,
   session started 2026-10-11 19:37Z) shows `agent_activity` at
   21:59:38Z, at **00:54:06Z**, and next at **05:45:28Z**. Nothing else in that
   process read the catalog in between.
3. At 05:45:28Z the read waited on catalog membership
   (`scanCache.ts:1023`). New transcripts had appeared since 00:54, so it most
   likely joined a full-corpus scan, which takes seconds. The answer's
   `catalog:"stale"` is set only on the budget path, so the 650 ms catalog
   budget (`bindings.ts:6195`) did run out, and `completedGenerationSelection` answered
   from `lastScannedFiles()` (`inventorySelection.ts:218-224`): the 00:54 rows,
   labelled `stale`.
4. The answer budget of 800 ms (`bindings.ts:6199`, `6232`) is one clock for the
   whole call (`answerBudget`, `liveness.ts:868-898`, started in `agentLivenessSnapshot`). The registry read and host probes
   (`liveness.ts:1008-1015`) plus the 650 ms catalog wait used it up, so the
   tail reads returned before they started: `if (answer.spent()) return
   ANSWER_SPENT;` (`liveness.ts:1140`). The answer counted 19 such rows
   (`unverifiedCount`), each `evidenceSource:"projection"`.
5. With no tail, silence is the catalog row's mtime:
   `const lastRecordMs = evidence?.lastRecordTs ?? entry.mtimeMs`
   (`liveness.ts:1199`). For an agent that was writing at 00:54, that mtime is
   about 00:54:07Z. 05:45:29Z − 00:54:07Z = 17,482 s, the number in the report;
   the seat's own row (17,466 s) is its transcript's mtime at the same scan.
6. The turn state for a projected row is the catalog's `jsonl_turn_open`, so
   `busy` (`turnStateFromEvidence`, `liveness.ts:546-554`). `evaluateLiveness` then returns `stalled`
   for a live host, a busy turn and silence over ten minutes
   (`liveness.ts:604`, `636`).

The answer said `evidence:"pending"` at the top, but the compact rows
(`compactAnswers.ts:259-280`) carry `lifecycle:"stalled"` and no marker of
their own, so the reader saw seven confirmed-looking stalls.

### 1.2 Reproduced live, read-only

A fresh `agent_activity` call from this stage's own MCP process at 05:49:24Z
answered `catalog:"stale"`, `inventorySelectionMs 664`, `evidenceReadMs 0.76`,
`hydrated 0`, `projected 30` for 30 of 30 rows. Its silences looked correct
only because this process had loaded the catalog the Viewer had persisted a few
seconds earlier. The mechanism is the same; the error is the age of the
process's last catalog. The two named lanes, read the same minute: lane 82239c67's
rollout ends in a Codex `sleep {"duration_ms":50000}` call at 05:51:17Z after
a poll of the pre-push privacy gate, which had been running for 34 minutes as a
descendant of the agent's host process. That agent was waiting on a check.

### 1.3 Reproduced in isolation

A scratch test in the stage's temporary directory, run against an export of
`a8e005428` under isolated HOME, XDG, TMPDIR and `LLV_STATE_DIR`, drove the real
`agentLivenessSnapshot` with one live structured host, a `stale` catalog row
whose mtime is 17,482,029 ms old, a catalog wait of 850 ms (the 650 ms budget
plus the registry read), `answerBudgetMs: 800`, and a tail whose newest record
is 10 s old. The answer:

```
{"lifecycle":"stalled","reason":"host_alive_transcript_silent","silentForMs":17482029,
 "evidenceSource":"projection","tailReads":0,"hydrated":0,"projected":1,"cacheStatus":"stale"}
```

The tail was never opened. With a 700 ms wait the same fixture reads the tail
in the remaining 100 ms and answers `running`, `silentForMs 10000`: the
verdict depends on whether the catalog wait leaves any budget, which is why
the same tool looked right on some calls and wrong on others.

### 1.4 The board's version

The board reads the Viewer's catalog, which is fresh, so it never showed 4.8 h.
It has its own false stall instead: `activityVerdict` calls a busy turn
`stalled` once the file has been quiet for 180 s (`activity.ts:442-446`).
`turnIsRunning` requires `activity === "live"` (`turnDuration.ts:44-46`), so
the card's «ПРАЦЮЄ N хв» badge (`cardStatus.ts:42-48`) vanishes, and
`stalledAttention` (`attention.ts:105-109`) paints the phone row red
(`mobileBoardModel.ts:156`). A Claude agent inside one long `bun test` writes
nothing until the command returns, so the board calls it stalled after three
minutes.

### 1.5 Rotation and resume, checked

The pinned candidates were checked against the code. A conversation's rows
come from catalog rows keyed by transcript path. When a Codex rollout rotates or
a Claude session resumes into a new file, the registry appends a generation
(`registry.ts:6475`, `6513`) and the host entry's `artifactPath` names the new
file. The old file's catalog row is still in the catalog with its open turn, no
host matches it (`entryForPath`, `liveness.ts:467`), and once the grace has
passed it reads `stalled` with reason `launch_unproven_expired`
(`liveness.ts:617-618`), even with its tail verified. This did not cause the
reported rows. It is the same kind of false stall, so the fix covers it (§2.3).

## 2. The fix

Five changes, each small. Nothing new is persisted. The vocabulary in
`src/lib/lifecycle/vocabulary.ts` keeps its eight states.

### 2.1 No stall without a tail read

`liveness.ts:1199` stops falling back to the catalog's mtime. A row whose tail
was not read in this call, or whose tail could not be used, has:

- `silentForMs: null`, `stalledForMs: null`;
- `verified: false` (new field; `evidenceSource` stays for the full answer);
- `evaluateLiveness` called with `silentForMs: null` and a new flag
  `turnVerified: false`. A live host then gives `running` with reason
  `evidence_unverified`, never `stalled`. A dead host gives `gone` with reason
  `host_gone_turn_unverified`: the host's death is a verified process fact, but
  whether the turn was open is not. (The seat tick treats `stalled` and `gone`
  alike, so no wake is lost; §4.)
- `launch_unproven_expired` needs a verified tail too. Without one, the row is
  `starting` inside the grace and `gone` after it.

The compact row adds `verified` and drops `silentForMs` when it is false, so
a reader cannot take a projected number for a measured one. `stalledCount`
counts only verified stalls; `stalledConfirmedCount` becomes an alias and is
documented as such.

### 2.2 Running agents always get their tail

Today, tail reads start after the catalog wait. The hosts the registry names
(`hostedPaths`, `liveness.ts:1009-1013`) are known before the catalog is
read, and a running agent's file does not depend on the catalog. The change
is in `livenessSnapshotWithin`: after the hosted set is built, describe each
hosted path (one `stat`, `describeTranscriptPath`) and start its tail read at
once, **concurrently** with `selectInventory`. When the catalog answers, its
rows are matched to the tails already in flight by path; catalog-only rows
(not hosted) are read afterwards under the remaining budget as today. The
carried-evidence map (`liveness.ts:904-934`) is unchanged and still lets a
later call take a slow read.

Cost: one `stat` and one bounded tail (128 KiB) per running agent, at the
existing concurrency of 4; in the live read above that is 30 tails. They start
right after the registry read, so they get the time the catalog wait used to
take. In that call the registry read and the row projection together took
503 ms (`journalProjectionMs`), so the tails would have had roughly 300 ms; a
tail that misses the budget is `verified:false` under §2.1 and its read is
carried to the next call. The catalog budget stays at 650 ms. If the build
measures hosted tails missing the budget on a busy machine, the fix is to
exclude the catalog wait from the answer budget for liveOnly reads, which the
test in §5 measures.

### 2.3 One conversation, one row, from the file its host writes

For each selected row, resolve the conversation (`conversationIdForPath`,
`liveness.ts:739`) and its **writer path**: the newest file by `stat` among
the live host entry's `artifactPath`, the conversation's generations and its
`continuityPaths`. The newest record is the question, so one rule covers a
host entry that has not caught up with a new file yet. Rows of the same
conversation fold into one row for the writer path; the folded paths are
listed in the full answer as `previousPaths`. A targeted call by
`conversationId` uses the same resolution in place of
`generations.at(-1).path` (`liveness.ts:1027`). That handles a rotated Codex
rollout and a resumed Claude session the same way, and removes the old-file
`launch_unproven_expired` rows of §1.5.

### 2.4 One classifier for the three states

A new pure module, `src/lib/lifecycle/agentActivity.ts`, exports
`classifyAgentActivity(facts, nowMs)`. The facts it reads:

| Fact | Source |
| --- | --- |
| `lastRecordAt` | newest record timestamp in the tail read (`newestRecordTimestamp`, `transcript.ts:72`) |
| `openCall` | the newest tool call in the tail without its result: Claude `tool_use` without a matching `tool_result`; Codex `function_call` / `custom_tool_call` without its `*_output` |
| `recentWait` | the newest completed tool call, if it was wait-shaped and finished less than 3 min ago (the gap between two iterations of a sleep loop) |
| `background` | Claude background tasks still pending, from the existing ledger (`foldBackgroundTaskRecords` and `pendingBackgroundTasks`, `src/lib/pipelines/backgroundTasks.ts:250`, `267`) |
| `workProcesses` | live descendants of the host process whose start time is after the open turn's first record, from `procBackend.ppidMap()` and `descendantPids` (`src/lib/proc/memory.ts:104`). Both engines start their MCP servers as direct children before the first turn (observed: the Claude seat's server started with its engine; a Codex app-server's `bin/mcp-server.mjs` is its direct child), so the start-time rule leaves them out without reading any engine configuration. |

A call is **wait-shaped** when it is the Codex `sleep` tool, a Codex
`write_stdin` with no input (polling a running exec session), a Claude
`Monitor` or blocking `TaskOutput`, or a shell command whose text is a sleep or
a watch: `sleep N`, `until …; do … sleep`, `while … sleep`, `wait`,
`gh pr checks --watch`, `gh run watch`, `tail -f`.

The states, first match wins. They apply only to a running agent: a live host
and a turn that is not settled.

| State | Ukrainian label | Rule |
| --- | --- | --- |
| `checking` | «чекає перевірку · {check}» | `openCall` is wait-shaped, or `recentWait`, or `background` is not empty, or a work process has been running for 30 s or more (a one-second `rg` is not a check) |
| `idle` | «стоїть {N} хв» | none of the above, and `now − lastRecordAt ≥ 10 min` |
| `working` | «працює» | otherwise: a record within the last 10 min |

`{check}` names what is being waited on, in this order: the longest-running
work process's command reduced to its script or binary and first argument
(`bun scripts/privacy-publication-gate.ts …` → `privacy-publication-gate`;
`bun test src/lib/x.test.ts` → `bun test x.test.ts`), else the background
task's description, else the open call's own command clipped to 40 characters.
With nothing to name it reads «чекає перевірку».

`N` is whole minutes since `lastRecordAt`. An agent whose turn is settled and
whose host is alive keeps today's reading (`waiting`,
`host_alive_turn_idle`); a pending permission request keeps «потребує вас»; a
provider retry keeps its limit chip. A dead host keeps today's `killed`
reading. None of those are new.

Ten minutes is the operator's number. It is safe because a long check is no
longer silence: it shows as `checking` through its process or its sleep loop.

`AgentLivenessRecord` gains `activity: { state, check, idleForMs }` for
running rows with `verified: true`, and the compact row carries it.

### 2.5 The scanner gives the board the same facts

The board's card and phone row read `FileEntry` from the Viewer's scan, so the
scanner computes the same facts during enrichment
(`src/lib/scanner/observe.ts`), from the tail it already reads for
`transcriptTurnResult` and the process table it already holds, below the pid it
assigns to the entry (`FileEntry.pid`), for entries with `proc === "running"`
and an open turn. `FileEntry` gains
`agentActivity?: { lastRecordAt, check, checking }`. The client calls
`classifyAgentActivity` with its own clock, so «стоїть» appears when ten
minutes pass with no new scan. Any new record changes the file and triggers a
scan. The dot subscribes to the existing shared 30-second board clock, so an
unchanged row reaches idle without a parent rerender or another transcript poll.

`activityVerdict` keeps its 180 s `stalled` value for the catalog (other
readers use it), but two board readers stop treating it as a stall:

- `turnIsRunning` (`turnDuration.ts:44-46`) becomes "the turn is open on a
  running host" (`turnLeftOpen(file) && file.proc === "running"`), so the card
  badge stays through a long check;
- `stalledAttention` (`attention.ts:105-109`) becomes
  `classifyAgentActivity(...).state === "idle"`.

The working counts (`isWorkingAgent`, `workingAgents.ts:27-31`) count `working` and `checking`;
an `idle` agent is not working.

## 3. Where it shows

The operator's prototype decision on 2026-10-12 replaces the proposed
text badge with a small dot in the existing row. No new panel or status row.
`CardStatusBadge` renders running activity as an 8 px dot: green for working,
amber for a check, red for verified idle after 10 minutes. The dot has no
visible text, border or pill padding. Existing attention and delivery badges
keep their own behaviour.

Desktop hover or keyboard focus, and phone tap, open the existing portalled
`TooltipBubble`, anchored to the dot. It flips or shifts inside the viewport,
clears on Escape or an outside press, and changes neither row geometry nor
scroll dimensions. The phone puts the dot beside the title in its existing
row. The dot's accessible label carries the same short text as the popover.

The popover has at most two short lines: working; checking with the minutes
since the last record and an optional short plain check name; or idle minutes
and the last action's local HH:MM time, using h23. Arbitrary background-task
text, identifiers and paths do not appear. The check's complete name remains
in the tool's activity facts. The phone's `stalled` classification still uses
record age for idle, but the row renders that state through the dot. Activity
text does not duplicate in the plan/goal meta line.

The en and uk keys cover checking, idle, minutes and the last action.

`agent_activity` compact rows carry the same `activity` object, so the seat
and the operator read the same words.

## 4. The seat-tick wake rule

The tick runs in the Viewer process (`seatTickSources.ts:690-699`), with a
fresh catalog and no answer budget, so its rows are verified except a tail that
cannot be read.

New rule in `stalledLanes` and `stalledChildren` (`seatTick.ts:404`, `438`): a
lane whose current stage conversation, or a running child, has a verified
`activity.state === "idle"` produces a wake item of kind `stalled`, labelled
«{title} — стоїть {N} хв: no transcript record since {HH:MM} and no running
process». Its `stallToken` is `conversationId@lastRecordAt`, so one idle
stretch wakes the seat once, and a later stretch after new activity wakes it
again.

- The item is due at the **first** sighting. The second-sighting rule
  (`seatTick.ts:1216-1219`) existed because a projected silence could be one
  scan old. A verified ten-minute silence is already a persisted observation;
  waiting for the next check would make it up to fifteen.
- `checking` never produces an item, however long. `unverified` never produces
  an item.
- The tick's default `stallAfterMs` drops from 40 to 10 minutes
  (`seatTick.ts:142`) and now means the idle threshold;
  `LLV_SEAT_TICK_STALL_MINUTES` still overrides it.
- Dead hosts keep their existing path (`stalled`/`gone` from the registry), and
  so does the seat's own stall check (`seatStalled`, `seatTickSources.ts:1447`).

With the tick checking every five minutes, the seat learns of an idle agent
between 10 and 15 minutes after its last record.

## 5. Tests

Each runs by path through `scripts/gate-slot.sh bun test <file>` with an
isolated HOME, XDG_CONFIG_HOME, TMPDIR, `CLAUDE_CODE_TMPDIR`, `LLV_STATE_DIR`
and `LLV_VIEWER_CONTROL_URL` pointing at a closed port. None touches the live
registry.

| File | Case | Red on `a8e005428` |
| --- | --- | --- |
| `src/lib/lifecycle/liveness.test.ts` | **The 4.8 h regression.** A stale catalog row for a hosted Codex rollout with mtime 17,482,029 ms old, `selectInventory` answering after 850 ms, `answerBudgetMs: 800`, the tail's newest record 10 s old. Expect `running`, `verified:true`, `silentForMs` 10,000. | Today: `stalled`, `silentForMs` 17,482,029, `projection`. |
| same | The same with the tail read held past the budget. Expect `running`, reason `evidence_unverified`, `silentForMs:null`, `stalledCount 0`. | `stalled`. |
| same | **Rotated Codex rollout.** Generations [rollout one (ends mid-turn, 5 h old), rollout two (record 20 s ago)], host entry on rollout two, both in the catalog. Expect one row for the conversation on rollout two, `working`, rollout one in `previousPaths`. | Two rows; rollout one `stalled launch_unproven_expired`. |
| same | **Resumed Claude session.** Two Claude session files in the conversation's generations, the host entry still naming the old one, the new one newer by `stat` with a record 15 s old. Expect one row on the new file, `working`. | The old file's silence: `stalled`. |
| same | **Dead host.** Host pid gone, verified open turn: `stalled host_gone_turn_open` (unchanged). Same with the tail unreadable: `gone host_gone_turn_unverified`. | The second reads `stalled`. |
| `src/lib/lifecycle/agentActivity.test.ts` (new) | **Sleep loop.** Codex tail ending in an open `sleep {"duration_ms":50000}` → `checking`; the same after its output with the next poll 20 s later → `checking` (`recentWait`); Claude `Bash` open with `sleep 55 && gh pr checks 1 --watch` → `checking`. A descendant `bun scripts/privacy-publication-gate.ts` names the check `privacy-publication-gate`. | New module. |
| same | **Real idle agent.** Open turn, newest record 11 min ago, no open call, no descendants → `idle`, 11 min. At 9 min → `working`. An MCP server descendant started before the turn does not count as work. | New module. |
| `src/lib/monitor/seatTick.test.ts` | A lane whose stage row is `idle` 11 min, verified → one `stalled` item on the first check; the next check with the same `lastRecordAt` adds none; `checking` for 60 min → none; `unverified` → none. | No item before 40 min plus a second check. |
| `src/lib/mcp/` agent_activity test beside the existing one | Compact rows carry `verified` and `activity`; a projected row has no `silentForMs`. | Fields absent. |
| `src/components/cardStatus.test.ts` | An open turn on a running host, file quiet 5 min with a live check → `running` with `activity.state "checking"`; quiet 12 min with nothing running → `idle`. The short dot popover text in en and uk. | Today: `null` (badge gone) after 180 s. |
| `src/components/mobile/mobileBoardModel.test.ts` | The phone row is `stalled` only for `idle`; a 5-min check reads `working`, and its check detail appears only in the dot popover. | Today: `stalled` after 180 s. |

Rendered evidence goes through the existing drivers, as AGENTS.md requires:
one `describe` block in `src/components/kanban/kanbanBoard.browser.test.tsx`
over `issue1695Evidence.fixture.tsx` with three cards (working, checking with a
long check name, idle 14 min) at 1440 and 1000 px, and one case in
`src/components/mobile/issue1671Evidence.browser.test.tsx` at 390 px. Measure
that the dot is 8 px, its short popover is portalled inside the viewport,
and opening it changes neither the row height nor page scroll dimensions.

## 6. Validation against the requirement

- «чтобы ты всегда был в курсе, когда они стоят» — §4: a verified idle agent
  wakes the seat within 10–15 minutes without anyone asking.
- «Каким-то простым инструментом» — no new tool and no new panel: the
  existing row carries a small dot; its popover, `agent_activity` row and
  seat-tick item explain the same measured state.
- «Чтобы я понимал, когда они стоят, когда не стоят. Реально. По активности.» —
  §2.1–2.3: the word comes from the transcript's newest record and the host's
  running processes, read at the moment of asking. A number that was not
  measured is not shown.

## Deferred — not currently justified

- **Refreshing an MCP process's catalog from the Viewer's persisted snapshot.**
  The Viewer writes `files-scan-snapshot.json` every few seconds (it was 10 s
  old during this investigation); an idle MCP process keeps its own copy from
  its last call. Adopting the newer file in the stale branch would make
  `catalog:"stale"` rarer. After §2.1–2.2 that age no longer reaches any
  running agent's state, so it would only freshen titles and non-hosted rows.
- **Waking the seat on a check that runs too long.** `checking` for an hour is
  visible on the card with its name; nothing in the requirement asks for a
  wake, and a threshold for "too long" depends on the check.
- **Showing activity for agents outside a running turn** (settled turns,
  subagents, shell tasks). They are not running agents; their current readings
  stay.
- **Telling an MCP server restarted mid-turn from a check.** Such a server
  starts after the turn began, so the agent reads «чекає перевірку · mcp-server»
  until the turn ends. The name shows what it is, and restarts mid-turn are
  rare; reading each engine's server list (a `--mcp-config` file for Claude,
  `config.toml` under `CODEX_HOME` for Codex) is machinery for that edge.
- **A fourth display state for `unverified` on the board.** The Viewer reads
  every tail it shows, so the board never sees one; it exists only in
  `agent_activity` answers.


## Implementation verification notes

The activity tool uses the existing Claude background ledger with a
768 KiB read cap (plus the bounded transcript tail). The Viewer scan enriches live hosts through that reader
without the tool deadline, before publishing their facts. Each bounded tool
observation advances the complete-line
cursor; an incomplete prefix cannot prove that background work ended. A quiet
live turn with that evidence unresolved remains unverified and carries no
silence number. A positive wait or live check still establishes `checking`.
This keeps large and sparse transcripts within the bounded-read contract.

The current kanban renders conversation state in its member tile, so the
shared activity dot replaces that tile's state word. The phone puts the
same dot in its existing title row. The existing browser drivers record the three
states in both languages at 1440, 1000 and 390 px.
