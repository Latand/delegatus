# Pinned findings verification

The fix round covers the four findings from review attempt 3 and the five
findings from UI check attempt 1. The merged baseline is
`68df5fee98cbbb1ae125dad48edf01f49b52b9c5`; it integrates `origin/main` without
conflicts. The free-text status-note lane remains separate.

| Finding | Acceptance evidence |
| --- | --- |
| Closed/cancelled references complete steps | `taskSteps.test.ts`: open and dropped states survive closed/cancelled references, including their reason; completed references complete open work. Regression failed before the fix. |
| Step operator hold loses its note and age | `motion.test.ts`, `kanbanModel.test.ts`, `phoneKanbanModel.test.ts`, `KanbanEditing.dom.test.tsx`: preserve reason, age, counts and pinning. Real MCP update/readback in `bindings.test.ts` preserves the hold. Shared browser fixture uses a step operator hold at both widths in both locales. Model regressions failed before the fix. |
| Header totals bypass shared motion | `kanbanModel.test.ts`: zero-member provisioning, in-flight and step work agree across header, column and Overview. Hidden provisioning still contributes; existing seat exclusions pass. Regression failed before the fix. |
| MCP rejects normalizable holds | `bindings.test.ts`: real SDK client/server transport through production bindings stores 201-character notes as 200 for create/update and step holds, unknown kinds as unstated, server provenance and all four legacy statuses. `schemaParity.test.ts` checks the advertised task schema. Transport regression failed before the fix. |
| Waiting header clips and needs-you is colour-only | Shared browser driver checks heading scroll/client widths and the warning glyph at 1440 in both locales; progress captures show one working, one needs-you and one no-reason count in Waiting. |
| Needs-you uses ambiguous Waiting wording | Shared driver checks the chip translation and operator line in both locales; English operator line contains no Waiting. Progress and operator captures show Needs you / Потрібні ви. |
| Motion reasons are unbounded | Shared driver checks every card motion line against two line heights, including exactly 200-character notes, at 1440/390 in en/uk. Full text remains in the title and is displayed without a clamp on the phone task screen. Long-card and full-reason captures verify both readings. |
| Ukrainian task-reference sentence is centred/split | Shared driver compares button/parent text alignment. The label, note and age now share the same inline button content; the Ukrainian task-reference capture shows a left-aligned wrapped sentence. |
| Working count is repeated in the footer | Updated desktop component assertions and shared browser checks require the motion count and no footer working count. Phone assertions inspect the actual agents line as well as its count marker. Progress captures confirm one working count per card. |

## Checks

Every test ran by file through `/var/tmp/llv-gate bun test`, with isolated
`LLV_STATE_DIR` and a temporary root outside operator state.

- `src/lib/tasks/taskSteps.test.ts`: 3 passed.
- `src/lib/tasks/motion.test.ts`: 4 passed.
- `src/components/kanban/kanbanModel.test.ts`: 53 passed.
- `src/components/kanban/KanbanEditing.dom.test.tsx`: 27 passed.
- `src/components/mobile/phoneKanbanModel.test.ts`: 19 passed.
- `src/components/mobile/MobileKanban.dom.test.tsx`: 14 passed. The footer
  regression requires the Working motion count, no footer working count, and
  the retained agent count.
- `src/lib/mcp/bindings.test.ts`: 88 passed.
- `src/lib/tasks/taskHold.test.ts`: 4 passed.
- `src/lib/mcp/schemaParity.test.ts`, task-write case: passed.
- Shared `kanbanBoard.browser.test.tsx`, task-motion case: passed; four
  viewport/locale combinations, 416 assertions. The driver closes contexts,
  browser and its ephemeral-port fixture server in `finally`.
- `bunx tsc --noEmit`: passed.
- ESLint on changed TypeScript files: no introduced errors; baseline errors
  listed below.
- Privacy gate with `--base origin/main --check-commits`: passed.
- `git diff --check`: passed; source and test diff reviewed locally.

Rendered measurements are in `renders.json`. The shared driver saves PNGs
under `.artifacts/task-states/renders/`: progress, waiting, checklist, editor,
operator card, long card, desktop task-reference card and phone full reason.
Images were inspected directly. Headless Chromium shell was used.

## Notes

The complete schema-parity file has 29 passing cases and one unrelated failure
at `src/lib/mcp/schemaParity.test.ts:700`: a pipeline fail-edge description
assertion expects older wording. The same failure reproduces in an export of
the merged baseline. Its task-write case passes.

ESLint on all changed TypeScript files reports 93 existing errors and eight
warnings. Running the same file set in an export of current main gives the
same totals and the same per-file, per-rule severity counts; the changed
implementation adds none.

The pre-existing right-edge clipping of the Done column at 1440 remains
outside these nine findings. Browser evidence covers emulated phone geometry.

## Follow-up acceptance

Merged the four newer main commits without conflicts at `a817ccadb` before
updating the phone assertion. The complete phone suite reproduced 13 passing
tests and one failure before the assertion change, then passed all 14 tests
with the motion count and retained agent count checked separately.

Reran every changed non-browser test file individually with isolated state
through the memory-capped gate: 447 passed, with only the unrelated
schema-description failure above. The same schema-description failure was
reproduced on current main; the task-write schema acceptance passes.
The shared task-motion browser case again passed 406 assertions across
1440/390 in English/Ukrainian. All 30 fresh captures were inspected directly;
the driver closed the browser and its fixture server. TypeScript, privacy
with commit checking, and diff checks passed after the merge.

## Completed step-reference acceptance

The relayed production repros are now covered through
`projectTaskWorkflows` → `buildTaskBands` → `buildKanbanModel` →
`buildPhoneKanban`. New regressions failed before the changes and pass after:

- An open operator-held step retains its note, original age, needs-you totals,
  warning edge and phone pinning when its reference is paused or running.
  The shared browser fixture includes the paused reference at both widths
  in both locales. Existing non-operator reference tests remain green.
- Done and dropped steps retain terminal motion when the referenced running
  pipeline has a passed build, pending review and committing cursor while
  publication is unavailable. They contribute no working totals or live
  Overview cards. The same fixture with an open step still counts as work.
- Overdue task and step postponements retain their known reasons and remain
  reachable through Postponed, excluded from No reason. Bare and unstated
  task/step waits remain included; filters and counters share one predicate.

The latest by-file rerun has 451 passing tests and the single baseline
schema-description failure documented under Notes. The production MCP
transport suite passes all 88 tests with its temporary root under `/var/tmp`;
the inherited stage scratch TMPDIR caused two stderr-only harness failures
before that isolation. The finding-specific schema case also passes.

The shared driver passes 416 assertions at 1440/390 in en/uk. All 30 current
captures were inspected directly, including unclipped Waiting headers,
operator warning edges and ages, two-line long reasons with full text on
the phone task screen, left-aligned task references and one working count
per card. Browser and fixture server closed in the driver's finalizer.

TypeScript, privacy with commit checking and diff checks pass. ESLint matches
current main at 93 errors/eight warnings by file, rule, severity and leading
message, with no introduced diagnostics. The schema-description failure was
also reproduced on current main. A fresh independent read-only review of
the complete diff and all 30 captures found no remaining pinned defect.
The status-note fence is preserved.

## Project-bar overflow acceptance

The additional UI finding is fixed in the project bar only. Search and reason
filters share one row; the filter group keeps its natural width while search
gives room first. Bars without reasons and the Overview retain their layouts.
The new shared-driver regression failed against the prior layout with the
search starting at -3 px. It now checks both vertical bounds and that all five
reason chips fit horizontally at 1440 in English and Ukrainian.

Merged current main (`ef18d741d`) without conflicts, retaining its phone-launch
and runtime changes. Acceptance checks on the merged head:

- All nine finding-specific files/cases pass: 213 model, component and real
  MCP transport tests. The preceding complete by-file sweep had 451 passes
  and only the baseline schema-description failure documented above.
- The shared task-motion browser case passes 432 assertions at 1440/390 in
  en/uk. It saves 32 captures, including the two new top-bar captures. The
  browser, contexts and ephemeral fixture server close in the finalizer.
- At 1440 in both languages the bar is y=0..48, search is y=7.5..39.5 and
  filters are y=14.5..32.5. Filter client/scroll widths agree: 296/296 px in
  English and 311/311 px in Ukrainian. Measurements are in `renders.json`.
- TypeScript, privacy with commit checking and diff checks pass.
- ESLint on changed TypeScript files reports 93 errors/eight warnings.
  Current main over the same existing files reports 93 errors/ten warnings;
  the file/rule/severity/leading-message comparison finds no new diagnostics.
  The new files and the shared browser driver have no lint diagnostics.

The rendered acceptance surfaces were inspected directly. Local source and
test changes were reviewed against the findings; the status-note fence remains
preserved. Notes: the unrelated pipeline-description assertion still fails
on current main. The pre-existing clipped Done column, Ukrainian conversation
wording and grey phone Working line remain outside the pinned findings. At
narrower desktop widths the filters remain horizontally scrollable; the
Ukrainian search placeholder truncates at 1440 as the field gives room first.


## Malformed checklist and narrow filter follow-up

Merged current main at `70f13157d` before fixing the two remaining findings.
Merge resolution retains status notes and task motion as separate components
on desktop, phone cards and the phone task screen, and combines both sets of
REST/MCP fields, guards and regression cases.

The store now removes a checklist rejected by `storedTaskSteps` after the raw
row spread. Thirteen persisted shapes each have a regression through
`loadTasks` → `projectTaskWorkflows` → `buildTaskBands` → `buildKanbanModel` →
`buildPhoneKanban`: string, number, boolean, null, object, empty array, null
entry, primitive entries, nested array, missing fields, invalid state,
array-valued state and object-valued state. Persisted state validation now
checks the primitive string type before membership, so object-to-string
coercion cannot throw and an array cannot masquerade as an open state.
The checks exercise legacy import and the subsequent SQLite read, retaining
the task without steps. A mixed-array regression retains both valid entries.
All thirteen malformed cases failed before their fixes, including the production
`steps.map` and null `step.ref` crashes; the mixed-array case already passed.

Filters retain their search-row placement at 1440. Below 1168 px of actual
bar width they occupy a wrapping row directly beneath the bar. The existing
shared driver now checks 1280/1024 in both languages: all five reasons fit,
there is no document or filter-group horizontal overflow, and filtering can
be toggled without losing the checklist. Its original complete task/card
contract remains at 1440/390 in both languages. The added 1280 bar regression
failed before the layout change (296 px of filters in 183 px of space).

Final verification:

- 303 tests pass across 13 targeted files, each run separately through the
  memory-capped gate with an isolated state directory.
- The shared browser case passes 498 assertions over eight width/locale
  combinations. Search remains at y=7.5..39.5 inside the y=0..48 bar. At 1440,
  filters occupy y=14.5..32.5 and have identical client/scroll widths (296 px
  en, 311 px uk). At 1280/1024, filters occupy y=48..82 with identical
  client/scroll widths. Measurements are in `renders.json`.
- Opened bar/filter frames at every desktop width in both languages, plus
  progress, Waiting and full-reason phone frames. The driver closes its
  contexts, browser and ephemeral fixture server in its finalizer.
- `bunx tsc --noEmit` and `git diff --check` pass. ESLint on the five changed
  TypeScript files reports 70 errors/four warnings; a file/rule/severity/message
  comparison with current main gives exactly the same diagnostics.
- Privacy with `--check-commits` passes using the scanner from a detached
  worktree of current main against the candidate repository.

Existing board/card clipping at narrower desktop widths, Ukrainian
conversation wording and grey phone Working text remain outside the two
findings. No product changes were made for those observations. The old
schema-description failure recorded above is resolved by the main merge;
the complete schema-parity file now passes all 32 tests.


Hosted note after the first push: `privacy-publication` fails in the trusted
main checkout's OCR `exactOnly` self-tests at
`scripts/privacy-publication-gate.test.ts:1391`. The expected-output assertion
omits the scanner's added `file-sha256` attribution line. Both scanner and
self-test files are byte-identical to current main in this branch, and the
workflow runs this step in `trusted` before scanning the candidate. The direct
trusted-main scan of the candidate with commit checking passes. This unrelated
self-test issue stays outside the two fixes; hosted build/native checks may
still be pending when the fix stage hands over.

## Search width floor follow-up

The project bar's search field now holds a 128 px minimum while reason chips
share its row. This exceeds the 112 px acceptance floor and leaves 86 px for
placeholder text after padding and borders: 58.7 px in English and 80.6 px in
Ukrainian. The containing group includes its children's minimum widths so
they cannot overlap the next control. The existing 1168 px bar-width threshold
and all narrower layouts remain unchanged.

The shared browser case now asserts `topbar.searchWidth >= 112` and that the
placeholder fits the field's text area at 1440 in both languages. The new
width assertion fails against the preceding CSS (110.23 px in English).
With the fix, all 502 assertions pass at 1440/1280/1024/390 in English and
Ukrainian. Search is 128 px in both 1440 cases; all five reason chips fit
inside the 48 px bar. The filters remain beneath it at 1280/1024 without
document or filter-group sideways overflow. Updated measurements are in
`renders.json`.

Opened the actual final top-bar, Waiting and phone frames in both languages;
the full placeholders and adjacent controls are readable. The driver closes
its browser, contexts and ephemeral server in its finalizer. The existing
1024 Ukrainian attention-chip overlap and horizontally scrolled board columns
remain outside this finding.

Focused checks use isolated state through the memory-capped gate: 67 kanban
model tests (including all thirteen malformed checklist shapes and the mixed
array), three checklist tests and the browser case pass. TypeScript and
`git diff --check` pass. ESLint has no diagnostics for the changed browser
driver; CSS is ignored by the repository's ESLint configuration.
