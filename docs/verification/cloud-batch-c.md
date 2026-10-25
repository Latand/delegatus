# Cloud batch C regression pins

The first test drafts came from Codex Cloud, task `d7feabf4`. Each of the five
supplied diffs applies cleanly with `git apply` to main at
`adce5764927f7e838f20070cd2968128912e861c`. Verification on 2026-10-23 used that
base plus the four retained test changes in this commit.

| Issue | Decision | Coverage and revert check |
| --- | --- | --- |
| #3245 | Kept | `src/lib/limits.test.ts:1390` adds the exact `.500Z` rounding boundary and asserts that the provider read sees the frozen clock. Removing that test's `setSystemTime(new Date(now))` makes all four weekly-only cases fail (exit 1). The restored file passes in three time zones. |
| #2991 | Kept, startup defect only | `src/lib/runtime/startup.quarantine.test.ts:108` combines a missing rollout with an unrelated healthy adoption. Both are attempted once, the missing rollout is terminal, and no retry file remains. Replacing `codexBootAdoptionRetired` with `return false` leaves a retry file and fails the pin (exit 1). The full file also exercises retirement across real process restarts. |
| #2896 | Kept | `src/lib/state/pipelineControllerIndex.owner.test.ts:40` verifies that an MCP reader leaves a partially installed optional index alone. Removing the `mayRunStateStartupMutation` guard installs four extra schema objects and fails the pin (exit 1). Existing coverage verifies authorized installation, older-writer triggers, and hook temporary-root fallback. |
| #2742 | Dropped | The supplied test asserts the existing queued-send containment flags. The issue requests authoritative per-input identity, combined-frame evidence, and restart/delivery validation before batching returns. That work remains open in `docs/design/seat-inbox-coalescing.md`, section 1. A containment test cannot establish that outcome; no pin or revert check is retained for this issue. |
| #2323 | Kept | `bin/mcp-server.test.ts:1202` exercises a child exiting after `ECONNREFUSED`, recovery over the same stdio connection, retained tool discovery, and a successful subsequent call. Replacing the launcher's child-exit recovery with `process.exit(code ?? 1)` loses response 3 and fails the pin (exit 1). Cleanup also handles an already-exited launcher. |

The #2991 pin covers the reported repeating missing-rollout adoption. The wider
incident's slow board reads, control latency, and deployment validation remain
outside this pin. The #2896 addition covers MCP startup ownership; its other
acceptance paths use the existing tests named below. These references do not
close either issue.

Refs #3245 — already fixed on main, pinned.

Refs #2991 — already fixed on main, pinned (missing-rollout adoption).

Refs #2896 — already fixed on main, pinned (MCP startup ownership).

Refs #2323 — already fixed on main, pinned.

## Verification procedure

All twelve heavy checks run sequentially inside one
`gate-remote -- python3 -c "$CAMPAIGN" "$REVERT_PLAN"` invocation, admitted by
the stage's installed `gate-slot.sh`. The table lists the commands that campaign
executes. Each command starts with `setsid` and stdin from `/dev/null`, with
fresh private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, and `LLV_STATE_DIR` directories
and `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. The repository's normal test
preload stays enabled. Typecheck additionally sets
`NODE_OPTIONS=--max-old-space-size=8192`.

For each revert check, the campaign saves the named source bytes, applies only
the replacement described above, runs the filtered test, restores the saved
bytes in `finally`, and asserts byte equality before continuing. All mutations
occur in the disposable remote export. The assigned checkout contains no
production source changes. The campaign reports one result per command and a
final `RAN-COUNT 12`.

| Command | Condition | Exit | Result |
| --- | --- | --- | --- |
| `bun test src/lib/limits.test.ts -t 'weekly-only Codex account charts'` | #3245 clock freeze removed | 1 | Expected failure, 4 failed cases |
| `bun test src/lib/runtime/startup.quarantine.test.ts -t 'a missing rollout is retired once'` | #2991 terminal predicate disabled | 1 | Expected failure, retry file remains |
| `bun test src/lib/state/pipelineControllerIndex.owner.test.ts -t 'an MCP reader does not finish'` | #2896 ownership guard removed | 1 | Expected failure, extra schema objects |
| `bun test bin/mcp-server.test.ts -t 'a child that exits on ECONNREFUSED'` | #2323 child exit propagated | 1 | Expected failure, response 3 times out |
| `TZ=UTC bun test src/lib/limits.test.ts` | Restored source | 0 | 67 passed |
| `TZ=America/Los_Angeles bun test src/lib/limits.test.ts` | Restored source | 0 | 67 passed |
| `TZ=Europe/Kyiv bun test src/lib/limits.test.ts` | Restored source | 0 | 67 passed |
| `bun test --timeout=60000 src/lib/runtime/startup.quarantine.test.ts` | Restored source | 0 | 15 passed |
| `bun test --timeout=60000 src/lib/state/pipelineControllerIndex.owner.test.ts` | Restored source | 0 | 2 passed |
| `bun test --timeout=60000 bin/mcp-server.test.ts` | Restored source | 0 | 38 passed, 1 existing native integration skip |
| `bun test scripts/local-gate.test.ts -t 'gate creation'` | Existing #2896 fallback coverage | 0 | 4 passed; EROFS, EACCES, ENOENT, unrelated failures, refused fallback |
| `bun x tsc --noEmit` | Restored source, 8192 MiB heap limit | 0 | Typecheck passed |

The campaign itself returned exit 0 with all twelve command results present.
`git diff --check` and `sha256sum --check` against the recorded four test-file
hashes both returned exit 0 after verification. Publication privacy checks on
the four test files and this report each returned exit 0 (`PRIVACY GATE: PASS`).

The five original diff basenames are `cloud-3245.diff`, `cloud-2991.diff`,
`cloud-2896.diff`, `cloud-2742.diff`, and `cloud-2323.diff`. Each `git apply`
returned exit 0 in a clean export of the named base. Each corresponding
`gh issue view <number> --json number,title,body,state` returned exit 0.

The open pull requests touching the retained files were also inspected: #3269
adds due-date assertions to a different startup case, and #3236 adds delayed
startup retry/probe cases. Neither supplies or replaces this batch's pin.
