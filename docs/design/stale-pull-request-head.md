# Publication when a pull request head stays stale

Publication continues on fresh Git evidence after the existing bounded forge
re-reads. It does not close or reopen a pull request. Avoiding that write also
avoids an uncertain close/reopen outcome during an outage.

`src/lib/pipelines/stagePullRequest.ts` requires a settled successful publication
receipt for the accepted commit and current delivery owner/epoch. An available
pull request must pass every existing identity, state, repository and base
check. Its older head must be a commit proven to be an ancestor of the accepted
commit. A final, bounded `git ls-remote` must return exactly that commit at the
delivery branch. An unavailable forge can also defer confirmation when the same
receipt and fresh remote proof hold. Cached tracking refs supply no proof.
Ownership and target checks run again after each Git await; controller settlement
retains its existing cancellation fence. The initial lookup and the verification
after PR creation use the same proof. A body refresh still needs its exact text
read back before its write can count as confirmed.

The attempt's existing persisted `error` field records the Git confirmation and
deferred forge confirmation. No new recovery budget, schema or forge mutation
is introduced. Every subsequent active settlement reads the forge again, and a
healthy matching response clears that advisory. A completed lane's merge path
also rechecks the forge. A temporary outage can leave an unlinked delivery
without a PR; Git publication and task completion can still settle.

These refusals remain:

- A returned PR head that is divergent, absent, malformed or unavailable locally
  as an ancestor cannot explain the publication.
- A delivery branch that moved away from the accepted commit, or cannot be read,
  supplies no current publication proof.
- A PR from another owner/repository fails the existing identity checks. Wrong
  branch, base, number, state and ambiguous discovery retain their refusals too.

Review capture still binds to the exact published Git commit. The forge merge
runner still requires its PR head to equal the reviewed chain tip and dispatches
with `--match-head-commit`. Git continuation authorizes no merge of a stale head.
Privacy refusals and uncertain PR body writes retain their existing handling.

## Baseline reproduction

Before changing production code, an isolated regression was run against main
`8ee4db2e42`. It drove the real controller publication path with a local bare
remote and a read-only forge stub returning an older ancestor. The remote
contained the exact accepted commit, but the lane entered `needs_decision` with
`the delivery pull request differs in headRefOid` after all bounded re-reads.
The regression expected completion and failed. No live forge state was used.

`src/lib/pipelines/parkedPublication.test.ts` exercises that path, unavailable
reads, persisted advisories in a fresh process, and the retained refusals.
Its forge fixture now accepts discovery without an optional base filter, as
the real verifier discovers by head before validating the base.
`src/lib/pipelines/stagePullRequest.test.ts` covers delivery changes across Git
awaits and exact review/merge fencing. Synthetic head-only tests explicitly
provide no Git proof and retain their earlier refusal expectations.

## Verification

Checks ran sequentially on an isolated source export on 2026-11-14, with private
HOME, XDG configuration, state and temporary directories and native Git.
Every test file had its own recorded command and terminal verdict.

| Command or scope | Result |
| --- | --- |
| `bunx tsc --noEmit` | Passed after the final test edit |
| ESLint on the three changed TypeScript files | Passed |
| `bun test --timeout=60000 src/lib/pipelines/stagePullRequest.test.ts` | 163 passed; the affected review/merge case passed again after a lint-only local binding rename |
| `LLV_PARKED_PUBLICATION_CHILD=1 bun test --timeout=60000 src/lib/pipelines/parkedPublication.test.ts` | 133 passed, nine existing failures |
| New real-publication cases selected from that same file | 19 passed |

The same nine older publication producer-repair, startup and deadline assertions
failed against main with the same isolation and corrected discovery fixture
(114 passed, nine failed; the new cases were excluded). They remain baseline
failures, outside this change. The final publication privacy scan and its
commit-range result are recorded in the stage report.
