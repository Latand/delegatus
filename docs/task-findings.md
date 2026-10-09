# Finding identity on board tasks

`create_task` and `update_task` accept `findingKey`, an opaque
string of at most 200 Unicode characters. Case and whitespace are retained.
Each project can have one open task holding a given key. Done tasks retain
their key as history; reopening one refuses if another open task holds it.
An update can clear the key with `null` or replace it with a different key,
which starts occurrence history at one.

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

After recurrence, the existing card state line shows the count and a localized
last-seen date and time. No new control is added. Rendered measurements for
English and Ukrainian at 1440 and 390 pixels are recorded in
`evidence/finding-recurrence/readings.json`; the reusable kanban browser
driver captures the cards in `.artifacts/finding-recurrence/`.
