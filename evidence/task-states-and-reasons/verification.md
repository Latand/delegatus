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
