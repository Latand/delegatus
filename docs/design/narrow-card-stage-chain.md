# Narrow card: the pipeline stages as one vertical chain

## Originating requirement

Operator, 2026-09-30, in Russian, verbatim, with a screenshot:

> "Так, сделай вот тут, когда она так показывается, в таком маленьком... Чтобы
> вертикальные были, как знаешь, вер- вертикально, а не связаны между собой, а
> не стрелочка идёт сбоку."

In English: "Here, when it is shown like this, in a small card, make the stages
vertical, joined to each other, without the arrow at the side."

Screenshot: `~/Pictures/delegatus-review/stage-chain-vertical/operator-2026-09-30-narrow-card.png`.
It shows a task card in the narrow "Готові" (Done) column. The lane row of that
card has three rows:

1. The `Build` pill. The PR chip `#2348` and "завершено · змерджено ›" are on
   the right side of the same row.
2. `→` then `Review ↺1/3`. The arrow is the first thing on the row, at the
   left of the pill.
3. `гілка: Review fix` on a row of its own, with no mark that ties it to
   `Review`.

The stages look like separate items that wrapped. They do not look like a
chain. The arrow joins nothing, because the pill it points from is on the row
above.

## What renders the chips today

One component draws a pipeline everywhere: `PipelineBlock`
(`src/components/pipelines/PipelineBlock.tsx`), styled by
`src/components/pipelines/pipelineBlock.css`. It has three densities:

| Density | Where | Chain drawn by | Shape |
|---|---|---|---|
| `task` | Desktop kanban card, one lane row per pipeline (`src/components/kanban/KanbanCard.tsx:459`). Phone task screen, **finished** lanes only (`src/components/mobile/MobileTaskScreen.tsx:684`). | `ChainPills` (`PipelineBlock.tsx:137`) inside `.pb-chain` (`PipelineBlock.tsx:684`) | A row that wraps. The main path is joined by `.pb-arrow` "→", then the fail branches. **This is the screenshot.** |
| `card` | Phone board card (`MobileKanban.tsx:425`, `MobilePipelineCard.tsx:72`) | `CardLine` (`PipelineBlock.tsx:179`) | One measured line that never wraps, with the passed stages folded into a count. |
| `screen` | Phone pipeline screen, and live lanes on the phone task screen | `ScreenBlock` | Already a vertical numbered list (`.pb-stages`). |

The parts of the `task` chain:

- `StagePill` (`PipelineBlock.tsx:92`): `.pb-pill` with classes
  `tone-<STAGE_TONE> st-<state>` and the optional `waiting`, `side` (a branch),
  `rework` and `selected`. Inside it, in order:
  - `StageGlyph`: the model glyph, 14 × 14 px (`.mglyph`, `--glyph-size`), or
    the fallback `.pmark`, 12 × 12 px.
  - `.pb-name`: "гілка: {stage}" for a branch (`kanban.branch`).
  - `CountCircle`: the review-loop rounds.
  - `ReturnSuffix` (`.pret`, "↺ fired/max"): the fail edge on the failing
    pill, `PipelineSection.tsx:242`.
- `ChainPills` renders `.pb-pills` > `.pb-step`* in this order: the main chips
  (`!chip.branch`), each after the first preceded by
  `<span class="pb-arrow">→</span>`, then every branch chip.
  `summarizePipeline` (`kanbanModel.ts:349`) orders the chips the same way: the
  pass path, then the other non-branch stages, then the fail-only stages.
- CSS (`pipelineBlock.css`):
  - `:93` `.pb-pills`: flex, wrap, gap 4px.
  - `:94` `.pb-step`: inline-flex, gap 4px.
  - `:95` `.pb-arrow`: `--color-muted`.
  - `:63–84` `.pb-pill`: height 22px, padding 0 8px, 1px `--border-default`,
    gap 5px, `align-items: center`, name ellipsis.
  - `:125–136` `.pb-chain` row: pills, then `.pb-finish`, `.pb-links`
    (max 50%), `.pb-tail`.
  - `:197` under `pointer: coarse`, a task-density pill is 30px high.

Pill geometry, measured from the pill's outer left edge: 1px border + 8px
padding, so the glyph starts at x = 9. The glyph's centre is at x = 16 for the
14px model glyph and at x = 15 for the 12px mark. The glyph is centred
vertically in the pill (`align-items: center`) at every pill height (22, 30, or
more when the name wraps).

Lane widths, from `kanbanLayout.ts` and `kanbanBoard.css`. A card's
`.pblock` is its column's width minus 50px: 12 + 12 for the column body
padding, 12 + 12 for the card inset, and 2 for the border.

- Shelf column in the "narrow" mode (1200–1399px board): 220px, so the lane is
  about 170px.
- Balanced shelf in the "wide" mode at a 1440px viewport: about 264–330px, so
  the lane is about 214–280px.
- The wide share (Assigned, or a widened shelf): at least 440px (narrow mode)
  or 520px (wide mode), so the lane is at least about 390px.
- Phone at 390px, finished lane on the task screen: 390 − 24 (body `px-3`) −
  24 (lane `px-3`), so the lane is about 342px.

## The design

### 1. When the chain goes vertical

Add a size container on the task-density lane and switch the chain with one
container query:

```css
.pblock[data-density="task"] { container: pb-lane / inline-size; }
@container pb-lane (max-width: 379.98px) { /* the vertical chain, §3 */ }
```

The 380px breakpoint separates the two groups measured above:

- **Vertical:** every shelf card at every desktop mode (up to about 335px on a
  1920px screen) and the phone's 342px lane.
- **Horizontal, as today:** the wide share at every mode, from about 390px up.

A reading shelf (420–460px column, 370–410px lane) falls on whichever side its
width puts it. That is correct, because it is either narrow or wide.
`299.98px`-style bounds are the board's own idiom (`kanbanBoard.css:239`).

This is pure CSS, with no measuring and no React state. Inline-size
containment is safe here: both hosts stretch the block (a flex column item in
`.card`, a block child in `.phone-lane`). Nothing sizes it to its content.

### 2. What React adds (horizontal DOM stays as it is)

`ChainPills` keeps its DOM order and its `.pb-arrow` spans. It writes three
facts on each `.pb-step`, which only the vertical CSS reads:

- `data-step`:
  - `"first"` for the first main chip.
  - `"next"` for every later main chip. These are exactly the steps that carry
    an arrow today.
  - `"branch"` for a branch chip.
- `data-through="1"` on a branch step whose anchor (below) is followed by a
  later main chip. The main line has to pass down beside it.
- `style={{ "--pb-order": n }}`:
  - A main chip at main index `i` gets `2i`.
  - A branch gets `2a + 1`, where `a` is its anchor's main index.

  Ties keep DOM order.

**Anchor of a branch.** The first main chip, in `summary.chips` order, whose
`stage.onFail?.to` is the branch's id. This is the reviewer, and `summary.loops`
holds the same pair. If no main chip fails to it (for example, only another
branch does), the anchor is the last main chip. The branch then keeps its
place at the end, as today.

Put this as a small pure helper beside `cardChain` in
`src/components/pipelines/pipelineBlockModel.ts`, so it can be unit-tested
without a DOM.

### 3. The vertical chain (inside the container query)

Tokens, declared on `.pblock[data-density="task"]`:

```
--pb-chain-gap: 8px;          /* between consecutive rows, and the connector's length */
--pb-rail-x: 15px;            /* the connector's left edge; it covers x 15–16 */
--pb-branch-indent: 28px;     /* the branch pill's left edge */
--pb-rail: var(--border-strong);
```

Why x = 15: the 1px line covers x 15–16, so its centre is 15.5. That is 0.5px
from the centre of both glyph kinds (16 for the model glyph, 15 for the mark).
A 1px line cannot be closer to both at DPR 1.

Why `--border-strong` at 1px: it is one step above the pill outline
(`--border-default`). The connector reads as the thread that holds the pills
without competing with the state colours. The token already has light and dark
values (`#cbc3b7` / `#3c404c`), so the theme needs nothing else.

```
 x: 0    9  15|16 23       28
    ╭────[G]──────────╮                 G = glyph, centre x 15–16
    │ (✓) Build       │   #2348  завершено · змерджено ›
    ╰───────┬─────────╯
            │  8px, 1px solid --border-strong
    ╭───────┴─────────╮
    │ (✓) Review ↺1/3 │
    ╰───────┬─────────╯
            ┆  8px + half the branch pill, 1px dashed
            └┄┄┄┄╭──────────────────────╮
                 │ (✓) гілка: Review fix │   starts at x 28
                 ╰──────────────────────╯
```

The rules:

- **The row.** `.pb-chain { flex-wrap: wrap; row-gap: 4px; }`.
  - The pills column keeps `flex: 1 1 auto`. When its widest pill (plus the
    indent) does not fit beside `.pb-links` and `.pb-tail`, those items wrap to
    a line under the chain. `.pb-tail`'s `margin-left: auto` keeps it at the
    right edge.
  - The chain itself is never squeezed. `.pb-chain.has-finish` already wraps
    this way, so its rule does not change.
- **The column.** `.pb-chain > .pb-pills { flex-direction: column;
  align-items: flex-start; flex-wrap: nowrap; gap: var(--pb-chain-gap); }`.
- **No arrow.** `.pb-chain .pb-arrow { display: none; }`. The element stays in
  the DOM for the wide layout. It is already `aria-hidden`.
- **The steps.** `.pb-chain .pb-step { position: relative;
  order: var(--pb-order, 0); max-width: 100%; }`.
- **The connector.** `.pb-step[data-step="next"]::before`:
  - `content: ""; position: absolute; pointer-events: none;`
  - `left: var(--pb-rail-x); top: calc(-1 * var(--pb-chain-gap));`
  - `width: 1px; height: var(--pb-chain-gap); background: var(--pb-rail);`
  - It runs from the bottom border of the row above to this pill's top border.
    `"first"` draws nothing, so nothing is drawn before the first chip. No
    step draws below itself, so nothing is drawn after the last one.
- **The branch.** `.pb-step[data-step="branch"] { padding-left:
  var(--pb-branch-indent); }`. The elbow is `::after`:
  - `content: ""; position: absolute; pointer-events: none;`
  - `left: var(--pb-rail-x); top: calc(-1 * var(--pb-chain-gap));`
  - `width: calc(var(--pb-branch-indent) - var(--pb-rail-x));`
  - `height: calc(var(--pb-chain-gap) + 50%);`
  - `border-left: 1px dashed var(--pb-rail); border-bottom: 1px dashed
    var(--pb-rail);`, square corner.

  It leaves the reviewer's bottom border on the rail, drops to the branch
  pill's vertical middle, and turns right into its left border. `50%` is half
  the step, which is half the pill, so the arm lands on the glyph's centre line
  at 22px, 30px (coarse) and wrapped heights alike.

  It is dashed for two reasons: it matches the graph, where a fail edge is
  dashed (`kanbanBoard.css:1149`), and it keeps the main line solid. It stays
  neutral in colour: a fix that succeeded is not an alarm. The "гілка:" label,
  the indent and the dash together tell the branch apart from the next step.
- **The main line past a branch.** `.pb-step[data-step="branch"][data-through]::before`:
  the same line as the connector, with `height: calc(100% +
  var(--pb-chain-gap))`. It continues the solid rail past the branch row, and
  the next main step's own connector closes the gap under it. The dashed
  elbow's vertical part is painted over the solid rail, so only its arm shows.
- **Long names.** In the vertical chain a name wraps inside its pill and never
  ellipsizes. This is the same treatment `CardLine`'s last fold uses
  (`pipelineBlock.css:214–216`):
  - `.pb-pill { height: auto; min-height: 22px; padding-block: 2px; }`
  - Under `pointer: coarse`, `min-height: 30px`.
  - `.pb-name { white-space: normal; overflow-wrap: anywhere; }`

  The suffix and the round circle are `flex-shrink: 0` and stay at the end. The
  glyph stays centred, and so does the elbow.

### 4. Every state a chain can be in

| Case | Vertical chain |
|---|---|
| One stage | One pill (`data-step="first"`). No connector, no elbow. |
| Running / reviewing / committing stage | The pill as today: live glyph, `tone-active` or `tone-review` border. The connector takes no state colour. |
| Failed review with a fix branch | The reviewer pill keeps `↺ fired/max` (`.pret`, warning or danger). The fix pill is indented at 28px under it with the dashed elbow. If a stage follows the reviewer, the solid rail passes down beside the branch to it. |
| Round counters | `CountCircle` and `ReturnSuffix` are unchanged, inside the pill. |
| Skipped / pending stage | Ring mark, `tone-idle` name, dashed pill outline when the stage has no attempt. The connectors to it are the same 1px solid rail. The graph shows edge state; the card does not. |
| Needs decision / failed | Tone as today (`tone-needs`, `tone-bad`). The answer panel under the chain is unchanged. |
| Rework, selected | `rework` border and the `selected` 2px ring are unchanged. The ring may cover the connector's end pixel; that is acceptable. |
| Long stage names | The name wraps inside the pill (§3). No ellipsis in the vertical chain. |
| Phone at 390px | The finished lane on the task screen is 342px, so it is vertical. Pills are 30px high (coarse). The 44px hit areas of neighbouring pills overlap by 6px across the 8px gap. The wrapped row does the same today (4px gap), and the later pill wins. |
| Lane with its own head row (a pipeline on no task, or a titled lane) | Same chain under `.pb-head`. `.pb-chain` then holds pills and links only. |
| Graph open | Unaffected: `GraphSlot` replaces the chain. |

### 5. What must not change

- **The wide layout.** At a lane width of 380px or more, `.pb-chain`,
  `.pb-pills` and `.pb-step` render pixel for pixel as they do at the merge
  base: arrows, wrap, and branches at the end. The new attributes and the
  `--pb-order` custom property are read only inside the container query.
- **The pill.** Its size, padding, outline, tone classes, glyph and badge,
  `CountCircle`, `ReturnSuffix`, colours, tooltip, aria label and click target.
  The only exception is the name wrapping in the vertical chain.
- **The `card` density** (`CardLine`, `.pb-pills.fold`) and the **`screen`
  density**. Scope every new selector through `.pb-chain`, which exists only in
  the task density.
- **The data model.** `summarizePipeline`'s chip order and `chip.branch` are
  unchanged.
- **The fenced paths.** Nothing under `src/lib/links/**`,
  `src/lib/selfUpdate/**` or `src/lib/runtime/**`. The change is in
  `PipelineBlock.tsx`, `pipelineBlockModel.ts`, `pipelineBlock.css` and their
  tests and fixtures.

## Verification the build owes

- **Unit** (`src/components/pipelines/pipelineBlockModel.test.ts` or the
  existing `PipelineBlock.dom.test.tsx`). Use a chain build → review (`onFail`
  → fix) → critique. Assert:
  - `data-step` is first, next, next, branch.
  - The fix step has `data-through`.
  - `--pb-order` is 0, 2, 4, 3.
  - `.pb-arrow` is still rendered twice.
  - A second chain build → review → fix has no `data-through`.
- **Browser, desktop.** Add one `describe` to
  `src/components/kanban/kanbanBoard.browser.test.tsx` over
  `issue1695Evidence.fixture.tsx`. Extend the fixture with lanes for:
  - the operator's case (build → review ↺1/3 → branch);
  - a stage after the reviewer;
  - a running stage;
  - a skipped stage;
  - a long stage name.

  At 1440px, read from a shelf card (scroll it into view first:
  `content-visibility: auto` skips off-screen cards):
  - The main pills' left edges are equal, and the branch pill's is 28px to
    their right (±1).
  - `getComputedStyle(step, "::before")` on each `next` step gives a
    `height` of 8px and a `left` of 15px.
  - The first step has no `::before`, and no step draws after the last one.
  - `.pb-arrow` is `display: none`.
  - No two text ink rects intersect, and no name is clipped: measure the
    union of text rects clipped by overflow ancestors, not the boxes.

  From the wide share, the chain's geometry must match the merge base. Run the
  checks in light and in dark.
- **Browser, phone.** Add one case to
  `src/components/mobile/issue1671Evidence.browser.test.tsx`: the task screen
  of a finished lane at 390px, with the same assertions, light and dark.
- **Renders** into `~/Pictures/delegatus-review/stage-chain-vertical/`, with
  the "before" set from an export of the merge base:
  - `before-1440-narrow-{light,dark}.png`, `after-1440-narrow-{light,dark}.png`
  - `before-1440-wide-light.png`, `after-1440-wide-light.png`
  - `before-390-phone-{light,dark}.png`, `after-390-phone-{light,dark}.png`

  Name them in the PR.
- **Checks.**
  - The touched test files, run by path (never a directory sweep; see
    AGENTS.md).
  - `bunx tsc --noEmit`.
  - The browser drivers with their gate variables (`LLV_KANBAN_BROWSER_TEST=1`
    / `LLV_SWIPE_BROWSER_TEST=1` plus `CHROME_BIN`).
  - `bun run build` with an isolated `LLV_STATE_DIR`.

  Heavy gates run under `flock /var/tmp/llv-heavy-gate.lock`. Existing browser
  assertions that measured the old wrapped row inside a shelf card may need
  their expected geometry updated. Change only those, and say which ones in the
  PR.

## Options weighed

- **Trigger.** Three options:
  - A container query (chosen).
  - Measure in JS and go vertical only when the row would wrap. Rejected:
    cards in one column would mix two layouts, and every lane row would get a
    ResizeObserver for something CSS decides.
  - Always vertical. Rejected: the wide layout must keep its look.
- **Branch placement.** Three options:
  - CSS `order` under the reviewer (chosen).
  - Leave the branch at the end. Rejected: when a stage follows the reviewer,
    the elbow would hang off the wrong stage.
  - Reorder the DOM. Rejected: the wide layout's order would then need its own
    `order` workaround.

  Cost of the chosen option: in the vertical chain, keyboard focus reaches a
  branch after the later main stages, while the eye sees it under its reviewer.
  This happens only when a stage follows the reviewer, and the pills are
  secondary targets on a card that is itself a button.

No ADR: the change is reversible CSS plus three attributes.

## Validation against the requirement

- "Вертикально": in a narrow card and at 390px the pills stand one under
  another.
- "связаны между собой": consecutive stages are joined by a solid 1px line
  from pill to pill.
- "не стрелочка идёт сбоку": the arrow is not drawn in the vertical chain.
- The review-fix branch hangs off its reviewer on a dashed elbow, indented, so
  it does not read as the next step.
- Wide layouts are untouched.

## Deferred — not currently justified

- **The phone board card** (`card` density, `CardLine`). It is one measured
  line by design (`phone-kanban.md` §3.13). It never wraps, so the loose
  arrow the operator pointed at does not happen there. Making it vertical
  would multiply the height of every phone board card. The operator's
  screenshot is the desktop lane row.
- **State on the connector** (taken or not taken, live flow). The graph
  already carries edge state. On the card the pills' tones already say it.
- **Animating the switch** between the horizontal and vertical chain.
- **A DOM reorder** for keyboard order in the vertical chain (see "Options
  weighed").
- **Changing the `screen` density's** numbered stage list, which is already
  vertical.
