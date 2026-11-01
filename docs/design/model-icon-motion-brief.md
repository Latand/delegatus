# Model-glyph motion: real work only, speed from the applied tier — prototype brief

## Originating requirement (paraphrase)

Operator request, 2026-10-29, in the operator's chat (Russian, voice). The
verbatim text stays in the task record. This is a paraphrase:

> The model icons on stages (Astra, Sol, the sun and the others) rotate. They
> should rotate when an agent is actually working, and the rotation must be
> smooth, without lag. Right now a task whose lane is only preparing its
> worktree shows a spinning sun, while a stage where work is really going on
> shows a sun that either does not spin or spins with lag. Second: the speed
> should reflect the model's speed setting. Fast spins twice as fast as
> ordinary, and ultrafast spins much faster than fast.

The pinned acceptance turns this into: motion only for real active agent work;
no model-work motion during worktree provisioning, before an agent exists,
while a passed turn settles or commits, while paused, done or blocked; speed
from the **applied** runtime tier, with fast exactly 2× ordinary; two timing
variants on the same layout; artwork, layout and the preparation indication
unchanged.

This brief is the first slice. It specifies a prototype over real product
components and changes no product code. The same task carries the chosen
implementation later.

Base: `origin/main` = `7c13643b0` (HEAD..origin/main = 0, fetched
2026-10-29). Every file:line below is at that revision.

## What exists today (observed)

### The glyph and its motion

- `src/components/kanban/StageGlyph.tsx:93-120` draws `<span class="mglyph
  g-<kind>" data-glyph-state data-live>` around one `<svg>`.
  `data-live="1"` is set when `live || GLYPH_STATE[state] === "running"`.
- `src/components/kanban/modelGlyph.ts:41-50` `GLYPH_STATE` maps the chip
  states **running, committing and reviewing** to `running`.
- `src/components/kanban/modelGlyph.css:52-68`: all motion sits under
  `prefers-reduced-motion: no-preference` and animates **SVG children**
  (`.mg-turn`, `.mg-breathe`, `.mg-corona`, `.mg-core`, …). Periods: Sol
  rays turn once per `3.5s × 4 = 14 s`, and Opus once per `3.6s × 4 = 14.4 s`.
  **Astra does not rotate.** Its corona breathes and its core flares
  (`modelGlyph.css:60-63`). `docs/design/model-glyphs.md:174-176` records why:
  "off its axes an eight-point star blurs into a cog at 14 px". The halo
  (`::before`) breathes on `--mg-period` and stays lit under reduced motion.
- The repository's own comments say that Chromium animates these SVG-child
  animations on the main thread (`kanbanBoard.css:422-428`,
  `globals.css:379-384`, which records a measured input-to-paint 24 ms vs 16 ms
  with the glyphs running vs held). This brief records that claim as the
  code's statement. It does not diagnose the reported lag from it.
- Glyph motion is **paused** at these existing sites:
  `:root[data-composer-focused] .mglyph[data-live="1"] *` (`globals.css:389-393`,
  i.e. while any composer has focus), `[data-card-drag]`
  (`kanbanBoard.css:430-436`), `[data-layout-animating="content"]` and
  `[data-column-text-held]` (`kanbanBoard.css:294-301`), and `.scheme-panning`
  (`globals.css:441-445`). The last three lists name the moving classes
  explicitly.

### Which state makes it move (checked by a probe)

`stageChipState` (`src/lib/pipelines/stageChip.ts:58-85`) returns `running`
for the cursor stage whenever `pipelineCursorActive` holds. That covers
`provisioning`, and also `paused` with a busy `pausedState`
(`stageChip.ts:17-20`). A scratch probe that imported the real function
(bun, isolated HOME/XDG/`LLV_STATE_DIR`) printed:

| Lane shape | chip | glyph today |
|---|---|---|
| `provisioning`, cursor pending, no attempt | running | moves |
| running, attempt `spawning` | running | moves |
| running, attempt `running` | running | moves |
| running, attempt `committing` with a pass verdict | committing | moves |
| `paused` (pausedState running), attempt running | running | moves |

None of these reads the stage conversation's turn. The task view already
holds a paused stage still (`PipelineBlock.tsx:929,966`, `shown = "pending"`).
The board graph (`PipelineSection.tsx:610`), the card pills
(`PipelineBlock.tsx:136`), the docked fix strip (`PipelineSection.tsx:500`),
the Stages sheet (`StagesSheet.tsx:264,386,464`), the stage pane
(`StagePlaceholderPane.tsx:284`) and the phone do not hold it.

These are real cases, from read-only `list_pipelines` reads on 2026-10-29:

- A Git-only verifier lane (Sol, `gpt-6.1-sol`) was created at 20:14:14Z. Its
  first attempt started at 20:21:12Z, so for about 7 minutes the lane was
  `provisioning` with its cursor on the stage. By the rule above the Sol glyph
  moved for the whole of that window. The card's own words at the same time
  were `kanban.progress.provisioning` («готується робоче дерево · жоден етап
  не почався»). That lane has since completed, so this is reproduced as a
  fixture.
- At the time of the read, open lanes included: attempts `committing` after a
  pass verdict; a review attempt `pending` while its lane waited in the CPU
  queue (cursor on it, chip running); and lanes `paused` "waiting for host
  termination" with their cursor attempt `running`. All of them draw a moving
  glyph today.
- The relayed architect example (pass ≈20:22, `completedAt` null, attempt
  `committing`, lane running, next stage not started, board word «працює») has
  the same shape as the committing row. It was not verified independently and
  is used only as a fixture.
- A genuine active turn: this brief's own stage (Opus) was `running` with an
  open turn while it was written. That is the moving case the prototype must
  keep.

### The client's existing "actually working" signal

`isWorkingAgent(file, now)` (`src/components/workingAgents.ts:29-38`) is true
only for a running turn whose process is not done or killed, and whose
activity is not idle (row `working` or `held`). The card's «N working» uses
it. `workingStageConversations` (`kanbanModel.ts:341-353`) already maps a
lane's attempts (`agentPath` or `conversationId`) to that set, and
`stageViews` already uses it for `rework` (`pipelineGraph.ts:156-174`).
**The prototype keys motion on this signal and invents no new one.**

### The applied tier

- `FileEntry.serviceTier` (`src/lib/types.ts:261`) is set by the scanner
  (`src/lib/scanner/observe.ts:99-103`, `effort.ts:115-142`) from the
  process argv `service_tier`, else from the newest `thread_settings_applied`
  event in the transcript tail (the applied value, see
  `docs/design/codex-service-tier.md`), else from the registry launch profile.
  `fast` is derived from it.
- The speed pill's face already reads this field
  (`src/components/runtimeProfile.ts:144`). The prior review contract (commit
  `d2ebe12e9`, 2026-10-27, "Name the applied speed…") shows the applied speed
  only after the server confirms it, and says pending and refused requests in
  place.
- Requested values that must **not** drive speed are
  `stage.effectiveRole.serviceTier`, `attempt.effectiveRole.serviceTier`,
  `runtimeSwitch.to.serviceTier` before `phase === "committed"`, the model
  name, and any role default.
- Claude glyphs have no service tier (`runtimeProfile.ts:241,260`), so they are
  always ordinary.
- Limitation, to be verified in the implementation slice and not in this one:
  the launch-profile fallback branch may record a requested value when the
  transcript tail holds no `thread_settings_applied`. `FileEntry` does not
  expose which branch answered (`entryServiceTierResult` exposes `source`, and
  only MCP reads it).

## The rule the prototype demonstrates

Per stage glyph:

**Active** is true only when all of these hold: the stage's chip is `running`
or `reviewing`; the lane is not paused; and the latest attempt's conversation
is in `workingStageConversations`. Also active: the existing `rework` case,
which already requires a working conversation.

| Case | Active | Drawn |
|---|---|---|
| provisioning (no attempt) | no | waiting reading (drained, still, no halo); the card's provisioning words unchanged |
| attempt `spawning` / pending in the CPU queue / provider wait | no | waiting reading |
| running chip, conversation not working (turn ended, idle, stalled host gone) | no | full colour, still, no halo |
| committing / settling after a reported verdict | no | full colour, still, no halo |
| paused lane | no | waiting reading (the task view's §3.13 rule, applied on every surface) |
| passed / failed / needs_decision | no | unchanged (badge or word) |
| running or reviewing, conversation working | **yes** | full colour, halo, motion at its tier |
| rework (settled, conversation working again) | **yes** | unchanged badge, motion at its tier |

**Speed** comes from the active stage conversation's `FileEntry.serviceTier`:

- `null`, `default` or `standard`, or any unknown id → ordinary;
- `priority` → fast;
- `ultrafast` → ultra.

The display never claims a tier it cannot read.

**Timing** (one revolution of the rotating figure):

| Variant | ordinary | fast | ultra | ratio |
|---|---|---|---|---|
| A | 4 s | 2 s | 1 s | 1:2:4 |
| B (recommended if legible) | 4 s | 2 s | 0.5 s | 1:2:8 |

- **Rotating figures:** Sol, Astra and Opus. The whole drawing of each is
  radially symmetric, so it turns as one. Astra's turn is required by the
  pinned acceptance, which overrides `model-glyphs.md:175-176`. The critic
  judges the cog-blur risk that the old design named.
- **Other glyphs** keep their own figure motion: Sonnet writes, Haiku sways,
  Fable tilts, Terra slides, Luna phases. That motion is divided by the same
  tier multiplier. Claude glyphs are always ordinary.
- The **halo and Astra's core flare stay at the ordinary period** at every
  tier, so ultra adds no pulsing faster than today's.

**Mechanism constraints:**

- CSS animations only, with one `transform: rotate` per glyph on a box element
  (the glyph's `<svg>`, never the `.mglyph` span, which also holds the badge).
- Speed comes from one custom property or attribute.
- No JS timer, `requestAnimationFrame` loop or per-icon React state.
- No `will-change` on all glyphs and no `*` selector added.
- A tier change may re-phase once. Routine board updates must not restart the
  animation.

Reduced motion: no figure moves at any tier, and the halo stays lit only on
active glyphs. The tier is then visible only where the product already prints
it (the speed pill). This is accepted, because the request adds no labels.

## Prototype deliverable

Location: `docs/design/model-icon-motion/prototype/`. Copy the pattern of
`docs/design/card-progress-estimate/prototype/` and
`docs/design/task-timeline/prototype-v2/`:

- `README.md`, `prototype.fixture.tsx`, `prototype.css` (unlayered, because
  `modelGlyph.css` is a plain `@import` in `globals.css:16`), and
  `.gitignore` (`*.png`, `*.webm`).
- Query string `?variant=0|A|B&device=desktop|phone&lang=uk|en&theme=light|dark`.
  `variant=0` is today's main, for the before samples.
- **Real components:** desktop `KanbanBoard` (graph, pills, an opened card
  with the stage list), and the phone's board and pipeline screen. The glyph
  is the unchanged `StageGlyph`.
- The fixture computes *active* and *tier* per stage with the rule above, from
  its own `Pipeline` and `FileEntry` data. It annotates each `.mglyph` with
  `data-proto-active` and `data-proto-tier` through the host attribute that
  locates the glyph's stage. `prototype.css` keys motion on them. A check
  fails the frame if any `.mglyph` lacks the annotation.
- **Cases on one board** (the `uk` names are the product's own words):
  - Active: Sol default, Sol priority, Astra ultrafast, Opus (Claude), Terra
    priority, and one rework stage.
  - Active, tier not applied: Astra with a runtime switch `requested` to
    ultrafast while the file says `default`, and Astra with a `failed` switch.
    Both must turn at ordinary speed.
  - Static: provisioning (Git-only lane, Sol, no attempt), spawning,
    CPU-queue pending, running with an idle conversation, committing after
    pass (the relayed example), paused, passed, needs_decision.
- **Realistic updates:** every 2 s the fixture bumps the active conversations'
  `mtime`/`size` and dispatches `llv:files-changed` and
  `llv:pipelines-changed`, like `issue1695Evidence.fixture.tsx:3253-3258`.

**Drivers.** Use only the existing ones, with no new driver file:

- Add one `describe` block to `src/components/kanban/kanbanBoard.browser.test.tsx`
  and one to `src/components/mobile/issue1671Evidence.browser.test.tsx`, each
  calling one new `captureModelIconMotionPrototype(browser, base, out, phone)`
  in `src/components/kanban/issue1695BrowserHarness.ts`.
- Serve with `serveEvidenceFixture(out, "docs/design/model-icon-motion/prototype/prototype.fixture.tsx")`.
- Open contexts with `openFixture`. For recordings, pass Playwright
  `recordVideo` on that context, as the drivers already do at
  `kanbanBoard.browser.test.tsx:25078` and
  `issue1671Evidence.browser.test.tsx:8755`.

**Frames:** 8 compact stills (variant A/B × 1440/390 × light/dark, `uk`, the
phone at 2× with touch). Frames go to the prototype stage's reported frame
directory, never committed. A 820 px desktop run executes the checks without
frames.

**Motion evidence:**

- Recordings: one ~6 s recording per variant × viewport (4 files).
- A video cannot show ultra B. Its 8-fold symmetry repeats every 62.5 ms, which
  is under two frames of Playwright's ~25 fps video, so the video aliases. For
  every active glyph, add a numeric trace: the rotation angle read from
  `getComputedStyle(svg).transform` on each frame for 1 s, with frame
  intervals. This rAF is for measurement only.
- The critic watches the recordings and runs the fixture headed for direct
  observation.

## Finite checks (each records its number; any failure fails the run)

1. **Truth.** Running transform animations on a glyph exist exactly for the
   active cases, in both variants and at both viewports. This is read from
   `getAnimations({subtree:true})` with `playState === "running"`.
2. **Ratio.** The rotation `getComputedTiming().duration` is 4000/2000/1000
   (A) or 4000/2000/500 (B). The two not-applied Astra cases read 4000. Claude
   reads 4000. The measured angular speed from the trace is within 5% of
   360°/duration.
3. **Phase.** Over five routine updates, each active glyph keeps the same
   `Animation` object and `startTime`, and its angle trace has no backward
   jump. Count render-phase resets: 0 expected.
4. **Static.** Static cases have no running animation and no halo
   (`::before` opacity 0). Provisioning and spawning read `data-glyph-state`
   waiting. The provisioning card still prints `kanban.progress.provisioning`.
5. **Reduced motion.** No running figure animation. The halo is lit only on
   active glyphs.
6. **Existing pauses.** Setting `data-composer-focused` on `:root`, then
   `data-card-drag`, then `data-layout-animating="content"` on a card, sets
   every glyph animation's `playState` to `paused`.
7. **Geometry.** The glyph box stays 14×14. Host row, pill and node rects are
   identical to `variant=0`. No glyph ink overlaps foreign text (measured from
   text ranges). Hit targets are unchanged.
8. **Themes and zoom.** Light and dark, and the board's zoomed-out and
   zoomed-in steps, give no overlap and keep motion.
9. **Errors.** Page errors equal `[]`.

## Performance claim (only if measured)

Make no smoothness claim from the CSS. To make one:

- Run 3 alternating pairs: `variant=0` → B → `variant=0` → B → …, on the
  identical desktop scene (same cases, same 9 active glyphs, the same 2 s
  update cadence), each a 10 s window in a fresh context.
- Record, from CDP `Performance.getMetrics` deltas: `RecalcStyleCount`/s,
  `LayoutCount`/s, `RecalcStyleDuration`, `LayoutDuration`, `TaskDuration`.
- Record long tasks (`PerformanceObserver` `longtask`), and frame intervals
  (p50/p95/max) from a `devtools.timeline` trace or the angle trace.
- Record the load beside the numbers (`/proc/loadavg`, gate-slot admission).
- A phone pair at 390 px with CDP CPU throttling ×4 is optional. Report it if
  it runs.
- Claim a gain only if all 3 pairs agree.

## How to run (one at a time, isolated)

From a scratch export with `bun install --frozen-lockfile`, private HOME,
XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR`, a short Chrome TMPDIR, the Viewer
control URL on a closed port, `CHROME_BIN` set, and `NODE_ENV` as the drivers
need it:

```
LLV_KANBAN_BROWSER_TEST=1 <gate-slot> bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "model icon motion prototype"
LLV_SWIPE_BROWSER_TEST=1  <gate-slot> bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "model icon motion prototype"
```

Never point these at the operator's running Delegatus. No other suites, and no
typecheck or build unless the stage brief names them.

## Keep-list (must not change)

- Every glyph drawing in `StageGlyph.tsx`, the tokens in `tokens.css`, the
  badge, the 14 px size, and the accessible name (`named`).
- The waiting treatment that `tokens.contrast.test.ts:162-169` pins.
- The progress words for provisioning and the disk-wait reason
  (`PipelineSection.tsx:153`, `pipelineBlockModel.ts:337`).
- The speed pill and selector, and their pending/refused texts.
- The existing `model glyphs in place of the stage dot` driver case
  (`kanbanBoard.browser.test.tsx:18506`, evidence `evidence/model-glyphs/`).
  It must still pass on the implementation slice.
- No backend, lifecycle, account or setting change. No product default.

## Overlapping open work (diffs read 2026-10-29; leave unchanged)

- #3493 (rail menu): server, files and projects only. No overlap.
- #3491 (settings): its own prototype directory plus
  `conversationWindow.browser.test.tsx`. No overlap.
- #3265 adds a `StageGlyph` caller (`model={null}`, `fallback="tone"`) in
  `StagesSheet.tsx`. #3265, #3399 and #3499 edit the two drivers, the harness
  and `kanbanBoard.css`. Append the new describe blocks and helper at the end
  of those files. Edit none of their lines. Any later `StageGlyph` prop must
  keep the `model={null}` path unchanged.

## Deferred — not currently justified

- Product implementation, which is the next slice on this task after the
  variant is chosen.
- Exposing `serviceTierSource` on `FileEntry` or verifying the launch-profile
  fallback. This belongs to the implementation slice.
- Any speed signal under reduced motion.
- New labels or badges.
- Settlement or recovery fixes for lanes stuck in `committing`. These are
  separate tasks already.
- A benchmark platform. A stutter diagnosis beyond the paired measurement
  above.
