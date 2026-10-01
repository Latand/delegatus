# The «Needs you» filter dims the rest of the kanban

## The requirement

The operator, 2026-10-01, in Ukrainian, answering the options in issue #2135:

> «по питанняю - ну давай 2 тоді, але непрацююче треба теж прибирати»

In English: "on the question — let's go with 2 then, but the non-working code
has to be removed too."

Option 2 of #2135, verbatim: *"Give the kanban its own needs-me filter: keep
cards that carry `data-attention` at full strength and dim the rest, counting
parked lanes too, since #2129 made them part of the same queue."*

The pinned task spec adds: the same behaviour on the phone board, en + uk,
light and dark, 390 px and 1440 px, no layout shift on toggle, and tests for
which cards dim and for the removed code.

This brief is for the builder. Line numbers are against `a47c7a5a4` (main at
the time of writing).

---

## 1. What is broken today

The toggle works but nothing reads it.

- `src/components/Viewer.tsx:992`: `attentionFilter` is React state.
- `src/components/Viewer.tsx:1203-1218`: it becomes `attentionPaths`, a `Set`
  of waiting conversation paths.
- `src/components/Viewer.tsx:1706`: it is handed to `ProjectDashboard`.
- `src/components/ProjectDashboard.tsx:168` declares the prop and `:410`
  destructures it. Nothing reads it after that.
- The only code that ever drew the dim is `src/components/scheme/nodes.tsx`
  (`dimClass`, `:795`), rendered only by `SchemeBoard`. No product entry point
  reaches either file (proof in §6).

On the phone the filter does not exist. `Viewer.tsx:993-996` forces it off
under `isMobile`, the funnel is desktop-only (`AttentionIsland`), and the F
key is ignored on the phone (`Viewer.tsx:1290`).

---

## 2. Where kanban cards render

| Surface | Component | Card element | Mounted from |
|---|---|---|---|
| Desktop, one project | `src/components/kanban/KanbanBoard.tsx` → `KanbanColumnView` (`:2859`) → `KanbanCard` (`src/components/kanban/KanbanCard.tsx`) | `<article class="card" data-kanban-card data-attention=…>` (`KanbanCard.tsx:508-517`) | `ProjectDashboard.tsx:2513` |
| Desktop, Overview (every project) | the same `KanbanBoard` | the same `article.card` | `OverviewKanban.tsx:183`, via `OverviewBoard` (`Viewer.tsx:1663`) |
| Desktop, remote rows with no task | `RemoteAgents` inside `.remote-unbound` (`KanbanBoard.tsx:3027`) | `div.remote-unbound` | Inbox column |
| Phone, one project | `src/components/mobile/MobileKanban.tsx` → `CardView` (`:398`) | `Pressable` `<div>` (`:220-223`) wrapping either `div[data-phone-card-frame]` or `button/div[data-phone-card]`, plus an optional remote-rows `<div>` sibling (`:523`) | `ProjectDashboard.tsx:2390` |
| Phone, Overview | the same `MobileKanban` | the same | `OverviewKanban.tsx:155` |

Every surface above renders inside the Viewer's `<main>`
(`Viewer.tsx:1625`), and none of them portals out of it. §4 depends on that.

**Not cards, never dimmed:**

- the orchestrator seat panel (`KanbanSeat`, `data-kanban-seat`) and the phone
  `MobileSeatCard`. They are the one place the operator writes, and a seat's
  own decision requests (bridge asks) show there, not on a task card;
- column heads and counts, the tab strip, the bar, the open-agents rail
  (`OpenAgentsRail`), the hidden tray, empty states;
- the phone conversation screen (`MobileFocusView`) and the catalog list
  (`ConversationList`, `DesktopConversations`). These are reading surfaces with
  no waiting signal per row. The spec's "phone board/list" is the phone
  board's one-column-at-a-time list, which is `MobileKanban`.

---

## 3. What "waits on the operator" means

Use the signal the card already draws. Do not compute a new one.

**Desktop:** `KanbanCard.tsx:419`: `data-attention="needs"` exactly when
`card.needsYou`. `card.needsYou` is `reasons.length > 0`
(`src/components/kanban/kanbanModel.ts:589-608`), where `reasons` collects:

- every member conversation's `conversationNeed` that nobody dismissed
  (`src/components/attention/needReason.ts:51`). It reads `attentionReason`
  (`src/components/attention.ts:247`), whose kinds are `decision` (an
  orchestrator's open bridge ask, `attention.ts:253-275`), `question`, `plan`,
  `permission`, `delivery`, `launch` and `ask`
  (`src/lib/attention/dismissalTypes.ts:19`);
- every lane parked on the operator that nobody dismissed: `laneNeed`
  (`needReason.ts:76`), with kinds `lane-decision`, `lane-review` and
  `lane-merge` (`dismissalTypes.ts:23`). These are the lanes #2129 added to the
  queue.

These are the same predicates `buildNeedsYouQueue`
(`src/components/attention/attentionQueue.ts:50`) uses for the island's count,
so a lit card and a queue row cannot disagree. An orchestrator's decision
request lights the seat, which is never dimmed anyway (§2).

**Phone:** `PhoneCard.reasons` (`src/components/mobile/phoneKanbanModel.ts:187`,
`liveReasons`) is the same list, minus lanes that are closing. Do **not** key
on the existing `data-needs` (`MobileKanban.tsx:484`). It follows `item.need`,
which can be null while reasons exist (a reason whose member the card does not
hold, `phoneKanbanModel.ts:199-202`), and it sits on the inner face, not on the
outer frame.

A card that only carries a *cleared* reason (someone dismissed it) does not
wait. It dims.

---

## 4. The mechanism: one attribute on `<main>`, one CSS block

No prop is threaded into a board. The Viewer owns the state, so the Viewer
writes one attribute:

```tsx
// Viewer.tsx:1625
<main ref={mainRef} data-needs-only={needsOnly ? "" : undefined} className=…>
```

A stylesheet then dims every card in that subtree that does not carry
`data-attention`. This also covers the Overview and the phone, adds no render
to the memoised boards (the boards do not re-render when the filter flips),
and changes no geometry, so nothing shifts.

### 4.1 Tokens (`src/styles/tokens.css`)

Add to the light `@theme static` block, and set the dark values in **both**
dark blocks: the `@media (prefers-color-scheme: dark)` block (`:221`) and the
`[data-theme="dark"]` block (`:307`).

| Token | Light | Dark | Why |
|---|---|---|---|
| `--needs-dim-opacity` | `0.6` | `0.55` | The lowest value that keeps `text-primary` at ≥ 4.5 : 1 on a dimmed card over the canvas: light 4.58 : 1 at 0.6, dark 5.04 : 1 at 0.55 (sRGB contrast over `--surface-canvas`). `text-muted` drops to about 2.4 : 1 in both themes, which is the intended recession. |
| `--needs-dim-saturate` | `0.35` | `0.35` | Drains the warning, colour-label and model hues so the lit cards are the only coloured ones. |

Transitions use the existing `--motion-base` and `--ease-standard`.

### 4.2 Rules (`src/app/globals.css`, one block named «needs you» filter)

```css
/* «Needs you» filter: cards that wait on the operator stay at full strength,
   the rest recede. Opacity and filter only, so geometry, hit areas and
   scrolling never move when it toggles. */
[data-needs-only] .kb .card:not([data-attention]):not(.dragging):not(.ghost):not(.landing):not(.has-reader):not(:hover):not(:focus-within),
[data-needs-only] .kb .remote-unbound:not(:hover):not(:focus-within),
[data-needs-only] [data-phone-card-shell]:not([data-attention]) {
  opacity: var(--needs-dim-opacity);
  filter: saturate(var(--needs-dim-saturate));
}
.kb .card, [data-phone-card-shell] { transition: opacity var(--motion-base) var(--ease-standard), filter var(--motion-base) var(--ease-standard); }
@media (prefers-reduced-motion: reduce) { .kb .card, [data-phone-card-shell] { transition: none; } }
```

Notes for the builder:

- `.kb .card` already has a `transition` (`kanbanBoard.css:280`). Extend that
  declaration with `filter` instead of adding a competing one in globals, and
  keep its border and box-shadow parts.
- The `:not(.dragging/.ghost/.landing)` exclusions matter. Without them this
  selector out-specifies `.kb .card.dragging { opacity: 0.35 }`
  (`kanbanBoard.css:286`) and `.kb .card.landing { opacity: 0 }` (`:548`), and
  breaks the drag and landing animations.
- `:hover`, `:focus-within` and `.has-reader` restore a card to full strength
  while the operator points at it, works inside it, or reads a conversation
  opened in it. That keeps "still readable and clickable" true. The phone has
  no hover, and a tap opens a screen, so the phone rule needs neither.

### 4.3 Phone markup (`MobileKanban.tsx`)

`CardView`'s outermost element is `Pressable`'s `<div>` (`:222`). Remote rows
are a sibling `<div>` (`:523`).

- `Pressable` takes a `waits: boolean` prop and renders
  `data-phone-card-shell="" data-attention={waits ? "needs" : undefined}` on its
  div. `CardView` passes `item.reasons.length > 0`.
- The remote-rows sibling `<div>` gets the same two attributes, so a card's
  remote rows dim with it.

Do not touch `data-needs` or `data-phone-card`. Existing tests read them.

---

## 5. Where the toggle state lives, and how each control reaches it

The state stays where it is: `const [attentionFilter, setAttentionFilter] =
useState(false)` at `Viewer.tsx:992`. It is React state, not stored. It
survives every re-render and poll, it is per tab (so per device), and a reload
starts it off. That reload behaviour is a deliberate rule of the old design:
a filter that survived a reload would silently grey the board (the comment at
`:986-991`). Keep it. Rename the state to `needsOnly` / `setNeedsOnly`.

Changes in `Viewer.tsx`:

1. **When the filter is offered.** Replace `attentionKey` / `attentionFilterable`
   (`:1200-1214`) with:

   ```ts
   const needsOnlyAvailable = shellEntries.length > 0;
   ```

   `shellEntries` (`:1243`) is the queue scoped to the board on screen: this
   project's entries, or the whole queue on the Overview. Move the
   `shellEntries` / `projectEntries` declarations above this line. This is
   option 2's "counting parked lanes too": a lane-only queue now offers the
   filter, which keeps that lane's card lit. Scoping it to the board on screen
   means the funnel never offers to dim a board where nothing would stay lit.
   Keep the effect that turns the filter off when it stops being available
   (`:1212-1214`), keyed on `needsOnlyAvailable`.
2. **Phone.** Delete the `isMobile` reset effect (`:993-996`) and rewrite the
   comment above it (`:986-991`), which says the phone renders without a
   dimming channel. That is no longer true.
3. **`<main>`** gets `data-needs-only={needsOnly && needsOnlyAvailable ? "" : undefined}`.
4. **Funnel (desktop).** `AttentionIsland` already renders `aria-pressed`, the
   pressed tone (`BAR_PRESSED`) and the labels (`AttentionIsland.tsx:57-70`).
   Pass `onToggleFilter={needsOnlyAvailable ? … : undefined}` as today. The
   width does not change between pressed and unpressed (`w-8` in both), so
   toggling cannot shift the layout. Update the doc comments at
   `AttentionIsland.tsx:16-17` and `:30-31` to say the funnel shows while
   anything on the board waits.
5. **F key (desktop).** The handler at `:1306-1309` keeps its shape and is
   gated on `needsOnlyAvailable`. It stays desktop-only (`if (isMobile) return`
   at `:1290`). Rewrite that comment: the reason is now that a phone has no
   hardware F, not a missing channel.
6. **Phone toggle.** The phone's entry to the queue is the ⚠ badge, which opens
   `MobileAttentionSheet` (`Viewer.tsx:1531-1567`). Add a funnel icon button to
   that sheet's header, beside «Dismiss all» in the `extra` slot
   (`src/components/attention/MobileAttentionSheet.tsx:163`). Rules:
   - new props `filterActive: boolean` and `onToggleFilter?: () => void`;
     render the button only when `onToggleFilter` is passed (same contract as
     the island), and pass it when `needsOnlyAvailable` is true;
   - a 44 × 44 px target (`min-h-11 w-11`), `lucide-react` `Filter` 18 px,
     `aria-pressed`, the island's pressed tone (`BAR_PRESSED` from
     `ProjectBar.tsx:77`: `border-accent/45 bg-accent/10 text-accent`), and
     `data-attention-filter` so the desktop and phone tests share a selector;
   - the sheet stays open after the tap, as the desktop panel does; the pressed
     state is what shows it took effect;
   - add `needsOnly` to the `mobileShell` memo deps (`:1569`).

### 5.1 Labels

| Key | en | uk |
|---|---|---|
| `attention.filterOn` (keep) | Show only those waiting on you (F) | Показати лише тих, хто чекає на тебе (F) |
| `attention.filterOff` (**change**: it says "nodes", from the scheme) | Show all cards (F) | Показати всі картки (F) |
| `attention.filterOnTouch` (new, phone, no key hint) | Show only those waiting on you | Показати лише тих, хто чекає на тебе |
| `attention.filterOffTouch` (new) | Show all cards | Показати всі картки |

Files: `src/lib/i18n/en.ts:2885-2886`, `src/lib/i18n/uk.ts:2830-2831`. Add the new
keys beside them in both files.

### 5.2 Things the spec names that already work

- **The count and the popover** (`AttentionIsland` count button and
  `AttentionPanel`) are untouched.
- **«Next ›»** no longer exists. Option B of
  `docs/design/needs-you-options.md` removed it, and the test
  `Viewer.needsYou.dom.test.tsx:336` pins its absence. The N key
  (`Viewer.tsx:1301-1305`) is what walks the queue, and it stays untouched. Do
  not add a Next control.

---

## 6. Dead code to remove

### 6.1 Proof of what is reachable

A reachability walk from every product entry point (`src/app/**` pages,
layouts and routes, `src/instrumentation.ts`, `src/runtime-host/main.ts`,
`src/lib/mcp/entry.ts`, `bin/*.mjs`, `src/lib/state/owner/*`), resolving `@/`
and relative imports with `Bun.Transpiler.scanImports`, reaches 1 518 modules.
It reaches **neither** `src/components/scheme/SchemeBoard.tsx` **nor**
`src/components/scheme/nodes.tsx`. It does reach `ProjectDashboard.tsx`,
`KanbanBoard.tsx` and `MobileFocusView.tsx`.

`git grep -n 'attentionPaths\|dimClass\|stackDimmed\|deckDimmed' -- ':!docs'`
lists every occurrence, all of which go below. No `docs/` file names
`attentionPaths`.

### 6.2 Remove: the `attentionPaths` channel and the scheme's needs-me dim

| File | What goes |
|---|---|
| `src/components/Viewer.tsx` | `attentionKey` memo and its comment (`:1200-1206`); `attentionPaths` memo (`:1215-1218`); the `attentionPaths={attentionPaths}` prop (`:1706`); the `isMobile` reset effect (`:993-996`, see §5 step 2) |
| `src/components/ProjectDashboard.tsx` | the prop and its doc comment (`:167-168`); the destructure (`:410`) |
| `src/components/scheme/SchemeBoard.tsx` | the prop (`:133`, with its doc comment); the destructure (`:243`); the pass-through (`:1534`) |
| `src/components/scheme/nodes.tsx` | `dimClass` and its comment (`:792-795`); the `dimmed` param, type and class use on `LiteNodeShell` (`:806, :811`), `LiteDraftShell` (`:872, :877`), `LiteDeckShell` (`:894, :902`), `MiniStackShell` (`:944, :949`), `NodeChrome` (`:1073, :1110-1111, :1186`, plus wherever `NodeShell` forwards it), `DraftShell` (`:1413, :1421, :1428`), `StageSlotShell` (`:1488, :1506, :1558, :1597, :1621`), `DeckShell` (`:1675, :1681, :1690`); `NodesLayer`'s `attentionPaths` (`:1715, :1758-1760`), `stackDimmed` / `deckDimmed` (`:1848-1854`), and every `dimmed=` at the call sites (`:1860-1924`). Drop "dim" from the memo comment at `:1063`. |
| `src/components/scheme/nodes.dom.test.tsx:211`, `nodes.stageRow.dom.test.tsx:159`, `nodes.strip.dom.test.tsx:124`, `src/components/EffortPills.slot.dom.test.tsx:171`, `src/components/TmuxComposer.liveRefreshFocus.dom.test.tsx:244` | the `attentionPaths={null}` prop |
| `src/components/scheme/nodes.anatomy.render.test.tsx:59, :97, :109` | the `dimmed={false}` prop |

**Keep** the scheme's *selection-session* dim: the `.scheme-session` rules in
`globals.css:360-385` and the `session` / `scheme-select-check-zone` code in
`nodes.tsx` (`:1024`, `:1160`). It is a different feature, and it is covered
by the deferred SchemeBoard removal below.

`tsc` proves nothing else consumed the removed props: they are props and
local helpers, and no export disappears.

### 6.3 Not removed here: `SchemeBoard` itself

The spec allows deleting SchemeBoard "only when nothing imports it". Three
things still import it:

- its 11 tests (`src/components/scheme/SchemeBoard.*.dom.test.tsx`);
- `scripts/fixtures/board-density.tsx:7`, driven by
  `scripts/capture-board-density.ts`, the #1651 density capture;
- `docs/design/task-board-integration/artifact/build-renderer.mjs:104`, by
  path.

The guard fails, so SchemeBoard stays. Its unreachable closure is also not
small. 41 source files reach no product entry point except through it:
`scheme/{SchemeBoard, nodes, TaskCard, TaskEdgesLayer, TasksLayer,
TaskBandsLayer, TaskStickyComposer, BulkActionBar, EdgeChips,
GroupOverridePanel, Minimap, SubagentBadges, SubagentTrayView}.tsx`, 17 scheme
`.ts` modules, `flows/{FlowDialog, FlowHub, FlowStrip, RoleTag}.tsx`,
`pipelines/{PipelineEditor, PipelineHub, PipelineStrip, StageCompletedCard,
StageStatusRow, VerdictPopover}.tsx` and `tasks/TaskWorkflowPanel.tsx`. On top
of those come about 50 test files, a capture driver, and two live-component
tests that render through `nodes.tsx`. That is its own change. See Deferred.

---

## 7. Tests

Run each touched file by path. Never sweep a directory (AGENTS.md).

1. **`src/components/Viewer.needsYou.dom.test.tsx`** (it already mounts both
   form factors with a waiting lane):
   - **Rewrite** `"desktop: with only a lane waiting the island offers no filter, and F arms none"` (`:383`).
     It becomes: with only a lane waiting, the funnel is offered; F presses it;
     `main` gains `data-needs-only`; the lane's card has `data-attention="needs"`
     and a non-waiting card on the same board has none; F again removes the
     attribute.
   - New: on another project's board (ATLAS while only LEDGER waits), no funnel
     is offered, and F sets nothing.
   - New: once the last waiting item is dismissed, the filter turns itself off
     and `data-needs-only` is gone.
   - New, phone: the ⚠ sheet shows `[data-attention-filter]`; a tap sets
     `aria-pressed="true"` and `main[data-needs-only]`; the lane's
     `[data-phone-card-shell]` carries `data-attention="needs"` and a quiet
     card's does not.
2. **`src/components/attention/AttentionIsland.dom.test.tsx`**: keep the
   existing tests and update the `filterOff` label assertion if one names
   "nodes".
3. **`src/components/attention/MobileAttentionSheet.dom.test.tsx`**: the button renders only with `onToggleFilter`, carries
   `aria-pressed`, shows the en and uk labels, and is a 44 px target.
4. **Which cards dim, in real CSS:** one `describe("needs-you filter")` in the
   existing driver `src/components/kanban/kanbanBoard.browser.test.tsx` over
   `issue1695Evidence.fixture.tsx`, which mounts the full `Viewer`. Add a
   fixture scenario holding a waiting conversation, a parked lane, a plain
   running card and a card with a cleared reason, plus a scenario where nothing
   waits. Assert with `getComputedStyle`: lit cards have opacity 1, the others
   have `--needs-dim-opacity`, and every card's `getBoundingClientRect()` is
   identical with the filter on and off (no layout shift). Hover restores
   opacity 1 at 1440.
5. **Removed code has no importers:** one small unit test,
   `src/components/attention/needsYouFilter.test.ts`. It reads every
   `src/**/*.{ts,tsx}` file with `Bun.Glob` and asserts that `attentionPaths`
   and `dimClass` appear nowhere. `tsc` already enforces the rest. Name the
   file after the feature, not an issue number.
6. Also run the touched neighbours by path: `KanbanCard`'s and
   `MobileKanban.dom.test.tsx`, `nodes*.test.tsx`, `EffortPills.slot.dom.test.tsx`,
   `TmuxComposer.liveRefreshFocus.dom.test.tsx`, and the i18n parity test.
   Then `tsc` and the build, under `flock /var/tmp/llv-heavy-gate.lock`.

---

## 8. States to render (rendered evidence)

Use the driver in `src/components/kanban/kanbanBoard.browser.test.tsx`
(`LLV_KANBAN_BROWSER_TEST=1`, `CHROME_BIN`). Do not write a new driver. Record
the readings as JSON under the driver's evidence directory, and screenshot
each frame:

| Axis | Values |
|---|---|
| filter | off, on |
| waiting cards | some (conversation + parked lane + cleared + quiet), none (no funnel offered) |
| viewport | 390 × 844 (phone: `MobileKanban`, ⚠ sheet with its funnel) and 1440 × 900 (desktop: `KanbanBoard` + island) |
| scheme | light, dark |
| locale | en, uk (`localStorage llv_lang`) |
| board | one project; Overview at 1440 (one frame is enough) |

For each frame, check that the island and the sheet header do not overflow;
the uk «Зняти всі N» plus the funnel must fit beside the sheet title at 390.
Check that dimmed titles stay legible, and that the funnel's pressed and
unpressed widths are equal. Look at the 390 px frames yourself.

---

## 9. Do not touch

- `src/lib/search/**` and the search UI (`src/components/search/**`,
  `GlobalSearch`): lane 94d3896d holds them.
- `AGENTS.md`, `CLAUDE.md`.
- The queue builders (`buildNeedsYouQueue`, `buildAttentionQueue`,
  `buildKanbanModel`, `buildPhoneKanban`), their predicates, and the N key.
- The count button, `AttentionPanel`, dismissal and undo.
- `data-needs` and `data-phone-card` on phone cards; `data-attention` on desktop
  cards (read it, do not change when it is set).
- The scheme selection-session dim (§6.2), and SchemeBoard itself (§6.3).
- Do not persist the filter (no `localStorage`).
- The phrase for free/libre source code: avoid it in any text (the #2391
  fence).

---

## 10. Deferred — not currently justified

- **Deleting SchemeBoard and its 41-file closure.** The spec's own condition
  fails: a capture driver and a docs artifact import it. The scale (≈ 41
  modules, ≈ 50 tests, two live-component tests that render through
  `nodes.tsx`) is unrelated to the filter. File it as its own issue. That
  change would also retire `scripts/capture-board-density.ts` and its fixture,
  a #1651 one-shot driver of the kind #1761 removed, and the
  `.scheme-session` CSS.
- **A filter cue on the phone bar** (a pressed ⚠ badge while the filter is on).
  The dimmed board is itself the cue, and the bar is already at its width limit
  at 390 px.
- **Member-level dimming inside a lit card** (dimming the tiles of a waiting
  card's non-waiting members). The card is the unit option 2 names.
- **Dimming the catalog list rows.** They carry no waiting signal.
- **Persisting the filter across reloads.** Rejected by the existing design
  (D6), and the spec does not ask for it.
