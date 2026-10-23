# Cloud batch B verification

Verification date: 2026-10-23. The first test drafts came from Codex Cloud.
Six issue pins are retained; four drafts are dropped. No production code,
workflow, or issue comment was changed.

The initial comparison used main at `95d52f4db`. Main then advanced to
`d9369c628`; the assigned branch was fast-forwarded without conflicts. Checks
on that updated tree are recorded below. Tests use Bun 1.4.0, the normal
`bunfig.toml` preload and the owned runner. Heavy checks run sequentially through
`gate-remote`, with private HOME, XDG, temporary and state directories. Browser
checks explicitly set `LLV_KANBAN_BROWSER_TEST=1` and use its configured browser.
Revert probes alter disposable exports only and restore their source afterwards.

| Issue | Kept/dropped | Revert check or named-test result |
| --- | --- | --- |
| #2386 | Dropped | The flock test still passes with `bin/cli.mjs` from `efd43fc7c^` (exit 0). It checks normal shutdown while the test is alive; it does not exercise failure/timeout teardown or a host surviving the test runner. |
| #2356 | Kept | Removing the frozen dependency-install block in `executePipelinePublication` makes the new test fail (exit 1: the hook marker is absent). Restoring it passes (exit 0). The test checks publication, advancement and one push from a worktree without dependencies. |
| #2319 | Dropped | Disabling local-output head admission and the behind-reviewed-head diagnostic still passes the draft (exit 0). Its PR head already equals `lastPassedCommit`, so the reported head mismatch is absent. |
| #2299 | Kept | This issue reports a red test. The named `columns balanced` browser case passes with its gate enabled (exit 0); the DOM pin verifies all four current `.pb-name` elements. No revert check is required for this issue. |
| #2296 | Kept | This issue reports red tests. All four named removal/recovery cases now pass in the full account suite (exit 0). The additional pin verifies the seeded rollout after closing and reopening the registry. No revert check is required. |
| #2292 | Dropped | The supplied runtime-selection helper test does not exercise MCP launcher-crash recovery. The original issue path matches no test (exit 1); the named case moved to `src/lib/monitor/seatTickController.policy.test.ts` and passes there (exit 0). |
| #2290 | Dropped | The SIGTERM draft still passes with `bin/cli.mjs` from `efd43fc7c^` (exit 0). It exercises normal launcher shutdown rather than the reported harness teardown failure. |
| #2279 | Kept | This issue reports a red test. The named tone-matrix case and the additional neutral-paused-dot pin pass (exit 0). No revert check is required. |
| #2276 | Kept | This issue reports red tests. The named menu and fail-edge DOM cases pass, as does gated `#1695 K5a` (exit 0). The old `#1743` block no longer exists and was not run. Three other DOM failures reproduce on base; details follow. No revert check is required. |
| #2259 | Kept | This issue reports red tests. All five named startup cases pass in the full instrumentation suite (exit 0). The new pin also checks retained host diagnostics and home-path redaction. No revert check is required. |

Refs #2356 — already fixed on main, pinned

Refs #2299 — already fixed on main, pinned

Refs #2296 — already fixed on main, pinned

Refs #2279 — already fixed on main, pinned

Refs #2276 — already fixed on main, pinned

Refs #2259 — already fixed on main, pinned

## Commands and exit codes

Rows show the individual commands executed inside sequential `gate-remote --`
batches. Each test starts with `setsid` and stdin from `/dev/null`. A batch's
transport exit 0 does not replace its individual test results. The initial
batches finished with `RAN_COUNT=10`, `5`, `8` and `5`, respectively.

All ten `gh issue view <issue> --json number,title,body,state` reads exited 0.
Each supplied patch was applied with `git apply`: all initially exited 0 except
#2290 (exit 1, overlapping insertion context with #2386). Reversing #2386 then
applying #2290 exited 0; a three-way reapplication of #2386 exited 1 because the
index was unchanged. Both test blocks were combined for verification and both
were subsequently dropped. `bun install --frozen-lockfile` exited 0.

Initial tree, including all draft tests:

| Command | Exit | Result |
| --- | --- | --- |
| `bun test bin/cli.exposure.integration.test.ts` | 0 | 23 pass |
| `bun test src/lib/pipelines/parkedPublication.test.ts` | 0 | Isolated wrapper passes |
| `bun test src/lib/forge/autoMerge.test.ts` | 0 | 60 pass |
| `bun test src/components/pipelines/PipelineBlock.dom.test.tsx` | 0 | 23 pass |
| `bun test src/lib/accounts/codex.test.ts` | 0 | 36 pass |
| `bun test bin/server-runtime.test.ts` | 0 | 32 pass |
| `bun test src/components/pipelines/PipelineStrip.render.test.tsx` | 0 | 17 pass |
| `bun test src/components/kanban/KanbanStages.dom.test.tsx` | 1 | 40 pass, 2 pre-existing failures |
| `bun test src/components/kanban/KanbanPipelines.dom.test.tsx` | 1 | 32 pass, 1 pre-existing failure |
| `bun test src/instrumentation.test.ts` | 0 | 47 pass |

Revert probes and focused checks on the initial tree:

| Source condition | Command | Exit |
| --- | --- | --- |
| Historical CLI | `bun test bin/cli.exposure.integration.test.ts -t 'a CLI stopped under flock'` | 0 |
| Historical CLI | `bun test bin/cli.exposure.integration.test.ts -t 'SIGTERM reaps the checkout'` | 0 |
| Head compensation removed | `bun test src/lib/forge/autoMerge.test.ts -t 'a disabled-publication fix then passing review'` | 0 |
| Dependency preparation removed | `env LLV_PARKED_PUBLICATION_CHILD=1 bun test src/lib/pipelines/parkedPublication.test.ts -t 'a passed read-only stage with no node_modules publishes and advances'` | 1 |
| Restored source | Same publication command | 0 |
| Original issue path | `bun test src/lib/monitor/seatTickController.test.ts -t 'repeated real launcher child crashes'` | 1 (no matching test) |
| Moved case | `bun test src/lib/monitor/seatTickController.policy.test.ts -t 'repeated real launcher child crashes'` | 0 |
| New menu and original case | `bun test src/components/kanban/KanbanStages.dom.test.tsx -t "a pipeline card's one menu keeps Priority\|the lane row's head opens Stages"` | 0 (2 pass) |
| Original fail-edge case | `bun test src/components/kanban/KanbanPipelines.dom.test.tsx -t 'a fail edge takes no slot'` | 0 |
| Browser gate enabled | `env LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx -t 'columns balanced'` | 0 |
| Browser gate enabled | `env LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx -t '#1695 K5a'` | 0 |
| Initial tree | `bunx tsc --noEmit` | 0 |

The publication-child variable selects the actual cases inside that file's
isolation wrapper. Its normal owned-runner preload remains enabled.

## Existing DOM failures

Two full-file baseline runs and a second branch run gave matching failures:

| Command | Base run 1 | Base run 2 | Branch run 2 |
| --- | --- | --- | --- |
| `bun test src/components/kanban/KanbanStages.dom.test.tsx` | 1 | 1 | 1 |
| `bun test src/components/kanban/KanbanPipelines.dom.test.tsx` | 1 | 1 | 1 |

`KanbanStages.dom.test.tsx` fails both variants of “a failed terminal budget card
sends a bounded revision-checked grant”: the expected “Review again” control is
absent. Base has 39 passing cases and branch has 40, including the new menu pin.

`KanbanPipelines.dom.test.tsx` fails “an open card whose lane finished and whose
work is stopped with no reason still says so in its state line”: it renders
“Done · 5m ago” instead of the expected stopped reason. Both sides have 32 passing
cases. The issue's named fail-edge case passes on both sides.

## Updated-main verification

The following checks were repeated after the fast-forward. The full DOM suites
retain exactly the three baseline failures described above. Browser cases run
with their gate explicitly enabled.

| Source condition | Command | Exit |
| --- | --- | --- |
| Retained tests | `bun test src/lib/pipelines/parkedPublication.test.ts` | 0 |
| Retained tests | `bun test src/lib/accounts/codex.test.ts` | 0 (36 pass) |
| Retained tests | `bun test src/instrumentation.test.ts` | 0 (47 pass) |
| Retained tests | `bun test src/components/pipelines/PipelineBlock.dom.test.tsx` | 0 (23 pass) |
| Retained tests | `bun test src/components/pipelines/PipelineStrip.render.test.tsx` | 0 (17 pass) |
| Retained tests | `bun test src/components/kanban/KanbanStages.dom.test.tsx` | 1 (40 pass, 2 baseline failures) |
| Unchanged main tests | `bun test src/components/kanban/KanbanStages.dom.test.tsx` | 1 (39 pass, same 2 failures) |
| Related unchanged suite | `bun test src/components/kanban/KanbanPipelines.dom.test.tsx` | 1 (32 pass, 1 baseline failure) |
| Unchanged main tests | `bun test src/components/kanban/KanbanPipelines.dom.test.tsx` | 1 (32 pass, same failure) |
| Browser gate enabled | `env LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx -t 'columns balanced'` | 0 |
| Browser gate enabled | `env LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/kanbanBoard.browser.test.tsx -t '#1695 K5a'` | 0 |
| Moved case | `bun test src/lib/monitor/seatTickController.policy.test.ts -t 'repeated real launcher child crashes'` | 0 |
| Dependency preparation removed | `env LLV_PARKED_PUBLICATION_CHILD=1 bun test src/lib/pipelines/parkedPublication.test.ts -t 'a passed read-only stage with no node_modules publishes and advances'` | 1 |
| Restored source | Same publication command | 0 |
| Updated tree | `bunx tsc --noEmit` | 0 |

The repeat campaign completed with `RAN_COUNT=15` and transport exit 0; its four
full-file DOM exits and its induced publication failure match their expected
outcomes. The ten issue requirements were read again with exit 0 for each and
were unchanged. `git fetch origin main`, `git merge --ff-only origin/main`,
`git diff --check` and local `bun run privacy:check` exited 0. The final
commit-hook outcome and the post-commit publication scan are recorded in the
stage report.
