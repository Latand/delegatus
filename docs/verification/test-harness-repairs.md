# Test harness repairs

Verified on 2026-10-22, starting from `351d63b1` (includes minimum-SQLite
PR #3183). Tests ran in scratch exports with a fresh HOME, XDG_CONFIG_HOME,
TMPDIR and LLV_STATE_DIR for each invocation, and
LLV_VIEWER_CONTROL_URL pointed at a closed loopback port. Heavy commands ran
one at a time through the stage-supplied `scripts/gate-slot.sh` wrapper.

## Causes and controls

| Case | Starting revision | Repair and negative control |
| --- | --- | --- |
| A: Telegram report admission | Three passes, two failures before reservation: the registry fixture lacked the batch writer. | Implement the current batch-writer and asynchronous failure methods. Both launches must return the expected terminal account-failure receipt. Giving the report Computer Use makes the capability test fail; classifying the service caller as anonymous makes the team test fail. |
| B: MCP seed | All 29 existing cases already pass. Commit `1aef6f0f4` had removed the state-root override after static imports. | Preserve that fix and assert the shared store root, 1,037 tasks, 900 pipelines, 100 tombstones, 37 distinct capabilities and a real executor call. Restoring the old override reproduces the reported setup failure. Rejecting authenticated executor calls makes the new seed-contract test fail after setup. |
| C: repeated file cleanup | The exact minimum-SQLite repetition command passes twice, then fails reading the removed child ledger. | Renew isolation and child ownership for each repetition. Await child teardown before releasing its root. New child-process regressions fail on base and pass after repair, including detection and cleanup of a child leaked during the second repetition. |
| D: bounded retention | All three assertions execute, but 1,040 durable revisions take 10.418 seconds and exceed the default five-second timeout. | Give this test the same 60-second budget as minimum-SQLite CI. Keep every revision and assertion. |

The seeder also announced readiness before verifying its counts. A new split-root
child fixture reproduces that failure on base: the seed throws, but readiness
already exists. Readiness now follows successful verification and connection
closure; the regression requires the failure and absence of readiness together.

The existing temp-directory cleanup test stripped the signal-domain capability
needed for its nested runner. Preserving that one capability exposed another
base failure: importing the Codex feature fixture resolved memory state before
the preload claimed its private root, leaving an unowned-state directory behind.
The preload now imports that fixture after isolation. The existing assertion
that the original temporary directory is empty remains intact and passes.

## Shared surfaces

`src/lib/agent/spawnParent.ts` consumes the registry batch-writer callback; `src/lib/agent/spawnCommand.ts`
consumes the asynchronous terminal-failure methods. The report fixture executes
the callback and preserves the production admission path. The sole consumer of
`src/lib/testing/testChildren.ts:beginTestChildOwnership` is `test-preload.ts`, which now owns its returned
teardown. The state-writer seeder is shared by `src/lib/mcp/writerConcurrencyChild.ts`, the
benchmark and `src/lib/mcp/taskExecutor.test.ts`; all receive readiness after validation.
Repairs are confined to harnesses.

## Verification commands

Each line below is the command passed to the gate wrapper, in a fresh sandbox.
The base and head comparisons use identical isolation. Negative controls modify
only the scratch copy and are restored before final verification.

```sh
bun test src/lib/telegram/reportSpawn.test.ts
bun test src/lib/mcp/taskExecutor.test.ts
bun test src/lib/testing/testChildren.test.ts
bun test src/lib/testing/testGitIsolation.test.ts
bun test src/lib/tempDirs.test.ts
bun test --preload ./src/lib/state/minimumSqlite.preload.ts src/lib/state/hotStateStores.sqlite.test.ts --test-name-pattern 'workflows serialize' --rerun-each=2
bun test src/lib/state/hotStateStores.sqlite.test.ts
bun test --preload ./src/lib/state/minimumSqlite.preload.ts src/lib/state/hotStateStores.sqlite.test.ts
bunx tsc --noEmit
```

The eight test invocations above pass 113 cases: 5 report-spawn, 31 executor,
8 child-ownership, 7 Git-isolation, 4 temp-directory, 2 repeated workflow,
28 native hot-state and 28 minimum-SQLite hot-state cases. Retention completes
in 9.391 seconds on native SQLite and 11.248 seconds on SQLite 3.39.4 under
the owned runner; these are timeout-budget observations, with no performance
claim. The pre-push hook also runs types, lint, privacy and its scoped tests.
