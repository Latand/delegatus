# Pipelines in depth

A pipeline runs one task through a fixed set of agent stages, such as build,
review and verify. This page covers the stages and roles, verdicts and fail
edges, review rounds, how a pipeline looks on the board, merging, and what
happens when a pipeline ends. The stage contract, the HTTP API and recovery are
in [docs/pipelines.md](../pipelines.md); [docs/review-loop.md](../review-loop.md)
covers a review round.

![A pipeline opened from its task: Build, Review and Verify stages, with Review's loop back to Build folded under it, and the builder's and the reviewer's conversations side by side](../media/readme/pipeline.svg)

## Stages and roles

A pipeline has up to eight stages and works in its own git worktree and
branch. Each stage has a role, such as builder, reviewer, verifier,
architect or visual critic, which judges only the rendered screens. The role
sets the engine, model, effort and whether the stage may change the
repository. No stage deploys. The deployer role is refused in a pipeline,
except its release mode, which validates a release and asks before it pushes
the tag. Which engine and model each role uses is in
[Accounts, limits and roles](accounts-and-roles.md#roles).

## Verdicts and fail edges

Each stage ends with a verdict. Pass moves to the next stage. Fail follows
the stage's fail edge, usually back to the builder, until the round budget
runs out. "Needs decision" stops and asks you. If a "needs decision" carries
findings and the stage has a fail edge, Delegatus routes it like a fail, so
the findings reach the stage that can fix them. The next stage receives
everything the previous agent wrote before it reported, the whole
stage output and more than its summary. Each stage is drawn with a small figure for the model it runs on.

## Review rounds and the budget

Every review round starts a fresh reviewer with read-only access and no
memory of the builder's conversation, so it reads the whole diff cold. What
happens when the last round fails depends on the pipeline's exhaustion
policy:

- **`advance`** (the default). The builder fixes those findings once more and
  the pipeline moves on, marking the fix as not re-reviewed.
- **`stop-after-fix`**. After that fix the pipeline waits for you if the fix
  wrote a new head: it stops on the fixed head and offers **Accept as is**. A
  fix that left the head unchanged moves on without asking.
- **`park`**. The builder fixes after every failed review but the last, and
  one more review follows the final fix. A failure there stops the pipeline
  for you before any further fix.

No policy offers an extra review to ask for.

A review budget is fixed when the pipeline is created. Under `advance` and
`stop-after-fix`, N rounds are N reviews and a fix of the last review's
findings; under `park`, N rounds are N fixes and N + 1 reviews.
[docs/review-loop.md](../review-loop.md) covers a round in detail.

## On the board

On the task's card a pipeline takes one row: its stages as a chain, its
state, its pull request and the issues that pull request closes. Skip or
retry the stage and close the pipeline are in the card's ⋯ and on the stop's
own entry in the timeline. Open the row to see the stage graph beside each
stage's conversation, as in the picture above.
[Everyday workflows](workflows.md#watch-a-pipeline) shows what to do when a
stage stops.

## Merging

**Merge when the review passes**, on the **Merging and syncing** page of the
board's ⋯ menu, is off by default. While it is off, a pipeline ends with its
pull request open and the orchestrator tells you it is ready.

Turn it on and Delegatus merges each pipeline whose reviews passed, one at a
time per repository:

- **When.** Once the base branch's required checks on the head have settled
  green. Pending optional checks can continue; any reported check failure stops
  the merge.
- **Behind the base.** It updates a branch that fell behind.
- **On a conflict.** It starts a refresh on the same branch: an agent merges
  the base, a reviewer checks that resolution for one round, and a conflict in
  meaning stops with the file named.
- **What you see.** The pipeline shows "waiting for checks", "merge stopped" or
  "merged". A stopped merge appears under **Needs you** with **Try the merge
  again**.

The orchestrator can also hand several reviewed pull requests to one
**merger** stage, which lands them as a single batch pull request with one
commit per original; [docs/merge-batch.md](../merge-batch.md) has the
procedure.

## When a pipeline ends

Mark a pipeline **Finishes the task** and its task moves to Done when the
pipeline finishes, or, with merging on, when its pull request is merged. An
hourly sweep removes the worktrees of merged pipelines, and those of other
finished lanes four days after they settle when every commit is on the
remote. It skips any worktree that is still in use or holds unpublished
work.
