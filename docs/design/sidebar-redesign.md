# The left sidebar: three numbered variants inside today's interface

**Originating requirement** (operator's verdict on two redesign attempts, 2026-10-06, as paraphrased in the lane's specification): the orchestrator conversation looks good and stays; the pipelines interface is well thought out and stays; "the left sidebar does not look good and has odd moments". The redesign is targeted: Delegatus keeps its structure and its visual language, and only the named surfaces are redrawn, each in its own lane, to the quality of the best parts of today's interface. No liquid glass.

**Variant 1 was built and is the product's sidebar** (operator's decision, 2026-10-06: sidebar variant 1, without the question line). Section 8 says what was built, what changed against the drawing and where its evidence is. Sections 1 to 7 are the design as it was written and judged: in them "today" is the sidebar that variant 1 replaced, and the prototype file, the variant switch (`?railv=`, `?railask=`, `?railopen=`) and the driver block they name were removed with the build.

This note covers the desktop sidebar. When it was written it was a design: the three variants were working prototypes drawn on the real product components, and the product kept drawing the sidebar of section 1 unless the kanban evidence fixture asked for a variant.

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
| F14 | Claude and Codex: active account, plan tier, every limit window with its reset, the accounts panel, the burndown chart | `src/components/LimitsFooter.tsx:138`, panels at `:400`–`:401` |
| F15 | Copilot account and allowance | `src/components/CopilotFooterRow.tsx:195` |
| F16 | Telegram status and its panel | `src/components/TelegramConnect.tsx:414` |
| F17 | Stale and failed readings (dimmed block, amber dot, reason) | `src/components/LimitsFooter.tsx:262`, `src/components/ResourcesFooter.tsx:262` |

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

Same width (248 px), same order, same places. Rows are one line: name, then a column for each mark, then a short age (`31s`, `11m`, `3h`, `6d`). "Waiting" has one column and "working" has another, so each is read down the list, and a column exists only while some project carries its mark. The marks and the age stand at the right of the first line only. A name takes the columns its own row leaves empty, and a name longer than the first line goes on under the marks across the whole row before it is cut after two lines. A row is the same height selected or not, so choosing a project moves nothing; the conversation count is in the row's tooltip. Sections carry labels, each with its count ("Pinned 2" with the crown, "Projects 4", "Archive 2"), so the crown leaves the name's left edge. Every name and every label (Overview, the section labels, Archive, System, and every line of the system block: RAM, Swap, the accounts, Telegram) starts at the same x, 19 px; the icon of a label follows its word. The archive is a labelled fold under the list; unfolded, its rows are drawn as the quiet rows above them, without the crown control. The filter gets a search glyph. The two header controls are icons with no frame until the pointer is on them, so the filter row holds the only two frames above the list. A rail with no project has nothing to filter, so the labelled "Create project" button takes the whole row (today the field beside it is squeezed to "Filter pro").

The system block is one line per reading on a shared grid: name, what is left, bar. An engine line shows the active account, the engine's mark after it, and the tightest window ("left 12%"); the account opens the accounts panel, the reading opens the burndown chart. The mark follows the account as an icon follows its word in the list, so the account starts on the edge RAM and Swap start on and the block has one left edge. The Copilot line is built the same way: the account in the same type, a mark in the same 12 px box after it (its tint dot, since the product has no Copilot mark), the reading and the bar. Telegram is the word and then its glyph. A control in the block's header, named in words ("All windows" / "Compact"), swaps the lines for today's full blocks with every window and reset, and remembers the choice. An aged or failed reading keeps its amber dot: beside the word on a memory line, on the corner of the engine mark on an engine line, where it takes no width from the account's name. The reason is in the tooltip of the dot and of the line. A read that failed puts its reason in the line in place of the number, in the room the account's name leaves, so the name is whole in that state too.

Measured at 1440x900: footer 169 px (480 today), list 649 px (336 today), 16 of 16 rows visible with a long list (4 of 16 today). No project name is cut in any frame of the variant, in either language (today cuts the long one in every frame). The driver reads one left edge for names, labels and the lines of the system block (19 px), one for the waiting marks (130 px) and one for the working marks (168 px) in every frame.

**1 with the question line** (`?railask=1`, frames `v1-ask-…`): the same sidebar with variant 3's question under each row that waits on the operator. This is the combination section 6 recommends. Measured at 1440x900: 6 of 6 rows in the short list and 13 of 16 with a long list in English, 12 in Ukrainian, where two questions take a second line; no question is cut in any of the sixteen frames.

### 2. Narrow rail that opens

At rest the sidebar is a 56 px rail: the mark, three buttons (open, find, add a folder), Overview, one tile per project with a two-letter monogram, an archive tile, a gauge per system block, and the header menu at the bottom. A tile carries a number badge for waiting and a green dot for working; the selected tile has a bar on the rail's edge. Resting the pointer on the rail, or pressing any of its open controls, lays the full sidebar of variant 1 **beside** the rail, over the board and without moving the board. The rail is never covered, so the click that follows the pause lands on the tile or the gauge under the pointer; that click also closes the sidebar, since the choice is made, and a gauge's panel or the menu then opens in the space the sidebar left. Escape, a click outside or leaving closes it. A dock control in the opened header keeps the sidebar open in the layout, and that choice is remembered. The opened sidebar is 248 px, the width of the docked one.

The rail says the state of its list at rest, with no hover. While the list loads, five placeholder tiles stand where the tiles will be. When the catalog cannot be reached, a red warning tile with the number of failed attempts stands there; a press on it opens the sidebar with the notice and its retry button, so an unreachable server never reads as an idle rail (#696). On a first run there is no tile to draw and one thing to say in words, so the full sidebar is drawn in the layout with the labelled "Create project" button until a project exists (#1162). A list longer than the rail shows a strip at the end it runs past, with an arrow and the number of tiles beyond it; a press on the strip scrolls to them. The archive tile carries its count, and a press on it opens the sidebar with the archive unfolded.

Measured at 1440x900: the board gains 192 px (1384 px wide, 1192 today); 10 of 16 tiles visible with a long list, and the strip under them reads 7: six tiles and the archive tile. The pointer rehearsal in the driver leaves the rail, comes back onto a target, rests 300 ms and clicks: 27 of 27 targets at the two sizes (15 tiles, Overview twice, eight gauges, the menu twice) had the sidebar open at the click, were themselves under the pointer, and did their own job (that project selected and no other, that panel or the menu open and uncovered).

### 3. Projects that say who waits and who runs

The full sidebar at 264 px. A quiet project is one line, as in variant 1. A project with something happening grows by one line per fact: an amber line with the mark and the **title of the oldest conversation waiting on the operator**, on up to two lines, and a green line with "N working" and the marks of the engines running there. The row's tooltip carries the whole question. The operator reads the question in the sidebar and decides whether to go.

The system block is the one from variant 1.

Measured at 1440x900: the board loses 16 px (1176 px); 6 of 6 rows visible in the short list and 9 of 16 with a long list. Of the fixture's questions none is cut in English and one is cut after two lines in Ukrainian, in every state and at both sizes; its tooltip completes it.

### The same readings side by side

| | Today | 1 | 1 with the question | 2 | 3 |
|---|---|---|---|---|---|
| Sidebar width, px | 248 | 248 | 248 | 56 (248 more opened, over the board) | 264 |
| Board width at 1440, px | 1192 | 1192 | 1192 | 1384 | 1176 |
| System block, open, px | 480 | 169 | 169 | 193 | 169 |
| Project list at 1440x900, px | 336 | 649 | 649 | 517, and 497 above the strip of a long list | 649 |
| Rows visible of 16, 1440x900 | 4 | 16 | 13 en, 12 uk | 10 | 9 |
| Rows visible of 16, 1000x700 | 1 | 10 | 7 en, 6 uk | 5 | 5 |
| Project names cut, frames | every | none | none | none (opened) | none |
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
| F5 | Add a folder | Square beside the filter; on first run a labelled button across the row | Folder button on the rail opens the sidebar with the form | As 1 |
| F6 | Overview | First row, grid icon, totals of both marks | Grid tile | As 1 |
| F7 | Select a project | Row of one line, two for a long name; the second line runs under the marks | Monogram tile; the full name in the tooltip and the opened sidebar | Row of one to three lines |
| F8 | Working | Green dot and number, in its own column | Green dot on the tile; number in the tooltip and opened | Green line: "N working" and engine marks |
| F8 | Waiting on the operator | Person mark and number, in its own column; with `?railask=1` also the question under the row | Amber number badge | Amber line with the question, whole in the tooltip |
| F8 | Conversations | Every row's tooltip | Tooltip, here and in the opened sidebar | Every row's tooltip |
| F8 | Age | Short form in a right column | Tooltip, and the opened sidebar | Short form in a right column |
| F9 | Pin with the crown | Control at the row's right, in the age's place while the pointer is on the row or the keyboard is on the control; "Pinned" section with its count | Crown glyph above the pinned tiles; the control in the opened sidebar | As 1 |
| F10 | Archive | Labelled fold with its count under the list; unfolded, the archived rows (frames `v1-archive`) | Archive tile with its count at the end of the tiles (`v2-archive`); a press opens the sidebar with the archive unfolded (`v2-open-archive`) | As 1 (`v3-archive`) |
| F11 | Empty, loading, unreachable catalog | Same notices in the list | At rest on the rail: placeholder tiles while loading (`v2-loading`); a warning tile with the attempt count when the catalog is unreachable (`v2-unreachable`), which opens the notice and its retry (`v2-unreachable-open`); on a first run the full sidebar in the layout with the labelled button (`v2-empty`) | Same notices in the list |
| F12 | Fold the system block | Labelled fold, same stored key as today | Chevron above the gauges, same stored key | As 1 |
| F13 | Memory and swap; cleanup panel | One line each, free memory and free swap; the block opens the panel. The age of the capture and Delegatus's own memory are in the tooltip and behind "All windows" | One square with two bars; opens the panel; the same tooltip | As 1 |
| F14 | Claude, Codex | One line each: account opens accounts, reading opens burndown. The plan tier, every window and the age of an old reading are in the tooltip; the reset times are behind "All windows" | One gauge each, opens accounts; the same tooltip; burndown and reset times in the opened sidebar | As 1 |
| F15 | Copilot | One line built as the Claude and Codex lines: the active account by name, the tint dot after it, what is left, bar. With no account the line reads "Copilot" and "no account". Opens its account list | One gauge; opens its account list; the account is in the tooltip | As 1 |
| F16 | Telegram | One line, the word and then its glyph, with status; opens its panel | Icon with a status dot; opens its panel | As 1 |
| F17 | Stale and failed readings | Dimmed line and an amber dot (beside "RAM", on the corner of an engine mark); the reason in the tooltip of the dot and the line, for memory and for limits; a failed read shows its reason in the line beside the whole account name | Dimmed gauge and an amber dot in its corner; the reason in the tooltip | As 1 |

## 5. Costs

**1.** The conversation count leaves the rows for their tooltips. Reset times need one click ("All windows"). An engine line shows one window, the tightest, where today shows all; the engine is named by its 12 px mark and the tooltip, and the plan tier and the age of the capture are in the tooltip only. A name has 106 px of the first line in a row with both marks, 144 px with one and 174 px with none, and 210 px of the second; the fixture's 42 and 45 letter names are whole in both languages, and a name longer than two lines is cut with the full name in the tooltip. A row whose name wraps is 18 px taller than its neighbours. The second line runs under the marks by a float inside a line clamp, which the driver checks in Chromium only; the other engines need a check before this ships. The account's name on an engine line has about 66 px beside a reading in Ukrainian; a longer one is cut, as today. A failed read's reason is cut after about 25 letters and is whole in the tooltip. Copilot is named on its line by a tint dot and the tooltip. The engine's mark stands after the account, so the marks of two lines are in one column only when the two account names are equally long. The age of a row is hidden while the pointer is on it or the keyboard is on its crown control, because the control stands there. Swap is stated as free where today's block says used. The crown control is a 22 px square; today's smallest rail control is 24 px. With the question line, a row that waits is up to two lines taller, so 12 or 13 of 16 rows fit where all 16 do without it.

**2.** A monogram names a project only to someone who already knows the list, and two projects can share one. A first run gets no rail at all: the sidebar is 248 px until the first project exists, then folds to 56 px, so the board moves once. An unreachable catalog is one red tile at rest; its wording and the retry are one press away. The strip that counts the tiles past the end of the list takes 20 px from the list, which is one tile fewer in view (10 of 16 where 11 fitted). Opening on hover will sometimes open by accident. While it is open the sidebar covers the board from x 56 to x 304: on a project's board that is the project's name and its "N working" counter in the board header, the left edge of the search field, the left 248 px of the orchestrator conversation (its header and the start of every line), and the tab strip and first column heading under it; on Overview it is the summary line and most of the first column of cards. The rail stays in view, so nothing on it is covered and a click on it is never misdirected; that click closes the sidebar, and the pointer has to leave and return, or press the open button, to bring it back. Every function that needs text is two steps away. Docking moves the sidebar 56 px to the left, because the rail folds into it. The docked header has three squares (dock, hide, menu) where today's has two. The rail carries more new behaviour than the other two together (hover timing, focus, Escape, docking), so it is the most expensive to finish and test.

**3.** The sidebar is 16 px wider. A busy project takes up to four lines, so a long list scrolls sooner than in variant 1 (9 of 16 rows visible against 16 of 16). The question line is one more place where a conversation title is shown, and a long one is cut after two lines. The row height changes as agents start and stop, so rows move more. Amber and green text on most rows makes it the loudest of the three.

All three: the compact footer needs the `density` property this lane added to `ResourcesFooter`, `LimitsFooter`, `CopilotFooterRow` and `TelegramFooterRow`. Its default is today's drawing, and nothing in the product passes another value.

## 6. Recommendation

**Variant 1**, with one thing taken from variant 3.

Variant 1 answers the twelve marks (for mark 1, two frames above the list where today has four; for mark 7, a long name gets a second line across the row, and a name too long for two lines is still cut, with the full name in its tooltip) and asks the operator to relearn nothing: every control is where it is today, the list gets twice the height, and the footer reads as one table. It is also the cheapest to ship, because each row and each footer line is a restyle of a component that exists.

From variant 3, take the amber question line, for rows that wait on the operator only. That is the fact the operator acts on, there are rarely more than two or three such rows, and it costs one or two lines each. The combination is drawn: `?railask=1`, frames `v1-ask-…` and `v1-ask-many-…`. The green line with engine marks can stay behind: "2 working" is already said by the mark.

Variant 2 is worth keeping as a later option for the hide control: today the sidebar is either fully open or gone, and a docked 56 px rail is a useful middle. It should follow the choice of a full-width design, since its opened state is that design.

## 7. Evidence

Driver: the block "the left sidebar, numbered design variants" in `src/components/kanban/kanbanBoard.browser.test.tsx`, over `src/components/kanban/issue1695Evidence.fixture.tsx` with `?rail=few|many` (synthetic projects only) and `?railv=0|1|2|3`. The variant's number is printed on a strip above the application frame; the frame under it is the real Viewer.

```
LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=<chrome> SIDEBAR_FRAMES_DIR=<a directory outside the checkout> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "numbered design variants"
```

Frames at 1440x900 and 1000x700, light and dark, en and uk, today (0) and each variant in the same states: Overview selected, a project selected, the footer folded, sixteen projects with an archive; for variant 1 also the question line (`ask`, `ask-many`); for variant 2 also the opened sidebar; the header menu and the create form once per drawing. The fixture carries a long project name in every state.

The states "every function is kept" rests on are shot at 1440x900 light (`?railstate=`), in Ukrainian unless said: a Copilot account on a line (variants 1 and 3) and on a gauge, in both languages, and its account list; aged memory and Claude readings with a failed Codex read, in all three variants and both languages; every limit window after "All windows"; the accounts panel, the burndown chart, the sessions cleanup and the Telegram panel opened from variant 1's lines, and the three a gauge opens from variant 2's rail (the burndown chart has no gauge and is reached from the opened sidebar); the empty list (today's beside each variant's), the loading list and the unreachable catalog in all three variants, each read at rest, and for variant 2 also the notice its warning tile opens; the archive with two archived projects under the short list, in both languages: unfolded in variants 1 and 3, the tile on variant 2's rail, and the sidebar that tile opens.

The readings each frame is judged by are committed in `evidence/sidebar-redesign/measurements.json`: per frame the sizes, the left edges of names, labels and mark columns, each footer line's reading and the share its bar draws, the cut questions, and the size of an opened panel; then the pointer rehearsal of variant 2 (`pointer`) and the text its opened sidebar lies over (`covered`). The driver fails on two left edges (names and labels, each mark column, the account names on the engine lines), an account name cut on an engine line in any state, a project name cut in an English frame, a bar more than two points from its reading, a cut question the tooltip does not complete, a panel outside the window, a pointer target that missed, a state whose own element is absent from the frame (the labelled button on a first run, the placeholder rows or tiles while loading, the notice or the warning tile when the catalog is unreachable), a first run drawn as a narrow rail, an archive label off the 19 px edge or an unfolded archive without both of its rows in the frame, or a tile list that runs past its box with no strip saying so. Frames and contact sheets are not committed; they are in `$HOME/Projects/delegatus-wt/handoff/ui-targeted/sidebar/`:

- `critique-today-light-en.png`, `critique-today-light-uk.png`: today's rail with the twelve marks
- `sheet-variant-0.png` … `sheet-variant-3.png`: one contact sheet per drawing; `sheet-variant-N-menu-and-create.png` beside each
- `sheet-variant-0-states.png` … `sheet-variant-3-states.png`: the states of the paragraph above (today has the empty list only)
- `sheet-compare-all.png`: today and all three, whole frames
- `sheet-compare-rails-<size>-<scheme>-<lang>.png`: the rails alone at full size, one sheet per combination
- `v<N>-<state>-<size>-<scheme>-<lang>.png`: the frames

## 8. What was built

`ProjectRail` in `src/components/ProjectRail.tsx` is variant 1 for every user of the desktop layout. Variants 2 and 3, the question line, `sidebarVariants.prototype.tsx`, the context that let the fixture swap the drawing, and the gauge drawing of the footer blocks are gone. The phone is unchanged: it draws its project picker with `MobileProjectSheet`, and the memory and Telegram blocks keep their `full` drawing for it. The limits and Copilot blocks are mounted by the sidebar alone, so they have its two drawings and no other.

Built as drawn in section 3: one left edge at 19 px for every name and label; a column for each mark that exists only while some project carries the mark; a short age in the last column; "Pinned" and "Projects" sections with their counts, the crown on the label of the first; the archive as a labelled fold with its count, its rows without the crown control; Overview with the totals of both marks; the filter with its glyph and, on a first run, the labelled "Create project" button across the row; the system block of one line per reading behind the same fold and the same stored key as before.

Every function of section 1 is in the built sidebar, at the place the "1 Tidied" column of section 4 names. The strings the prototype carried in its own table are i18n keys now (`rail.pinned`, `rail.rowNeedsYou`, `rail.rowWorking`, `rail.rowConversations`, `rail.rowUpdated`, `rail.age*`, `rail.footerDetail*`, `rail.footerCompact*`), in English and Ukrainian with the Ukrainian plural forms.

Changed against the drawing, each from the design critique's open notes on variant 1:

1. **"All windows" has the block's left edge.** The drawing swapped the lines for the old full blocks, which start at 14 px, put the Telegram icon before its word again and fill the memory bar as memory is used. The built mode keeps the same lines and adds under each account its plan and every limit window on the same grid: the window's name, what is left, a bar of that share, and the reset under it. Memory adds what Delegatus itself holds and the age of the reading. A failed read's reason is whole under its account there. Every bar in the block draws what is left, in both modes. The choice is stored under `llv:rail-footer-detail:v1`.
2. **The switch reads as a control.** "All windows" / "Compact" has a frame, where the drawing had bare words.
3. **"Pinned" carries its count** as "Projects" and "Archive" do, and the driver checks each count against the rows under it.
4. **The crown control and the age never share a place.** The control shows while the pointer is on the row or the keyboard is on the control, and the age of that row is hidden for exactly as long. The driver reaches a control with Tab alone and fails if the age under it is drawn, if a mark is under it, or if any other row shows a control or hides its age.

The cost section's list for variant 1 stands for the built sidebar, with two changes: reset times and the plan tier are one press away and no longer need the old blocks; a reset line with the hour of an old reading runs to a second line and is never cut. The check of the name's second line in engines other than Chromium is still owed: this machine has Chromium only.

**Evidence.** Driver: the block "the left sidebar: one tidy panel with a compact system block" in `src/components/kanban/kanbanBoard.browser.test.tsx`, over the same fixture with `?rail=few|many`, `?railstate=`, `?railview=overview` and `?railarchive=1`, which are data scenarios and switch no drawing.

```
LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=<chrome> SIDEBAR_FRAMES_DIR=<a directory outside the checkout> \
  SIDEBAR_TODAY_DIR=<frames of the replaced sidebar> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "one tidy panel"
```

Frames at 1440x900 and 1000x700, light and dark, en and uk, in eight states: few (Overview selected), a project selected, the system block folded, sixteen projects, the empty list of a first run, the loading list, the unreachable catalog, the archive unfolded. Then once each at 1440x900 light: the header menu and the create form in both languages, a Copilot account and its account list, aged and failed readings, "All windows" (also with Copilot, with aged readings, and reached by its own switch), the accounts panel, the burndown chart, the sessions cleanup, the Telegram panel, and a crown control reached by the pointer and by the keyboard.

The replaced sidebar cannot be drawn by the product any more, so its side of every comparison is a frame the design lane's block wrote at the commit before the build (`v0-<state>-…png`, shot in the same eight states) and handed to the run through `SIDEBAR_TODAY_DIR`. Its numbers come from `evidence/sidebar-redesign/measurements.json`, which stays as the design lane committed it; the built sidebar's readings are in `evidence/sidebar-redesign/built.json`, each with the replaced sidebar's reading of the same frame beside it.

The driver fails on: a sidebar that is not 248 px or a board whose width differs from the one beside the replaced sidebar; two left edges for names and labels, for a mark column or for the lines of the system block, or an edge that is not 19 px; a section with no count or a count that differs from its rows; a label, a reading, a control word or a project name that is cut or leaves the sidebar, in either language; a bar more than two points from the reading beside it; an account name cut on an engine line; a failed read's reason that is cut with no tooltip completing it, or cut behind "All windows" with no whole line under its account; a state whose own element is absent from the frame; an archive label off the edge or an unfolded archive without both rows; a list no taller than the replaced sidebar's or with fewer rows in view; a panel outside the window; a crown control over an age or a mark; a page error.

Frames and sheets are not committed; they are in `$HOME/Projects/delegatus-wt/handoff/ui-built/sidebar/`:

- `sheet-compare-<size>-<scheme>-<lang>.png`: every state as "today | built", the sidebars alone at full size, one sheet per combination
- `sheet-compare-whole-light-<lang>.png`: whole frames of three states, so what is outside the sidebar can be compared
- `sheet-built-states.png`: the states shot once
- `built-<state>-<size>-<scheme>-<lang>.png`: the frames
- `today/v0-<state>-<size>-<scheme>-<lang>.png`: the frames of the replaced sidebar the comparison sheets use
