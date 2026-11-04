# Durable PR integration

The merge runner resumes integration inside the outcome that owns the PR.
A base update does not create another user pipeline. Existing feature stages,
attempts, reports and review evidence remain historical records of their heads.

`PipelineMerge.integration` records the originating outcome, first reservation
key, desired base, requirement and policy revisions, workspace scope, delivery
epoch, stage/attempt/launch binding, publication receipt and batch cursor.
The three reusable integration stages use the normal controller, runtime
membership, `stage_report`, independent review and publication checks.

Admission reads the delivery remote before taking the delivery transaction,
then compares the reservation, head, epoch and scope under that transaction.
An indexed legacy creation receipt wins over adoption. A running legacy carrier
keeps its own claim; the original continues to mirror its progress. An unstarted
reservation is adopted using its original key, without calling creation.
Foreign branch work and an unresolved publication refuse adoption.

Each compatible batch freezes at most eight outcomes for one hour. Its cursor
advances from persisted item receipts; a restart reconstructs execution from
those records. Only one conflict resolver per repository owns execution
capacity. Review, CI, provider and decision waits release that capacity.
Independent ready PRs can pass waiting work. A PR based on another retained
PR's branch waits for that named predecessor. A fresh stage attempt runs each
item; conversations and worktree authority remain scoped to that item.

The physical repository landing fence covers every workspace scope. A merge
intent is durable before dispatch. An uncertain merge retains that fence and
uses forge readback; it never automatically repeats the write. A legacy intent
without a recorded target conservatively fences the repository. Known targets
leave independent branches available. Publication
continues to use the existing exact-head receipt and remote reconciliation.

A CLEAN forge status alone does not establish a current base under soft branch
protection. The runner compares immutable base ancestry before integration and
again before landing. Base movement requires an integration review, including
transitive contracts, defaults, configuration, schemas, generators, toolchain
and policy. The original feature review stays historical. Required checks still
run against the resulting head. Unknown applicability withholds landing.
Policy, scope, requirement or delivery changes fence reports and execution.

Repair attempts are counted on the outcome, across base updates and restarts:
three fixes and 64 integration cycles require a decision when exhausted. Native
stage lifecycle evidence supplies progress; an integration session has a
one-hour deadline. An expired session parks with its current attempt preserved.
Uncertain effects retain reconciliation authority until their result is known.

Focused verification uses synthetic repositories and isolated homes, config,
state and temporary directories through `scripts/gate-slot.sh`:

```sh
bun run test src/lib/forge/autoRefresh.test.ts
bun run test src/lib/pipelines/integration.test.ts
bun run test src/lib/pipelines/integrationLifecycle.test.ts
bun run test src/lib/pipelines/autoRefreshStore.test.ts
bun run test src/lib/pipelines/stageCompletion.test.ts
```

The lifecycle test drives real Git and the existing controller through launch,
report, commit, publication and integration review, including a successful push
whose answer is lost. Runner tests cover twenty base movements, duplicate and
process-restart replay, batch recovery, blocked-item fairness, predecessor
waiting, legacy ownership, transitive contract changes and uncertain landing.
These tests make no production performance or creation-latency claim.
