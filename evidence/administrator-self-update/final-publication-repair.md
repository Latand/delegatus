Publication repair after the accepted change at `29f2fc5c94`.

`src/lib/selfUpdate/routes.test.ts:962` supplied a `fell-back` error without the required `revision` field. The fixture now records `tipSha.slice(0, 7)`, identifying the failed candidate as the real writers in `bin/launcher-relaunch.mjs` do. The runtime implementation and preceding work are preserved.

The typecheck compares two fresh tracked exports of the accepted commit, overlaying only the repaired test in the second export. Both use the same dependencies, Bun command, default 11264 MiB compiler heap and incremental configuration, with no existing compiler cache or build output. Generated output stays in the exports. Each command receives fresh HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, NODE_ENV=test, a private runtime-host socket and a closed Viewer control URL.

Heavy commands run sequentially as `LLV_OWNED_RUN_TIMEOUT_MS=600000 bash "$GATE_WRAPPER" --record "$STAGE_TMP/<run>.log" bash "$RUN" "$RUN_ROOT" "$EXPORT" <command>`. The supplied wrapper is gate-slot.sh from release `34b741354731`. Each recording receives one native `wait_for_check` call through terminal cleanup. Raw logs, receipts and source hashes are retained privately under the stage evidence's `publication-type-repair/` directory.

| Run | Command | Exit | Counts |
| --- | --- | ---: | --- |
| type-repair-before | `bunx tsc --noEmit` | 2 | One TS2322 diagnostic, reproducing the publication refusal. |
| type-repair-after | `bunx tsc --noEmit` | 0 | Zero TypeScript diagnostics. |
| type-repair-lint | `bun run lint src/lib/selfUpdate/routes.test.ts` | 0 | One code file; zero errors, zero warnings. |
| type-repair-routes | `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts` | 1 | 128 passed, two failed, 801 assertions across 130 cases. |

The baseline compiler completed at 2026-11-12T11:24:50Z; the repaired compiler completed at 2026-11-12T11:28:45Z; the route-file run completed at 2026-11-12T11:29:49Z. All cold-recovery, bootstrap and legacy staged-build cases passed. The two failures are the same managed-short-revision and retry-after-rollback baseline failures reproduced on main in `evidence/administrator-self-update/final-fixes.md`.

Small focused lint ran without admission. Subsequent privacy and normal commit-hook results are included in the repair handover; the raw logs retain their commands, UTC start/end and actual exits.

The repaired `src/lib/selfUpdate/routes.test.ts` has SHA-256 `609017a3c9b4cbf48dc9b15bec41b22e75d44461e6676e42ac6c7fe3d45a03a9`.
