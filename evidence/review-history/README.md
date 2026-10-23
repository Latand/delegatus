# S6: pipeline creation and recorded review history

This slice implements `docs/design/retire-flows.md` §6 and S6. S7–S9 remain separate work.

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
