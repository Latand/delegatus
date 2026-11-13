# Relay action outcome verification

All action calls in these checks target an ephemeral loopback fake. Production state, messages and actions are untouched. Tests execute in scratch exports with compatible installed dependencies shared read-only. The package manifest and lockfile are unchanged from the installed inputs.

Each explicit test invocation selects one file. The installed `scripts/gate-slot.sh` records execution, and the native `wait_for_check` reads its terminal exit once. HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR point into a fresh private scratch root; LLV_VIEWER_CONTROL_URL points at closed loopback port 1. Heavy commands are started one at a time; the unmodified publication hook owns its standard child checks. Complete command outputs and source digests are retained in private stage evidence; public commands below omit private machine paths.

| Command | Exit | Counts |
| --- | --- | --- |
| `git fetch origin main` | 0 | initial comparison: 2 local commits, 40 main commits |
| `git merge --no-edit origin/main` | 0 | one merge commit, no conflicts |
| Baseline: `gate-slot.sh bun test --timeout=60000 src/lib/externalRelay/actionOutcome.test.ts` | 1 | 0 pass, 10 fail, 10 assertions, one file |
| Intermediate implementation: same explicit test command | 0 | 20 pass, 0 fail, 117 assertions, one file |
| Intermediate `bun run lint` with nine changed TypeScript files | 0 | 9 files, no diagnostics; the durable-bound change is checked in the final hook |
| Intermediate privacy gate with all changed files | 0 | 10 files, no findings |
| Renewed privacy gate after group-copy and evidence changes | 0 | 11 files, no findings |
| `gate-slot.sh bunx tsc --noEmit --incremental false` before the durable-bound change | 0 | no diagnostics; final hook renews types on the committed source |
| Final `gate-slot.sh bunx tsc --noEmit --incremental false`, including durable bounds | 0 | no diagnostics |
| Expanded verifier matrix, explicit actionOutcome.test.ts | 0 | 23 pass, 0 fail, 126 assertions |
| Same file after durable bounds were introduced | 0 | 25 pass, 0 fail, 137 assertions |
| Focused relay runner command below | 0 | 6 pass, 338 filtered, 0 fail, 48 assertions |
| `gate-slot.sh bun test --timeout=60000 src/lib/externalRelay/runner.test.ts` | 1 | 333 pass, 4 skip, 7 fail, 3322 assertions |
| Main comparison: same file, selecting the seven failed cases | 1 | 0 pass, 331 filtered, 7 fail, 82 assertions; all seven match |
| Final actionOutcome.test.ts, including restart and refusal guards | 0 | 26 pass, 0 fail, 143 assertions |
| Final lint, all ten TypeScript files | 0 | 10 files, 0 errors, 2 existing unused-variable warnings in store.ts |
| Final privacy gate, all changed files | 0 | 13 files, 0 findings |
| Final fetch and `git rev-list --left-right --count HEAD...origin/main` | 0 | 3 local commits, 0 main commits |
| `git diff --check` | 0 | no whitespace errors |

The initial ten failures cover the four required behaviours with and without a three-second event-loop stall and two current-service refusal behaviours. The final matrix also probes shared-deadline seams, request-lifetime reserve, mismatched response identity/effect, changed arguments/tool under a saved key, lease loss, receipt recovery after a real service restart and the terminal no-effect fence. A slow worker and a disconnected worker are released at an acknowledged barrier independently of status reads.

The request's action route and canonical body are reused. A retry after a pre-admission no-effect refusal applies once under the same key; a stored terminal no-effect receipt remains no effect across replay and restart. No new identity is created automatically for an uncertain action. Verification bounds are kept in the existing request ledger, including across process restarts, lease replacement and claim release. The service remains the sole owner of action outcomes. The full new-member reproduction below exposes the missing cross-message guarantee; acceptance remains blocked on that contract.

The unmodified final-commit pre-push hook is invoked after committing. Its terminal result and any repository baseline findings belong to the stage report, because adding its result here would change the commit it checked.

Focused delivery command:

```sh
bash scripts/gate-slot.sh bun test --timeout=60000 src/lib/externalRelay/runner.test.ts \
  --test-name-pattern '^trigger (lost|outcome_unknown) then'
```

The complete runner file's seven failures reproduce on origin/main with the same fresh isolation: five historical prompt-hash snapshots and two document-path fixture cases. The six new delivery scenarios pass. Those pre-existing failures are retained as baseline evidence; no unrelated prompt snapshots or document policy were changed. The final publication hook compares its own failing samples against main.

## Review fix round

Three local defects are repaired: possible emission is durable before the initial POST, restored calls spend the original verification budget before sending, and pending shares the initial action deadline. The request ledger writer, claim/release and pruning paths preserve the dispatch marker; the runner and owner-service adapter forward the same budget callback. Pre-existing records without the marker also require recovery because their bounds were saved after uncertainty. No change to the external wire is made.

| Command | Exit | Counts |
| --- | --- | --- |
| `git fetch origin main` followed by `git merge --no-edit origin/main` | 0 | one unrelated monitor update merged |
| Before fixes: `gate-slot.sh bun test --timeout=60000 src/lib/externalRelay/actionOutcome.test.ts --test-name-pattern 'restart and authorization\|real client restarts\|pending action status'` | 1 | 0 pass, 4 fail, 15 assertions |
| After fixes: explicit `actionOutcome.test.ts` | 0 | 30 pass, 0 fail, 175 assertions |
| Final action file, including emission-boundary and old-record compatibility cases | 0 | 34 pass, 0 fail, 189 assertions |
| `gate-slot.sh bun test --timeout=60000 src/lib/externalRelay/runner.test.ts` | 1 | 334 pass (including one expected failure), 4 skip, 7 fail, 3290 assertions |
| Current main, same file selecting all seven failures | 1 | 0 pass, 7 fail, 82 assertions; all match |
| Whole-file privacy gate, all 14 lane files | 0 | PASS |
| Full runner member-retry reproduction, with `test.failing` removed in the scratch copy | 1 | 0 pass, 1 fail, 8 assertions; both request route and call identity differ |

The committed member-retry reproduction is marked `test.failing` to preserve the known contract defect. Its two normal runner entries exercise request claims, leases, recorded tool outcomes, terminal claims and exactly one fake effect. This expected failure does not satisfy acceptance 3: a fresh member request supplies no link to the earlier action. A contract that safely reauthorizes redelivery of the original identity is still required, and the agreed lane constraint excludes inventing a new cross-turn identity. No fuzzy matching by arguments or message text is added.

The final commit's unmodified pre-push hook is run once after commit; its actual exit, source digests and complete output are retained in stage evidence and reported in the stage result. No hook result is claimed here before that run.
