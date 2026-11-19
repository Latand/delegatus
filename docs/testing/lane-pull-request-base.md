# Lane pull request base

Set a lane's `baseBranch` to the intended PR destination. Publication passes
that branch to `gh pr create --base`. An existing PR must have the same base,
whether publication discovers it by head or reads a linked PR by number.
If publication reports `baseRefName`, correct the PR's base and retry Publish.
Publication refuses the mismatch before advancing to review or changing the
PR body. It creates no replacement PR to conceal an existing mismatch.

## Diagnosis

Investigation on 2026-11-12 started at main commit `dfc99dce`. The incident's
original creation request explicitly supplied a predecessor branch as
`baseBranch`, with its commit as `baseRef`. The durable lane record retained
both. Creation used that configured base. Merging main into a worktree does
not change the lane's stored destination.

Current main already supplies the lane's base when creating a PR. Its adoption
check, introduced by successor verification commit `157a53fa96`, exempted
linked PRs from base verification. Discovery also filtered by base, hiding a
PR on the same head with another destination. The regression reproduces both
paths with a lane explicitly targeting `main` and an existing predecessor-base
PR. The fix applies the same base check to every read and discovers by head
before checking the base. A custom destination remains supported.

The base flows from request validation through base resolution into the lane
store. PR-link drafts copy the forge's base; conversation drafts copy the
conversation branch. Publication reads the stored value for creation,
discovery, linked verification, head retries, body refresh and recovery reads.
Those reads all pass through `ensureStagePullRequest` in
`src/lib/pipelines/stagePullRequest.ts`. No engine or stored schema changes
are needed for this verification rule.

## Verification

Commands run from a scratch source export. `$GATE` denotes the controller's
pinned `gate-slot.sh`; logs and isolated directories are below the stage's
`$TMPDIR`. Each run sets private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and
`LLV_STATE_DIR`, `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`, and
`LLV_OWNED_RUN_TIMEOUT_MS=600000`. Recorded checks are awaited once through
`wait_for_check`; their terminal receipts supply exit statuses.
The privacy commands additionally set
`LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE` to the export's committed catalog;
`$WORKTREE` denotes the assigned checkout inspected read-only by that command.
The final complete changed-source run used code revision `43ab102a02`;
the subsequent commit only adds this ledger.

| Check | Command | Exit | Counts |
| --- | --- | --- | --- |
| Regression on unchanged main | `bash "$GATE" --record "$TMPDIR/red.log" bun run test src/lib/pipelines/stagePullRequest.test.ts --test-name-pattern="lane targeting main refuses a predecessor PR base"` | 1, expected | 0 pass, 2 fail, 156 filtered, 7 assertions |
| First complete file | `bash "$GATE" --record "$TMPDIR/green.log" bun run test src/lib/pipelines/stagePullRequest.test.ts` | 1 | 156 pass, 2 fail, 1173 assertions |
| First focused run | `bash "$GATE" --record "$TMPDIR/focused.log" bun run test src/lib/pipelines/stagePullRequest.test.ts --test-name-pattern="lane targeting main\|publication creates a PR against\|a base change during"` | 1 | 4 pass, 2 fail, 154 filtered, 40 assertions |
| Corrected focused run | `bash "$GATE" --record "$TMPDIR/focused2.log" bun run test src/lib/pipelines/stagePullRequest.test.ts --test-name-pattern="lane targeting main\|publication creates a PR against\|a base change during"` | 0 | 6 pass, 0 fail, 154 filtered, 54 assertions |
| Complete file after fixture correction | `bash "$GATE" --record "$TMPDIR/final.log" bun run test src/lib/pipelines/stagePullRequest.test.ts` | 1 | 158 pass, 2 fail, 1183 assertions |
| Unchanged main, privacy-control group | `bash "$GATE" --record "$TMPDIR/baseline.log" bun run test src/lib/pipelines/stagePullRequest.test.ts --test-name-pattern="PR inspection runs the repository gate on refreshed"` | 0 | 8 pass, 0 fail, 147 filtered, 128 assertions |
| Complete unchanged main | `bash "$GATE" --record "$TMPDIR/base-full.log" bun run test src/lib/pipelines/stagePullRequest.test.ts` | 0 | 155 pass, 0 fail, 1152 assertions |
| Final complete changed source | `bash "$GATE" --record "$TMPDIR/final2.log" bun run test src/lib/pipelines/stagePullRequest.test.ts` | 0 | 160 pass, 0 fail, 1201 assertions |
| Native source commit hooks | `bun scripts/local-gate.ts pre-commit` through plain `git commit` | 0 | Staged whitespace clean; 2 TypeScript files, 0 lint errors |
| Source and commit privacy | `bun scripts/privacy-publication-gate.ts --require-known-values --repository "$WORKTREE" --base origin/main --check-commits --paths src/lib/pipelines/stagePullRequest.ts src/lib/pipelines/stagePullRequest.test.ts` | 0 | 2 complete files and commit surfaces; 0 findings |
| Integration preview | `git merge-tree --write-tree HEAD origin/main` | 0 | 0 conflicts |
| Main scope comparison | `git diff --quiet dfc99dce origin/main -- src/lib/pipelines/stagePullRequest.ts src/lib/pipelines/stagePullRequest.test.ts` | 0 | 0 changed scope files |
| Whitespace, repeated during editing | `git diff --check` | 0 | 0 findings |
| Native ledger commit hooks | `bun scripts/local-gate.ts pre-commit` through plain `git commit` | 0 | Staged whitespace clean; documentation only |
| Final whole-file and commit privacy | `bun scripts/privacy-publication-gate.ts --require-known-values --repository "$WORKTREE" --base origin/main --check-commits --paths src/lib/pipelines/stagePullRequest.ts src/lib/pipelines/stagePullRequest.test.ts docs/testing/lane-pull-request-base.md` | 0 | 3 complete files and both commits; 0 findings |

On unchanged main, both regression failures advanced the lane to review. The discovered case
created another PR; the linked case accepted the mismatched PR. The same tests
require zero PR writes on refusal, no reviewer launch, and recovery with the
same PR after its base is corrected. Additional cases check explicit `main`
and custom-base creation and a base change during head retry for same-repository
and fork PRs.

The two intermediate creation-test failures were incomplete fixtures: the
first lacked a publication summary; the next lacked the artifact directory
normally prepared by controller settlement. Supplying both made the focused
cases pass without further product changes.

The next complete run passed the six new cases but failed two existing
privacy-control cases: their sentinel scan returned `configuration_error: 1`
instead of `known_value: 1`. A fresh isolated run of all eight related cases
on unchanged main passed. The complete comparisons then passed 155 tests on
unchanged main and 160 on the changed source. The earlier two failures did not
recur; their cause remains undetermined.

Main advanced during verification to `34b7413547`, changing four profiler and
recorded-check files. The two scope files remained identical to the starting
main, and the committed change's merge preview had no conflicts. The assigned
branch retains its starting base; publication and review remain with the
pipeline controller. `src/lib/pipelines/engine.ts` is untouched.
