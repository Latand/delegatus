# Board timeline data

`src/lib/board/taskTimeline.ts` exports `projectTaskTimelines({ project,
tasks, pipelines, members, nowMs })`. The frontend supplies its existing board records
and one clock value in milliseconds. The result contains that clock and task
rows, each with pipeline rows and chronologically ordered stage attempts.
Use the same attempts for the collapsed agent strip and expanded stage bars.

The board already reads `/api/files?view=summary`. Its `filesReadSummary`
projection preserves all attempt timestamps and effective runtimes. The task
summary and chronology work also consumes these records; event chronology
alone lacks the start/end pairs needed for bars. Separate reads through
`/api/tasks` and `/api/pipelines` can feed the projection too. No endpoint or
persisted record is added.

The server's existing `workspaceFiles` filtering and `workspaceRoute` guards
remain the access boundary. Call the projection with those authorized records.
Its project predicate narrows both tasks and pipelines and never treats a
pipeline's task id as permission to read another project's history.

An open, visible pipeline or a currently working resolved board member puts a
task in the timeline. Provisioning, running,
paused, awaiting review and awaiting a decision all count: waits are part of
the task's elapsed time. Done tasks, drafts, hidden pipelines and tasks whose
lanes have all settled and have no working member are excluded. Earlier
visible completed/closed lanes
of an active task remain as history. Callers may further narrow the input to
the board's resolved task groups for its hide, search and membership choices.

Both board mounts pass members from shown cards, using the board's working
predicate, plus resolved assignments and explicitly linked stage references
from the board's workflow projection. This preserves workers folded into
layout groups. Related lanes do not promote their other workers into a task.
The projection rechecks project and current work. Standalone turns
appear in `agents`, with their recorded turn start (or recorded launch time
before a turn exists), engine and model, and end at the supplied clock. A
member represented by a current live attempt contributes no duplicate bar.
A later working turn of a settled stage conversation appears in `agents`,
alongside the frozen earlier attempt, and can expand the task by default.
An absent member supplies no invented history or duration. The collapsed
strip uses the existing engine colour tokens, stable across outcome changes;
expanded bars and their state words still describe each attempt's outcome.

Each task exposes its recorded creation time separately. Its bar starts at
the first recorded attempt start, falling back to the first lane creation
before an attempt has started, and ends at the supplied clock. A task's `live`
flag identifies a default-expansion candidate with a live stage.

Each attempt carries pipeline/stage/attempt identity, stage kind, state,
historical flag, engine, model and role. Its effective runtime takes precedence
over the current editable stage. `startedAtMs` and `completedAtMs` preserve
parseable record times. A confirmed `suspension.stoppedAt` freezes the work
interval and clears its live flag, even while the attempt remains running.
The open task's overall elapsed span still reaches now. A stale working member
whose turn predates the stop adds no live bar; a later turn can resume work.
`endAtMs` is a valid completion or confirmed stop, whichever comes first, or
the supplied clock for the latest operational attempt of the cursor's stage while its state is
spawning, running, reviewing or committing. Historical, superseded and settled
attempts never grow. Missing/reversed bounds yield a null drawable end;
missing starts remain null. Consumers omit bars whose bounds are unknown.
Future starts never make a live bar or move the task start past now.

Task and lane order is chronological, with identity breaking ties. Attempt
keys remain stable across refreshes. Projection returns scalar copies and
contains no account identifiers, transcript bodies or source object references.
Expansion persistence and rendering belong to the frontend slice.
