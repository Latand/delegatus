# Issue delivery verification

Run one test file per isolated export command through the stage-provided gate.
`G` below expands to `bash "$GATE" --record "$TMPDIR/check-<run>.log"`.
The installed `scripts/gate-slot.sh` was supplied by the controller. Each run
used a fresh HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, a closed
`LLV_VIEWER_CONTROL_URL` on loopback port 1, `LLV_GATE_RUNNER=off`, and a
600000 ms owned-run deadline. Each recorder was awaited once through
`wait_for_check`, including cleanup. The application test runner was Bun 1.4.0.

The source was exported with `bun scripts/review-export.ts HEAD`, overlaid
through a counted tar archive, and checked from scratch. Final source:
16 TypeScript files, aggregate SHA-256 `29d9ee147b834bbdda8eeb799baa9a5a9633ca44ee4d619ff958a1ce7dce915c` (sorted file-to-SHA-256
JSON, with the default JSON separators). No performance gain is claimed.

The final focused selections total **314 passing tests, 3365 assertions**.
The full repository-initialization file has one matching baseline failure:
`P2: repeated board preflight reuses the successful existing-repository Git
probes`, expected 200, received 503. The Git-only lifecycle case passes.

## Every recorded run

Counts are passing / failing tests; lint rows give diagnostic counts. Earlier
attempts are retained below, including fixture failures and baseline reads.

| Run | Command | Exit | Counts | Assertions |
|---|---|---:|---|---:|
| delivery-1 | `G bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 38 / 0 | 81 |
| delivery-store-1 | `G bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 1 | 0 / 9 | 9 |
| mcp-links-1 | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 1 | 1 / 2 | 6 |
| mcp-links-base | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts (baseline export)` | 1 | 1 / 1 | 6 |
| delivery-store-2 | `G bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 0 | 9 / 0 | 64 |
| mcp-links-2 | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 1 | 1 / 2 | 6 |
| auto-merge-1 | `G bun test --timeout=60000 src/lib/forge/autoMerge.test.ts` | 0 | 158 / 0 | 2731 |
| postmerge-binding-1 | `G bun test --timeout=60000 src/lib/forge/postMerge.taskBinding.test.ts` | 0 | 10 / 0 | 55 |
| worklinks-1 | `G bun test --timeout=60000 src/lib/forge/workLinks.test.ts` | 0 | 40 / 0 | 112 |
| done-project-1 | `G bun test --timeout=60000 src/lib/done/project.test.ts` | 0 | 31 / 0 | 122 |
| mcp-links-3 | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 1 | 1 / 2 | 6 |
| focused-lint-1 | `G bunx eslint $CHANGED_TS` | 0 | 16 files; 0 errors; 8 existing warnings | — |
| git-only-1 | `G bun test --timeout=60000 src/lib/pipelines/repositoryInitialization.test.ts` | 1 | 39 / 1 | 297 |
| git-only-base | `G bun test --timeout=60000 src/lib/pipelines/repositoryInitialization.test.ts (baseline export)` | 1 | 39 / 1 | 297 |
| mcp-links-4 | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 1 | 2 / 1 | 20 |
| delivery-2 | `G bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 47 / 0 | 94 |
| mcp-links-5 | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 0 | 3 / 0 | 23 |
| delivery-final | `G bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 47 / 0 | 94 |
| delivery-store-final | `G bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 0 | 9 / 0 | 64 |
| auto-merge-final | `G bun test --timeout=60000 src/lib/forge/autoMerge.test.ts` | 0 | 158 / 0 | 2731 |
| git-only-focused | `G bun test --timeout=60000 src/lib/pipelines/repositoryInitialization.test.ts --test-name-pattern '^D:'` | 0 | 1 / 0 | 96 |
| git-task-finishes | `G bun test --timeout=60000 src/lib/forge/autoMergeStore.test.ts --test-name-pattern 'no PR is expected'` | 0 | 8 / 0 | 36 |
| delivery-pagination | `G bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 50 / 0 | 104 |
| delivery-store-pagination | `G bun test --timeout=60000 src/lib/forge/issueDeliveryStore.test.ts` | 0 | 9 / 0 | 64 |
| task-wire-1 | `G bun test --timeout=60000 src/lib/links/taskWire.test.ts` | 0 | 3 / 0 | 19 |
| delivery-renames | `G bun test --timeout=60000 src/lib/forge/issueDelivery.test.ts` | 0 | 51 / 0 | 107 |
| focused-lint-final | `G bunx eslint $CHANGED_TS` | 0 | 16 files; 0 errors; 8 existing warnings | — |
| mcp-links-final | `G bun test --timeout=60000 src/lib/mcp/workLinks.test.ts` | 0 | 3 / 0 | 23 |

The first persistence fixture used an invalid empty completed graph; it was
corrected to a valid completed lane. The MCP fixture needed an explicit caller,
its own transcript roots and an isolated capability. The baseline MCP run
reproduced the original caller refusal before those fixture changes. No
production authentication guard was weakened.

`CHANGED_TS` is the following explicit file list:

```text
src/lib/done/candidates.ts
src/lib/forge/autoMerge.test.ts
src/lib/forge/autoMerge.ts
src/lib/forge/issueDelivery.test.ts
src/lib/forge/issueDelivery.ts
src/lib/forge/issueDeliveryStore.test.ts
src/lib/forge/landedPullRequests.ts
src/lib/forge/postMerge.taskBinding.test.ts
src/lib/forge/workLinks.ts
src/lib/mcp/server.ts
src/lib/mcp/workLinks.test.ts
src/lib/monitor/seatTickSources.ts
src/lib/pipelines/engine.ts
src/lib/pipelines/store.ts
src/lib/pipelines/types.ts
src/lib/viewerLoopMonitor.ts
```

## Other checks

| Command / procedure | Exit | Counts and result |
|---|---:|---|
| `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json bun scripts/privacy-publication-gate.ts --require-known-values --paths $CHANGED_TS` | 0 | 16 whole files; PRIVACY GATE: PASS; before final pagination and rename edits |
| `git diff --check` | 0 | No whitespace errors |
| `gh --version` and `gh api --help` | 0 | Installed gh 2.45; pagination uses `--paginate --jq @json` |
| `gh api repos/$REPOSITORY/pulls/3909 --jq '{number,merged_at,base:{ref:.base.ref,repo:{default_branch:.base.repo.default_branch}}}'` | 0 | One primary record; merged into the default branch |
| `gh api graphql -f query="$CLOSER_QUERY" -f owner="$OWNER" -f name="$REPOSITORY_NAME" -F number=3901` | 0 | The exact query from issueDelivery.ts returned one closed event, closer PR 3906, zero GraphQL errors |
| `git fetch origin main` followed by `git diff --name-only dfc99dce..origin/main` | 0 | Five main changes; no overlap with this implementation |
| `gh pr list --state open --limit 100 --json number,title,headRefName,files` and `gh pr diff <number>` | 0 | Eleven overlapping PRs inspected |
| `git merge-file -p "$CURRENT_FILE" "$BASE_FILE" "$PR_FILE"`, repeated against both the starting and final file | See below | 31 file pairs across eleven PRs; 61 existing conflict regions on each side; zero newly introduced conflicts |

The compatibility checks covered PRs 3920, 3891, 3802, 3801, 3795, 3749, 3747,
3731, 3710, 3668 and 3585. Earlier placement checks introduced 5, 2 and 4
conflicts respectively; moving the new imports and creation hook clear of
existing changes reduced the final count to zero new conflicts. Per-file
merge-file exits count conflict regions (zero means a clean merge):

| PR | File | Starting exit | Final exit |
|---|---|---:|---:|
| 3920 | `src/lib/monitor/seatTickSources.ts` | 0 | 0 |
| 3891 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3802 | `src/lib/mcp/server.ts` | 3 | 3 |
| 3802 | `src/lib/pipelines/engine.ts` | 3 | 3 |
| 3802 | `src/lib/pipelines/store.ts` | 4 | 4 |
| 3802 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3801 | `src/lib/forge/autoMerge.ts` | 0 | 0 |
| 3801 | `src/lib/pipelines/engine.ts` | 2 | 2 |
| 3801 | `src/lib/pipelines/store.ts` | 1 | 1 |
| 3801 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3795 | `src/lib/mcp/server.ts` | 1 | 1 |
| 3749 | `src/lib/mcp/server.ts` | 7 | 7 |
| 3749 | `src/lib/pipelines/engine.ts` | 3 | 3 |
| 3749 | `src/lib/pipelines/store.ts` | 1 | 1 |
| 3749 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3747 | `src/lib/forge/autoMerge.ts` | 0 | 0 |
| 3747 | `src/lib/pipelines/engine.ts` | 2 | 2 |
| 3747 | `src/lib/pipelines/store.ts` | 1 | 1 |
| 3747 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3731 | `src/lib/mcp/server.ts` | 12 | 12 |
| 3710 | `src/lib/mcp/server.ts` | 12 | 12 |
| 3710 | `src/lib/pipelines/engine.ts` | 2 | 2 |
| 3710 | `src/lib/pipelines/store.ts` | 1 | 1 |
| 3710 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3710 | `src/lib/viewerLoopMonitor.ts` | 1 | 1 |
| 3668 | `src/lib/forge/autoMerge.test.ts` | 0 | 0 |
| 3668 | `src/lib/forge/autoMerge.ts` | 0 | 0 |
| 3668 | `src/lib/pipelines/engine.ts` | 2 | 2 |
| 3668 | `src/lib/pipelines/store.ts` | 3 | 3 |
| 3668 | `src/lib/pipelines/types.ts` | 0 | 0 |
| 3585 | `src/lib/mcp/server.ts` | 0 | 0 |

Publication runs the repository's guarded commit and pre-push checks. Their
terminal results are handed over in the stage report and retained check log.
The stage ran no full test suite, build or standalone publication typecheck.


## Final local checks

| Command | Exit | Counts and result |
|---|---:|---|
| `G bun scripts/privacy-publication-gate.ts --require-known-values --paths src/lib/forge/issueDelivery.ts src/lib/forge/issueDelivery.test.ts src/lib/forge/issueDeliveryStore.test.ts docs/verification/issue-delivery.md` | 0 | Four whole files pass; thirteen other source files were byte-identical to the earlier whole-file scan |
| `git commit -m "Close delivered issues after lane pull requests land"` with the tool attribution trailer | 1 | The staged whitespace hook found one extra blank line at EOF in the new landing helper; removed before retry |

The final guard retry and the privacy rescan of this updated ledger and the
whitespace-only helper correction are recorded in the stage handoff. No test
behaviour changed after the passing focused selections.
