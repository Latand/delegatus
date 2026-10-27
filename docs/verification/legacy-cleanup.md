# Legacy cleanup evidence

Written in Codex Cloud (result 47, base `adce5764`) and applied on main at `b027e190d`. Every removal was re-checked on that revision.

Each row is an independent change unit. No workflow, compatibility identifier,
MCP key, dependency version, or committed evidence JSON was changed.

| Item | Change and evidence |
| --- | --- |
| Prototype product names | Changed only the HTML titles in `docs/design/task-board-integration/artifact/index.html` and `docs/design/mobile-v2/prototype/index.html`. Both still displayed the old product name. Historical quotations, migration notes and compatibility names remain. |
| Section header | Removed `src/components/ui/SectionHeader.tsx`. TypeScript-resolved imports across `src` have no incoming edge to this file. Searches for its path, component and exported style constant find no code consumer; the design document describes a visual recipe, not a runtime dependency. |
| Workflow strip | Removed `src/components/workflows/WorkflowStrip.tsx`. The same import resolution finds no incoming edge. Remaining references are historical design/inventory entries, not executable callers. The shared workflow model remains. |
| Board density capture | `scripts/capture-board-density.ts` and `scripts/fixtures/board-density.tsx` were already removed on main before this change; the test only pins their absence. |
| Layering capture | Removed `scripts/capture-layering.ts`. No executable caller, workflow invocation or package command remains outside the file itself; the retirement design cites it as a historical consumer. |
| Accounts capture | Removed `scripts/capture-issue-1418-accounts-dialog.ts`. References outside the script are design/performance notes; no executable caller or workflow invokes it. |
| Task bands capture | Removed `scripts/capture-issue-1586-task-bands.ts`. References outside the script are historical design/capture instructions; no executable caller or workflow invokes it. |
| Catalog focus capture | Removed `scripts/capture-issue-1625-catalog-focus.ts`. The retirement design cites it, but no executable caller or workflow invokes it. |
| Readable tools capture | Removed `scripts/readable-tool-shots.tsx`. No external executable caller or workflow invokes it. Shared feed fixtures remain. |
| Crown capture | Removed `scripts/evidence-crown-capture.ts` and `scripts/evidence-crown-browser.cjs`. The browser script's sole caller was the capture script; only historical acceptance instructions refer to the pair. |
| Docs that named a removed driver | `docs/design/task-centered-board/README.md`, `docs/acceptance/sidebar-crown-pin/README.md`, `docs/repository-cleanup.md` and a `.gitignore` comment told readers to run or keep a removed script; each now says the script is gone. Committed `evidence/**/*.json` and the evidence JSON beside those docs are untouched. |
| Next patch | Already fixed. Revision `e48eae0c8` removed the local patch when updating Next to 16.4.1. Both installed manifest-plugin builds use `concatenatedModId !== null`. The new test exercises the installed guard with zero, a positive id and null, and pins absence of a local Next patch. The release dependency stays. |

## Retained entry points

The board geometry capture, capture-directory helper, kanban browser tests,
conversation-window browser tests and phone browser tests remain. The README
capture has an explicit workflow caller and remains. Demo captures have package
commands and remain. The mobile-v2 capture exports helpers exercised by its
retained test suite and remains. Browser test files are automatically discovered
by Bun; absence of a workflow command alone does not prove those tests dead.
All committed evidence JSON and historical design records remain.

## Verification

All commands ran through the gate wrapper, one at a time, with fresh `HOME`,
`XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR` and the Viewer control URL on a
closed port.

| Check | Result |
| --- | --- |
| `bun test ./scripts/legacy-cleanup.test.ts` | 16 passed, 0 failed |
| `bunx tsc --noEmit` | exit 0, no errors |
| `bunx eslint` on the new test | exit 0 |
| `bun run build` with a fresh `LLV_STATE_DIR` | exit 0 (Next webpack build, MCP bundle and gate tooling built) |
| `git grep` for each removed path and component name in `src`, `scripts`, `package.json` and `.github` | no match outside the new test |
