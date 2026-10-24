# Scheduled board maintenance window

Board maintenance remains off by default. Its optional `maintenance.window`
restricts new scheduled maintenance launches only. Explicit messages, seat
wakes, active pipelines and reconciliation of running maintenance continue
independently. The launch interval remains a minimum elapsed-time gap.

Example settings change:

```json
{"maintenance":{"enabled":true,"window":{"timeZone":"Europe/Paris","weekdays":[1,2,3,4,5],"startHour":9,"endHour":17}}}
```

Weekdays use ISO numbering (Monday 1, Sunday 7). Hours are integers from 0 to
24, start inclusive and end exclusive. This slice supports one same-day window;
start must precede end. `window: null` removes the restriction. Partial changes
preserve it. Invalid writes are refused; malformed persisted maintenance windows
read as maintenance off through both legacy JSON and SQLite reads. The independent
curation timer keeps its own settings. Existing settings without a window retain
their cadence.

Hours follow the named IANA zone at each real instant, including DST changes.
Missing hours have no opening; repeated hours are both eligible. The existing
elapsed-time cooldown and durable run claim still prevent duplicate launches.
The bounded lookahead includes a second weekly opening when a clock change
removes the first one.

Downtime uses **skip and coalesce**: closed windows are skipped, with no replay
queue. On recovery outside a window, nothing launches until a later opening.
Inside a window, all overdue intervals coalesce into at most one current run.
A recovered undispatched claim waits for maintenance to be enabled and its
window to open; an expired claim is
settled by the existing recovery rules. The current window is checked again
after evidence preparation and before dispatch. An already dispatched turn
continues, including receipt recovery before its local checkpoint.

HTTP and MCP settings reads expose `maintenance.window`,
`maintenance.missedWindowPolicy` (`skip-and-coalesce`) and `maintenance.nextRunAt`.
The latter estimates the next controller check inside the window after cooldown,
subject to the existing seat, deployment and live-run holds. `nextEligibleAt`
continues to describe cooldown eligibility. The estimate searches up to fifteen
days and is null when no controller check fits that horizon. Estimates do not
reserve a wake time.

Compact MCP settings reads include window metadata when a window is configured.
An unrestricted compact read omits the empty window and missed-window policy
fields; HTTP and verbose MCP reads expose `window: null`. Existing compact
fields, including interval editor bounds, retain their shape and byte budget.
