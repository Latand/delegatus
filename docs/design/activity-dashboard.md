# Activity dashboard: human interaction time and agent activity per project

- Status: prototype built (one builder stage, PR left open, no deploy, no merge)
- Grounded base: `main` at `bfd58b846fa21e84138b7e74f64f0fb34c73b852`
- Prior work read: #473 (WakaTime integration), #763 and its landed Phase 0 (#767, #1017, #1623), the scanner activity model, the view presence heartbeat, the transcript search index
- Revised by three operator corrections on 2026-09-24 (below). Where the first draft of this document and a correction disagree, the correction wins and the text here already follows it.
- Extended the same day by "Activity records itself" (section [Continuous record](#continuous-record-no-export-required)): every host's operator input and agent turns are written into Delegatus's own store as transcripts are indexed, other hosts are pulled over ssh, and an export is no longer required for complete numbers.
- Extended on 2026-09-25 by [One project's page](#one-projects-page): the whole page filtered to one project, agent time a host did not send read as a lower bound, and Codex subagent threads counted as their own agents.

## Originating requirement

The request, as the orchestrator relayed it on 2026-09-24. The two billed
client projects are redacted.

> Operator request for the Delegatus project: investigate a per-project
> activity dashboard and have Opus create a reviewable prototype. Show human
> interaction time and agent activity separately, with WakaTime-like
> day/project views. Human time must come from real interaction in Delegatus
> web, desktop, and mobile surfaces where observable; agent work needs its own
> provenance and must never inflate human hours. Inspect the current main
> implementation and prior operator-worktime ledger / agent-activity analytics
> (#763 and #473) before choosing calculations or data sources; state coverage
> gaps honestly. Keep personal information, raw prompts, message bodies, and
> secrets out of Delegatus metrics and UI. This dashboard is a separate product
> task from the paid #zvit, which covers only [two client projects]. Please own
> the investigation, task and Opus prototype handoff, then show the prototype
> to the operator. No deployment is authorized by this request.

The pinned specification added the views (per day with a day strip and
totals, per project with a ranking and breakdown, a Today / 7 days / 30 days
picker) and the rules on sources, privacy, the #zvit fence and no deployment.

### Operator correction 1: supervised agent work is the operator's work

It replaces the specification line "agent work never counts toward human
hours" (paraphrased by the orchestrator):

> 1. Supervised agent work IS the operator's work. After each real operator
>    request the operator is watching the agent: at least a 10-15 minute
>    engagement window per request, and when the gap to the next request is
>    below the episode threshold, the whole span between the two requests
>    counts as human time even though an agent is working in it.
> 2. What must never count as human time is UNATTENDED agent work: agent
>    activity beyond the engagement window after the last operator input,
>    background/automation runs, spawn/bridge/injected prompts.
> 3. Human and agent time are two parallel axes that overlap. The dashboard
>    shows both on their own axes (the overlap is expected and should be
>    visible, e.g. supervised vs unattended agent time); neither axis is
>    subtracted from the other.
> 4. The operator already has a calculated method; apply it rather than
>    inventing one. [...] Reconcile the two into one exact, parameterised
>    method (window length, T, rounding) and say which values are defaults.
>    Do not change the #zvit path itself.

### Operator correction 2: human input comes from more than one host

Paraphrased. A worktime scan that read only this workstation reported no paid
activity for 2026-09-23 after the client work moved to a separate stage host.
A read-only inventory of that host found 81 candidate human-input records for
2026-09-23 and 91 for 2026-09-22, all real operator decisions. A calculation
that reads one host therefore undercounts without saying so. Required:

1. Every human-input event carries its host and source. Each host is read
   through a pluggable source; hosts that are not connected are listed, and a
   day or project whose host was not read shows coverage *unknown*. A zero is
   shown only when every expected source was read.
2. Copies are deduplicated by stable prompt or message ids across mirrors,
   account-store copies, resumes, continuations and fan-out, with a documented
   (timestamp, canonical-hash) rule only where no id exists.
3. Agent relays, generated stage prompts, spawn, bridge and injected prompts
   and automation are never human input.
4. Human time stays its own axis beside agent time (correction 1).
5. Privacy is unchanged: events carry ids, times, a host, a project and a kind.
6. Tests: two hosts where only the remote one has input (hours come from it,
   coverage complete); the same with the remote host missing (coverage unknown,
   never zero); a mirror and continuation duplicate counted once; a relay and a
   stage prompt excluded. One render shows the unknown-coverage state.

### Operator correction 3: six counting rules from a real recount

Paraphrased. A recount the operator had to fix on 2026-09-24 roughly doubled
once the stage host was read; one day went from 0 h to 8.5 h. The rules:

1. **Every host with a Viewer or agent transcript store is a source.** Client
   work runs through a stage Viewer on another host, which the local Codex
   home, account stores and shared mirror never see. An unread host is unknown.
2. **Dedupe across stores by prompt id or event id.** The same message sits in
   shared mirrors and account stores, sometimes on both machines. Id-less
   copies with identical canonical content within 90 s count once; only a hash
   is stored.
3. **Count only real operator input.** Exclude spawn and role scaffolds,
   reviewer, auditor and deployer templates, bridge, automation and recovery
   notifications, injected skill hints, auto-attached screenshots, and
   worker-to-manager messages that arrive with role=user. The reliable positive
   signal is the `llv:structured-user` operator-origin marker; unmarked
   role=user records are treated conservatively and counted per exclusion
   reason.
4. **Sessions span days.** Every message is bucketed by its own timestamp in
   Europe/Kyiv (configurable), never by the session's start date or directory.
5. **Project attribution comes from the conversation's context** (its project,
   cwd or task binding), never from words in the text.
6. **Sanity check.** A workday with 0 h human time while an expected source is
   unread, or while agent activity shows the operator was working somewhere, is
   flagged as a probable missing source and never presented as a clean zero.

The method itself was restated: each operator message opens a 10-minute
window, windows combine within each clock hour, 10-39 minutes weigh 0.5 h and
40 or more 1 h, and one hour goes to one project. Billable tagging is a
setting; the dashboard covers every project and the paid report path is
untouched.

## Decision

1. **Human axis: human-input events from every expected host.** An event is
   `{ ids, at, host, source, project, kind, surface, hash }`. Two sources exist
   and more can be added behind the same interface:
   - `ledger`: this host's request ledger, written at each direct-operator
     ingress (exact, with the browser surface), from its first row on. It
     sees only requests made through Delegatus.
   - `transcripts`: an export file per host, produced on that host by
     `scripts/export-human-input.ts` from all of its transcript stores, keeping
     only real operator input, and copied into `activity/hosts/<host>/`.
2. **Coverage.** The expected hosts are this one, the hosts in
   `activity/hosts.json`, and any host with an export directory. The stretch a
   host's sources did not cover is *unknown* for the projects that host holds.
   Only a source that read every store of its host covers it: the host's
   continuous record (this host's ingest, another host's pull) or a transcript
   export. The ledger's rows count, but the ledger never covers its host,
   because input typed into an agent's terminal there never reaches it.
   A figure missing a host is a lower bound (`≥`); nothing read is `Unknown`.
3. **Counting method.** The operator's method, parameterised: engagement
   window `W`, episode threshold `T`, rounding. Defaults follow the restated
   method and the recount that used it: `W = 10`, `T = W`, clock-hour weights,
   Europe/Kyiv. `T = 30` with half-hour rounding is the 2026-07-29 refinement.
4. **Agent axis.** From the full-history transcript search index on this host
   (path, speaker and time only), joined to the registry for conversation, role
   and pipeline stage, split into *supervised* (inside a human episode of the
   same project) and *unattended*.
5. **Sanity flag.** A zero-hour workday with an unread source or with at least
   30 minutes of agent wall-clock is a probable missing source.
6. **Page.** `/activity`, desktop and phone, backed by the pure module
   `src/lib/activity/method.ts` and one `GET /api/activity`.

## Continuous record: no export required

The operator's request after the prototype merged, paraphrased: activity must
be recorded automatically as it happens and stored in Delegatus's own
database; an export may exist, and the numbers must never depend on one.

### This host: the ingest

`src/lib/activity/ingest.ts`, called from the transcript index's background
pass (`src/lib/search/transcriptFeed.ts`) over the same scanner inventory,
right after the index and in the same process. It writes
`<state>/activity/records.sqlite` (`src/lib/activity/store.ts`):

| table | one row per | fields |
|---|---|---|
| `activity_inputs` | operator input, per host | opaque ids, content hash, time, project, kind, surface, opaque conversation digest |
| `activity_input_ids` | id of this host's inputs | which row the id already names |
| `activity_turns` | agent turn of a conversation, per host | opaque conversation digest, project, engine, role, pipeline and stage ids, start, end |
| `activity_files` | transcript read | byte offset read to, what the lines before it said (cwd, entrypoint, how the session started, the open turn), whether its first message was judged |
| `activity_hosts` | host | span read, when last read and attempted, why the last attempt failed, the pull cursor and the remote store's id, exclusion counts |

- **The same rules as the export.** Each transcript's new lines go through
  the exporter's own line reader and classifier (`TranscriptLineReader`,
  `classifyRecords`, `conversationResolver`), so the marker-only rule, the
  exclusion reasons, Kyiv buckets and project from context are one code path.
- **Incremental, with a durable cursor.** Only the bytes a transcript gained
  since its cursor are read, in pieces of 32 MB; each piece's rows, exclusion
  counts and advanced cursor commit in one transaction. A half-written last
  line waits for the next pass. A restart resumes at the cursor; a
  transcript shorter than its cursor is read again, and its ids keep it from
  doubling.
- **Copies count once.** A copy of an input whose id is already stored joins
  that row; an unregistered session's copies share their file name and are
  one conversation for turns. The read side still applies the fallback rule
  (`dedupeCandidates`), so fan-out and id-less copies collapse exactly as in
  an export.
- **Backfill.** The first pass has no cursors, so it reads the host's whole
  history, newest transcripts first, within a budget of 1 GB per pass; the
  rest continues on the next passes.
- **A transcript the registry does not name yet.** A Delegatus-hosted session
  can be written before the registry records it, and judged then its input
  would be excluded for good. It waits up to 15 minutes, and the read span
  stops before its first unread record meanwhile.
- **Read span.** From the first record on disk to the start of the last pass
  that read the whole inventory without failures, and never past the moment
  the scan that listed it began. The index passes every four to eight minutes
  (measured on the operator's host: median 250 s, p90 6 min, max 8 min), so a
  source whose last read ended within 10 minutes is caught up and covers to
  now; one older than that is behind, and the stretch since is unread.
  Transcripts an engine has already deleted are not on disk to read: the span
  begins at the oldest record that survived.

### Other hosts: the pull

Observed, not assumed: the second host is a shared stage box that runs its
own Delegatus as a user service on a loopback port, reachable from this host
only over ssh with the operator's key. This host's Viewer container shares
the operator's home (ssh config and keys) and has `openssh-client`, and a
non-interactive `ssh -o BatchMode=yes <alias>` from inside it answers.

So each host records itself with the same ingest, and this Viewer pulls:
`src/lib/activity/pull.ts` runs `ssh -o BatchMode=yes <alias>` with a
self-contained reader handed to the remote Bun on stdin. The reader uses Bun
built-ins only, reads the remote `activity/records.sqlite` read-only in one
transaction, and answers the remote's read span, exclusion counts, store id
and every input and turn row written after the version this host last
received. Nothing is installed on the remote host and no port is opened.

- **Idempotent.** Rows are keyed per host and replace an older version only;
  a replay changes nothing. A remote store whose id changed (recreated) is
  dropped here and read again whole.
- **Honest span.** A pull in pages takes the remote's read span only with its
  last page. A failed pull (`unreachable`, `timeout`, `no-ingest` for a remote
  Delegatus that predates the ingest, `malformed`) keeps the last span and
  names the reason in the hosts table; the stretch after it is unread.
- **Schedule.** After an ingest pass, every host whose interval (5 minutes by
  default) has passed is pulled, one at a time, beside the index queue so a
  slow host delays nothing but itself.
- **Configuration.** A host entry in `activity/hosts.json` gains
  `pull: { ssh, bun?, stateDir?, everyMin? }`; `ssh` is an alias from the
  operator's ssh config and is never an option or a command.

### Agent axis from the same record

The measurement below showed the index-based turns wrong in both directions,
and the other host missing entirely, so the agent axis now reads agent turns
from the store: this host's once its ingest has finished a pass (the index
approximation until then), and every pulled host's. A turn is bounded by the
engine's own records:

- **Codex:** from `task_started` to `task_complete` or `turn_aborted`. A user
  message opens a turn only when none is running. A turn started by another
  agent's delivery carries no user message, which is why the index, which saw
  only message rows, ran such a conversation's idle hours between turns into
  one turn.
- **Claude:** from a user record with text to the turn's last assistant,
  tool-result or system record. Queue and bookkeeping records written while
  the agent waits are not work.
- A turn still running is stored as far as it has run and extended later.

A Codex line's place in a turn is in its first few hundred bytes, so tool
output, reasoning and compaction lines are never decoded or parsed whole.

### Project attribution

Human input and agent turns take their project from the conversation's
context through the scanner's own rules (`projectInfoFromCwd`), so a worktree
groups under its parent repository on both axes. One family was still
splitting: every seat rotation's handoff digest runs in its own
`<state>/orchestrator/handoff-digests/<request>/cwd`, so each was a project
named `cwd`. A pure path recognizer now groups them under their container
("Handoff digests"), live or deleted. Two distinct projects that would still
read the same name on the page take a short piece of their key.

### Codex subagent threads

A Codex subagent thread writes its own rollout, and the registry can name the
parent's conversation for it. Keyed by that conversation, the thread's turns
were unioned into the parent's, so work the two did side by side counted once
and agent-hours ran low (about 3 h short for one project on one day). The
ingest now keys a Codex session whose `session_meta` names a subagent source
by the parent's conversation and the thread's own session
(`turnOwnerConversation`, `src/lib/activity/ingest.ts`). It keeps the parent's
project, role and pipeline stage. Agent-hours and the agent count rise;
wall-clock stays the same. Turns already stored before this rule keep their old key.
No production store had been written when it landed.

### Cost, measured on the operator's workstation

| pass | transcripts | read | time | rows |
|---|---|---|---|---|
| backfill, all history | about 10,000 | 26 GB | 95-105 s of work over 25 passes of at most 1 GB, the longest 7 s, yielding between 32 MB pieces | about 270-320 rows (inputs and turns) per second, 200-240 MB/s |
| steady state, nothing new | same | only new bytes | about 0.1 s per pass | — |

Memory: the process's resident size rises by about 550-650 MB at the peak of
the backfill, the allocator's high-water mark while parsing a few very large
Codex rollouts, independent of the per-pass budget, and falls back to within
about 60-150 MB of its starting size after it; a steady-state pass adds
nothing measurable. The store holds the whole history in about 15 MB. The
stage box, with about 350 transcripts, backfills in 2.5 s. A pull of its whole
history is about 1,300 rows in one page, under 2 s over ssh.

## Prior work: what is reused and what is wrong or missing

| prior work | what it is | reused | wrong or missing for this dashboard |
|---|---|---|---|
| #473 WakaTime sync (`src/lib/wakatime/sync.ts`, `docs/design/wakatime-integration.md`) | 60 s scheduler that turns scanner turn windows into WakaTime heartbeats | the idea of turn windows, and the operator/agent provenance split | Agent turns and operator points go onto **one** WakaTime timeline, which unions them (`docs/wakatime.md`, "Activity mapping"), so WakaTime totals cannot supply either axis on its own. The stream state is keyed by opaque digests with no role or pipeline, and it exists only while enabled. It needs an external account and network. Rejected as a source. |
| #763 Phase 0 (`src/lib/wakatime/operatorActivity.ts`) | `recordDirectOperatorWakatimeActivity` at every validated operator ingress | **the ingress sites and the authority rule** | Returns `null` unless `LLV_WAKATIME_ENABLED=1`. A point is queued in the WakaTime outbox and deleted after delivery, so nothing local survives. It carries no surface and no kind. When attribution fails it throws, and callers refuse the action. The dashboard ledger never refuses. |
| #763 issue body (never built) | operator-event ledger, 30-min episodes, 0.5 h rounding, #zvit delivery | the episode parameterisation | Never implemented. Its `max(last - first, 10 min)` gives the last request of a long episode no window, which correction 1 rules out. The delivery half belongs to #zvit and stays out of scope. |
| scanner activity model (`src/lib/scanner/activity.ts`) | point-in-time liveness from mtime and tail turn state | nothing for ranges | It has no history: every verdict is relative to *now*, and its tail parse covers under 5% of recent transcripts. |
| view presence heartbeat (`src/hooks/useViewPresence.ts`) | device kind, visibility and input sequence every 10 s | the device rule, moved to `src/lib/view/device.ts` | Screen input is not a request; a new view session counts as input on its first heartbeat. Not used for time. |
| transcript search index (`src/lib/search/transcriptSearch.ts`) | incremental full-history index of message rows | **the agent-axis source** | No tool-only records, so turns are approximate (measured below); no time index before this change. It cannot supply human input: it drops the provenance fields the operator-only rule needs. |
| delivery provenance (`src/lib/runtime/claudeMessageProvenance.ts`, `submissionIdentity.ts`, `codexStructuredUserText.ts`) | per-row operator/agent origin of Delegatus deliveries, and the client message id | **the positive operator signal and the request key** | Present only on a host that runs Delegatus and still holds its delivery ledgers. |

## Sources inventory

### Human axis, source 1: the request ledger (this host)

Every site below already classifies the caller with
`directOperatorActivityAuthority` (`src/lib/agent/operatorAuthority.ts:139`),
which refuses agents that present their conversation capability and Viewer
services (monitor, MCP, orchestrator) that present the signed service header.
The ledger call sits beside the WakaTime call, after it, and never refuses.

| # | surface of the request | kind | site (current tree) |
|---|---|---|---|
| 1 | browser composer send (legacy host path) | `message` | `src/app/api/conversation-host/handlers.ts:150` |
| 2 | dialog key in a pending CLI dialog | `dialog` | same helper, called for `dialog-key` |
| 3 | structured send / steer / inject / answer | `message`, `answer` | `src/lib/runtime/http.ts:275` |
| 4 | pending-question answer | `answer` | `src/app/api/answer/route.ts:141` |
| 5 | task send, recorded once however many agents it reaches | `message` | `src/app/api/tasks/[id]/send/route.ts:106` |
| 6 | task spawn | `spawn` | `src/app/api/tasks/[id]/spawn/route.ts:324` |
| 7 | direct spawn | `spawn` | `src/lib/agent/spawnCommand.ts:478` |
| 8 | final utterance in a live voice call | `voice` | `src/lib/runtime/realtimeControl.ts:427` (user agent passed by `src/app/api/runtime/realtime/route.ts`) |
| 9 | pipeline decision answer | `decision` | `src/app/api/pipelines/[id]/route.ts:96` |
| 10 | pipeline create | `pipeline` | `src/app/api/pipelines/route.ts:140` |
| 11 | task create, and task edit of text, details or status | `task` | `src/app/api/tasks/route.ts:64`, `src/app/api/tasks/[id]/route.ts:56` |

The ledger covers nothing by itself (`scope: "delegatus"`,
`src/lib/activity/hostSources.ts:143`). It records every Delegatus request
and nothing typed into an agent's terminal on the same host, so the host is
read only where its own transcript export covers (`scope: "all"`, `:260`).
Until one does, this host's figures carry `≥` and the hosts table says why.

Board moves, colours, icons, links and hides instruct no agent and are not
recorded. **Surface** comes from the request's `User-Agent` through
`requestSurface` (`src/lib/view/device.ts`): `desktop`, `tablet`, `phone`, or
`other` for a caller with no browser user agent. Delegatus ships no native
desktop app, so "web" and "desktop" are one surface: a desktop browser.

### Human axis, source 2: a host's transcript export

`scripts/export-human-input.ts` runs on the host it reads. Its core is
`src/lib/activity/transcriptExport.ts` and the rules are in
`src/lib/activity/humanInput.ts`.

| fact | where it comes from |
|---|---|
| the stores | the Claude and Codex homes (`ROOTS`, `src/lib/scanner/roots.ts`), every account store and retired archive (`claudeProjectRoots`, `codexSessionRoots`), the shared mirror (`sharedClaudeProjectsRoot`), and any `--root` |
| which files | every `.jsonl` modified since the window began (`listTranscriptFiles`); the date directory a session was filed under is ignored |
| Claude record | `type: "user"` with text: `uuid`, `promptId`, `promptSource` (`typed`, `sdk`, `system`), `turnOrigin`, `isMeta`, `isSidechain`, `isCompactSummary`, `entrypoint`, `cwd`, `timestamp` (`parseClaudeUserRecord`) |
| Codex record | `response_item` message with role `user`: its `id`, the `llv:structured-user` marker read by the runtime's own `decodeCodexStructuredUserText` (`src/lib/runtime/codexStructuredUserText.ts:89`: origin, and the 64-hex delivery key in either the compact `ctx` form or the legacy `dedup` form), `timestamp`; the session's `session_meta` `originator`, `source` and `cwd` (`parseCodexUserRecord`, `codexSessionKind`) |
| origin of a delivery | the marker; otherwise `claudeMessageProvenance` and `submissionIdentities` (keyed by the same 64-hex delivery key) on a host that runs Delegatus, which also give the client message id |
| how a conversation was launched | the host registry: a pipeline membership (stage), a lineage edge or delegation depth of 1 or more (delegated spawn), otherwise the operator; unknown when the registry is skipped (`--no-registry`), unreadable, or does not name the transcript |
| project | the registry's ownership, else the conversation's cwd through `resolveProjectAttribution` |

The export is placed under `activity/hosts/<host>/` on the host that runs the
dashboard. The source reads every file there; each file's manifest names the
span it speaks for (`exportSource`, `src/lib/activity/hostSources.ts`).

### Expected hosts and settings

| file | shape | default when absent |
|---|---|---|
| `activity/hosts.json` | `{ v: 1, local: { id, label }, hosts: [{ id, label, projects, since, pull? }] }`, `pull` = `{ ssh, bun?, stateDir?, everyMin? }` | this host is `local`; no other host is expected unless it has an export directory |
| `activity/settings.json` | `{ v: 1, tz, billable: [project keys], workdays: [0-6] }` | Europe/Kyiv, nothing billable, Monday to Friday |

`projects` scopes a host (`"all"` or a list): its absence makes only those
projects unknown. `since` says when the host started holding work.

### Agent axis

| fact | source | site |
|---|---|---|
| message rows (path, speaker, time) for every indexed transcript | `transcript-search.sqlite` through `readTranscriptActivity` | `src/lib/search/transcriptSearch.ts:763`; covering index at `:269` |
| which transcripts are indexed, with the board's project | scan catalog feed | `src/lib/scanner/discover.ts` (`transcriptIndexFeed`) |
| conversation and role for a path | registry | `conversationForPath`, `conversationAgentRole` (`src/lib/agent/spawnAdmission.ts:275`) |
| pipeline and stage | registry memberships of kind `pipeline` (container id, stage id), which survive pipeline archival | `src/lib/activity/agentSource.ts` |

### Sources considered and not used

| source | why not |
|---|---|
| WakaTime API or state | Operator and agent time are unioned in one timeline, only while enabled, drained after delivery. |
| Runtime journal events | Keeps the newest 20,000 rows, which is days. |
| Presence heartbeat | It measures screen input, and the method counts requests. |
| Reading transcripts live on each dashboard request | Five gigabytes on this host alone; the export runs once per host and the dashboard reads its small result. |

## Counting method

The operator's method as one parameterised definition, implemented in
`src/lib/activity/method.ts` and checked by `method.test.ts`.

### The three statements of the method

- **Original.** Each operator message opens a 10-minute window; windows
  combine; covered minutes are weighed per clock hour: 10-39 min = 0.5 h,
  40+ min = 1 h; fan-out and copies dedupe; generated prompts are excluded.
- **Refinement (2026-07-29).** Supervised spans between messages closer than
  T = 30 min count whole; round to 0.5 h.
- **Restated (2026-09-24), and used for the recount the operator accepted.**
  10-minute window per operator message, windows combined within each clock
  hour, the weights above, one hour to one project, days and hours in
  Europe/Kyiv.

### One definition

| parameter | meaning | default | allowed |
|---|---|---|---|
| `W` | engagement window after each input | **10 min** | 10-15 min (clamped) |
| `T` | a gap to the next input above `T` ends the episode | **= W** | `W` to 120 min (clamped; below `W` becomes `W`) |
| `rounding` | raw minutes to report hours | **`clock-hour`** | `clock-hour`, `half-hour` |
| `tz` | the zone of days and clock hours | **Europe/Kyiv** (settings) | any IANA zone; an invalid one falls back to the settings zone |

Inputs are the merged, deduplicated human inputs of every expected host,
read from `T` before the first day so an episode reaching into the range is
counted exactly.

1. **Episodes, per project, across hosts.** Sort one project's inputs by time.
   Consecutive inputs at most `T` apart share an episode, which covers
   `[first, last + W]`, clipped at now. With `T = W` the episodes are exactly
   the union of the per-input windows.
2. **One minute is counted once.** The union of every episode is cut into
   segments; each segment belongs to the most recent input at or before it
   among the episodes covering it. That input's project, host, surface and
   kind label the minutes, so the per-project, per-host, per-surface and
   per-kind figures all partition the same total.
3. **Days and hours.** Each minute falls in the day and clock hour of the zone
   where it lies. A session that runs past midnight puts each message on its
   own day. Day length follows the zone (a 25-hour day on 2026-10-25 in Kyiv).
4. **Report hours.**
   - `clock-hour`: every window in a clock hour combines; the hour's covered
     minutes weigh under 10 = 0, 10-39 = 0.5 h, 40+ = 1 h; the hour goes to the
     project with the most of its minutes (a tie to the more recent input).
   - `half-hour`: each project's raw time per day rounds to the nearest 0.5 h
     (a tie rounds up), and any non-zero time is at least 0.5 h.
5. **Billable.** The billable figure repeats steps 1-4 on the billable
   projects' inputs alone, as a paid report would, so a request to another
   project never takes a billable minute. A billable project's own report
   hours, on its row and its page, are this count
   (`docs/design/worktime-matches-zvit.md`); the day's total over every
   project keeps steps 1-4.

Raw minutes stay the primary figure; report hours are secondary and name
their mode.

## Cross-host human input

### Only real operator input counts

`classifyUserRecord` (`src/lib/activity/humanInput.ts:262`) keeps a record
only on a positive signal:

1. the `llv:structured-user` marker with operator origin (`ctx=o.…` or
   `origin=operator`);
2. the host's delivery provenance naming the operator, which also yields the
   client message id;
3. the engine's own record that a person typed it (`promptSource: "typed"` or
   `turnOrigin: "human"`), surface `terminal`.

Everything else is excluded and counted by reason in the export manifest,
which the page lists per host:

| reason | what it catches |
|---|---|
| `scaffold` | the first prompt of a delegated spawn, or an unmarked role scaffold of an operator launch |
| `stage-template` | a pipeline stage's first prompt (builder, reviewer, auditor, deployer…), marked or not |
| `unregistered` | the first message of a Delegatus session the host's registry does not name, marked or not |
| `notification` | task, bridge, seat and recovery notifications, `promptSource: "system"`, compaction summaries |
| `recovery` | a notice Delegatus sent into a conversation it re-hosted after a restart or a release, marked or not |
| `injected` | system reminders, skill hints, AGENTS.md and environment context, local command output, other `isMeta` records |
| `attachment` | an auto-attached screenshot (`isMeta` image records) |
| `agent-message` | a message from one agent to another that arrived with role=user (`a.` marker, or provenance naming an agent) |
| `subagent` | a Claude sidechain or a Codex subagent session |
| `automation` | `codex exec` sessions and SDK sessions no Viewer owns |
| `interrupt` | an interrupt marker |
| `unmarked` | no positive signal at all |
| `duplicate` | a copy of an input already counted |

Two of these exist because the operator marker is not proof by itself:

- **Restart notices.** At startup Delegatus sends "Continue the interrupted
  turn from the transcript." to every interrupted Codex conversation, and an
  interruption notice to every conversation whose turn it cut. Both were sent
  with no origin, and the Codex host stamps a send with no origin as the
  operator's, so each restart wrote one operator-marked record per
  conversation; the fan-out rule then collapsed them into one input per host,
  a fabricated window per restart. Both sends now carry the agent origin
  `startup-recovery` (`src/lib/runtime/recoveryNotices.ts`), and the
  classifier excludes their text whatever the marker says, which catches the
  records already written.
- **Unregistered sessions.** Pipeline and orchestrator spawns write their
  first prompt with the operator marker (a spawn at delegation depth 0 is
  stamped operator). Only the registry's launch record tells a stage template
  from an operator's own spawn, so when it is missing the first message of a
  Delegatus-hosted session is excluded. This undercounts an operator spawn the
  registry lost, which is the safe direction.

### Copies count once

1. **The id rule.** Records that share any stable id are one input: Claude
   `promptId` and `uuid`, the Codex item `id`, the delivery key in a marker, and
   the request key from provenance (the same key the request ledger stores).
   Mirrors, account-store copies, resumes and continuations copy these ids.
2. **The fallback rule, only between inputs no id joins.** Identical canonical
   content (the marker line dropped, whitespace collapsed) within 90 s of the
   input's first copy is one input. This catches an id-less copy and a
   Delegatus fan-out, whose copies in different conversations each got their
   own ids. Two records of one conversation that both carry ids stay two.
   Only a SHA-256 of the canonical content is kept.
3. **Across hosts.** The merge applies the id rule over every host, and the
   fallback rule between hosts (same hash within 90 s).
4. **The ledger and the transcripts of one host.** Inside the span a host's
   ledger covers, that host's transcript inputs that came through Delegatus
   (surface `unknown`) are dropped: the ledger recorded each Delegatus request
   once, at ingress, fan-out included. Terminal-typed input still counts from
   the transcripts.

Duplicates change request counts. They barely change hours, because a copy
within 90 s adds at most 90 s to a union of 10-minute windows.

### Coverage: unknown is never zero

`uncoveredSpans` (`method.ts:589`) returns, for a window and optionally a
project, the stretches some expected host holding that project was not read
for. A host is read where a transcript export of it covers; the ledger's span
does not count toward this (see source 1). A day, a project row and the range each carry `{ complete, missingHosts }`:

- complete: the figure is exact, and a zero is a real zero;
- incomplete with time read: the figure is a lower bound, shown `≥ 2 h 10 m`;
- incomplete with nothing read: `Unknown`.

A host listed with explicit projects gets a row for each of them even when
nothing was read, so a missing host's projects read `Unknown` and never vanish.
A host's `since` date removes the requirement before it.

### Probable missing source

A workday (Monday to Friday by default) is flagged when its human time is zero
and either an expected host was not read for it, or agents ran at least 30
minutes of wall-clock that day. The page shows "Probable missing source" in
the warning tone with an icon, never `0 m`.

## Agent axis calculation

This section describes the index approximation, which now serves only this
host until its ingest has finished a pass; see
[Agent axis from the same record](#agent-axis-from-the-same-record) for the
turns the page reads after that.

1. **Rows.** `SELECT id, speaker, transcript_path, timestamp FROM transcript_messages WHERE sort_timestamp BETWEEN ? AND ? AND timestamp IS NOT NULL`,
   from six hours before the range. The body is never selected.
2. **Turns per transcript.** A user row opens a turn that ends at the last
   assistant row before the next user row; assistant rows before any user row
   open a turn at the first of them. Empty and zero-length turns are dropped;
   turns clip to the range and to now.
3. **Conversation activity** is the union of its transcripts' turns.
4. **Per project and day:** wall-clock (at least one agent working),
   agent-hours (each agent counted), supervised (inside the same project's
   human episodes) and unattended.
5. **Provenance:** engine from the index, role from the registry, pipeline and
   stage from the registry's pipeline membership; anything unknown is
   `unregistered`.

**Accuracy (measured by the investigation, 2026-09-24).** Over 1,100
conversations active in 7 days the approximation totals 362.9 h against
356.7 h from the canonical turn classifier: +1.7% in aggregate, 19% mean
absolute deviation per conversation. The page labels agent figures `≈` and
shows no per-conversation durations.

**Query cost.** The covering index
`transcript_messages_time(sort_timestamp, speaker, transcript_path, timestamp)`
is created when the writer opens the database. On a synthetic index of 300,000
rows (199 MB), a 30-day read of about 100,000 rows took 77 ms on first read
and 67-69 ms warm through the index (`SEARCH … USING COVERING INDEX`), against
115-123 ms warm as a table scan with the index dropped; the investigation
measured 6.5 s for the cold scan on the real 5 GB table. The read goes through
the read-only query connection and is cached for 60 s per range and zone.

**This host only.** The agent axis reads this host's index. Agent work on the
stage host is not on the page yet (see Deferred).

## Coverage gaps

The page shows these in its "What is counted" panel, with a hosts table.

### By host

| host state | effect | shown as |
|---|---|---|
| read for the whole window | exact figures | plain figures |
| read for part of it (an old export, an export that started later) | lower bound | `≥` figure, hatched unknown stretch, tooltip naming the host |
| this host with its ledger read and no export for the stretch | lower bound: Delegatus requests counted, terminal input unread | `≥` figure, and a warning under the host in the hosts table |
| listed and never read | unknown | `Unknown`, "Not connected" in the hosts table, flagged workdays |
| its agent turns not read: listed with a pull that never answered (`pending`, `no-ingest`, `unreachable`), or read by an export alone | agent figures of the projects it holds, and every total, are a lower bound | `≥ ≈` on the Agents figure, the rows and the day tooltip; "Lower bound" on the chip; the drawer and the hosts table name the host |
| an export file for another host, or malformed | covers nothing | "unreadable" in the hosts table |

### By surface

| surface | observed and counted | not observed, or observed and not counted |
|---|---|---|
| Desktop browser | every request kind in the ledger table | reading and scrolling between requests, board moves |
| Tablet | same as desktop | same; an iPad that asks for the desktop site reads as desktop |
| Phone | same as desktop, including voice | same |
| Voice call | each final utterance in a live call | listening, partial speech, dictation never sent |
| Terminal | prompts an agent CLI records as typed by a person, through the host's export, this host's included | a client that records no such flag: excluded as unmarked; a stretch no export of the host covers: unknown |
| Other same-origin client | counted as `other` (the authority rule's documented residual) | whether a person was behind it |
| Outside Delegatus: editors, Telegram, GitHub review | nothing | all of it |

### By time and source

| gap | effect | shown as |
|---|---|---|
| Before a host's first ledger row or export span | unknown for that host | hatched, `Unknown` or `≥` |
| An unwritable ledger | that request is missing | one `[activity] request_not_stored` diagnostic with an outcome class |
| Agent approximation | turns ending in tool calls end early | `≈` on every agent figure |
| Transcripts not indexed (OpenClaw, deleted) | missing agent time | named in the panel |
| Registry misses | role and pipeline `unregistered` | a bucket in the breakdowns |
| Inputs with no resolved project | kept | a `No project` row |

## One project's page

The operator's request on 2026-09-24, paraphrased: filter the page by each
project to see how many hours went into it.

### What the server counts

`GET /api/activity?project=<key>` scopes `totals` and `days` to one project
(`ReportInput.scope`, `projectView` in `src/lib/activity/method.ts`). The
method runs over every input exactly as it does unscoped, and the view keeps
the project's share of what it decided:

| figure | the project's share |
|---|---|
| your minutes | its segments after one-minute-once, so a minute a later input to another project took stays there |
| report hours | the clock hours it won (`clock-hour`), or its rounded day (`half-hour`) |
| billable | its hours in the billable-only pass; 0 for a project not tagged billable |
| requests | its inputs in the range |
| agent split and agent-hours | its agents against its own episodes, unclear where a host holding it was not read |
| coverage, both axes | the hosts that can hold it |
| a day's flag (probable missing source) | kept: it is a fact of the day, and that day's input was not read for this project either |

Each figure is therefore the number the project's row carries in the unscoped
answer, which `report.test.ts` and `route.test.ts` check for every project and
range, and `projects` still lists every project. An hour's weight goes to the
project only when it won the hour, so the Rhythm cells of a day still add up to
its report hours. An older key of a project names it. An empty, overlong or
control-character key scopes nothing. The row with no project cannot be
chosen. Each host row carries `inScope`: whether it can hold the project, so
the Today bands, the drawer's flags and "nothing read" consider only those.

### What the page shows

- A click on a project's row scopes the page to it and opens the row; a
  second click, or the chip beside the title, returns to every project.
- The header's picker (`ActivityProjectPicker`) lists every project of the
  range with your hours and agent time, filtered by name as you type, since
  the list folds what does not fit into "+ N more".
- The choice is `?project=`: a click is a history step Back undoes, the
  range and view switches keep it, and a reload opens it.
- Your time reads `Unknown` wherever it is zero and a host holding it was
  not read, on every page and every figure.

### Agent time a host did not send

An agent turn reaches this Viewer only through a host's own record: this
host's ingest (or the index before the ingest's first pass) and another
host's pull. `HostCoverage.agents` holds what each host's turns were read
for (`agentSpans`, `src/lib/activity/report.ts`), and `agentCoverage` sits
beside `coverage` on the range, each day and each project. A host listed in
`hosts.json` whose pull never answered, or that only an export reads, leaves
every agent figure that misses it a lower bound: `≥ ≈` on the figure, the
chip at "Lower bound", and the host named in the drawer and the hosts table.

## Privacy boundary

- **Ledger rows** (`activity/requests-YYYY-MM-DD.jsonl`, mode `0600`,
  directory `0700`, 90-day retention) hold exactly
  `{ v, key, at, kind, surface, project }`. The key is
  `sha256("delegatus-activity-request-v1\0" + idempotencyKey)`, or random.
- **Export rows** hold a manifest `{ v, type, host, coveredFrom, coveredUntil, exportedAt, records, excluded }`
  (counts only) and one line per input
  `{ v, type, ids, hash, at, host, project, kind, surface }`. The ids are
  SHA-256 digests of the raw ids under a domain string; the hash is a SHA-256
  of the canonical content. No text, path, session id or title is written.
  The exporter reads text only in memory, to classify and to hash.
- **The agent query** selects no body; transcript paths never leave the
  server.
- **API and UI** carry times, durations, counts, enums, project keys and
  names, host ids and the operator's own host labels, pipeline and stage ids,
  and role ids. No titles, model names or account names.
- **Fixtures and tests** use invented projects, ids, hosts and text.
- **#zvit fence.** `src/lib/wakatime/**` is untouched; the ledger call sits
  beside the WakaTime call.

## Prototype scope

### What it does

- `src/lib/activity/method.ts` (pure): parameters, interval algebra, the
  zone calendar, episodes, one-minute-once segments, both roundings, the
  billable pass, agent turns, host coverage, the missing-source flag, and
  `activityReport`.
- `src/lib/activity/humanInput.ts` (pure): record parsing for both engines,
  session kinds, the operator-only classifier, the dedupe rules, the merge
  across sources and hosts, and the export row format.
- `src/lib/activity/transcriptExport.ts` and `scripts/export-human-input.ts`:
  the per-host exporter (`--host`, `--from`, `--to`, `--tz`, `--out`,
  `--root`, `--only-roots`, `--no-registry`). It claims the `tool` state
  owner, reads the registry and delivery ledgers, and writes only its `--out`.
- `src/lib/activity/hostSources.ts`: `hosts.json`, the ledger source, the
  export source, and `readHumanInputs`.
- `src/lib/activity/requestLedger.ts`: `recordOperatorRequest` at the eleven
  ingress sites and `readRequests`.
- `src/lib/activity/agentSource.ts`, `settings.ts`, `report.ts`, and
  `GET /api/activity` (`range`, `tz`, `window`, `break`, `rounding`, all
  clamped; behind `rejectCrossOrigin`).
- `src/lib/view/device.ts`: the device rules, shared by the presence heartbeat
  and the ledger.
- `/activity` (`src/app/activity/page.tsx`,
  `src/components/activity/ActivityDashboard.tsx`), reached from the desktop
  rail's "More" menu and the phone's board menu: range and view controls,
  four tiles (your time with report hours and the billable figure when
  configured, agents working, supervised agent time with its split, agent-hours),
  a day view with a two-lane 24-hour strip per day, a project ranking with
  breakdowns by host, surface, input kind, engine, role and pipeline, and the
  "What is counted" panel with the hosts table. English and Ukrainian.

### Tests, by path

- `src/lib/activity/method.test.ts`: W and T, `T = W` equals the union of
  windows, the clip at now, one minute once across projects, surface and kind
  partitions, fan-out, agent-only time adds nothing, a long unattended run,
  the supervised split, both roundings including hour-level clock weights, the
  Kyiv midnight split and the 25-hour day, the defaults, two hosts (remote
  input with complete coverage; the remote host missing gives unknown and a
  flag), project-scoped hosts, `since`, a session crossing midnight in Kyiv, the
  missing-source flag on a workday and not on a Sunday, and the billable pass.
- `src/lib/activity/humanInput.test.ts`: marker-only counting, a
  worker-to-manager role=user message excluded, the typed flag, each exclusion
  reason, restart notices excluded with the operator marker on them, an
  unregistered session's marked first message excluded, one delivery id for
  the compact and legacy marker forms and none for a forged one, session
  kinds, mirror and continuation copies once, the 90 s fallback,
  same-conversation messages kept apart, fan-out, cross-host dedupe, ledger
  precedence, and an export round trip with no text.
- `src/lib/activity/transcriptExport.test.ts`: files chosen by mtime, each
  message on its own Kyiv day, the manifest's exclusion counts, a restart that
  reaches four conversations adding no human time, an unregistered stage
  session, context over keywords for the project, and no text or path in the
  export.
- `src/lib/activity/hostSources.test.ts`: the two-host fixture with real
  export files (complete, then the stage host missing), a ledger alone leaving
  its host incomplete and a partial export of it, an export that ends early, a
  mislabelled file, cross-host dedupe, and the hosts file.
- `src/lib/runtime/startup.test.ts`: the Codex continuation carries the
  `startup-recovery` origin.
- `src/lib/activity/requestLedger.test.ts`, `src/app/api/activity/route.test.ts`,
  `src/lib/runtime/http.activityLedger.test.ts`,
  `src/app/api/tasks/activityLedger.test.ts`, and the exporter's case in
  `src/lib/stateOwnership.entryPoints.test.ts`.

### Renders

The `activity` case of `scripts/capture-board-geometry.ts`
(`BOARD_CAPTURE_CASE=activity`) seeds a home with invented projects, a local
ledger, this host's own export up to last midnight (with a few terminal
prompts), a stage host export that stops two days back, invented transcripts
indexed by the Viewer's own scan, and `hosts.json`, then captures at
1440 x 900 and 390 x 844: the day view, the project view with one row
expanded, the unknown-coverage state (the stage host not read for the last two
days, and today's terminal input on this host not exported yet, which the
hosts table names), and a home with no data at all. Output:
`~/Pictures/delegatus-review/activity-dashboard/`.

### What it does not do

- No settings UI; `hosts.json` and `settings.json` are edited as files.
- No per-conversation or per-stage durations.
- No change to WakaTime, #zvit or their data. The only schedule is the pull,
  which rides the transcript index's pass.

## Deferred — not currently justified

| item | why deferred | what would justify it |
|---|---|---|
| A remote host's request ledger | The pull carries its transcript records, which hold every Delegatus delivery there too (surface `unknown`); the ledger would add the browser surface. | Per-surface figures for the stage host. |
| A canonical turn-window index | The approximation is within 1.7% in aggregate. | Per-conversation agent durations become a requirement. |
| Settings UI for hosts, zone and billable tags | Files cover the prototype. | The operator edits them regularly. |
| Viewing time from the presence heartbeat | Not engagement under the method. | The method changes. |

## Options considered

| decision | options | chosen and why |
|---|---|---|
| Human source | ingress ledger / transcripts / WakaTime / presence | **Both the ledger and per-host transcript exports**: the ledger is exact with a surface; transcripts are the only record on a host without the ledger and for history, and they are what the operator's recount used. |
| Reading remote hosts | live reads / network pull / exported files | **Exported files**: the dashboard stays cheap, the exporter runs where the stores and delivery ledgers are, and nothing crosses a host boundary but ids, hashes and times. |
| Counting unmarked records | count / exclude and report | **Exclude and report per reason**, as correction 3 asks. |
| Defaults | refinement (T = 30, half-hour) / restated method (T = W, clock-hour) | **The restated method**, which the operator used for the accepted recount; the refinement stays a parameter. |
| Clock-hour weight | winner's minutes / the hour's combined minutes | **The hour's combined minutes**, since windows combine within the hour before it is weighed and given to one project. |
| Cross-project minutes | per project / priority list / most recent input | **Most recent input**: rows sum to the total. |
| Where the page lives | a hash route in the board / `/activity` | **`/activity`**, independent of the board's state. |

## Validation against the requirement

| requirement | how the prototype meets it |
|---|---|
| Human time and agent time separately, per day and per project, range picker | Two axes with their own tiles, lanes and bars; day and project views; Today / 7 days / 30 days. |
| Human time from real interaction, each source named with its surface | Ledger rows carry the browser surface; exports carry `terminal` or `unknown`; the surface table says what each contributes. |
| Coverage gaps stated and visible | Hosts table, hatched unknown stretches, `≥` and `Unknown` figures, the surface and gap tables. |
| Agent provenance: engine, role, pipeline/stage, conversation | Breakdowns by engine, role and pipeline with stage ids; conversations counted per project. |
| Supervised agent work counts, unattended never does (correction 1) | Episodes cover supervised spans; only operator input opens them; the agent axis is split. |
| Human input from every host, unknown never zero (corrections 2, 3.1) | Per-host sources, `hosts.json`, coverage per day and project, the two-host tests. |
| Dedupe by ids, 90 s hash fallback (2.2, 3.2) | The id rule, the fallback rule, cross-host merge, ledger precedence; tested. |
| Only real operator input (2.3, 3.3) | Positive signals only; exclusions counted per reason; tested for relays, stage prompts and role=user worker messages. |
| Messages bucketed by their own time in Kyiv (3.4) | Anchors carry their own time; files chosen by mtime; zone from settings; tested across midnight. |
| Project from context (3.5) | Registry ownership or cwd; tested against a name in the text. |
| Probable missing source (3.6) | The workday flag; tested; shown in the warning tone. |
| The operator's method, parameterised, defaults stated | `W = 10`, `T = W`, clock-hour, Europe/Kyiv; refinement by parameter. |
| Privacy | Six-key ledger rows; export rows with digests and a hash; no body anywhere. |
| #zvit untouched, no deploy, no merge | WakaTime code unchanged; PR left open; tests and builds on isolated roots; renders from a seeded home. |
