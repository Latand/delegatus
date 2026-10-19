# Finished work and attention

A done task keeps its Done status. An unfinished task in In progress returns
to Inbox once all its linked lanes have completed or closed. A pending merge,
another active lane, a later assignment or an explicit later status choice
keeps the task in its current column. A conversation resumed after the lane
ended also keeps its task in In progress. This does not declare unfinished
tasks done or change the lane's outcome.

A dead conversation's permission, question, plan, prose ask, stage decision or
memory warning is withdrawn when its recorded time precedes its task's or
lane's recorded ending. A live host, a newer reason, an unknown completion
time or unreadable ownership preserves the ask. An owed operator message
remains owed. Direct asks without a terminal container remain visible.
A task decision form raised before the task was completed expires too. Forms
raised afterwards and answered forms whose message remains undelivered keep
their attention. Seat decision forms have their own lifecycle.

The badge, desktop board and phone read the same withdrawal rule immediately.
Reconciliation records the exact reason as `container-finished`; operator Undo
is retained and prevents the same reason from being automatically hidden again.
Both shipping locales name the rule. A confirmed dead process counts as no
working agent immediately. A cached live row with explicit host-gone evidence
and no process expires from working counts after sixty seconds; an unknown
process alone supplies no evidence of death. A confirmed running host has no
silence timeout.

`src/lib/attention/finishedWorkCleanup.ts` runs once inside the serving release's
startup mutation fence. It reads the archive cooperatively, rechecks authority
and current task and lane state after asynchronous admission, and commits the
column updates and `finishedWorkInbox-v1` marker together. It retains task
content, assignments and receipts. The marker survives process restart; later
operator choices are never replayed over. Startup also runs one fresh attention
reconciliation; ordinary reconciliation keeps handling future endings. No
process is stopped and no recovery placeholder is removed by this change.

The write paths remain the task store's existing transaction and the attention
dismissal store. Task status comes from task creation, REST and MCP patching,
assignment admission, pipeline task finishing and linked task replication.
`statusBy` stays local to the installation: the task store validates it and drops
it when an unnamed writer changes status. An explicit operator-only assignment
patch records that choice even when the stored status was already Assigned;
this lets the operator reopen a card whose displayed status has returned to
Inbox. A same-status text edit retains the earlier attribution. The board's
terminal-work rule and seat-action arrows consume that attribution; operator
choices generate no seat arrow. No task schema or replication default changes.

Verification uses explicit Bun test paths in isolated HOME, XDG_CONFIG_HOME,
TMPDIR and LLV_STATE_DIR, with LLV_VIEWER_CONTROL_URL on a closed port. The
existing kanban browser driver case `terminal containers withdraw stale asks
and retain the live ask` captures en/uk, light/dark, phone/desktop. For its
baseline export, copy only the case and the fixture's scenario routing into the
base source and set FINISHED_WORK_STAMP=before. The same invented input is used
for both revisions. Captures are under `.artifacts/finished-work`; the committed
counts and render readings are in `evidence/finished-work/`.

No performance improvement is claimed. The model's ownership index is reused
across clock ticks; normal projections read the current board inputs and the
one-time startup cleanup includes archived history.
