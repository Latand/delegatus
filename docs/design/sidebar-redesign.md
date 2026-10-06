# The left sidebar: three numbered variants inside today's interface

**Originating requirement** (operator's verdict on two redesign attempts, 2026-10-06, as paraphrased in the lane's specification): the orchestrator conversation looks good and stays; the pipelines interface is well thought out and stays; "the left sidebar does not look good and has odd moments". The redesign is targeted: Delegatus keeps its structure and its visual language, and only the named surfaces are redrawn, each in its own lane, to the quality of the best parts of today's interface. No liquid glass.

This note covers the desktop sidebar. It is a design: nothing here ships. The three variants are working prototypes drawn on the real product components, and the product keeps drawing today's rail unless the kanban evidence fixture asks for a variant.

Prior work: `search_transcripts` ("left sidebar redesign variants footer memory swap accounts") found the two closed concept lanes and the usage audit, and no earlier decision about the rail itself. The inventory in `docs/design/interface-redesign-usage-audit.md` (on the audit lane's branch) was the starting point; every row below was checked against the source at this commit.

## 1. What the sidebar does today

The desktop rail is `ProjectRail`, mounted once at `src/components/Viewer.tsx:1652`. The phone draws its project picker with `src/components/mobile/MobileProjectSheet.tsx:52`, a different component, so the phone is outside this lane and unchanged; the `isMobile` branches left inside `ProjectRail` are untouched too.

| # | Function | Source today |
|---|---|---|
| F1 | Brand mark and product name | `src/components/ProjectRail.tsx:226` |
| F2 | Hide the rail (button; the shell button and key B bring it back; remembered) | `src/components/ProjectRail.tsx:231`, `:544` |
| F3 | Header menu: language, phone access QR, push notifications, setup guide, interface walk, agent mapping, dictation, telemetry, linked installation, external relay, update, activity, team, sign out | `src/components/ProjectRail.tsx:392`–`:529` |
| F4 | Filter projects by text | `src/components/ProjectRail.tsx:252` |
| F5 | Add a folder as a project (name, root, browse, create a missing root, errors) | `src/components/ProjectRail.tsx:263`, form at `:639` |
| F6 | Overview | `src/components/ProjectRail.tsx:297` |
| F7 | Project list: select a project | `src/components/ProjectRail.tsx:140`, row at `:844` |
| F8 | Row counters: working, waiting on the operator, conversations, age | `src/components/ProjectRail.tsx:896`–`:900` |
| F9 | Pin a project with the crown; pinned projects sort first | `src/components/ProjectRail.tsx:156`, marker at `:893` |
| F10 | Archive: fold, count, open an archived project | `src/components/ProjectRail.tsx:320` |
| F11 | Empty, loading and unreachable-catalog states of the list | `src/components/ProjectRail.tsx:349` |
| F12 | Fold the system footer (remembered; folded blocks stop polling) | `src/components/ProjectRail.tsx:560`, `:585` |
| F13 | Memory and swap readings; the sessions cleanup panel | `src/components/ResourcesFooter.tsx:120`, panel at `:362` |
| F14 | Claude and Codex: active account, plan, every limit window with its reset, the accounts panel, the burndown chart | `src/components/LimitsFooter.tsx:138`, panels at `:391`–`:392` |
| F15 | Copilot account and allowance | `src/components/CopilotFooterRow.tsx:195` |
| F16 | Telegram status and its panel | `src/components/TelegramConnect.tsx:414` |
| F17 | Stale and failed readings (dimmed block, amber dot, reason) | `src/components/LimitsFooter.tsx:262`, `src/components/ResourcesFooter.tsx:250` |

## 2. What is weak today

The numbers match the marks on `critique-today-light-en.png` and `critique-today-light-uk.png`. Measurements are from the 1440x900 frame with the footer open.

1. **Four framed boxes before the first project.** Two squares in the header, then a field and a button. The eye meets chrome first and content second.
2. **Overview is drawn as one more project.** It has a grey dot that carries no meaning and no sign that it is a different kind of destination.
3. **Sections are split by bare lines.** Nothing says the first group is pinned; a new operator has to infer it from the crown.
4. **The crown sits before the name.** Pinned names start 16 px to the right of the others, so the list has two left edges.
5. **Three bare numbers on a row.** Working, waiting and conversations stand side by side; working and conversations are the same grey and the same size, and only the middle one has a shape. A row reading "11 · 3 · 26" needs the operator to remember the order.
6. **The age takes a second line.** Every row is 55 px tall for one small fact, so six projects fill the list.
7. **A long name is cut while the line under it is empty.** "Northwind customer da…" loses half its name beside a free second line.
8. **The footer is taller than the list.** 480 px of system blocks under 336 px of projects: four of six rows are visible, and four of sixteen with a long list. The sidebar's main job gets the smaller share.
9. **The memory bar fills as memory is used.**
10. **The quota bar beside it drains as quota is used.** One shape, opposite meanings, 80 px apart.
11. **A "12%" chip with no word** next to rows that say "left 88%". It is the tightest window, and nothing says so.
12. **A reset line under every bar.** Six lines of 10 px text stay on screen for a fact that matters a few times a week.

Smaller things seen in the same frames: three label styles in one footer (a bold black title, an engine name in the engine's colour, a small grey plan word), the account switch drawn as a pill that looks like a status badge, and Telegram as the only footer row with an icon.

## 3. The three variants

Each variant receives exactly the props today's rail receives and is assembled from the rail's own parts: `RailHeaderMenu`, `CreateProjectForm`, the crown request, `ResourcesFooter` and `LimitsFooter` with their panels, and the summaries `buildProjectSummaries` computes. Colours, type, radii and borders are the product's tokens. Two marks are shared by all three: **waiting on the operator** is the person glyph the board's Waiting cards carry, with a number, on the warning tint; **working** is the green dot of the board header's "N working", with a number.

Every footer bar in the variants shows the share already spent, so a fuller bar is worse in every block.

### 1. Tidied sidebar, compact system block

Same width (248 px), same order, same places. Rows are one line: name, the two marks, a short age (`31s`, `11m`, `3h`, `6d`) in a fixed right column. The selected row is the only one that grows: its name wraps to two lines and the conversation count sits under it. Sections carry labels ("Pinned" with the crown, "Projects 4", "Archive 2"), so the crown leaves the name's left edge. Overview gets a grid icon and the totals of both marks. The filter gets a search glyph and the header keeps its two squares.

The system block is one line per reading on a shared grid: name, value, bar. An engine line shows the engine mark, the active account, and the tightest window ("left 12%"); the account opens the accounts panel, the reading opens the burndown chart. One control in the block's header swaps the lines for today's full blocks with every window and reset, and remembers the choice.

Measured at 1440x900: footer 169 px (480 today), list 649 px (336 today), 16 of 16 rows visible with a long list (4 of 16 today).

### 2. Narrow rail that opens

At rest the sidebar is a 56 px rail: the mark, three buttons (open, find, add a folder), Overview, one tile per project with a two-letter monogram, an archive tile, a gauge per system block, and the header menu at the bottom. A tile carries a number badge for waiting and a green dot for working; the selected tile has a bar on the rail's edge. Resting the pointer on the rail, or pressing any of its open controls, lays the full sidebar of variant 1 over the board without moving the board; Escape, a click outside or leaving closes it. A dock control in the opened header keeps it open in the layout, and that choice is remembered.

Measured at 1440x900: the board gains 192 px (1384 px wide, 1192 today); 11 of 16 tiles visible with a long list.

### 3. Projects that say who waits and who runs

The full sidebar at 264 px. A quiet project is one line, as in variant 1. A project with something happening grows by one line per fact: an amber line with the mark and the **title of the oldest conversation waiting on the operator**, and a green line with "N working" and the marks of the engines running there. The operator reads the question in the sidebar and decides whether to go.

The system block is the one from variant 1.

Measured at 1440x900: the board loses 16 px (1176 px); 6 of 6 rows visible in the short list and 11 of 16 with a long list; the question line is cut in four rows.

### The same readings side by side

| | Today | 1 | 2 | 3 |
|---|---|---|---|---|
| Sidebar width, px | 248 | 248 | 56 (264 opened, over the board) | 264 |
| Board width at 1440, px | 1192 | 1192 | 1384 | 1176 |
| System block, open, px | 480 | 169 | 193 | 169 |
| Project list at 1440x900, px | 336 | 649 | 518 | 649 |
| Rows visible of 16, 1440x900 | 4 | 16 | 11 | 11 |
| Rows visible of 16, 1000x700 | 1 | 10 | 6 | 5 |
| Smallest control in the sidebar, px | 24 | 22 | 26 at rest, 22 opened | 22 |

No frame has a page error. The only frames whose sidebar is wider than its own box are variant 2's opened ones, where the sidebar lies over the board by design.

## 4. Where every function is

| # | Function | 1 Tidied | 2 Narrow rail | 3 Rich rows |
|---|---|---|---|---|
| F1 | Brand | Header, mark and name | Mark on the rail; name in the opened header | Header |
| F2 | Hide the rail | Header square | Opened header; at rest the rail is already 56 px | Header square |
| F3 | Header menu, all fourteen entries | Header, same component | The opened header; the button at the bottom of the rail serves keyboard and touch | Header, same component |
| F4 | Filter | Field with a search glyph | Search button on the rail opens the sidebar with the field focused | As 1 |
| F5 | Add a folder | Square beside the filter; a labelled button on first run | Folder button on the rail opens the sidebar with the form | As 1 |
| F6 | Overview | First row, grid icon, totals of both marks | Grid tile | As 1 |
| F7 | Select a project | One-line row | Monogram tile; the full name in the tooltip and the opened sidebar | Row of one to three lines |
| F8 | Working | Green dot and number | Green dot on the tile; number in the tooltip and opened | Green line: "N working" and engine marks |
| F8 | Waiting on the operator | Person mark and number | Amber number badge | Amber line with the question |
| F8 | Conversations | Selected row, and every row's tooltip | Tooltip, and the opened sidebar | Selected row, and every row's tooltip |
| F8 | Age | Short form in a right column | Tooltip, and the opened sidebar | Short form in a right column |
| F9 | Pin with the crown | Hover control at the row's right; "Pinned" section | Crown glyph above the pinned tiles; the control in the opened sidebar | As 1 |
| F10 | Archive | Labelled fold with its count | Archive tile with its count opens the sidebar with the archive unfolded | As 1 |
| F11 | Empty, loading, unreachable catalog | Same notices in the list | In the opened sidebar | Same notices in the list |
| F12 | Fold the system block | Labelled fold, same stored key as today | Chevron above the gauges, same stored key | As 1 |
| F13 | Memory and swap; cleanup panel | One line each; the block opens the panel | One square with two bars; opens the panel | As 1 |
| F14 | Claude, Codex | One line each: account opens accounts, reading opens burndown; every window behind the detail control and in the tooltip | One gauge each, opens accounts; burndown and windows in the opened sidebar | As 1 |
| F15 | Copilot | One line; opens its account list | One gauge; opens its account list | As 1 |
| F16 | Telegram | One line with status; opens its panel | Icon with a status dot; opens its panel | As 1 |
| F17 | Stale and failed readings | Dimmed line and amber dot; reason in the tooltip | Amber dot on the gauge | As 1 |

## 5. Costs

**1.** The conversation count leaves the unselected rows. Reset times need one click (the detail control) or a hover. An engine line shows one window, the tightest, where today shows all. The crown control and the detail control are 22 px squares; today's smallest rail control is 24 px.

**2.** A monogram names a project only to someone who already knows the list,, and two projects can share one. Opening on hover will sometimes open by accident, and the opened sidebar covers 264 px of the board while it is open. Every function that needs text is two steps away. With a pointer the rail opens before a click lands on it, so the menu button at the bottom of the rail is covered by the opened sidebar and the menu is used from the opened header (the `rail-menu` frame shows this); the prototype leaves that seam unresolved. The rail carries more new behaviour than the other two together (hover timing, focus, Escape, docking), so it is the most expensive to finish and test.

**3.** The sidebar is 16 px wider. A busy project takes up to three lines, so a long list scrolls sooner than in variant 1 (11 of 16 rows visible against 16 of 16). The question line is one more place where a conversation title is shown and cut. The row height changes as agents start and stop, so rows move more.

All three: the compact footer needs the `density` property this lane added to `ResourcesFooter`, `LimitsFooter`, `CopilotFooterRow` and `TelegramFooterRow`. Its default is today's drawing, and nothing in the product passes another value.

## 6. Recommendation

**Variant 1**, with one thing taken from variant 3.

Variant 1 answers eleven of the twelve marks (a long name is still cut on an unselected row, with the full name in its tooltip) and asks the operator to relearn nothing: every control is where it is today, the list gets twice the height, and the footer reads as one table. It is also the cheapest to ship, because each row and each footer line is a restyle of a component that exists.

From variant 3, take the amber question line, for rows that wait on the operator only. That is the fact the operator acts on, there are rarely more than two or three such rows, and it costs one line each. The green line with engine marks can stay behind: "2 working" is already said by the mark.

Variant 2 is worth keeping as a later option for the hide control: today the sidebar is either fully open or gone, and a docked 56 px rail is a useful middle. It should follow the choice of a full-width design, since its opened state is that design.

## 7. Evidence

Driver: the block "the left sidebar, numbered design variants" in `src/components/kanban/kanbanBoard.browser.test.tsx`, over `src/components/kanban/issue1695Evidence.fixture.tsx` with `?rail=few|many` (synthetic projects only) and `?railv=0|1|2|3`. The variant's number is printed on a strip above the application frame; the frame under it is the real Viewer.

```
LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=<chrome> SIDEBAR_FRAMES_DIR=<a directory outside the checkout> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "numbered design variants"
```

Frames at 1440x900 and 1000x700, light and dark, en and uk, today (0) and each variant in the same states: Overview selected, a project selected, the footer folded, sixteen projects with an archive; for variant 2 also the opened sidebar; the header menu and the create form once per drawing. The fixture carries a long project name in every state. The readings each frame is judged by are committed in `evidence/sidebar-redesign/measurements.json`. Frames and contact sheets are not committed; they are in `$HOME/Projects/delegatus-wt/handoff/ui-targeted/sidebar/`:

- `critique-today-light-en.png`, `critique-today-light-uk.png`: today's rail with the twelve marks
- `sheet-variant-0.png` … `sheet-variant-3.png`: one contact sheet per drawing; `sheet-variant-N-menu-and-create.png` beside each
- `sheet-compare-all.png`: today and all three, whole frames
- `sheet-compare-rails-<size>-<scheme>-<lang>.png`: the rails alone at full size, one sheet per combination
- `v<N>-<state>-<size>-<scheme>-<lang>.png`: the frames
