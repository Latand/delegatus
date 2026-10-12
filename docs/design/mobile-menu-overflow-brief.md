# Phone «…» menus and horizontal scroll: brief

## The requirement

The operator wrote this in Ukrainian on 2026-10-12 at about 05:20, in the
orchestrator seat's conversation:

> також на моб телефоні коли відкриваю якусь менюшку  ( на кнопці "...")то
> з'являється горизонтальний скрол

In English: "also on the phone, when I open some menu (on the "..." button), a
horizontal scroll appears". The same message also covered the desktop header and
the landing page. This brief covers only the phone menus.

Pinned acceptance, in short: at 390×844 and 360×740, no «…» menu ever makes the
page or its container scroll sideways. The menu stays inside the viewport, long
Ukrainian labels wrap or truncate, the fix goes in once at the shared component,
desktop menus stay the same, and the evidence is a case in
`src/components/mobile/issue1671Evidence.browser.test.tsx`.

**The device.** The operator's own phone screenshots in the seat conversation
(2026-10-10) show an iPhone running Microsoft Edge: the iOS status bar, plus
Edge's Copilot mark and bottom toolbar. Edge on iOS uses WebKit, so the engine
is WebKit and not Chromium.

## Verdict in one paragraph

Every «…» on the phone opens the same component, the bottom sheet
`MobileSheet`. None of them is an anchored popover, a fixed-width dropdown or a
menu placed from its button's position. I measured all of them, plus every
safe row that opens another sheet or dialog from them. The matrix covered two
engines (Chromium and WebKit), both widths, both languages, three pixel
densities, enlarged text, the longest real strings that can land in a
non-shrinking slot, and every animation frame of opening and closing. None of
it made the page or the sheet scroll sideways. **So the exact cause is not
confirmed.** The operator's answer to one question, at the end of this brief,
decides whether the change below fixes the actual cause or only guards against
it. The change itself is ready: one class on the shared sheet body, one
wrapping row, and one driver case that would catch any sheet that overflows.

**Decided on 2026-10-12 (the orchestrator, settling the brief's question):**
option A. Build the change below now. The operator has been asked for the
screen, the ⋯ and a recording from the iPhone; if one arrives during the build
and shows another cause, it is forwarded to the lane. The five causes that only
WebKit on iOS could show were checked against the code afterwards
(see "WebKit-only causes" below): none is confirmed, and none needs a change
beyond the one below.

## Every «…» menu on the phone

All of them render through `MobileSheet` (`src/components/mobile/MobileSheet.tsx:48`).
"Bar ⋯" is the shell's one ⋯ button (`src/components/mobile/MobileShell.tsx:348-358`,
`data-mobile2-open="menu"`), which every phone screen draws. It calls
`nav.openSheet("menu")`, and the screen's own `renderSheet` decides what that sheet
holds.

| # | Menu | Trigger | Sheet it opens |
|---|---|---|---|
| 1 | Board menu (project board) | bar ⋯ on the board, the pipelines list, accounts and reports screens | `HeaderMenuSheet` (`src/components/headerMenu/HeaderMenu.tsx:246`, `PhoneMenu` from `:265`), which lays out through `MobileMenuSheet` (`src/components/mobile/MobileMenuSheet.tsx:40-62`). Its entries are built in `src/components/ProjectDashboard.tsx:2090-2180` and mounted at `:2268`. |
| 1a | Board menu pages: Settings, Memory, Key, Help, Project rules | rows inside 1 | `HeaderMenu.tsx:333-338`. Project rules embeds desktop rows in their `sheet` variant (`MergeOnReviewRow`, `ShareProjectRow`, `BridgeReportsRow`, `LearnedRulesRow`, `AsksYouRow`, `ProjectDashboard.tsx:2137-2146`). Settings embeds `SoundToggle` and `KeepAwakeMenuRow` (`HeaderMenu.tsx:293-308`). |
| 2 | Overview menu (all projects) | bar ⋯ on the overview | `HeaderMenuSheet` again (`src/components/OverviewBoard.tsx:261-268`) |
| 3 | Conversation menu: a plain agent, a pipeline stage's agent, the orchestrator seat's conversation | bar ⋯ on a conversation | `MobileConversationMenu` (`src/components/mobile/MobileConversationMenu.tsx:170`), mounted at `src/components/mobile/MobileFocusView.tsx:630`. Its sections open in place through `MobileSheetFold` (`MobileSheet.tsx:206`). |
| 4 | Task menu | bar ⋯ on a task screen | `src/components/mobile/MobileTaskScreen.tsx:1007`, with its Colour (`:945`) and Priority (`:971`) faces. The status pill's sheet is at `:813`. |
| 5 | A lane's menu on the task screen (the pipeline block's ⋯) | `data-pipeline-menu` in `src/components/pipelines/PipelineBlock.tsx:669-679` and `:1027-1031` | `MobileTaskScreen.tsx:758-761` and `:784-787` call `nav.openSheet("lane")`, which renders the sheet at `:857` |
| 6 | Pipeline screen menu, and a stage's sheet | bar ⋯ on the pipeline screen; a stage row's `data-stage-configure` (`PipelineBlock.tsx:932`) | `src/components/mobile/MobilePipelineScreen.tsx:465` (menu) and `:512` (stage, opened at `:561-564`) |
| 7 | Orchestrator seat sheet | the seat card's controls button (a sliders icon, not ⋯), `src/components/mobile/MobileSeatCard.tsx:597-608` | `MobileOrchestratorSheet` (`src/components/mobile/MobileOrchestratorSheet.tsx:314`) |
| 8 | A card's menu | a long press on a phone card (phone cards have no ⋯ button) | `CardSheet`, `src/components/mobile/MobileKanban.tsx:735-739`, mounted at `:1273` outside the column pager |
| 9 | A background shell task's ⋯ | `data-mobile2-task-menu`, `src/components/mobile/MobileChromeSheets.tsx:91-102`, inside the Background tasks sheet (`:68`) | Inline `role="menu"` rows inside that sheet (`:104-140`); not a popover |

Desktop ⋯ components that never render in the phone layout:
- `AgentControlStrip`: gated by `isMobile` at `src/components/BranchPane.tsx:527`; its ⋯ opens in place with `flex-wrap` in any case.
- `PipelineStrip`: scheme nodes only.
- `compactMenu.tsx` and `kanbanMenus.tsx`: the desktop kanban.
- `BarMoreMenu`: `src/components/ProjectBar.tsx:242`.
- `RailHeaderMenu`: `src/components/ProjectRail.tsx:482`.
- The team page's member ⋯: it opens a dialog.

## The shared component, and the one way it can scroll sideways

`MobileSheet` (`MobileSheet.tsx:116-160`) is built like this:

- **The scrim** (`:118-126`) is `fixed inset-0 flex flex-col justify-end`. A fixed box is laid out against the viewport. It does not count towards the document's scrollable width, and an ancestor's `overflow` does not clip it.
- **The dialog** (`:127-136`) is a flex item stretched across the scrim, so its width is the viewport's width. Its height is capped at `max-h-[88%]`.
- **The body** (`:151`) is `min-h-0 overflow-y-auto`. Per CSS, `overflow-y: auto` with `overflow-x: visible` computes `overflow-x` to `auto`. **The sheet body is therefore a scroller in both directions**: any descendant wider than the sheet makes the body (not the page) scroll sideways. On iOS that shows as a horizontal indicator while you swipe the menu, which matches "a horizontal scroll appears when I open a menu", because the body exists only while the menu is open.
- **Rows.** In `MobileSheetRow` (`:237-310`) the label truncates (`min-w-0 flex-1 truncate`, `:296`). The trailing slot is `shrink-0` (`:299-300`) unless `trailingShrinks` is set.

The page itself is protected twice:
- The production `<body>` is `h-dvh overflow-hidden` (`src/app/layout.tsx:37`).
- `useModalLayer` sets `body.style.overflow = "hidden"` while a sheet is open (`src/components/modalLayer.ts:93-98`).

Fields are already 16 px on touch screens (`src/app/globals.css:55-61`), so iOS does not zoom the page when a field inside a sheet takes focus.

Content inside a sheet that does not shrink, and could push the body wider with real data:
- the trailing slot of `MobileSheetRow` (`MobileSheet.tsx:299-300`), which in the conversation menu holds whole clauses (`MobileConversationMenu.tsx:258`, `:297`, `:418`) and in the board menu holds a badge plus a count (`ProjectDashboard.tsx:2125-2130`);
- the state phrase in the conversation menu's identity row. It is `shrink-0` (`MobileConversationMenu.tsx:175-181`) and by design never truncates (`src/components/mobile/mobileChatState.ts:173-176`; the mobile-v2 design, §3.2). The limit state puts the account name in it (`mobileChatState.ts:190-198`);
- the seat sheet's status lines: `shrink-0` spans at `MobileOrchestratorSheet.tsx:1208`, `:1217`, `:1223` and `:1255`;
- the desktop rows embedded in the board menu's pages (1a above).

## What I measured

**Setup.** I made a `git archive` export of `a8e005428` under the stage's scratch
directory and served the phone fixture (`issue1671Evidence.fixture.tsx`) through
the shared harness (`serveEvidenceFixture`). Contexts used `hasTouch` and
`isMobile`.

**Readings.** For each opened menu I recorded:
- `documentElement.scrollWidth` against `clientWidth`;
- `scrollX` after `window.scrollTo(200, 0)`;
- every element whose `overflow-x` is `auto` or `scroll` and whose `scrollWidth` exceeds its `clientWidth`, with a zero threshold;
- every non-fixed element past the right edge that no ancestor clips;
- all of the above sampled on every animation frame for 1.2 s while the menu opens, and again while it closes.

**The deployed build matches.** Production runs `0ef6ec497`. Between that commit
and `a8e005428`, nothing in `src/components/mobile`, `modalLayer.ts`,
`globals.css`, `layout.tsx` or `PipelineBlock.tsx` changed; only the driver file
did. So the code I measured is the code on the operator's phone.

| Run | Surfaces | Result |
|---|---|---|
| Chromium, DPR 1 | menus 1, 1a (all five pages), 4, 5, 6 (menu and stage), 7, 8, 9, plus the task status sheet, in en and uk at 390×844 and 360×740 | page 390 / 360 in every frame, no scroller, `scrollX` 0 |
| Chromium, DPR 2.625 and 3 | same, with a zero threshold | none |
| Every safe row reached from a menu, uk at 360 | menu 3 on a plain conversation (pinned, background, pipeline, needs-you, host details, attach terminal dialog, project), menu 3 on a stage conversation, menu 1 (tasks, pipelines, hidden, both board faces, accounts, host, settings, help, rules) | none |
| Longest real strings forced into the `shrink-0` trailing slot, en and uk at 390 and 360 | the compact refusals, the kill hints, the subagent states, "round replaced" | widest is 259 px (uk, "Delegatus не має каналу стиснення до цього хоста"). The label shrinks to 10 px, but nothing overflows. |
| The conversation menu's state phrase with accounts of 4, 11 and 17 characters (accounts on this machine run from 6 to 17), held × 12, offline | — | widest is 223 px, nothing overflows |
| WebKit 26.5 (Playwright WebKit with `isMobile`), uk at 390 | 14 menus and pages | none |
| Text enlarged ×1.15, ×1.3 and ×1.5 to imitate a larger iOS or Edge text size, uk at 390 | all menus | sheets: none. At ×1.3 the board's stage chips pass the edge, but they are clipped and the page stays 390. |
| Sub-pixel overflow, which an integer `scrollWidth` cannot show: Chromium at DPR 3, 2.625 and 2, 390 and 360, en and uk. For each sheet body: the largest fractional right edge of any unclipped descendant past the body's content edge, and `scrollLeft` read back after `body.scrollLeft = 50` | menus 1 and 3 (plain conversation and orchestrator seat), and the menu on a conversation with background tasks, at rest and with each fold opened in turn: 156 readings | no descendant past the edge by any fraction, and `scrollLeft` reads back 0 in every reading |

Also ruled out:
- **The shell's push slide.** The shell's push animation (`starting:translate-x-6`, `MobileShell.tsx:179-182`, `:283`) makes the shell the containing block of a fixed sheet for 200 ms. It runs on a screen push, not when a sheet opens, and the shell clips it (`overflow-hidden overflow-x-clip`).
- **Tooltips.** They are fixed and clamped to the viewport (`src/components/TooltipBubble.tsx:22-31`, `:86`).

## Cause: not confirmed

Ranked candidates:

1. **The sheet body scrolls sideways because one line in it does not shrink, with
   data the fixture lacks.** This fits the wording best: the scroller is the
   menu's own body, and it exists only while the menu is open. Nothing I could
   construct triggers it, including the longest strings the code can put into the
   `shrink-0` slots.
2. **A WebKit-on-iOS behaviour that headless WebKit does not model.** One example
   is a page left zoomed by a pinch, which can then be panned sideways. If that is
   it, the scroll does not depend on the menu, and the change below would not
   fix it.
3. **A surface outside the menus that only the operator's data reaches.**

### WebKit-only causes, checked in the code

Headless Chromium and Linux WebKit cannot show these, so each was checked
against the code instead. Nothing below needs a change of its own.

| Cause | What the code does | Verdict |
|---|---|---|
| **Safe-area insets** add width | The sheet pads only `env(safe-area-inset-top)` (full sheets) and `env(safe-area-inset-bottom)` (`MobileSheet.tsx:134-135`). No sheet or row pads a left or right inset. The dialog is a stretched flex item, so its width is the scrim's, whatever its padding. Left and right insets are 0 on an iPhone held upright. | Ruled out |
| **`100vw` against the visual viewport** | No component under `src/components/mobile`, `headerMenu`, or the board rows embedded in menu 1a sizes anything with `100vw`. Sheet widths come from `fixed inset-0` and stretch. On iOS, `100vw` is the layout viewport's width and has no scrollbar gutter in any case. | Ruled out |
| **Momentum scroll on the `fixed inset-0` scrim** | The scrim is not a scroller. A swipe on it chains to the viewport. The sheet body scrolls only when its content overflows (the probes above read zero sideways overflow). | Ruled out |
| **The page behind the sheet scrolls sideways** | `<html>` is `h-full` with `overflow: visible`, so `<body>`'s `overflow-hidden` (`layout.tsx:37`) is propagated to the viewport, and iOS 16 and later do not let a finger scroll a viewport whose overflow is hidden. The document also measured `scrollWidth === clientWidth` with every menu open. | Ruled out for the document |
| **A wide element under the sheet becomes scrollable once the sheet locks body scroll** | `useModalLayer` writes `body.style.overflow = "hidden"` (`modalLayer.ts:93-98`), and the body's class already says `overflow-hidden`. Opening a sheet therefore changes nothing about how the page scrolls, and closing it restores the empty inline value. The page's own sideways scrollers (the board's column pager, `MobileKanban.tsx:1221`) sit under the scrim, and a touch hits the scrim first. | Ruled out |
| **Focus zoom from a field under 16 px** (checked in addition) | `globals.css:55-61` forces 16 px on every `input`, `textarea` and `select` under `(pointer: coarse)` with `!important`, so the `text-[…]` utilities cannot win. No sheet focuses a field when it opens: `useModalLayer` focuses the dialog itself, and nothing in the menus uses `autoFocus` or `contentEditable`. | Ruled out |
| **A page left zoomed** (pinch, or a zoom iOS kept after a field took focus) | The viewport is `width=device-width, initial-scale=1` (`layout.tsx:15-20`), with no `maximum-scale`, and iOS ignores `user-scalable=no` anyway. A zoomed page pans sideways on any screen, with or without a menu open. | Possible, and outside the code. This is candidate 2; only the recording can confirm it. |

## The change (one place, phone only)

Each item states what to change, where, and what counts as accepted.

1. **The shared guard.**
   - **Where:** the sheet body, `MobileSheet.tsx:151`.
   - **Change:** add `overflow-x-hidden` next to `overflow-y-auto`. A sheet's body then scrolls only vertically, whatever a row holds, and every one of the menus above inherits it at once.
   - **Kept working:** horizontal scrollers inside a sheet, such as the prototype review's variant chips on the phone, keep their own `overflow-x-auto` and still scroll.
   - **Acceptance:** with the driver case below, every sheet body reads `scrollWidth === clientWidth` in every frame.
2. **Hiding must never cut text, so the line that cannot shrink wraps instead.**
   - **Where:** the conversation menu's identity row, `MobileConversationMenu.tsx:175`.
   - **Change:** let it wrap (`flex-wrap`, keeping the meter at the end of its line), so a long state phrase takes a second line whole. This keeps the "never truncates" rule in `mobileChatState.ts:175`.
   - **Acceptance:** at 360 in uk with the limit phrase for a 17-character account, the phrase's whole text sits inside the sheet; measure a Range over its text against the sheet box.
3. **A geometry check that does not trust the guard.** `overflow-x: hidden` would hide a future overflow from a `scrollWidth` test. The case therefore also scans every descendant of `[data-mobile2-sheet]` and fails when a box's right edge is past the sheet's right edge by more than 0.5 px, excluding descendants of an element that is itself a horizontal scroller. Before the guard, this is the check that would name the offending line.

Nothing else changes. No popover machinery, no portal (the scrim is already
fixed, and nothing clips it), and no change to `MobileSheetRow`'s trailing rules
(they measured fine, and #1681's opt-in `trailingShrinks` stays as it is).

### Evidence: one new case in the existing phone driver

Add a `describe` block to `src/components/mobile/issue1671Evidence.browser.test.tsx`,
gated by `LLV_SWIPE_BROWSER_TEST=1`. Do not add a new driver. Write the readings
to `evidence/phone-menu-overflow/readings.json`; the name describes the topic and
carries no issue number.

**Viewports, languages and themes:** 390×844 and 360×740, `en` and `uk`, light
and dark, with touch and `isMobile`.

**States to open, each read at rest and on every frame while it opens and closes:**

- menu 1 at rest, and each of its pages: Settings, Memory, Key, Help, Project rules;
- menu 2 (the overview);
- menu 3 on a plain conversation (`#c=conversation_running`), on a stage conversation (task screen › Open agent), and on the orchestrator seat's conversation, with each section opened in turn: Subagents, This turn, Conversation, Close or stop;
- menu 4 at rest, with its Colour and Priority faces, plus the status sheet;
- menu 5 (the lane ⋯ on `t-favicon`);
- menu 6 and its stage sheet (`#pipeline=lane-upload`, `data-stage-configure`);
- menu 7 (the seat sheet);
- menu 8 (a long press on a card in the visible column; drive it with CDP touch the way the column-pager case does);
- menu 9 (`?chrome=2`, the Background tasks sheet with one row's ⋯ open), and the Pinned sheet.

**Long-data states:**
- the fixture's walled conversation (`issue1671Evidence.fixture.tsx:842-844`) given a 17-character synthetic account name, so its menu shows the limit phrase;
- a conversation with compact refused for an unknown host and no context meter, so the trailing slot holds "Delegatus has no compact channel to this host";
- a held conversation with 12 queued messages.

**Assertions:**
- `documentElement.scrollWidth === clientWidth`;
- `scrollX` is 0 after `window.scrollTo(200, 0)`;
- `[data-mobile2-sheet-body]` reads `scrollWidth === clientWidth`;
- the descendant geometry check from item 3;
- no page errors.

**Frames:** one per menu at 390 in each language and theme, for the pull request.

## What must not change on desktop

`MobileSheet` renders only in the phone layout. The shell is mounted under
`useIsMobile`, and the prototype review picks the sheet only `if (phone)`
(`src/components/prototypeReview/PrototypeReview.tsx:892`). The change touches
two phone files:
- `MobileSheet.tsx`;
- `MobileConversationMenu.tsx`.

The desktop menus are not touched:
- `compactMenu.tsx` and its layout model;
- `kanbanMenus.tsx`;
- `ProjectBar.tsx` `BarMoreMenu`;
- `ProjectRail.tsx` `RailHeaderMenu`;
- `HeaderMenu.tsx`'s desktop menu;
- `AgentControlStrip`;
- `PipelineStrip`.

Their recorded measurements in `evidence/compact-card-menu/built.json` stay valid. A review checks that the diff touches no file outside the two above, the driver and the evidence JSON.

## Question for the operator (decided: A)

The orchestrator chose option A on 2026-10-12. The question below still stands
with the operator, and its answer is forwarded to the build lane if it arrives
in time.

**Which screen and which ⋯ was it? Please send a screenshot or a few seconds of
screen recording from the iPhone that shows the sideways scroll.** Everything I
could run on this machine is clean, and the answer decides whether the change
above fixes the cause (candidate 1) or only guards against it (candidate 2 or
3).

| Option | What happens | Trade-off |
|---|---|---|
| A (recommended) | Build the change above now: the guard, the wrapping identity row and the driver case. The operator checks on the phone after the next deploy; if the scroll is still there, the recording points at candidate 2 or 3. | Small and phone-only, and it closes candidate 1 for every sheet at once. It may not be the actual cause. |
| B | Wait for the recording, then build exactly what it shows. | The cause is known before anything is built, but nothing ships until the operator answers. Deploys are frozen by the incident in any case. |
| C | Close the task as not reproducible. | Leaves candidate 1 open on every sheet. |

## Deferred — not currently justified

- **Turning the sheets into anchored popovers that flip or shift (Floating UI or similar).** The phone has no anchored menu: every one is a full-width bottom sheet, which never needs to flip. The acceptance line about flipping has nothing to act on.
- **Portalling `MobileSheet` to `document.body`.** The scrim is `position: fixed` and escapes every clip that exists today. No clip was observed.
- **Truncating every `MobileSheetRow` trailing slot.** The longest real strings fit at 360 in uk. #1681's opt-in `trailingShrinks` already covers rows whose trailing text is a whole clause.
- **A WebKit run in the phone driver.** WebKit needs system libraries this machine and CI lack. Revisit only if the recording shows a WebKit-only cause.
- **Board stage chips under enlarged text.** At ×1.3 they pass the column edge but are clipped, and the page does not widen. They are not a menu, so they are outside this task.
- **`touch-pan-y` on the sheet body.** It would stop WebKit from starting any sideways pan inside a sheet, a zoomed page included. It would also stop a pinch that starts inside the sheet, and no WebKit cause is confirmed. Revisit only if the recording shows a zoomed page panning while a menu is open.
- **`overscroll-y-contain` on the sheet body.** It stops vertical scroll chaining to the page, which is unrelated to the sideways scroll the operator reported.

## Baseline

The brief was written against `a8e005428`. Before it was finished, `origin/main`
moved to `97aa4ac7c`. The two new commits touch three cited files:
- `globals.css`: one rule appended at the end of the file;
- `MobileConversationMenu.tsx`: a comment and the terminal row's label (now "Copy terminal command"), each a one-line replacement in place;
- the phone driver: a new case.

Every line anchor in this brief is unchanged. The lane adds its case to a
driver that main has just extended, so it starts from current main.
