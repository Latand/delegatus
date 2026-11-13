The final two review findings are addressed in `src/lib/selfUpdate/service.ts` and `src/lib/selfUpdate/routes.test.ts`. Automatic ticks observe an accepted apply before considering automatic-policy cleanup. Recovery leaves apply-owned holds with `ApplyController` and removes older duplicate automatic metadata without releasing the hold. The bootstrap case builds its baseline in a private clone.

The new four-case regression uses real `ApplyController.begin`/`send` output, a built A→B release, fixed request IDs and a fixed observation clock. Each case starts six real service processes against the same persisted records: two pending generations, unavailable host health, verified completion or rollback, then a terminal-write crash with duplicated automatic metadata and unavailable/healthy host observations. Pending and unverified terminal states retain the drain; verified states release it. Every process refuses a new built-in update with 403 and rejects forged automatic admission. An assertion on the hold captured before the fixture's snapshot read proves that the automatic tick itself verifies and releases a terminal hold. The full routes file also retains both cold-ready cases, the successor bootstrap and the legacy staged-build case.

The branch started at `e077eb070f`; `origin/main` at `2614b079b3` was incorporated with merge commit `abde9030c8` before editing. The regression baseline is that merged tree with the final tests/child fixture overlaid and its original service retained. The main baselines are clean tracked exports of `2614b079b3`. Builds, tests and fixture writes use scratch exports; no running installation is exercised. No performance gain is claimed.

Every test file has its own recorded gate invocation, sequentially. The invocation is `LLV_OWNED_RUN_TIMEOUT_MS=600000 bash "$GATE_WRAPPER" --record "$STAGE_TMP/<run>.log" bash "$RUN" "$RUN_ROOT" "$EXPORT" <command>`. `GATE_WRAPPER` is the supplied gate-slot.sh from release `34b741354731`. Each recording received exactly one native `wait_for_check` call and a terminal cleanup result. CPU-queue waits were allowed to finish. The helper prints the exact command, UTC start/end and actual exit status. It supplies fresh HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, NODE_ENV=test, a private runtime-host socket and a closed Viewer control URL. Bun is 1.4.0. Raw logs, recorder receipts, the helper and source manifests are retained privately in the stage evidence under `final-fixes/`.

Commands used in the tables:

- `R`: `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts`
- `C`: `bun test --timeout=60000 src/lib/selfUpdate/routes.test.ts --test-name-pattern 'disabled cold processes'`
- `A`: `bun test --timeout=60000 src/lib/selfUpdate/auto.test.ts`
- `M`: `bun test --timeout=60000 src/lib/selfUpdate/managedAuto.test.ts`
- `P`: `bun test --timeout=60000 src/lib/selfUpdate/apply.test.ts`
- `D`: `bun test --timeout=60000 src/lib/selfUpdate/drain.test.ts`
- `L`: `bun run lint src/lib/selfUpdate/service.ts src/lib/selfUpdate/routes.test.ts src/lib/selfUpdate/__fixtures__/installationPolicy.child.ts`

| Run | Inputs | Command | Exit | Pass | Fail | Assertions | Filtered |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| regression-head | initial fixture | C | 1 | 0 | 4 | 4 | 126 |
| regression-head-2 | fixture dependency repaired | C | 1 | 2 | 2 | 60 | 126 |
| regression-head-3 | fixed deadline, retention still real | C | 1 | 2 | 2 | 68 | 126 |
| regression-head-4 | preliminary fixed source | C | 0 | 4 | 0 | 88 | 126 |
| regression-base | preliminary tests, pre-fix service | C | 1 | 0 | 4 | 12 | 126 |
| routes-head | preliminary fixed source | R | 1 | 128 | 2 | 777 | 0 |
| routes-main | main | R | 1 | 112 | 2 | 603 | 0 |
| routes-final | before tick-only terminal recovery | R | 1 | 128 | 2 | 777 | 0 |
| regression-base-final | prior tests, pre-fix service | C | 1 | 0 | 4 | 12 | 126 |
| auto-final | before tick-only terminal recovery | A | 1 | 103 | 6 | 700 | 0 |
| auto-main | main | A | 1 | 100 | 6 | 675 | 0 |
| managed-final | before tick-only terminal recovery | M | 0 | 98 | 0 | 544 | 0 |
| apply-final | final source | P | 0 | 28 | 0 | 162 | 0 |
| drain-final | final source | D | 0 | 4 | 0 | 10 | 0 |
| routes-custody-final | final source | R | 1 | 128 | 2 | 801 | 0 |
| regression-base-custody-final | final tests, pre-fix service | C | 1 | 0 | 4 | 16 | 126 |
| auto-custody-final | final source | A | 1 | 103 | 6 | 697 | 0 |
| managed-custody-final | final source | M | 0 | 98 | 0 | 544 | 0 |

The initial regression runs exposed fixture setup mistakes: an omitted `buildEnv`, a deadline derived from wall time, and an assertion that rejected normal retention logging. The fixture now supplies a typed dependency object, freezes the deadline and stubs unrelated pruning. Self-review added tick-only terminal recovery and renewed the affected checks. All earlier results remain recorded above. The final regression's four cases pass inside `routes-custody-final`; the identical final tests fail on the pre-fix service when the pending drain disappears. Test execution finished at 2026-11-12T11:09:09Z. Apply/drain test inputs were unchanged by the last service/fixture edit; their earlier results remain applicable.

Only two routes failures remain on final source, both reproduced on main: “managed installs refuse short revisions before runtime admission” (expected 400, received 202) and “Retry after a verified rollback rebuilds and sends another complete apply” (times out with check up-to-date, update failed, busy null).

The six automatic-controller failures also reproduce on main: final launcher admission after its Git observation for accepted-disable, manual-build, snapshot-build and quiet-build; the delayed final Git observation allowing an older switch over a newer disable; and the web-fallback pointer/switch case. These are retained baseline notes outside the two handed findings.

`lint`, `lint-final` and `lint-custody-final` ran command L in fresh isolation and each exited 0: three code files, zero errors and zero warnings. Small focused lint requires no admission. Interim and final `git diff --check` invocations also exited 0 with zero whitespace errors. Tests began at 2026-11-12T10:43:18Z; raw logs retain each run's own UTC start/end. A final fetch found no new commits on main. The stage handover supplies subsequent publication-privacy scans and normal commit-hook results. Full typecheck, build and repository-wide tests belong to publication; this fix stage runs the explicitly selected files.

Before the last tick-only change, `privacy-before-commit` ran `bun run privacy:check` and exited 0: PASS, no findings, five committed branch commits selected. `privacy-files` ran `env LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json bun scripts/privacy-publication-gate.ts --repository . --require-known-values --paths evidence/administrator-self-update/final-fixes.md src/lib/selfUpdate/service.ts src/lib/selfUpdate/routes.test.ts src/lib/selfUpdate/__fixtures__/installationPolicy.child.ts` and exited 0: four whole files, PASS, no findings. These early scans remain recorded; final scans are renewed after the last edits.

Final source SHA-256 digests:

| File | SHA-256 |
| --- | --- |
| `src/lib/selfUpdate/service.ts` | `544ae8760419210e07f49773dbeeff55ff8a939218c031918c29de674bb1b4a4` |
| `src/lib/selfUpdate/routes.test.ts` | `8773c3be57a8e0b7202daa2608c1be6ef6475460be475ab9a2fb0f3d27271637` |
| `src/lib/selfUpdate/__fixtures__/installationPolicy.child.ts` | `03c0dd22893bc15b043e311ec5214ba1bced64c53fff871ce3e1c30b9643dbd4` |
