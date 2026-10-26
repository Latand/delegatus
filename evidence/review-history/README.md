# S6: pipeline creation and recorded review history

This slice implements `docs/design/retire-flows.md` §6 and S6. S7–S9 remain separate work.

The implementation and verification below describe the reviewed S6 head. [Main refresh and supported-board coverage](#main-refresh-and-supported-board-coverage) records the adaptations made while merging main.

New work enters the existing pipeline draft editor. Built-in review templates use native reviewer and fixer run stages with a finite fail edge. Historical conversations require explicit task selection in the draft.

Recorded reviews open through `src/components/flows/ReviewHistory.tsx`. Project menus, legacy stage links, verdict details, task history and archive decks share that reader. Legacy flow-round open requests reach the reader independently of board placement and camera support. It follows the archive cursor, exposes every round, resolves reviewer aliases and generations, and reads findings or reports missing artifacts. Recorded approval retains its reviewed commit; an unavailable current commit is labelled unknown. Uncertain delivery remains visibly unresolved.

`src/components/flows/reviewGroup.ts` separates independent reviewer groups from executable flow configuration. Existing membership, disclosure, geometry and activity ordering remain in their existing selectors. Archived decks suppress the composer and agent controls. Cached flow actions return a local retirement refusal. The server retirement fence from S5 remains authoritative.

## Contract paths

| Producer | Consumers and defaults | Result |
| --- | --- | --- |
| Archived snapshots and runtime reconnects | Viewer, dashboards, overview, scheme, kanban, phone, task history | Preserve recorded membership and rounds; remove optimistic close and flow-driven activity overrides. |
| Direct-review grouping | Shared grouping core, alias resolver, deck, layout and geometry | Explicit direct-review group; preserve identity, order and folding without executable configuration. |
| Single and bulk creation entries, built-in templates, canvas add-review | Existing draft creation, role defaults and task editor | Native run stages; no flow creation or automatic adoption of historical work. |
| Legacy stage/verdict/task/focus links | Shared archive dialog and existing GET/export endpoints | History remains reachable when a board deck or source transcript is absent. |
| Reviewer auto-close | Durable pipeline membership before direct-review closure | Historical verdicts cannot close a current pipeline reviewer. |

## Verification records

`checks.json` records commands, exit codes, baseline and source digests. `test-observations.json` records every explicit importer test file and its completed head/base samples. `regressions.json` retains the project comparator's result. Whole-file controls check failures that filtered reruns classify as flaky.

`rendered.json` records the existing kanban browser driver's archive case: English and Ukrainian, light and dark, widths 320, 390, 640, 1280 and 1440. The 640 viewport is 320 pixels high. Each case captures long findings and a later approved round with missing findings, checks bounds and text clipping, traps keyboard focus, closes with Escape and records zero flow writes. Frame digests identify the 40 generated screenshots. Raw captures follow the repository's local-media policy; the committed driver regenerates them under `.artifacts/review-history`.

All heavy checks run through `scripts/gate-slot.sh` and `gate-remote` with private HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR. These changes claim no performance gain.


## Modal and archive control fixes

The template picker renders into the document body as a native modal dialog. Its backdrop occupies the viewport, and a short viewport scrolls the choices. The archive reader also uses the browser's modal layer, reserves its keyboard input and restores its opener. Selecting an absent round reports unavailable history. Changing the selected archive or round starts its content at the top.

`BranchPane.readOnly` reaches `LogFeed`, `DeputyBlock`, `FeedMessageRow` and `ConversationMessageRow`. Archive decks and relay readers supply the flag; every other caller keeps the default `false`. The flag suppresses transcript deletion and rename, process and account changes, migration recovery, launch and deputy retries, pending prompt answers and message delivery actions. Transcript disclosure, reading, links and export remain available. Draft panes, ordinary conversation readers, mobile chrome and the orchestrator keep their existing defaults.

Expanded archive and direct-review decks keep their fold control in the shared round navigation, including when the phone hides the transcript header.

Legacy round buttons in `StagesSheet` pass the attempt's durable archive id and exact round to the shared reader. Their destination remains available when the reviewer transcript and the board deck are absent. The phone pipeline’s past-round list offers the same exact-round archive route and keeps its existing transcript links. Round controls measure at least 24 pixels on desktop and 44 pixels for touch.

The existing kanban browser driver has an additional S6 integration case. It enters through bulk selection, the scheme node, the phone menu, expanded archive decks, verdict evidence, task history and legacy round buttons. It also renders the Viewer’s taskless group and the shared board layout’s direct-review deck, with a subject alias and a superseded reviewer generation, current and completed attempts, a fresh review after a fix, a spent budget, an answered question and the legacy draft conversion entry. Both languages and themes run at 320, 390, 640, 1280 and 1440 pixels; the 640-pixel view is 320 pixels high. The browser clock is fixed at an invented UTC timestamp. `integration.json` records visible text ranges with ancestor clipping accounted for, hit tests, control and input measurements, viewport and focus measurements, source digests and frame digests. The project history case in `rendered.json` now enters through the real project menu and checks keyboard shortcuts, outside taps and focus restoration.

`fix-regressions.json` records the explicit importer manifest and the final comparison. Earlier check records above describe the original implementation; the fix records and their source digests identify the later verification.

Independent review decks also remain members of their subject's primary task band. The shared task-band projection previously dropped these decks because they have no executable container halo. Taskless subjects and subjects shared by tasks retain one deck; an absent subject remains absent.

`fix-checks.json` records the fix campaign's exact command sources and final source digests. The final checks pass typecheck, touched-file lint with zero introduced errors (122 baseline diagnostics), 121 focused tests and the 248-file importer comparison with zero introduced failures. That comparison retains 138 baseline failures and six filtered intermittent results. `fix-test-observations.json` reconciles every manifest file with a completed result. `fix-whole-files.json` retains three complete runs per side for each sampled file; the two board assertions fail on both sides in all three runs, qualifying their filtered classification. `fix-extra-browser.json` records two fresh runs per side of the older phone browser importer, which fails at the same absent generated-CSS prerequisite on both sides.

The final browser campaign passes both cases across all 20 combinations, producing 396 integration frames and 40 archive-reader frames. `integration.json` and `rendered.json` retain their measurements and final source/frame hashes. Only the browser driver and the new task-band test fixture changed after the complete importer comparison; both were checked again with final rendered coverage, the affected unit file, typecheck and lint. Product source stayed identical to the compared snapshot.

`fix-visual-review.json` records visual inspection of all 436 final frames through 73 contact sheets, plus the eight full Viewer follow-ups. It reconciles every inspected frame with the committed frame digests and records the contact-sheet crops used for desktop surfaces.

## Short viewport evidence

The S6 integration case reveals the parent card, scrolls to the defining state, captures the painted frame, and then measures it. Each defining marker is checked in full against horizontal and vertical ancestor clips and hit tests along the line edges. Entirely offscreen ranges fail the check. Negative controls cover both viewport axes, ancestor clipping and a pinned bar covering part of a line.

Fresh review, unfinished budget, answered question and conversion captures name their defining text. Archive-deck, verdict and task-history captures show their history opener. Each legacy round has a separate source frame before mouse or keyboard activation, plus a frame of the selected archive round.

The regenerated `integration.json` and `rendered.json` describe 436 integration frames and 40 archive-reader frames across English and Ukrainian, light and dark, at 320, 390, 640, 1280 and 1440 pixels. The 640-pixel viewport is 320 pixels high. `short-viewport-review.json` records visual inspection of all 220 defining-state and navigation crops, plus 16 complete short-viewport frames, with their hashes and crop bounds. `short-viewport-checks.json` records the final commands and results for this correction. Earlier check and inspection records retain their original campaigns.

## Main refresh and supported-board coverage

The merge retains main's retirement of SchemeBoard, FlowDialog, FlowHub, FlowStrip, PipelineStrip, VerdictPopover, TaskWorkflowPanel and the scheme selection/editor closure. `retiredSchemeBoard.test.ts` remains the retirement check.

The S6 fixture and browser checks now use these supported surfaces:

- Bulk and single-node creation checks move to the phone's New pipeline menu and template picker. Desktop checks require the supported kanban board to omit the old creation entry.
- The direct-layout scenario moves to the real kanban board for reviewer-card suppression and the existing shared RoundDeck scene for two-round selection and fold controls. Subject aliases and superseded reviewer generations remain in the fixture.
- VerdictPopover and TaskWorkflowPanel archive-open checks move to the desktop StagesSheet and phone pipeline past-round controls. They exercise an unavailable archive, preserve the source sheet and restore focus. The existing exact-round cases still exercise click and keyboard navigation with an available archive.
- The retired PipelineEditor conversion fixture and its browser check are removed with main's editor retirement. The supported legacy-stage cases continue to cover retained round navigation.
- The taskless/shared-task direct-review deck regressions move from the deleted `scheme/taskBands.test.ts` to `kanban/kanbanModel.test.ts`, including the absent-subject case and a check that the supported board has one primary subject card.
- `ReviewHistory.dom.test.tsx` opens the archive through the supported RoundDeck control in place of mounting FlowStrip and FlowHub. Its read-only, all-rounds, locale, request and state-preservation assertions remain.

Earlier evidence files describe their original source digests and retired surfaces. [Refresh renders](refresh-rendered.json) record the supported-board campaign, its source and frame digests, and visual inspection. [Refresh checks](refresh-checks.json) record the explicit test paths and their base comparisons. These records keep the historical captures separate from the refresh verification.

### Latest main integration

The subsequent main merge preserves both transcript guards. `BranchPane` retains main's retired-orchestrator send blocker and the archive's disabled launch retry. `LogFeed` accepts both `readOnly` and `sendBlockedReason`; attention controls stay hidden for an archive and while a compact feed's first read loads. The mobile feed DOM test covers editable and archived readers during loading and after arrival.

The shared browser driver keeps the S6 history cases, main's conversation-opening motion case, and main's narrow-header case as separate suites. [Current main checks](current-main-checks.json) and [current main renders](current-main-rendered.json) record the final integration's verification and source digests. The earlier refresh records retain their original snapshot.
