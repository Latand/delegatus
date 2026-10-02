# Merger procedure

The `merger` role takes one required text parameter, `prs`, containing
comma-separated `N@reviewedSha` pairs. It defaults to Codex / GPT-6.1-Sol /
high, with read-write access and no child spawning. Use a single run stage or
`spawn_agent`; no additional MCP tool is needed. The seat must have merge
authority and exclude PRs whose live `merge.state` Delegatus already holds.

Run from the repository with a dedicated `TMPDIR` for this pass. Keep that
directory for every command; the run record is `$TMPDIR/merge-batch.json`.
The launched agent must have the machine noreply author and committer identity
described in [CONTRIBUTING](../CONTRIBUTING.md).

```sh
bun scripts/merge-batch.ts build '12@abcdef1,13@1234567'
bun scripts/merge-batch.ts gate
bun scripts/merge-batch.ts land
```

`build` fetches fresh main and each listed PR, checks its open/non-draft/main
base and reviewed head, and allocates a temporary worktree on a unique
`merge-batch/…` branch. It leaves the caller's checkout untouched. In list
order, it squash-applies each PR as one commit. A conflict or a different
stable patch-id from a binary, zero-context diff defers that PR for the entire
pass, including rebuilds. The commit contains the title, PR number, first
body paragraph (up to 600 characters), and deduplicated machine credit.
Human `users.noreply` author identities add no trailers; an existing
non-machine `Co-Authored-By` trailer is refused.

`gate` runs the commands from `localGateCommands` through `/var/tmp/llv-gate`:
frozen dependency installation, TypeScript, ESLint on changed source files,
changed tests and existing sibling tests by file path, and the publication
gate with `--check-commits`. Each command has isolated state under `/var/tmp`.
The commands are in one replaceable function for the CI/local-hooks lane.
On failure, the same command must first pass on the batch's main baseline.
`git bisect run` then identifies the first failing batch commit. The culprit
is removed, and the remaining reviewed patches are rebuilt and checked.
A red baseline or an inconclusive bisect stops the pass.

`land` requires a gated exact tip, checks original heads again, pushes only
the owned batch branch, and creates one batch PR. Its body carries the
original PR references and their closing issue references. It obtains required
check names from main's protection and waits for those checks to be present,
finished and green. Optional failures do not hold this batch. A red required
check is attributed only through diagnostic commit/path notices in its failed
workflow log. A red without a usable notice stops without merging; ordinary
checkout log hashes cannot accuse a PR.

Main movement triggers rebase, classification against the original reviewed
patches, gates and a lease-protected update of the owned batch branch. Three
refreshes are allowed. The merge uses `gh pr merge --rebase
--match-head-commit`, preserving one commit per original PR. It verifies the
landed chain's patches, then closes each unchanged original with a receipt
linking its landed SHA and batch PR. Original branches stay in place. A head
that moves after landing stays open, with that fact in the run record.

After the batch lands (or becomes empty), resolve each deferred PR:

```sh
bun scripts/merge-batch.ts resolve 13
# Read resolving.work in merge-batch.json. Resolve and stage conflicts there.
bun scripts/merge-batch.ts resolve 13
```

The first call starts a merge of the new main into the reviewed head in a
separate temporary worktree. The next call commits the staged resolution,
checks it, and makes a normal fast-forward push to the original PR's head
repository. The result is `needs-review <sha>`; the merger never merges that
resolution in this pass. The seat assigns an independent branch review,
including `git show --remerge-diff <sha>`, before listing its newly reviewed
head in the next batch. A failed resolution gate can be retried after its
cause is addressed, with the recorded resolution kept for inspection.

The report has one row per input: `merged <main sha>`, `needs-review <sha>`,
`culprit <check: attribution>` or `head-moved`, plus the batch URL. A deferred
row initially says `needs-review pending resolution`; it is unfinished until
the merger resolves it or reports why the pass failed. The run succeeds when
every row is final and the batch merged or became empty. GitHub failures,
unattributable red checks and exhausted refreshes fail the pass. Keep the
private run record and worktrees for inspection; worktree cleanup owns their
eventual removal. Do not push main or change branch protection.
