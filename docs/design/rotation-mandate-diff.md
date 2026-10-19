# Rotation dialog: the mandate as a diff

## Originating requirement

Operator, 2026-10-15 about 15:30Z, chat message to the project's orchestrator,
Russian, verbatim («div» is how speech recognition wrote «diff»):

> Нужно, знаешь, что сделать? Чтобы вот на этой менюшке показывалось, показывался только div мандата, то есть если что-то изменилось. И, ну, если раскрывать, то показывать div. А если, э-э, ничего не изменилось, то просто даже не раскрывать.

The message came with a phone screenshot of the sheet «Замінити оркестратора
цього проєкту», opened for a seat whose mandate is based on v54. Under
«Мандат · Його інструкції (v55)» it showed the stale notice «Мандат чинного
оркестратора базується на v54; поточний типовий — v55», the button «Лишити
мандат чинного (на основі v54)», and the whole v55 text in an open text box
that filled the rest of the screen.

The lane's pinned outcome, restated by the orchestrator to the operator at
15:31Z (no reply since):

- **Changed:** one collapsed summary line (versions, how many lines changed)
  that expands to a readable diff. Reuse the repository's diff renderer, and
  add no new diff engine where one exists.
- **Unchanged:** one line saying so, with no expandable body.
- «Лишити мандат чинного» and the rotate action keep working as now. The
  rotation posts the same text the diff was computed against.
- An existing way to edit the mandate before rotating stays reachable through
  an existing control. Where editing exists only in the full text box, that
  box goes behind the expanded section. No new chrome beyond the collapse.
- Phone (390 px) and desktop.

Anchors below are at `805a790ac`. On `origin/main` (`5352d66c3`, re-checked
before this was written), none of the cited files changed.

## Result

Both rotate drafts replace the mandate block with one line. Two strings are
compared: the incumbent's stored mandate (`seat.mandate`) and the exact text
the draft will post. When they differ, the line reads
`Мандат v54 → v55 · рядки: +45 −68` and stays collapsed until pressed. Pressed,
it shows the diff in the feed's renderer, with the existing text box under the
diff. When they are equal, the line reads `Мандат без змін (v55) (редагувати)`.
It has no chevron, it never opens by itself, and pressing «(редагувати)»
reveals only the editor. That keeps the phone's existing «Редагувати мандат»
row working (see D2). The keep choice and the restore button share one slot
above the line. Nothing on the server changes.

The repository has the diff model (`src/components/feed/diff.ts`), the
intraline highlighter and the renderer (`DiffCard.tsx`). It has no line differ
for two whole texts. The one new algorithmic piece is a bounded line LCS,
about 40 lines, that feeds the existing `finalizeFile`. No new UI was needed to
keep editing, so this design needs no decision from the operator.

## What the code does today

### Surfaces

| Surface | Component | Where |
| --- | --- | --- |
| Desktop dock, rotate mode | `RotateDraft` → `OrchestratorDraft mode="rotate"` | `src/components/orchestrator/OrchestratorPanel.tsx:892-995`, `:1004-1272` |
| Desktop stale notice + keep | `<p data-orchestrator-mandate-stale>` above the rules | `OrchestratorPanel.tsx:1149-1168` |
| Desktop rules disclosure | `<details data-orchestrator-mandate-details>`, summary `{mandateSummaryOf} (edit)`, body = restore + textarea | `OrchestratorPanel.tsx:1170-1210` |
| Desktop auto-open | opens the details whenever `edited` | `OrchestratorPanel.tsx:1060-1074` |
| Phone sheet header | «Замінити оркестратора цього проєкту» | `src/components/mobile/MobileOrchestratorSheet.tsx:563-582` |
| Phone rotate draft | `RotateDraft` | `MobileOrchestratorSheet.tsx:705-869` |
| Phone mandate field | `MandateField`: **not folded** in rotate (no `folded` prop), so label row, caption, stale box + keep, and the textarea are always open. This is the screenshot. | call `:818-831`; component `:887-1016`; keep box `:979-995`; keyboard reveal `:928-936` |
| Phone live seat sheet | «Редагувати мандат · замінює оркестратора» row opens the rotate draft | `MobileOrchestratorSheet.tsx:1082-1096` (`data-orchestrator-edit-mandate`), `MandateView :1284-1310` |
| Summary rule shared by both | `mandateSummaryOf(mandate, incumbent)` | `src/components/orchestrator/seatState.ts:401-419` |

### Where the two texts come from, and what is posted

- **Current seat's mandate:** the seat read (`GET /api/orchestrator/seat`)
  provides `seat.mandate` and `seat.promptVersion`. The desktop passes it as
  `seat` (`OrchestratorPanel.tsx:906`, `incumbent={seat}` at `:982`). The phone
  passes `rotate.seat` (`MobileOrchestratorSheet.tsx:587`).
- **Successor's mandate (draft):** `useState(() => readField("Rotate", project,
  "mandate") || rotateMandateBase(seat))` (`OrchestratorPanel.tsx:922-927`,
  `MobileOrchestratorSheet.tsx:738-744`). `rotateMandateBase`
  (`seatState.ts:393-399`) returns the current built-in default
  (`ORCHESTRATOR_SYSTEM_PROMPT`, v55) when the seat is stale. Otherwise it
  returns the seat's own text. The draft persists only when it differs from
  the base.
- **Posted:** confirm sends `body.mandate = mandate` and
  `launch.firstMessage = mandate` verbatim. It refuses only an empty text
  (`OrchestratorPanel.tsx:954-974`, `MobileOrchestratorSheet.tsx:772-792`).
- **Server:** `base = requested || incumbent.mandate` sets the recorded
  version: current when `base` is the default, `null` when it is an edit over
  a stale seat, otherwise the incumbent's version
  (`src/lib/orchestrator/seatCommand.ts:1637-1645`). `composeRotationMandate`
  (`seatCommand.ts:1781-1813`) splits `base` at the handoff/history headings
  (`src/lib/orchestrator/handoffDigest.ts:124-158`). It keeps the part before
  them, then appends a compacted «Rotation history» and a fresh handoff.
  Delivery appends the role table. So the successor receives the posted text's
  core plus a tail the server composes.
- **Stored mandates carry their own handoff.** `seat.mandate` is the composed
  text the seat was created with. The live seat on this project (read with
  `get_orchestrator`, 2026-10-15 15:34Z) is v54, 26,908 bytes, 131 lines, and
  ends with a `## Handoff from your predecessor (rotation)` section.

### Diff code that exists

- `src/components/feed/diff.ts`: the `DiffLine`/`Hunk`/`FileDiff` model
  (`:8-26`), `DIFF_CAPS` (`:28-34`), character-level intraline highlights
  (`intralineEdits :57`, `addIntralineHighlights :105`; similarity ≥ 0.5,
  ≤ 250,000 cells per pair), and `finalizeFile` (`:166`), which applies
  redaction, caps and intraline in one place. The builders turn tool payloads
  into hunks (`diffFromClaudeEdit`, `diffFromApplyPatch`, …). **No function
  diffs two whole texts line by line.** A search for LCS/Myers helpers in
  `src` and `scripts` found only this file's intraline code, and
  `package.json` has no diff package.
- `src/components/feed/cards/DiffCard.tsx`: `LineRow` (`:39`) draws
  `+`/`-`/context rows with intraline spans in the `diff-*` tokens. Light and
  dark variants are in `src/styles/tokens.css:200-205`, `:303-308`.
  `FileDiffView` (`:66`) adds a file header, an 8-row preview and a «show all»
  button. Rows are `whitespace-pre` mono with horizontal scroll.
- `src/components/feed/mandateMessage.ts`: client-safe split of a delivered
  mandate into mandate and handoff, used by the feed's `MandateCard`.

### Editing the mandate before rotating, today

The rotate draft's textarea is the only place, on both surfaces. On the desktop
it sits behind the rules disclosure. On the phone it is always open, and the
live seat sheet's «Редагувати мандат» row exists to get there: it is labelled
as an edit and opens this draft. Agents can pass `mandate` to
`rotate_orchestrator`, which this design leaves alone.

### Measurements (live v54 seat against the v55 default)

Made in a scratch export of `805a790ac` with bun, on this machine (24 cores,
load average 11.8-14.8 during the runs). The seat text was read with
`get_orchestrator`. It was kept in scratch and is not reproduced here.

| Quantity | Value |
| --- | --- |
| Lines old / new | 131 / 108 (26,908 / 26,469 bytes) |
| Changed lines, whole texts | +45 −68 (the −68 include the 7 lines of the old handoff section) |
| Longest v55 line / median | 1,532 / 148 chars (one paragraph per line) |
| Hunks at context 0 / 1 / 2 / 3 | 18 / 11 / 6 / 3 |
| Rows and chars shown at context 1 | 141 rows, 32,832 chars |
| Line LCS, mean of 20 runs | 0.24 ms |
| Edit-shaped runs through the shipped `finalizeFile` + intraline, 10 runs | min 5.4, median 6.6, max 15.7 ms; **truncated by `hunksPerFile: 16`**; 8 lines got intraline spans |
| Paired lines eligible for intraline under the 250k-cell bound | 20 of 25 |

Two consequences shape the design. The feed's caps cut a real mandate diff,
so text diffs need their own caps. The full model with intraline costs
milliseconds, so it is built only while the section is open.

## Design

### D1. What is compared

The two sides are `seat.mandate`, exactly as the seat read returns it, and
`mandate`, the draft state that confirm posts. They are compared as whole
strings split on `"\n"`, with every segment kept. Three things follow:

- "Unchanged" is exactly `mandate === seat.mandate`, with zero changed lines.
  A trailing newline or CRLF difference counts as a changed line, because the
  server receives it.
- When a stale seat moves to the default, the old handoff section shows as
  removed lines. That is accurate. With the default as base, the server keeps
  no history from the incumbent's text. With «Лишити мандат чинного», the old
  handoff is compacted into the successor's history. The server's fresh
  handoff is never shown, as today, and the hint above already says the server
  hands over the transcript and tasks (`orchPanel.rotateHint`).
- No second section-splitting rule on the client. Diffing only the core was
  considered and cut (see Deferred).

### States

| State | When | Line (en / uk) | Slot above the line | Body | Opens by itself |
| --- | --- | --- | --- | --- | --- |
| **Changed, collapsed** | `mandate !== seat.mandate` | `Mandate v54 → v55 · lines: +45 −68` / `Мандат v54 → v55 · рядки: +45 −68`, with chevron | stale seat: the existing «Лишити мандат чинного (на основі v54)»; otherwise none | not rendered | never |
| **Changed, expanded** | the operator pressed the line | same line, chevron turned | same | the diff (all hunks), then the editor: header row (restore when shown · «Надсилається як перше повідомлення») and the textarea | — |
| **Unchanged** | `mandate === seat.mandate`, seat on the current version or bespoke | `Mandate unchanged (v55) (edit)` / `Мандат без змін (v55) (редагувати)`; bespoke: `(own rules)` / `(власні правила)`; no chevron | none | only after «(редагувати)»: the editor, no diff | never |
| **Keep-current chosen** | stale seat, keep pressed (`mandate === seat.mandate`) | `Mandate unchanged (v54; the current default is v55) (edit)` / `Мандат без змін (v54; поточний типовий — v55) (редагувати)` | the existing «↺ Повернути типовий» (sets the text back to v55, which is the base) | as Unchanged | never |
| **Edited** | the operator typed | `Mandate v55 → your edit · lines: +1 −1` / `Мандат v55 → ваша правка · рядки: +1 −1` (stale seat: `v54 → …`) | stale: keep; otherwise none | as Changed; the editor's restore button shows | never; it stays open or closed as the operator left it |

Rules shared by every state:

- The section's open state belongs to the operator. A change of state while
  it is open (for example, typing the text back to the incumbent's) neither
  closes nor opens it. The diff simply disappears or appears above the editor.
- The editor's restore button shows when `mandate !== base`, except in
  keep-current chosen, where the slot already shows it. Its label rule is
  unchanged: «Повернути поточний мандат» on a current seat, «Повернути типовий»
  on a stale one.
- `from` is `v{promptVersion}`, or «власні правила» when the version is
  `null`. `to` is `v{current}` when `mandate === ORCHESTRATOR_SYSTEM_PROMPT`,
  otherwise «ваша правка». The server records `null` for exactly that last
  case. (`to` never equals the incumbent's text in a changed state.)
- Submitting: the line still toggles; slot buttons and the textarea are
  disabled, as today. An intent error keeps its block above the section, and
  the section behaves the same.
- Counts are the `+`/`−` rows of the same line diff that the body draws.

One pure helper beside `mandateSummaryOf` in `seatState.ts` decides all of
this for both surfaces. Call it `rotateMandateView(seat, mandate)`. It returns
`{ kind: "changed", from, to, added, removed } | { kind: "unchanged", label }`,
plus the slot (`keep` | `restore-default` | `null`). This follows the existing
"one rule for the dock and the phone" (`seatState.ts:401-404`). Once both
rotate drafts use it, `mandateSummaryOf`'s incumbent branch has no caller.
Reduce it to the create draft's two cases.

### Copy

New keys in `src/lib/i18n/en.ts` and `uk.ts`, placed in the `orchPanel.mandate*`
block (en `:3368-3380`, uk `:3321-3334`):

| Key | en | uk |
| --- | --- | --- |
| `orchPanel.mandateDiffSummary` | `Mandate {from} → {to} · lines: +{added} −{removed}` | `Мандат {from} → {to} · рядки: +{added} −{removed}` |
| `orchPanel.mandateDiffVersion` | `v{version}` | `v{version}` |
| `orchPanel.mandateDiffOwn` | `own rules` | `власні правила` |
| `orchPanel.mandateDiffEdited` | `your edit` | `ваша правка` |
| `orchPanel.mandateUnchanged` | `Mandate unchanged ({label})` | `Мандат без змін ({label})` |
| `orchPanel.mandateUnchangedStale` | `Mandate unchanged (v{version}; the current default is v{current})` | `Мандат без змін (v{version}; поточний типовий — v{current})` |

The noun comes before the numbers («рядки: +45 −68»), so no plural agreement is
needed in Ukrainian. `−` is U+2212, as in `DiffCard.tsx`'s header.

Reused without change: `orchPanel.mandateEdit`, `orchPanel.keepIncumbentMandate`,
`orchPanel.restoreDefault`, `orchPanel.restoreIncumbent`, `orchPanel.mandate`,
`orchPanel.mandateSent`, `tools.diffTruncated`.

Become unused and are deleted: `orchPanel.rotateStaleMandate` (the line now
states both versions, so the sentence would repeat them on the same surface),
`orchPanel.mandateSummaryIncumbent`, `orchPanel.mandateSummaryIncumbentStale`,
`orchPanel.mandateSummaryIncumbentCustom`.

### Diff computation (`src/components/feed/diff.ts`)

- `diffTextLines(oldText, newText): DiffLine[]`: split on `"\n"`, keeping
  every segment. Trim the common prefix and suffix lines. Run an LCS table
  (`Uint32Array`) over the middle when its cell count is ≤ 1,000,000;
  otherwise the middle becomes one removal run followed by one addition run.
  On ties, removals come before additions, so a reworded paragraph reads
  `−old` then `+new` and pairs for intraline.
- `diffFromTexts(oldText, newText, { path, context = 1 }): FileDiff`: groups
  the ops into hunks with `context` unchanged lines around each change. Lines
  are paragraphs, so one is enough context; at context 1 the live pair gives
  11 hunks. Each hunk's `header` is the nearest heading line (`/^#{1,6} /`)
  at or before its first row, omitted when that row is the heading itself.
  The hunks go through the existing `finalizeFile`, which gains a `caps`
  parameter defaulting to `DIFF_CAPS`. The feed passes nothing and behaves
  byte for byte as before. Text diffs pass
  `TEXT_DIFF_CAPS = { files: 1, hunksPerFile: 500, linesPerFile: 2_000,
  charsPerLine: 8_000, totalChars: 128_000 }`. Two mandates at the 32,000-byte
  structured envelope total at most 64,000 chars, so this leaves 2× headroom
  for a draft typed past the envelope. Past it, the existing truncation line
  shows.
- Intraline: the existing character-level engine, unchanged.
- Cost control: the summary counts come from `diffTextLines` over the live
  draft on every render, at about 0.24 ms for the live pair. The full
  `FileDiff` is built only while the section is open. It is memoised on
  (incumbent text, `useDeferredValue(mandate)`), so typing in the textarea
  below a long diff stays responsive.

### Rendering (`src/components/feed/cards/DiffCard.tsx`)

- Export the row renderer (`LineRow` plus `flatten`, or a `DiffRows({ hunks,
  prose })` component that `FileDiffView` also uses). The feed's output must
  stay identical, so `toolCards.render.test.tsx` passes unchanged.
- Prose variant, used only by the mandate:
  - sans `text-ui leading-[1.45]`, `whitespace-pre-wrap break-words`, no
    `overflow-x-auto`;
  - the `+`/`-` marker stays real text in its own one-character column, so
    wrapped lines align;
  - hunk headers are muted captions without the `@@ ` prefix;
  - the same `diff-*` tone and intraline tokens as the feed;
  - rows carry `data-orchestrator-mandate-diff-line="+|-| "`.
- Container `data-orchestrator-mandate-diff`, `rounded-surface border
  border-border bg-sunken`. It has no inner scroller, no preview cap and no
  copy button: the draft's own scroller carries it.

### Desktop (dock 440 px by default at 1440; 360 px, its minimum, at 768)

- `<details data-orchestrator-mandate-details>` stays at
  `OrchestratorPanel.tsx:1174` and gains
  `data-orchestrator-mandate-state="changed|unchanged"`.
- The slot renders where the stale box renders today (`:1152-1168`), above
  the details. It uses the existing button classes, without the warning box
  and without the sentence. The wrapper keeps
  `data-orchestrator-mandate-stale={incumbent version}` when the seat is
  stale. The keep button keeps `data-orchestrator-keep-incumbent`.
- Summary: changed shows the native marker. Unchanged uses `list-none`, has
  no marker, and ends with «(edit)». The class string is otherwise the same
  (`min-h-7 … text-label font-semibold text-secondary`).
- The auto-open effect (`:1072-1074`) runs for the create draft only. The
  rotate details never open by themselves.
- Body: the diff (changed only), then the existing header row (restore when
  shown · «Sent as the first message»), then the existing textarea
  (`#orchestrator-mandate`, `min-h-[220px]`).
- The inherited-directory line stays below the details (`:1215-1219`). The
  footer is unchanged.

### Phone (390 px, fullscreen sheet)

`RotateDraft` renders the section in place of today's open `MandateField`
(`MobileOrchestratorSheet.tsx:818-831`), after the launch controls:

1. **Slot**, when present: the existing 44 px keep or restore button, with
   no warning box or sentence. The wrapper carries
   `data-orchestrator-mandate-stale`.
2. **Line**: the existing fold control's look (`data-orchestrator-mandate-fold`,
   `min-h-11`, `ChevronRight`, `MandateField :938-950`), used as a two-way
   toggle with `aria-expanded`. The chevron turns 90° when open. Unchanged has
   no chevron and ends with «(редагувати)».
3. **When open**: the diff (changed only), then the editor: the label row
   («Мандат» · restore when shown · «Надсилається як перше повідомлення») and
   `#mobile-orchestrator-rotate-mandate` (`min-h-[160px]`). The caption
   `data-orchestrator-mandate-kind` is not rendered in the rotate draft,
   because the line already says what the text is.
4. **Directory line** «Наступник продовжить у …», always below the section.

- The keyboard reveal (#1004, `:928-936`) scrolls the editor's label row to
  the scroller top, never the section top. Otherwise the textarea would end
  up below a diff that may be thousands of pixels tall.
- The create draft's `MandateField` (one-way fold, caption) and both footers
  are unchanged.
- First screen: the header (52 px), the hint and the stacked launch controls
  take about 430-470 px. The slot and the line therefore sit inside the first
  screen above the footer. In the operator's screenshot, at 440 CSS px wide,
  the «Мандат» block starts at about 455 px.

### D2. The editing path

Editing exists only in the text box, so the text box goes behind the section:
in a changed state, under the diff.

In an unchanged state, the spec's "no expandable body" would remove the only
editing path for every seat already on the current version. That is the
common case right after any rotation. The phone's own «Редагувати мандат ·
замінює оркестратора» row would then open a draft where the mandate cannot be
edited.

The design therefore keeps the existing control: the line's existing
«(редагувати)» word on the same disclosure. It has no chevron, it never opens
by itself, and it reveals only the editor; no diff is shown, because nothing
differs. No new control is added.

**Departure, named.** The unchanged line can be opened by an explicit
«(редагувати)». The spec says "no expandable body at all". This trades that
clause for the spec's other clause ("stays reachable through an existing
control"). The cost is one word on the unchanged line. If the operator wants
the strict reading, deleting the body in the unchanged state is a one-line
change, and editing a current seat's mandate then disappears from the UI.

### D3. One fact once

The stale notice's sentence repeated the line's `v54 → v55`, so the sentence
goes. Its keep button stays, with the same label, attribute and effect, in
the slot. After keep is pressed, the same slot offers «Повернути типовий».
That button already existed inside the open box, and putting it in the slot
keeps the choice reversible in one press while the section stays closed.
Today the auto-opened editor provided that.

The desktop incumbent header's chip «мандат v54, типовий v55» describes the
running seat and predates this change. It stays.

## What must not change

- `POST /api/orchestrator/rotate` body and `launch.firstMessage`: the draft
  text verbatim, plus engine, model, effort, fast and account as today. The
  empty-text refusal stays.
- `rotateMandateBase` (#1452), the `"Rotate"` draft persistence (stored only
  when it differs from the base), and keep's effect (`mandate = seat.mandate`)
  and its offer condition (stale seat and `mandate !== seat.mandate`).
- Restore semantics and labels; the textarea's ids and `data-orchestrator-mandate`.
- Server composition (`seatCommand.ts`, `handoffDigest.ts`) and
  `src/lib/orchestrator/prompt.ts`. Mandate texts are fenced by lane 468f3725.
- The create drafts on both surfaces; `MandateCard` in the feed.
- The feed's `DiffCard` output and `DIFF_CAPS`.
- Both footers, the sheet header, the vacated note and the intent-error block.
- The phone's live seat sheet, including the «Редагувати мандат» row and
  `MandateView`.

## Files

| File | Change |
| --- | --- |
| `src/components/feed/diff.ts` | `diffTextLines`, `diffFromTexts`, `TEXT_DIFF_CAPS`; a `caps` parameter on `finalizeFile` |
| `src/components/feed/cards/DiffCard.tsx` | export the row renderer with a prose variant |
| `src/components/orchestrator/seatState.ts` | `rotateMandateView`; `mandateSummaryOf` keeps its create cases |
| `src/components/orchestrator/OrchestratorPanel.tsx` | rotate branch of `OrchestratorDraft` (slot, summary, body, no auto-open) |
| `src/components/mobile/MobileOrchestratorSheet.tsx` | `RotateDraft` section; editor reveal target |
| `src/lib/i18n/en.ts`, `uk.ts` | six keys added, four deleted |
| tests and the evidence case | below |

Fences and open work, read from their diffs:

- Lane 468f3725 changes only `prompt.ts`, its tests and an untracked v55
  fixture. Nothing here touches them.
- Lane b647caac (in progress, uncommitted) edits `issue1695Evidence.fixture.tsx`
  around lines 4454-4467 and the kanban driver around 26923-27082, and edits
  i18n near en `:1038` and uk `:1028`.
- PR #2941 (lane 1fcd5437) adds blocks at kanban driver line 23413 and phone
  driver line 10909, and an i18n line near en `:2320` and uk `:2265`.
- This work's edits sit elsewhere: fixture `:387` and the seat stub at
  `:4486-4487`, the kanban driver after `:29991`, and i18n `:3321-3380`.
  Hunks do not touch.

## Tests (by path, isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, with `LLV_VIEWER_CONTROL_URL` on a closed port, through `scripts/gate-slot.sh bun test <file>`)

- `src/components/feed/diff.test.ts`:
  - equal texts give no rows;
  - a trailing newline or CRLF difference counts as one changed line;
  - a reworded paragraph pairs `−` then `+` and carries intraline spans;
  - context 1 hunking, and the heading header present or omitted;
  - two 32,000-byte texts with nothing in common are not truncated under
    `TEXT_DIFF_CAPS`;
  - the cell bound falls back to one replacement run;
  - `finalizeFile` with default caps returns the same model as before.
- `src/components/orchestrator/seatState.test.ts`: `rotateMandateView` for
  stale-default (changed, v54 → v55, slot keep), keep-chosen (unchanged-stale,
  slot restore), current (unchanged v55), bespoke (unchanged own rules),
  edited on stale and on current seats (→ your edit), and counts equal to
  `diffTextLines`.
- `src/components/orchestrator/OrchestratorPanel.dom.test.tsx`: rewrite the
  rotate cases at `:1389`, `:1435` and `:1453`, and open the section before
  typing in `:1465`.
  - Details closed on open, with the summary text.
  - No auto-open after keep. Keep changes the line to unchanged-stale and
    shows restore in the slot. Restore returns the changed line.
  - Opening shows `[data-orchestrator-mandate-diff]` before the textarea.
  - Typing an edit changes the line to «→ your edit», and `rotatePosts[0].mandate`
    equals the text the line was computed from.
  - In the unchanged state there is no diff element, even after «(edit)» is
    pressed.
- `src/components/mobile/mobileOrchestratorControls.dom.test.tsx`: the same on
  the phone (`:382`, `:557`). The section is folded on open, and the toggle is
  two-way. The keyboard case at `:590` opens the section first and asserts
  that the reveal brings the editor's label row to the top. Cases from
  `:438` that type into the textarea open the section first.
- Run unchanged and check they stay green:
  `OrchestratorDock.dom.test.tsx`, `mobileOrchestratorLeaves.dom.test.tsx`,
  `mobileSeatCard.dom.test.tsx`, `MobileFocusView.conversation.dom.test.tsx`,
  `src/components/feed/cards/toolCards.render.test.tsx`,
  `src/lib/i18n/i18n.test.ts`. Where one of them types into the rotate
  textarea right after opening, it now opens the section first.
- `src/components/mobile/issue1347Evidence.browser.test.tsx:524-528` asserts
  the rotate textarea is on screen. It changes to assert the mandate line
  instead.

## Rendered evidence (the existing kanban driver; no new driver)

One `describe("rotation dialog: the mandate as a diff", …)` block in
`src/components/kanban/kanbanBoard.browser.test.tsx`, inserted after the
account-chips block that ends at `:29991`. That block already opens this draft
at 1440 and, with phone emulation, at 390 (`:29843-29852`). The fixture is
`issue1695Evidence.fixture.tsx`, `scenario=seat-head` plus a new
`mandate=changed|unchanged` read next to `SEAT_HEAD` (`:387`). The seat stub
(`:4486-4487`) then answers as follows:

- `changed`: `promptVersion = ORCHESTRATOR_PROMPT_VERSION - 1`. The mandate
  text is derived from `ORCHESTRATOR_SYSTEM_PROMPT` by rules that do not
  depend on wording (468f3725 is rewriting the text):
  - drop the last `- ` list line before the final heading;
  - insert one extra paragraph after the first heading;
  - swap one word in the first line of 150-450 chars after the first heading,
    which keeps intraline in bounds;
  - append a `## Handoff from your predecessor (rotation)` section of two
    lines naming a fixture conversation id.
- `unchanged`: `ORCHESTRATOR_SYSTEM_PROMPT` at the current version.
- Without `mandate`, the stub keeps today's «Keep the project moving.», so
  existing cases are untouched.
- Never copy a live seat's mandate into the fixture: it carries conversation
  ids.

Frames go to `ROTATION_MANDATE_DIFF_OUT`, outside the tree. Readings are
committed as `evidence/rotation-mandate-diff/readings.json` (text and geometry
only).

| State | How reached | Defining element (visible text on the first screen) |
| --- | --- | --- |
| A changed, collapsed | `mandate=changed`, open the rotate draft | the line `Mandate v54 → v55 · lines: +A −R` (expected counts from `diffTextLines` in the driver) |
| B changed, expanded | A, press the line; if the first diff row is not whole on the first screen, scroll the section top to the scroller top | the first diff row and its hunk caption |
| C unchanged | `mandate=unchanged`, open the rotate draft | `Mandate unchanged (v55) (edit)` |
| D keep-current chosen | A, press keep | `Mandate unchanged (v54; the current default is v55) (edit)` and «Restore default» in the slot |

Matrix: states A-D × widths 390 (phone, touch), 768 (narrowest desktop; the
dock at its 360 px minimum) and 1440 × en, uk, in light. Add dark for all four
states at 390 uk and 1440 en. That is 32 frames, named
`rotation-mandate-{state}-{width}-{lang}-{scheme}.png`. If the fixture does
not show the dock at 768, use the narrowest desktop width that does and
record it in the readings. Desktop frames clip to the whole dock panel. Phone
frames are the whole viewport.

Assertions per frame, recorded in the readings:

1. **Defining element:** visible on the first screen, measured from text
   ranges inside the scroller's visible rect and above the footer.
2. **No sideways overflow in the diff:** the container's
   `scrollWidth ≤ clientWidth + 0.5`; setting `scrollLeft` to a large value
   reads back 0; every row's text-range right edge is within the container
   (fractional).
3. **No overlap:** zero overlap between the slot button, the line's text,
   the launch controls above and the directory line below.
4. **Targets:** on the phone, the line and slot controls are ≥ 44 × 44 CSS px.
5. **What renders where:**
   - A, C, D: no visible textarea and no diff rows.
   - B: the textarea follows the last diff row in document order.
   - C, after «(edit)» is pressed: the textarea and still no diff rows.
6. **Counts:** in B, the line's `+A −R` equal the rendered `+` and `−` rows
   and the driver's own count.
7. **Intraline:** at least one highlighted span in B.
8. **Contrast:** add, del and context text, intraline spans, and the line's
   text are ≥ 4.5:1 against their computed backgrounds, in light and dark.
9. **Flows:**
   - D, then «Restore default», returns A's exact text.
   - B, then typing one character, gives «→ your edit» with +1 −1 relative
     to the v55 text.
10. `pageErrors` is empty.

Run it, for example:
`LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=<chrome> ROTATION_MANDATE_DIFF_OUT=<scratch>/frames bash scripts/gate-slot.sh bun test src/components/kanban/kanbanBoard.browser.test.tsx -t "rotation dialog: the mandate as a diff"`.
Use private HOME, XDG_CONFIG_HOME and LLV_STATE_DIR, a short TMPDIR for
Chrome's sockets, and `LLV_VIEWER_CONTROL_URL` on a closed port.

## Deferred — not currently justified

- **Diffing only the core** (without the handoff/history tail). It would hide
  an edit typed into the tail and the drop of the old handoff when moving to
  the default. It would also need a client copy of `splitMandate`, which
  lives in a module that imports `node:fs`.
- **Word-snapped intraline highlights for paragraphs over about 500 chars.**
  That changes the shared engine's cost bound on the feed's hot path. The
  existing character-level highlights are reused.
- **A preview with «show all» inside the expanded diff.** The operator asked
  for the diff on expansion. A second fold is chrome the requirement does not
  ask for.
- **Opening the editor directly when the phone's «Редагувати мандат» row
  starts the draft.** That needs an intent flag through `rotate.onOpen`; the
  word «(редагувати)» on the line is one press away.
- **A copy-diff button.**
- **Showing the server-composed history, handoff or role table in the dialog.**
- **Moving the keep/restore slot into the line.** Interactive content inside
  `<summary>` breaks the disclosure's accessibility.

## Validation against the requirement

- "показывался только diff мандата": both surfaces drop the whole text. The
  section is one line plus the existing slot.
- "если что-то изменилось … если раскрывать, то показывать diff": the changed
  line is collapsed by default. Expanding shows the diff first, in the
  repository's own renderer with its intraline highlights.
- "если ничего не изменилось, то просто даже не раскрывать": the unchanged
  line never opens by itself and has no diff to show. The one departure is
  the explicit «(редагувати)», kept for the reason in D2.
- The keep choice works as before, and the posted text is the diff's new side
  by construction: both read the same `mandate` state.

## Notes

- Lane 468f3725 raises the mandate version. Once it deploys, every seat on
  v55 is stale, and this dialog shows a changed v55 → v56 line for every
  project.
- In the operator's screenshot, the floating voice avatar covers the start of
  the footer's cancel button. The voice panel belongs to lane 1fcd5437, and
  this design does not touch it.
- No ADR: every decision here reverses with a small change.
