# Lighter task cards on the desktop board: three flatter variants

Design only; nothing here is built. The operator picks one variant, and the
chosen one is then built as the single `PipelineBlock` that phone-kanban slice 3
already plans (`docs/design/phone-kanban.md` §3.13 and §4 slice 3, on branch
`origin/pipeline/phone-kanban-design`). Every `file:line` below is on
`origin/main` at `9197c4e97`.

## 0. The requirement

Source: the operator, in the orchestrator seat conversation, 2026-09-23 at
12:40 UTC, looking at a screenshot of a desktop task card. Verbatim, with a
translation:

> п'ятишаровий пиріг. може ще щось можна придумати як полегшити? але не
> знищуючи те що ми додали нове

("A five-layer cake. Can we think of something to make it lighter? But without
destroying the new things we added.")

A minute later, same conversation:

> Спершу покажи 2-3 варіанти, як спростити, я виберу.

("First show 2-3 options for how to simplify it; I'll choose.")

The stage specification spells this out. The five nested frames are the task
card, the "N розмов" conversation group, each pipeline card, each stage pill
(dot, engine mark, stage name, effort bars) and the "worker успішно · N хв тому"
status line. The deliverable is 2 or 3 genuinely different, flatter variants.
None of them may lose the recent additions: the PR and issue chips (#2059
`WorkLinkChip`, "без PR", +N), the stage chain with its states, the
needs-a-decision and needs-review emphasis with its actions, running and
stalled liveness, attempts, the Stages and graph entry points, and "+ Агент".
For each variant the spec asks what it removes (frames, fills, lines), what it
merges, and what it moves behind hover or expansion; how it reads at 390 px
phone card density; and before/after renders on a production build at board
widths 1440 and 1080 plus a 390 px phone, in en and uk.

Two things follow from the quote and shape everything below:

- **Lighter, measured.** Each variant is scored by what the card actually draws:
  its height, how many framed boxes it contains, and how deep they nest (§6).
- **Nothing new destroyed.** §2 lists every recent addition. Each variant keeps
  every one of them, either on the card or one hover or click away, and says
  which.

## 1. What the card draws today

The card is `KanbanCard` (`src/components/kanban/KanbanCard.tsx`). Its pipelines
are `PipelineSection` (`src/components/kanban/PipelineSection.tsx:175`). The
layers the operator counted, from the outside in:

| # | Layer | Frame today | Where |
| --- | --- | --- | --- |
| 1 | Task card | border, `--shadow-1`, `--surface-card` fill | `kanbanBoard.css:210` |
| 2 | "N conversations" group: the activity line, then each conversation as a 196 px tile | each tile bordered, working and needs-you tiles tinted or ringed | `KanbanCard.tsx:486`, `:549`; `kanbanBoard.css:291` |
| 3 | Pipeline section, one per pipeline | tinted `--surface-well` fill, a border tinted by the task colour, 8 px radius | `PipelineSection.tsx:226`; `kanbanBoard.css:323` |
| 4 | Stage pill | bordered pill on `--surface-card`, holding the dot, the engine mark, the name and the effort ladder | `PipelineSection.tsx:709`; `kanbanBoard.css:365`; `identityMarks.tsx:82` |
| 5 | Status line: the stage report ("worker passed · 5m ago") and findings | text, but it sits inside layer 3, inside layer 1 | `PipelineSection.tsx:282` |

Four more things add weight without being one of the five layers:

- **Every pipeline header has its own state chip** (`.pstate-chip`,
  `kanbanBoard.css:352`), which is a bordered pill. It also has a graph toggle,
  a "Stages" button and a ⋯ menu, which is three controls per pipeline.
- **The PR chips are drawn twice.** The task's chip row aggregates every
  pipeline's links (`KanbanCard.tsx:383`), and each pipeline repeats its own
  chips (`PipelineSection.tsx:267`). On the Copilot card below, `#2031 #2030`
  appear on consecutive rows.
- **The pipeline title repeats the task title** whenever a task has one pipeline
  created from its own text: "Restore search results after th…" under "Restore
  search results after the index rebuild".
- **The activity line** ("● needs you · 2 conversations · 2 stages waiting")
  says again what the state chip and the pills already say.

Measured on the rendered board (method in §9): the seven-pipeline card is
**689 px** tall and holds **25** framed boxes, nested up to **3** deep. The
eight-stage upload card nests **4** deep: card, section, pill, then the
review-round counter inside the pill.

## 2. What must survive

The quote says "not destroying what we added new". These are the recent
additions the card carries, and the checklist every variant is held to:

| Addition | What it is on the card |
| --- | --- |
| #2059 PR and issue chips | `WorkLinkChip`s, "no PR" / "без PR" on a lane without one, "+N" opening all of them |
| #1765 pipeline titles and completed fold | each pipeline named by its first prompt line; finished ones fold behind "N completed" once a card holds more than three (`KanbanCard.tsx:40`) |
| #1743 who runs a stage | the engine mark and effort ladder on each pill |
| #1798 fail edges | the return arc under the row, or the "↺ 1/2" suffix on a wrapped row (`PipelineSection.tsx:630`) |
| #1938 spent review budget | "last review fail on 4f1c2a9d · current head 9b2e7d4c unreviewed" (`PipelineSection.tsx:281`) |
| Graph slice 2 stage reports | "Builder failed · 41m ago" and ranked findings |
| #1865 attempt labels | a stage tile's "· 2" attempt suffix |
| #1834 details | the collapsed Details row |
| Liveness | the pulsing dot of a running or reviewing stage; "N working"; a stalled member |
| Decisions | needs-a-decision / needs-review emphasis, and Skip / Retry / Close through the ⋯ menu (`KanbanBoard.tsx:1274`) |
| Entry points | Stages (the sheet, which also draws the graph, `StagesSheet.tsx:263`), the inline graph toggle, "+ Agent" |

## 3. Variant A: Hairlines (the same card, one frame)

Keep today's structure and order, and take the frames away. The card stays the
only box. Pipelines sit on the card's own surface, divided by hairlines.

**Removes**

- The pipeline section's fill, border and radius. A 1 px `--border-default`
  hairline above each pipeline replaces them.
- The pill's border and fill. A stage becomes its state dot plus its name, with
  a `--surface-well` hover.
- The effort ladder and the non-default model name on the pill. The engine mark
  stays.
- The border of the "stages running" state chip, which becomes a plain word in
  its tone. Only needs-a-decision and needs-review keep a soft warning fill:
  one accent element per component (design-system rule 7).
- The conversation tiles' borders and tints. A conversation becomes a
  full-width row: engine mark, role, state word (a dot while working); then the
  latest line and the age.
- The pipeline head note ("Diagnose", "Implement"), which names the stage the
  live pill already marks.

**Merges**

- The task's chip row shows only the links no visible pipeline row already
  draws. Links of folded completed pipelines and links attached to the task by
  hand stay on it. Every link appears once on screen.

**Moves behind hover**

- The graph toggle and "Stages" appear on hover or keyboard focus of a pipeline
  row, over its right end on a card-coloured ground. ⋯ stays visible.
- The effort ladder and model move into the pill's tooltip, which already
  carries "Claude · Opus 5.5 · reasoning high" (`PipelineSection.tsx:723`), the
  Stages sheet and the graph nodes.

**Kept as is:** the activity line, the pipeline title per pipeline, the links
row per pipeline, the stage report and findings, fail-edge arcs, "N completed",
Past attempts, and the footer (status pill, age, + Agent).

**At 390 px** (`variant-a/phone-*.png`): the phone card takes the same rule, so
its pills lose their outline and a stage reads "✓ Implement → ○ Review". On the
task screen, a task's pipeline blocks share one surface with hairlines between
them, where round 2 draws one card per block, and the state chip becomes a word.
This changes the approved round-2 look. It is flatter, but the outlined pill is
what makes a 44 px stage target read as a button on a touch screen, and A
removes that cue.

**Risks**

- It is the smallest change and saves the least height: 7 % to 19 % per
  card. A pipeline still stacks four rows (title and state, links, chain,
  report), so the card is still tall. It is the same cake with less frosting.
- Controls that appear on hover cannot be discovered by looking. A desktop with
  a coarse pointer (a touch laptop) has no hover. There they must stay visible,
  as `(pointer: coarse)` already decides elsewhere.
- Hairlines alone can make two pipelines of one task read as one list. The
  600-weight pipeline title is what separates them.
- The conversation rows are taller than two tiles side by side: the export card
  grows from 224 px to 246 px.

## 4. Variant B: Lane rows (the phone's block, frameless, on the desktop)

Each pipeline becomes the phone round-2 block at task density
(`phone-kanban.md` §3.13), drawn without a frame of its own: a head line, a
chain line with its PR on the right, and the answer in place when the lane
needs the operator. That is the "one `PipelineBlock`" the spec asks for,
already approved on the phone.

```
┌▌Mobile data: stop repeated full-board downloads and             ⌄ ⋯ ┐
│▌hidden-tab traffic                                                     │
│▌A phone with the board open keeps downloading…                         │
│▌───────────────────────────────────────────────────────────────────────│
│▌Finish mobile traffic acceptance  paused · 2h ago ›                  ⋯ │  head: title · state · age
│▌(● Accept) → (○ Review)                                        no PR  │  chain · PR
│▌───────────────────────────────────────────────────────────────────────│
│▌Stop repeated full-board downloads  needs a decision · 41m ago ›     ⋯ │
│▌((!) Implement) → (○ Review)                                   no PR  │
│▌Builder failed · 41m ago                                              │  the answer, in place
│▌P1 The delta chain is rebuilt on the request thread; …                │
│▌[ Skip Implement ]  [ Retry Implement ]                               │
│▌› Past attempts · 1                                                   │
│▌[Assigned ▾]  just now · 2 conversations                    + Agent   │
└────────────────────────────────────────────────────────────────────────┘
```

**Removes**

- The pipeline section's fill, border and radius, as in A.
- The "stages running" chip, since the live pill says it. Any other state stays
  a word in its tone on the head line ("paused", "needs a decision").
- The engine mark, the effort ladder and the model from the pill. The pill is
  the phone's: an outlined 22 px pill with no fill, holding the mark and the
  name.
- The activity line. Its parts move: "needs you" to the edge and the lane's
  state word, "N working" and "N conversations" to the footer, and "N stages
  waiting" is already the dashed pending pills.
- The conversation tiles' frames (rows, as in A).
- The #1798 arc band under a chain. The fail edge rides the failing pill as the
  suffix ("Verify ↺1/2"), which is what the desktop draws on a wrapped row and
  what the phone draws everywhere.

**Merges**

- The pipeline title and state chip become one head line: the title (omitted
  when it equals the task's title, as on the phone), the state word, the age,
  and "›". The whole head opens the Stages sheet, which replaces the separate
  "Stages" button.
- The pipeline's links move onto the chain line, at its right end (the phone's
  layout). The task row keeps only links not already drawn (as in A).
- The emphasis is the card's amber left edge plus the lane's own amber state
  word and pill. One status hue per card, as on the phone (§3.4). The desktop
  card draws no separate badge beside the title (see Risks). A task that needs
  you only through a conversation's question, with no lane to carry it, shows
  "needs you" in amber in the footer.
- The decision gets answered in place. A lane that needs a decision shows its
  stage report, first finding, and **Skip ‹stage›** / **Retry ‹stage›**, reusing
  the existing `kanban.pipelineAct.label.*` copy. A spent review budget shows
  the #1938 heads line with **Close the pipeline** / **One more round**. Both
  go through `usePipelineActions` (`usePipelineActions.ts:46`), as the phone
  block does.

**Moves behind hover**

- The graph toggle shows on hover or focus of the lane (⋯ stays), and the Stages
  sheet draws the graph too.
- The engine, model and effort move to the pill's tooltip, the Stages sheet and
  the graph nodes.

**Kept as is:** "N completed" fold, Past attempts, the stage report on a lane
that does not need you, Details, the footer's status pill and "+ Agent".

**At 390 px** (`variant-b/phone-*.png`): the phone card is round 2, unchanged,
because round 2's card line *is* this block at card density. On the task screen,
a task's blocks share one surface with hairlines between them, where round 2
draws one card per block, and the running chip is dropped as on the desktop.
The pills keep their round-2 outline.

**Risks**

- It adds action buttons to the desktop board. An accidental Retry starts an
  attempt. Skip and Close should keep the phone's deferred receipt with Undo
  (phone-kanban §3.13: four seconds, then send).
- A badge beside the title does not fit the desktop. The first render put the
  phone's "needs a decision" badge there. In a 256 px shelf it crushed the
  title to "Sh… / o…", and in Ukrainian at 454 px it cut the two-line title
  to "…всієї дошки й траф…". The badge repeated the lane's own amber state
  word, so B drops it. The final frames have no badge, and every task title
  reads in full. A lane's own title still ellipsizes beside a long state word
  ("Припинити повторні заванта… потребує рішення"), with the whole title in
  its tooltip. The phone card keeps its round-2 badge: it has the width, and the
  badge belongs to the card, not to the shared block.
- In a 256 px shelf the two answer buttons need the whole width. They share
  one line when they fit and wrap otherwise, without truncating their words.
- The #1798 arc is a recent addition, and B draws its information as the pill
  suffix instead. The count, the spent budget (colour) and "running because of
  it" (the live suffix) all survive. The drawn arc itself survives only in the
  graph. If the operator values the arc on the card, B can keep the arc band,
  but its lane layout has not been rendered with the arc on.
- The engine mark and effort ladder (#1743) leave the card entirely, into the
  tooltip, the sheet and the graph. The phone made the same call in round 2.
- `.kb .lane` is already taken (the conversation lane, `kanbanBoard.css:1116`,
  `flex: 1; overflow-y: hidden`). The prototype's first render reused the name,
  and every lane clipped to the same height. The block must get its own class.

## 5. Variant C: One lead lane (the phone card on the desktop)

The desktop card becomes the round-2 phone card: the title, **one** line for
the pipeline that matters most, a reason line when it needs you, and one
line counting the rest. The rest open in place as variant B's rows.

```
┌▌Kanban: say what each pipeline of a task does, and fold…         ⌄ ⋯ ┐
│ #2201 #2188 #2150 +4                                                   │  links not on the lead line
│ Seven pipelines on one card: four running, three finished.            │
│ (● Diagnose) → (◉ Cut)  80m ago                        #2204  ›  ⋯   │  lead lane at card density
│ › +3 running · 3 completed                                            │  opens every lane (B's rows)
│ [Assigned ▾]  5m ago · ● 4 working · 15 conversations       + Agent   │
└────────────────────────────────────────────────────────────────────────┘
```

**Removes** everything B removes. Collapsed, it also removes every pipeline
beyond the lead one, the Past attempts row and the per-pipeline head line.

**Merges**

- The lead lane is the lane that needs you if one does, else the newest
  unfinished one. Its chain folds the way the phone card folds (passed stages →
  "✓n", then the current stage, the next one and "+m"), measured so the
  current stage is never truncated. Its first link sits on the right with
  "+n", then "›" (Stages) and ⋯.
- "+3 running · +1 paused · 3 completed" is one line that counts every other
  lane.
- A lane that needs you shows the reason line in amber, "Implement failed · 1
  finding · 41m" or the #1938 heads line, plus the amber edge. As in B, the
  desktop card draws no badge beside the title; the reason line says what the
  phone's badge says.
- A fail branch that holds the work (parked or running) is where the lead
  chain stands: the blocked card reads "+2 → (!) Diagnose", not the failed
  Build before it.

**Moves behind expansion**

- Every other pipeline, and the answer buttons: "›" opens them in place as B's
  rows, with the answer panel. Built, the choice would be kept the way the
  graph toggle's is (per card and pipeline, while the board is open); the
  prototype keeps it only until a reload.
- Past attempts, and the graph toggle, which is on the expanded rows.

**At 390 px** (`variant-c/phone-*.png`): identical to round 2 by construction.
Nothing changes on the phone. The desktop adopts the phone's card instead.

**Risks**

- It hides running lanes. On a task with four live pipelines, three of them
  become a count, and seeing which stage each is on takes a click. The desktop
  has the room to show them, which is what B does.
- A decision takes two clicks (⋯, then Retry), the same as today, where B takes
  one.
- It is the most code: B's rows plus the card density, the measured fold and the
  per-card open state. The prototype's first fold clipped "Review ui" and "M"
  until it measured the real width. The board lays cards out lazily
  (`content-visibility: auto`), so the fold has to start over when a card gets
  its width.
- Past attempts sits behind the expansion.

## 6. Comparison

Measured on the rendered board at 1440 px, en, light (§9). "Frames" counts
elements with a border on at least three sides or a fill of their own. Pills
and link chips count. "Depth" is how deeply framed boxes nest, counting the
card as 1. At 1080 px the board is its scroller and Assigned keeps its 480 px
column, so the Assigned cards measure the same. (The Done shelf's card draws
folded at 1080 in every variant, so its row is 1440 only.) Heights in Ukrainian
stay within 36 px of these. The largest gaps are longer Ukrainian words
stacking B's answer buttons in a shelf, or wrapping C's heads line.

| Card (Assigned: 454 px wide; Blocked and Done shelves: 256 px) | Before | A | B | C | C opened |
| --- | --- | --- | --- | --- | --- |
| Mobile data: decision + paused | 430 px · 10 frames · depth 3 | 400 · 3 · 2 | 384 · 9 · 2 | 216 · 4 · 2 | 412 · 9 · 2 |
| Copilot: spent review budget | 342 px · 10 frames · depth 3 | 301 · 5 · 2 | 273 · 8 · 2 | 166 · 5 · 2 | |
| Seven pipelines | 689 px · 25 frames · depth 3 | 629 · 9 · 2 | 502 · 18 · 3 | 212 · 8 · 2 | 530 · 18 · 3 |
| Eight-stage upload | 370 px · 17 frames · depth 4 | 299 · 5 · 2 | 255 · 13 · 3 | 160 · 6 · 2 | |
| Search: fail edge fired | 380 px · 13 frames · depth 4 | 335 · 5 · 2 | 293 · 9 · 3 | 198 · 6 · 2 | |
| Release notes: decision, 3 chips | 270 px · 12 frames · depth 3 | 229 · 6 · 2 | 219 · 9 · 2 | 166 · 5 · 2 | |
| Export: 2 conversations, no pipeline | 224 px · 4 frames · depth 2 | 246 · 2 · 2 | 224 · 2 · 2 | 224 · 2 · 2 | |
| Blocked: decision on a fail branch | 362 px · 7 frames · depth 3 | 301 · 3 · 2 | 283 · 7 · 2 | 172 · 4 · 2 | |
| Done: verify still running | 312 px · 6 frames · depth 3 | 253 · 3 · 2 | 223 · 4 · 2 | 154 · 4 · 2 | |

B's frame count stays close to today's because it keeps the round-2 pill
outline, which is a hairline with no fill. Its depth-3 cases are a counter (↺ or
a round count) inside a pill. The nested box, the thing the operator called a
layer, is gone in all three variants: nothing sits inside a pipeline frame,
because there is none.

| | A: Hairlines | B: Lane rows | C: One lead lane |
| --- | --- | --- | --- |
| Pipeline frame | gone (hairline) | gone (hairline) | gone; one lead line |
| Pill | frameless: dot + engine mark + name | phone's outlined pill, no fill, mark + name | as B |
| State chip | a word; warning fill for decisions | a word on the head line; running implied | the reason line; running implied |
| Activity line | kept | merged into the edge, the lane's state word and the footer | as B, with the reason line |
| PR chips (#2059) | once per screen; per pipeline row | once; at the end of each chain line | lead link + "+n"; rest on the task row |
| Pipeline titles (#1765) | kept | kept, omitted when equal to the task's | on expansion |
| Who runs a stage (#1743) | engine mark kept; ladder and model on hover | on hover, Stages, graph | as B |
| Fail edges (#1798) | arcs kept | suffix "↺1/2" | suffix on the lead chain |
| Spent review budget (#1938) | heads line kept | heads line + Close / One more round | reason line; buttons on expansion |
| Decision actions | ⋯ menu (2 clicks) | in place (1 click) | ⋯ or expansion (2 clicks) |
| Liveness | pulsing dot, "N working" | pulsing dot, "N working" in the footer | lead lane's dot, counts |
| Stages / graph | on hover + ⋯ | head "›" / graph on hover | "›" / graph on expansion |
| Attempts | ↺, rounds, Past attempts, tile suffix | as A | ↺ on the lead chain; Past attempts on expansion |
| + Agent | footer | footer | footer |
| Phone 390 | changes round 2: frameless pills, one surface | round 2 card unchanged; task-screen blocks share one surface | round 2 unchanged |
| Height saved | 7–19 % (shelves 17–19 %) | 11–31 % (shelves 22–29 %) | 39–69 % collapsed (shelves 51–52 %) |
| Build cost | CSS and link dedupe | the PipelineBlock at task density, which slice 3 builds anyway | B + card density + fold + open state |

## 7. Recommendation: B

B is the variant the quote asks for. It removes every nested frame and the three
repeated facts (the state chip, the activity line, the second copy of each
chip). It keeps every pipeline visible at a glance, and it destroys none of the
additions in §2. It relocates only the pill's engine mark and effort ladder (to
the tooltip, the sheet and the graph) and the drawn arc (to the suffix). It is
also the variant closest to the rest of the plan. Its lane row *is* the phone's
approved round-2 block at task density, so the "one `PipelineBlock` with
card/task/screen densities" becomes one component with one look. A would
change the approved phone look, and C would add a desktop card density of its
own. Answering a decision on the card, in one click, is the one new
capability. The phone design already specified it, and
the desktop gains the same buttons from the same component.

A is the cheaper fallback if the operator wants the card's structure untouched:
it removes the frames and nothing else. C is right only if the board's first
job is a short scan. It trades seeing every lane for about half the height, and
the desktop has the width not to make that trade.

## 8. How the chosen variant becomes the one PipelineBlock

Whichever the operator picks, slice 3 of the phone kanban builds
`PipelineBlock` with three densities. What each density draws, per variant:

| Density | Where | A | B | C |
| --- | --- | --- | --- | --- |
| `card` | phone board card; C's desktop lead line | chain (frameless) · age · PR text | round 2 | round 2 |
| `task` | desktop card rows; phone task screen | title/state, links, chain, report; hairline apart | head line, chain + PR, answer; hairline apart | as B, on expansion |
| `screen` | phone pipeline screen (Stages view) | round 2 | round 2 | round 2 |

## 9. Evidence

**Where.** `/var/tmp/desktop-flat-cards/` holds `before/`, `variant-a/`,
`variant-b/`, `variant-c/` (and `variant-c/expanded/`). None of it is committed.
Each folder has:

- `board-<width>-<lang>-<scheme>.png`: the whole Viewer at 1440 × 900 or
  1080 × 900 with the orchestrator seat folded.
- `board-tall-*.png`: the same at 3400 px tall, every column in full.
- `column-assigned-*.png`: the Assigned column in full.
- `card-<task>-*.png`: one card each. `t-mobile` is a decision plus a paused
  lane. `t-review-spent` is the spent review budget. `t-many` has seven
  pipelines. `t-upload` has eight stages. `t-search` has a fired fail edge.
  `t-links` is a decision with three chips. `t-export` is conversations without
  a pipeline. `t-limits` (Blocked shelf) and `t-attach` (Done shelf) are the
  narrow 256 px case.
- `phone-board-390-<lang>.png`, `phone-board-light-390-*.png`,
  `phone-task-390-full-*.png`, `phone-task-many-390-full-*.png`: the 390 px
  reading.
- `metrics.json` (desktop card measurements) and `phone-geometry.json`.

Desktop frames exist for en and uk at 1440 (light and dark) and at 1080
(light).

**How the desktop was rendered.** The repo's browser evidence driver
(`issue1695BrowserHarness.ts`: the fixture bundled for the browser by
`buildEvidenceFixture.ts`, the production stylesheet compiled from
`globals.css`, a loopback server on port 0), `playwright-core` with
`CHROME_BIN=google-chrome-stable` and headless Chrome started with
`launchServer`, stopped by its recorded PID. It ran from an export of `HEAD` in
a scratch directory, with `LLV_STATE_DIR` and `XDG_CONFIG_HOME` pointed at
scratch directories. The fixture answers every request itself, so nothing
reached a server or a state directory. It is not `next dev`. It is the real
`Viewer` over `issue1695Evidence.fixture.tsx`, with one scratch scenario added
in the export: long titles, one to seven pipelines per task, a decision, a
spent review budget, several PR chips, and Ukrainian content when the page is
uk. "Before" is the unmodified component. Each variant is a patch to
`KanbanCard.tsx`, `PipelineSection.tsx` and one scratch module and stylesheet
in that export, switched by `?flat=a|b|c`. The patches exist to be looked at;
they are not the implementation. Memory was checked first (more than 9 GB
available).

**How the phone was rendered.** The phone kanban is not built, so its approved
baseline is the round-2 static mockup (`/var/tmp/phone-kanban/mockups-r2-src/`).
Each variant is a copy of that source with the variant's rules, rendered by the
round-2 script at 390 × 844, device scale 3, dark, plus a light board frame.
`before/phone-*` is round 2 re-rendered unchanged. The round-2 geometry gates
(44 px targets, overlap, clipping, horizontal overflow, a title drawn twice) ran
on all 40 phone frames and found nothing.

**What was checked by eye only.** The desktop frames have no automated overlap
gate. I looked at a sample of about thirty of them: the main cards of every
variant at 1440 en light, the Assigned column of C, and uk, dark, 1080 and
shelf frames for each variant. Four prototype defects came up and were fixed
before the final render: the `.lane` class collision in B (§4), C's unmeasured
fold clipping two chains, C's fold measuring cards before the lazy layout gave
them a width (§5), and C's lead chain skipping a parked fail-branch stage. Two
defects were in the designs themselves, and the designs changed: the title
badge beside the title in B and C (§4), and B's answer buttons wrapping their
words in a shelf. No render logged a page error. Frames I did not open may
still hold a defect I have not seen.

**Not rendered:** a stalled member, which the fixture's cards do not carry. In
A it keeps today's tile state word. In B and C it takes the phone's red edge and
"stalled" badge (§3.4 of the phone design).

## 10. Deferred — not currently justified

- **C's lead line as the collapsed state of B.** The card already folds (the ⌄
  in its header), and today the folded card shows only the title and links. Its
  one line could be C's lead lane. That is cheap once B exists, but nobody asked
  for it.
- **A density toggle on the board** (compact / comfortable). Nothing in the
  requirement asks the operator to choose per session.
- **Removing the footer's status pill.** It is the status control, and the quote
  protects what exists.
- **An automated desktop overlap gate.** It belongs in
  `kanbanBoard.browser.test.tsx` as a `describe` block when the chosen variant
  is built. It is not justified for a design note.
- **Retuning colours or the dark palette.** Every variant uses today's tokens.

## 11. Decision for the operator

Pick one:

- **A: Hairlines.** Same card and same order, one frame. The smallest change.
- **B: Lane rows (recommended).** Each pipeline is the phone's block,
  frameless, with the answer in place.
- **C: One lead lane.** The phone card on the desktop; the other lanes open on
  a click.

If B: should the card keep the #1798 arc under the chain (unverified in B's
layout), or take the phone's "↺1/2" suffix as rendered?

Look at these first, all under `/var/tmp/desktop-flat-cards/`. Compare each
desktop frame with the same file name in `before/`:

| Variant | Desktop | 390 px |
| --- | --- | --- |
| A | `variant-a/card-t-many-1440-en-light.png` | `variant-a/phone-board-390-en.png` |
| B | `variant-b/card-t-mobile-1440-en-light.png` | `variant-b/phone-task-many-390-full-en.png` |
| C | `variant-c/column-assigned-1440-en-light.png`, and opened: `variant-c/expanded/card-t-many-1440-en-light.png` | unchanged from round 2 (`variant-c/phone-board-390-en.png`) |
