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
| F13 | Memory and swap readings, the age of the capture; the sessions cleanup panel | `src/components/ResourcesFooter.tsx:120`, panel at `:377` |
| F14 | Claude and Codex: active account, plan tier, every limit window with its reset, the accounts panel, the burndown chart | `src/components/LimitsFooter.tsx:138`, panels at `:395`–`:396` |
| F15 | Copilot account and allowance | `src/components/CopilotFooterRow.tsx:195` |
| F16 | Telegram status and its panel | `src/components/TelegramConnect.tsx:414` |
| F17 | Stale and failed readings (dimmed block, amber dot, reason) | `src/components/LimitsFooter.tsx:264`, `src/components/ResourcesFooter.tsx:262` |

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

Every footer line in the variants names what is left ("9.0 GiB free", "left 12%") and its bar draws that same share, so a shorter bar is worse in every block and the number and the bar never disagree. The driver measures it: in every frame the drawn bar is within two points of the reading beside it (28.1% beside 9.0 of 32 GiB, 87.5% beside 7.0 of 8 GiB, 12% and 65% beside the two accounts).

### 1. Tidied sidebar, compact system block

Same width (248 px), same order, same places. Rows are one line: name, then a column for each mark, then a short age (`31s`, `11m`, `3h`, `6d`). "Waiting" has one column and "working" has another, so each is read down the list; a row without a mark keeps its column empty, and a column exists only while some project carries its mark. A name longer than its column takes a second line before it is cut. The selected row also shows its conversation count. Sections carry labels ("Pinned" with the crown, "Projects 4", "Archive 2"), so the crown leaves the name's left edge. Every name and every label (Overview, the section labels, Archive, System) starts at the same x, 19 px; the icon of a label follows its word. The filter gets a search glyph and the header keeps its two squares.

The system block is one line per reading on a shared grid: name, what is left, bar. An engine line shows the engine mark, the active account, and the tightest window ("left 12%"); the account opens the accounts panel, the reading opens the burndown chart. A control in the block's header, named in words ("All windows" / "Compact"), swaps the lines for today's full blocks with every window and reset, and remembers the choice. An aged or failed reading keeps its amber dot beside the name it qualifies, and the reason is in the tooltip of the dot and of the line; a read that failed puts its reason in the line in place of the number.

Measured at 1440x900: footer 169 px (480 today), list 649 px (336 today), 15 of 16 rows visible with a long list (4 of 16 today). The driver reads one left edge for names and labels (19 px), one for the waiting marks (130 px) and one for the working marks (168 px) in every frame.

**1 with the question line** (`?railask=1`, frames `v1-ask-…`): the same sidebar with variant 3's question under each row that waits on the operator. This is the combination section 6 recommends. Measured at 1440x900: 6 of 6 rows in the short list and 12 of 16 with a long list; no question is cut in any of the sixteen frames.

### 2. Narrow rail that opens

At rest the sidebar is a 56 px rail: the mark, three buttons (open, find, add a folder), Overview, one tile per project with a two-letter monogram, an archive tile, a gauge per system block, and the header menu at the bottom. A tile carries a number badge for waiting and a green dot for working; the selected tile has a bar on the rail's edge. Resting the pointer on the rail, or pressing any of its open controls, lays the full sidebar of variant 1 **beside** the rail, over the board and without moving the board. The rail is never covered, so the click that follows the pause lands on the tile or the gauge under the pointer; that click also closes the sidebar, since the choice is made, and a gauge's panel or the menu then opens in the space the sidebar left. Escape, a click outside or leaving closes it. A dock control in the opened header keeps the sidebar open in the layout, and that choice is remembered. The opened sidebar is 248 px, the width of the docked one.

Measured at 1440x900: the board gains 192 px (1384 px wide, 1192 today); 11 of 16 tiles visible with a long list. The pointer rehearsal in the driver leaves the rail, comes back onto a target, rests 300 ms and clicks: 27 of 27 targets at the two sizes (15 tiles, Overview twice, eight gauges, the menu twice) had the sidebar open at the click, were themselves under the pointer, and did their own job (that project selected and no other, that panel or the menu open and uncovered).

### 3. Projects that say who waits and who runs

The full sidebar at 264 px. A quiet project is one line, as in variant 1. A project with something happening grows by one line per fact: an amber line with the mark and the **title of the oldest conversation waiting on the operator**, on up to two lines, and a green line with "N working" and the marks of the engines running there. The row's tooltip carries the whole question. The operator reads the question in the sidebar and decides whether to go.

The system block is the one from variant 1.

Measured at 1440x900: the board loses 16 px (1176 px); 6 of 6 rows visible in the short list and 8 of 16 with a long list. Of the fixture's questions none is cut in English and one is cut after two lines in Ukrainian, in every state and at both sizes; its tooltip completes it.

### The same readings side by side

| | Today | 1 | 1 with the question | 2 | 3 |
|---|---|---|---|---|---|
| Sidebar width, px | 248 | 248 | 248 | 56 (248 more opened, over the board) | 264 |
| Board width at 1440, px | 1192 | 1192 | 1192 | 1384 | 1176 |
| System block, open, px | 480 | 169 | 169 | 193 | 169 |
| Project list at 1440x900, px | 336 | 649 | 649 | 518 | 649 |
| Rows visible of 16, 1440x900 | 4 | 15 | 12 | 11 | 8 |
| Rows visible of 16, 1000x700 | 1 | 9 | 6 | 6 | 4 |
| Questions cut, en / uk | | | 0 / 0 | | 0 / 1 |
| Smallest control in the sidebar, px | 24 | 22 | 22 | 26 at rest, 22 opened | 22 |

No frame has a page error. A sidebar is wider than its own box only where something lies outside it by design: variant 2's opened sidebar, and a frame with a panel open. Every opened panel is whole inside the window.

## 4. Where every function is

| # | Function | 1 Tidied | 2 Narrow rail | 3 Rich rows |
|---|---|---|---|---|
| F1 | Brand | Header, mark and name | Mark on the rail; name in the opened header | Header |
| F2 | Hide the rail | Header square | Opened header; at rest the rail is already 56 px | Header square |
| F3 | Header menu, all fourteen entries | Header, same component | Button at the bottom of the rail, always reachable; the menu opens beside the rail. Docked: the header | Header, same component |
| F4 | Filter | Field with a search glyph | Search button on the rail opens the sidebar with the field focused | As 1 |
| F5 | Add a folder | Square beside the filter; a labelled button on first run | Folder button on the rail opens the sidebar with the form | As 1 |
| F6 | Overview | First row, grid icon, totals of both marks | Grid tile | As 1 |
| F7 | Select a project | Row of one line, two for a long name | Monogram tile; the full name in the tooltip and the opened sidebar | Row of one to three lines |
| F8 | Working | Green dot and number, in its own column | Green dot on the tile; number in the tooltip and opened | Green line: "N working" and engine marks |
| F8 | Waiting on the operator | Person mark and number, in its own column; with `?railask=1` also the question under the row | Amber number badge | Amber line with the question, whole in the tooltip |
| F8 | Conversations | Selected row, and every row's tooltip | Tooltip, and the opened sidebar | Selected row, and every row's tooltip |
| F8 | Age | Short form in a right column | Tooltip, and the opened sidebar | Short form in a right column |
| F9 | Pin with the crown | Hover control at the row's right; "Pinned" section | Crown glyph above the pinned tiles; the control in the opened sidebar | As 1 |
| F10 | Archive | Labelled fold with its count | Archive tile with its count opens the sidebar with the archive unfolded | As 1 |
| F11 | Empty, loading, unreachable catalog | Same notices in the list | In the opened sidebar | Same notices in the list |
| F12 | Fold the system block | Labelled fold, same stored key as today | Chevron above the gauges, same stored key | As 1 |
| F13 | Memory and swap; cleanup panel | One line each, free memory and free swap; the block opens the panel. The age of the capture and Delegatus's own memory are in the tooltip and behind "All windows" | One square with two bars; opens the panel; the same tooltip | As 1 |
| F14 | Claude, Codex | One line each: account opens accounts, reading opens burndown. The plan tier, every window and the age of an old reading are in the tooltip; the reset times are behind "All windows" | One gauge each, opens accounts; the same tooltip; burndown and reset times in the opened sidebar | As 1 |
| F15 | Copilot | One line; opens its account list | One gauge; opens its account list | As 1 |
| F16 | Telegram | One line with status; opens its panel | Icon with a status dot; opens its panel | As 1 |
| F17 | Stale and failed readings | Dimmed line and an amber dot beside the name; the reason in the tooltip of the dot and the line, for memory and for limits; a failed read shows its reason in the line | Dimmed gauge and an amber dot in its corner; the reason in the tooltip | As 1 |

## 5. Costs

**1.** The conversation count leaves the unselected rows. Reset times need one click ("All windows"). An engine line shows one window, the tightest, where today shows all; the engine is named by its 12 px mark and the tooltip, and the plan tier and the age of the capture are in the tooltip only. Two mark columns and the age leave a name about 106 px, so a long name wraps to a second line and a very long one is still cut there (one such name in the fixture, whole in the tooltip). The account's name on an engine line has about 65 px; a longer one is cut, as today. Swap is stated as free where today's block says used. The crown control is a 22 px square; today's smallest rail control is 24 px. With the question line, a row that waits is up to two lines taller, so 12 of 16 rows fit where 15 do without it.

**2.** A monogram names a project only to someone who already knows the list, and two projects can share one. Opening on hover will sometimes open by accident. While it is open the sidebar covers the board from x 56 to x 304: on a project's board that is the project's name and its "N working" counter in the board header, the left edge of the search field, the left 248 px of the orchestrator conversation (its header and the start of every line), and the tab strip and first column heading under it; on Overview it is the summary line and most of the first column of cards. The rail stays in view, so nothing on it is covered and a click on it is never misdirected; that click closes the sidebar, and the pointer has to leave and return, or press the open button, to bring it back. Every function that needs text is two steps away. Docking moves the sidebar 56 px to the left, because the rail folds into it. The docked header has three squares (dock, hide, menu) where today's has two. The rail carries more new behaviour than the other two together (hover timing, focus, Escape, docking), so it is the most expensive to finish and test.

**3.** The sidebar is 16 px wider. A busy project takes up to four lines, so a long list scrolls sooner than in variant 1 (8 of 16 rows visible against 15 of 16). The question line is one more place where a conversation title is shown, and a long one is cut after two lines. The row height changes as agents start and stop, so rows move more. Amber and green text on most rows makes it the loudest of the three.

All three: the compact footer needs the `density` property this lane added to `ResourcesFooter`, `LimitsFooter`, `CopilotFooterRow` and `TelegramFooterRow`. Its default is today's drawing, and nothing in the product passes another value.

## 6. Recommendation

**Variant 1**, with one thing taken from variant 3.

Variant 1 answers the twelve marks (a long name gets a second line; a name too long for two lines is still cut, with the full name in its tooltip) and asks the operator to relearn nothing: every control is where it is today, the list gets twice the height, and the footer reads as one table. It is also the cheapest to ship, because each row and each footer line is a restyle of a component that exists.

From variant 3, take the amber question line, for rows that wait on the operator only. That is the fact the operator acts on, there are rarely more than two or three such rows, and it costs one or two lines each. The combination is drawn: `?railask=1`, frames `v1-ask-…` and `v1-ask-many-…`. The green line with engine marks can stay behind: "2 working" is already said by the mark.

Variant 2 is worth keeping as a later option for the hide control: today the sidebar is either fully open or gone, and a docked 56 px rail is a useful middle. It should follow the choice of a full-width design, since its opened state is that design.

## 7. Evidence

Driver: the block "the left sidebar, numbered design variants" in `src/components/kanban/kanbanBoard.browser.test.tsx`, over `src/components/kanban/issue1695Evidence.fixture.tsx` with `?rail=few|many` (synthetic projects only) and `?railv=0|1|2|3`. The variant's number is printed on a strip above the application frame; the frame under it is the real Viewer.

```
LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=<chrome> SIDEBAR_FRAMES_DIR=<a directory outside the checkout> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "numbered design variants"
```

Frames at 1440x900 and 1000x700, light and dark, en and uk, today (0) and each variant in the same states: Overview selected, a project selected, the footer folded, sixteen projects with an archive; for variant 1 also the question line (`ask`, `ask-many`); for variant 2 also the opened sidebar; the header menu and the create form once per drawing. The fixture carries a long project name in every state.

The states "every function is kept" rests on are shot once each, at 1440x900 light uk (`?railstate=`): a Copilot account on a line and on a gauge, and its account list; aged memory and Claude readings with a failed Codex read; every limit window after "All windows"; the accounts panel, the burndown chart, the sessions cleanup and the Telegram panel opened from variant 1's lines, and the three a gauge opens from variant 2's rail (the burndown chart has no gauge and is reached from the opened sidebar); the empty list, the loading list and the unreachable catalog.

The readings each frame is judged by are committed in `evidence/sidebar-redesign/measurements.json`: per frame the sizes, the left edges of names, labels and mark columns, each footer line's reading and the share its bar draws, the cut questions, and the size of an opened panel; then the pointer rehearsal of variant 2 (`pointer`) and the text its opened sidebar lies over (`covered`). The driver fails on two left edges, a bar more than two points from its reading, a cut question the tooltip does not complete, a panel outside the window, or a pointer target that missed. Frames and contact sheets are not committed; they are in `$HOME/Projects/delegatus-wt/handoff/ui-targeted/sidebar/`:

- `critique-today-light-en.png`, `critique-today-light-uk.png`: today's rail with the twelve marks
- `sheet-variant-0.png` … `sheet-variant-3.png`: one contact sheet per drawing; `sheet-variant-N-menu-and-create.png` beside each
- `sheet-variant-1-states.png`, `sheet-variant-2-states.png`: the states of the paragraph above
- `sheet-compare-all.png`: today and all three, whole frames
- `sheet-compare-rails-<size>-<scheme>-<lang>.png`: the rails alone at full size, one sheet per combination
- `v<N>-<state>-<size>-<scheme>-<lang>.png`: the frames
