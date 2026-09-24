# Activity dashboard v2: the desktop presentation

- Status: concept and static mockup, design stage. No product code changed.
- Grounded on: PR #2126, branch `pipeline/activity-dashboard-prototype` at
  `e40861caa`. The counting method, the sources and the API stay as
  `docs/design/activity-dashboard.md` defines them. This document replaces
  only the presentation that doc's "Prototype scope" describes.
- Mockup: `docs/design/activity-dashboard-v2/mockup.html` (invented data,
  every state behind a URL parameter). Its renders live outside the
  repository, in `~/Pictures/delegatus-review/activity-dashboard-v2/`, because
  the publication gate refuses committed rasters.
- Prior work searched: the transcript index returned the prototype lane's own
  design, build and review conversations (2026-09-24) and nothing earlier on
  presenting this page. The dashboard design rules applied here come from the
  data-visualisation method the lane loaded, checked against the app's tokens.

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
  (host, surface, input kind, engine, role, pipelines) that none of the four
  questions asks for.
- The supervised tile's meter has no labels on its two parts.

**Trust noise.**
- On 30 days, 16 rows read "Probable missing source" in the warning colour,
  every row adds `≈ 0 m`, and the empty state repeats the warning on 22
  rows while hatching the whole page.
- About 20 `≈`/`≥` glyphs on the 7-day page, one on nearly every figure.
- The same gap is stated three times: in the banner, on the day rows, and
  under the host in the hosts table.
- A day whose human input was not read still shows its agent time as
  `0 m supervised`, a claim that the operator was away. The split cannot be
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
| 2 | How much did agents work, how much unattended? | the **Agents** figure with its two-part meter | yes: one number, one proportion |
| 1+2 per day | …and on which day? | the **by-day chart**: your reported hours beside agent time | yes: seven column pairs |
| 3 | When during the day? | the **Rhythm** grid, one cell per clock hour | a compact second read |
| 4 | Can I trust it? | one **trust chip** in the header, `≥`/`?` marks where they apply, the **drawer** | quiet until opened |

## The concept

One screen with one number to read first, one chart to read second, and
nothing that is not an answer to the four questions. Two hues carry the whole
page: the app's accent (indigo) is **you**, its info teal is **agents**, each
with one lighter step. Status colour (warning amber) appears only where trust
is in question. Everything that explains the method lives behind one drawer.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ [← Board]  Activity  18–24 Sept         [Today|7 days|30 days] [⚠ Lower bound] ⓘ How… │
├───────────────────────────────────────────────────────┬──────────────────────────────┤
│ ■ You                      ■ Agents                   │ Projects 13        You⌄ Agents│
│ ≥ 27.5 h reported          ≈ 50 h                     │ orchard-client [billable] ≥9 h│
│ ≥ 23 h 42 m by the minute  ▇▇▇▇▇▇▇▇░░░░░░░░░░░░        │ ▇▇▇▇▇▇▇▇▇▇            ≈ 12 h │
│ · ≥ 14 h billable          ■ ≥ 18 h supervised        │ lantern-api        7.5 h ≈15 h│
│                            ■ ≤ 32 h unattended        │ …  (rows fill the column;     │
│ ───────────────────────────────────────────────────── │     the rest folds into       │
│ 16 h                  10.5                            │     "+ N more")               │
│      8.5               ▇▒                   ≥ 4  4.5  │                              │
│      ▇▒          0  0  ▇▇     ?             ▇▒   ▇▒   │                              │
│      ▇▇     ▒    ▒  ▒  ▇▇     ▒             ▇▇   ▇▇   │                              │
│     Fri 18 Sat 19 Sun 20 Mon 21 Tue 22 Wed 23 Today   │                              │
├───────────────────────────────────────────────────────┤                              │
│ Rhythm              ■ 1 h ■ ½ h ■ agents without you ▨│                              │
│ Fri 18  ▒▒▒▒·····▇▇▇▇▒▇▇▇▇▆▆··▆▒▒                      │                              │
│ …one row per day, 24 hour cells                       │                              │
│ Today   ··▒▒····▆▇▇▇▆▆                                │                              │
│         00      06      12      18      24            │                              │
└───────────────────────────────────────────────────────┴──────────────────────────────┘
```

**Information hierarchy**, in reading order:

1. **You**: reported hours for the range. The only hero figure on the page.
2. **Agents**: approximate agent wall-clock, then its supervised and
   unattended parts.
3. **By day**: the same two measures per day, side by side.
4. **Projects**: the reported hours per project, agent time beside it.
5. **Rhythm**: when, per day and hour.
6. **Trust**: a chip in the header; its detail is one click away.

The figure labels double as the chart legend: the indigo square beside "You"
and the teal squares beside "supervised" and "unattended" are the only legend
the day chart has, and every number on the page has exactly one label.

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
Under it a 6 px two-part meter (supervised teal, unattended light teal, 2 px
surface gap) and its labelled parts:
`■ ≥ 18 h supervised  ■ ≤ 32 h unattended`.

- One figure for agents. Agent-hours (parallel agents each counted) moves to
  the figure's tooltip and the drawer; it answers none of the four questions
  on its own and was the prototype's duplicate tile.
- The parts are rounded so they add up to the total shown.
- **When your time is a lower bound, supervised is too and unattended is an
  upper bound.** Reading the missing input can only move agent time from
  unattended to supervised, so the parts carry `≥` and `≤`. This is a
  presentation of the existing split; the counting is unchanged.
- **When none of your time was read,** the split is not shown at all: the
  meter is one teal bar and the line reads "Split unknown: your time was not
  read." The prototype printed `0 m supervised` there.

### By-day chart (questions 1 and 2, per day)

Paired columns on one hour axis, one pair per day: **your reported hours**
(indigo) on the left and **agent wall-clock** on the right, stacked
supervised (teal, at the base) and unattended (light teal, on top) with a
2 px surface gap. Both measures are hours, so one axis is honest; they stand
side by side and are never stacked together, which is the rule "never added"
drawn as geometry.

- Your column carries its value on the cap (`8.5`, `≥ 4`, `0`, `?`): that is
  the day's figure for the report, and the only number labelled per day. Agent
  columns carry none; the axis and the tooltip hold their values.
- Columns are at most 22 px wide, 4 px rounded at the data end and square at
  the baseline; hairline solid gridlines on clean ticks (every 4 h up to 16 h); the unit sits on
  the top tick (`16 h`).
- Day labels under the pairs; weekends in muted ink, today as **Today**.
- Hover or keyboard focus on a pair opens the day tooltip (below).

Why this chart: it answers "how much, per day" for both axes at once, shows
the heavy day, the empty weekend and the unread days without reading a
number, and keeps the two measures apart. A stacked-by-project column was
considered and set aside (see Options).

### Rhythm (question 3)

A day × hour grid: one row per day, 24 cells per row, each cell one clock
hour. A cell is

| cell | meaning |
|---|---|
| indigo | an hour you worked a full reported hour (40 minutes or more) |
| light indigo | an hour that reported half an hour (10 to 39 minutes) |
| light teal | agents worked at least 10 minutes and you did not |
| hatched | a host was not read for that hour, nothing else known |
| hatched light teal | agents worked, your input for that hour was not read |
| faint track | nothing happened, and everything was read |
| none | a future hour today |

One cell per hour ties the rhythm to the billable figure: under clock-hour
weights, a row's indigo cells count one hour each and its light ones half an
hour, so the row adds up to the day's reported hours. Agents alongside you are
already inside your hours; the grid shows agents only where they worked
without you, which is the "while I was away" part of question 2 and the
"gaps" part of question 3. Under half-hour rounding the same bins are
labelled `40+ min` and `10–39 min`.

Legend, top right of the card: `■ 1 h  ■ ½ h  ■ agents without you  ▨ not read`.
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
- A row is `≥` when a host holding the project was not read for part of the
  range, `?` when nothing was read.
- **Click a row to expand it in place** (the Projects view's detail, now
  four lines):
  `You  ≥ 8 h 5 m by the minute · 71 inputs`
  `Agents  9 h supervised · 3 h unattended · 7 agents`
  `Hosts  Stage host 7 h 17 m · Workstation 49 m`
  `Pipelines  3 · ≈ 7 h 5 m`

The Days and Projects views are kept by showing both at once. The tab switch
between them goes.

### Trust chip and the "How it's counted" drawer (question 4)

One chip in the header, 28 px tall:

| state | chip |
|---|---|
| every expected host read for the range, no flagged day | `✓ All sources read` (success check, secondary text) |
| any host unread for part of the range, or a probable missing source | `⚠ Lower bound` (warning tone) |
| nothing read for the range | `⚠ Nothing read` (warning tone) |

Both the chip and `ⓘ How it's counted` open the same right-hand drawer
(460 px, scrim over the page, closes on Escape and on the scrim). The chip
opens it at the top; its sections:

1. **This range**: one warning row per problem, in plain words
   ("Stage host was not read on 22–23 Sept. Your hours there may be
   higher." / "Tue 22 Sept reads zero on a workday while agents ran. A
   source is probably missing."), then one row per host: a check or a
   warning icon, its name, its sources and what they were read for.
2. **Method**: five short bullets (window, reported-hour weights, only your
   input, agent time and the split, the time zone).
3. **Excluded as not your input**: collapsed; the per-host exclusion counts.
4. **What each surface contributes**: collapsed; three lines.
5. A muted footer: when agent time was indexed, how many agents the registry
   does not know.

On the page itself trust shows only where a figure depends on it: `≥` on a
lower bound, `?` on a day or project that was not read, amber `?` on a
probable missing source. A problem is described once, in the drawer.

### Tooltips

- **Day pair** (hover or focus):
  `Mon 21 Sept` /
  `■ 10.5 h reported · 9 h 11 m by the minute` /
  `■ ≈ 14 h · 6 h 50 m supervised` /
  muted: `harbor-ledger 4 h · orchard-client 2.5 h · lantern-api 2 h · …`
  (the day's reported hours per project, which is what the daily report
  copies). On a lower-bound day a last line: `Stage host not read: at least
  this.` On a flagged day: `A workday reads zero while agents ran: a source
  is probably missing.` When your time was not read, the agent line adds
  `Your time was not read, so the split is uncertain.`
- **Rhythm cell**: `Mon 21 Sept, 14:00–15:00` / `You 48 min · lantern-api` /
  `Agents 55 min`.
- **Agents figure**: `≈ 61 agent-hours: parallel agents each counted.`

Every tooltip value is also reachable without hover: day values through the
table view of the chart (screen readers and `forced-colors`), project values
in the list.

## Ranges

| | Today | 7 days | 30 days |
|---|---|---|---|
| header date | `Thursday, 24 Sept` | `18–24 Sept` | `26 Aug – 24 Sept` |
| main chart | hourly pairs, minutes per hour (`60 min` top tick), a hairline at now, labels every 3 h | daily pairs, value on each of your caps | daily pairs, 10 px columns; only `≥`/`?` marks on caps; labels on Mondays and today |
| rhythm | hidden (the chart is hourly) | 7 rows × 24, 18 px | 30 rows × 24, 7 px |
| projects | today's projects | the range's | the range's |
| fits 1440×900 | yes, ends at 585 px | yes, ends at 778 px | yes, ends at 861 px |

## States

| state | You figure | chart | rhythm | projects | chip |
|---|---|---|---|---|---|
| complete | `27.5 h` | caps plain, `0` in muted ink on a clean zero | cells as read | plain | `✓ All sources read` |
| lower bound | `≥ 27.5 h`; `≥` on minutes and billable; agents `≥`/`≤` | `≥ 4` on the affected days | hatched cells where unread | `≥` on projects the unread host holds | `⚠ Lower bound` |
| probable missing source | as lower bound | amber `?` on the day's cap, no column | the day's cells hatched | – | `⚠ Lower bound`; one row in the drawer |
| nothing read for the range | `Unknown` (32 px), "No host was read for this range." and `🔌 Connect a host` (opens the drawer at Hosts) | agent columns only, one teal (split unknown); muted `?` on every cap | hatched, agents hatched light teal | `?` in the You column, sorted by Agents | `⚠ Nothing read` |
| agent index not built yet | unchanged | your columns only | your cells only | agents column `…` | unchanged; the drawer says "Agent time appears after the first transcript scan." |
| a project with no agent time | – | – | – | `–` in the Agents column | – |
| future hours today | – | nothing drawn | nothing drawn | – | – |
| loading, first time | three card skeletons at their final sizes | | | | |
| loading, range switch | the previous render held at 60 % opacity, no layout jump | | | | |
| error | the card body reads "The activity report could not be loaded." with `Retry` | | | | |

The rule behind every row: a figure that could be higher carries `≥`, a
figure that could be lower carries `≤`, a value nothing was read for is `?`
or `Unknown`, and a zero is printed only when every expected source was
read. A flag that applies to the whole range (nothing read) is stated once
and is not repeated per day.

## Copy

Every visible string of the main view and the drawer. `{…}` are values.
Units follow the app: `h`/`m` and `год`/`хв`; decimals use a comma in
Ukrainian.

| key (proposed) | en | uk |
|---|---|---|
| `activity.back` (kept) | Board | Дошка |
| `activity.title` (kept) | Activity | Активність |
| `activity.range.*` (kept) | Today / 7 days / 30 days | Сьогодні / 7 днів / 30 днів |
| `activity.trust.ok` | All sources read | Усі джерела прочитано |
| `activity.trust.lower` | Lower bound | Нижня межа |
| `activity.trust.none` | Nothing read | Нічого не прочитано |
| `activity.how` | How it's counted | Як рахується |
| `activity.fig.you` | You | Ви |
| `activity.fig.agents` | Agents | Агенти |
| `activity.fig.reported` | reported | у звіті |
| `activity.fig.byMinute` | {value} by the minute | {value} похвилинно |
| `activity.tile.billable` (reworded) | {value} billable | {value} оплачуваних |
| `activity.fig.supervised` | {value} supervised | {value} під наглядом |
| `activity.fig.unattended` | {value} unattended | {value} без нагляду |
| `activity.fig.splitUnknown` | Split unknown: your time was not read. | Розподіл невідомий: ваш час не прочитано. |
| `activity.unknown` (kept) | Unknown | Невідомо |
| `activity.fig.noneRead` | No host was read for this range. | За цей період не прочитано жодного хоста. |
| `activity.fig.connect` | Connect a host | Підʼєднати хост |
| `activity.fig.indexing` | Indexing transcripts… | Індексуємо транскрипти… |
| `activity.fig.agentHours` | ≈ {value} agent-hours: parallel agents each counted. | ≈ {value} агенто-годин: паралельні агенти рахуються окремо. |
| `activity.chart.today` | Today | Сьогодні |
| `activity.chart.unitH` | h | год |
| `activity.chart.unitMin` | min | хв |
| `activity.rhythm.title` | Rhythm | Ритм |
| `activity.rhythm.full` | 1 h | 1 год |
| `activity.rhythm.half` | ½ h | ½ год |
| `activity.rhythm.full40` / `half10` (half-hour rounding) | 40+ min / 10–39 min | 40+ хв / 10–39 хв |
| `activity.rhythm.alone` | agents without you | агенти без вас |
| `activity.rhythm.unread` | not read | не прочитано |
| `activity.view.projects` (kept) | Projects | Проєкти |
| `activity.col.you` | You | Ви |
| `activity.col.agents` | Agents | Агенти |
| `activity.project.billable` (kept) | billable | оплачуваний |
| `activity.projects.more` | + {n} more | + ще {n} |
| `activity.unattributed` (kept) | No project | Без проєкту |
| `activity.project.byMinute` | {value} by the minute | {value} похвилинно |
| `activity.project.requests` (kept) | {n} input / inputs | {n} ввід / вводи / вводів / вводу |
| `activity.project.agents` (kept) | {n} agent / agents | {n} агент / агенти / агентів / агента |
| `activity.project.hosts` | Hosts | Хости |
| `activity.project.pipelines` | Pipelines | Пайплайни |
| `activity.tip.reported` | {value} reported | {value} у звіті |
| `activity.tip.supervised` | {value} supervised | {value} під наглядом |
| `activity.tip.lower` | {host} not read: at least this. | {host} не прочитано: щонайменше стільки. |
| `activity.tip.missing` | A workday reads zero while agents ran: a source is probably missing. | Робочий день показує нуль, хоча агенти працювали: ймовірно, бракує джерела. |
| `activity.tip.split` | Your time was not read, so the split is uncertain. | Ваш час не прочитано, тож розподіл неточний. |
| `activity.drawer.title` | How this is counted | Як це рахується |
| `activity.drawer.close` | Close | Закрити |
| `activity.drawer.range` | This range | Цей період |
| `activity.drawer.method` | Method | Метод |
| `activity.drawer.flagLower` | {host} was not read on {days}. Your hours there may be higher. | {days}: {host} не прочитано, тож ваших годин тоді могло бути більше. |
| `activity.drawer.flagMissing` | {day} reads zero on a workday while agents ran. A source is probably missing. | {day} — робочий день із нулем, хоча агенти працювали. Ймовірно, бракує джерела. |
| `activity.drawer.m1` | Each of your inputs opens a 10-minute window; overlapping windows merge. A minute counts once, for the project of the latest input. | Кожен ваш ввід відкриває вікно на 10 хвилин; вікна, що перетинаються, зливаються. Хвилина рахується один раз — для проєкту останнього вводу. |
| `activity.drawer.m2` | Reported hours weigh each clock hour: under 10 minutes 0, 10–39 half an hour, 40 or more a full hour. The hour goes to the project with the most minutes. | Години у звіті зважують кожну годину за годинником: менше 10 хвилин — 0, 10–39 — пів години, 40 і більше — година. Година дістається проєкту з найбільшою кількістю хвилин. |
| `activity.drawer.m3` | Only your own input counts. Stage prompts, agent-to-agent messages, notifications and injected text are left out. | Рахується лише ваш власний ввід. Промпти етапів, повідомлення між агентами, сповіщення та вставлений текст не враховуються. |
| `activity.drawer.m4` | Agent time (≈) runs from each message to the agent's last reply. Inside your time on the same project it is supervised; the rest is unattended. Your time and agent time are never added. | Час агентів (≈) триває від повідомлення до останньої відповіді агента. У межах вашого часу на тому ж проєкті це нагляд; решта — без нагляду. Ваш час і час агентів ніколи не додаються. |
| `activity.drawer.m5` | Days and hours are in {tz}. | Дні й години — за {tz}. |
| `activity.drawer.hostRead` | Read to {when} | Прочитано до {when} |
| `activity.drawer.hostGap` | Not read {days} | Не прочитано {days} |
| `activity.hosts.thisHost` (kept) | this host | цей хост |
| `activity.drawer.srcBoth` | Request ledger and transcript export | Журнал запитів і експорт транскриптів |
| `activity.hosts.transcripts` (kept) | Transcript export | Експорт транскриптів |
| `activity.hosts.notConnected` (kept) | Not connected: its time reads Unknown | (kept) |
| `activity.drawer.excluded` | Excluded as not your input | Виключено як не ваш ввід |
| `activity.coverage.title` (kept) | What each surface contributes | Що дає кожна поверхня |
| `activity.drawer.foot` | Agent time indexed {when}. {n} agents are not in the registry, so their roles are unknown. | Час агентів проіндексовано {when}. {n} агентів немає в реєстрі, тож їхні ролі невідомі. |
| `activity.failed` (kept) + `Retry` | The activity report could not be loaded. · Retry | Не вдалося завантажити звіт про активність. · Повторити |

The surface table collapses to three lines in the drawer:
"Browser, tablet, phone: every request, voice included" / "Terminal: prompts
a CLI records as typed by a person, through a host's export" / "Outside
Delegatus (editors, Telegram, GitHub review): not seen", with the Ukrainian
lines in the mockup. The prototype's `activity.subtitle`, `activity.tile.*`
sub-lines, `activity.gap.*` banner strings, `activity.legend.*`,
`activity.breakdown.surface|kind|engine|role` and `activity.coverage.*Counted`
/ `*Missing` rows leave the page.

## Number formats

| figure | format | example |
|---|---|---|
| reported hours | halves, one decimal when needed | `27.5 h`, `27,5 год`, `9 h` |
| by the minute | hours and minutes | `23 h 42 m` |
| agent time | `≈`; whole hours from 10 h, 5-minute steps below; `–` for none | `≈ 50 h`, `≈ 8 h 50 m`, `–` |
| a split | rounded so its parts add up to the total beside it | `18 h` + `32 h` = `≈ 50 h` |
| lower bound | `≥` before the value, in muted ink, smaller on the hero | `≥ 27.5 h` |
| upper bound (unattended while your time is a lower bound) | `≤` | `≤ 32 h unattended` |
| not read | `?` on a day or row, `Unknown` for the range | |

The agent approximation is +1.7 % in aggregate and 19 % per conversation
(method doc, "Accuracy"), so printing it to the minute claimed a precision it
does not have.

## What leaves the main view, and where it goes

| prototype element | v2 |
|---|---|
| subtitle sentence | removed; the layout and the drawer's method say it |
| four equal tiles | two figures, one hero |
| "Agents working" and "Agent-hours" tiles | one Agents figure; agent-hours in its tooltip and the drawer |
| full-width incompleteness and missing-source banner | the trust chip; the sentences move to the drawer's "This range" |
| legend row | the figure labels are the legend |
| per-day 24 h timeline with four numbers per day | the by-day chart plus the Rhythm grid |
| Days / Projects switch | both visible, side by side |
| Your time / Agent time sort switch | the Projects column headers |
| six breakdown lists per project | four detail lines in the expanded row; surface, input kind, engine and role leave the page (see Deferred) |
| "What is counted" paragraphs | drawer, Method (five bullets) |
| hosts table | drawer, This range (one row per host) and "Excluded" (collapsed) |
| surface table | drawer, collapsed, three lines |

## Colour

Everything resolves to the app's tokens (`src/styles/tokens.css`). The chart
steps are new tokens, proposed for the same file so the dark palette gets
its own validated steps.

| role | light | dark | use |
|---|---|---|---|
| you | `--color-accent` `#5a51e0` | `#7f79e6` | your columns, full-hour cells, bars in Projects |
| you, half | `#9ca2f0` | `#4a4786` | half-hour cells |
| agents, supervised | `--color-info` `#0d9488` | `#20a896` | base of agent columns, meter |
| agents, unattended | `#79b9ae` | `#296b65` | top of agent columns, "agents without you" cells |
| track | `#f1ede6` | `#1f222b` | empty rhythm cells |
| hatch | `--border-strong` | `#3c404c` | not read |
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

Texture is used once, for the "not read" state; no series is textured.
The prototype's second hatch (unattended agents) is gone.

## API additions (presentation only)

The page must never re-implement the method, and two things it draws are
method outputs the response does not carry today. Both are values
`src/lib/activity/method.ts` already computes on the way to its totals;
exposing them changes no count.

```ts
interface DayActivity {
  // …existing fields…
  /** One entry per clock hour of the day in the zone (23 or 25 on DST days). */
  hours: Array<{
    start: number;            // the hour's start, ms
    humanMs: number;          // covered minutes of your time in the hour
    weight: 0 | 0.5 | 1 | null; // clockHourWeight of those minutes; null under half-hour rounding
    project: string | null;   // the project the hour's weight went to
    supervisedMs: number;
    unattendedMs: number;
    unknown: boolean;         // some expected host was not read for part of it
  }>;
  /** dayReportHours for the day, with the raw minutes behind each entry. */
  projects: Array<{ project: string | null; humanMs: number; humanHours: number }>;
}
```

Tests the builder adds beside `method.test.ts`: for every day, the weights
of `hours` sum to `humanHours` under clock-hour rounding; `projects` sums to
`humanHours` and `humanMs`; the hours' supervised and unattended sum to the
day's; an hour inside an uncovered span is `unknown`.

Everything else the page shows is already in the response: `totals`
(reported, by-the-minute, billable, the agent split, `coverage`,
`missingSourceDays`), `days[]` (value, `coverage`, `missingSource`, the
agent split), `projects[]` (hours, `coverage`, `billable`, `requests`,
`conversations`, `byHost`, `pipelines`, the agent split), `coverage.hosts`,
`indexedAtMs`, `unregisteredConversations`, `billableConfigured`.

## Phone

Unchanged in this lane. The v2 layout applies from 1024 px wide; below it the
prototype's phone layout renders as it does now, and its strings stay
available. A phone pass is Deferred.

## Notes for the builder

- The chart and the grid are inline SVG, as the prototype's timeline is; no
  chart library.
- Component split: `ActivityFigures`, `ActivityDayChart`, `ActivityRhythm`,
  `ActivityProjects` (with the in-place detail), `ActivityTrustChip`,
  `ActivityCountingDrawer`. The existing `ActivityDashboard` keeps the fetch
  and the range state, and the phone branch.
- Keyboard: the range switch is a tablist; each day pair and each project row
  is focusable and shows its tooltip or detail on focus; the drawer traps
  focus and returns it to the control that opened it.
- A hidden table view of the day chart (date, reported hours, by the minute,
  supervised, unattended) for screen readers and `forced-colors`.
- Rendered evidence goes through the capture case the prototype already added
  to `scripts/capture-board-geometry.ts`; no new driver. The cases to render:
  7 days en and uk, 30 days, Today, drawer open, a project expanded, nothing
  read, at 1440×900 and 1280×800 with no page scroll for 7 days.

## The mockup

`docs/design/activity-dashboard-v2/mockup.html` is one self-contained file:
the app's tokens by value, invented data shaped like the response plus the
two proposed fields, and the page drawn in HTML and SVG. The data is uneven
on purpose: a 10.5-hour Monday, an empty weekend with night agent runs, the
stage host offline on Tuesday and Wednesday (a lower-bound Wednesday and a
flagged Tuesday), 13 projects of which three have agent time only, and a
generated month behind the last week.

Parameters: `lang=en|uk`, `range=today|7d|30d`,
`state=default|drawer|expand|hover|empty`, `theme=light|dark`.

Render, from a copy outside the worktree:

```
google-chrome-stable --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1440,900 --virtual-time-budget=2000 \
  --screenshot=mockup-1440.png "file://$PWD/mockup.html?range=7d"
```

The page writes a self-check into `body[data-measure]` (read it with
`--dump-dom`): the card rectangles, the document's scroll width, any text
element whose content overflows its box, and a word count.

Renders in `~/Pictures/delegatus-review/activity-dashboard-v2/`:
`mockup-1440.png` (7 days, en), `mockup-1440-{uk,30d,uk-30d,today,drawer,uk-drawer,expand,hover,empty,dark}.png`, and `mockup-1280x800{,-uk}.png`.

Measured on those renders at 1440×900:

| render | page ends at | horizontal overflow | overflowing text | words |
|---|---|---|---|---|
| 7 days, en | 778 px | none | none | 162 in the DOM; 109 by OCR (prototype: about 400 in the first 900 px, 821 on the page) |
| 7 days, uk | 778 px | none | none | 162 |
| 30 days, en and uk | 861 px | none | none | 148 |
| Today | 585 px | none | none | 88 |
| nothing read | 778 px | none | none | 132 |
| drawer open (en / uk) | – | none | none | 354 / 335 with the drawer |
| 7 days at 1280×800, en and uk | 778 px (document 794 px, inside the 800 px window) | none | none | 162 |

Every render was looked at, at full size, after the last change. Faults
found on the way and fixed in the mockup: raw-minute precision on agent
figures; `≈ 0 m` on projects with no agent time; a split whose rounded parts
did not add up to the total; a two-lane rhythm that turned into noise at 30
days; `0 m supervised` shown for a day with no input read; a tooltip whose
project list did not add up to the day; a doubled full stop after a
Ukrainian month abbreviation; the Ukrainian "Today" label touching the card
edge on 30 days.

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

## Deferred — not currently justified

- **Selecting a project to scope the charts** (the rest turns grey). Useful,
  and the four questions are answered without it; it would also need
  per-day, per-project agent time in the response.
- **Surface, input-kind, engine and role breakdowns** in the UI. The data
  stays in the response; no question asks for it on this page.
- **A per-project page**, **week navigation** (previous and next week),
  **custom ranges**, **CSV export**.
- **The phone redesign.**
- **The 30-day weekday punch card** (option 7).

## Validation against the requirement

| requirement | v2 |
|---|---|
| Q1 at a glance: how much, which projects, report hours | the 44 px reported-hours figure with billable beside it; the Projects list; each day's reported hours on its column |
| Q2 at a glance: agent work, unattended share | one `≈` figure, a two-part meter, both parts labelled |
| one strong chart | the by-day paired columns |
| Q3 as a compact timeline | the Rhythm grid, 7 rows × 24 hours in 250 px |
| Q4 small, quiet, expands on demand | one header chip opening the drawer; `≥`/`?` only on figures they qualify |
| method prose, hosts table, surface table leave the main view, one affordance | all in one drawer, reached from the chip or "How it's counted" |
| 7 days readable without scrolling at 1440×900 | ends at 778 px (30 days too, at 861 px) |
| far fewer words | 109 by OCR against about 400 in the first screen and 821 on the whole prototype page |
| every number labelled once | the figure labels are the chart legend; your value is printed once per day; agent values per day only in the tooltip |
| keep the method, the API and its data | unchanged; two presentation fields added, both existing intermediate values |
| human and agent time never added | two figures, two columns side by side, never stacked together |
| supervised vs unattended | the meter, the stacked agent column, the rhythm's "agents without you" |
| Unknown / lower bound, never a clean zero for unread data | `≥`, `≤`, `?`, `Unknown`; `0` printed only when everything was read; split hidden when your time is unknown |
| Today / 7 days / 30 days | all three, drawn and measured |
| days and projects views | both on one screen; a project row expands to its detail |
| en + uk | every string in the Copy table, both languages rendered |
| desktop only, phone unbroken | v2 from 1024 px; the phone layout unchanged |
| realistic uneven fixtures, no operator strings | invented projects and hosts; a heavy day, an empty weekend, a host unread for two days, a long tail |
