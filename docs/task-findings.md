# Finding identity on board tasks

`create_task` and `update_task` accept `findingKey`, an opaque
string of at most 200 Unicode characters. Case and whitespace are retained.
Each project can have one open task holding a given key. Done tasks retain
their key as history; reopening one refuses if another open task holds it.
An update can clear the key with `null` or replace it with a different key,
which starts occurrence history at one.

If project aliases join two open holders, the oldest task keeps the key.
Their counts are combined and the latest last-seen time is retained. Other
task records keep their text, details and status and become keyless. Read
projections agree; the next task write persists that reconciliation.

Creating a task with an already open key returns its existing id and
`matched: true`. It increments `finding.count`, records `finding.lastSeenAt`,
and replaces the status `note`; an omitted note clears the earlier note.
The original text, details, status and other task fields stay as written.
Retries with the same `clientRequestId` return the earlier result without
counting another observation. After Done, a fresh task starts at one and
records the latest earlier task in `finding.previousTaskId`.

The key and occurrence history belong to this installation. Linked task
exchange sends neither field; edits arriving from a peer retain the local
fields. This lets reporters on separate installs use their own identities
without sharing opaque log identifiers. The linked task text continues to
travel under the existing sharing rules. `taskSync.test.ts` tests encoding,
arrival and a peer edit of a local keyed task.
When a peer reopens a Done task whose key an open successor holds here, this
install refuses the reopen and sends Done back with a newer status stamp.
After the successor finishes, a fresh reopen can succeed. A refused reopen
is a completed refusal and is never queued for later execution.

After recurrence, the existing card state line starts with the count and a
localized relative last-seen time, before any hold details. Hovering the time
shows the localized absolute date and time. The hold tooltip
includes that recurrence text. No new control is added. Rendered measurements
for quiet and held cards in English and Ukrainian, light and dark themes,
at 1440, 1000 and 390 pixels are recorded in
`evidence/finding-recurrence/readings.json`; the reusable kanban browser
driver captures the cards in `.artifacts/finding-recurrence/`. Measurements
record vertical clipping and check that every recurrence fragment stays
inside the visible state line even when later hold details are clamped.
