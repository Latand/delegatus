# S7 build brief: the memory profile window, levels on the left and rules on the right

## 0. Originating requirement

On 2026-11-20 (17:07 UTC) the operator answered the S2/S7 decision form on the
redesign task. For S7, the memory profile and rules window, the answer was:
build variant 5, «Рівні ліворуч, правила праворуч», as it is, with the remark
that it is fine overall. The same form chose to build S2 and S7 together. The
free-text comment on that form is about S2's stage branching and asks that the
visual critic's fixes land; it names no change to S7.

The pinned specification turns that answer into this outcome. The real window
follows variant 5 on desktop and phone, on the real components and the real
role-memory data:

- levels on the left (role, project, machine and any other level the data has)
  and the selected level's rules on the right;
- one scroller per pane;
- rule details keep the earlier text and its return;
- every current function stays reachable, including the profile summary,
  «З чим стикалися агенти», rule history and revert.

The operator's standing design rules apply:

- no liquid glass;
- a status is a small dot with a short popover;
- no new chrome where an existing control fits;
- no rows of identical cards;
- one obvious primary action.

Rendered evidence goes through the existing driver that renders this window,
with media outside the tree. The required checks are the pre-push hook and the
hosted required checks, with touched test files run one by one in isolated
state.

**Which prototype "variant 5" is.** The form numbered S2's variants 1–3 and
S7's variants 4–6. Variant 5 is S7 variant 2 in the prototype:

- `VariantTwo` in `docs/design/redesign-2026-11/prototype/s7.tsx` at commit
  `c521b9fc`. That commit is the critic-passed round 3. It sits on the
  unpublished local branch of the prototype lane and is absent from `main`.
  Read it with `git show c521b9fc:<path>`.
- Its frames are `s7-v2-desktop-profile`, `s7-v2-desktop-earlier`,
  `s7-v2-desktop-820-profile`, `s7-v2-phone-profile` and `s7-v2-phone-level`.
  They are under `<state>/evidence/b5153269/redesign-s2-s7/round-3/frames/`,
  listed in `manifest-round3.json` beside them.

The form's option labels, its answer indexes and the four frames it showed are
in the task's prototype review round (`read_prototype_review`, round 5).

## 1. What variant 5 is

The window keeps the product's shell:

- the overlay;
- the header: spark glyph, title «Профіль пам’яті · {project}», one line
  under it and ×;
- the curator line.

Under the curator line the window splits into two columns.

**Left column, 380 px, one scroller:**

- The profile summary without its card: headline, «Оновити», prose, and the
  model · time · language line.
- «За рівнями»: one row per level. Each row shows the role's costume and name
  · «Цей проєкт»/«Усі проєкти» (or «Проєкт», «Машина»), the level summary's
  headline under it, and the active-rule count at the right. The selected row
  has the accent background.
- «З чим стикалися агенти»: one row per overall topic, with its title, its
  one-line text and its rule count.

**Right pane, one scroller.** It holds the selected level's rules, drawn by
the product's `RuleSection` without its card:

- the heading in the text colour with its count;
- the level summary's prose as the subtitle;
- the rule rows, each with its kind's dot, ×, «Чому», the provenance line and
  «Попередній текст · N», which opens the earlier text, its time and «Повернути»;
- «Вибули з правил · N».

**Phone.** The left column is the first screen, and every level and topic row
ends in ›. A tap opens that level's rules as a second screen, which starts
with «← До профілю». The header and the curator line stay on both screens.

## 2. Sources read

| Source | What it settled |
|---|---|
| `git show c521b9fc:docs/design/redesign-2026-11/prototype/s7.tsx` (`VariantTwo`, `Shell`, `Summary`, `Level`, `LEVELS`) and `prototype.css` (`[data-s7-flat]` rules) | Exact layout, classes and which product parts the variant reuses |
| Round-3 manifest and the four variant-5 frames, plus the 820 px width check | What the operator saw; zero text cut sideways and zero rows cut at a scroller top in every variant-5 frame |
| `read_prototype_review` for the redesign task | The numbering 4–6 → 1–3, the answer «Будувати як є», the scope «Обидва одразу» |
| `src/components/roleMemory/LearnedRules.tsx`, `MemoryProfile.tsx`, `useMemoryProfile.ts`, `RoleMark.tsx` | Every current function (§4) |
| `src/lib/memory/roleStore.ts:757-801`, `roleTypes.ts`, `profileTypes.ts`, `profile.ts:84-115` | Which scopes the window receives and which get summaries (§3) |
| `src/components/kanban/kanbanBoard.browser.test.tsx:3596-4113`, `src/components/mobile/issue1671Evidence.browser.test.tsx:10134-10556`, `landing/site/demo/demo.tsx:829-845, 898-903, 948-953` | Every driver and demo that presses the controls this change removes |
| `docs/design/memory-profile.md`, `role-memory.md` §3 item 6, `role-memory-curation.md` §3.8, `landing-refresh-autonomy-memory.md` §4 | The earlier approved designs this one supersedes in part |
| An earlier attempt of this same stage (ended 17:18 UTC without writing the file) | Its findings: the prototype never reaches `main`; swarm scopes get their own summaries; no test rejects removed i18n keys; the committed evidence JSON these blocks rewrite holds no absolute paths |

`search_memory` held nothing about this window. No open pull request touches
`src/components/roleMemory/`. Five open pull requests change
`kanbanBoard.browser.test.tsx`, and all their hunks sit outside the memory
profile blocks (lines 3596–4113). Two open pull requests change
`src/lib/i18n/en.ts` and `uk.ts`; the key deletions of §5.9 can meet them as
line conflicts at merge, resolved by keeping both sides' other lines.

## 3. Real data → levels

The window reads `GET /api/role-memory?project=` (`RoleMemoryProjectView`).
`buildProjectView` (`roleStore.ts:776-797`) returns these scopes:

- every role scope with a stored scope row: this project's (`role:<project>:<role>`)
  and every-project ones (`role:*:<role>`);
- `project:<project>` and `machine`, always;
- one `swarm:<role>` per swarm role while swarm rules are enabled.

The profile (`GET /api/role-memory/profile`, `MemoryProfileView`) carries one
`slices[]` entry per scope with `count` and `summary`
(`profile.ts:109-111`), swarm scopes included.

**Which scopes become level rows:**

- a role scope with at least one active **or** departed (`left`) rule;
- a swarm scope with at least one active rule;
- the project and the machine scope always, even with nothing in them. They
  are the kinds a new agent starts with, and this row is the only place an
  empty one says so.

Keeping role scopes that hold only departed rules matters. The «Вибули з
правил» history and its «Повернути» exist today on the «Усі правила» page for
such a scope (`LearnedRules.tsx:358-366`). Dropping the row would make that
restore unreachable.

**Order.** Keep the existing order function unchanged (`MemoryProfile.tsx:50-55`,
already tested): role levels grouped by role, this project before every
project, then swarm levels, then project, then machine.

**Row label.** Keep the existing `label()` (`MemoryProfile.tsx:40-42`):

- role: costume + role name · «Цей проєкт»/«Усі проєкти»;
- swarm: costume + `roleMemory.swarm`;
- project: `roleMemory.projectSection`;
- machine: `roleMemory.machineSection`.

**Row second line.** The slice summary's headline when that slice has one.
While the profile reads or runs and the slice has no summary yet, show a
one-line grey placeholder bar (the existing `Placeholder`). Otherwise show no
second line. `memoryProfile.sliceEmpty` would repeat «not summarised» on every
row beside a summary block that already says so, so it is retired.

**Row count** is `scope.active.length`, and «0» for an empty project or machine.
The rows add up to the ⋯ menu row's total (`LearnedRulesRow`, `LearnedRules.tsx:491`).

**Before the rules answer arrives (cold profile).** The rows come from
`profile.slices` with a count above zero, plus project and machine. They are
disabled, as the level-card buttons are today (`MemoryProfile.tsx:122`).
Topic rows stay disabled until rules arrive (`:65`). The window-level line
`roleMemory.reading` keeps saying why.

## 4. Every current function and where it lives in variant 5

Line numbers are in the current `main` (22d316fb).

### Window shell

| # | Function today | Where today | Where in variant 5 |
|---|---|---|---|
| W1 | Open from the board's ⋯ row with the project's rule total | `LearnedRulesRow` `LearnedRules.tsx:486-514`, mounted `ProjectDashboard.tsx:2173` | Unchanged |
| W2 | Open from the phone ⋯ sheet's project rules | same, `ProjectDashboard.tsx:2063` | Unchanged |
| W3 | Open from a stage report's rule line on that rule | `StageLessonLine` `:71-88` → `openRulesWindow(project, ruleId)` `:103`; the page opens on «Усі правила» with that role chosen (`:384`, `:400-402`) | Selects the level that holds the rule, active or departed. The row is opened and scrolled into view (`RuleRow` focus, `:232-235`). On the phone the window opens straight on that level's screen. A rule found only among departed rules also opens «Вибули з правил» |
| W4 | Title and the line under it | `:445-446`; title switches between `memoryProfile.title` and `roleMemory.window.title`, the line between `memoryProfile.subtitle` and `roleMemory.startsWith(Swarm)` | One page, so the title is always `memoryProfile.title`. The line `data-rules-starts` is always `roleMemory.startsWith`, or `roleMemory.startsWithSwarm` when a swarm scope is present (as the prototype draws it) |
| W5 | Close: ×, Escape, a tap on the backdrop | `:388-392`, `:438`, `:448-449` | Kept. Escape and Tab move to the shared `useModalLayer` (`src/components/modalLayer.ts:86`) with `manageFocus: false`, so × keeps its `autoFocus`. That gives the dialog the Tab trap it lacks today: the board behind takes no keyboard focus |
| W6 | Reading line, read failure, save failure | `:451-453` | Unchanged and at the same place, between the header and the curator line. The right pane stays empty while there is no reading |
| W7 | Paused banner (kill switch / Settings «Пам’ять Delegatus») | `:455` | Unchanged |
| W8 | Curator line: last and next pass, paused/off; it opens to the passes, each with state, failure, counts, «N змінено пізніше» and «Скасувати прохід» | `:456-465` | Unchanged, on both phone screens |
| W9 | Tabs «Профіль» / «Усі правила» | `:466-468` | **Removed.** Both pages' content is on one view |

### Profile (today's «Профіль» tab, `MemoryProfile.tsx`)

| # | Function today | Where today | Where in variant 5 |
|---|---|---|---|
| P1 | Overall headline and prose; model · time · language | `:95-102` inside a bordered card `:94` | Top of the left column, without the card (prototype `Summary`). The meta line moves under the prose, as the prototype draws it |
| P2 | «Підсумувати» / «Оновити» / «Спробувати ще», solid when it is the next step and outlined when the profile is fresh. It is hidden while reading, with memory off or with no rules | `:97-99` | Same rules, to the right of the headline. It stays the window's one solid button |
| P3 | States: reading, summarising, «Підсумки з’являються…», error (account/size/other), stale with counts, no rules, no summary yet | `:89-105` | Same states and strings, in the summary block |
| P4 | «З чим стикалися агенти»: overall topics as cards with title, text and «Правила · N →», opening the topic's rules | `:61-71`, `:106` | Rows in the left column: title, text, count, and › on the phone. A row opens a **topic pane**: the topic's title once, its text, then one `RuleSection` per level holding its rules (heading = level label, rows filtered to the topic, no history). This replaces today's drill, which repeated the topic title over every level (`LearnedRules.tsx:469`) |
| P5 | «За рівнями»: one card per non-empty level with label, slice headline, slice prose, slice topic pills and «Правила · N →» | `:108-126` | Level rows (§3). The row carries the label, headline and count. The pane carries the slice prose as its subtitle |
| P6 | Slice topic pills, which open that topic's rules within the level | `:72`, `:117` | The same pills (`data-profile-pill`, unchanged markup) under the pane's subtitle. A pill opens the topic pane for that level. Kept because the 2026-10-11 profile design approved them and the specification keeps every function. The prototype frames do not draw them; see §9 |
| P7 | A drill's «← До профілю» | `:73-81` | Phone only: «← До профілю» heads every level and topic screen. On the desktop the list stays visible |
| P8 | Topic and level controls disabled until the rules answer | `:65`, `:122` | Kept (§3) |

### Rules (today's «Усі правила» tab and `RuleSection`)

| # | Function today | Where today | Where in variant 5 |
|---|---|---|---|
| R1 | Role chips with per-role counts (role + swarm) | `:422-435` | **Replaced** by the level rows, one per role scope. The chips' counts become the rows' counts |
| R2 | Role section: «Цей проєкт» and «Усі проєкти» groups, then the read-only swarm block | `RuleSection` `:346-357`, `:472` | Each is its own level. A swarm level is `RuleSection kind="swarm"`: no ×, the read-only line `roleMemory.swarmPublic` under its subtitle, and «Чому» replaced by the same line as today (`:252`) |
| R3 | Project and Machine sections with their fixed subtitles | `:473-474` | Levels «Проєкт» and «Машина». Their pane subtitle is the slice prose, or `roleMemory.projectSubtitle` / `roleMemory.machineSubtitle` while there is none. A role level without a summary has no subtitle, because its label already says which role and which projects |
| R4 | Count beside the heading; size against the bound from 80 % | `:339-340`, `:351` | Kept in the pane heading (`data-rules-count`, `data-rules-size`) |
| R5 | Rule row: kind dot, two-line clamp, tap to open «Чому» and provenance (kept by you, awaiting curator, rewritten by, author, fix round, merged from N, from N tasks), the «перевірте текст» hint, tooltip | `RuleRow` `:230-268` | Unchanged, except the × sits on the rule's first line (prototype `prototype.css` lines 173–174) and long words wrap (§5.6) |
| R6 | «Попередній текст · N»: each earlier text, its why, time and reviser, and «Повернути» (revert) | `EarlierTexts` `:270-281` | Unchanged |
| R7 | × removes at once; «Правило прибрано · Повернути» stands in the row's place for 8 s; a refused write brings the rule back with the save error | `:264-265`, `:303-312`, `:394-420`, `:199-213` | Unchanged within the level's pane |
| R8 | «Вибули з правил · N»: struck rows with reason and place, a link to the rule it merged into or contradicts, earlier texts, «Повернути» (restore) | `:283-298`, `:358-366` | Per level. The counterpart link selects the counterpart's level and focuses that rule, even when it lives in another level |
| R9 | «Правил ще немає.» once in an empty kind | `:347` | Once, in an empty level's pane |
| R10 | Focused rule highlighted and scrolled into view | `:232-244` | Unchanged |
| R11 | 15 s re-read; optimistic presses drawn over it; a refusal undoes only its own press | `useProjectRules` `:152-215` | Unchanged |
| R12 | The window as tall as its longest column, up to 689 px on the rules page and 820 px on the profile page | `:436-440` | One fixed desktop height, `min(820px, 90dvh)`, top unchanged, so choosing another level never moves the window's edges (prototype `Shell fixed`) |

Nothing else in the window has a function. The «Роль» heading, the role
subtitles and the «Цей проєкт»/«Усі проєкти» group labels inside a section
only labelled the old grouping.

## 5. Behaviour

### 5.1 Split and screens

The split follows the product's phone signal, `useIsMobile()`
(`src/hooks/useIsMobile.ts:35`): either axis under 640 × 600. That is the
signal the shell behind the window uses.

**Two panes when it answers false:**

- From 768 px up the left column is 380 px wide, as in the prototype.
- Between 640 and 767 px the window is full-screen and the left column is
  300 px, so the rules pane keeps at least 340 px.

**On a phone, one pane is mounted at a time.** The other pane is unmounted.
The Tab trap counts only what exists, and a pane the reader cannot see must
hold no control that can take focus.

### 5.2 Selection

The state is one of:

- a level, by scope key;
- a topic: its title, its text if any, and its rule ids, with the level it
  came from for a slice pill.

On the phone it also holds whether the rules screen is open.

**Initial state:**

- with a focus rule, its level, and on the phone the rules screen is open;
- otherwise the first level in order, with the phone on the list.

If the selected level leaves the list, the selection falls back to the first
level. A curator pass that moves a role scope's last rules into another scope
can cause that on the next re-read.

### 5.3 Desktop pane

The selected row has `aria-current="true"` and the accent background. A
topic row is selected the same way. Clicking a row changes the pane and leaves
focus on the row.

### 5.4 Phone screens

A tap on a row opens its screen:

- focus moves to «← До профілю»;
- the pane starts at its top, or at the focus rule.

«← До профілю» returns to the list:

- the list's scroll position is restored from a ref saved when the screen
  opened;
- focus goes back to the row that opened it.

Escape and × close the window from either screen, as today.

### 5.5 Scrolling

- **Desktop:** the left column and the right pane are one scroller each.
  Nothing inside them scrolls: `RuleSection`'s own `md:overflow-y-auto` goes.
- **Phone:** the open screen's pane is the one scroller under the fixed header
  and curator line.
- Both panes end in the prototype's 28 px fade (`prototype.css` line 176),
  over 28 px of bottom padding. The last row is therefore whole when scrolled
  to the end.
- The curator line's own pass list keeps its short internal scroller, which is
  part of the shell and unchanged.

### 5.6 Flat sections and long text

Move the prototype's `[data-s7-flat]` rules (`prototype.css` lines 166–174)
into `RuleSection`'s own classes:

- **Section:** no border, radius, card background or 3 px kind stripe.
- **Heading:** 14 px in the text colour.
- **Subtitle:** 12 px / 17 px in the secondary colour, 12 px top padding.
- **Body:** never scrolls.
- **×:** raised 5.5 px, or 9.5 px on a coarse pointer, so its centre meets the
  first line's centre.
- **Kept:** the row dot keeps its kind colour, and a focused row keeps its
  kind's soft background.
- **Removed:** `KIND_TONE.bar` and `KIND_TONE.text` lose their last readers.

Rule text, the why line, earlier texts, departed rows, level labels and topic
titles take `[overflow-wrap:anywhere]`. A path or address with no spaces then
wraps inside its pane and never pushes the pane sideways.

### 5.7 What moves where in code

- `RulesWindow` calls `useMemoryProfile`; today `MemoryProfile` calls it. The
  right pane needs the slice summaries, and the left column needs the same
  hook result, so the hook moves up one level with its revision string
  (`MemoryProfile.tsx:37-38`).
- `MemoryProfile` becomes the left column. It takes the hook result, the
  rules, the ordered levels, the selection and `onSelect`. Its `renderRules`
  and `onDrill` props go.
- A pure `profileLevels(rules, profile)` in `MemoryProfile.tsx` returns the
  ordered level descriptors: scope, kind, role, count, departed count and
  summary. It implements §3 and is unit-testable without a DOM.

### 5.8 Kept attributes and new hooks for the drivers

Kept: `data-rules-window`, `data-rules-starts`, `data-memory-profile` (now the
left column scroller, `aria-busy` as today), `data-profile-ready`,
`data-profile-summarize`, `data-profile-stale`, `data-profile-pill`,
`data-rules-section`, `data-rules-history`, `data-rules-count`,
`data-rules-size`, `data-learned-rule*`, `data-rule-versions`,
`data-rule-revert`, `data-left-rule*`, `data-rules-undo*` and
`data-curation-*`.

New:

- `data-profile-level="<scope>"` on each level row;
- `data-profile-topic="<n>"` on each overall topic row;
- `data-level-pane="<scope>"` or `data-level-pane="topic"` on the right pane
  scroller;
- `data-level-back` on «← До профілю».

Removed: `data-profile-slice`, `data-rules-role`, `data-rules-every-project`
and `data-rules-swarm`.

### 5.9 Strings

No new string is needed. The prototype's words are all existing keys:
`memoryProfile.title`, `roleMemory.startsWith(Swarm)`, `memoryProfile.byLevel`,
`memoryProfile.encountered`, `memoryProfile.back`,
`memoryProfile.thisProject`/`everyProject`, `roleMemory.empty` and
`roleMemory.history`.

After the change, delete from `en.ts` and `uk.ts` together every key left
without a reader. Expect `memoryProfile.navigation`, `memoryProfile.allRules`,
`memoryProfile.subtitle`, `memoryProfile.topicRules`,
`memoryProfile.sliceEmpty`, `roleMemory.window.title`,
`roleMemory.roleSection`, `roleMemory.roleSubtitle`,
`roleMemory.roleSubtitle.chosen`, `roleMemory.thisProject` and
`roleMemory.everyProject`.

Confirm each with
`rg -F '"<key>"' src landing --glob '!src/lib/i18n/*'` before deleting. Keep
`memoryProfile.profile`, which the summary heading still uses (`MemoryProfile.tsx:101`).

## 6. States to render

Every state is rendered through the existing drivers (§8.2, §8.3) on the real
`RulesWindow`. The full matrix is:

- widths 1440 × 900, 1000 × 700 (between the two named widths) and 390 × 844;
- `en` and `uk`;
- light and dark.

The 768 × 800 two-pane boundary and the 640 × 800 narrowest two-pane width are
rendered for the states marked *edge*, in `uk` light and `en` dark.

Each frame is kept under `$LLV_EVIDENCE_DIR` and opened and inspected at
native size before review.

**Fixture.** Extend `richMemory()` (`kanbanBoard.browser.test.tsx:3933`) with
a profile from `createProfileService` whose slices have summaries and slice
topics. Each state names its defining element, which must be visible text on
the first screen.

| State | Data | Defining element on the first screen | Desktop | Phone |
|---|---|---|---|---|
| `default` *edge* | richMemory + summaries | Summary headline; first level row selected; its pane heading with count | Both panes at rest | The list screen: summary, «За рівнями» rows with ›, topics |
| `level` | same | «← До профілю» and the level heading | Equals `default` | Level screen of «Білдер · Цей проєкт» |
| `earlier` | a rule with two earlier texts, one by the curator and one by another role | «Попередній текст · 2» open: earlier text, time, reviser costume, «Повернути» | Pane scrolled so the opened rule starts whole under the pane top | Same, on the level screen |
| `archived` | a level whose departed rules cover `deleted`, `merged` (with counterpart), `task-specific` and `budget` | «Вибули з правил · 4» open: struck rows, reasons, the counterpart link, «Повернути» | Pane scrolled to the history | Same |
| `empty-level` | `machine` with no active and no departed rules; the project level holding only departed rules | «Машина» row with 0; pane says «Правил ще немає.» once | Machine selected | Machine screen |
| `long` *edge* | one rule of about 600 characters, one with a 120-character path without spaces, and a long slice headline | Closed: two-line clamp with ellipsis. Open: the whole text inside the pane | Both | Both |
| `many` | 40 rules in one level, and 10 roles with both scopes (22 level rows) | Both scrollers at rest, then scrolled to the middle and the end; no row sliced at a scroller top; last row whole at the end | Both panes | List and level screens |
| `topic` | an overall topic spanning two levels | Topic title once, its text, two level sections | Selected in the left list | Topic screen |
| `focus` | opened from a card's rule line (W3), including a rule only among departed rules | The focused row open and highlighted; history open for the departed one | Both, through the phone driver's rule-line case | Both |
| Profile states | reading; no summary yet; summarising; error (account); stale; no rules at all; memory paused (both causes); cold profile with rules held | The summary block's own heading or alert; rows disabled while rules are held | At 1440 and 390, all four language × theme pairs | — |
| Remove / undo | × on a rule | «Правило прибрано · Повернути» in the row's place, inside the pane, over no rule | Both | Both |

## 7. Files to change

| File | Change |
|---|---|
| `src/components/roleMemory/LearnedRules.tsx` | `RulesWindow`: <br>• drop `page`, `chosenRole`, `drilled`, the picker, the tab `nav` and the three-column grid; <br>• add the selection of §5.2, `useIsMobile`, `useModalLayer`, `useMemoryProfile` and `profileLevels`; <br>• render the left column and the right pane (or one of them on a phone); <br>• fixed desktop height; title and line per W4. <br><br>`RuleSection`: <br>• drop the `additionalScope`, `swarm` and `picker` props; <br>• add a `below` slot under the subtitle for the slice pills; <br>• flat drawing and no inner scroller (§5.6); <br>• open «Вибули з правил» initially when the focus rule is among the departed rules; <br>• swarm read-only line for `kind="swarm"`. <br><br>`KIND_TONE` keeps `dot` and `soft` only. `StageLessonLine`, `LearnedRulesRow`, `useProjectRules` and `predictedRules` are unchanged |
| `src/components/roleMemory/MemoryProfile.tsx` | Becomes the left column: summary block (all P3 states, no card), level rows, topic rows. Add `profileLevels()`. Remove the level cards, the drill, `renderRules`, `onDrill`, `TONE` and the `sliceEmpty` line |
| `src/components/roleMemory/useMemoryProfile.ts` | Unchanged; called from `RulesWindow` |
| `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` | Delete the keys that lost their readers (§5.9), both files in one commit |
| `src/components/roleMemory/MemoryProfile.dom.test.tsx`, `LearnedRules.render.test.tsx`, `LearnedRules.polling.dom.test.tsx` | Rewritten and extended (§8.1) |
| `src/components/kanban/kanbanBoard.browser.test.tsx` | Update the blocks `swarm release rules` (`:3596`), `memory profile` (`:3693`), `memory profile window: one top, …` (`:3838`) and `memory profile window: opening under slow data` (`:3947`). Add the S7 states case (§8.2). Frames go to an output directory read from `MEMORY_PROFILE_OUT`, defaulting to the current `.artifacts/…` paths |
| `src/components/mobile/issue1671Evidence.browser.test.tsx` | Update `role memory curation: reversible window` (`:10134`) and `role memory: rules window and the rule line` (`:10259`) (§8.3) |
| `src/components/kanban/issue1695Evidence.fixture.tsx` | No change: scenario `memory-profile` already mounts the real `RulesWindow` and `LearnedRulesRow` (`:5784`) |
| `landing/site/demo/demo.tsx` | `openRules(role, expand)` (`:829-845`) presses the «Усі правила» tab and a role chip, both of which disappear; `press` then rejects with «Demo view did not become ready» (`:536-544`). Change it to press `[data-profile-level="role:<project>:<role>"]`; on the phone that opens the level screen. The `curator` views (`:898-903`, `:948-953`) select the project level before opening its history |
| `landing/site/README.md` (line 321), `docs/design/landing-refresh-autonomy-memory.md` §4.1–4.2 | Describe the new path to the two landing views: the board's ⋯, «Learned rules», then the level row |
| `docs/design/memory-profile.md` §Scope and presentation, `docs/design/role-memory.md` §3 item 6, `docs/design/role-memory-curation.md` §3.8 | One dated line each: superseded on 2026-11-20 by this layout, with a link to this brief. The earlier text stays as history |
| `evidence/role-memory-curation/geometry.json`, `evidence/role-memory-mvp/geometry.json`, `evidence/swarm-rules/rendered.json` | Regenerated by the updated blocks. Commit the new readings after reading them for absolute paths and identities |

No server, store, API or type changes. `RoleMemoryProjectView` and
`MemoryProfileView` already carry everything the variant draws.

## 8. Test cases

All runs are by explicit path through `scripts/gate-slot.sh`, each with its
own fresh HOME, XDG_CONFIG_HOME, TMPDIR and `LLV_STATE_DIR` under the system
temp root. `LLV_VIEWER_CONTROL_URL` points at a closed port. Browser runs get
`CHROME_BIN` and a short Chrome TMPDIR. Do not sweep a directory.

### 8.1 DOM and render tests (happy-dom)

`src/components/roleMemory/MemoryProfile.dom.test.tsx`:

1. `profileLevels`:
   - a role scope with departed rules only is listed;
   - a role scope with neither is not;
   - project and machine are listed with 0;
   - a swarm scope with rules is listed after the role levels;
   - order is this project → every project per role, then swarm, project and
     machine;
   - counts add up to the scopes' active total.
2. Running with no overall: the summary says `runningTitle`; each level row
   names its level once and shows one placeholder bar.
3. Ready: each row shows its slice headline. Clicking a row calls `onSelect`
   with its scope. A topic row calls `onSelect` with the topic's ids.
4. Kept as they are, adapted to the new props:
   - the model name is shown and the model id is not;
   - while the first profile read is pending there is no Summarize and one
     GET;
   - a refused read shows the alert, offers retry and sends no POST;
   - a failed read with pending rules invents no empty memory.

`src/components/roleMemory/LearnedRules.render.test.tsx`:

5. Kept: size hidden far from the bound and shown near it; one empty line or
   one count; earlier text with «Повернути» and both reviser costumes;
   recurring tasks in both languages; the predicted reading; overlapping
   deletes; the delete refusal; the paused banners.
6. Swarm level: `RuleSection kind="swarm"` draws the read-only line and its
   rules with no × and no revert.
7. The orchestrator and maintainer test becomes «each role level opens its
   rules in both languages». It presses `data-profile-level` for each role
   and finds that role's rule in the pane.
8. **Desktop window, `matchMedia` stubbed false:**
   - it opens with the first level selected and only that scope's rule ids in
     `[data-level-pane]`;
   - pressing «Проєкт» swaps the pane;
   - the old tab `nav` and role chips are absent.
9. **Phone window, `matchMedia` stubbed true:**
   - it opens on the list with no pane mounted;
   - a row tap mounts the pane with `data-level-back` focused;
   - back unmounts the pane, restores the list and focuses the same row.
10. Focus rule:
    - an active one selects its level and opens its row;
    - one only among departed rules selects its level and opens «Вибули з
      правил»;
    - on the phone the window opens on that level's screen.
11. The counterpart link in history selects the counterpart's level and
    focuses it.
12. Topic:
    - an overall topic row shows its title exactly once in the pane, then one
      section per level with only the topic's rules;
    - a slice pill does the same for its level.
13. Modal: with focus on the last control, Tab moves focus to the first
    control inside the window, and Escape closes it once.

`src/components/roleMemory/LearnedRules.polling.dom.test.tsx`:

14. «A rules read slower than a poll interval still opens the profile and
    rules tabs» becomes «… still draws the selected level». The rule appears
    in the pane with no tab press.
15. Cold profile: level rows and topics are disabled before the rules answer
    and enabled after. The topic then opens its rules. No POST.

Run each file alone:

```
bash scripts/gate-slot.sh bun test src/components/roleMemory/MemoryProfile.dom.test.tsx
```

Unchanged files that must still pass: `useMemoryProfile.test.ts`,
`useMemoryProfile.locale.dom.test.tsx`, `src/lib/i18n/i18n.test.ts`.

### 8.2 Kanban board driver (`LLV_KANBAN_BROWSER_TEST=1`)

The new describe block is «memory profile window: levels on the left, rules
on the right». It renders §6 through `?scenario=memory-profile&rolememory=1`
(and `&via=row` for W1).

Every frame runs the prototype's `MEASURE` against the real window, ported
from `c521b9fc:src/components/kanban/kanbanBoard.browser.test.tsx` lines
46662–46730. It fails on:

- **Text cut sideways:** any text range cut by a clipping ancestor or the
  viewport, unless it is an intended ellipsis or line clamp.
- **Top slice:** a row sliced by the top of a scroller, after scrolling to a
  rule or to the middle.
- **× position:** an × whose centre is more than 2 px from its rule's first
  line.
- **Repeats:** two rule rows with the same text.
- **Overflow and title:** the page scrolling sideways, or the window title not
  whole on the first screen.
- **Nested scroller:** any element inside `[data-memory-profile]` or
  `[data-level-pane]` with `overflow` auto or scroll and
  `scrollHeight > clientHeight + 1`, other than the pane itself.
- **Pane contents:** the selected row without `aria-current`, or a pane
  showing a rule id outside its scope or topic.
- **Counts:** a row count different from its pane heading count or from
  `scope.active.length`, or row counts that do not sum to the ⋯ row's total.
- **Desktop stability:** window top, height or header height differing
  between any state or level choice.
- **Phone rows:** a level or topic row without its ›.
- **Phone back link:** «← До профілю» text starting more than 1 px from the
  pane heading's text.
- **Touch targets:** a row on a coarse pointer under 44 px tall.
- **Modal:** after 30 Tab presses, `document.activeElement` outside the
  window.

The existing blocks lose their tab presses and keep their purpose:

- **`memory profile`:** clicks a level row where it clicked
  `[data-profile-slice] button`. Its five-state loop adds 1440.
- **`one top, whole rows, …`:**
  - the "rules page top equals profile top" check becomes "top and height
    hold across level choices";
  - the per-card sliced-row check runs on the pane;
  - the order check reads `data-profile-level`.
- **`opening under slow data`:** waits for the pane where it pressed «Усі
  правила» and «Профіль».
- **`swarm release rules`:** selects the swarm level and asserts no ×, the
  read-only line, and that the swarm row follows that role's other rows.

Command:

```
LLV_KANBAN_BROWSER_TEST=1 MEMORY_PROFILE_OUT=$LLV_EVIDENCE_DIR/s7 \
  bash scripts/gate-slot.sh bun test src/components/kanban/kanbanBoard.browser.test.tsx \
  -t "memory profile|swarm release rules"
```

### 8.3 Phone driver (`LLV_SWIPE_BROWSER_TEST=1`)

`role memory curation: reversible window`:

- open the builder's this-project level for the candidate rule, and the
  every-project level for the rule the curator moved there (`ids[0]`);
- the history, version and pass-undo steps stay;
- the "no card scrolls inside itself" check becomes "nothing inside the pane
  scrolls".

`role memory: rules window and the rule line`:

- the line opens the window on the focused rule's level;
- "three kinds, each its own section" becomes "the level list holds role,
  project and machine rows, and the focused level's pane is shown";
- the chip steps become level-row steps for orchestrator and maintainer;
- the "as tall as its longest column" check (`:10372-10376`) becomes the
  fixed-height check;
- remove and undo stay in the pane.

Command:

```
LLV_SWIPE_BROWSER_TEST=1 bash scripts/gate-slot.sh bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "role memory"
```

### 8.4 Landing demo

Build the landing site and render the learned-rules section's two tabs:

```
bash scripts/gate-slot.sh bun landing/site/build.ts
bash scripts/gate-slot.sh bun landing/site/capture.ts --only=en-1440
bash scripts/gate-slot.sh bun landing/site/capture.ts --only=uk-390
```

`report.json` must list no page error and no unanswered request for the
`mem` frames. Open the `rules` and `curator` frames and check that they show
the orchestrator level with O1 open and the project level's history.

### 8.5 Publication

The pre-push hook runs types, changed-file lint and touched tests. The hosted
required checks run after it. The visual critic reads the §6 frames.

## 9. Decisions taken here, and why

1. **Slice topic pills stay, under the level's subtitle.** The frames do not
   draw them. They are a function of the 2026-10-11 profile design
   (`memory-profile.md`: «Topics open the active rules behind them»), the
   specification keeps every function, and removing an operator-chosen
   control needs the operator's word. They reuse the existing pill. The
   visual critic should judge them like any other element.
2. **Swarm is a level of its own, after the role levels.** This is how
   today's profile already orders it (`MemoryProfile.tsx:51`). Today's «Усі
   правила» page draws it inside the role section, a grouping that variant 5
   replaces with one level per scope.
3. **Project and machine rows are always listed.** An empty one shows 0. A
   role scope holding only departed rules stays listed, so its restore stays
   reachable.
4. **The split follows `useIsMobile()`, and the hidden pane is unmounted.**
   This avoids a second width rule and keeps the Tab trap honest.
5. **`useModalLayer` replaces the window's own Escape listener.** It is the
   product's existing primitive. It adds the missing Tab trap that the
   rendered-work rules require of a modal.
6. **The topic pane names the topic once.** Each level section is then
   headed by the level's own label, so the topic title does not repeat over
   every level, as it does today.

None of these changes what the operator chose. If the visual critic or the
operator rejects 1 or 3, removing the pills or the empty rows is a deletion
with no other effect.

## 10. Acceptance

- [ ] On desktop the window shows the summary, «За рівнями» and «З чим
      стикалися агенти» on the left and the selected level's rules on the
      right. Each side is one scroller with nothing scrolling inside it, and
      no card, stripe or tab appears.
- [ ] On the phone the list is the first screen. A row opens its level behind
      «← До профілю». Back restores the list's place and focus.
- [ ] Every function in §4 is reachable and exercised by a test in §8:
      W1–W8, P1–P8 and R2–R12. W9 and R1 are replaced by the level rows.
- [ ] Levels come from the data (§3), including swarm, roles with only
      departed rules, and empty project or machine.
- [ ] All §6 states are rendered at every width, language and theme it
      names, inspected at native size, and pass the §8.2 gates.
- [ ] The landing `rules` and `curator` views render with no page error.
- [ ] Dead i18n keys are removed from both locales and no reader remains.
- [ ] The pre-push hook and the hosted required checks pass.

## Deferred — not currently justified

- **The «перевірте текст» hint as a dot with a popover.** It is a short
  warning that names its own action, and the run-status rule does not cover
  it. The approved frames do not show it. Moving it would put a second
  control inside the row's toggle button.
- **The stale notice as a dot.** The frames do not show the stale state. The
  notice is a sentence with counts inside the summary block, and no rule in
  the specification asks to shrink it.
- **Keyboard shortcuts between levels** (arrow keys in the level list). No
  request asks for them.
- **A browser-history entry for the phone's level screen.** Today's drill has
  none, and the window's × and Escape already leave it.
- **The prototype's own driver block and fixture**
  (`docs/design/redesign-2026-11/prototype/`, the «redesign 2026-11» describe
  block). They render invented data for the choice and stay on the prototype
  branch. The build ports their geometry gates into the real window's blocks.
- **Audit item 9's agent correspondence table.** The S7 decision covers the
  memory profile and its rules only.
