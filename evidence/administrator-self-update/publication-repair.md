Publication repair for the accepted implementation at `602255c6`.

The publication typecheck reported TS2352 because `installationPolicy.child.ts` asserted that an incomplete dependency object was `ServiceDeps`. The fixture now supplies every required dependency through a typed value. Unused effects throw if reached; read-only lookups return fixture-owned empty results. The fixture’s fixed clock, isolated state and update-policy assertions remain in place.

The repair checks use a scratch export of the accepted commit, then overlay the repaired fixture. Each command receives isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, NODE_ENV=test, a 4096 MiB heap for focused test/lint runs (11264 MiB for the normal full typecheck), a private runtime-host socket and a closed Viewer control URL. Heavy checks run sequentially through the pipeline-supplied gate-slot.sh at release `34b741354731`, each with a fresh recorded log and one wait_for_check call. Raw logs are retained in the stage evidence under `publication-repair/`.

The repaired fixture digest is recorded in `source-digests.json`. Original check results remain in `checks.md`.

Each recorded command used `bash "$GATE_WRAPPER" --record "$STAGE_TMP/<log>.log" bash "$RUN" <run> <command>`, with a 600000 ms execution allowance. Full typecheck reruns set `REPAIR_NODE_OPTIONS=--max-old-space-size=11264`.

| Run | Command | Exit | Counts / result |
| --- | --- | ---: | --- |
| `repair-types-before` | `bunx tsc --noEmit` | 134 | 4096 MiB heap exhausted; compiler did not complete. |
| `repair-types-before-2` | `bunx tsc --noEmit` | 2 | 11264 MiB heap; 1 TS2352 diagnostic, matching the publication refusal. |
| `repair-types-after` | `bunx tsc --noEmit` | 0 | 11264 MiB heap; 0 TypeScript diagnostics. |
| `repair-process-test` | `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts --test-name-pattern 'a saved automatic preference stays blocked across real Viewer-service processes'` | 0 | 1 passed, 0 failed, 124 filtered out, 7 assertions; 3 real service processes. |
| `repair-lint` | `bun run lint src/lib/selfUpdate/__fixtures__/installationPolicy.child.ts` | 0 | 1 changed code file; 0 errors, 0 warnings. |

The first compiler run exited 134 at the locally selected 4096 MiB heap limit. It was reconciled before retry: the command had exited and the gate had cleaned up. The project gate configures a separate 14 GiB check service and normally supplies an 11264 MiB compiler heap. The retry used that project setting and reproduced the original diagnostic; the repaired fixture then passed the identical compiler command. No check or hook was disabled.

The focused regression drives the existing route test and its child fixture through two disabled launches and one re-enabled launch, reading the same persisted automatic-update preference. The fixture change passes that runtime case as well as the compiler’s complete dependency contract.

These wrappers completed on 2026-11-12, through 2026-11-12T07:53:13Z. Final whitespace, publication-privacy and commit-hook results are included in the handover reply and retained logs.
