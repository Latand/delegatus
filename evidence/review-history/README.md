# S6: pipeline creation and recorded review history

This slice implements `docs/design/retire-flows.md` §6 and S6. S7–S9 remain separate work.

New work enters the existing pipeline draft editor. Built-in review templates use native reviewer and fixer run stages with a finite fail edge. Historical conversations require explicit task selection in the draft.

Recorded reviews open through `src/components/flows/ReviewHistory.tsx`. Project menus, legacy stage links, verdict details, task history and archive decks share that reader. It follows the archive cursor, exposes every round, resolves reviewer aliases and generations, and reads findings or reports missing artifacts. Recorded approval retains its reviewed commit; an unavailable current commit is labelled unknown. Uncertain delivery remains visibly unresolved.

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
