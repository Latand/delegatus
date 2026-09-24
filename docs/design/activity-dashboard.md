# Activity dashboard: human interaction time and agent activity per project

- Status: design for a prototype (one builder stage, PR left open, no deploy, no merge)
- Grounded base: `main` at `bfd58b846fa21e84138b7e74f64f0fb34c73b852`
- Prior work read: #473 (WakaTime integration), #763 and its landed Phase 0 (#767, #1017, #1623), the scanner activity model, the view presence heartbeat, the transcript search index

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

### Operator correction, 2026-09-24 (paraphrased by the orchestrator)

It replaces the specification line "agent work never counts toward human
hours" and is the basis of the counting method below.

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

The elided part of point 4 points at the operator's reference memory
`worktime-zvit-method.md` and restates both versions of the method. They are
summarised in [Counting method](#counting-method) below.

## Decision

1. **Human axis.** Each validated direct-operator request is recorded once, at
   the server ingress that admits it, into a new local append-only request
   ledger. The ledger holds a timestamp, a kind, a surface, a project key and a
   dedupe key. It does not depend on `LLV_WAKATIME_ENABLED` and it does not
   touch the WakaTime queue. Human time is the operator's episode method
   applied to those requests (defaults: 10-minute window, 30-minute break,
   rounding to the nearest half hour).
2. **Agent axis.** Agent activity is built from the full-history transcript
   search index that the Viewer already maintains (`transcript-search.sqlite`).
   The query reads only path, speaker and timestamp. A turn is taken as the span
   from a user message to the last assistant message before the next user
   message. Provenance comes from registry and pipeline joins: engine, role,
   pipeline, stage and conversation.
3. **Overlap.** Agent wall-clock time is split into *supervised* (inside a
   human episode of the same project) and *unattended* (everything else). The
   two axes are shown side by side and neither is subtracted from the other.
4. **Page.** A `/activity` page with desktop and phone layouts, backed by a
   pure calculation module and one `GET /api/activity` route.
5. **Coverage.** Human history starts on the day the ledger is installed.
   Earlier days are drawn as *not recorded*, which is different from zero.
   Every gap below is also shown in the UI.

## Prior work: what is reused and what is wrong or missing

| prior work | what it is | reused | wrong or missing for this dashboard |
|---|---|---|---|
| #473 WakaTime sync (`src/lib/wakatime/sync.ts`, `docs/design/wakatime-integration.md`) | 60 s scheduler that turns scanner turn windows into WakaTime heartbeats | the idea of turn windows, and the operator/agent provenance split | Agent turns and operator points go onto **one** WakaTime timeline, which unions them (`docs/wakatime.md`, "Activity mapping"), so WakaTime totals cannot supply either axis on its own. The stream state is keyed by opaque digests with no role or pipeline, and it exists only while enabled. It also needs an external account and network. Rejected as a source. |
| #763 Phase 0 (`src/lib/wakatime/operatorActivity.ts`) | `recordDirectOperatorWakatimeActivity` at every validated operator ingress | **the ingress sites and the authority rule**: they are exactly the request events the method needs | Returns `null` unless `LLV_WAKATIME_ENABLED=1` (`operatorActivity.ts:69`). A point is queued in the WakaTime outbox and deleted after delivery, so nothing local survives. It carries no surface and no kind. When attribution fails it throws, and callers refuse the action (`http.ts:267`, `tasks/[id]/spawn/route.ts:318`). A dashboard ledger must never do that. |
| #763 issue body (never built) | operator-event ledger, 30-min episodes, `max(last - first, 10 min)`, 0.5 h rounding, #zvit delivery | T = 30 min and 0.5 h rounding survive as defaults | The ledger, episode calculator and rollup were never implemented. The issue closed on Phase 0, which re-scoped it to WakaTime emission. `max(last - first, 10 min)` gives the **last** request of a long episode no window, which the correction rules out ("at least a 10-15 minute engagement window per request"). The delivery half belongs to #zvit and stays out of scope. |
| scanner activity model (`src/lib/scanner/activity.ts`) | point-in-time liveness: `live` / `recent` / `stalled` / `idle` from mtime and tail turn state (20 s, 180 s, 900 s; `activity.ts:425-455`) | nothing for ranges | It has no history: every verdict is relative to *now*. `recentTurnWindowsFor` (`turnDuration.ts:131`) parses only the 128 KiB tail (`activity.ts:350`). Of the 2,135 transcripts written in the last 30 days (5.2 GB), 2,026 are larger than that tail, so tail windows cannot reconstruct a week. |
| view presence heartbeat (`src/hooks/useViewPresence.ts`, `src/lib/view/presenceStore.ts`) | every 10 s: device kind, visibility, `inputSequence` on pointerdown / keydown / touchstart / wheel, project on screen | the device classification (`detectDeviceKind`, `useViewPresence.ts:71`) moves to a shared pure module | It keeps 120 s of state (`presenceStore.ts:34`). It measures screen input, which is not a request, so the method does not count it (see Deferred). A new view session counts as an interaction on its first heartbeat, with no input (`presenceStore.ts:249`), so it would inflate time if it were ever used. |
| transcript search index (`src/lib/search/transcriptSearch.ts`) | incremental full-history index of user and assistant message rows with timestamps, project and engine | **the agent-axis source** | It holds no tool-only records, so it can only approximate turns (measured below). It has no index on time: a range query scans the table (measured below). |

## Sources inventory

### Human axis: direct-operator request ingress (recorded by the new ledger)

Every site below already classifies the caller with
`directOperatorActivityAuthority` (`src/lib/agent/operatorAuthority.ts:139`).
That function refuses agents that present their conversation capability and
Viewer-internal services (monitor, MCP, orchestrator) that present the signed
service header. Anything else that is same-origin counts as the operator.

| # | surface of the request | kind | site | status |
|---|---|---|---|---|
| 1 | browser composer send (legacy host path) | `message` | `src/app/api/conversation-host/handlers.ts:133-148` (`recordAuthorizedOperatorActivity`), called at `:387` | existing WakaTime hook; add ledger |
| 2 | dialog key in a pending CLI dialog | `dialog` | same helper, called at `handlers.ts:291` | existing; add ledger |
| 3 | structured send / steer / inject / answer | `message` (`answer` for answer) | `src/lib/runtime/http.ts:257-266` | existing; add ledger |
| 4 | pending-question answer | `answer` | `src/app/api/answer/route.ts:128-130` | existing; add ledger |
| 5 | task send (fan-out to the task's agents) | `message`, recorded once per request | `src/app/api/tasks/[id]/send/route.ts:89-91` | existing; add ledger |
| 6 | task spawn | `spawn` | `src/app/api/tasks/[id]/spawn/route.ts:311-313` | existing; add ledger |
| 7 | direct spawn | `spawn` | `src/lib/agent/spawnCommand.ts:454-470` | existing; add ledger |
| 8 | voice: final user utterance in a live realtime call | `voice` | `src/lib/runtime/realtimeControl.ts:405-419` (only the live realtime peer is admitted) | existing; add ledger |
| 9 | pipeline decision answer | `decision` | `src/app/api/pipelines/[id]/route.ts:57`, action `resolve-decision`, after success | **new** |
| 10 | pipeline create | `pipeline` | `src/app/api/pipelines/route.ts:112`, after success | **new** |
| 11 | task create, and task edit of text / details / status | `task` | `src/app/api/tasks/route.ts:29`, `src/app/api/tasks/[id]/route.ts:20`, after success | **new** |

Board layout moves, colours, hide/show, pins and attention dismissals are
interaction, but they are not requests: they instruct no agent. The method
does not count them, so they are not recorded.

**Surface** comes from the request's `User-Agent`, classified with the same
rule the presence heartbeat uses. `detectDeviceKind` moves from
`src/hooks/useViewPresence.ts:71` to a pure `src/lib/view/device.ts` that both
sides import. The classes are `desktop`, `tablet`, `phone` and `other` (no
browser user agent, for example a script calling the same-origin API).
Delegatus ships no native desktop application and no installable web-app
manifest (`public/` holds no manifest). The spec's "web" and "desktop" are
therefore one surface as far as the server can tell: a desktop browser. The
UI says so.

### Agent axis

| fact | source | site |
|---|---|---|
| message rows (speaker, seconds timestamp) for every scanned transcript, full history | `transcript-search.sqlite`, tables `transcript_files` and `transcript_messages` | schema `src/lib/search/transcriptSearch.ts:236-257`; row classification `:334-380` (text parts only, `:318`; tool results and tool-only records excluded) |
| which transcripts are indexed, with canonical project | scan catalog feed | `src/lib/scanner/discover.ts:185-220` (openclaw excluded) |
| paths removed from the scan are removed from the index | `options.complete` prune | `transcriptSearch.ts:549` |
| conversation id, engine, role for a path | registry | `conversationForPath` (`src/lib/agent/registry.ts:779`), `agentRole` (`:265`) |
| project attribution precedence | `resolveProjectAttribution` | `src/lib/session/projectResolution.ts` (fallback: the index's project, passed through `canonicalProject`) |
| pipeline and stage for a conversation | pipeline attempts | `src/lib/pipelines/types.ts:345` (`attempt.conversationId`), read with `loadPipelinesForList()` (`src/lib/pipelines/store.ts:1053`) |

### Sources considered and not used

| source | why not |
|---|---|
| WakaTime API or `wakatime-state.json` | Operator and agent time are unioned in one timeline. The data exists only while the integration is enabled and is drained after delivery. It needs network and a key. |
| Runtime journal events | Keeps the newest 20,000 rows (`docs/runtime-journal-retention.md`), which is days, not 30 days. |
| Claude delivery ledger (`claude-delivery-ledger/`, `src/lib/runtime/claudeStreamBrokerHost.ts:96-101`) and Codex `o.`/`a.` origin markers (`src/lib/runtime/codexStructuredUserText.ts:106-110`) | They could backfill operator messages from before the ledger existed, but the delivery ledger stores message bodies, and backfill needs the #763 canonical-instruction dedupe across fan-out, resume and account mirrors. Deferred. |
| Lifecycle journal (`src/lib/lifecycle/vocabulary.ts`) | Stage-level only; ad-hoc conversations are absent. |
| Presence heartbeat | Screen input, not requests. Deferred. |

## Counting method

This is the operator's method, taken from their reference memory
`worktime-zvit-method.md` and the refinement they approved on 2026-07-29
(used for a real sent report). It is written here as one parameterised
definition. The calculation module implements exactly this, and the review
stage checks the module against it.

### The two versions the operator used

- **Original.** Each human message opens a ~10-minute engagement window.
  Windows combine. Covered minutes are weighted per clock hour: 10-39 min =
  0.5 h, 40+ min = 1 h. Large gaps are breaks. Fan-out, copied and resumed
  sessions dedupe to one canonical instruction. Spawn, bridge and automation
  prompts are excluded.
- **Refinement (2026-07-29).** Upper-bound episodes: supervised spans count.
  An unattended gap longer than T = 30 min breaks an episode. Round to 0.5 h.

### One definition

Parameters:

| parameter | meaning | default | allowed |
|---|---|---|---|
| `W` | engagement window after each request | **10 min** | 10-15 min (clamped) |
| `T` | break threshold: a gap to the next request above `T` ends the episode | **30 min** | `W` to 120 min (clamped; `T < W` becomes `W`) |
| `rounding` | how raw minutes become report hours | **`half-hour`** | `half-hour`, `clock-hour` |
| `tz` | the IANA zone that decides days and clock hours | the browser's zone | any IANA zone; an invalid one falls back to the server zone |

Inputs are the **anchors**: the request events in the ledger for the range,
deduplicated by key, each with `at`, `project`, `surface` and `kind`.

1. **Episodes, per project.** Sort one project's anchors by time. Consecutive
   anchors whose gap is `<= T` belong to one episode. An episode covers
   `[first anchor, last anchor + W]`, clipped at *now*. A lone request covers
   exactly `W`.
2. **Raw human minutes.** For a project and a day: the length of the union of
   that project's episodes, cut at the day's boundaries in `tz`.
3. **One minute is counted once across projects.** The day's total is the
   union of all projects' episodes. A minute covered by episodes of several
   projects goes to the project of the most recent anchor at or before that
   minute. Per-project rows therefore sum to the total, and the rows show
   the overlapping minutes that were reassigned.
4. **Surface and kind breakdown.** Inside an episode, every minute belongs to
   the most recent anchor at or before it. Its surface and kind label the
   minute, so the breakdowns partition the same total.
5. **Report hours.**
   - `half-hour` (refinement): per project per day, raw minutes are rounded to
     the nearest 0.5 h, and any non-zero raw time is at least 0.5 h.
   - `clock-hour` (original): per clock hour in `tz`, each project's covered
     minutes are weighed as follows: under 10 min = 0, 10-39 min = 0.5 h,
     40+ min = 1 h. One clock hour goes to one project, the one with the most
     covered minutes in it (ties go to the more recent anchor).
   Raw minutes stay the primary figure. Report hours are the secondary one,
   and the chosen mode is named beside them.

**How the two versions reconcile.** With `T = W` the episodes are exactly the
union of per-request `[t, t + W]` windows, which is the original method. With
`T = 30 min` they are the refinement's upper-bound episodes. The defaults
(`W = 10`, `T = 30`, `half-hour`) are the refinement, because it is the later,
operator-approved version and was used for a real report. Unit tests pin both
readings.

**The one intended difference from the #763 issue text.** #763 wrote the
episode length as `max(last - first, 10 min)`, which gives the last request no
window whenever the episode is longer than 10 minutes. The correction says
every request has at least a `W` window, so an episode ends at `last + W`.

**What never opens or extends an episode.** Only direct-operator ingress
writes anchors. So these add zero human time, whatever the agents do:

- agent work after `last + W` when no next request comes within `T`;
- pipeline dispatch, seat ticks, monitors, flows and any other automation;
- delegated spawns, bridge relays, MCP `send_message` and injected prompts
  (refused by `directOperatorActivityAuthority`).

**Dedupe.** A request is recorded once, at admission. A fan-out task send is
one anchor, and resumed, copied or migrated transcripts never create
anchors. Retries share one key, because the key is a digest of the ingress's
existing idempotency key (`clientMessageId`, `clientRequestId`,
`clientAttemptId`, the realtime `operatorEventId`). This removes the need for
the #763 transcript dedupe on everything recorded from now on.

### What the method does not include

The operator's original method also adds WakaTime **editor** durations. The
specification limits human time to Delegatus surfaces, so editor time is out
of this dashboard, and the coverage panel says so.

## Agent axis calculation

1. **Rows.** `SELECT transcript_path, speaker, timestamp FROM transcript_messages WHERE sort_timestamp BETWEEN ? AND ? AND timestamp IS NOT NULL`,
   plus a small margin before the range start, so that a turn crossing the
   start is seen. The body column is never selected.
2. **Turns per transcript.** In time order, a `user` row opens a turn. The
   turn ends at the last `assistant` row before the next `user` row. Assistant
   rows before any user row open a turn at the first of them. Turns with no
   assistant row, or with zero length, are dropped. The last turn ends at its
   last assistant row. Every turn is clipped to the range and to *now*.
3. **Conversation activity** is the union of that transcript's turns.
   Transcripts that belong to one conversation (registry generations) are
   unioned together.
4. **Per project and day:**
   - *agent wall-clock*: the union over the project's conversations, meaning
     time when at least one agent worked;
   - *agent-hours*: the sum of per-conversation activity, meaning parallel
     work counted once per agent;
   - *supervised*: agent wall-clock inside the project's human episodes from
     step 1 of the counting method (before the cross-project reassignment);
   - *unattended*: agent wall-clock minus supervised. The same split is
     applied to agent-hours.
5. **Provenance per conversation:** engine (from the index), conversation id
   and `agentRole` (registry, via `conversationForPath`), pipeline id and stage
   id (pipeline attempts). Anything that does not resolve is `unregistered`.
   The breakdowns are by engine, by role, and the top pipelines by id.

**Accuracy, measured on a copy of real data (2026-09-24).** Over 1,100
conversations active in the last 7 days, this approximation totals 362.9 h,
against 356.7 h from the canonical classifier (`recentTurnWindowsFromRecords`,
`turnDuration.ts:55`) run over the full transcripts: +1.7% in aggregate.
Per conversation the mean absolute deviation is 19% (4,057 of 21,403
minutes), and 62 conversations are off by more than 20% or 5 minutes. The
largest misses are turns that ended in tool calls with no final text.
Per-project and per-day totals, which aggregate many conversations, are
reliable. Per-conversation and per-stage figures are not, so the prototype
shows no per-conversation durations. The UI labels agent time "approximate:
from message timestamps".

**Query cost, measured (read-only, 2026-09-24).** The time filter scans the
whole table: 6.5 s cold, 131-170 ms warm, 69,331 rows for 30 days. The
prototype adds one covering index when the writer opens the database, in the
same `CREATE INDEX IF NOT EXISTS` style the file already uses
(`transcriptSearch.ts:205`, `:215`, `:258`):

```sql
CREATE INDEX IF NOT EXISTS transcript_messages_time
  ON transcript_messages(sort_timestamp, speaker, transcript_path, timestamp);
```

The dashboard reads through the read-only query connection and never opens
the writer. The computed agent axis is cached in memory for 60 s per
`(range, tz)`. The builder measures the indexed query on a synthetic database
of 300k rows and puts the number in the PR. Nobody copies or migrates the
operator's index.

## Coverage gaps

The UI shows these in a "What is counted" panel and marks each affected day.

### By surface (human axis)

| surface | observed and counted | not observed, or observed but not counted |
|---|---|---|
| Desktop browser | every request kind in the ingress table | reading, scrolling and board browsing between requests (observable through presence, and not a request under the method); board layout edits; anything done in a terminal attached to an agent host |
| Tablet | same as desktop | same. An iPad that asks for the desktop site reads as `desktop` (user-agent rule) |
| Phone browser | same as desktop, including voice | same |
| Voice call (any device) | each final user utterance in a live realtime call | listening to the assistant, and partial speech. Dictation into the composer counts only when it is sent |
| Other same-origin client (script, CLI without a capability) | counted as `other`, because the authority rule treats it as the operator (the documented residual in `operatorAuthority.ts`) | whether a human was behind it |
| Outside Delegatus: editors, terminals attached to a host, Telegram, GitHub review | nothing | all of it. Zero here means *not observed* |

### By time and source

| gap | effect | shown as |
|---|---|---|
| Ledger install date | no human data before it | days before it drawn hatched as "Not recorded", never as 0 h |
| A ledger write that fails (disk, permissions) | that request is missing | one `[activity] request_not_stored` diagnostic with an outcome class; the action itself proceeds |
| Agent approximation | turns that end in tool calls with no final text end early; open or zombie turns end at their last text | "approximate" label on every agent figure |
| Transcripts that are not indexed | openclaw sessions, and transcripts deleted from disk (the index prunes them) | named in the panel |
| Index lag | the current turn appears after the next scan has indexed it | "updated <time>" beside agent figures |
| Registry or pipeline join misses | role and pipeline become `unregistered` | an `unregistered` bucket in the breakdowns |
| Human anchors with no resolved project | the time is kept | an `Unattributed` project row |

## Privacy boundary

- **Ledger rows** (`statePath("activity/requests-YYYY-MM-DD.jsonl")`, UTC day
  files, mode `0600`, directory `0700`) hold exactly
  `{ "v": 1, "key": <sha256 hex>, "at": <ms>, "kind": <enum>, "surface": <enum>, "project": <project key> | null }`.
  There is no conversation id, path, title, text, account or device id. The
  key is `sha256("delegatus-activity-request-v1\0" + idempotencyKey)`, or
  random bytes when the ingress has no key. The prototype keeps 90 days and
  prunes older day files when a new day file is created.
- **The agent query** selects no body column. Transcript paths never leave
  the server: the API names conversations by registry id and never by path.
- **API and UI** carry timestamps, durations, counts, enums, project keys and
  display names, pipeline, stage and conversation ids, and role ids. They
  carry no conversation, task or pipeline **titles**, because titles are
  derived from prompt text (a pipeline card's title is its prompt's first
  line). They carry no model names or account names.
- **Fixtures and tests** use invented projects, ids and times. The privacy
  gate runs on the PR. Render images stay outside the repository.
- **#zvit fence.** `src/lib/wakatime/**` and WakaTime payloads, cadence and
  state are untouched. The ledger call sits beside the existing WakaTime call,
  never inside it. #zvit reads WakaTime and its own sources, so nothing the
  prototype adds reaches it.

## Prototype scope

### What it does

**`src/lib/activity/method.ts` (pure, no I/O).** It holds the counting
method and the agent-axis calculation above:

```ts
interface MethodParams { windowMs: number; breakMs: number; rounding: "half-hour" | "clock-hour"; tz: string }
interface Anchor { at: number; project: string | null; surface: Surface; kind: RequestKind }
interface AgentRow { transcriptPath: string; speaker: "user" | "assistant"; atMs: number }
function clampMethodParams(input: Partial<Record<keyof MethodParams, unknown>>): MethodParams
function humanEpisodes(anchors: Anchor[], params: MethodParams, nowMs: number): Episode[]
function agentTurns(rows: AgentRow[], range: TimeRange, nowMs: number): Map<string, Interval[]>
function activityReport(input: ReportInput): ActivityReport // days, projects, coverage
```

**`src/lib/activity/requestLedger.ts`.** It holds
`recordOperatorRequest(request, { kind, idempotencyKey?, conversationId?, path?, project? })`
and `readRequests(fromMs, toMs)`.

- Recording never throws. It resolves the project with the same precedence
  `operatorActivity.ts` uses, and falls back to `null` instead of refusing.
- The surface comes from the `User-Agent`.
- It writes with `appendFileSync`, so a Viewer release succession cannot
  corrupt a file. Reads dedupe by key.
- It is called at the 11 ingress sites in the table, only where
  `directOperatorActivityAuthority(req).ok`. For site 8 the realtime route
  passes the user agent down to `executeRealtimeControl`.

**`src/lib/view/device.ts`.** `detectDeviceKind` and `detectBrowser` move
here from `src/hooks/useViewPresence.ts`, which re-imports them.

**Search index.** The covering index above.

**`GET /api/activity`.** It takes `range=today|7d|30d`, `tz`, `window`,
`break` and `rounding`. All inputs are clamped: a bad value gets its default
and never an error. The route runs behind `rejectCrossOrigin`. It answers
`{ generatedAt, params, coverage, days[], projects[] }`, where:

- `days[]` has, per day: human raw minutes, report hours, episodes as
  `[start, end, project]`, agent wall-clock segments marked supervised or
  unattended, agent-hours, and a `recorded` flag.
- `projects[]` has, per project: human minutes and hours; human minutes by
  surface and by kind; agent wall-clock, supervised, unattended and
  agent-hours; agent-hours by engine and by role; and the top five pipelines
  by id with their stage ids.

**`/activity` page.** `src/app/activity/page.tsx` renders a client component
`src/components/activity/ActivityDashboard.tsx`, reached by one link from the
desktop project header menu and one from the phone menu. Read
`node_modules/next/dist/docs/` for page conventions first. The strings use
the existing `en` and `uk` i18n, and the styling follows
`docs/design/viewer-design-system.md`. There is no chart library: bars and
strips are CSS or SVG.

- *Header*: a Today / 7 days / 30 days segmented control, and a Day /
  Projects view switch.
- *Totals*: separate tiles for human time (raw, then report hours with the
  mode named), agent wall-clock, supervised versus unattended, and
  agent-hours. Human and agent use two fixed hues. Unattended agent time is
  the agent hue hatched. No tile adds the two axes together.
- *Day view*: one row per day (a single row for Today) with a 24-hour strip
  of two lanes, human episodes above and agent activity below, split into
  supervised and unattended, plus the day's totals. Days before the ledger
  existed are hatched and labelled "Not recorded".
- *Project view*: a ranking by human time, with agent time as a sort option.
  Each row has a human bar, an agent bar with its supervised share, and both
  times, and it expands into the breakdowns: surface, kind, engine, role,
  pipeline ids.
- *What is counted*: the method parameters in words, the per-surface
  coverage table, the ledger start date and the approximation note.
- *Phone (390 px)*: the same content stacked in one column, with a 2x2 grid
  of tiles, full-width strips, and project rows showing two stacked bars.
  The 24-hour strip keeps hour ticks every 6 hours.

**Tests, run by path:**

- `src/lib/activity/method.test.ts`:
  - a lone request is `W`;
  - gaps of 29 and 31 minutes with `T = 30`;
  - `T = W` equals the union of per-request windows (the original method);
  - an episode ends at `last + W`;
  - the clip at now;
  - a midnight split in `Europe/Kyiv`, including the 2026-10-25 DST change;
  - cross-project minutes are counted once, and the project rows sum to the
    total;
  - surface and kind breakdowns partition the total;
  - both rounding modes, including 0.5 h minimum and the clock-hour weights;
  - agent-only hours add zero human time;
  - the supervised and unattended split;
  - agent turns from rows (a leading assistant row, zero-length turns
    dropped, clipping);
  - parameter clamping.
- `src/lib/activity/requestLedger.test.ts`:
  - append, read and dedupe;
  - an unwritable directory does not throw, and emits the diagnostic;
  - retention;
  - a row carries exactly the six allowed keys.
- A route test for `/api/activity`: a cross-origin request is refused, and
  the response holds no path and no text.
- Ingress tests on `src/lib/runtime/http.ts` and
  `src/app/api/tasks/[id]/route.ts`: an operator request writes one row; an
  agent capability or internal-service request writes none; a failing ledger
  still admits the action.

**Renders.** Add an `activity` case to `scripts/capture-board-geometry.ts`
(`BOARD_CAPTURE_CASE=activity`), the existing real-browser driver on a seeded
home against the production build. Do not write a new driver.

- *Seed*: invented projects; ledger day files that start partway through the
  30-day range; and a search index built by the seeded scan from invented
  transcripts (or seeded directly, if the scan is too slow). Include at least
  one day with agent activity and no requests, which shows all-unattended
  agent time.
- *Captures* at 1440x900 and 390x844: day view (7 days), project view with
  one row expanded, and the empty/gap state (30 days with hatched unrecorded
  days, plus a home with no data at all).
- *Output*: `~/Pictures/delegatus-review/activity-dashboard/`.

**Verification.**

- `bunx tsc --noEmit`, with the exit code captured.
- The touched tests, by path.
- `bun run build` with an isolated config root (`LLV_STATE_DIR` or
  `XDG_CONFIG_HOME` under a temp directory).
- `bun scripts/privacy-publication-gate.ts --base <merge-base>`.
- Open a PR to `main` and leave it open. No merge and no deploy.

### What it does not do

- No backfill of human requests from before installation.
- No change to WakaTime or #zvit, and no export for them.
- No settings UI for `W`, `T` or rounding: they are query parameters with
  defaults, and the page shows the defaults.
- No per-conversation or per-stage durations (see the accuracy figures).
- No persisted rollups: the report is computed per request, with a 60 s
  cache for the agent axis.
- No new background scheduler, worker or timer.
- No use of the presence heartbeat for time.

## Deferred — not currently justified

| item | why deferred | what would justify it |
|---|---|---|
| Backfilling operator requests from transcripts (Codex `o.` markers, Claude delivery ledger origin) | Needs the #763 canonical-instruction dedupe across fan-out, resume and account mirrors. The Claude ledger stores bodies. Ingress recording is exact from now on. | The operator asks for pre-install history. |
| A canonical turn-window index (incremental full-transcript parse with `classifyTurnRecord`, including tool activity and silent gaps) | The approximation is within 1.7% in aggregate. A second 5 GB parse pipeline and state are heavy for a prototype. | Per-conversation or per-stage agent durations become a requirement (measured error today: 19% per conversation). |
| Viewing time from the presence heartbeat | The method anchors on requests. Screen input without a request is not engagement under it. The presence store also counts a page load as input. | The operator folds viewing into the method, with its own window. |
| WakaTime editor durations on the human axis | Outside Delegatus surfaces, which the specification excludes. It is part of #zvit's own inputs. | The operator wants one combined worktime view. |
| A project priority list for cross-project minutes (billing rule) | Recency assignment is enough for a dashboard. Priority is a billing concern of #zvit. | The dashboard's report hours are used for billing. |
| A settings UI for method parameters | Query parameters and defaults cover the prototype. | The operator changes them regularly. |
| Recording board layout, colour and hide actions | They are not requests. | The method changes. |

## Options considered

| decision | options | chosen and why |
|---|---|---|
| Human source | ingress ledger / transcript extraction / WakaTime / presence | The **ingress ledger**. It is exact, needs no dedupe, can carry a surface, and costs one line at sites that already classify the operator. Transcript extraction cannot see the surface, needs dedupe, and would require reading bodies. WakaTime unions the axes. Presence measures input, not requests. |
| Agent source | scanner tail windows / search index / new canonical index / WakaTime streams | The **search index**. It already holds full history, costs nothing new at runtime, and measured within 1.7% of canonical. Tail windows cover under 5% of recent transcripts. A canonical index is deferred. WakaTime streams have no role or pipeline and exist only while enabled. |
| Human episode tail | `max(last - first, W)` (#763) / `last + W` | **`last + W`**, as the correction requires. |
| Cross-project minutes | count per project (sum can exceed the total) / priority list / most recent request | **Most recent request**. Rows sum to the total, and it matches the idea of the operator watching what they last asked for. |
| Where the page lives | a hash route inside the board SPA / a separate `/activity` route | **A separate route**. It is independent of `Viewer.tsx` state and is simple to capture at both widths. |

## Validation against the requirement

| requirement (relay, spec, correction) | how the design meets it |
|---|---|
| Human interaction time and agent activity shown separately, WakaTime-like views per day and per project, range picker | Two axes with their own tiles, lanes and bars. Day view, project view, and Today / 7 days / 30 days. |
| Human time only from real interaction on Delegatus web, desktop and mobile, with each source named with its surface | Only validated direct-operator ingress writes anchors, and each anchor carries a surface. The surface table names what each surface does and does not contribute. |
| Coverage gaps stated and visible | The gap tables here and in the "What is counted" panel, hatched unrecorded days, and the approximation label. |
| Agent provenance: engine, role, pipeline/stage, conversation | The per-conversation join, with breakdowns by engine, role and pipeline/stage id. |
| Supervised agent work counts as human time; unattended, automation, spawn, bridge and injected work never does | Episodes span between requests up to `T`, plus `W` after the last. Only operator ingress anchors episodes. Automation and relays are refused by the authority rule. |
| Two overlapping axes, neither subtracted, overlap visible | Supervised versus unattended split of agent time, with both axes shown in full. |
| The operator's method applied, parameterised, defaults stated | The Counting method section: `W = 10`, `T = 30`, `half-hour` by default. `T = W` reproduces the original, and `clock-hour` reproduces its weights. |
| Prior work inspected; what is sound reused, what is wrong named | The prior-work table. |
| No personal information, prompts, bodies or secrets in metrics, API or UI | The privacy boundary: a six-key ledger row, no body column, no titles, no paths. |
| #zvit path and data unchanged | WakaTime code and payloads are untouched, and the ledger sits beside the WakaTime call. |
| No deployment, no merge, live state never touched | The PR is left open. Tests and builds use isolated roots, and renders use a seeded home. |
