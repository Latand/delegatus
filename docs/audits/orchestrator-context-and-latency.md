# Orchestrator context and latency audit (2026-09-22)

What fills the orchestrator seat's context, which of its calls are slow, and
where it does work it does not need to do. Every number below was measured from
this project's own seat transcripts, the Viewer's MCP receipt store and the
running Viewer. Estimates are marked as estimates.

## Scope, sources and units

**Window.** 2026-09-20T09:03Z to 2026-09-22T20:10Z: eight consecutive seats of
this project (S1 oldest, S8 current), taken from the seat record's `previous`
lineage. Together they made 1,987 model requests and 2,653 tool calls.

| Seat | Transcript window (UTC) | Hours | Model requests | Peak context (measured tokens) | Compactions |
|---|---|---|---|---|---|
| S1 | 09-20 09:03 → 09-21 05:42 | 20.7 | 760 | 787,403 | 1 |
| S2 | 09-21 04:28 → 09-21 11:04 | 6.6 | 239 | 527,191 | 0 |
| S3 | 09-21 11:03 → 09-21 19:44 | 8.7 | 237 | 522,294 | 0 |
| S4 | 09-21 19:20 → 09-22 09:40 | 14.3 | 391 | 798,032 | 1 |
| S5 | 09-22 09:40 → 09-22 16:36 | 6.9 | 74 | 336,998 | 0 |
| S6 | 09-22 16:40 → 09-22 17:08 | 0.5 | 68 | 173,379 | 0 |
| S7 | 09-22 17:08 → 09-22 19:02 | 1.9 | 127 | 296,172 | 0 |
| S8 | 09-22 19:32 → 09-22 20:10 | 0.6 | 91 | 279,701 | 0 |

**Workers.** For comparison: the Claude pipeline workers active in the same
window with transcripts over 200 KB. That is 72 builders, 9 architects and 5
reviewers; most reviewers run on Codex and were not parsed (see §5).

**What counts as context.** The script counts only what the model sees: the
text of `tool_result` blocks, the `tool_use` inputs the seat wrote, the text of
user-role messages, the `rendered` text of harness attachments, and the tool
schemas that `ToolSearch` loaded (`deferred_tools_record`). It does not count
the UI-only `toolUseResult` copy on each result line, or hook records whose
`rendered` text is empty (2,344 async hook responses, none of which reach the
model). Everything in context stays in history until the seat rotates or
compacts.

**Tokens.** The table columns use **tokens ≈ bytes / 4, which is an
estimate**. Measured against the provider's own usage, it is too low. In the 41
turns where the seat made exactly one call and got more than 8 KB back, the
growth in context between the request before and the request after gives
**2.53 bytes per token** (median; interquartile range 2.27–2.66). Real token
counts are therefore about 1.6× the bytes/4 figures. The provider usage records
for the eight seats add up to 624.7 M cache-read input tokens, 8.0 M
cache-write tokens and 1.52 M output tokens across 1,987 requests.

**Totals.** 9,969,594 model-visible bytes, about 2.49 M tokens at bytes/4.

| Family | Bytes | Share |
|---|---|---|
| Viewer MCP answers (1,682 calls) | 3,592,480 | 36.0% |
| Viewer MCP inputs written by the seat | 1,609,066 | 16.1% |
| Bash output (826 calls) | 1,322,679 | 13.3% |
| Bash commands written by the seat | 415,338 | 4.2% |
| Harness attachments (tool schemas, instructions, skill list, reminders) | 1,524,242 | 15.3% |
| User-role text (mandate, seat ticks, operator, compaction summaries) | 744,532 | 7.5% |
| The seat's own prose | 634,558 | 6.4% |
| Read / Write / Edit / ToolSearch / other | 126,699 | 1.3% |

**Start-up cost, measured.** A seat's first request already holds 43–46 K
tokens: the system prompt, tool definitions, mandate, instructions and skill
list. By its tenth request it holds 80–122 K, and by its thirtieth 118–205 K.
Tool traffic in the first 15 minutes averages 126 KB per seat (≈31 K tokens at
bytes/4). On 09-22 the seat rotated four times in 10.5 hours, so it paid this
start-up cost four times.

## 1. Top context offenders

Ranked by total bytes. Share is of the 9.97 MB total. The "re-read" weighting in
row 1 multiplies each item's bytes by the number of later requests that carried
it before a rotation or compaction dropped it. That is the cache-read volume
the item caused.

| # | Source | Calls | Avg / max | Total (≈tok/4) | Share | Example call (arguments only) | What to cut and how |
|---|---|---|---|---|---|---|---|
| 1 | Tool schemas loaded by `ToolSearch` | 71 loads, about 10 per seat; reloaded after each compaction | 10.1 KB per load; 58–88 KB distinct per seat | 717,145 (179 K) | 7.2%; **9.4% when weighted by re-reads**, the largest of any source | `ToolSearch` `select:` over the Viewer tools | The 30 Viewer tools a seat loads come to about 75 KB of schema: `create_pipeline` 11.0 KB, `request_attention` 7.2 KB, `seat_tick_settings` 4.3 KB, `update_task` 4.3 KB, `conversation_messages` 3.9 KB, `pipeline_action` 3.6 KB. The paragraph that used to repeat across tools is gone; repeated sentences now total 2.9 KB. What is left is property-level prose. Cut it to one line per property and move the rules into the server `instructions`, which load once. |
| 2 | `create_pipeline` **inputs** (lane specs the seat writes) | 126 | 4.6 KB (spec 2.8 KB, stages 1.2 KB) | 585,545 (146 K) | 5.9% | `create_pipeline(spec, stages, src, task, repoDir, publication, autoStart)` | The spec mostly restates the linked task's `details`. Let `create_pipeline` read the spec from the linked task when the caller omits it, and take stage prompts from role presets. 18 "pipeline state is busy" refusals made the seat resend 69.7 KB of identical input. |
| 3 | `get_pipeline` answers | 224 | 2.0 KB / 43.0 KB | 453,066 (113 K) | 4.5% | `get_pipeline(pipelineId, stageId)` 140 × 1.66 KB; `get_pipeline(pipelineId)` 6 × 19.5 KB; `get_pipeline(pipelineId, compact:true)` 74 × 1.25 KB | In the `stageId` answer, `attempt` takes 0.9 KB of 1.4 KB. About 39 of these reads are the mandate's read-back after a create or link (heuristic, §3), which the create answer's `taskIds` already covers. Make the id-only read compact by default and keep `full:true` for the whole record. |
| 4 | `pipeline_action` answers | 280 | 1.5 KB / 7.9 KB | 425,880 (106 K) | 4.3% | `pipeline_action(action:"close", pipelineId, reason)` 146 × 2.1 KB | Every action already answers with the compact acknowledgement, except `close`, which appends the whole close report (`src/lib/mcp/bindings.ts:1520`). Its `pending[]` list of host references (8 × 360 B in a typical answer, about 2.9 KB of 4.2 KB) is the whole excess. Answer with counts (`pending`, `stopped`, `alreadyStopped`, `status`) and leave the list to `get_pipeline`. |
| 5 | Bash `git` output | 139 | 3.0 KB / 20.2 KB | 414,434 (104 K) | 4.2% | `git show <ref>:<file> \| sed -n <range>` (37 of 38 `git show` calls read a file); `git diff` 7 × 8.2 KB; `git grep` 24 × 1.8 KB | This is the seat reading code to check lane work itself. Bash `sed` (112 KB) and `cat` (48 KB) add more of the same. Leave verification to the reviewer stage, and keep the seat's own reads to `--stat`, `--name-only` or `gh pr view --json <fields>`. |
| 6 | `conversation_messages` | 56 | 7.3 KB / 60.4 KB | 408,383 (102 K) | 4.1% | `conversation_messages(conversationId, roles:[user, assistant], limit:40)` 6 × 24.5 KB | This is the predecessor read the rotation mandate prescribes (`src/lib/orchestrator/seatCommand.ts:1029`). With the default `maxChars` of 4000, three of the six answers were too large for the client, which saved them to disk. The seat then made 16 Bash reads of client-saved overflow files (these three plus three other overflowed answers), which returned 90.9 KB. Prescribe `limit:12`, `maxChars:1500` and further pages only on demand, since the handoff section already summarizes the state. |
| 7 | Seat tick messages | 110 | 3.2 KB / 3.7 KB | 355,671 (89 K) | 3.6% | — (Viewer → seat) | Two parts repeat. The seat's own monitor note is echoed back in every tick: 136.0 KB, 1.24 KB per tick, and identical to the previous tick 33 times (`src/lib/monitor/report.ts:188`). The fixed 893-byte `Contract:` block is the same in all 110 ticks (98.2 KB, `report.ts:157`, appended at `report.ts:272` and `report.ts:317`). Together they are **66% of the tick bytes**. State the contract once in the mandate, and send the note only when it changed since the last delivered tick, otherwise a one-line "note unchanged (revision …)". |
| 8 | `seat_tick_settings` **inputs** (monitor-note rewrites) | 138, of which 117 set `monitorPrompt` | 2.4 KB (note 2.26 KB) | 337,078 (84 K) | 3.4% | `seat_tick_settings(monitorPrompt, reason, untilMinutes)` | The seat uses the note as its lane ledger and resends all of it on every lane change. A line-level edit (`replaceLine` / `appendLine`, the same shape #1845 proposed for task text) would reduce each change to one line. |
| 9 | Instructions attachment | 15 loads (8 seats plus reloads after compaction) | 21.5 KB | 322,836 (81 K) | 3.2% | — | The memory index is 17.8 KB of each load. The seats run from an older checkout whose `AGENTS.md` is 3.5 KB, while current checkouts carry 17.3 KB; that keeps the seat's load smaller than a builder's (36.6 KB) and also means the seat misses the current repository rules. The index has grown to more than 100 lines, and every seat and every worker session loads all of it. Keep the index to one short line per memory and prune entries that point at retired mechanisms. |
| 10 | `seat_tick_settings` answers | 138 | 2.2 KB / 15.6 KB | 304,485 (76 K) | 3.1% | `seat_tick_settings(verbose:true)` 10 × 10.1 KB, 9 of them at seat start; `seat_tick_settings(monitorPrompt)` write answers 1.2–1.7 KB | A verbose answer carries the same note **three times**: as `settings.monitorPrompt` (`bindings.ts:2839`), as top-level `monitorPrompt` (`bindings.ts:2842`) and as `effective.monitorPrompt` (`bindings.ts:2854`). That is 9.5 KB of an 11.1 KB answer. Carry it once. Reduce the write acknowledgement to `{changed, revision, changedFields, monitorPromptLength}`. |
| 11 | Skill listing attachment | 12 loads | 25.4 KB | 304,408 (76 K) | 3.1% | — | 94 skills are listed, most of them for projects unrelated to this repository. Workers load the same list: 2.18 MB across the 72 builder sessions. Give spawned agents a project-scoped skill set. Whether the CLI can filter the listing per session is **unverified**; check it before building on it. |
| 12 | `list_pipelines` | 73 | 4.2 KB / 24.5 KB | 303,984 (76 K) | 3.0% | `list_pipelines(compact:true, project, state:"open")` 24 × 3.6 KB; the same without `project`, 5 × 9.1 KB | Always pass `project`. 25 calls repeated an earlier call's exact arguments within the same seat, which is polling. |
| 13 | `list_tasks` | 30 | 10.1 KB / 24.6 KB | 303,552 (76 K) | 3.0% | `list_tasks(project, limit:200, updatedSince)` 2 × 24.4 KB, `list_tasks(project, limit:200, openOnly:true)` 1 × 24.7 KB, `list_tasks(project, limit:60, openOnly:true)` 2 × 24.3 KB, all stopped at the 24 KB page budget | The seats' mandate still says "list_tasks … NO status filter and limit: 200". That text left the prompt source on 09-20 and never reached a seat (§3). Search with `query` or `ids` instead, as the current prompt says. |
| 14 | `update_task` answers and inputs | 176 | answers 1.4 KB; inputs 1.3 KB (details 1.06 KB) | 244,400 + 223,033 (117 K) | 2.5% + 2.2% | `update_task(taskId, details)` 81×; `update_task(taskId, status:"done", details)` 32× | The acknowledgement fell from 3.2 KB (09-20 morning) to about 1.0 KB after 09-21. That is still five times #1845's 0.2 KB target: a `task` block of 347 B, `readMore` of 83 B and echoed ids. There is no append or line edit for `details`, so every change resends the whole field. |
| 15 | Mandate (the seat's first prompt) | 8 | 29.2 KB / 31.4 KB | 233,361 (58 K) | 2.3% | — | The core is 18.5 KB. The rotation history and handoff add 7–12 KB, bounded by design (`HISTORY_BUDGET_BYTES = 4096` in `handoffDigest.ts`). The size is acceptable. Its content is stale (§3). |
| 16 | Bash `gh` | 128 | 1.6 KB / 16.4 KB | 201,119 (50 K) | 2.0% | `gh pr view <n> --json <fields>` 55× | Mostly narrow already. The large answers are whole PR bodies and `statusCheckRollup` lists. |
| 17 | `get_flow` | 21 | 9.1 KB / 11.7 KB | 191,607 (48 K) | 1.9% | `get_flow(flowId)` | Returns the full flow record by default (`bindings.ts:5008`), with nine exact repeats. Answer compact by default, or stop reading flows as review flows are retired. |
| 18 | `get_task` | 51 | 3.1 KB / 16.9 KB | 157,685 (39 K) | 1.6% | `get_task(taskId)` 29 × 4.8 KB | About 17 are read-backs right after a create or link (heuristic, §3). `compact:true` answers those. |
| 19 | `agent_activity` | 68 | 2.3 KB / 26.6 KB | 154,889 (39 K) | 1.6% | `agent_activity(compact:true, liveOnly:true, project)` 16 × 4.0 KB | Acceptable after #1936; 27 exact repeats are polling. |
| 20 | `rotate_orchestrator` | 4 | 15.8 KB / 31.8 KB | 63,222 (16 K) | 0.6% | `rotate_orchestrator(project, handoffNotes, engine, accountId)` | The outgoing seat receives the successor's whole `seat` record, mandate included (`bindings.ts:3142`; the same applies to `create_orchestrator` at `bindings.ts:3043`). Acknowledge with `{conversationId, seatEpoch, state}`. |

The seat's own prose (634,558 B, 6.4%) is not a tool cost. It is listed here
because it stays in history like everything else.

**The same mechanism across rows.** Rows 7, 8 and 10 are one loop: the seat
writes its monitor note (337 KB), gets the settings answer back (304 KB), and
receives the note inside every tick (136 KB). That is **777 KB, 7.8%** of
everything, the largest single mechanism in this audit.

## 2. Slow calls

Latency is the time from the transcript line with the `tool_use` block to the
line with its `tool_result`. When the seat issues several calls in one turn,
later calls in that batch can include time spent waiting for earlier ones.
Where that mattered, the single-call figure is given separately. "Before" and
"after" split at 2026-09-21T12:00Z, when the lease and close fixes were
running.

| # | Tool / call | Count | p50 | p95 | Max | Cause (code) | Fix |
|---|---|---|---|---|---|---|---|
| 1 | Seat's own in-turn waits: a local merge helper (update branch → `gh pr checks --watch` → merge) | 50 runs | 29 s | 381 s | 600 s | The seat blocks its own turn on CI (4,812 s in total). The Viewer has no merge-when-green action. | Product: a server-side merge-when-green with a wake when it lands. Seat: end the turn and let the tick wake it. |
| 1b | Seat's own in-turn sleeps: `timeout N tail -f /dev/null`, used because the harness blocks `sleep` | 68 | 66 s | 193 s | 355 s | Waiting for deploys, lanes or CI inside the turn (5,319 s in total), although the mandate says the Viewer wakes the seat | Seat: forbid in-turn waiting in the mandate. Product: wake reasons for "CI green" and "deploy terminal". |
| 2 | `pipeline_action close` | 155 | 0.18 s | 30.7 s | 67.1 s | Waiting for the pipeline registry lease: `DEFAULT_PIPELINE_LOCK_WAIT_MS = 30_000` (`src/lib/pipelines/store.ts:1063`), which is the same as the MCP tool deadline (`src/lib/mcp/server.ts:3686`). A refused call therefore costs the full 30 s before it returns "pipeline state is busy". | **Held.** Before: p95 58.6 s (n=73). After: p95 0.2 s (n=82). |
| 2b | `pipeline_action retry-stage` | 45 | 8.0 s | 51.3 s | 55.2 s | Same lease wait | Before p95 52.0 s, after p95 13.6 s (n=8) |
| 2c | `pipeline_action publish` / `skip-stage` | 7 / 10 | 31.5 s / 3.1 s | 38.3 s / 30.0 s | 39.3 s / 30.0 s | Same lease (`StoreBusyBeforeAdmissionError` inside publication settlement) | None of either after the cutoff |
| 2d | `create_pipeline` | 126 | 1.5 s | 30.9 s | 41.2 s | Same lease; 18 "busy" refusals | Before p95 31.0 s, after p95 3.0 s |
| 3 | `send_message` | 57 | 2.1 s | 7.0 s | 8.5 s | 23 of 57 calls (40%) ended in `outcome_unknown`: "no downstream record holds this request yet" 15, "host ownership is synchronizing" 4, "dispatch deadline" 4. The last half-day was worse, at 11 of 14. The seat followed up with 34 `message_receipt` calls. | Open: #1582, #1866. Answer only once the delivery ledger holds the request, or return the receipt id with a state the seat can wait on without polling. |
| 3b | `message_receipt` | 34 | 0.5 s | 46.8 s | 89.8 s | Single calls: p95 0.55 s. The slow ones sat in batches behind lease-bound calls on 09-21. | No change needed on its own; it goes away with fix 3. |
| 4 | `request_attention` | 16 | 4.4 s | 9.2 s | 13.6 s | Looking up one target loads the whole pipelines, flows or tasks store: `dependencies.getPipelines().pipelines.find(…)`, `getFlowsWithPresets().flows.find(…)`, `loadTasks().find(…)` (`bindings.ts:4286–4296`). **Probable cause, from reading the code; not profiled.** | By-id lookups |
| 5 | `deployment_status(compact, deploymentId)` | 68 | 0.39 s | 7.6 s | 14.7 s | Every call over 4 s fell inside a deploy window (for example 19:41Z during the 19:35–19:42Z deploy): the runtime host is loaded during a release. The seat polled 45 times for 17 deploys, up to 7 per deploy. | Wake the seat when a deploy ends instead of letting it poll |
| 6 | `deploy_exact_sha` | 27 | 3.1 s | 8.1 s | 8.8 s | One per deploy; acceptable | — |
| 7 | `seat_tick_settings` | 138 | 1.16 s | 1.9 s | 24.4 s | A settings write takes a second or more (191 s in total). **Not attributed.** | Profile together with the answer diet in row 10 |
| 8 | `agent_activity` | 68 | 0.89 s | 5.7 s | 74.5 s | One outlier on 09-21; p50 on 09-22 was 0.58 s | — |
| 9 | Fast and healthy | `get_pipeline` 224 (p50 0.07 s), `update_task` 176 (p50 0.16 s, p95 0.2 s after the cutoff), `list_pipelines` 73, `list_tasks` 30 (p95 3.8 s after the cutoff) | | | | | |

**Runtime host, server side.** `deployment_status` read at 2026-09-22 about
20:15Z reported `runtimeHostRequests`: 50 samples, p95 2,031 ms, max 7,798 ms, 1
timeout (window 256). The earlier audit (task 62cf2b1b) measured 140 timeouts in
35 minutes.

**Seat time lost to waiting.** Bash calls of 30 s or more: 81 calls, 10,955 s
(3.0 h), across roughly 60 hours of seat wall-clock. While a turn is blocked, an
operator message or a tick queues behind it.

## 3. Needless work

1. **Rotated seats never receive mandate fixes.** Rotation composes the
   successor's mandate from the *incumbent's* text:
   `const base = text(rawBody.mandate) || incumbent.mandate`
   (`src/lib/orchestrator/seatCommand.ts:1258`). A seat picks up the new
   default only when `orchestratorMandateStale(incumbent.promptVersion)` is
   true (`prompt.ts:77`). Commit `8c2cd3351` (2026-09-20, the #1936 compaction
   PR) rewrote the mandate's cost-relevant lines without bumping
   `ORCHESTRATOR_PROMPT_VERSION`, which is still 20 (`prompt.ts:72`, set
   09-19). It replaced "list_tasks … limit: 200" with "query or ids when you can
   name the work", and changed the read-back to `get_pipeline` with
   `compact:true`. All eight seats since then run the old wording. The live core
   has 6 sentences (1.1 KB) that the current prompt does not, and the current
   prompt has 10 sentences (1.8 KB) that the live core lacks. **Task 8423f7d7's
   last step, "rewrite the seat's own habits", therefore never reached a
   seat.** Fixing this comes before every seat-behaviour item below, because
   those items are edits to that same text.
2. **Monitor-note churn.** The note was rewritten in full 117 times (337 KB of
   input), echoed back in each answer and in every tick (row 7, row 10), and
   read in full at seat start 9 times (`verbose:true`, 87.5 KB).
3. **Read-back after every create or link.** The mandate asks for
   `get_pipeline`, then `get_task`, after each create or link. Counting reads
   in the same ten-minute window after a successful create or link (a
   heuristic) gives 56 reads (39 `get_pipeline`, 17 `get_task`) and 82.1 KB.
   The create answer
   already carries `taskIds`, and `get_task(compact:true)` would answer the
   second check.
4. **Polling instead of waking.** Seats repeated a call with identical
   arguments 25 times for `list_pipelines`, 54 for `get_pipeline`, 27 for
   `agent_activity`, 33 for `deployment_status` and 9 for `get_flow`. For
   deploys: 45 status reads for 17 deploys. The tick already wakes the seat on
   lane events. Deploy-terminal and CI-green wakes would retire the rest.
5. **Blocking waits in the turn.** 118 Bash calls were the merge helper or a
   sleep substitute, 10,131 s in total (§2 rows 1 and 1b). The mandate's clock
   section says the Viewer wakes the seat, and the seat worked around the
   harness's sleep block anyway.
6. **The predecessor read.** The rotation mandate prescribes `limit:40` with
   default `maxChars`. Three of six answers were too large for the client,
   which stored them on disk. The seat then read those files with 16 Bash calls
   (90.9 KB).
7. **Retries that resend everything.** "Pipeline state is busy" appeared in 63
   tool results, 42 of them after a wait of 20 s or more. Each refusal made the
   seat resend the whole request: 69.7 KB of `create_pipeline` input alone.
   The refusals stopped after 09-21 12:00Z (62 before, 1 after, at 09-22
   08:22Z), but the mechanism is still there. The lease wait
   and the MCP deadline are both 30 s, so a refusal always costs the whole
   deadline.
8. **The seat reads code.** `git show`, `git diff`, `git grep`, `sed` and `cat`
   add up to about 390 KB, spent checking lane diffs that a reviewer stage
   already checks.
9. **Tool schemas reloaded after compaction.** The two seats that compacted
   (S1, S4) loaded their schemas twice: 142 KB and 163 KB, against 68 KB and 88
   KB of distinct schema.
10. **A defect still open from #1845: `GET /api/tasks` ignores its query.**
    `GET /api/tasks?project=nonexistent-x` answered 2,352,149 bytes (every
    task) at 2026-09-22 about 20:20Z. Seats still made 46 `curl` calls to
    `/api` in the window (29 on 09-20, 7 on 09-21, 10 on 09-22). They are
    small now, about 26 KB in total.

### Prior work: what held and what regressed

| Prior fix | Status | Evidence in this window |
|---|---|---|
| #1936 compact lists and budgets (task 8423f7d7) | **Held** | `list_tasks` never went over its 24 KB page (max 24.6 KB); `list_pipelines(compact, open)` avg 3.6 KB; `agent_activity(compact, liveOnly)` avg 4.0 KB |
| 8423f7d7's final step, "rewrite the seat's habits" | **Never landed** | The prompt text changed without a version bump, so rotations carried the old mandate (§3.1) |
| #1919 compact `stage_report` acknowledgement | **Held** | Receipt store: 276 `stage_report` answers since 09-20 09:00Z, average 680 B |
| #1845 slice 1: `create_pipeline` acknowledgement | **Held** | Median 1.08 KB, down from 10.4 KB |
| #1845 slice 1: `pipeline_action` acknowledgement like `pause` | **Partial** | `close` still appends its report: 2.1 KB average, 7.9 KB max (row 4) |
| #1845 slice 1: `deployment_status` compact and newest first (defect C) | **Held** | 0.4 KB answers, newest first |
| #1845 slice 1: `seat_tick_settings` echoes the note only when asked | **Partial** | Default writes no longer echo the note (1.2–1.7 KB), but `verbose` returns it three times (row 10) |
| #1845 defect B: `/api/pipelines` filters | **Fixed** | `?project=nonexistent-x` answers 16 B |
| #1845 slice 2: `update_task` acknowledgement of about 0.2 KB | **Partial** | About 1.0 KB since 09-21 (was 3.2 KB) |
| #1845 slice 2: `replaceLine` / `appendText` | **Not present** | No such parameter in `src/lib/mcp/server.ts` |
| #1845 defect A: `/api/tasks` filters | **Open** | 2,352,149 B for a nonexistent project |
| #1845 defect D: `send_message` `outcome_unknown` | **Open, worse at the end of the window** | 23 of 57 overall; 11 of 14 on 09-22 after 12:00Z |
| e4998332 (MCP calls taking 26–30 s) | **Held** | close / create / retry p95 went from 58.6 / 31.0 / 52.0 s to 0.2 / 3.0 / 13.6 s; one busy refusal after 09-21 12:00Z |
| 62cf2b1b (where the Viewer slows agents) | **Held** | Runtime host p95 2.0 s, 1 timeout in the last 50 requests |
| 6fe61a42 (repeated tool-description boilerplate) | **Held** | Repeated sentences across the 30 loaded Viewer tools now total 2.9 KB |

## 4. Ranked fix list

Ranked by context or time saved per unit of effort. Savings are for the 2.5-day
window at bytes/4 and are **estimates**; multiply by about 1.6 for measured
tokens.

### Product fixes (Viewer code)

**P1. Seat mandates track the prompt source.**
- Problem: rotation reuses the incumbent's mandate, and the version check did
  not fire because the version was not bumped (§3.1).
- Evidence: the live mandate still contains the `list_tasks … limit: 200`
  wording that `8c2cd3351` removed; both are prompt version 20.
- Fix: derive `ORCHESTRATOR_PROMPT_VERSION` from a hash of
  `ORCHESTRATOR_SYSTEM_PROMPT`, or add a test that fails when the text changes
  without a version bump. Rotation then rebuilds the core from the current
  default whenever the incumbent's core is an older default.
- Acceptance: after a deploy, the next rotation's mandate core is byte-identical
  to the current default, and changing any prompt text changes the recorded
  version.
- Effort: small. It unblocks every S-item below.

**P2. Ticks stop echoing the note and the contract.**
- Problem: 66% of tick bytes repeat what the seat wrote or already holds.
- Evidence: 136.0 KB of note preview (33 ticks identical to the previous one)
  and 98.2 KB of the fixed contract, in 110 ticks (`report.ts:157`, `188`,
  `272`, `317`).
- Fix: state the contract in the mandate only; include the note preview only
  when its revision changed since the last delivered tick, otherwise one
  "note unchanged" line.
- Acceptance: a tick with an unchanged note is at most about 1.2 KB, and the
  mandate contains every contract clause.
- Saves about 58 K tokens per 2.5 days, plus the re-reads.

**P3. `seat_tick_settings` answers carry the note once and acknowledge writes
briefly; the note gets line edits.**
- Evidence: a verbose answer is 11.1 KB, 9.5 KB of it three copies of the note
  (`bindings.ts:2839`, `2842`, `2854`). Write answers are 1.2–1.7 KB × 117.
  Note inputs total 337 KB.
- Fix: the note appears once in `verbose`; writes answer
  `{changed, revision, changedFields, monitorPromptLength}`; add
  `replaceLine` / `appendLine`.
- Acceptance: a verbose answer is no bigger than the note plus 1 KB; a write
  acknowledgement is 300 B or less; changing one lane line sends less than
  300 B.
- Saves about 130 K tokens per 2.5 days.

**P4. The `pipeline_action close` answer drops `pending[]`.**
- Evidence: 146 closes averaging 2.1 KB, max 7.9 KB (`bindings.ts:1520`).
- Fix: counts only; the host list stays in `get_pipeline`.
- Acceptance: a close answer is 600 B or less with 8 pending hosts.
- Saves about 60 K tokens.

**P5. Lighter Viewer tool schemas.**
- Evidence: about 75 KB for 30 tools, the largest re-read cost (9.4%), and
  reloaded after compaction.
- Fix: one line per property; move the rules into the server `instructions`;
  set a byte budget per tool and fail CI when a schema exceeds it.
- Acceptance: all Viewer tool schemas together are 40 KB or less, with the
  budget enforced by a test.
- Saves about 9 K tokens per seat at start (35 KB at bytes/4), re-read on
  every later request.

**P6. `update_task` acknowledgement and `details` edits (finish #1845 slice 2).**
- Evidence: about 1.0 KB acknowledgements × 176, and `details` rewrites of
  1.06 KB × 177.
- Fix: acknowledge with `{taskId, revision, status, changedFields}` and add
  `appendDetails` / `replaceDetailsLine`.
- Acceptance: the acknowledgement is 250 B or less; appending one line sends
  less than 300 B.
- Saves about 65 K tokens.

**P7. `create_pipeline` takes its spec from the linked task.**
- Evidence: 586 KB of seat-written specs; 69.7 KB resent after refusals.
- Fix: when `spec` is omitted and `task` is given, use the task's `details`;
  stage prompts default from the role preset.
- Acceptance: a create that names a task with `details` succeeds without
  `spec`, and the stored spec equals those `details`.
- Saves a large share of about 146 K tokens, which are also output tokens and
  priced higher.

**P8. `rotate_orchestrator` / `create_orchestrator` answer an acknowledgement.**
- Evidence: 15.8 KB average (`bindings.ts:3142`, `3043`).
- Fix: `{conversationId, seatEpoch, state, promptVersion}`; the mandate stays
  behind `get_orchestrator`.
- Acceptance: the answer is 500 B or less.

**P9. `get_flow` compact by default.**
- Evidence: 21 × 9.1 KB, 9 exact repeats (`bindings.ts:5008`).
- Fix: default to id, state, cursor and the current round; `full:true` for the
  record.
- Acceptance: the default answer is 1.5 KB or less.

**P10. Merge-when-green and wake reasons for CI and deploys.**
- Evidence: 10,131 s of in-turn waiting; 45 deploy status polls for 17 deploys.
- Fix: a Viewer action that merges a PR once its required checks pass at the
  recorded head (or wraps `gh pr merge --auto`). Add tick wake reasons for
  "PR merged / CI red" and "deploy terminal".
- Acceptance: a seat can go from APPROVE to merged to deployed with no Bash
  wait longer than 30 s, and no `deployment_status` poll between the start of a
  deploy and its end.

**P11. `request_attention` resolves its target by id.**
- Evidence: p50 4.4 s; loads whole stores (`bindings.ts:4286–4296`, probable
  cause).
- Acceptance: p95 under 1 s on the live stores.

**P12. `send_message` stops answering `outcome_unknown` for sends the ledger
has not yet recorded (#1582, #1866).**
- Evidence: 23 of 57, then 34 receipt polls.
- Acceptance: under 5% unknown over a day of seat traffic.

**P13. `GET /api/tasks` honours `project` and `status` (defect A).**
- Evidence: 2,352,149 B for a nonexistent project.
- Acceptance: an empty list, or a 400, for an unknown project.

**P14. Lease refusal costs less than the whole deadline.**
- Evidence: it held after 09-21, but a lease wait equal to the 30 s MCP
  deadline makes every refusal cost 30 s (`store.ts:1063`, `server.ts:3686`).
- Fix: refuse early with `retryAfterMs` when the lease holder's pass will
  outlast the remaining deadline.
- Acceptance: a busy refusal returns in under 5 s.

### Seat-behaviour fixes (mandate, prompt and skill wording)

These all depend on P1. Without it, a wording change never reaches a rotated
seat.

**S1. Predecessor read.**
- Change `seatCommand.ts:1029` to prescribe `limit:12`, `maxChars:1500`, with
  older pages only when the handoff section leaves a question open.
- Acceptance: the start-up predecessor read is 20 KB or less and never spills
  to disk.
- Saves about 25 K tokens per rotation.

**S2. Start-up reads.**
- Replace "list_tasks … limit: 200" with the current query/ids sentence (it is
  already in `prompt.ts`), read the note once, and drop the other start-up
  list reads the tick already answers.
- Acceptance: a seat's first 10 requests reach 70 K tokens of context or less
  (measured today: 80–122 K).

**S3. Read-back rule.**
- After `create_pipeline`, trust the returned `taskIds`; check the task with
  `get_task(compact:true)` only.
- Acceptance: no full `get_pipeline` or `get_task` read within a minute of a
  create.

**S4. No waiting in the turn.**
- State that the seat never sleeps or watches CI inside a turn (including
  `timeout … tail -f /dev/null` and `gh pr checks --watch`), and ends the turn
  instead.
- Acceptance: no seat Bash call longer than 60 s over a day. P10 makes this
  practical.

**S5. Leave verification to reviewers.**
- The seat checks diffs through the review stage's verdict and `gh pr view
  --json` fields, and reads code only to answer an operator question.
- Acceptance: seat Bash `git show` / `git diff` / `sed` output under 50 KB a
  day.

**S6. Memory index and skill scope** (operator configuration; affects every
seat and worker).
- Keep the memory index to one short line per entry, prune entries for retired
  mechanisms, and give spawned agents a project-scoped skill set.
- Acceptance: instructions plus skill listing come to 30 KB or less per
  session (measured today: about 47 KB for a seat and about 66 KB for a
  builder).

## 5. Workers: does the same bloat hit them?

Mostly not. Viewer MCP answers are a small share of worker context. Workers
fill their context with code reads, which is their job. The fixed per-session
cost (instructions and skill listing) hits them as hard as it hits the seat.

| Role (Claude) | Sessions | Model-visible bytes per session | Viewer MCP answers | Main context filler | Instructions + skill listing per session |
|---|---|---|---|---|---|
| Builder | 72 | 472 KB | 1.7% | Bash `sed` 6.4 MB, `cat` 2.2 MB, `grep` 1.9 MB across all sessions | 36.6 KB + 30.3 KB |
| Architect | 9 | 458 KB | 4.5% (mostly `search_transcripts`) | `sed` / `cat` reads, web search | 28.6 KB + 30.2 KB |
| Reviewer | 5 | 219 KB | 0.6% | `sed` / `git` reads | 34.6 KB + 30.2 KB |

Builder peak context: median 219 K tokens, max 793 K (measured). **Not
covered:** reviewers and builders that ran on Codex. Their rollouts use a
different record format and were not parsed in this pass; the earlier audit on
task 6fe61a42 measured Codex separately.

## Appendix: how each number was produced

All reads were made between 2026-09-22T19:55Z and 20:30Z, with no writes to
production. Transcript window: 2026-09-20T09:03Z to 2026-09-22T20:10Z.

- **Seat lineage:**
  `curl -s 'http://127.0.0.1:8898/api/orchestrator/seat?project=<project>'`
  (GET), fields `seat` and `previous[].{path, heldFrom, heldTo}`.
- **Transcripts:** the raw JSONL of each seat (`previous[].path`), parsed line
  by line and read-only. For each `tool_use` block: name, input, byte size and
  timestamp. For each `tool_result`: the byte size of its text content, its
  timestamp, `is_error`, and whether the client stored it on disk. Attachments
  are counted by their `rendered` text. `deferred_tools_record` entries are
  counted by their JSON size. The per-call shape is the tool name plus its
  argument keys, with enum-like values kept (`compact`, `limit`, `action`,
  `kinds`, `verbose` and similar) and `clientRequestId` dropped.
- **Latency:** result line timestamp minus call line timestamp. Single-call
  turns are those whose model request carried exactly one `tool_use` block.
- **Token calibration:** for single-call turns with a result over 8 KB, the
  result's bytes divided by
  `(input + cache_read + cache_creation)[next request] − (same)[this request] − output_tokens[this request]`.
- **Re-read weighting:** bytes × the number of later model requests in the
  same seat before the next `compact_boundary`.
- **Server-side answer sizes:** a read-only copy of the MCP receipt store,
  queried with
  `SELECT substr(receipt_key,1,instr(receipt_key,':')-1) tool, count(*), avg(storage_bytes), max(storage_bytes), sum(storage_bytes) FROM mcp_receipts WHERE claimed_at >= strftime('%s','2026-09-20 09:00:00')*1000 GROUP BY tool`.
  Read receipts are bounded and pruned, so read tools are undercounted there;
  the transcript figures are the primary evidence.
- **Runtime host:** Viewer MCP
  `deployment_status({compact: true, limit: 3})` → `runtimeHostRequests`.
- **HTTP defects:**
  `curl -s -o /dev/null -w '%{size_download}' 'http://127.0.0.1:8898/api/tasks?project=nonexistent-x'`,
  and the same for `/api/pipelines`.
- **Mandate drift:** the live mandate from the seat record (`seat.mandate`),
  compared by sentence with `ORCHESTRATOR_SYSTEM_PROMPT` loaded from
  `src/lib/orchestrator/prompt.ts` at `5ddc67a35`. History:
  `git log -S 'limit: 200, so blocked' -- src/lib/orchestrator/prompt.ts`.
- **Workers:** Claude transcripts under pipeline worktree checkouts, modified
  after 2026-09-20 09:00 and larger than 200 KB. Role taken from the
  `Role preset:` line of the first prompt.
