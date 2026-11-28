# Board chart: thick only where an agent worked, working time at once and true

Status: build brief, 2026-11-28. Lane c4327574 (UI and the chart's data route).
Covers findings F3, F4, F6 and F9 of the production critique of 2026-11-28 and
the P3s on wording, the overdue flag and the midnight gridline. Builds on
`docs/design/board-timeline-manager-view.md` (§20 F2 and F5 are revised here)
and on PR #4375, which added the work-time read.

## 1. Requirement

On 2026-11-22, about 18:55 UTC, the operator wrote in the seat chat (paraphrased):
the expanded chart lists stage attempts such as «build 7», «build 8», «build 9»,
counts oddly, and says one build took 25 hours, though they doubt the agent really
worked 25 hours. The operator's form answer of 2026-11-13 stands: idle time is
a thin line, work is thick segments, and the board due date comes first.

A read-only production critique on 2026-11-28 (revision 65ee22aa, 09:46–10:20 UTC,
real data, 71 chart tasks) found the chart still fails that requirement:

- F3: thick bars draw a stage's calendar span. Standing tasks carry thick
  «Fix 4 · Календарно: 25 год»; at «1 тиждень» one task shows about three days
  of unbroken thick green; the one overdue task is solid green across the window.
- F4: an 8-stage working task reads «Рахуємо час роботи…» for 45–60 s; each
  read took 28–46 s and three answered HTTP 500 after 8.8 s; afterwards 5 of 8
  rows read «Час роботи невідомий» and the other 3 equal the calendar span.
- F6: a live row's start is wrong and unstable: «з 11:46 · 6 хв», then
  «start unknown» twenty minutes later, on a task open since 13.11.
- F9: 63 of 71 tasks slipped, 43 of them five times or more, yet «переносили
  15 разів» sits in 11 px grey, the same weight as «1 раз».
- P3: the overdue summary appears twice with odd wording («найдовше» for one
  task, minutes on an 18-hour value); the overdue flag is lost on a red or green
  segment; there is no gridline at midnight.

Acceptance (pinned specification):

1. Thick only where an agent's turns ran (verified turn intervals); waiting inside
   a stage and unknown time are the thin line; an overdue or standing task is not
   drawn as work. Never invent a duration.
2. The work-time read answers for a typical 8-stage task within 2 s on this
   machine's data (before/after on identical recorded data, repeated runs), never
   answers 500 on a readable transcript, reports working time that differs from
   calendar time when the agent waited, and says «unknown» only when no turn
   evidence exists. It does not block the Viewer main loop with full transcript
   rescans on every open (a cache keyed by transcript mtime or equivalent).
3. A live row's start is the task's own first start and is stable across reloads
   and widths.
4. Repeated slips (5+) stand out with the existing danger tokens; the overdue
   summary appears once with correct singular and plural wording and no minutes on
   hour-scale values; the overdue flag stays visible on any segment colour; day
   boundaries get a gridline at the 3-day and week scales.
5. Out of scope: scrolling (lane 4d6de22e), the expanded-view look (F7, design
   choice pending), phone density (F8). Everything the critique marked fixed stays.
6. Existing drivers only; the project's checks pass.

## 2. Root causes

Line numbers are at 524869c5 (this lane's base). "Observed" means read from code,
logs or data; "inferred" is marked.

### F3 — thick bars are attempt lifecycles

- `src/lib/board/taskTimeline.ts:109-111` sets an attempt's `workEndAtMs` to its
  settled end (`completedAt`, or a confirmed stop) whenever one exists. A settled
  attempt therefore "worked" from `startedAt` to `completedAt`, which includes the
  wait for a worker slot, the stage's own waits on gates, the park after a refused
  publication and the queue before settlement.
- `src/lib/board/taskTimelineView.ts:58-65` (`attemptSegment`) turns that pair into
  a `span`, and `src/components/kanban/BoardTimeline.tsx:386-398` draws every span
  as a 10 px `.bt-segment` in the stage tone, titled with the calendar span
  (`elapsed`, :397). §20 F2 of the manager-view design recorded this on purpose:
  "A settled attempt is still one segment from its start to its end; waits inside
  it are not intervals in the board read." The turn windows did not exist then.
- The expanded stage row (`BoardTimeline.tsx:449-452`) draws the lifecycle as a
  52 px outlined box (`.bt-stage-bar`, `boardTimeline.css:33`, `:74`) and the turn
  windows as fill; the outline is a second thick shape for waiting time.
- The turn windows that would correct the task row are only requested for expanded
  tasks (`BoardTimeline.tsx:286-290`), so a collapsed row has no evidence to draw
  from even when it exists.

Observed on recorded data (scratch probe, §10.1): lane 588b7526 has 26.5 calendar
hours across 12 attempts and 9.7 hours of turns; its «fix 8» attempt ran from
27.11 04:31 to 22:09 UTC, 17.6 calendar hours. Lane 823a3df7 has 188 calendar hours
and 19.8 hours of turns. Those are the bars the operator and the critic saw as
«25 год» of work.

### F4 — the read waits on a filesystem scan and looks only inside the scan window

1. **The 28–46 s.** `src/app/api/board/work-time/route.ts:29` calls
   `completedFileScan()` with its defaults, `revalidate: true, wait: true`. With a
   snapshot present that runs `waitForCatalogMembership`
   (`src/lib/scanner/scanCache.ts:955-966`): whenever the transcript roots gained a
   member since the last scan (on this machine, nearly always), it waits for up to
   two scan generations, each started no sooner than
   `FILE_SCAN_MEMBERSHIP_REFRESH_MS` = 10 s (`scanCache.ts:107`, `:930-952`) after
   the previous one. The Viewer journal during the critique shows scans that took
   over a minute (`[flow pipeline controller] still scanning: ageMs=62020` at
   09:56:02 UTC). The handler's own CPU is small: loop-gap attribution for request
   class `http:/api/board/work-time` between 09:53 and 10:05 UTC totals about 400 ms
   (registry.snapshot 47 slices, 205 ms, max 67 ms; scanner.ipc-frame 47 ms;
   scanner.ipc-decode 28.5 ms for 13.6 MB). The rest is waiting.
2. **The three 500s.** At 09:56:11 UTC the journal shows four
   `FileScanIncompleteError: filesystem scan incomplete` stacks in one second: the
   shared membership generation the requests had joined finished incomplete, and
   `waitForFileScanRefresh` rejected all its subscribers (`scanCache.ts:475-509`,
   thrown at `:548`/`:618`). The handler has no catch, and
   `src/lib/team/workspaceRoute.ts:322` rethrows anything that is not a
   `WorkspaceRefusal`, so Next answers 500. The transcripts were readable; the
   refusal came from the inventory.
3. **5 of 8 unknown.** `route.ts:30-33` resolves identities only among
   `completed.snapshot.files`. That snapshot is the sidebar's scheme window,
   10 projects × 80 cards (`src/lib/scanner/schemeWindow.ts:7-8`,
   `src/lib/scanner/roots.ts:109`), plus live hosts. The persisted snapshot read at
   10:16 UTC held 686 files, 100 of them this project's. The 8-stage task the critic
   opened is lane a9dde81d: 5 of its 8 attempt transcripts were outside the window
   and 3 inside (all 8 exist on disk). An identity outside the window answers
   `null` (`src/lib/scanner/transcriptWork.ts:216-217`), the hook stores `null`,
   and the row falls back to `turnDuration` → «Час роботи невідомий»
   (`BoardTimeline.tsx:249-251`, `:259-263`). The counts match the critique
   exactly. The match is inferred from a snapshot taken 18 minutes after the reads,
   but the window only moves forward, so an attempt outside it at 10:16 was outside
   it at 09:58 too.
4. **One request per stage.** `src/components/kanban/useAttemptWork.ts:21-26`
   (`loadAttemptWork`) sends one GET per identity, so eight rows make eight
   requests that each join the same scan wait. A failed read is asked again on the
   next 30 s step (`:54-71`), which is the 45–60 s the critic saw before the rows
   settled.
5. **"The other 3 equal the calendar span" is true.** The three in-window
   attempts were one turn each. A pipeline stage usually runs in one turn and waits
   on its own checks inside it, so its turn time equals its calendar span. Turn time
   is the verified interval (acceptance 1); a wait inside a turn is not visible in
   the transcript and is not subtracted. Working time differs from calendar time
   exactly where the attempt waited between turns: before its first prompt, after
   its report, or across a park and resume (lane 588b7526: 9.7 h against 26.5 h).
6. **The parse is not the bottleneck.** A scratch probe on real transcripts
   (§10.1) read the 12–15 transcripts of four open lanes (28–94 MB per lane) in
   110–360 ms cold and about 1 ms warm with the existing `transcriptWork` reader.

### F6 — a task's start is the earliest attempt the board happens to hold

- `src/lib/board/taskTimeline.ts:250-266` sets `startedAtMs` to the earliest
  attempt start among the pipelines in the board payload, else the earliest
  standalone member start, else the earliest lane creation.
- The board payload carries only the live `pipelines` collection
  (`src/app/api/files/response.ts:829-830`); a task's settled lanes move to
  `pipelines_archive`. The critiqued task (2a014f43, created 13.11 07:58 UTC) had
  ten archived lanes and, until 10:14 UTC, no live one. Its row existed only
  because the critic's own assigned conversation was working, so its start came from
  `taskTimeline.ts:220`: the member's open turn start, 09:46 UTC, which renders as
  «з 11:46» in Kyiv time. Twenty minutes later that member's last turn had closed or
  left the scan window; the card still counted a working agent, so
  `BoardTimeline.tsx:83-84` built a bare row with `startedAtMs: null`, and `since`
  (`:246-247`) printed «start unknown».
- The durable record holds the true start. In `state.sqlite`,
  `pipeline_task_membership` (indexed by `task_id`, triggers at
  `src/lib/state/pipelineEvidenceIndex.ts:16-45`) joins every live and archived lane
  of a task to `history_attempts.startedMs`: for 2a014f43 the earliest is 13.11
  08:31 UTC across 51 archived attempts. The task's first assignment `at` is 13.11
  07:58:57 UTC.

### F9 — slips share the due date's ink

`BoardTimeline.tsx:320-326` joins the slip count into the same string as the due
date (`parts.join(" · ")`), rendered in `.bt-due-words`, `color:
var(--color-secondary)` (`boardTimeline.css:57`). Only an overdue date changes ink
(`:61`). Nothing separates ten slips from one.

### P3s

- **Overdue summary twice.** The head prints `overdueIn(rows)` for all rows
  (`BoardTimeline.tsx:487`); each collapsed group prints its own again
  (`:525`, `:529-531`, `:534`). An overdue task in «Стоять» is counted in both.
- **Wording.** `timeline.group.overdue` has one form for every count
  (uk «прострочено: {count} · найдовше {duration}», `src/lib/i18n/uk.ts:5413`;
  en `src/lib/i18n/en.ts:5499`), so one task reads «найдовше». The duration comes
  from `timelineDuration` (`taskTimelineView.ts:120-125`), which writes hours and
  minutes below two days («18 год 6 хв»).
- **Flag lost.** `.bt-flag` (`boardTimeline.css:51-55`) is a 2 px pole rendered in
  `dueMarks` before `.bt-track` (`BoardTimeline.tsx:381-382`), so a segment later in
  the DOM paints over it, and its danger colour has no edge against a red segment.
- **No midnight gridline.** Ticks start at `Math.ceil(view.start / step) * step`
  (`BoardTimeline.tsx:298-300`) and the lane gridlines use the same epoch-aligned
  offset (`:310-311`). With 6, 12 or 24 h steps they fall on UTC multiples (02:00,
  14:00 in Kyiv). The local day boundaries are computed (`:301-306`) and used only
  for the date labels.

## 3. Data source for real turn intervals, and its cache

### 3.1 What a turn interval is

A turn window is what `TurnWindowTracker` (`src/lib/scanner/turnDuration.ts:64`)
already produces from a transcript: the initiating prompt to the terminal output,
with `end` null while the turn is open at the last record. An attempt's working
time is the union of the windows of its conversation clipped to the attempt's own
lifecycle `[startedAt, endAt]` (`attemptWorkWindows`,
`src/lib/board/attemptWork.ts:27-41`, unchanged). An open window ends at the clock
for a live attempt, at the transcript's last record otherwise. Nothing else counts
as work.

### 3.2 Resolving an identity without the scan window

The route stops reading the completed scan. Each identity resolves to its
transcript paths through keyed reads only:

- `conversation_…` id → `agentRegistry().conversation(id)` (the keyed read, site
  `registry.keyed`; never `readOnlySnapshot()`), whose `generations[].path` lists
  every generation, including the predecessor of an account migration. This
  replaces the scan-window walk in `generationsOf`
  (`transcriptWork.ts:184-201`).
- A transcript path (attempts that recorded only `agentPath`) → that path, plus the
  registry's `conversationForPath(path)` generations when one owns it.
- Each path is then admitted only when `fs.realpath` lies under a registered
  conversation root (`claudeProjectRoots()` or the Codex session roots in
  `src/lib/scanner/roots.ts`), ends in `.jsonl`, and is a regular file. The root
  label (`claude-projects` / `codex-sessions`) comes from that containment check and
  feeds the existing reader. A path outside every root answers `null`.
- The project used for the workspace filter is the conversation's own project
  (`workspaceConversationProject`, the resolver the gate already uses,
  `workspaceRoute.ts:50-72`), so the handler applies the same rule the gate applied.

`combineTranscriptWork` (`transcriptWork.ts:160-181`) unions the generations as it
does today. A generation that cannot be read makes the answer `complete: false`.

### 3.3 Route contract

`GET /api/board/work-time?conversationId=…&taskId=…`, both repeatable, at most 32
of each per request (`MAX_IDENTITIES` 12 → 32; a GET of 32 ids stays under 3 KB).

```ts
{
  work: Record<string, TranscriptWork | null>;   // unchanged shape
  tasks: Record<string, { firstStartedAtMs: number | null } | null>;
}
```

- `null` in `work`: the identity resolves to no transcript the caller may read.
  `complete: false`: a transcript exists but could not be read through (too large,
  replaced mid-read, I/O error, registry temporarily unreadable). The client keeps
  any known value and asks again.
- `tasks[id]`: §5. `null` for a task the caller may not read or that does not exist.
- No inventory wait. The handler never calls `completedFileScan`, `cachedFileScan`
  or `currentFileScan`. Any thrown error inside one identity's read becomes that
  identity's `complete: false`; the response is 200 whenever the request itself was
  valid and authorized. 400 for no identities or over the cap, 401/403/503 from the
  gate as today.
- The `taskId` parameter is already gated (`workspaceRoute.ts:174`, `taskProject`);
  `conversationId` values are gated per value (`:215`).

### 3.4 The cache

The existing cache in `transcriptWork.ts:30` stays the one owner. Changes:

- **Key and validity**: unchanged. An entry is keyed by path and valid while
  `size`, `mtimeMs`, `ino` and `dev` match `fstat` (`:101`); a file that kept its
  identity and only grew resumes from the recorded offset after a 4 KB tail check
  (`:102-104`), so a running attempt's re-ask parses only appended bytes.
- **Bound**: `CACHE_ENTRIES` 64 → 512. A chart that shows working tasks plus open
  groups needs about 100–200 transcripts; 64 would evict the chart's own entries on
  every pass. Each entry measures `512 + tail + windows × 96` bytes (`:30`), about
  5–10 KB, so 512 entries stay under 5 MB. The builder records the measured total
  from `MeasuredCache` in the PR.
- **Eviction**: least recently used. A hit currently returns without touching
  order (`:101`); it moves the entry to the end (`delete` + `set`) so the chart's
  working set survives a burst of one-off reads.
- **In-flight sharing**: the key uses the size read by `fstat` in place of the
  scan's size, so concurrent asks for one file share one read
  (`transcriptWork.ts:79-87`).
- **Not persisted.** A restart re-reads on the first open. Measured cold cost
  (§2 F4.6): 110–360 ms for a 12–15-stage lane, so a full chart of about 100–200
  transcripts costs about 1–3 s of chunked parsing once per process. That is inside
  acceptance 2 for a typical task and does not justify a persisted artifact (§13).

### 3.5 The main loop

- Reading stays chunked: 1 MB per `handle.read`, one `JSON.parse` per line,
  awaited between chunks (`transcriptWork.ts:108-125`); no chunk holds the loop
  longer than parsing one megabyte (about 5–10 ms, to be measured, §10).
- Identities of one request are read one after another, so one chart open never
  runs more than one transcript parse at a time on the loop.
- The handler runs inside `withViewerOperation("board.work-time", …)`
  (`src/lib/viewerLoopMonitor.ts`; add the name to its union and to
  `src/lib/performanceSpans.ts`), so loop-gap logs name it.
- The route reads the registry by key only. The 47 `registry.snapshot` slices
  attributed to the route during the critique came from scan publication on the
  request; with no scan call they go away (to be confirmed by §10.3).

### 3.6 Client

`useAttemptWork` keeps its schedule (settled identities once, live ones every
30 s on the board clock, failures retried at the next step) and changes its loader:

- One batched loader `loadChartWork(identities, taskIds, signal)` replaces the
  per-identity fetch. The hook groups the identities due in a step into requests of
  at most 32 and issues them one after another.
- Wanted identities: every attempt of a shown task row whose lifecycle intersects
  the visible window `[view.start, nowMs]` (the collapsed row needs them for §4),
  plus every attempt of an expanded task (its rows print working time even when the
  bar is off-window). Wanted task ids: every shown task row.
- The first read fires on mount, so a typical chart's figures arrive with the
  first answer (target under 2 s).

## 4. Drawing rule (F3)

One pure function in `src/lib/board/taskTimelineView.ts` decides every thick shape:

```ts
export function workSegments(
  attempt: SegmentInput & { endAtMs: number | null; observedTurn: { startedAtMs: number; endAtMs: number } | null },
  evidence: TranscriptWork | null | undefined,
  nowMs: number,
): { kind: "windows"; spans: Array<[number, number]> } | { kind: "live" } | { kind: "none" }
```

- Known windows (`attemptWorkWindows` non-null) → `windows` with those spans.
- Otherwise a verified `observedTurn` → `windows` with that one span.
- Otherwise a live attempt → `live` (the existing fixed-width mark on the now line;
  pixels, never a duration).
- Otherwise `none`. Nothing thick.

Task row (`BoardTimeline.tsx:386-398`): for each attempt, draw `workSegments` spans,
merged with `mergeWorkWindows(spans, 2 / pxPerMs)` and clipped with `clipSpan`, as
`.bt-segment` in the stage tone (unchanged colour language, F7 owns colour). The
3 px start tick for an attempt with no lifecycle end stays (a start mark). The thin
`.bt-line` from the task's first start to now stays and now carries all waiting
and unknown time. Segment titles say the worked time and then the calendar span
(«Fix 4 · Працював: 40 хв · Календарно: 25 год»). Until the first read answers, a
row shows the thin line, ticks and live mark only; segments appear when the
evidence does. The `data-timeline-segment`, `data-start-ms`, `data-end-ms`
attributes stay, one element per merged span.

Stage row (`BoardTimeline.tsx:449-452`): the lifecycle `.bt-stage-bar` keeps its
element, its data attributes and its click target, and is drawn as the thin line
(2 px, `--color-secondary`, with the same end ticks as `.bt-line`) at the row's
vertical centre, in place of the 52 px outlined box. The work fill
(`.bt-stage-work`) keeps its size and colour; restyling it is F7. This is the
13.11 decision (idle thin, work thick) applied to the stage row; it settles no part
of the pending expanded-view design.

Legend (`timeline.legend`): see §8.

Consequences: a standing or overdue task is thick only where its agents' turns ran
inside the window, which for most is nothing; a live attempt is thick from its open
turn's start to now; an attempt whose transcript cannot be read is thin.

`TimelineAttempt.workEndAtMs` (`taskTimeline.ts:24-29`, `:111`) has no reader left
after this change except `attemptSegment`'s tick decision; the builder keeps the
field for the tick and drops its use as a span end.

## 5. The task's own first start (F6)

`firstStartedAtMs` for a task = the earliest of:

1. `MIN(history_attempts.startedMs)` over `pipeline_task_membership` rows with
   that `task_id`, live and archived (one keyed query through
   `pipeline_task_membership_lookup`; read-only, no lock);
2. the earliest `assignments[].at` on the task record. That field is the time of
   the assignment's last delivery attempt (`src/lib/tasks/types.ts:132`), so the
   minimum is an upper bound on the true first start; it is used because nothing
   earlier is recorded for direct assignments.

`null` when neither exists. The work-time route answers it per `taskId` (§3.3).
The chart then uses it for the start words (`since`, `BoardTimeline.tsx:246-247`),
the thin line's left end (`:362-363`), the clip glyph and the in-group order
tie-break (`compareTimelineRows`, `:88`), in place of `TaskTimeline.startedAtMs`.

Before the answer lands, a task row's meta shows no start words (an empty slot of
the same height) and the line starts at the projection's start. This keeps the
first frame free of a time that would change a second later. A bare working row
(`:83-84`) takes the same value. Both sides are durable records, so the value is
the same on every reload and at every width.

`TaskTimeline.startedAtMs` remains the projection's earliest visible work and keeps
its readers in `taskTimeline.ts`; only the chart's display switches.

## 6. Slips, overdue words, the flag and midnight (F9, P3)

- **Slips.** `dueWords` returns the due words and the slip words as two parts.
  The slip part renders in its own `<span data-timeline-slips>`; at
  `slips >= 5` (`LOUD_SLIPS = 5` in `taskTimelineView.ts`) it takes
  `color: var(--color-danger); font-weight: 600` (the `.bt-overdue-note` rule).
  The words are unchanged, so the count reads without colour.
- **Overdue summary once.** The head no longer prints an overdue note
  (`BoardTimeline.tsx:487` removed). A collapsed group prints the note for its own
  hidden rows (as today). A visible task row already says «прострочено на …» in its
  due words. Each overdue fact is then on screen once: on its row when the row
  shows, on its group's line when the group is collapsed.
- **Wording.** `timeline.group.overdue` becomes a plural form (§8). The lateness in
  `overdueBy` and in the group note uses `lateDuration(ms)`: under 1 h whole
  minutes, from 1 h to under 2 days whole hours, from 2 days whole days. Work and
  calendar durations keep `timelineDuration` (minutes matter when comparing them).
- **Flag.** `.bt-flag` gets `z-index: 3` and a 1 px `var(--color-canvas)` halo on
  the pole and the head (`box-shadow: 0 0 0 1px var(--color-canvas)`), so it
  separates from any segment colour, the danger colour included.
- **Midnight.** For each local day boundary in the window (the existing `days`
  list), each lane and the axis draw a 1 px `.bt-midnight` line at `x(day.start)`
  in `var(--color-border)` (stronger than `--bt-grid`), at every scale. Hour ticks
  of 3 h and longer start from the local midnight before `view.start`
  (`midnight + ceil((view.start - midnight) / step) * step`), and the lane
  background offset follows the same origin, so 6 h ticks land on 00, 06, 12, 18.
  A DST day of 23 or 25 hours shifts later ticks of that day by an hour; the
  midnight line itself is always exact.

## 7. Shared paths

| Path | Producers | Consumers | Effect of this change |
|---|---|---|---|
| `GET /api/board/work-time` | `route.ts` | `useAttemptWork` only (`grep` finds no other caller; `docs/workspace-human-routes.md:115` lists it as project-scoped) | gains `taskId` and the `tasks` field; `work` keeps its shape; cap 12 → 32 |
| `transcriptWork()` cache | `transcriptWork.ts` | the route; tests | bound, LRU touch and in-flight key; key and validity unchanged |
| `transcriptWorkFor()` | `transcriptWork.ts` | the route only | replaced by a resolver over registry and roots; the scan-window walk goes |
| `TaskTimeline.startedAtMs` | `taskTimeline.ts` | `BoardTimeline` (display), `compareTimelineRows` | display and order switch to `firstStartedAtMs`; the field stays |
| `attemptSegment` | `taskTimelineView.ts` | `BoardTimeline` task row and stage tick | spans no longer drawn from it; tick and live decisions stay |
| `timeline.legend`, `timeline.group.overdue` | i18n | the chart only | rewritten |

Authorization and hostile input, checked server-side in the handler:

- The gate authorizes each `conversationId` and `taskId` value for a member
  (`workspaceRoute.ts:174`, `:215`). The owner and solo paths skip the gate
  (`:297`), so the handler itself refuses any path outside the registered
  conversation roots after `realpath` (a symlink out of a root, `../` segments, a
  `.jsonl` elsewhere on disk, `/proc/self/…`): each answers `null`.
- A member's identity resolving to another project's transcript: the handler
  re-checks the resolved conversation's project against the scope and answers
  `null`, the same as an absent one.
- Over-cap or empty requests: 400 before any read.

## 8. Strings

| Key | uk | en |
|---|---|---|
| `timeline.legend` | Лінія — задача відкрита, етап чекав або час невідомий; товста — агент працював (його ходи); ⚑ — строк. | Line: task open, stage waiting or time unknown. Thick: the agent worked (its turns). ⚑: due date. |
| `timeline.group.overdue` | one: «прострочено: {count} · на {duration}»; few, many, other: «прострочено: {count} · найбільше на {duration}» | one: «overdue: {count} · by {duration}»; other: «overdue: {count} · up to {duration}» |
| segment title (composed) | «{stage} · Працював: {worked} · Календарно: {calendar}» | «{stage} · Worked: {worked} · Calendar span: {calendar}» |

`timeline.overdueBy`, `timeline.slips`, `timeline.worked`, `timeline.elapsed`
keep their text. The builder greps both locale files for the old legend text and
for `найдовше` after the edit (rule: no stale copy).

## 9. Files

| File | Change |
|---|---|
| `src/app/api/board/work-time/route.ts` | no scan; resolver; `taskId`; cap 32; per-identity errors; `withViewerOperation` |
| `src/lib/scanner/transcriptWork.ts` | resolver over registry generations and roots; cache bound, LRU touch, in-flight key |
| `src/lib/board/taskStart.ts` (new, server) | `firstStartedAtMs(taskIds)` keyed query plus assignments |
| `src/lib/board/taskTimelineView.ts` | `workSegments`, `lateDuration`, `LOUD_SLIPS`, local-midnight tick origin |
| `src/components/kanban/useAttemptWork.ts` | batched loader; task starts |
| `src/components/kanban/BoardTimeline.tsx` | task-row segments from evidence; stage bar as thin line; start from `firstStartedAtMs`; slips span; overdue once; midnight lines |
| `src/components/kanban/boardTimeline.css` | thin stage bar; flag halo and z-index; `.bt-midnight`; slips tone |
| `src/lib/i18n/uk.ts`, `src/lib/i18n/en.ts` | §8 |
| `src/lib/viewerLoopMonitor.ts`, `src/lib/performanceSpans.ts` | the `board.work-time` operation name |
| `docs/design/board-timeline-manager-view.md` | a §21 pointer: §20 F2 and F5 are revised by this document |

## 10. Measurement plan for acceptance 2

All runs isolate HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR` under the stage
scratch, set `LLV_VIEWER_CONTROL_URL` to a closed port, and never touch the
operator's Viewer. Transcripts are read in place, read-only; nothing from them is
committed or printed.

### 10.1 Recorded dataset (frozen before the build starts)

- Five tasks with 8±2 stage attempts taken from the operator's open and archived
  lanes, plus lane 823a3df7 (15 attempts, 94 MB) as the heavy case. For each: the
  identities, each transcript's path, size, mtime, inode, and the attempt
  lifecycles. Written once to `$LLV_EVIDENCE_DIR/work-time-dataset.json`; both sides
  read only this file and skip any transcript whose size, mtime or inode changed.
- Baseline already observed (2026-11-28 ~10:20 UTC, Bun at 524869c5, one fresh
  process per pass, a single run, so only an indication): existing
  `transcriptWork` over lanes 588b7526 / 823a3df7 / 90b81a35 / 3cf12ffc read
  12/15/14/12 transcripts in 137/359/119/110 ms cold and 1 ms warm; working time
  9.7/19.8/13.4/3.4 h against 26.5/188.4/13.8/3.5 calendar hours; no attempt unknown.

### 10.2 Route-level, before and after, identical data, repeated

A harness under `scripts/gate-slot.sh` imports each side's route handler from a
scratch export of 524869c5 (before) and of the candidate head (after), and seeds
an isolated state directory with: a registry whose conversations name the dataset
transcripts, a task store with the five tasks, membership rows for their lanes, and
a completed scan snapshot holding only 2 of each task's transcripts (the window
shape seen in production). A membership probe that always reports a new member and
a scan runner that takes 15 s reproduce a busy machine for the before side.

For each task and side, back to back under the same load (r_864520dcd907770d):

- cold: a fresh process, one request with all its identities (one per identity on
  the before side, concurrent, as the old client did);
- seeded: the same request repeated 10 times in the same process;
- grown: append one turn's records to a copy of one transcript (copy under scratch,
  registry pointed at the copy for this case only) and ask again.

Record per run: wall time to the last answer, status codes, `transcriptWorkRead.bytes`
delta, unknown count, total working ms, calendar ms. Report p50, p95 and max over
the 10 seeded runs and all cold runs, for before and after.

Pass: after-side p95 under 2 s cold and under 100 ms seeded for every 8±2-stage
task; zero 5xx on both shapes, including a scan runner that rejects with
`FileScanIncompleteError` (before: 500, after: 200); seeded runs parse 0 bytes; the
grown run parses only the appended bytes; unknown count 0 for every transcript in
the dataset; working ms below calendar ms for at least one task with a recorded
wait (588b7526 shape).

### 10.3 Main loop

Run the 10.2 after-side harness with the Viewer loop monitor enabled and a 50 ms
interval probe on the same loop. Pass: no loop gap over 50 ms attributed to
`board.work-time`, and the `registry.snapshot` site absent from its attribution.
Record the longest single chunk's parse time at the 94 MB lane.

### 10.4 After deploy, on production, read-only

The lane's visual check (existing drivers, signed in as the browser-check member)
opens the chart at 1440 light uk with the working group's 8-stage task expanded and
records each work-time request's status and duration the way
`data-work-time-reads.json` did on 28.11. Pass: every request 200 and under 2 s,
every expanded row with a figure within 2 s of opening, «unknown» only on rows
whose transcript the server reports `null`. The journal over the same window shows
no `FileScanIncompleteError` from this route and no loop gap attributed to it over
50 ms. The before numbers are the 28.11 evidence.

## 11. Test cases

Run by explicit path through `scripts/gate-slot.sh bun test <file>` with isolated
HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR`.

`src/lib/board/taskTimelineView.test.ts`

1. `workSegments`: lifecycle 25 h with two windows of 20 min inside → two spans
   totalling 40 min; the lifecycle itself is never a span.
2. Windows partly outside the lifecycle are clipped to it.
3. No evidence, no observed turn, settled → `none`.
4. No evidence, observed closed turn → one span equal to that turn.
5. Live attempt, open window → span from the window start to now.
6. Live attempt with no start and no evidence → `live`.
7. Evidence `complete: false` → treated as no evidence.
8. `lateDuration`: 59 min → «59 хв»; 18 h 6 min → «18 год»; 2 d 3 h → «2 дн.»
   (uk and en).
9. Tick origin: Kyiv zone, 6 h step → ticks at 00, 06, 12, 18 local; 72 h window
   crossing a DST change keeps the midnight lines at local midnight.

`src/lib/board/attemptWork.test.ts`

10. A one-turn attempt whose turn spans the lifecycle reports work equal to the
    calendar span; a two-turn attempt with a 6 h gap reports 6 h less.

`src/lib/scanner/transcriptWork.test.ts`

11. An identity whose transcript is not in any scan snapshot resolves through the
    registry's generations and answers windows.
12. A migrated conversation with two generations unions both; one unreadable
    generation → `complete: false`.
13. A path outside every conversation root, a `../` path, and a symlink inside a
    root pointing outside it → `null`.
14. Cache: a second ask of an unchanged file parses 0 bytes; a grown file parses
    only the appended bytes; a replaced file (new inode) is read from 0.
15. LRU: with the bound set low for the test, a recently hit entry survives
    eviction and the oldest untouched one goes.

`src/app/api/board/work-time/route.test.ts` (new; real handler, isolated state)

16. A scan that never resolves and a scan that rejects `FileScanIncompleteError`:
    the route answers 200 with windows in both, and never calls the scan.
17. A transcript that throws on read answers `complete: false` for that identity
    and 200 for the request.
18. 33 identities → 400; none → 400.
19. A member scoped to project A asking for a conversation of project B gets 403
    from the gate; the owner asking for a path outside the roots gets `null`.
20. `taskId`: a task with only archived lanes answers its earliest archived attempt
    start; a task with assignments earlier than any lane answers the assignment
    time; a task with neither answers `null`; another project's task is refused by
    the gate.

`src/components/kanban/useAttemptWork.dom.test.tsx`

21. Eight identities in one step make one request; 40 make two (32 + 8).
22. A settled identity is asked once; a live one again after 30 s; a failed request
    retries its identities at the next step and keeps known values.
23. Task starts are requested with the identities and exposed by task id.

`src/lib/board/taskTimeline.test.ts`

24. The chart's start for a task comes from `firstStartedAtMs` when given, and is
    unchanged when the member's open turn closes or the member leaves.

Browser cases: one `describe` block in
`src/components/kanban/kanbanBoard.browser.test.tsx` over
`issue1695Evidence.fixture.tsx`, gated by `LLV_KANBAN_BROWSER_TEST=1` and
`CHROME_BIN`, with a fixture task whose fix attempt has a 25 h lifecycle and two
20-minute turns, a standing overdue task, a task slipped 15 times and one slipped
once, a live task whose lanes are all archived, and a 72 h window across midnight:

25. The collapsed task row's `[data-timeline-segment]` widths sum to the two
    turns' pixels (±2 px), never the lifecycle's; the standing overdue task has no
    segment wider than its turns.
26. The stage row's `[data-timeline-bar]` is at most 2 px tall; its work fill is
    present.
27. The live task row reads «з 13 лист. · …» at 1440 and at 390, before and after a
    reload.
28. «переносили 15 разів» has the danger colour and weight 600; «переносили 1 раз»
    does not.
29. The overdue summary text appears exactly once on screen, in the collapsed
    group; with the group open it appears only on the task row.
30. The flag's pixels at its pole differ from the segment under it (sampled from
    the screenshot), in light and dark.
31. A `.bt-midnight` line sits at local midnight at 72 h and 168 h.

Existing cases that read `.bt-segment` widths, `.bt-stage-bar` geometry or the head
overdue note (`board timeline manager view`, `board timeline attempt rows` blocks
and the gesture helper's bar selector) are updated to the new shapes, never
deleted.

## 12. Rendered evidence

Frames through the existing kanban driver (above) and, for the production check,
the board geometry capture: 1440 × 900, 1024 × 768 and 390 × 844, one width
between each pair (1200, 700), uk and en, light and dark; states: working group
with the 8-stage task collapsed and expanded, «Стоять» open with the overdue task,
72 h and 168 h scales. Frames go under `$LLV_EVIDENCE_DIR`; none are committed.

## 13. Deferred — not currently justified

- **A persisted turn-window artifact** (for example a table keyed by path, size,
  mtime and inode). Cold parse measured at 110–360 ms per lane; a restart costs a
  few seconds of chunked parsing once. Revisit if §10.3 shows loop gaps or a chart
  needs more than about 500 transcripts.
- **Subtracting waits inside a turn** (an agent sleeping on its own check). The
  transcript shows a turn; inferring idleness from tool timing would be a guess.
- **A first-start field written on the task record.** The keyed query answers the
  same value without a write path or migration.
- **Computed finish forecast**, the expanded-view look and colour language (F7),
  phone density (F8), scrolling (lane 4d6de22e).
- **Folding the observed-turn strip into the segments.** It is turn evidence and
  already drawn; merging the two shapes belongs to F7.

## 14. Options considered

| Choice | Picked | Rejected, and why |
|---|---|---|
| Where turn windows come from | whole-transcript windows per conversation, resolved by registry and roots | the scan window (misses 5 of 8); the scanner's last turn (2 of 272 conversations had one on 13.11); the search index (messages without turn boundaries) |
| Inventory freshness | none: the registry and roots name the files | `completedFileScan({ wait: false })` still fails closed with `FileScanIncompleteError` and still limits the answer to the window |
| Task start delivery | the chart's own data route | the board summary in `/api/files` (hot, shared payload; widens this lane past its route); a stored field (write path, migration) |
| Waiting on the stage row | thin line | keeping the outline box (thick shape for waiting, against acceptance 1) |
| Overdue summary place | collapsed group or the row itself | the head (repeats a visible row's own words) |

## 15. Overlap with lane 4d6de22e

That lane changes the gesture and fit code (`BoardTimeline.tsx:96-225`, `:496-505`)
and `boardTimeline.css:6`, `:79`. This lane touches `BoardTimeline.tsx:246-247`,
`:286-311`, `:320-326`, `:362-460`, `:477-487`, `:524-534` and the CSS rules named in
§6 and §4. The hunks are disjoint at 524869c5; the sibling branch had no commits
when this was written. Whichever lane publishes second runs `git merge-file` on
scratch copies of both heads and runs the other lane's browser block before its
push.

## 16. Validation against the requirement

- «build 8 took 25 hours»: the bar and the row now show the agent's turns
  (§3, §4); 25 calendar hours with 40 minutes of turns draws 40 minutes thick and
  says both numbers. Acceptance 1 and 2.
- The 13.11 decision, idle thin and work thick: task row and stage row (§4).
- Working time at once: no inventory wait, one batched read, measured target under
  2 s with no 500s (§3.3, §10). Acceptance 2.
- Stable start: durable records only (§5). Acceptance 3.
- Slips, the overdue summary, the flag and midnight (§6). Acceptance 4.
- Out of scope items are untouched and listed (§13); everything the critique
  marked fixed keeps its code paths (scroll code and header button are not edited).
