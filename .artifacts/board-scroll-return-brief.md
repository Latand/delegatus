# Brief: a strip to scroll back up to the orchestrator, and a one-click return

Stage: architect (read-only), pipeline ee6dc7be. Written 2026-10-17 at 14:45Z against base `7367fd9f3`.
`origin/main` at `32e5a6e91` has moved since. Its changes touch none of the files or regions named
below; it only appends to `kanbanBoard.browser.test.tsx` near line 33335 and to `en.ts` near line 2977.

> This file is local (`.artifacts/` is gitignored). The operator's words below are for agents only.
> Do not copy them into a PR body, a commit message, a doc or any other published text.

## 1. Originating requirement

**Operator to the Delegatus orchestrator seat, 2026-10-17 13:26:50Z**, in Ukrainian. Verbatim
fragment (the rest of that message is about other topics):

> і дор ечі зарза коли я опускаюсь до задач - то я не можу нормально піднятися через блок скролу,
> але я і хочу щоб так було, але хюочу щоб була зона якась виділена щоб булоз розуміло що там можна
> скролити до оркестратора (тобто не задачі), і так смо коли в орк- кнопкою можна опуститися - але
> це вже є - це "згорнути оркестратор", але якщо наприкда просто хочу проскролити.. то треба швидке
> повернення.

Source: seat transcript `…/-home-latand--agents-tools-delegatus/75cdf38f-….jsonl`, record seq 5332353.
The operator's screenshot from that exchange shows the desktop board in uk and dark. The seat's
composer sits on top, the grip at its bottom edge, and the task columns below it.

**How the pinned spec renders it, and where it differs.** The spec adds "desktop and 390px". The
operator named no device, and the screenshot is desktop. At 390 px the board is the phone shell,
which has no page scroll (§3.4). So the phone gets no new UI. The builder proves that with a frame
and an assertion. This brief designs from the operator's words.

Read as: (a) keep the scroll lock; (b) show a highlighted zone that makes clear that scrolling there
goes to the orchestrator, not through the tasks; (c) going down from the orchestrator is already
covered by «Згорнути»; (d) after an ordinary scroll down into the tasks, give a quick way back.

## 2. Files (the import graph from the page down)

| File | Role here |
| --- | --- |
| `src/components/ProjectDashboard.tsx:2517` | Mounts `<KanbanSeat>` as the board's `seat` render prop. This is the only production mount. |
| `src/components/kanban/KanbanBoard.tsx:3001-3007` | `.kb-body > .kb-pane > .kb-page`. The page holds the seat (top placement, `{seatSide ? null : seatView}`) and then `.board-frame`. Side placement renders the seat in `.kb-body` instead. |
| `src/components/kanban/KanbanSeat.tsx:286-371` | Returns a fragment of `<a.skip-board>` and `<section.seat …>`. Collapse goes through `seat.toggle` (`onClose`). This is where the new strip goes (§5). |
| `src/components/orchestrator/OrchestratorPanel.tsx:654-668` | The fold button `[data-seat-collapse]`, `aria-keyshortcuts="O"`, with the labels `orchPanel.seatCollapse` / `seatExpand` and the words `seatFoldWord` («Згорнути») / `seatUnfoldWord`. |
| `src/components/kanban/kanbanSeatStore.ts:164-202` | `seatCollapsed`, `useKanbanSeat().toggle`. A window under `SEAT_SHORT_WINDOW = 800` px tall starts folded (`:40`). |
| `src/components/kanban/KanbanBoard.tsx:1922-1928` | The `O` key calls `seatToggleRef.current()`. |
| `src/components/ProjectBar.tsx:366-400` (`BarPanelToggles`) + `ProjectDashboard.tsx:2114-2118` | The bar's «Оркестратор» button. On the board it is `kanbanSeat.toggle`, so it collapses or expands the seat. |
| `src/components/kanban/kanbanBoard.css:552` `.kb-page`, `:921` `.board-frame`, `:1023-1140` `.seat*` | Page scroller, board height `max(440px, 100%)`, seat frame and head. |
| `src/components/kanban/kanbanBoard.css:339` and `:1064` | **The scroll lock**: `overscroll-behavior-y: contain` on `.col-body` and on the seat's `[data-log-feed-scroller]`. |
| `docs/design/independent-panel-scroll.md` | The lock's design (2026-10-14, #2847). |
| `src/components/mobile/MobileKanban.tsx:1250, 1288-1304` | Phone: the seat card is `shrink-0` above the tabs. Each column page is its own contained scroller. |
| Tests | `seatFold.dom.test.tsx` (renders `KanbanSeat` under happy-dom), `boardScrollers.test.ts` (CSS guard), `kanbanBoard.browser.test.tsx` `describe("independent panel scroll")` at `:32639-32924`, `issue1671Evidence.browser.test.tsx` phone case at `:3497-3584`. |
| Evidence | `evidence/panel-scroll/desktop.json`, `evidence/panel-scroll/phone.json`. |

## 3. Current behaviour, with evidence

**Probe conditions:** `git archive 7367fd9f3` into stage scratch. Fixture
`issue1695Evidence.fixture.tsx?scenario=agent-report` served by `serveEvidenceFixture`. Chrome for
Testing 156.0.8078.4, playwright-core 1.62.1, scrollbars drawn, light theme, `reducedMotion: reduce`.
Seat on top and expanded, rail open. Isolated HOME, `XDG_CONFIG_HOME`, `LLV_STATE_DIR` and TMPDIR,
control URL on a closed port, run through `gate-slot.sh`, 2026-10-17 at about 14:35Z. Wheel notch:
240 px.

### 3.1 The lock holds, and it traps the way back up

| Viewport | Page room (`.kb-page` max scrollTop) | Wheel up ×5 from a column head, page at its end: what was under the pointer → page scrollTop |
| --- | --- | --- |
| 1440×900 | 687 | column-head → 447, then conversation → 447, 447, 447, 447 |
| 1000×800 | 612 | column-head → 372, then conversation → 372 ×4 |
| 700×800 | 612 | column-head → 372, then conversation → 372 ×4 |

The first notch moves the page. That notch slides the seat's conversation under a pointer that has
not moved, and the contained feed then takes every later notch. The frame `base-stuck-1440x900`
shows the page stopped at 447: the conversation fills the top and the columns sit below it. This
is the complaint. The lock is working as designed, and the only places that move the page (the
page's own scrollbar, column heads, the seat head, the gaps; `desktop.json` "placed") scroll out
from under the pointer. None of them is marked.

A finger dragged 300 px down on a column head moves the page 687 → 245 (1440) and 612 → 176 (1000).
Touch hits the same wall one drag later.

### 3.2 No quick return exists

- The fold button lives inside the seat. With the page at its end, the seat's box is
  `[317, -627, 1040×675]` at 1440: entirely above the viewport.
- The bar's «Оркестратор» button at the page end has `aria-pressed="true"` (the seat is open).
  Clicking it **collapses** the seat: page 687 → 54, `data-collapsed="1"`. Getting the conversation
  back takes a second click. This holds at all three widths.
- `O` does the same (`seatToggleRef.current`).
- `taskAsked`'s receipt action (`KanbanBoard.tsx:2668-2677`) scrolls the seat's textarea into view.
  That is the only existing "bring the seat back" code, and only an «Ask» receipt reaches it.

### 3.3 Folded and side seats

- Folded: page room 54 px. Unfolding puts the page at 0 (`desktop.json` "placed", seat-folded rows).
  There is little to return from.
- Side placement: page room 0 (`desktop.json` "held" `seat-side pageRoom: 0`). There is nothing to
  return from.

### 3.4 Phone (390×844 and 430×932)

`evidence/panel-scroll/phone.json`: the document does not overflow, and the column pages are the
only vertical scrollers, each `contain`. The seat card stays at `[0, 52, 390×66]` before and after
fingers at a column's top and end. The orchestrator never leaves the screen on the phone, so it
needs neither a zone nor a return.

## 4. Options

| | Mechanism | Verdict |
| --- | --- | --- |
| **A (chosen)** | A strip pinned (`position: sticky; top: 0`) at the top of `.kb-page`, shown only while the seat head is above it. It belongs to the page scroller, outside both contained panels, so a wheel, a trackpad or a finger over it scrolls the page. Because it is pinned, it stays under the pointer for the whole way up. It is one button: a click returns to the top. | Measured in §5.4. |
| B | Pin the seat's own head (sticky seat with a negative top). | Fails by the same mechanism as §3.1. Once the page moves up, the head unpins and the conversation slides under the pointer. |
| C | Make the bar «Оркестратор» button scroll back instead of collapsing while the seat is off screen. | It gives a return but no zone. It also changes the meaning of an existing control (`aria-pressed`, the `O` key, «згорнути»), which puts acceptance 4 at risk. See Deferred. |
| D | A JS wheel handler that turns a wheel at the feed's top into a page scroll. | It breaks the lock (acceptance 1). |

Reuse: the strip borrows the fold control's vocabulary: lucide `ChevronUp` (the arrow the fold
button already uses, pointing where the panel is) and the `orchPanel.*` naming. Neither the fold
button nor the bar button can do the job unchanged: the first is off screen, the second collapses.
So the strip is the one new element, and it doubles as the return control. No second control is
added.

## 5. Design (desktop board, seat on top, expanded)

### 5.1 Markup: `KanbanSeat.tsx`

Render a strip as the **first** node of the fragment, before `<a.skip-board>`, only when
`!side && !seat.collapsed`. That makes it the first child of `.kb-page`. `KanbanBoard.tsx` stays
untouched.

```tsx
<div className="seat-return" data-seat-return="" {...(shown ? { "data-shown": "" } : {})}>
  <button type="button" onClick={returnToSeat} aria-label={t("orchPanel.seatReturnAria")} title={t("orchPanel.seatReturnHint")}>
    <ChevronUp aria-hidden /> <span>{t("orchPanel.seatReturn")}</span> <span className="hint">{t("orchPanel.seatReturnHint")}</span>
  </button>
</div>
```

- **`shown`:** an `IntersectionObserver` with root `.kb-page` (`sectionRef.current.parentElement`),
  observing the seat's `[data-seat-head]`, with `rootMargin: "-32px 0px 0px 0px"` and threshold 0.
  Set shown when `!isIntersecting && boundingClientRect.top < rootBounds.top + 32`, i.e. the head
  sits above the strip. Under happy-dom, with no `IntersectionObserver`, the strip stays hidden.
  One root is exactly what an observer expresses; contrast `KanbanBoard.tsx:2345`, where the
  predicate needs three. The observer does no per-scroll JS and needs no state-lock or hot-path
  work.
- **`returnToSeat`:** call `page.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" })`.
  Then move focus into the seat with `preventScroll`: the composer's `textarea` if there is one,
  otherwise `[data-seat-collapse]`. This follows `taskAsked`'s pattern. The strip hides once the
  head is back, so focus must not stay on it. The return never changes the folded state.
- **Hidden state:** `visibility: hidden; pointer-events: none`. That takes the strip out of the tab
  order and the accessibility tree.

### 5.2 Styles: `kanbanBoard.css`, in the seat block (`:1023-1140`)

```css
.kb .kb-page > .seat-return { position: sticky; top: 0; height: 0; z-index: 5; flex: 0 0 auto; }
.kb .kb-page > .seat-return > button { position: absolute; inset: 0 0 auto 0; height: 32px; display: flex; align-items: center; justify-content: center; gap: 8px;
  background: var(--color-accent-soft); color: var(--color-accent); border-bottom: 1px solid color-mix(in srgb, var(--color-accent) 45%, transparent);
  font-size: var(--text-label); font-weight: 600; }
.kb .kb-page > .seat-return:not([data-shown]) > button { visibility: hidden; pointer-events: none; }
.kb .kb-page > .seat-return .hint { font-weight: 500; opacity: .8; }
@container (max-width: 520px) { .kb .kb-page > .seat-return .hint { display: none; } }
.kb .kb-page:has(> .seat-return) > .board-frame { height: max(440px, 100% - 32px); }
.kb .kb-page:has(> .seat-return) { scroll-padding-top: 32px; }
```

- **Height 0 with an absolutely placed button:** the strip takes no layout while hidden, so the seat
  does not move at the top.
- **Board 32 px shorter:** at the page's end the board starts below the strip, so the jump row and
  the column heads are never covered (§5.4 geometry). The page room drops by 32. The existing floor
  `seat.boardFrameHeight ≥ 440` (`kanbanBoard.browser.test.tsx:2798`) still holds through `max()`.
- **`scroll-padding-top`:** focus and `scrollIntoView` land targets below the strip.
- **`z-index: 5`:** inside the CONTENT range (`layers.ts` `CONTENT_MAX = 12`), so the layering guard
  does not list it. It sits above the seat (3), its grip (4) and `.col-head` (2), and below
  `.skip-board` (6) and every overlay (58+).
- **Hint at narrow widths:** `.kb-page` is already `container-type: inline-size`. At a 640 px
  viewport with the rail open the page is 392 px wide; there the hint drops and the label stays.
- **Contrast:** the builder measures accent on accent-soft in light and dark (it must be at least
  4.5:1 at `--text-label`). It looked readable in the dark uk frame; the ratio is unmeasured.

### 5.3 Strings (`en.ts` / `uk.ts`, in the `orchPanel.*` block, en `:3394`, uk `:3347`)

| Key | en | uk |
| --- | --- | --- |
| `orchPanel.seatReturn` | Back to the orchestrator | До оркестратора |
| `orchPanel.seatReturnHint` | scroll here or click | гортайте тут або натисніть |
| `orchPanel.seatReturnAria` | Scroll back up to the orchestrator chat | Прокрутити до чату оркестратора |

The visible label with its hint is what makes the zone "clearly labelled". The strip carries no
other output: no state dot, no unread marker (rule: add no unrequested output).

### 5.4 Prototype measurements (same conditions as §3, strip injected with the CSS above)

| Viewport | Room | Strip at top / at end / mid-page / scrollTop 10 | At end: strip, jump row, column head (top, height) | Wheel ×5 from strip | Trackpad gesture 2000 px | Finger 400 px ×2 | Click | Column top, wheel up ×3 (lock) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1440×900 | 655 | hidden / shown / shown / hidden | 48+32, 80+56, 149+64 | 415, 175, **0**, 0, 0 (then seat-head under pointer) | **0** | 97 → **0** | page **0**, strip hidden, focus `TEXTAREA` in seat | 655 (held) |
| 1000×800 | 580 | hidden / shown / shown / hidden | 48+32, 80+68, 149+64 | 340, 100, **0**, 0, 0 | **0** | **0** | **0**, hidden, textarea | 580 (held) |
| 700×800 | 580 | hidden / shown / shown / hidden | 48+32, 80+68, 149+64 | 340, 100, **0**, 0, 0 | **0** | **0** | **0**, hidden, textarea | 580 (held) |

Frames I inspected: `band-end-1440x900`, `band-end-1440-dark-uk`, `band-mid-1000x800`,
`band-end-700x800`, `base-stuck-1440x900`. These are scratch frames for this brief only; the builder
renders the real ones. Things the builder must handle:

- **The fixture's attention toast** («permission prompt», top right, z 80) covers the strip's right
  end: `elementFromPoint` at 85% of the strip's width hits the toast at all three widths, and at
  700 px from 50% on. Dismiss the toast before taking frames and readings, and wheel at the strip's
  left part. In production a toast is transient and sits above the bar too. This is no defect of
  the strip.
- **At the page's end** the seat's resize grip (`.seat-grip`, `bottom: -7px`) shows its lower 7 px
  just under the strip, inside the board's 12 px top padding. It overlaps no text. Leave it, or say
  in the evidence why it was moved.
- **Mid-page**, the strip covers the top 32 px of the scrolled conversation, the way any pinned
  header does. That is expected.

## 6. States to cover

Tests and frames, desktop at 1440×900, 1000×800 (tabs) and one narrow desktop (700×800, or 640×800
with the rail open). Each in en light and uk dark.

1. Seat on top and expanded, page at 0: no strip visible, and the layout matches today except that
   the board is 32 px shorter.
2. Page at its end: the strip is shown, and its label and hint are whole text. The strip covers no
   jump-row or column-head text; measure from text ranges. At 640/700 px the hint drops and the
   label stays whole.
3. Mid-page (seat partly visible, head above the strip): the strip is shown.
4. Wheel over the strip reaches page 0; so do a trackpad gesture and a touch drag (hasTouch context,
   learned rule on touch gestures applies).
5. Click, then Tab-to-strip + Enter, then Space: page 0, strip hidden, focus on the seat's textarea
   (or the fold button when the seat shows the create draft or is unavailable).
6. The lock is unchanged: every "contained" row of the existing panel-scroll case still holds.
7. «Згорнути» still folds, from the head and from `O`. With the seat folded no strip renders, and
   page room stays 54.
8. Side placement: no strip, page room 0.
9. Create-draft seat (`[data-orchestrator-draft="create"]`, auto height): the strip still shows at
   the page's end.
10. A window under 800 px tall starts folded, so no strip.
11. Phone at 390×844: no `[data-seat-return]` in the document, and the seat card on screen at a
    column's end (the existing assertion plus one new one).

## 7. Tests and evidence (add cases, no new driver)

- **DOM, `src/components/kanban/seatFold.dom.test.tsx`** (it already mounts `KanbanSeat`):
  - the strip is the fragment's first node for top+expanded, and absent when folded or at the side;
  - en and uk labels and the aria label;
  - hidden without an observer;
  - with a stubbed `IntersectionObserver` reporting the head above the root, it gets `data-shown`;
  - a click calls `scrollTo({ top: 0 })` on the page and focuses the textarea with `preventScroll`;
  - the fold button still toggles and `O` still folds.
- **CSS guard, `boardScrollers.test.ts`:** assert that `.kb .kb-page > .seat-return` is sticky with
  `top: 0`. Assert that `.col-body` and the seat feed keep `overscroll-behavior-y: contain`, so the
  lock cannot be dropped silently.
- **Browser, `kanbanBoard.browser.test.tsx`:** add one `browserTest` **inside**
  `describe("independent panel scroll")` (`:32639-32924`), not at the end of the file, where #3024,
  #3017 and main all append. It covers states 1-10 with the readings in §5.4, plus a control: with
  `.seat-return` hidden, a wheel from the column head stops at the conversation as in §3.1, so the
  case is proven able to fail. Readings go to `evidence/panel-scroll/return.json`. Frames: end, mid
  and after-return at each width, light/en and dark/uk, under `LLV_KANBAN_FRAMES` or
  `.artifacts/panel-scroll-return`; frames stay out of the tree (PR frames rule). Re-run the existing
  panel-scroll case and regenerate `evidence/panel-scroll/desktop.json`: its rooms shift by 32 px
  and its rows read the room dynamically (`maxOf(page, PAGE)`).
- **Phone, `issue1671Evidence.browser.test.tsx` `:3508`:** extend the existing case. Assert no
  `[data-seat-return]` and the seat card box unchanged at the column's end. Its existing
  `390x844-column-end.png` is the 390 frame.
- **Runs:**
  - `CHROME_BIN=… LLV_KANBAN_BROWSER_TEST=1 bun test <file> -t "independent panel scroll"` and
    `LLV_SWIPE_BROWSER_TEST=1 … -t "independent panel scroll"`, through `gate-slot.sh`;
  - isolated HOME, `XDG_CONFIG_HOME`, `LLV_STATE_DIR` and TMPDIR, `LLV_VIEWER_CONTROL_URL` on a
    closed port, a short Chrome TMPDIR (the stage scratch path overflows the socket path);
  - DOM and CSS tests by path;
  - typecheck;
  - the pre-push touched-tests gate.
- **Other cases that read `.kb-page` with the seat on top** (`:2753`, `:5421` #1731 seat anchoring,
  `:13623`, `:13851`, `:14727`, `:19539`): they compute rooms at run time. The builder runs `:2753`
  and `:5421` at least, since they measure the seat and the board together.

## 8. What not to touch

- **The lock:** `kanbanBoard.css:339` and `:1064` (`overscroll-behavior-y`), and the phone columns'
  `overscroll-y-contain`.
- The fold button, `useKanbanSeat().toggle`, the `O` handler, `BarPanelToggles`, `MobileKanban`,
  `MobileSeatCard`.
- **Fence 685e2bb2, PR #3024** (head `9f723358` at 13:38Z). Its actual diff touches `layers.ts`,
  `layers.test.ts`, `modalLayer.ts`, `kanbanMenus.tsx`, `RuntimePill.tsx`, `ArtifactPreviewHost*`,
  `useOverlayEscape.ts`, the kanban fixture (hunks near lines 130, 2542 and 3873), the phone fixture,
  and appends to both browser drivers at their ends. At that head it does **not** touch
  `kanbanBoard.css` or `AgentWindow.tsx`, despite the brief. Stay out of all of these anyway:
  - add no rule near the overlay z-indexes (58-80) in `kanbanBoard.css`;
  - do not edit `layers.ts` or `LEGACY_RAW_Z`;
  - do not edit the fixture;
  - add the browser case mid-file.
- **Fence 94e88098, PR #3028:** its diff is only `.artifacts/form-draft-brief.md`. Do not touch the
  decision form component.
- **PR #3017** (05ef830c) touches `en.ts`/`uk.ts` near line 214. Add the new keys in the
  `orchPanel` block, about 3,100 lines away.

## 9. Deferred, not currently justified

- **Retarget the bar «Оркестратор» button and `O` to scroll back while the seat is open but off
  screen** (option C). Today they collapse (§3.2). The strip already gives the one-click return, and
  changing these controls risks acceptance 4. Revisit if the operator asks why the bar button folds
  the seat from the tasks.
- **A state dot or unread marker on the strip.** It would help, but nobody asked for it (rule
  against unrequested output).
- **A strip for the folded seat.** The page room is 54 px, the folded strip is one notch away, and
  a 32 px strip there would flicker within 22 px of scroll.
- **Any phone change.** At 390 the orchestrator never leaves the screen (§3.4).
- **A zone at the seat's bottom edge for scrolling down.** The operator said «Згорнути» covers
  going down.
