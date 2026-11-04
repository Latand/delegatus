# Checkpoints for completed test files

A touched-test selection can exceed its aggregate execution budget after many
individual files have passed. Retrying the same selection previously repeated
those files before reaching the unfinished work.

The local comparator now retains complete green head files in the existing
bounded gate receipt store. A retry reads those receipts and executes the
remaining files. The interrupted invocation still fails. Its result never
becomes a passing receipt for the whole selection.

## Input and completion boundaries

- Reuse requires the same clean worktree, commit, tree, branch, comparison base,
  full working inputs (including ignored files), installed dependency bytes,
  gate and runtime bytes, Git configuration, execution environment, selection
  and budgets. The existing gate input snapshot supplies these identities.
- Dirty trees, index flags and unreadable input identities receive fresh runs.
- A file must have at least one passing assertion, no failed assertion or
  diagnostic, a complete report and successful owned cleanup.
- Reusable files use Linux service cgroup cleanup. The portable fallback is
  best effort; its samples never become head checkpoints. Other platforms
  retain their existing fresh-file execution and whole-step receipt rules.
- Incomplete, timed-out and failed files run again. Baseline evidence retains
  its own confirmation rules. Diagnostic and flaky confirmation rounds remain
  fresh and never create head checkpoints.
- The comparator waits for its owned file runners and cleans its private root
  before sealing new receipts. A stopped supervisor or failed cleanup cannot
  seal them. Input drift prevents sealing; drift after reusing a checkpoint
  refuses the invocation.

Snapshots occur at invocation boundaries, so input hashing does not repeat for
each file. Single-file selections keep whole-step reuse and skip this extra
snapshot. Completed results remain in memory only for that bounded invocation.
The existing gate cache limits the namespace to 256 entries and 32 MiB, limits
each record to 1 MiB, and treats malformed or unavailable records as misses.
Head-file receipts expire after 24 hours. No additional service or timer runs.

The selected checks, file budgets, aggregate budget, publication privacy checks
and required CI checks retain their existing rules. A persistent assertion
failure still blocks publication after unrelated green files are reused.

## Verification

`scripts/local-gate.checkpoints.test.ts` uses separate comparator processes and
synthetic repositories. It demonstrates retained green files beside an
incomplete file, source/environment/ignored-input invalidation, malformed
receipts, and an aggregate deadline after eight of twelve files. The second
invocation executes only the remaining four. The deadline is controlled in the
parent; the child checks keep their real clocks and execution bounds.

This repairs the Delegatus repository's publication integration. The generic
cross-project execution contract remains tracked in #3622.
