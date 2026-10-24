# The task's timeline says what was concluded and why extra stages ran: prototype

The operator asked on 2026-10-24 for the task card's timeline to show what each
step concluded and why an extra stage or lane started. They also asked for a
short brief for a person on what was done and how it works now. Today the
timeline lists only events («Review · 1: 3 зауваження», «Запущено лінію:
Оновити гілку PR»). The only outcome text is the one-line agent note, and each
writer replaces it. This prototype draws three numbered options. No product
code changes.

| Variant | What it adds | Where |
|---|---|---|
| 1 | An entry that needs it carries «Чому: …» and «Результат: …», each on its own line of a few words. The chevron at the entry's end opens it: the same lines then say the full sentence in their place | inside the timeline entries, which keep their own «Раніше · N» fold |
| 2 | A «Підсумок» brief at the top of the task: what was done, how it works now, key decisions with their reasons, what is left. It takes the agent note's place. The timeline stays as it is, and its entries link to the brief's numbered points («↑ п. 4») | under the title and state line; links in the entries' last column |
| 3 | The timeline grouped into milestones (Build, Review and Fix, Merge with its extra lane, Deploy). Each shows how it ended, and why it ran when it left the default path; its single events fold behind «N подій» | replaces the timeline's list |

Each frame prints its variant number and name in a band above the screen, in
the frame's language. `today-*` frames show the same task as the product draws
it now, for comparison. `variant-1-*-all` frames open variant 1's «Раніше»
fold and its extra-lane entry, so every line it adds is on screen.

## What each variant says, and what it leaves out

- Variant 1 puts «Чому» only on entries that left the default path: each Fix
  round (the findings it answered), the update from main, the extra lane and
  the deploy lane started after the merge. A first lane's first stage, a
  first review and a passed review have none. A result stands only where the
  entry's words and its neighbours do not already say it: no result on a lane
  start whose stage below states it, none on the deploy, which the agent note
  states. Folded, each line fits whole in two lines on the 820 px card.
- Variant 2 numbers one decision per reason, so every Review and Fix round
  that changed something links to the point that names why it ran: rounds 1
  to point 4, rounds 2 to point 6. Among neighbouring short rows only one
  entry links to a point (the extra lane's start, not the update or the
  Refresh beside it).
- Variant 3 gives the Build milestone no «Чому» (the first stage of a lane
  always runs for the same reason), keeps the row's own time out of results,
  and keeps the Deploy result to what the note does not say.

## The fixture

One finished task, «Експорт CSV падає на великих проєктах», with three lanes:

- the main lane: Build, Review round 1 with 3 findings, Fix, Review round 2
  with 1 finding, Fix, Review round 3 passed; PR #412 queued, updated from
  main, merged by Delegatus;
- an extra lane «Оновити гілку PR»: main moved on (#408 changed the same file),
  so a Refresh stage merged main and a Review checked the resolution;
- a deploy lane: Deploy 2.14.1, passed.

The task also has the agent note as it looks today («Розгорнуто 2.14.1; …»),
a description and agent-facing details. Project, PR numbers, files and times
are invented. The clock is frozen at 16:30 Kyiv time.

## What each variant reads

The timeline's entries, their order and their words are the product's own:
`taskChronology`, `pastAttempts` and `chronologyEntryText`, built from the
fixture's `Pipeline` records. What the variants add would come from:

| Text | Variant | Exists today | Would need |
|---|---|---|---|
| Why a stage ran | 1, 3 | the attempt's `activatedBy` (stage, attempt, edge) and the previous attempt's findings count; a lane's start, the PR's `merge.updates` and `merge.refresh` | the product composing the sentence from those records |
| Why an extra lane started | 1, 3 | the merge record that started it (`merge.refresh.pipelineId`, the main move or conflict) | the same |
| What a stage concluded | 1, 3 | `attempt.report.summary` (the `stage_report` summary), written for the next stage and the PR body: several sentences | a short outcome line in `stage_report` (a few words for the folded line, one sentence open), or the first sentence of the summary |
| The brief | 2 | `task.text` is meant to hold "a few sentences about the outcome" for a person, but nothing writes them at the end; `task.note` is one 280-character line that each writer replaces | a brief on the task, written when the task finishes (by the last stage or by the orchestrator), with numbered points that timeline entries can name |

## Files

- `prototype.fixture.tsx`: the whole prototype. Query string:
  `?variant=0|1|2|3&device=desktop|phone&lang=uk|en&theme=light|dark`, plus
  `&all=1` for variant 1's open frames. The window's size decides the width.
  `variant=0` is today.
- `prototype.css`: the product's `globals.css` plus this directory as a
  Tailwind source.
- `*.png`: the rendered frames, ignored by git.

## Drawn by the product, and what is new

- Desktop: `KanbanBoard` with the task's card opened through its own fold
  control, and its own `TaskChronology` and lane rows. Phone: `MobileTaskScreen`
  with its own timeline and its agents: the fixture places the task's nine
  stage conversations on the scene, as the Viewer keeps launched stages there,
  so the phone lists the same nine the card counts. In variant 2, and in
  variant 1's `-all` frames, the timeline's own «Раніше · N» is pressed.
- New, drawn with the timeline's own classes (`chronology-link`,
  `chronology-entry`, `chronology-head`) and existing tokens: variant 1's
  lines and chevron, variant 2's brief section and its links, variant 3's
  milestone list. On the phone the brief uses the phone timeline's card frame,
  and variant 1's lines on an entry that opens its conversation sit inside its
  44 px button, under its words. No new colour, font or card shape.

## Building and rendering

From a scratch export with dependencies installed (`bun install
--frozen-lockfile`):

```
bun src/components/kanban/buildEvidenceFixture.ts \
  docs/design/task-timeline-outcomes/prototype/prototype.fixture.tsx <out>
```

Compile `prototype.css` with `@tailwindcss/postcss` into `<out>/style.css`.
Add an `index.html` that links `style.css`, holds `<div id="root">` and loads
`prototype.fixture.js` as a module. Serve `<out>` over local HTTP; every
`/api/` read is answered inside the page, so no Viewer runs.

Each frame is a full-page headless Chromium screenshot at 1440 px (desktop) or
390 px (phone, 2× scale, touch). The time zone is Europe/Kyiv, motion is
reduced, and the colour scheme matches the theme. The viewport is grown to the
card's or the task screen's full height, so nothing scrolls inside a pane.
Names: `variant-<n>-<width>-<lang>.png`, plus `today-<width>-<lang>.png`.

At 820 px the board scrolls sideways to the card before the height is
measured: the card has `content-visibility: auto` and keeps a placeholder
height while it is off screen.

Before each capture, every text range in the added elements, the timeline and
the variant band was checked: none lies outside the viewport, is cut by a
clipping ancestor or ends in an ellipsis. The checks also measured that each of
variant 1's folded lines takes at most two lines, that its timeline is at most
1.5 times today's height at 1440 px, and that its lines start right under the
entry's words. Variant 2's links share their row's text baseline and leave the
row's height as it is without them, and no brief point is longer than four
lines at 1440 px. The chevrons and links have a 24 px target on the desktop and
44 px on the phone, grown by padding that does not change the row. The same
checks ran at 820 px, in the dark theme, and in English.
