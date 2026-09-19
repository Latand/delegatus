# Board header: one bar (#1801, item 1 + the 2026-09-19 comment)

**Originating requirement** (operator report, 2026-09-19, issue #1801 newest comment, as paraphrased there in English): "UI fix: this header needs to be put in order." Wanted, from the same comment: "one designed header. Every fact once, grouped by purpose, one search, consistent control heights, the waiting-for-you signal as the one loud element, and a layout that holds at 1280 px, at 2540 px and at 390 px. No feature is removed without saying where it went."

Prior work: `search_transcripts` ("board header toolbar top bar redesign", "kanban toolbar") found no earlier design of this header; one hit was an unrelated review of #1697.

## 1. Decisions

1. **One bar, 48 px tall**, replacing the 40 px project row (`ProjectDashboard.tsx`, the `h-10` div) plus the 53/82 px `.kb .bar` (`KanbanBoard.tsx`). Header height drops from 93 px (2540) and 122 px (1280) to 48 px at both.
2. **One control height: 32 px**, radius `--radius-control` (8 px), 12 px / 600 text, 15 px icons. Three variants only: *outlined* (card fill, default border), *pressed* (`aria-pressed="true"`: accent-soft fill, accent text, accent/45 border; used by the view switch segments, Orchestrator, Tasks), *quiet icon* (32 × 32, no border until hover; only inside the `⋯` menu trigger). No pills, no 26/27/28 px controls, no tinted one-offs. Dark theme uses the same tokens; nothing is colour-coded by hand.
3. **The one loud element is the attention island** (`AttentionIsland`, fenced, untouched). It stays the only warning-coloured thing in the bar. Its mount in `Viewer.tsx` moves from `fixed right-4 top-12` to `top-[10px]` so its 28 px pill centres in the 48 px bar; the bar keeps the existing 236 px right reserve for it.
4. **One search in the bar: the task field.** It filters this board's cards by card title, description, member conversation titles and pipeline task text (`searchText`, all columns; unchanged behaviour). The message search (`search.open`, shortcut `/`, unchanged) leaves the bar and becomes the first row of the `⋯` menu. On the conversations view, which has no task filter, the same slot shows the message-search field-shaped button instead, so either view shows exactly one search.
5. **View switch**: two 32 px segments inside one outlined 32 px group, the selected one in the *pressed* variant. Icon + label when the bar is ≥ 1600 px wide, icon only below (label stays as `aria-label` and tooltip).
6. **Every fact once** — see §3.
7. **Phone (390) is unchanged.** Under 640 px the desktop rows are not rendered; the phone already has one 52 px `MobileShell` bar: project title, `⚠ n` (hidden at zero), search, `⋯`. It already meets the requirement; this lane touches nothing there.

## 2. Groups, left to right

| # | Purpose | Holds | Notes |
|---|---|---|---|
| 1 | where am I | project name (truncates, max 220 px); account switches (`ProjectAccounts`) | accounts collapse into `⋯` below 1600 px |
| 2 | what is happening | `● N working` (green dot), or the existing red `catalog.unreachable` / `kanban.filesFailed` text | plain text |
| — | one elastic spacer | | the only empty stretch in the bar |
| 3 | find | task search field, 240 px, grows to 420 px max; min 160 px | |
| 4 | view | `Hidden N` (hidden at 0, as today) · board / conversations switch | |
| 5 | create | `+ Task`, `+ Agent` | one `+` button with a two-row menu below 1600 px |
| 6 | panels | `Orchestrator` toggle · `Tasks N` toggle | icon only (+ count) below 1600 px |
| 7 | more | `⋯` menu | §4 |
| 8 | what needs me | attention island, in the 236 px reserve | far right, where it already lives |

Gaps: 8 px inside a group, 16 px between groups. Bar padding 16 px left, 236 px right.

## 3. Duplicates and what each collapses into

| Today | Becomes |
|---|---|
| "N branches running · N trees" (row 1) and "N agents working" (row 2) | **`● N working`** from `model.totals.working` (the number the columns already show). The branches/trees line leaves the board view; on the conversations view, whose trees it describes, it stays as that view's group 2. |
| "N need you" text (row 2) and the island | **the island only.** The summary text and its amber dot are deleted. |
| "N tasks on the board", `Tasks N`, `Hidden N` | **`Tasks N`** (open tasks, the panel toggle) and **`Hidden N`** (what is off the board) stay, each on the control that acts on it. "N tasks on the board" is deleted: each column header already carries its count. |
| search icon (row 1) and `Find a task` (row 2) | decision 4 |

## 4. The `⋯` menu (one menu, `KanbanMenu` row pattern; en / uk)

Search your messages ( / ) — Пошук моїх повідомлень ( / ) · Mute sound / Sound levels (existing labels) · Undo / Redo — Скасувати / Повторити (disabled rows when empty, with the existing entry title) · Archive project or Restore from archive · Delete project (danger row, existing confirm) · below 1600 px also: one row per engine account switch, opening the existing account popover.

Nothing else moves. Trigger label: More actions — Більше дій (`mobile2.bar.more` wording reused under a desktop key).

## 5. Renamed labels

| Key | en | uk |
|---|---|---|
| `kanban.summaryWorking` | `{count} working` | `{count} працює` / `працюють` (plural forms kept) |
| `kanban.viewTab` | `Board` | `Дошка` |
| `dash.viewList` | `Conversations` | `Розмови` |
| new `dash.create` (narrow `+` button aria/tooltip) | `Create` | `Створити` |
| new `dash.more` | `More actions` | `Більше дій` |

Deleted keys once unused: `kanban.summaryNeeds`, `kanban.summaryTasks`. Unchanged: `Find a task` / `Знайти задачу`, `Hidden` / `Приховані`, `Task` / `Задача`, `Agent` / `Агент`, `Orchestrator` / `Оркестратор`, `Tasks` / `Задачі`.

## 6. Mock-ups

2540 px (bar 2292 px after the 248 px rail; wide tier):
```
| harbor  [Claude acct ▾] [Codex acct ▾]   ● 5 working  ······················  [🔍 Find a task            ] [Hidden 12] [▥ Board|☰ Conversations] [+ Task] [+ Agent] [🤖 Orchestrator] [☑ Tasks 5] [⋯]   ( NEEDS YOU 3 | Next › | ⏷ ) |
                                                                                                                          ^^^^^^^ pressed
```
1280 px (bar 1032 px, 780 px usable; narrow tier, one row):
```
| harbor   ● 5 working  ····  [🔍 Find a task      ] [Hidden 12] [▥|☰] [+] [🤖] [☑ 5] [⋯]      ( NEEDS YOU 3 | Next › | ⏷ ) |
```
Budget: name 120 + status 90 + search 160–200 + hidden 90 + switch 66 + create 32 + panels 32 + 56 + more 32 + gaps ≈ 740–780. If it still does not fit (long uk strings, `Hidden` in five digits) the search shrinks to 160 px, then the name truncates; nothing wraps, nothing hides.

390 px (phone, unchanged):
```
| harbor ⌄                         ⚠ 3   🔍   ⋯ |      52 px
```

## 7. Observed on main (one render, exported HEAD `eb94cddf`, production build, synthetic home, Chromium; en + uk light, en dark)

| Claim in the comment | Verdict | Measured |
|---|---|---|
| Two bars, empty middle | **Confirmed** | Row 1: 40 px, spacer 1721 of 2292 px (75 %) at 2540, 461 of 1032 at 1280. Row 2: 53 px with a 1225 px spacer at 2540; at 1280 it wraps to 82 px (board mode `scroll`), header total 122 px. |
| Same facts twice | **Corrected** | "branches running" counts live conversation files, "agents working" counts working/held rows: the fixture shows 19 against 5 side by side. Two measures that read as one fact, so one must go. The island counts the whole Viewer (`queue.length`), the summary text counts this project. `Hidden N` counts hidden task groups plus off-board and closed conversations, so it is no task count. |
| Two searches | **Corrected** | They search different things: the 28 × 28 icon opens message search, the 240 × 32 field filters cards. |
| Different weights and heights | **Confirmed** | Six heights in one header: 20 (name), 25 (switch), 26 (sound), 27 (Orchestrator, Tasks), 28 (search icon, island), 32 (field, `+` buttons). Radii: full pill, 8 px. Text 11.5 / 12 / 13 px at 400 / 600 / 700. |
| Switch has no selected state | **Confirmed, with cause** | Selected and unselected segments compute identically (transparent fill, `rgb(28,28,34)` text, 13 px / 400). `kanbanBoard.css:26-27` (`.kb button { background:none; border:0; padding:0 }`, `font/color: inherit`) overrides the Tailwind `bg-accent/10 text-accent px-2 py-1`, leaving 19 px tall segments with no padding: 153 × 25 px en, 130 × 25 uk. |
| No grouping | **Confirmed** | Uniform 8–12 px gaps, no separators; create buttons sit between the switch and the island. |
| "settings icon" in row 1 | **Misread** | It is `Sound levels`; Archive and Delete project also live in this row. |
| WAITING pill in row 2 | **Misread** | It is the Viewer-level island, `position: fixed` at y = 48 over row 2 (111 × 28 at zero; row 2 reserves 236 px for it). |
| *New, P1* | | At 1280 the `+ Task` (x 836–901) and `+ Agent` (x 909–984) buttons lie under the search field (x 425–1044): the `margin-right: -220px` on `.bar-tools` overlaps them and the render shows neither. One row removes the rule. |

Not rendered: account pills, undo/redo and the non-zero island (the synthetic home has no accounts, history or waiting items); their sizes above come from the classes (`h-7` history, island `py-1`), and the builder's evidence must show them.

## 8. Build notes

- `KanbanBoard` `.bar` becomes the bar: it already owns query, hidden tray, create. `ProjectDashboard` stops rendering its `h-10` row on the board leaf and passes two nodes, `barLead` (groups 1) and `barTrail` (groups 6–7); on the conversations leaf it renders the same two nodes in its own 48 px row with the branches/trees line and the message-search button. Exempt the slots from the `.kb button` reset the way `.seat *` is, or restyle the switch with `.kb` classes; either way the pressed state must survive the reset.
- Delete `.kb[data-mode="scroll"|"tabs"] .bar` wrap rules, `flex-wrap`, the `order` rules and the −220 px margin. The tier follows the bar's own width (`ResizeObserver` already present, threshold 1600 px). The tabbed face (board under 768 px, a narrow desktop window outside this lane's three widths) is the one place the groups may wrap: one row there cannot hold them beside the 252 px of padding and island reserve.
- `Viewer.tsx`: island `top-12` → `top-[10px]`. No edits under `src/components/attention/`, `src/lib/attention/`, `src/lib/mcp/`, the pipeline data layer, or the limits code.
- Evidence: a case in `scripts/capture-board-geometry.ts` asserting at 2540 and 1280, en and uk, light and dark: header height 48, every control 32 px high (island 28), no two rects intersect, pressed segment's fill differs from the other, `+` controls hit-testable (`elementFromPoint`). Phone: bar still 52 px.

## Deferred — not currently justified

- `/` focusing the task field, matching issue numbers, per-column match counts, sticky search (#1801 item 4): conflicts with the existing `/` message-search shortcut; needs its own decision.
- Orchestrator placement and collapse, column expand (items 2, 3): #1841.
- A project-scoped waiting count beside the global island: would be a second counter; the cards already mark who waits.

## Build correction: the tier threshold is 1600 px, not 1200

Measured while building: labelled, with two account switches, the groups need about 1 300 px plus the bar's 16 px left padding and 236 px island reserve. A bar between 1200 and ~1550 px in the labelled tier runs past its own box, so the wide tier starts at 1600 px of bar (a 1850 px viewport with the rail). 2540 is wide and 1280 narrow either way; the evidence adds a 1850 px case and checks the bar never overflows.
