# Model-glyph motion, prototype

The operator asked on 2026-10-29 that a stage's model icon (Sol, Astra and the
others) turn smoothly while its agent really works, hold still while a lane
only prepares its worktree, and turn faster on a faster service tier: fast
twice ordinary, ultrafast much faster still. The brief is
`docs/design/model-icon-motion-brief.md`. This prototype draws its rule over
the product's own board and phone components and changes no product code.

## The variants

| Variant | ordinary | fast | ultra | ratio |
|---|---|---|---|---|
| 0 | today's main: every live chip moves, Sol turns once in 14 s, Astra breathes | | | |
| A | 4 s | 2 s | 1 s | 1:2:4 |
| B | 4 s | 2 s | 0.5 s | 1:2:8 |

A and B draw the same layout. Sol, Astra and Opus turn as one transform on
the glyph's own `<svg>`; their children stop turning and breathing. Sonnet,
Haiku, Fable, Terra and Luna keep their own figure motion, divided by the
tier. Every halo and Astra's core flare keep the ordinary period. A band at
the top of each frame names the variant; the product draws no such band.

## The rule

A glyph moves only when all of these hold: the stage chip reads running or
reviewing, the lane is not paused, and the attempt's conversation is one the
board already counts as working (`isWorkingAgent` through
`workingStageConversations`). A settled stage whose conversation works again
(rework) also moves. Everything else holds still without a halo. A stage
before its agent exists (preparing the worktree, starting, waiting in the CPU
queue) and a paused lane take the product's existing waiting reading.

Speed comes only from a tier the runtime confirmed. `FileEntry.serviceTier`
is filled by `entryServiceTierResult` (`src/lib/scanner/effort.ts`) from three
places in order: the process's `-c service_tier=` argument, the newest
`thread_settings_applied` event in the transcript tail, and otherwise the
registry's launch profile. The first two report what the runtime applied
(`native`). The third holds what the launch asked for, so a tier the runtime
never confirmed can reach the field (`profile`). `FileEntry` does not say
which answered; only the MCP binding reads `source` today. The fixture
carries that source beside each conversation, and the rule maps:

- `native` `priority` → fast, `native` `ultrafast` → ultra;
- anything else (no tier, `default`, an unknown id, a `profile` value) →
  ordinary.

A requested runtime switch, a refused one, the stage's requested role tier,
the model's name and any role default never set the speed. The implementation
slice has to carry the source onto `FileEntry` (or an equivalent confirmed
signal) for this mapping to hold in the product.

## The cases on one board

| Card | Stage | Expected |
|---|---|---|
| Промокоди в кошику | Sol review, `native` default | turns, ordinary |
| Слоти доставки на завтра | Sol build, `native` priority | turns, fast |
| Підказки пошуку під час набору | Astra build, `native` ultrafast | turns, ultra |
| Перенести збережені кошики… | Terra, `native` priority | slides, fast |
| Посібник з експорту для API | Sonnet docs reworking, Opus critique | both move, ordinary; Verify waits |
| Подарункові картки в кабінеті | Astra, ultrafast switch requested, file says default | turns, ordinary |
| Фільтри історії замовлень | Astra, ultrafast switch refused | turns, ordinary |
| Сповіщення про наявність на пошту | Astra, ultrafast only in the launch profile | turns, ordinary |
| Пайплайни працюють через Git | Sol verify, lane preparing its worktree for 7 min, no agent | still, waiting |
| Етикетки повернення… | Astra, attempt spawning | still, waiting |
| Округлення цін у рахунках | Sol review waiting for a CPU slot | still, waiting |
| Посилання на відстеження кур’єра | Sol, turn ended 11 min ago | still, full colour |
| Поділитися списком бажань | Opus design passed, committing | still, full colour |
| Бонусні бали в чеках | Astra, lane paused while its agent answers | still, waiting |
| Темна тема в налаштуваннях | passed, passed, needs decision | unchanged badges |

Every 2 s the working transcripts grow and the lanes are touched, and the
fixture dispatches `llv:files-changed` and `llv:pipelines-changed`, as the
board sees a working lane.

## Running it

Query string: `?variant=0|A|B&device=desktop|phone&lang=uk|en&theme=light|dark`,
plus `updates=0` to stop the 2 s refresh.

The two existing drivers each hold one `describe("model icon motion
prototype")` block that calls `captureModelIconMotionPrototype` in
`src/components/kanban/issue1695BrowserHarness.ts`. Run them from a scratch
export, one at a time, through the gate wrapper, with a private HOME,
XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR`, the Viewer control URL on a
closed port, `NODE_ENV=test`, `CHROME_BIN` on a Chrome with a short TMPDIR,
and `LLV_MODEL_MOTION_OUT` naming the output directory:

```
LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "model icon motion prototype"
LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "model icon motion prototype"
```

Each run writes `frames/`, `motion/` (about 6 s recordings of 0, A and B),
`strips/` (each moving glyph held at eight points of its turn, at 4×) and
`readings.json` with the source digests, every file it wrote, every reading
and the failures. Any failure fails the test. Nothing it writes is committed.

## What the run checks

1. Running figure animations exist exactly on the working stages, in A and B,
   at 1440, 820 and 390 px, light and dark.
2. The turn lasts 4000, 2000 and 1000 (A) or 500 (B) ms by its computed
   timing; the requested, refused and launch-profile Astra cases and Claude
   read 4000; the angle traced each frame for 1 s turns within 5% of
   360°/duration, never backwards.
3. Five routine refreshes keep every glyph node, `Animation` object and its
   running state; the angle never steps back afterwards.
4. Every still case has no running animation and no halo; the four waiting
   cases are drained; the preparing card prints exactly what today's prints.
5. Under reduced motion nothing moves and only working glyphs keep the halo.
6. The product's existing holds (focused composer, card drag, layout
   animation) pause every glyph animation, the turning box included.
7. Each glyph stays 14×14; every glyph and host rect equals today's; no text
   range overlaps a glyph.
8. At 80% and 150% zoom motion stays and nothing overlaps.
9. No page errors.

On the desktop it also takes three alternating 10 s samples of variant 0 and
B on the same scene, with Chrome's style and layout counts and durations,
task time, long tasks, frame intervals and the load average. A gain may be
claimed only if all three pairs agree.
