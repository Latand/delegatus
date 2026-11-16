# External relay poll diagnostics

The claim loop records completed attempts independently of request execution.
`External relay poll outcome` journal lines report changes between `ok-empty`,
`claimed`, an HTTP status, and a fixed connection or local failure class. The
path is always `/requests/claim`. A response status is retained even when the
response body cannot be parsed. Machine reasons from refusal bodies pass a fixed protocol allowlist; unknown
values become `other`. Exception messages, names and causes are excluded from
the records. HTTP 409 with `lease_lost` retains both status and reason.

Each pairing owns counters for polls, empty responses, claims and errors by
class. They are exposed as `status[].state.poll` by the existing authenticated
`GET /api/external-relay` response. `lastOutcome.at` is the latest completed
attempt time, including repeated outcomes. `since` identifies the counter
session. Request completion outcomes remain in their existing separate fields.

`External relay poll summary` journal lines carry the same cumulative counters,
last outcome and session time every ten minutes. The poll loop and the existing
minute sweep both check this deadline, so parked loops still produce summaries.
A quiet process with no completed attempts emits no summary. A hung connection
is bounded by the claim deadline, including DNS resolution.

A sustained outcome produces one change record followed by summaries. Flapping
outcomes emit at most 30 change records per one-minute window per pairing;
`suppressedChanges` counts excess changes in both status and summaries. Every
completed attempt still updates the counters and last outcome. All diagnostic
keys have fixed or HTTP-bounded cardinality. No endpoint host, address,
credential, pairing identifier, chat identifier or message text enters these
records.

The controller owns diagnostics across module copies and poll-loop restarts.
Removing a pairing evicts its diagnostics. A Viewer process restart starts
fresh counters and rate limits with a new `since`; journal records preserve the
previous process's observations. Summaries are cumulative within that session.
This change makes no performance improvement claim.

Non-success heartbeat and completion responses also emit bounded
`External relay HTTP refusal` records, including from the lease helper process.
Their paths use `/requests/:request/heartbeat` and `/requests/:request/complete`;
request identifiers are removed. The same reason allowlist applies before a
helper frame is sent and again at the journal boundary. Identical refusals
log once per ten minutes; changing refusals are capped at thirty records per
minute per path. The next emitted record reports how many were suppressed.
Heartbeat phase records also use the safe path and reason without step text
or request identifiers. The error objects used by delivery logic retain their
existing codes and payloads; the journal projection is sanitized separately.
