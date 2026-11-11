# Controller accounting

At task creation, supply `accounting.criteria` and the optional
`accounting.taskClass` declaration (`size`, `money`, `access`,
`dataMigration`). A child task supplies `originalTaskId`; a later defect
supplies `correctsTaskId`, both inside `accounting`. References must already
exist in the same project. The declaration stays with the task when its
title, details, status or assignments change. Existing tasks without creation
criteria retain unknown criteria; they cannot acquire retrospective acceptance.

After checking the criteria, use `update_task` with `accept: { evidence }`
and the current `expectedProject` and `expectedRevision` from `get_task`.
The server records the event time and caller kind. A repeated acceptance
preserves the original event. Moving a task to Done alone records no
acceptance. Acceptance is independent of lane completion and merge.

At lane creation, `create_pipeline.taskClass` freezes its declaration and the
controller's resolved project. Omitted declarations keep null fields. No class
is inferred from changed lines, model choice or the outcome. A retry or decision
answer can supply `repeatReason`; this is useful for a new requirement or an
operator revision that the controller cannot identify itself. Other causes come
from controller transitions, with `unknown` as the fallback. No prose matching
classifies an interruption.

Generate the report from a retained database snapshot:

```sh
bun scripts/accounting-report.ts DATABASE FROM TO AS_OF
```

The dates are ISO instants. FROM is inclusive; TO is exclusive. AS_OF defaults
to TO. Opening the database is read-only and performs no initialization,
migration, runtime call or transcript scan. Active and archived pipeline records
belong to the same report snapshot. The JSON exposes `calendar` and `cohort`
side by side:

- `calendar` counts original tasks accepted during the period and clips attempt
  work to the period, including attempts still open at the end.
- `cohort` selects original tasks created during the period and includes all
  their lanes known by AS_OF, including lanes linked through child tasks.
- Both show acceptance by declared class, nearest-rank latency percentiles from
  first ready time, the open remainder and its age, holds at the cutoff, and the
  unknown share of repeated attempts. Child tasks and correction tasks earn no
  additional original-task completions.

The source records must be retained with the report. Task deletion removes its
source record; the report cannot reconstruct deleted tasks. This command is an
API/CLI surface; there is no accounting dashboard.

## Time semantics

An attempt records the controller's admission and start observations separately.
Pending admission survives the time spent waiting for launch. A finished
attempt freezes its timing observations for its current completion interval in
its own record so later reports need
neither the native ledger nor check files. Reopening an existing attempt clears
that snapshot; its next completion records the new interval.

Native timing uses observed turn and tool boundaries. Model time means observed
time inside a native turn outside tool execution. It is not a provider's compute
measurement. Reconstructed history carries no clock. An unfinished turn can
contribute only through its last observed boundary. A different process cannot
join a lost owner's open interval to its own observations.

Checks retain closed CPU/slot wait observations and the producer's command
dispatch and close times. Unobserved setup, cleanup, missing dispatch, malformed
boundaries and gaps remain unknown. A deadline and a test runner's printed
duration are never substituted for observations. Ordinary tools that did not run
through the recorded-check protocol cannot supply a check split.

The partition counts overlapping wall time once: checks take precedence over
tools, which take precedence over model turns. Concurrent checks and tools count
their union. The unknown remainder makes the partition equal the attempt's
interval with zero tolerance. A component without evidence is null. A missing
or inverted interval remains null, including its unknown remainder. Bounded
native/check observations may leave an additional unknown remainder. Accounting
claims no performance improvement and changes no admission or review policy.
