# Done task board retention

Done tasks leave the board strictly after three days and stop counting toward
`BOARD_TASKS_PER_PROJECT_LIMIT`. `taskShowsOnBoard` defines both decisions.
`DONE_TASK_BOARD_RETENTION_MS` names the duration. Stored history remains
available through task lists, ID selection, search and `get_task`.

## Completion source and legacy fallback

`patchTask` stamps `doneAt` on entry into done and clears it on reopening.
The production lane/merge writer `finishBoardTask` uses that command.
Ghost settlement and dismissed unstarted launches use the same completion
normalizer. The store also guards direct writers, including in-place edits.
Repeated done writes and metadata edits preserve the original completion time.

Legacy done rows freeze their existing `updatedAt` as `doneAt` when read.
Read normalization performs no write. The next successful task-store write
persists that backfill with a fresh revision. The presence of `doneAt` makes
this per-row rule idempotent. Rows, assignments, extension fields and receipt
history are retained. Invalid dates remain visible rather than guessing age.

`doneAdmissions` records the completion's assignment identities. Expiry uses
the existing hidden-group resurfacing rule, with completion plus three days
as its implicit hide instant: a new admission or a later decision request
restores visibility. Reconciliation of an existing admission does not.
The current seat is exempt and retains its existing protected seat surface.
The existing board clock reapplies visibility without a reload; rendering can
lag the strict timestamp boundary by the board's 15-second model step.

## Checks

Each command used a fresh sandbox. Stateful integration files ran in separate
Bun processes because they establish their own environment before importing
modules; running them together caused module-cache/environment interference.
The final runs below all passed.

```sh
check_root=$(mktemp -d /tmp/llv-done-check-XXXXXX)
mkdir -p "$check_root/state" "$check_root/config" "$check_root/tmp"
export LLV_STATE_DIR="$check_root/state"
export XDG_CONFIG_HOME="$check_root/config"
export TMPDIR="$check_root/tmp"
bun test <one file from the table>
```

| Test file | Passing tests |
| --- | ---: |
| `src/lib/tasks/doneVisibility.test.ts` | 10 |
| `src/lib/tasks/boardVisibility.test.ts` | 10 |
| `src/lib/tasks/boardTaskLimit.test.ts` | 13 |
| `src/lib/tasks/tasks.test.ts` | 38 |
| `src/lib/tasks/store.sqlite.test.ts` | 32 |
| `src/lib/tasks/ghostSettlement.test.ts` | 3 |
| `src/lib/tasks/revision.test.ts` | 5 |
| `src/lib/tasks/membership.test.ts` | 21 |
| `src/lib/mcp/taskBoardVisibility.integration.test.ts` | 5 |
| `src/lib/forge/autoMerge.test.ts` | 29 |
| `src/components/scheme/taskBands.test.ts` | 40 |
| `src/components/kanban/kanbanModel.test.ts` | 41 |
| `src/components/tasks/TaskPanel.boardPreference.dom.test.tsx` | 7 |
| `src/components/tasks/TaskSheet.dom.test.tsx` | 4 |
| Total | 258 |

Rendered command, under the same sandbox variables:

```sh
LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=<installed Chromium> \
  bun test src/components/kanban/kanbanBoard.browser.test.tsx \
  --test-name-pattern 'done task retention'
```

One browser test passed, 68 unrelated cases were filtered out. It uses the
existing shared fixture/driver, the real Viewer and production stylesheet,
a private server bound to port 0, and invented data. Frames:

- [Desktop board](1440-board.png)
- [Desktop task list](1440-task-list.png)
- [390 px phone board](390-board.png)
- [390 px phone task list](390-task-list.png)
- [Machine-readable assertions](geometry.json)

The report and JSON record are committed. The four PNGs remain local capture
artifacts under the repository's existing `evidence/**/*.png` ignore rule.
All four PNGs were inspected visually. Old staffed and legacy completions
are absent from the Done column, a recent completion stays, and both lists
retain the old rows. The geometry record also checks there were no page errors.

Other commands, under fresh sandbox variables:

```sh
bun x tsc --noEmit
bun run lint <changed TypeScript files>
LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json \
  LLV_PRIVACY_OCR_LANGUAGES=eng+ukr \
  bun scripts/privacy-publication-gate.ts \
  --base <merge-base with origin/main> --check-commits --require-known-values
git diff --check
```

Lint passed with four existing unused-variable warnings. Two narrow lint
annotations retain the existing layout identity cache in `useBands`; task
visibility does not depend on that cache. Type checking and the privacy gate
passed. A combined sandbox run also passed the final command/projection changes:
64 tests across done visibility, board limit and kanban model.

## Files changed

- `src/lib/tasks/types.ts`
- `src/lib/tasks/completion.ts`
- `src/lib/tasks/boardVisibility.ts`
- `src/lib/tasks/commands.ts`
- `src/lib/tasks/ghostSettlement.ts`
- `src/lib/tasks/revision.ts`
- `src/lib/tasks/store.ts`
- `src/app/api/tasks/route.ts`
- `src/lib/mcp/bindings.ts`
- `src/components/scheme/taskBands.ts`
- `src/components/kanban/useBands.ts`
- `src/components/kanban/kanbanModel.ts`
- `src/lib/tasks/doneVisibility.test.ts`
- `src/lib/tasks/boardTaskLimit.test.ts`
- `src/lib/tasks/ghostSettlement.test.ts`
- `src/lib/mcp/taskBoardVisibility.integration.test.ts`
- `src/components/scheme/taskBands.test.ts`
- `src/components/kanban/kanbanModel.test.ts`
- `src/components/kanban/issue1695Evidence.fixture.tsx`
- `src/components/kanban/kanbanBoard.browser.test.tsx`
- This report and `geometry.json` in `evidence/board-done-retention/`

Four additional local PNG capture artifacts were produced in that directory.

## Verification boundaries

No deployment, hosted CI or live-state validation was performed. No full
production build or three-day wall-clock soak was run. Timestamp boundary and
clock-driven reprojection were tested with controlled timestamps; rendered
captures show desktop and phone behavior against the fixture. Other runtime,
service-tier, spawn, pipeline and role-registry lane files were untouched.
