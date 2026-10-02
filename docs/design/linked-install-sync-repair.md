# Linked board sync repair evidence

## Root cause and reproduction

The original sender (`5e6ec38b5`, `src/lib/links/taskWire.ts`) encoded
`task.chosen ? task.text : UNTITLED_TASK_TEXT`. Automatic task creation leaves
`chosen` unset. This substituted a 13-character placeholder while transmitting
the real text stamp and the details. The receiver stored that title with an
empty assignment list; assignments deliberately stay on their owning install.
Equal-stamp merge then kept the placeholder, and a consumed cursor stopped the
row from being visited again.

The sender fix already exists in `c7e9cf128`: the current encoder sends
`task.text` regardless of `chosen`. The two-install HTTP fixture now rehearses
the original encoding on both outbound pushes and inbound answers. Its
`historical unchosen-title sender` case checks the owner's real stored title,
the placeholder on the captured wire, the unchanged text stamp, the arriving
details and owner, and the empty assignment list. Switching back to the
current encoder restores both replicas and leaves a replay unchanged.

The existing recovery test now seeds a fully consumed cursor whose peer wire
version is already 3. Before this change that cursor could suppress recovery
indefinitely: wire-version negotiation had no upgrade left to observe. A
persisted `titleRepair` cursor marker now forces one bounded scan in both
directions before normal incremental exchange resumes. Equal-stamp recovery
requires the same recorded owner, retains details and the stamp, preserves
newer edits, and deletes nothing. Owner reinstalls and rolling upgrades retain
the existing race and restart coverage.

The task's reported live symptoms match the historical sender behavior. The
actual versions and stored rows of live installs were deliberately unexamined;
this evidence establishes the mechanism with fixtures.

## Cadence and visible state

`Viewer` passes its selected project into `useFiles`. The mounted visible board
sends a bodyless `HEAD /api/files?project=...` immediately and every 15 seconds,
including when a healthy runtime stream suppresses catalog polling. The route
records presence without scanning or projecting the catalog. Hidden tabs stop
heartbeats; closing or changing projects removes the timer. Presence expires
in 30 seconds, then the schedule restores idle backoff. Overview represents
all linked projects. Opening a board also shortens a previously armed idle
sync deadline at the next scheduler tick.

Remote rows derive freshness from the received snapshot's `asOf` timestamp and
the current display clock, using the existing 15-minute expiry. Browser cases
supply deliberately incorrect `stale` flags and verify the timestamp wins.

The existing links dialog refreshes link metadata every five seconds while
visible. Outgoing peers and incoming grants show waiting, their last successful
sync time, and their specific failure. Receiving any request cannot certify
sync success. First successes and state transitions persist; quiet successes
update memory, keeping idle exchanges free of repeated disk writes. A restart
may show an older persisted success, which remains an actual success time.

## Verification

All servers are fixture children bound to loopback port 0. Tests use fresh
`LLV_STATE_DIR`, `XDG_CONFIG_HOME` and `TMPDIR` roots, and cleanup names only
recorded children. No live install was paired, restarted or repaired.

Rendered records: `evidence/linked-board-sync-health/rendered.json` and
`evidence/linked-boards-m3/geometry.json`, produced by the existing kanban
browser driver. Screenshots stay in the driver's ignored artifacts directory.

Validation commands and final counts are recorded in the stage handoff.
Live deployment, the exact version skew of the reported installs, and live repair remain unverified and outside this stage.

## Changed files

| Area | Files |
| --- | --- |
| Title recovery | `src/lib/links/boardLinks.ts`, `src/lib/links/taskApply.ts` |
| Cadence and browser heartbeat | `src/lib/links/schedule.ts`, `src/lib/links/boardPresence.ts`, `src/app/api/files/route.ts`, `src/hooks/useFiles.ts`, `src/components/Viewer.tsx` |
| Success and error reporting | `src/lib/links/client.ts`, `src/lib/links/protocol.ts`, `src/lib/links/state.ts`, `src/app/api/peer/v1/[...path]/route.ts`, `src/components/links/LinkedSettingsDialog.tsx` |
| Freshness | `src/components/kanban/RemoteAgents.tsx` |
| Locales | `src/lib/i18n/en.ts`, `src/lib/i18n/uk.ts` |
| Fixtures and regression tests | `src/lib/links/testServer.ts`, `src/lib/links/boardSync.test.ts`, `src/hooks/useFiles.snapshot.dom.test.tsx`, `src/components/links/LinkedSettingsDialog.dom.test.tsx`, `src/components/kanban/kanbanBoard.browser.test.tsx` |
| Evidence | This document, `evidence/linked-board-sync-health/rendered.json` |

## Commands and counts

Every command below was prefixed by fresh sandbox variables:

```sh
scratch=$(mktemp -d /tmp/llv-sync-check.XXXXXX)
export LLV_STATE_DIR="$scratch/state" XDG_CONFIG_HOME="$scratch/config" TMPDIR="$scratch"
```

- `bun test src/lib/links/taskSync.test.ts src/lib/links/schedule.test.ts src/lib/links/protocol.test.ts src/lib/links/runtimeState.test.ts src/lib/links/agentFeed.test.ts src/components/links/LinkedSettingsDialog.dom.test.tsx src/hooks/useFiles.test.ts src/hooks/useFiles.snapshot.dom.test.tsx`: **77 pass, 1 skip, 0 fail**. The skip is the opt-in old-release database compatibility probe.
- `bun test src/lib/links/boardSync.test.ts -t '^(?!M3 link RSS)'`: **28 pass, 0 fail**, covering the remaining two-install cases, both wire upgrade orders, restart recovery, race preservation, cadence and sync status.
- `bun test src/lib/links/boardSync.test.ts -t 'M3 link RSS and heap'`: **1 pass, 0 fail**. The first combined stress run failed its heap threshold; the quiet-success path was then changed to reuse the already authorized grant instead of rereading its file on every exchange. The isolated rerun passed, including both warmed-heap medians below the 256 KiB threshold.
- `LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx -t 'open links show waiting|collapsed read-only rows'`: **2 pass, 0 fail**; 52 assertions, no page errors. `CHROME_BIN` points to the installed Chromium binary.
- `NODE_OPTIONS=--max-old-space-size=6144 bun x tsc --noEmit`: **PASS**. One earlier unbounded run exited with signal 143 and no diagnostic; subsequent bounded runs passed.
- `git diff --name-only HEAD^ HEAD -- '*.ts' '*.tsx' | rg -v '^src/components/(Viewer\.tsx|links/LinkedSettingsDialog\.tsx)$' | xargs bun x eslint`: **PASS**, one existing unused-token warning. Linting all 20 touched source/test files reports **15 errors** in the two excluded files. ESLint's API was run on both the starting commit's text and current text at those same paths: all error counts and rules match (10 refs + 1 effect error in Viewer; 4 existing React-rule errors in the dialog).
- `bun test src/app/api/files/route.test.ts --timeout 20000`: **95 pass, 10 fail**. The identical command against a `git archive` export of the starting commit gives the same **95 pass, 10 fail**, with the identical failing tests. The default 5-second run additionally timed out its large-registry probe during concurrent checks; the 20-second runs passed that probe on both versions.

The baseline files-route failures cover six cache/projection expectations, the
old persisted snapshot schema expectation (11 versus the current 12), the
bridge-ask shape, and two repeated-poll build counts. They predate the added
HEAD handler; GET's implementation is unchanged. The unchanged lint and route
failures keep the full raw checks red. The operator accepted these baseline
exceptions in the stage continuation and directed this lane to leave them
out of scope. The comparison below confirms that this change adds none.

- `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json bun scripts/privacy-publication-gate.ts --require-known-values --check-commits --base "$(git merge-base origin/main HEAD)"`: **PASS**, including known-value fingerprints and commit attribution.


## Accepted baseline exceptions

Base commit: `4baabbec88d86b5a9a69d178e2be9881d12fa7fe`.
The continuation compared all **20 touched TypeScript files** with that
commit using ESLint's `lintText` API and the repository configuration.
Diagnostics match by rule, message heading, column and the original source
line mapped through the diff: **15 baseline errors, 15 current errors,
0 new errors**. The other 18 touched files have no lint errors; the existing
unused-token warning remains. Every listed error is on unchanged source.

| File | Base line:column | Current line:column | Rule |
| --- | --- | --- | --- |
| `src/components/Viewer.tsx` | 304:3 | 304:3 | `react-hooks/refs` |
| `src/components/Viewer.tsx` | 316:23 | 316:23 | `react-hooks/refs` |
| `src/components/Viewer.tsx` | 347:22 | 347:22 | `react-hooks/refs` |
| `src/components/Viewer.tsx` | 348:20 | 348:20 | `react-hooks/refs` |
| `src/components/Viewer.tsx` | 349:10 | 349:10 | `react-hooks/refs` |
| `src/components/Viewer.tsx` | 350:25 | 350:25 | `react-hooks/refs` |
| `src/components/Viewer.tsx` | 353:5 | 353:5 | `react-hooks/refs` |
| `src/components/Viewer.tsx` | 353:33 | 353:33 | `react-hooks/refs` |
| `src/components/Viewer.tsx` | 353:69 | 353:69 | `react-hooks/refs` |
| `src/components/Viewer.tsx` | 1212:31 | 1212:31 | `react-hooks/set-state-in-effect` |
| `src/components/Viewer.tsx` | 1688:20 | 1688:20 | `react-hooks/refs` |
| `src/components/links/LinkedSettingsDialog.tsx` | 74:18 | 75:18 | `react-hooks/immutability` |
| `src/components/links/LinkedSettingsDialog.tsx` | 110:33 | 119:33 | `react-hooks/set-state-in-effect` |
| `src/components/links/LinkedSettingsDialog.tsx` | 162:137 | 171:137 | `react-hooks/purity` |
| `src/components/links/LinkedSettingsDialog.tsx` | 179:77 | 188:77 | `react-hooks/refs` |

The continuation also repeated `bun test src/app/api/files/route.test.ts
--timeout 20000` on the current implementation and an isolated `git archive`
export of the base commit. Both give **95 pass, 10 fail**, with this exact
failure list:

- `repeated files reads reuse the pure read snapshot and retain ETag behavior`
- `SQLite health exposes the authoritative revision and no mirror, without conditional-response churn`
- `a state database incident reaches systemHealth.storage on the next read (#1870)`
- `a bridge report invalidates a warm files projection through the report collection's revision (#1870 slice 4)`
- `a cross-process SQLite pipeline commit invalidates a warm files projection`
- `a corrupt completed snapshot falls back to a cold scan and repairs persistence`
- `project query changes reuse one global scan snapshot`
- `issue 1168: the seat's open bridge ask rides the files payload and clears on the answering directive`
- `a burst of concurrent and rapid sequential polls over an unchanged corpus causes one build`
- `a project-scoped burst keeps its own representation without rebuilding the unscoped one`

The export must retain a repository identity: after extracting the base,
initialize a private Git repository in the export and give it a synthetic
origin (`https://github.com/example/sync-fixture.git`). Symlink the existing
`node_modules` into the export and use a fresh state/config/temp root per
run. An initial export without Git metadata had three additional failures
in repository-identity tests; correcting that fixture setup restores the
identical 95/10 result. No product code changed during this continuation.

Reproduction recipe (from this lane checkout; each test uses its own state):

```sh
scratch=$(mktemp -d /tmp/llv-sync-baseline.XXXXXX)
mkdir "$scratch/base"
git archive 4baabbec88d86b5a9a69d178e2be9881d12fa7fe | tar -x -C "$scratch/base"
ln -s "$PWD/node_modules" "$scratch/base/node_modules"
git -C "$scratch/base" init -q
git -C "$scratch/base" remote add origin https://github.com/example/sync-fixture.git
LLV_STATE_DIR="$scratch/current-state" XDG_CONFIG_HOME="$scratch/current-config" TMPDIR="$scratch" \
  bun test src/app/api/files/route.test.ts --timeout 20000
(
  cd "$scratch/base"
  LLV_STATE_DIR="$scratch/base-state" XDG_CONFIG_HOME="$scratch/base-config" TMPDIR="$scratch" \
    bun test src/app/api/files/route.test.ts --timeout 20000
)
```

The implementation and its **108 pass, 1 skip** targeted/rendered results
were completed in the prior attempt at the same source tree; this
continuation retained those checks and verified the accepted exceptions.
Self-review found no additional defect or scope expansion. No pull request
was opened; live installs, deployment and live repair remain unverified.

## Done-task export retention

The follow-up operator decision excludes tasks that have automatically left
the board after more than three days in Done. Both `readLogPage` and
`readScanPage` in `src/lib/links/taskFeed.ts` now call `taskShowsOnBoard` from
`src/lib/tasks/boardVisibility.ts`. That predicate owns
`DONE_TASK_BOARD_RETENTION_MS`, the strict boundary, legacy completion fallback,
new-admission and decision resurfacing, and the orchestrator-seat exception.
There is no second expiry calculation in the sender.

The same reader serves `serveTasks` pull answers and `TaskExchange` pushes,
including resync and the scheduler's pending-push probe. Skipped rows still
advance the cursor. The filter applies on the owning install, which holds the
completion and admission records. Replicas have their own completion fallback
and no owner assignments; their existing resync echo behavior remains intact.
Passing membership as true keeps manual board preferences outside this export
policy. Seat references, cached scan members and pipeline records are read
lazily only when the board predicate needs an expiry exception, so an idle
feed retains its existing revision-only path.

No receiver or deletion code changed. Absence from a log page or a full scan
keeps every stored copy and creates no tombstone. Reopening or a new admission
restores eligibility on the next task change. A fresh member decision also
restores eligibility; a decision from before expiry does not.

The added two-install HTTP cases inspect owner pushes and pull answers in both
directions. They cover initial omission, aging a previously delivered task,
suppressed later edits, full resync without removal, reopening, new admissions,
fresh versus old decisions, and continued seat-task export. Both stores retain
their tasks and tombstone counts. The feed test also checks the exact three-day
boundary, cursor advancement and preservation of manual board preferences.

Follow-up checks use the same fresh sandbox variables shown above, with a
separate `mktemp -d /tmp/llv-done-*.XXXXXX` root per command:

- `bun test src/lib/links/taskSync.test.ts src/lib/tasks/doneVisibility.test.ts`: **29 pass, 1 skip, 0 fail**. The skip remains the opt-in old-release database compatibility probe.
- `bun test src/lib/links/boardSync.test.ts -t '^(?!M3 link RSS)'`: **30 pass, 0 fail**. This includes the two new HTTP cases and all existing non-stress exchange cases, including idle CPU, row reads, writes and heap growth.
- `bun test src/lib/links/boardSync.test.ts -t 'M3 link RSS and heap'`: **1 pass, 0 fail**. Both warmed-heap growth medians stay below 256 KiB across three isolated trials with 2,000 tasks and 200 agents per side.
- `NODE_OPTIONS=--max-old-space-size=6144 bun x tsc --noEmit`: **PASS**.
- `bun x eslint src/lib/links/taskFeed.ts src/lib/links/taskSync.test.ts src/lib/links/boardSync.test.ts src/lib/links/testServer.ts`: **0 errors, 3 warnings**. All three unused-variable warnings occur on unchanged lines in the existing arrival-repair test.
- The known-value privacy gate with `--check-commits` and the merge base as `--base`: **PASS**.

Combined result: **60 pass, 1 existing opt-in skip, 0 fail**.

Self-review confirmed that the shared feed covers both exchange directions,
omission advances cursors without manufacturing deletion rows, and no other
lane's files changed. The two earlier commits remain intact; this follow-up
does not rebase or create a pull request. Live installs and deployment remain
outside the fixture-only scope.
