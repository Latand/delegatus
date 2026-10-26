# Task summary and timeline, prototype v2

The operator asked on 2026-10-24 for a task's timeline to say what each step
concluded and why an extra stage or lane ran, plus a short brief for a person
on what was done and how it works now. The first round
(`docs/design/task-timeline-outcomes/prototype/`, #3331) drew three
structures; on 2026-10-26 the operator chose its variant 2 and rejected how
all three looked. This round keeps that structure and draws it three ways,
built from the product's own card, task screen, tokens and type.

## The structure (the operator's answers of 2026-10-26)

- A «Підсумок» block at the top of the task tells a returning person how the
  task works now. On the desktop it stands under the title and the state
  line, before the description; on the phone it is the first group under the
  title, above «3 завершені», «Опис» and the agents. It takes the agent
  note's place, which said the release a second time.
- Each stage writes its own one-line result in its report; the timeline
  shows it under the stage's entry. The last stage writes the task's summary.
- An entry that left the default path (a Fix after its Review, the extra lane
  after the update from main, the deploy lane after the merge) says why it
  ran by naming the entry it answers, as a link in the timeline's own words
  («Відповідь на Review · 1», «Після оновлення з main», «Після мерджу PR
  #412; розгортання схвалили ви»).

## The three treatments

| Variant | The summary block | The timeline's lines |
|---|---|---|
| 1 «Абзацом» | A section like «Хронологія»: its heading with the writer and time at the end («від Deploy · 15:07»), a paragraph in the card's primary ink (12 px on the desktop, 13 px on the phone), and one quiet line of facts under it («Працює з 2.14.1 · 15:05 · PR #412 · Лишилось …») | A stage's line on a second line of its entry, muted; the reason first, its link in the accent, then the result |
| 2 «Рядками» | The same heading over labelled rows: «Зроблено», «Працює тепер», «Версія», «Лишилось», the label in a muted column of its own, the value in primary ink | The line runs on in the entry's own words after « · », so the timeline stays one paragraph per entry |
| 3 «Панеллю» | A panel on the well surface (the one the card's details use), a one-line headline in bold, two shorter sentences and the facts line | An entry that answers another carries a 2 px rule beside its words, so the answer is seen before it is read; the reason stays in muted ink and the result in secondary |

Every treatment uses the card's label (11 px), ui (12 px) and body (13 px)
sizes, its primary, secondary, muted and accent inks and its card and well
surfaces; no new colour, font, pill or card shape. The phone block takes the
task screen's card frame (12 px radius, the card surface, shadow 1); variant
3's phone block sits on the well surface with the default border.

## The fixture

One finished task, «Експорт CSV падає на великих проєктах», with three lanes:

- the main lane: Build, Review round 1 with 3 findings, Fix, Review round 2
  with 1 finding, Fix, Review round 3 passed; PR #412 queued, updated from
  main, merged by Delegatus;
- an extra lane «Оновити гілку PR»: main moved on (#408 changed the same
  file), so a Refresh stage merged main and a Review checked the resolution;
- a deploy lane: Deploy 2.14.1, passed.

Project, PR numbers, files and times are invented. The clock is frozen at
16:30 Kyiv time; the frames run in Europe/Kyiv.

## What each line would read

The timeline's entries, their order and their words are the product's own:
`taskChronology`, `foldChronology` and `chronologyEntryText`, built from the
fixture's `Pipeline` records and drawn with the timeline's own classes. What
the prototype adds would come from:

| Text | Exists today | Would need |
|---|---|---|
| A stage's one-line result | `attempt.report.summary` (the `stage_report` summary), several sentences written for the next stage and the PR body | a one-line `result` in `stage_report`, written by every stage for the timeline |
| Why a Fix ran | the attempt's `activatedBy` (stage, attempt, edge) | the product composing «Відповідь на Review · N» from it and linking the entry |
| Why the extra lane started | the merge record that started it (`merge.updates`, `merge.refresh`) | the same, from the record |
| Why the deploy lane started | the lane's `createdAt` after `merge.mergedAt`, and who approved it | the same |
| The summary | `task.note` is one 280-character line each writer replaces; `task.text` holds the description | a summary on the task, written by the last stage when the task finishes: a headline, a few sentences and the facts (release, PR, what is left) |

## Files

- `prototype.fixture.tsx`: the whole prototype. Query string:
  `?variant=0|1|2|3&device=desktop|phone&lang=uk|en&theme=light|dark`, plus
  `&fold=1` to keep the timeline's own «Раніше · N» fold closed. The window's
  size decides the width. `variant=0` is today.
- `prototype.styles.ts`: the prototype's rules, from the product's tokens.
- `*.png`: the rendered frames, ignored by git.

## Rendering

The existing drivers render it; no new driver. Each has one `describe`
block, «task summary and timeline prototype v2», that bundles this fixture
with `serveEvidenceFixture` and calls `captureTaskTimelinePrototype` from
`src/components/kanban/issue1695BrowserHarness.ts`:

```
LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "task summary and timeline prototype v2"
LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "task summary and timeline prototype v2"
```

Isolated state (a private HOME, TMPDIR and `LLV_STATE_DIR`, the Viewer
control URL on a closed port, `CHROME_BIN` on a short TMPDIR) and
`TZ=Europe/Kyiv`. The desktop block renders every variant at 1440 and
820 px, the phone block at 390 px (2×, touch), each in uk and en, light and
dark, with the «Раніше» fold open; one `-folded` frame per variant at the
first width shows the fold as a returning person first sees it, and `today-*`
frames show the product as it is. Frames go to `.artifacts/task-timeline-v2/`
(ignored) and the readings to `evidence/task-timeline-v2/`.

Each frame is a full-page screenshot with the viewport grown until nothing
scrolls inside the card's column or the task screen. Before it grows, at the
named viewport, the block measures where the summary's first line ends: it
must end on the first screen. After it grows, every text range in the summary,
the timeline and the variant band is checked to be whole, on the page, never
cut by a scroller or ended in an ellipsis, and every reason's link to point at
an entry on the page.
