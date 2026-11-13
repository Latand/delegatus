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

The request's action route and canonical body are reused. A retry after a pre-admission no-effect refusal applies once under the same key; a stored terminal no-effect receipt remains no effect across replay and restart. No new identity is created automatically for an uncertain action. Verification bounds are kept in the existing request ledger, including across process restarts, lease replacement and claim release. The service remains the sole owner of action outcomes. The finality clarification below supersedes the earlier cross-message blocker.

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
| Expanded action file, including emission-boundary and old-record compatibility cases | 0 | 34 pass, 0 fail, 189 assertions |
| `gate-slot.sh bun test --timeout=60000 src/lib/externalRelay/runner.test.ts` | 1 | 334 pass (including one expected failure), 4 skip, 7 fail, 3290 assertions |
| Current main, same file selecting all seven failures | 1 | 0 pass, 7 fail, 82 assertions; all match |
| Whole-file privacy gate, all 14 lane files | 0 | PASS |
| Full runner member-retry reproduction, with `test.failing` removed in the scratch copy; renewed with the final two-message input | 1 | 0 pass, 1 fail, 8 assertions; both request route and call identity differ |
| `gate-slot.sh bunx tsc --noEmit --incremental false` | 2 | One new test assertion overload error; fixed with explicit `toBeUndefined` and string branches. The final hook renews types and tests after that correction |

At that revision the member-retry reproduction was marked `test.failing` because a fresh member request supplied no link to the earlier action. The finality clarification below supersedes that interpretation. No fuzzy matching by arguments or message text is added.

The final commit's unmodified pre-push hook is run once after commit; its actual exit, source digests and complete output are retained in stage evidence and reported in the stage result. No hook result is claimed here before that run.

## Finality clarification

The member-retry regression is now an ordinary test of two separate member requests: a terminal no-effect receipt for the first, then one applied action under the second request's new identity. A companion runner case loses the response after an effect and refuses the saved-outcome read; its expected answer names the verification failure and never reports not done. Existing recovery, budget and deadline regressions are unchanged. The report explains why same-key reuse across separate member messages is deferred and unnecessary for safety under authoritative no-effect finality.

Verification for this revision is incomplete. The explicit runner-file command was launched once in a scratch export with isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, but its log was mistakenly placed under retained evidence. The native waiter refused that location because it requires a log under the stage temporary root. The result is unknown; the run is preserved without polling or restarting, as the check policy requires. Further heavy checks and the final-commit pre-push invocation are deferred while that run is unresolved; earlier results above do not verify this revision.
