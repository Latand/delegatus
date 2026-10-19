# Seat tick reminders for waiting work

The tick treats explicitly chosen board work (`BoardTask.chosen`) as accepted
work. This includes submitted continuations. Automatically captured Inbox
cards without that flag keep their existing quiet behavior. An accepted task
in Inbox or Assigned with no open lane becomes due after one hour. Its line
names the task id and the hours since its latest status entry, or creation
when there is no status entry. A reasoned hold has a kind other than
`unstated` and a nonempty note; it suppresses the reminder until its optional
expiry. Tasks assigned to another installation stay excluded. Historical
assignments and completed lanes do not own accepted work.

`pipeline_action` with `action: "pause"` accepts `reason` and an optional
`resumeCondition`. Conditions are either `{kind: "date", at: <ISO timestamp>}`
or `{kind: "account-usage", engine, accountId, window, belowPercent}`. `window`
is `session` or `weekly`; the percentage is between 0 and 100. The engine
validates these values for both HTTP and MCP callers before pausing, records
the server-attributed actor, and clears the metadata on resume. Older callers
that omit a reason get an explicit missing-reason record.

The HTTP route forwards `PatchPipelineRequest`; the MCP schema admits the
condition and its binding forwards it to the same `patchPipeline` writer.
Existing board controls omit both fields and use that default. The pipeline
store validates the optional record and preserves it in full reads;
`get_pipeline(full: true)` exposes it. Both the initial tick gather and its
pre-send refresh project the reason, condition and pause author. Legacy
`stateDetail` attribution is the fallback for records without an author.

A date condition is due when its instant arrives. An account condition needs
an authenticated, fresh live cached observation for that account and engine;
the named window must be strictly below the threshold. Stale or missing
evidence leaves the condition unproven. Reading a condition makes no provider
request. An agent pause without a condition, including a legacy pause, is due
after 24 hours from `pausedAt` (or its last recorded movement). Operator pauses
remain excluded. A reminder asks the seat to review or resume the lane; it
does not resume anything itself. The existing deployment-settlement reminder
still carries legacy seat pauses, while a recorded condition must be met.
The delivered deployment wake records its cutoff so a pause instruction beyond
the agenda limit can drain later; pauses begun after that cutoff keep their
own bound.

Each task and pause episode repeats at most once per 24 hours. The existing
delivered-item ledger stores the stamp, only after the complete item was
delivered. Failed sends and cropped bullets earn no stamp. Reminder stamps
survive process restarts and seat rotation. The agenda still has its configured
item limit and wake interval. The ledger retains its existing bounded history
and eviction rule for ordinary agenda history. Reminder stamps are protected
for their 24-hour window independently of that history cap, then join its
bounded history. Their protected size is bounded by delivered reminders
within that window, with one stamp per task or pause episode. Reminder order
uses the first wait instant or the last delivery plus the repeat bound, so an
agenda that spans more than a day can finish naming unseen work.

The composer uses the task and lane projections already gathered for the
check. Account conditions read cached quota rows once per needed engine, with
`seat-tick.pause-conditions` attribution. No performance gain is claimed.
Regression coverage lives in `src/lib/monitor/seatTick.test.ts`,
`src/lib/monitor/seatTickSources.test.ts` and
`src/lib/pipelines/engine.pauseMetadata.test.ts`.
