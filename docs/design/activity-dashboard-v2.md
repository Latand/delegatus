# Activity dashboard v2: the desktop presentation

- Status: built on PR #2126. The desktop page is `ActivityDesktop` and the
  components beside it in `src/components/activity/`, from 1024 px wide; the
  presentation fields are in `src/lib/activity/method.ts` and
  `src/lib/activity/report.ts`. "Build" below lists where the build differs
  from this concept.
- Grounded on: PR #2126, branch `pipeline/activity-dashboard-prototype` at
  `e40861caa`. The counting method, the sources and the API stay as
  `docs/design/activity-dashboard.md` defines them. This document replaces
  only the presentation that doc's "Prototype scope" describes.
- Mockup: `docs/design/activity-dashboard-v2/mockup.html` (invented data,
  every state behind a URL parameter). Its renders live outside the
  repository, in `~/Pictures/delegatus-review/activity-dashboard-v2/`. The
  publication gate admits a committed raster only when a checked-in generator
  reproduces it byte for byte, and a browser screenshot cannot meet that.
- Prior work searched: the transcript index returned the prototype lane's own
  design, build and review conversations (2026-09-24) and nothing earlier on
  presenting this page. Later searches, for how unread stretches and an
  unknown split were drawn before and for judging that split per project,
  found only this lane's reviews. The dashboard design rules applied here come
  from the data-visualisation method the lane loaded, checked against the
  app's tokens.
- Revision 2 answers the design review of revision 1: a day whose input was
  not read no longer draws its agent time as unattended; unsplit agent time
  has its own fill; Today draws an unread hour; agent-hours and the
  per-project breakdowns can be reached again; the expanded project row and
  the day tooltip carry their marks and every part of the split.
- Revision 3 answers the review of revision 2. "Unclear" is now judged per
  project, by the same rule as the Projects list's `≥`: a project's agent
  time is unclear only where a host holding that project was not read, or on
  a flagged day. Revision 2 judged it per day, so on Wed 23 it called
  ≈ 3 h 40 m of lantern-api, kestrel-cli and sorrel-bot agent time unclear
  while the list showed those projects fully read; the 7-day meter now reads
  ≈ 28 h unattended and ≈ 5 h unclear where it read ≈ 25 h and ≈ 8 h. The
  definition of unattended no longer reads as "you were away" (below,
  Agents and Rhythm).

## Originating requirement

The pinned specification of this task, as the orchestrator relayed it on
2026-09-24. The operator's verdict inside it is the orchestrator's English
paraphrase. The Ukrainian name of the daily paid report is transliterated as
`#zvit`, as in the method document.

> PR #2126 holds a working prototype of /activity (design doc
> docs/design/activity-dashboard.md on that branch; renders in
> ~/Pictures/delegatus-review/activity-dashboard/). The counting method and
> data are accepted; the PRESENTATION is rejected. Operator verdict
> 2026-09-24, paraphrased: it looks terrible, far too much text, the UX/UI was
> never thought through; desktop only for now; an Opus architect must think
> the concept through and produce a good visualization, and Opus must check
> the screenshots.
>
> Who looks at it and why (design for these questions, in this order):
> 1. How much did I work today / this week, and on which projects? (report
>    hours are the billable figure; the operator uses them for the daily
>    #zvit count)
> 2. How much did my agents work, and how much of it ran unattended while I
>    was away?
> 3. When during the day did I and the agents work (rhythm, gaps)?
> 4. Can I trust these numbers? (coverage: a host not read, lower bounds, a
>    zero day that is probably a missing source)
>
> Answer 1-2 at a glance with numbers and one strong chart; 3 as a compact
> timeline; 4 as a small, quiet trust indicator that expands on demand. The
> long method prose, hosts table and per-surface table leave the main view:
> one "How this is counted" affordance (drawer or popover). Target: the main
> view readable without scrolling at 1440x900 for the 7-day range; far fewer
> words than now; every number labelled once.
>
> Keep: the method, the API (/api/activity) and its data, human time and
> agent time never added together, supervised vs unattended split, Unknown /
> lower-bound semantics (never a clean zero for unread data), Today / 7 days /
> 30 days, days and projects views, en + uk strings. Change freely: layout,
> chart types, hierarchy, copy, which details are hidden by default. The API
> may gain fields the view needs; it may not change the counting.
> Desktop only in this lane (the phone view must not break, and may stay as
> is). Fixtures: invented projects and work, realistic and uneven (a heavy
> day, an empty weekend, one host unread for two days, many projects with a
> long tail), never operator strings or real transcripts.

## What fails in the prototype

Read from the nine renders in `~/Pictures/delegatus-review/activity-dashboard/`
and their `activity.json`. Word counts are OCR of the PNGs (the same method
is used for the v2 figure below).

**Length.** The 7-day desktop page is 1,598 px tall at 1,440 px wide, the
30-day page 2,886 px and the empty 30-day page 2,787 px. At 1440x900 the
visible part of the 7-day page carries about 400 words; the whole page
carries 821, and 550 of them sit in the "What is counted" panel, which is
always open.

**Hierarchy.**
- Four tiles of equal weight open the page. The figure the operator reports,
  "18 h reported" and "6 h billable", is the smallest grey line inside the
  first tile, under a headline of raw minutes (`≥ 11 h 58 m`).
- Two of the four tiles show the same value (`Agents working ≈ 31 h 25 m`,
  `Agent-hours ≈ 31 h 25 m`), and a third repeats the agent total split in
  two.
- A full-width warning banner of two sentences sits above the numbers, so
  the first thing read is a caveat.

**Chart choices.**
- The one chart is a 24-hour timeline per day. It answers "when" (question
  3). "How much per day" (question 1) is answered only by a column of 28
  small numbers at the right edge, four per day.
- Human time is drawn as dozens of 10-minute slivers; the eye gets texture
  and no shape.
- Two different diagonal hatches carry two unrelated meanings: a host that
  was not read, and agents working unattended.
- The Days view has no project dimension. The Projects view is a separate
  tab whose rows put a human bar and an agent bar on unrelated lengths, so
  agent bars dwarf human ones, and an expanded row opens six breakdown lists
  (host, surface, input kind, engine, role, pipelines) at once, all open.
- The supervised tile's meter has no labels on its two parts.

**Trust noise.**
- On 30 days, 16 rows read "Probable missing source" in the warning colour,
  every row adds `≈ 0 m`, and the empty state repeats the warning on 22
  rows while hatching the whole page.
- About 20 `≈`/`≥` glyphs on the 7-day page, one on nearly every figure.
- The same gap is stated three times: in the banner, on the day rows, and
  under the host in the hosts table.
- A day whose human input was not read still shows its agent time as
  `0 m supervised`, a claim that none of it was watched. The split cannot be
  known for that day.

**Labelling.** Each day row carries four numbers
(`≥ 50 m · 1 h reported` / `≈ 2 h 10 m · 48 m supervised`) whose meaning
rests on a coloured square and a legend 100 px above.

**Ukrainian.** Tile sub-lines wrap to two lines ("Агенто-години" and its
explanation), and the page subtitle is a two-line sentence.

## The questions, and what answers each

| # | Question | Answered by | At a glance |
|---|---|---|---|
| 1 | How much did I work, on which projects? | the **You** figure (reported hours, 44 px) and the **Projects** list | yes: one number, one ranked list |
| 2 | How much did agents work, how much unattended? | the **Agents** figure with its labelled meter: supervised, unattended, and unclear where your input for the agents' project was not read | yes: one number, one proportion |
| 1+2 per day | …and on which day? | the **by-day chart**: your reported hours beside agent time | yes: seven column pairs |
| 3 | When during the day? | the **Rhythm** grid, one cell per clock hour; on Today, the hourly chart | a compact second read |
| 4 | Can I trust it? | one **trust chip** in the header, `≥`/`?` marks and the hatch where they apply, the **drawer** | quiet until opened |

## The concept

One screen with one number to read first, one chart to read second, and
nothing that is not an answer to the four questions. Two hues carry the whole
page: the app's accent (indigo) is **you**, its info teal is **agents**, each
with one lighter step. **Texture means one thing: your input was not read.**
It comes in two forms: grey where a host was not read and nothing else is
known, teal where agents worked on a project whose input was not read. Status colour (warning amber) appears only where trust is in
question. Everything that explains the method lives behind one drawer.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [← Board]  Activity  18–24 Sept         [Today|7 days|30 days] [⚠ Lower bound] ⓘ How… │
├───────────────────────────────────────────────────────┬──────────────────────────────┤
│ ■ You                      Agents                     │ Projects 13        You⌄ Agents│
│ ≥ 27.5 h reported          ≈ 50 h                     │ orchard-client [billable] ≥9 h│
│ ≥ 23 h 42 m by the minute  ▇▇▇▇▇▇▇░░░░░░░░░░▨▨▨▨       │ ▇▇▇▇▇▇▇▇▇▇            ≈ 12 h │
│ · ≥ 14 h billable          ■ ≈ 17 h supervised        │ lantern-api        7.5 h ≈15 h│
│                            ■ ≈ 28 h unattended ▨ ≈ 5 h│ …  (rows fill the column;     │
│ ───────────────────────────────────────────────────── │     the rest folds into       │
│ 16 h                  10.5                            │     "+ N more")               │
│      8.5               ▇░                   ≥ 4  4.5  │                              │
│      ▇░          0  0  ▇░     ?             ▇▨   ▇░   │                              │
│      ▇▇     ░    ░  ░  ▇▇     ▨             ▇▇   ▇▇   │                              │
│     Fri 18 Sat 19 Sun 20 Mon 21 Tue 22 Wed 23 Today   │                              │
├───────────────────────────────────────────────────────┤                              │
│ Rhythm  You: ■ 1 h ■ ½ h ■ agents without you ▨ unclear ▨ not read                   │
│ Fri 18  ▒▒▒▒·····▇▇▇▇▒▇▇▇▇▆▆··▆▒▒                      │                              │
│ …one row per day, 24 hour cells                       │                              │
│ Today   ··▒▒····▆▇▇▇▆▆                                │                              │
│         00      06      12      18      24            │                              │
└───────────────────────────────────────────────────────┴──────────────────────────────┘
```

**Information hierarchy**, in reading order:

1. **You**: reported hours for the range. The only hero figure on the page.
2. **Agents**: approximate agent wall-clock, then its supervised,
   unattended and unclear parts.
3. **By day**: the same two measures per day, side by side.
4. **Projects**: the reported hours per project, agent time beside it.
5. **Rhythm**: when, per day and hour.
6. **Trust**: a chip in the header; its detail is one click away.

The figure labels double as the chart legend: the indigo square beside "You"
and the three swatches under the Agents meter are the only legend the day
chart has, and every number on the page has exactly one label.

## Components

### Header

`[← Board]` · **Activity** · the range as dates (`18–24 Sept`,
`Thursday, 24 Sept`, `26 Aug – 24 Sept`) · the range switch
(`Today | 7 days | 30 days`) · the trust chip · `ⓘ How it's counted`.

The prototype's subtitle sentence ("…The two overlap and are never added
together.") goes: the layout shows it (two separate figures, two separate
columns) and the drawer states it.

### Figures: You and Agents (questions 1 and 2)

**You.** `≥ 27.5 h` at 44 px, `reported` beside it in muted 13 px. Below,
one line: `≥ 23 h 42 m by the minute · ≥ 14 h billable`. The billable figure
is in secondary ink and semibold, because it is the one the paid report
copies; it appears only when a project is tagged billable
(`billableConfigured`).

- Why reported hours lead: the operator counts and bills in them, and a
  second, larger raw-minute number beside them made the prototype read as
  two answers to one question. The exact minutes stay one line below.
- Proportional figures on the hero; tabular figures in every column.

**Agents.** `≈ 50 h` at 32 px: wall-clock with at least one agent working.
Under it an 8 px meter in up to three parts with a 2 px surface gap, and the
parts labelled beneath it:
`■ ≈ 17 h supervised  ■ ≈ 28 h unattended  ▨ ≈ 5 h unclear`.

- **One rule decides the parts, per project.** Your input for a project is
  *not read* at a moment when a host holding that project (its `projects`
  lists it, or is `"all"`) was not read then, or when the day is flagged as a
  probable missing source. A flag names no host and no project, so it counts
  as an unread host that holds every project. For hosts this is the test
  the Projects list uses for its `≥`, so the list and the split agree; the
  flag is the one difference, explained under Projects.
  - **Supervised** (teal): agent time inside your read time on its own
    project.
  - **Unclear** (light teal, hatched): outside that time, while your input
    for that project was not read. It may have been supervised.
  - **Unattended** (light teal): the rest, agent time outside your time on
    its own project while that project's input was read. It includes time
    you spent on another project: it says nobody watched that project's
    agents, and leaves open where you were. The Rhythm shows the hours with
    no read input from you at all (below).
- When agents of several projects share a minute, the day and the range
  count it once, with the precedence supervised > unclear > unattended, the
  way the method already counts wall-clock and its supervised part. The
  unclear part is shown only when it is above zero.
- In the mockup, the stage host holds only orchard-client and harbor-ledger
  and was not read on 22–23 Sept. On Wed 23 the unclear part is
  ≈ 1 h 35 m, all of it harbor-ledger's night run; the lantern-api,
  kestrel-cli and sorrel-bot time that day is supervised or unattended,
  because the workstation, which holds them, was read. Tue 22 is flagged, so
  its ≈ 3 h 15 m of tidewater-app and kestrel-cli time is unclear.
- Why a third part in place of `≥`/`≤` marks on two (revision 1): a mark
  on "unattended" still drew the unread hours in the unattended colour,
  which told the operator nobody watched them on a day nothing was read for.
  With the part separated, supervised and unattended are exact up to the `≈` of the
  method, and the uncertainty has its own place in the chart, the meter and
  the tooltips.
- The label "Agents" carries no swatch: agent time is drawn in three fills,
  and their swatches under the meter are the legend.
- The parts are rounded so they add up to the total shown.
- **When none of your time was read,** the whole meter is the unclear fill,
  and the line under it reads `▨ Split unknown: your time was not read.` No
  fill that means supervised or unattended appears anywhere on that page.
- Agent-hours (parallel agents each counted) is one hover away, in the
  figure's tooltip, and one click away, in the drawer's "This range" and in
  each expanded project row. It answers none of the four questions on its
  own and was the prototype's duplicate tile.

### By-day chart (questions 1 and 2, per day)

Paired columns on one hour axis, one pair per day: **your reported hours**
(indigo) on the left and **agent wall-clock** on the right, stacked from the
baseline as supervised (teal), unattended (light teal) and unclear (light
teal, hatched), 2 px surface gaps between parts. Both measures are hours, so
one axis is honest; they stand side by side and are never stacked together,
which is the rule "never added" drawn as geometry.

- Your column carries its value on the cap (`8.5`, `≥ 4`, `0`, `?`): that is
  the day's figure for the report, and the only number labelled per day. Agent
  columns carry none; the axis and the tooltip hold their values.
- **Agent time whose project's input was not read never shows solid
  unattended.** The column's unclear part is the day's share of the rule
  under Agents: agent time on a project a then-unread host holds, and all
  agent time on a flagged day. In the mockup, Tue 22 (flagged) is one hatched
  column, and Wed 23 (the stage host unread) is supervised, unattended and a
  hatched ≈ 1 h 35 m, harbor-ledger's part. A lower-bound day can therefore
  show solid unattended: that is agent time on projects whose hosts were all
  read. The mockup checks the rule per project and hour on every range: no
  unclear time on a project whose input was read, and no unattended time on
  one whose input was not (`unclearOnReadProjects` and
  `unattendedOnUnreadProjects`, both 0 on every day).
- Columns are at most 22 px wide, 3 px rounded at the data end and square at
  the baseline; hairline solid gridlines on clean ticks (every 4 h up to 16 h);
  the unit sits on the top tick (`16 h`).
- Day labels under the pairs; weekends in muted ink, today as **Today**.
- Hover or keyboard focus on a pair opens the day tooltip (below).

Why this chart: it answers "how much, per day" for both axes at once, shows
the heavy day, the empty weekend and the unread days without reading a
number, and keeps the two measures apart. A stacked-by-project column was
considered and set aside (see Options).

**On Today** the same chart is hourly: minutes per clock hour on a `60 min`
axis, labels every 3 h, a hairline at now, nothing drawn after now. **A
stretch a host did not read** is one hatched band (the grey "not read" hatch)
behind those hours, the full height of the plot, with a direct label above
its start: `Stage host not read`. The band is per host; whatever was read is
drawn over it, and an empty slot inside it means "not read", never zero.
Agent minutes inside it are unclear only on projects that host holds (in the
render, orchard-client's run from 09:00 to 12:00); other projects' minutes
there stay supervised or unattended. The Rhythm card, which carries the legend on the other ranges,
is hidden on Today, so the band is labelled where it stands. The hero and the
by-the-minute and billable figures carry `≥`, and the chip reads
`⚠ Lower bound` (render `mockup-1440-today-gap.png`: the stage host unread
09:00–12:00, hero `≥ 1.5 h`).

### Rhythm (question 3)

A day × hour grid: one row per day, 24 cells per row, each cell one clock
hour. A cell is

| cell | meaning |
|---|---|
| indigo | an hour you worked a full reported hour (40 minutes or more) |
| light indigo | an hour that reported half an hour (10 to 39 minutes) |
| light teal | no reported weight from you, and agents worked at least 10 minutes outside your time on their project, mostly on projects whose input was read (unattended) |
| hatched light teal (unclear) | the same, mostly on projects whose input was not read (a tie goes to unclear) |
| hatched grey (not read) | some host was not read for that hour, and nothing above applies |
| faint track | nothing happened, and everything was read |
| none | a future hour today |

The agent cells follow the agents' projects, by the rule under Agents; the
grey hatch and the cell tooltip's `You` line follow the hosts. So on Wed 23,
with the stage host unread all day, the 18:00 cell is solid teal
(lantern-api's agents, a project the stage host does not hold), and its
tooltip still reads `You  not read (Stage host)`, because input you typed on
the stage host that hour, on its own projects, was not read. Every hour of a
day flagged as a probable missing source counts as not read for every
project.

One cell per hour ties the rhythm to the billable figure: under clock-hour
weights, a row's indigo cells count one hour each and its light ones half an
hour, so the row adds up to the day's reported hours. An hour with your
weight is drawn as yours whatever the agents did in it, so **the teal cells
are the part of agent time outside your time on its project that falls in
hours with no reported input from you** (under 10 read minutes). That is the
closest the page comes to question 2's "while I was away", and it is the
"gaps" part of question 3; where a host was not read in such an hour, the
cell's tooltip says `You  not read ({host})`, because input there could
exist. The rest of unattended time
sits under indigo cells, as agents working on one project while you worked
on another. Today in the mockup shows it: at 11:00 you worked most of the
hour on harbor-ledger while orchard-client's agents ran, so the hour is
indigo and that orchard-client time is unattended; the 7-day Today row has
two teal cells against ≈ 2 h 50 m unattended. The Agents meter and the
columns carry the whole unattended figure; the grid is the stricter view.
Under half-hour rounding the same bins are labelled `40+ min` and
`10–39 min`.

Legend, top right of the card:
`You: ■ 1 h  ■ ½ h  ■ agents without you  ▨ unclear  ▨ not read`. "You:"
names the subject of the two indigo swatches once, so "1 h" never reads as
"1 h of what"; the legend stays on one line at 1280×800 in Ukrainian
(`Ви: ■ 1 год  ■ ½ год  …`). With none of your input read it keeps only the
two hatches, the only marks drawn.
Hour axis `00 06 12 18 24` under the grid. Rows are 18 px for 7 days and
7 px for 30 days (every Monday and today labelled); on Today the rhythm card
is hidden, because the main chart is already hourly.

### Projects (question 1, "on which projects")

A ranked list in the right column, sorted by your reported hours:

`name [billable]` · a 4 px indigo bar under the name, proportional to the
largest row · your hours (`≥ 9 h`, `7.5 h`, `0`, `?`) · agent time in muted
ink (`≈ 12 h`, `–` for none).

- The rows fill the column's height; what does not fit folds into one
  `+ N more` row carrying the sums of the folded rows. The column ends where
  the left column ends.
- Sorting: the two column headers, `You⌄` and `Agents`. The separate sort
  switch goes.
- `billable` is an outlined pill, only on tagged projects.
- Your hours read `≥ 5 h` when a host holding the project was not read for
  part of the range, `?` when that leaves nothing read for it (a lower bound
  of zero says nothing), and a clean `0` only when every host holding it was
  read. This is the project's `coverage` from the response, unchanged.
- A flagged day does not put `≥` on the rows. It holds every project, so it
  would mark all of them and tell nothing about any one; it is stated once,
  on its day's cap, in the hero's `≥`, the chip and the drawer. It still
  makes that day's agent time unclear for every project, so a row can read a
  plain `2 h` with some unclear agent time behind it. The expanded row says
  where that comes from: its unclear part names its days (next bullet).
- **Click a row to expand it in place** (render `mockup-1440-expand.png`,
  harbor-ledger, a lower-bound billable project):
  `You  ≥ 4 h 13 m by the minute · 37 inputs · 12 m counted under a later input's project`
  `Agents  ≈ 3 h 15 m supervised · ≈ 4 h unattended · ≈ 1 h 35 m unclear (Wed 23) · 5 agents · ≈ 11 agent-hours`
  `Hosts  Stage host ≥ 3 h 38 m · Workstation 35 m`
  `› More detail`
  The unclear part names its days, or counts them past two (`3 days`).
  kestrel-cli, whose only host was read all week, reads
  `≈ 55 m unclear (Tue 22)`: the flagged day (render
  `mockup-1440-expand-kestrel.png`).
- **Supervised is never more than your time on the project** in the mockup's
  data, as the method guarantees against the project's own episodes. When
  some of the project's minutes went to a later input's project, the page
  can show supervised above "by the minute"; the You line then names those
  minutes (`12 m counted under a later input's project`), which is the
  reason.
- **`More detail`** (one more click, render `mockup-1440-expand-more.png`)
  opens the prototype's remaining breakdowns under a rule, each one line:
  `Surface  Desktop browser 2 h 37 m · Phone 1 h 1 m · Terminal 35 m`
  `Input  Messages 3 h · Answers 38 m · Voice 25 m · Decisions 10 m`
  `Engine  Claude ≈ 7 h · Codex ≈ 4 h`
  `Role  implementer ≈ 6 h · reviewer ≈ 3 h · architect ≈ 1 h · not in the registry ≈ 1 h`
  `Pipelines  7c1e04ab design · build ≈ 5 h 5 m · 2f9a61d0 review ≈ 2 h 25 m`
  and one muted note: "Surface and input share out your time; engine, role
  and pipelines share out agent-hours." Engine and role add up to the
  agent-hours on the Agents line; pipelines are the top five, as in the
  response.

The Days and Projects views are kept by showing both at once. The tab switch
between them goes.

### Trust chip and the "How it's counted" drawer (question 4)

One chip in the header, 28 px tall:

| state | chip |
|---|---|
| every expected host read for the range, no flagged day | `✓ All sources read` (success check, secondary text) |
| any host unread for part of the range, or a probable missing source | `⚠ Lower bound` (warning tone) |
| none of your input read for the range | `⚠ Your time not read` (warning tone). It names what went unread: agent time may still be read and drawn beside it, so the chip never claims that nothing was read. It fits the header at 1280 px in Ukrainian (`Ваш час не прочитано`) |

Both the chip and `ⓘ How it's counted` open the same right-hand drawer
(460 px, scrim over the page, closes on Escape and on the scrim). The chip
opens it at the top; its sections:

1. **This range**: one warning row per problem, in plain words
   ("Stage host was not read on 22–23 Sept. Your hours then may be higher."
   / "Stage host was not read today, 09:00–12:00. …" / "Tue 22 Sept reads
   zero on a workday while agents ran. A source is probably missing."), then
   the two agent measures (`≈ 50 h  time at least one agent worked`,
   `≈ 71  agent-hours: parallel agents each counted`), then one row per host:
   a check or a warning icon, its name, its sources and what they were read
   for.
2. **Method**: five short bullets (window, reported-hour weights, only your
   input, agent time and its three parts, the time zone).
3. **Excluded as not your input**: collapsed; the per-host exclusion counts.
4. **What each surface contributes**: collapsed; three lines.
5. A muted footer: when agent time was indexed, how many agents the registry
   does not know.

On the page itself trust shows only where a figure depends on it: `≥` on a
lower bound, `?` on a day or project that was not read, amber `?` on a
probable missing source, and the hatch on time nobody read. A problem is
described once, in the drawer.

### Tooltips

Each tooltip is a small table: a swatch, the value right-aligned, then its
label, so a value is never read off a sentence. Every agent value carries
`≈`, parts included.

- **Day pair** (hover or focus; renders `mockup-1440-hover.png`,
  `-hover-wed.png`, `-hover-tue.png`, `-uk-hover-wed.png`):
  ```
  Mon 21 Sept
  ■      10.5 h  reported
       9 h 11 m  by the minute
         ≈ 14 h  agents
  ■       ≈ 5 h  supervised
  ■       ≈ 9 h  unattended
  harbor-ledger 4 h · orchard-client 2.5 h · lantern-api 2 h · …
  ```
  The muted last line is the day's reported hours per project, which is what
  the daily report copies. A lower-bound day prints `≥` on your figures, adds
  its unclear part when it has one (Wed 23: `▨ ≈ 1 h 35 m unclear`) and two
  notes: `Stage host not read: your time is at least this.` and
  `Unclear: your input for harbor-ledger was not read, so it may have been
  supervised.` The unclear note names the projects it covers, largest first
  (`a`, `a and b`, `a, b and 2 more`), which is what keeps it from reading as
  a claim about the whole day. A flagged day prints `? reported` with the
  grey hatch swatch, its agent time as unclear only, and
  `A workday reads zero while agents ran: a source is probably missing.`
- **Agents figure** (render `mockup-1440-hover-agents.png`), under the figure
  so the meter stays visible:
  `≈ 50 h  time at least one agent worked` /
  `≈ 71  agent-hours: parallel agents each counted`, and, when the unclear
  part is above zero, `Unclear: agent time on projects whose input from you
  was not read then. It may have been supervised.`
- **Rhythm cell** (render `mockup-1440-hover-cell.png`):
  `Wed 23 Sept, 18:00–19:00` / `You  not read (Stage host)` /
  `Agents  ≈ 50 m unattended · lantern-api`. `You` is judged per host and
  `Agents` per project, as in the grid. A read hour reads
  `You  48 m · lantern-api` / `Agents  ≈ 55 m · lantern-api`; an hour that
  read some input while a host was not read prints `≥` on it
  (`You  ≥ 51 m · lantern-api` on Wed 23 at 16:00); on a flagged day with no
  unread host, `You  not read (a source is probably missing)`.

Every tooltip value is also reachable without hover: day values through the
table view of the chart (screen readers and `forced-colors`), project values
in the list and its detail, agent-hours in the drawer.

## Ranges

| | Today | 7 days | 30 days |
|---|---|---|---|
| header date | `Thursday, 24 Sept` | `18–24 Sept` | `26 Aug – 24 Sept` |
| main chart | hourly pairs, minutes per hour (`60 min` top tick), a hairline at now, labels every 3 h | daily pairs, value on each of your caps | daily pairs, 10 px columns; only `≥`/`?` marks on caps; labels on Mondays and today |
| an unread stretch | one hatched band behind the hours, labelled `{host} not read`; agent minutes in it unclear on the projects that host holds | `≥`/`?` on the day's cap; agent time unclear on the projects the host holds | as 7 days |
| rhythm | hidden (the chart is hourly) | 7 rows × 24, 18 px | 30 rows × 24, 7 px |
| projects | today's projects | the range's | the range's |
| fits 1440×900 | yes, ends at 585 px (uk with an unread stretch: 605 px, the agents legend wraps to a second line) | yes, ends at 778 px; the document (794 px) also fits the 813 px viewport of a 1440×900 screen with browser chrome | yes, ends at 861 px (document 877 px); in an 813 px viewport it scrolls 64 px |

## States

| state | You figure | chart | rhythm | projects | chip |
|---|---|---|---|---|---|
| complete | `27.5 h` | caps plain, `0` in muted ink on a clean zero; agents supervised + unattended | cells as read | plain | `✓ All sources read` |
| lower bound (a host unread for part of the range) | `≥ 27.5 h`; `≥` on minutes and billable; Agents meter gains its unclear part when agents worked on a project the host holds | `≥ 4` on the affected days; agent time there on the host's projects is unclear (hatched), on other projects supervised or unattended as usual | grey hatch where a host was unread and nothing else applies; teal hatch where agents worked mostly on the host's projects, solid teal where they worked on others | `≥` on projects the unread host holds, `?` where that leaves zero; their expanded unclear part names its days | `⚠ Lower bound` |
| probable missing source (a flagged day) | as lower bound | amber `?` on the day's cap; the whole agent column unclear, every project | every cell of the day hatched | no mark on the rows (it would mark all of them); an expanded row names the day on its unclear part | `⚠ Lower bound`; one row in the drawer |
| Today, a host unread for some hours | `≥ 1.5 h` and `≥` on its line | the hatched band behind those hours, labelled; read minutes drawn over it; agent minutes there unclear on the host's projects | (hidden on Today) | `≥` / `?` as above | `⚠ Lower bound`; the drawer names the hours |
| none of your input read for the range | `Unknown` (32 px), "No host was read for this range." and `🔌 Connect a host` (opens the drawer at Hosts) | agent columns only, every one unclear; muted `?` on every cap | agents teal-hatched, the rest grey-hatched | `?` in the You column, sorted by Agents | `⚠ Your time not read` |
| agent index not built yet | unchanged | your columns only | your cells only | agents column `…` | unchanged; the drawer says "Agent time appears after the first transcript scan." |
| a project with no agent time | – | – | – | `–` in the Agents column | – |
| future hours today | – | nothing drawn | nothing drawn | – | – |
| loading, first time | three card skeletons at their final sizes | | | | |
| loading, range switch | the previous render held at 60 % opacity, no layout jump | | | | |
| error | the card body reads "The activity report could not be loaded." with `Retry` | | | | |

The rule behind every row: a figure that could be higher carries `≥`, a
value nothing was read for is `?`, `Unknown` or hatched, agent time is
called unattended only where every host holding its project was read and
the day is not flagged, and a zero is printed only when every expected
source was read. A flag that applies to the whole range
(nothing read) is stated once and is not repeated per day.

## Copy

Every visible string of the main view, the tooltips, the project detail and
the drawer, under the keys the build uses (`src/lib/i18n/en.ts`, `uk.ts`).
`{…}` are values. Units follow the app: `h`/`m` and `год`/`хв`; decimals use
a comma in Ukrainian. The phone layout keeps the prototype's own keys, so
nothing it shows changes wording; where the desktop words a string
differently, it has a key of its own.

| key | en | uk |
|---|---|---|
| `activity.back` (kept) | Board | Дошка |
| `activity.title` (kept) | Activity | Активність |
| `activity.range.*` (kept) | Today / 7 days / 30 days | Сьогодні / 7 днів / 30 днів |
| `activity.trust.ok` | All sources read | Усі джерела прочитано |
| `activity.trust.lower` | Lower bound | Нижня межа |
| `activity.trust.none` | Your time not read | Ваш час не прочитано |
| `activity.how` | How it's counted | Як рахується |
| `activity.fig.you` | You | Ви |
| `activity.fig.agents` | Agents | Агенти |
| `activity.fig.reported` | reported | у звіті |
| `activity.fig.byMinute` | {value} by the minute | {value} похвилинно |
| `activity.fig.billable` | {value} billable | {value} оплачуваних |
| `activity.fig.supervised` | {value} supervised | {value} під наглядом |
| `activity.fig.unattended` | {value} unattended | {value} без нагляду |
| `activity.fig.unclear` | {value} unclear | {value} неясно |
| `activity.fig.splitUnknown` | Split unknown: your time was not read. | Розподіл невідомий: ваш час не прочитано. |
| `activity.unknown` (kept) | Unknown | Невідомо |
| `activity.fig.noneRead` | No host was read for this range. | За цей період не прочитано жодного хоста. |
| `activity.fig.connect` | Connect a host | Підʼєднати хост |
| `activity.fig.indexing` | Indexing transcripts… | Індексуємо транскрипти… |
| `activity.fig.wall` | time at least one agent worked | час, коли працював хоча б один агент |
| `activity.fig.agentHours` | agent-hours: parallel agents each counted | агенто-години: паралельні агенти окремо |
| `activity.chart.aria` / `ariaToday` (screen readers) | Your reported hours and agent time, per day / Your minutes and agent minutes, per hour today | Ваші години у звіті й час агентів, по днях / Ваші хвилини й хвилини агентів, по годинах сьогодні |
| `activity.chart.pair` (screen readers) | {day}: you {you}, agents {agents} | {day}: ви {you}, агенти {agents} |
| `activity.chart.unitH` | h | год |
| `activity.chart.unitMin` | min | хв |
| `activity.chart.unread` | {host} not read | {host}: не прочитано |
| `activity.rhythm.title` | Rhythm | Ритм |
| `activity.rhythm.you` | You: | Ви: |
| `activity.rhythm.full` | 1 h | 1 год |
| `activity.rhythm.half` | ½ h | ½ год |
| `activity.rhythm.full40` / `half10` (half-hour rounding) | 40+ min / 10–39 min | 40+ хв / 10–39 хв |
| `activity.rhythm.alone` | agents without you | агенти без вас |
| `activity.rhythm.unclear` | unclear | неясно |
| `activity.rhythm.unread` | not read | не прочитано |
| `activity.rhythm.aria` (screen readers) | Your reported hours and agents working without you, per day and hour | Ваші години у звіті й агенти без вас, по днях і годинах |
| `activity.view.projects` (kept) | Projects | Проєкти |
| `activity.col.you` | You | Ви |
| `activity.col.agents` | Agents | Агенти |
| `activity.col.sort` (screen readers) | Sort by {column} | Сортувати: {column} |
| `activity.project.billable` (kept) | billable | оплачуваний |
| `activity.projects.more` | + {count} more | + ще {count} |
| `activity.projects.none` | No projects in this range. | За цей період проєктів немає. |
| `activity.unattributed` (kept) | No project | Без проєкту |
| `activity.project.requests` (kept) | {count} input / inputs | {count} ввід / вводи / вводів / вводу |
| `activity.project.agents` (kept) | {count} agent / agents | {count} агент / агенти / агентів / агента |
| `activity.detail.reassigned` | {value} counted under a later input's project | {value} зараховано проєкту пізнішого вводу |
| `activity.detail.agentHours` | {value} agent-hours | {value} агенто-годин |
| `activity.detail.unclearOn` | {value} unclear ({days}) | {value} неясно ({days}) |
| `activity.detail.days` | {count} day / days | {count} день / дні / днів / дня |
| `activity.list.and2` / `andMore` | {a} and {b} / {a}, {b} and {count} more | {a} і {b} / {a}, {b} та ще {count} |
| `activity.detail.hosts` | Hosts | Хости |
| `activity.detail.more` | More detail | Докладніше |
| `activity.detail.surface` / `kind` / `engine` / `role` / `pipelines` | Surface / Input / Engine / Role / Pipelines | Поверхня / Ввід / Рушій / Роль / Пайплайни |
| `activity.detail.note` | Surface and input share out your time; engine, role and pipelines share out agent-hours. | Поверхня і ввід ділять ваш час; рушій, роль і пайплайни — агенто-години. |
| `activity.surface.*`, `activity.kind.*`, `activity.role.unregistered` (kept) | Desktop browser, Phone, Terminal, …; Messages, Answers, Voice, …; not in the registry | (kept) |
| `activity.tip.byMinute` | by the minute | похвилинно |
| `activity.tip.agents` | agents | агенти |
| `activity.tip.supervised` / `unattended` / `unclear` | supervised / unattended / unclear | під наглядом / без нагляду / неясно |
| `activity.tip.lower` | {host} not read: your time is at least this. | {host} не прочитано: вашого часу щонайменше стільки. |
| `activity.tip.unclearNote` | Unclear: your input for {projects} was not read, so it may have been supervised. | Неясно: ваш ввід для {projects} не прочитано, тож це міг бути нагляд. |
| `activity.tip.unclearAny` | Unclear: agent time on projects whose input from you was not read then. It may have been supervised. | Неясно: час агентів на проєктах, ваш ввід для яких тоді не прочитано. Це міг бути нагляд. |
| `activity.tip.missing` | A workday reads zero while agents ran: a source is probably missing. | Робочий день показує нуль, хоча агенти працювали: ймовірно, бракує джерела. |
| `activity.cell.notRead` | not read ({host}) | не прочитано ({host}) |
| `activity.cell.missing` | not read (a source is probably missing) | не прочитано (ймовірно, бракує джерела) |
| `activity.cell.none` | no input | без вводу |
| `activity.drawer.title` | How this is counted | Як це рахується |
| `activity.drawer.close` | Close | Закрити |
| `activity.drawer.range` | This range | Цей період |
| `activity.drawer.method` | Method | Метод |
| `activity.drawer.flagLower` | {host} was not read {when}. Your hours then may be higher. | {when}: {host} не прочитано, тож ваших годин тоді могло бути більше. |
| `activity.drawer.whenDays` / `whenToday` | on {days} / today, {span} | {days} / сьогодні, {span} |
| `activity.drawer.flagMissing` | {day} reads zero on a workday while agents ran. A source is probably missing. | {day} — робочий день із нулем, хоча агенти працювали. Ймовірно, бракує джерела. |
| `activity.drawer.flagMissingMany` (more than three flagged days) | {count} workdays read zero while agents ran ({days}). A source is probably missing. | {count} робочих днів із нулем, хоча агенти працювали ({days}). Ймовірно, бракує джерела. |
| `activity.drawer.m1` | Each of your inputs opens a {window}-minute window; overlapping windows merge. A minute counts once, for the project of the latest input. | Кожен ваш ввід відкриває вікно на {window} хвилин; вікна, що перетинаються, зливаються. Хвилина рахується один раз — для проєкту останнього вводу. |
| `activity.drawer.m1Episodes` (a break above the window) | Each of your inputs opens a {window}-minute window, and inputs at most {break} minutes apart join one episode. A minute counts once, for the project of the latest input. | Кожен ваш ввід відкриває вікно на {window} хвилин, а вводи з проміжком до {break} хвилин складають один епізод. Хвилина рахується один раз — для проєкту останнього вводу. |
| `activity.drawer.m2` | Reported hours weigh each clock hour: under 10 minutes 0, 10–39 half an hour, 40 or more a full hour. The hour goes to the project with the most minutes. | Години у звіті зважують кожну годину за годинником: менше 10 хвилин — 0, 10–39 — пів години, 40 і більше — година. Година дістається проєкту з найбільшою кількістю хвилин. |
| `activity.drawer.m2Half` (half-hour rounding) | Reported hours round each project's day to the nearest half hour, and any time at all is at least half an hour. | Години у звіті округлюють день кожного проєкту до пів години, і будь-який час — щонайменше пів години. |
| `activity.drawer.m3` | Only your own input counts. Stage prompts, agent-to-agent messages, notifications and injected text are left out. | Рахується лише ваш власний ввід. Промпти етапів, повідомлення між агентами, сповіщення та вставлений текст не враховуються. |
| `activity.drawer.m4` | Agent time (≈) runs from each message to the agent's last reply. Inside your time on the same project it is supervised; where a host holding that project was not read, or on a day that probably misses a source, it is unclear; the rest is unattended, including time you spent on another project. Your time and agent time are never added. | Час агентів (≈) триває від повідомлення до останньої відповіді агента. У межах вашого часу на тому ж проєкті це нагляд; де хост цього проєкту не прочитано або дню ймовірно бракує джерела — неясно; решта — без нагляду, зокрема поки ви працювали над іншим проєктом. Ваш час і час агентів ніколи не додаються. |
| `activity.drawer.m5` | Days and hours are in {tz}. | Дні й години — за {tz}. |
| `activity.drawer.hostRead` | Read to {when} | Прочитано до {when} |
| `activity.drawer.hostGap` | Not read {when} | Не прочитано: {when} |
| `activity.hosts.thisHost` (kept) | this host | цей хост |
| `activity.drawer.srcBoth` | Request ledger and transcript export | Журнал запитів і експорт транскриптів |
| `activity.drawer.srcLedger` | Request ledger | Журнал запитів |
| `activity.hosts.transcripts` (kept) | Transcript export | Експорт транскриптів |
| `activity.hosts.notConnected` (kept) | Not connected: its time reads Unknown | (kept) |
| `activity.drawer.excluded` | Excluded as not your input | Виключено як не ваш ввід |
| `activity.coverage.title` (kept) | What each surface contributes | Що дає кожна поверхня |
| `activity.drawer.indexed` | Agent time indexed {when}. | Час агентів проіндексовано {when}. |
| `activity.drawer.unregistered` | {count} agents are not in the registry, so their roles are unknown. | {count} агентів немає в реєстрі, тож їхні ролі невідомі. |
| `activity.drawer.indexing` | Agent time appears after the first transcript scan. | Час агентів зʼявиться після першого сканування транскриптів. |
| `activity.table.day` (screen readers) | Day | День |
| `activity.failed` (kept) + `activity.retry` | The activity report could not be loaded. · Retry | Не вдалося завантажити звіт про активність. · Повторити |

The surface table collapses to three lines in the drawer
(`activity.drawer.surf1`–`surf3`): "Browser, tablet, phone: every request,
voice included" / "Terminal: prompts a CLI records as typed by a person,
through a host's export" / "Outside Delegatus (editors, Telegram, GitHub
review): not seen", with the Ukrainian lines in the dictionary. The desktop
page no longer shows the prototype's `activity.subtitle`, `activity.tile.*`
sub-lines, `activity.gap.*` banner strings, `activity.legend.*`,
`activity.breakdown.*` titles and `activity.coverage.*Counted` / `*Missing`
rows; the phone layout still does.

## Number formats

| figure | format | example |
|---|---|---|
| reported hours | halves, one decimal when needed | `27.5 h`, `27,5 год`, `9 h` |
| by the minute | hours and minutes | `23 h 42 m` |
| agent time | `≈` before every value, parts included; whole hours from 10 h, 5-minute steps below; `–` for none | `≈ 50 h`, `≈ 8 h 50 m`, `–` |
| agent-hours | `≈` and a count of hours, no unit: halves below 10, whole above | `≈ 71 agent-hours`, `≈ 9` |
| a split | rounded so its parts add up to the total beside it; the same for engine and role against agent-hours | `17 h` + `28 h` + `5 h` = `≈ 50 h` |
| lower bound | `≥` before the value, in muted ink, smaller on the hero | `≥ 27.5 h` |
| not read | `?` on a day or row, `Unknown` for the range, the hatch in a chart | |

The agent approximation is +1.7 % in aggregate and 19 % per conversation
(method doc, "Accuracy"), so printing it to the minute claimed a precision it
does not have.

## What leaves the main view, and where it goes

| prototype element | v2 |
|---|---|
| subtitle sentence | removed; the layout and the drawer's method say it |
| four equal tiles | two figures, one hero |
| "Agents working" and "Agent-hours" tiles | one Agents figure; agent-hours in its tooltip, the drawer and each project's detail |
| full-width incompleteness and missing-source banner | the trust chip; the sentences move to the drawer's "This range" |
| legend row | the figure labels are the legend |
| per-day 24 h timeline with four numbers per day | the by-day chart plus the Rhythm grid; on Today, the hourly chart |
| Days / Projects switch | both visible, side by side |
| Your time / Agent time sort switch | the Projects column headers |
| six breakdown lists per project, all open | three lines in the expanded row (you, agents, hosts); surface, input, engine, role and pipelines one click further, behind `More detail` |
| "What is counted" paragraphs | drawer, Method (five bullets) |
| hosts table | drawer, This range (one row per host) and "Excluded" (collapsed) |
| surface table | drawer, collapsed, three lines |

## Reaching every measure of the prototype

Every measure and breakdown the prototype shows is reachable in at most two
clicks from the main view, and a render shows each.

| prototype measure or breakdown | v2 | clicks | render |
|---|---|---|---|
| your time (raw minutes), range | You figure, second line | 0 | `mockup-1440.png` |
| reported hours, billable hours, range | You figure | 0 | `mockup-1440.png` |
| agents working (wall-clock), range | Agents figure | 0 | `mockup-1440.png` |
| supervised / unattended, range | Agents meter and its labels (plus unclear) | 0 | `mockup-1440.png` |
| agent-hours, range | Agents tooltip (hover); drawer "This range" | 0 + hover / 1 | `-hover-agents.png`, `-drawer.png` |
| per day: reported hours | the cap of your column | 0 | `mockup-1440.png` |
| per day: your minutes, agent wall-clock, supervised, unattended | day tooltip (hover or focus); the chart's table view | 0 + hover | `-hover.png`, `-hover-wed.png`, `-hover-tue.png` |
| per day: reported hours per project | day tooltip, last line | 0 + hover | `-hover.png` |
| per hour: your input, its project and host, agents supervised or not, unread | Rhythm cell tooltip; on Today the hourly chart | 0 + hover | `-hover-cell.png`, `-today-gap.png` |
| per project: reported hours, agent wall-clock | Projects row | 0 | `mockup-1440.png` |
| per project: your minutes, inputs, reassigned minutes | expanded row, You line | 1 | `-expand.png` |
| per project: supervised / unattended (plus unclear and its days), agents, agent-hours | expanded row, Agents line | 1 | `-expand.png`, `-expand-kestrel.png` |
| per project: your time by host | expanded row, Hosts line | 1 | `-expand.png` |
| per project: by surface, by input kind | `More detail` | 2 | `-expand-more.png` |
| per project: agent-hours by engine, by role; top pipelines | `More detail` | 2 | `-expand-more.png` |
| hosts: sources, read spans, gaps | drawer, This range | 1 | `-drawer.png`, `-today-gap-drawer.png` |
| hosts: excluded inputs by reason | drawer, "Excluded as not your input" | 2 | (collapsed in `-drawer.png`) |
| what each surface contributes | drawer, collapsed section | 2 | (collapsed in `-drawer.png`) |
| agent index time, unregistered agents | drawer footer | 1 | `-drawer.png` |

## Colour

Everything resolves to the app's tokens (`src/styles/tokens.css`). The chart
steps are new tokens, proposed for the same file so the dark palette gets
its own validated steps.

| role | light | dark | use |
|---|---|---|---|
| you | `--color-accent` `#5a51e0` | `#7f79e6` | your columns, full-hour cells, bars in Projects |
| you, half | `#9ca2f0` | `#4a4786` | half-hour cells |
| agents, supervised | `--color-info` `#0d9488` | `#20a896` | base of agent columns, meter |
| agents, unattended | `#79b9ae` | `#296b65` | above it in agent columns, meter, "agents without you" cells |
| agents, unclear | `#79b9ae` under 1.3 px stripes of the card colour (78 %), 3.6 px pitch | `#296b65` under stripes of `#191b23` (80 %) | top of agent columns, meter, "unclear" cells, and the whole agent mark when nothing was read |
| not read | `--mark-track` under 1.2 px `--border-strong` stripes | `#1f222b` under `#3c404c` | rhythm cells, the Today band |
| track | `#f1ede6` | `#1f222b` | empty rhythm cells |
| status | `--color-warning`, `--color-success` | (tokens) | trust chip, `?` on a flagged day, drawer rows |
| text | primary / secondary / muted | (tokens) | every label and value; no text wears a series colour |

Validation with the data-visualisation palette checker (OKLab ΔE):

- you vs supervised, light, on the card: every check passes; worst CVD ΔE
  20.3 (deutan), normal vision 25.1, both at least 3:1 against the surface.
- you vs supervised, dark: the app's own `#8f88ff`/`#2dd4bf` fail the dark
  lightness band (L 0.69 and 0.79, above 0.67); the chart steps
  `#7f79e6`/`#20a896` pass every check (CVD 15.5, normal 21.5, ≥ 3:1).
- each lighter step as an ordinal pair with its base: monotone, one hue,
  light end at least 2:1 against the surface (`#79b9ae` 2.21, `#9ca2f0`
  2.34, `#296b65` 2.77 and `#4a4786` 2.08 on the dark card). A lighter teal
  (`#99c8bf`, 1.82:1) failed and was not used.
- the light steps sit under 3:1, so the relief rule applies: every value they
  carry is labelled in text (figure lines, legend, tooltips, the table view).
- unclear and unattended share a hue and a lightness on purpose (both are
  agent time outside your read time); the stripes are the difference. The
  stripe is the one mark that is not a colour, so it survives every colour
  vision deficiency and `forced-colors` renders it as a pattern.

Texture carries one meaning on the page, "your input was not read", in two
forms: grey where a host was not read and nothing else is known, teal where
agents worked on a project whose input was not read. The prototype's second
hatch (unattended agents) is gone.

## API additions (presentation only)

The page must never re-implement the method, and the things it draws below
are method outputs the response does not carry today. Each is a value
`src/lib/activity/method.ts` already has on the way to its totals, or an
intersection of intervals it already builds; exposing them changes no count.

```ts
interface AgentSplit {
  // …existing fields…
  /** The part of unattendedMs whose project's input was not read: a host
      holding that project was not read then (uncoveredSpans with the
      project), or the day is flagged as a probable missing source. The page
      draws it as "unclear" and draws unattendedMs − unattendedUnreadMs as
      unattended. Days, totals and projects all carry it. */
  unattendedUnreadMs: number;
}

interface ProjectActivity {
  // …existing fields…
  /** The dates (in the zone) holding at least a minute of its
      unattendedUnreadMs, oldest first. */
  unclearDays: string[];
}

interface ActivityHostRow {
  // …existing fields…
  /** The stretches of the range, up to now, the host was not read for: the
      drawer's "Not read on 22–23 Sept" and Today's band. */
  unread: Interval[];
}

interface DayActivity {
  // …existing fields…
  /** One of the weekdays checked for a probable missing source (settings). */
  workday: boolean;
  /** One entry per clock hour of the day in the zone (23 or 25 on DST days). */
  hours: Array<{
    start: number;              // the hour's start, ms
    humanMs: number;            // covered minutes of your time in the hour
    weight: 0 | 0.5 | 1 | null; // clockHourWeight of those minutes; null under half-hour rounding
    project: string | null;     // the project the hour's weight went to
    supervisedMs: number;
    unattendedMs: number;
    unattendedUnreadMs: number; // as on AgentSplit, within the hour
    agentProject: string | null; // the project with the most agent wall-clock in the hour
    unreadHosts: string[];      // expected hosts not read for part of the hour (per host)
  }>;
  /** dayReportHours for the day, with the raw minutes behind each entry. */
  projects: Array<{ project: string | null; humanMs: number; humanHours: number }>;
}
```

How the method builds `unattendedUnreadMs`, with what it already has
(`agentsByProject`, each project's own episodes `own`, `supervisedUnion`,
`uncoveredSpans`, and the days' `missingSource`, which is decided before any
of this):

1. `flagged` is the union of the windows of the flagged days.
2. For each project `P`: `unread(P) = uncoveredSpans(range, hosts, P).spans ∪
   flagged`, and `unclear(P) = (wall(P) ∩ unread(P)) − own(P)`, where
   `wall(P)` is the union of `P`'s agents' activity. The project row's
   `unattendedUnreadMs` is `totalMs(unclear(P))`, and `unclearDays` the days
   it touches. `uncoveredSpans` already asks `holdsProject`, so a host whose
   `projects` is `"all"` counts for every project, and unattributed time
   (`null`) for every host.
3. For a day, the range and an hour: `unclearAll = ⋃ unclear(P) −
   supervisedUnion`, clipped to the window. That is the precedence
   supervised > unclear > unattended for a minute several projects' agents
   share, the way `wallMs` and `supervisedMs` already count it.

So a project's figure is unclear only where its own hosts were unread or its
day flagged, and the day and the range show exactly the union of those
stretches. Supervised stays exactly what it is: agent time inside the
project's own episodes. Where no two projects' agents share a minute, the
projects' unclear parts add up to the range's; where they do, the range
counts the minute once, as it does for wall-clock, and the projects' parts
add up to more.

Tests the builder adds beside `method.test.ts`: for every day, the weights
of `hours` sum to `humanHours` under clock-hour rounding; `projects` sums to
`humanHours` and `humanMs`; the hours' supervised, unattended and unread
parts sum to the day's. The unclear rule gets its own cases: a host holding
only project A is unread for a day, and project B's agents that day, read on
another host, have `unattendedUnreadMs` 0 while A's unattended time in the
gap is all unread (the Wed 23 case); a host with `projects: "all"` unread
makes every project's time there unread; a flagged day's
`unattendedUnreadMs` equals its `unattendedMs` for the day and for each
project; a minute where A is supervised and B is unread counts as supervised
for the day, and one where A is unread and B unattended counts as unread;
the day's figure equals the union of the projects' `unclear` stretches minus
`supervisedUnion`; with nothing read, `supervisedMs` is 0 and
`unattendedUnreadMs` equals `wallMs`.

Everything else the page shows is already in the response: `totals`
(reported, by-the-minute, billable, the agent split, agent-hours, `coverage`,
`missingSourceDays`), `days[]` (value, `coverage`, `unknown`, `missingSource`,
the agent split), `projects[]` (hours, `humanReassignedMs`, `coverage`,
`billable`, `requests`, `conversations`, `byHost`, `bySurface`, `byKind`,
`byEngine`, `byRole`, `pipelines`, the agent split), `coverage.hosts`,
`indexedAtMs`, `unregisteredConversations`, `billableConfigured`.

## Build

What the build does that this concept did not say, or says differently:

- **Keys.** The Copy table lists the keys the build uses. Strings the phone
  layout still shows keep their prototype keys and wording; the desktop words
  them under its own (`activity.fig.billable`, `activity.detail.*`).
- **Presentation fields beyond the proposal**: `DayActivity.workday` (weekend
  labels follow the configured workdays, not Saturday and Sunday) and
  `ActivityHostRow.unread`. `unclearDays` names a day only when it holds at
  least a minute of unclear time. An hour's `project` and `agentProject` are
  null when the hour holds none; the page reads that as "no project" only
  when the hour has minutes.
- **`+ N more`** opens the whole list, scrolling inside the card.
- **Focus.** A day pair shows its frame only when a keyboard reached it; a
  pointer gets the tooltip alone. A Rhythm row takes focus and moves by hour
  with the arrow keys.
- **More than three flagged days** in the drawer are one row that lists them.
- **Dates** come from `Intl` (`18 – 24 Sept` in Chrome's en-GB, `18–24 вер.`).
- **Renders** of the built page, from a seeded home with the invented data
  above: `BOARD_CAPTURE_CASE=activity bun scripts/capture-board-geometry.ts`
  against a production build, copied with
  `ACTIVITY_RENDER_DIR=~/Pictures/delegatus-review/activity-dashboard-v2/build`.
  The case checks the 7-day page ending inside 900 px, the trust chip and the
  Rhythm legend on one line (also at 1280×800 in Ukrainian), no cut text, and
  tooltips inside the viewport, and writes every reading to `activity.json`.

## Phone

Unchanged in this lane. The v2 layout applies from 1024 px wide; below it the
prototype's phone layout renders as it does now, and its strings stay
available. A phone pass is Deferred.

## Notes for the builder

- The chart and the grid are inline SVG, as the prototype's timeline is; no
  chart library. The two hatches are SVG patterns defined once per page and
  referenced by both; the meter and the legend swatches use the same stripes
  as CSS gradients at the same angle.
- Component split: `ActivityFigures`, `ActivityDayChart`, `ActivityRhythm`,
  `ActivityProjects` (with the in-place detail and its `More detail`),
  `ActivityTrustChip`, `ActivityCountingDrawer`. The existing
  `ActivityDashboard` keeps the fetch and the range state, and the phone
  branch.
- Keyboard: the range switch is a tablist; each day pair, each Rhythm row and
  each project row is focusable and shows its tooltip or detail on focus;
  `More detail` is a disclosure button; the drawer traps focus and returns it
  to the control that opened it.
- A hidden table view of the day chart (date, reported hours, by the minute,
  supervised, unattended, unclear) for screen readers and `forced-colors`.
- Rendered evidence goes through the capture case the prototype already added
  to `scripts/capture-board-geometry.ts`; no new driver. The cases to render:
  7 days en and uk, 30 days, Today complete and with an unread stretch, drawer
  open, a project expanded with `More detail` open, the day tooltip on a
  complete, a lower-bound and a flagged day, nothing read, at 1440×900 and
  1280×800 with no page scroll for 7 days.

## The mockup

`docs/design/activity-dashboard-v2/mockup.html` is one self-contained file:
the app's tokens by value, invented data shaped like the response plus the
proposed fields, and the page drawn in HTML and SVG. The data is uneven on
purpose: a 10.5-hour Monday, an empty weekend with night agent runs, the
stage host offline on Tuesday and Wednesday (a lower-bound Wednesday and a
flagged Tuesday), 13 projects of which three have agent time only, and a
generated month behind the last week. Two hosts: the workstation holds every
project and is always read (except in the nothing-read state); the stage host
holds orchard-client and harbor-ledger. Supervised time is computed per
project and hour as agent minutes inside your read minutes on that project,
so no project shows more supervised time than your own; the rest of a
project's agent minutes is unclear where its input was not read (its host
unread, or a flagged day) and unattended otherwise. Projects never share a
minute in this data, so their parts add up to the day's exactly.

Parameters: `lang=en|uk`, `range=today|7d|30d`,
`state=default|drawer|expand|expand-more|hover|hover-agents|hover-cell|empty`,
`day=YYYY-MM-DD` (the day the hover tooltip opens on), `project=<name>` (the
row `state=expand` opens, harbor-ledger by default), `data=gap` (the stage
host unread today 09:00–12:00), `theme=light|dark`.

Render, from a copy outside the worktree:

```
google-chrome-stable --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1440,900 --virtual-time-budget=2000 \
  --screenshot=mockup-1440.png "file://$PWD/mockup.html?range=7d"
```

The page writes a self-check into `body[data-measure]` (read it with
`--dump-dom`): the card rectangles, the document's scroll width, any text
element whose content overflows its box, any tooltip outside the viewport, a
word count, and the unclear rule checked three ways:

- per day, the supervised, unattended and unclear minutes, with
  `unclearOnReadProjects` (unclear minutes on a project whose input was read)
  and `unattendedOnUnreadProjects` (unattended minutes on one whose input was
  not); both are 0 on every day of every range and state;
- per project, its unclear minutes and the part of them from flagged days,
  with `projectsUnclearSum` against the range's unclear minutes, and
  `unclearOnProjectsReadThrough`: the unclear minutes, outside flagged days,
  of the projects no unread host holds. On 7 days: harbor-ledger 96 (all on
  Wed 23, its host unread), tidewater-app 135 and kestrel-cli 58 (all on the
  flagged Tue 22), sum 289 = the range's 289, and 0 for the projects read
  through. Today with the gap: orchard-client 162 = 162. Nothing read: 3,015
  = 3,015;
- `wed18`, the Wed 23 18:00 cell: 51 minutes unattended, 0 unclear, drawn
  solid teal.

Renders in `~/Pictures/delegatus-review/activity-dashboard-v2/`, all at
1440×900 unless named otherwise: `mockup-1440.png` (7 days, en),
`mockup-1440-{uk,30d,uk-30d,dark}.png`,
`mockup-1440-{today,today-gap,uk-today-gap,today-gap-drawer}.png`,
`mockup-1440-{drawer,uk-drawer}.png`,
`mockup-1440-{expand,expand-more,uk-expand-more,expand-kestrel}.png`,
`mockup-1440-{hover,hover-wed,hover-tue,uk-hover-wed,hover-agents,hover-cell}.png`,
`mockup-1440-{empty,uk-empty,dark-empty}.png`, and `mockup-1280x800{,-uk}.png`.

Measured on those renders:

| render | page ends at | horizontal overflow | overflowing text | words (DOM) |
|---|---|---|---|---|
| 7 days, en | 778 px | none | none | 166; about 100 by OCR (prototype: about 400 in the first 900 px, 821 on the page) |
| 7 days, uk, and dark | 778 px | none | none | 166 |
| 30 days, en and uk | 861 px | none | none | 152 |
| Today, all read | 585 px | none | none | 88 |
| Today, stage host unread 09:00–12:00 (en / uk) | 585 / 605 px | none | none | 92 |
| nothing read (en / uk / dark) | 778 / 779 / 778 px | none | none | 123 / 121 / 123 |
| a project expanded (harbor-ledger / kestrel-cli) / with `More detail` (en / uk) | 778 px (rows fold into `+ N more`) | none | none | 209 / 201 / 273 / 262 |
| tooltips (day, Agents, Rhythm cell) | 778 px | none | none, every tooltip inside the viewport | 180–229 |
| drawer open (en / uk / Today unread) | – | none | none | 401 / 373 / 311 with the drawer |
| 7 days at 1280×800, en and uk | 778 px (document 794 px, inside an 800 px viewport; with browser chrome, a 713 px one, it scrolls 81 px) | none | none | 166 |

The "inside the viewport" checks ran in the 1440×813 viewport that headless
Chrome reports for a 1440×900 window when it dumps the DOM, the size of a
1440×900 screen minus browser chrome; the 7-day page fits it (794 px).

Every render was looked at, at full size or zoomed, after the last change.
Faults found on the way and fixed in the mockup: raw-minute precision on
agent figures; `≈ 0 m` on projects with no agent time; a split whose rounded
parts did not add up to the total; a two-lane rhythm that turned into noise
at 30 days; `0 m supervised` shown for a day with no input read; a tooltip
whose project list did not add up to the day; a doubled full stop after a
Ukrainian month abbreviation; the Ukrainian "Today" label touching the card
edge on 30 days. In revision 2: agent time of unread days drawn as solid
unattended (Tue 22 whole, Wed 23 partly); the nothing-read page painting all
agent time in the supervised colour; Today drawing nothing for an unread
hour; per-hour ghost columns on Today that read as a third series and had no
legend there (replaced by one labelled band); a tooltip value column
stretched to the width of its note; a tooltip that covered the meter it
explains and another that ran over the Projects card; agent-hours printed as
`11 h agent-hours`; engine and role lists that did not add up to the
agent-hours beside them; hatch stripes leaning one way in the chart and the
other in the legend; a project showing more supervised time than your own
time on it. In revision 3: unclear judged per day, which hatched lantern-api,
kestrel-cli and sorrel-bot time on Wed 23 while the list showed those
projects fully read (≈ 8 h unclear on the 7-day meter where ≈ 5 h is
supported); an unclear note that did not say which projects it covered; a
Rhythm cell tooltip that printed read minutes without `≥` inside an unread
stretch.

## Options considered

1. **Your column stacked by project in categorical hues** (the WakaTime
   look). It answers "which project on which day" in the chart itself, at the
   cost of seven or more hues on a page whose complaint is noise; the long
   tail needs an "Other" band anyway, and the agents' teal then competes with
   a project hue. Chosen: two hues, with the per-day project split in the
   day tooltip and the range split in the Projects list.
2. **Raw minutes as the hero** (the prototype). Rejected: the operator
   counts and bills in reported hours; raw minutes stay one line below.
3. **Mirrored columns** (you above a baseline, agents below). It makes "never
   added" vivid, and it makes the agent magnitudes read downward and wastes
   half the plot on days with little agent work. Chosen: side-by-side pairs
   on one axis.
4. **Rhythm with two lanes per day** (you, agents): drawn in the mockup's
   first rounds. At 30 days it became a barcode, and the agents lane repeated
   what the you lane already implied (supervised agents sit inside your
   hours). Chosen: one lane, agents shown only where they worked without you.
5. **Rhythm as intensity of minutes**: set aside for the report bins
   (under 10, 10–39, 40+), which make a row add up to the reported figure.
6. **Trust as a popover** beside the chip, with the method in a separate
   drawer: two surfaces for one question. Chosen: one drawer, two entry
   points.
7. **A weekday × hour punch card for 30 days**: a cleaner pattern, and it
   hides which day had the gap. Deferred.
8. **Bounds on a two-part split** (`≥ supervised · ≤ unattended`, revision
   1). Cheaper in words, and it left the unread hours drawn in the
   unattended colour, so the chart said "unattended" where the text said
   "at most". Chosen: a third, textured part.
9. **Today's unread hours as a hatched ghost in each of your slots**
   (revision 2's first render). Precise per hour, and three striped columns
   read as a third series with no legend on that range. Chosen: one band
   behind the stretch, labelled with the host.
10. **Unclear judged per day** (revision 2): any agent time outside your
    time in a stretch some host was not read. One interval test per day, and
    it contradicts the Projects list whenever the unread host holds only some
    projects: on Wed 23 it called ≈ 3 h 40 m unclear on projects the list
    showed as fully read. Chosen: judged per project with the list's own
    test (`uncoveredSpans` with the project), and the day shows the union.
11. **A flagged day marks every project row `≥`**, which would make the list
    and the split one test for flags too. It puts the same mark on all 13
    rows for one suspect day and says nothing about any one project, the
    noise the prototype was rejected for. Chosen: the flag marks its day,
    the hero and the chip, makes that day's agent time unclear for every
    project, and an expanded row names the day on its unclear part.

## Deferred — not currently justified

- **Selecting a project to scope the charts** (the rest turns grey). Useful,
  and the four questions are answered without it; it would also need
  per-day, per-project agent time in the response.
- **A per-project page**, **week navigation** (previous and next week),
  **custom ranges**, **CSV export**.
- **The phone redesign.**
- **The 30-day weekday punch card** (option 7).

## Validation against the requirement

| requirement | v2 |
|---|---|
| Q1 at a glance: how much, which projects, report hours | the 44 px reported-hours figure with billable beside it; the Projects list; each day's reported hours on its column |
| Q2 at a glance: agent work, unattended share | one `≈` figure and a meter whose three parts are labelled; unattended is agent time outside your time on its project while that project's input was read; the Rhythm's teal cells show the hours with no reported input from you in which agents kept working |
| one strong chart | the by-day paired columns |
| Q3 as a compact timeline | the Rhythm grid, 7 rows × 24 hours in 250 px; on Today the hourly chart |
| Q4 small, quiet, expands on demand | one header chip opening the drawer; `≥`/`?` and the hatch only on what they qualify |
| method prose, hosts table, surface table leave the main view, one affordance | all in one drawer, reached from the chip or "How it's counted" |
| 7 days readable without scrolling at 1440×900 | ends at 778 px (30 days too, at 861 px) |
| far fewer words | 166 in the DOM, about 100 by OCR, against about 400 in the first screen and 821 on the whole prototype page |
| every number labelled once | the figure labels are the chart legend; your value is printed once per day; agent values per day only in the tooltip |
| keep the method, the API and its data | unchanged; presentation fields added, each an existing intermediate value or an intersection of two returned ones; every prototype measure reachable in two clicks (table above) |
| human and agent time never added | two figures, two columns side by side, never stacked together |
| supervised vs unattended | the meter, the stacked agent column, the rhythm's "agents without you", each project's Agents line |
| Unknown / lower bound, never a clean zero for unread data | `≥`, `?`, `Unknown`, the hatch; `0` printed only when everything was read; agent time never called unattended where its project's input was not read, on any range, and never called unclear where it was (checked per project and hour) |
| Today / 7 days / 30 days | all three, drawn and measured, Today also with an unread stretch |
| days and projects views | both on one screen; a project row expands to its detail and its breakdowns |
| en + uk | every string in the Copy table, both languages rendered |
| desktop only, phone unbroken | v2 from 1024 px; the phone layout unchanged |
| realistic uneven fixtures, no operator strings | invented projects and hosts; a heavy day, an empty weekend, a host unread for two days, a long tail |
