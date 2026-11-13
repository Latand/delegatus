# Runtime image writer admission

## Decision

Keep complete queue-ticket publication and the exclusive `.writer-lock`. New
writers use the ticket queue for fairness and `.writer-lock` for the quota
critical section. They read `.writer-lock-gate/owner.json` only to wait for a
live writer from an older release. New writers never create, modify, or delete
that legacy gate.

This removes the writer-side gate protocol. It also removes gate staging,
quarantine, fd-relative child paths, owner retirement, and release markers.
There is no owner check followed by unlink, and no directory-fd path whose
child lookup differs across Linux and macOS.

## Why the ticket and writer lock are sufficient

The original quota race came from publishing a queue ticket in place: a peer
could read an empty ticket and delete it while its writer was alive. Writers
now write complete owner JSON to a unique `.writer-ticket.<token>.partial`
file and rename it into `.writer-lock-gate.queue/`. Queue readers only see
complete current tickets. A dead complete ticket is retired by the next queue
scan. A fresh malformed ticket from an older release keeps its sorted position
until its file age exceeds `writerLockStaleMs`; after that, the next scan
retires it.

Only the live queue head proceeds to `.writer-lock`. Its `mkdir` is exclusive,
and every quota read, garbage collection, and image publication remains inside
that lock. Current writers therefore serialize quota decisions without a
second gate. The ticket partial is a root file ending in `.partial`, handled
by the existing aged-partial cleanup.

Older releases still use the directory gate. A current writer waits while its
owner record proves that an older process is alive. A dead valid owner is
ignored. An unreadable or incomplete owner is held until the gate directory
passes `writerLockStaleMs`, then ignored. The file and directory remain
untouched. `.writer-lock` still serializes the old and current quota-critical
sections when their observations overlap.

## Interruption and recovery

| Interruption point | Persistent state | Recovery |
|---|---|---|
| Before ticket rename | Root `.writer-ticket.<token>.partial` | Existing startup cleanup removes it after the abandoned-partial age. |
| After ticket rename | Dead unique queue ticket | Next queue scan recognizes its dead owner and removes it. |
| While an older release writes a ticket in place | Fresh incomplete queue ticket | Queue readers preserve its position until it completes or ages past `writerLockStaleMs`; then a reader removes it. |
| While an older release publishes its gate owner | Empty or partial owner in the fixed legacy gate | Current writers wait until the directory is stale, then proceed without changing the file. |
| During quota work | `.writer-lock` with owner record | Existing stale-lock recovery applies. |

The current protocol creates no gate staging or retirement names. Repeated
interruption cannot accumulate gate leftovers. A malformed legacy owner stays
at one fixed path and stops blocking once stale; the current protocol never
deletes a file whose identity can change between inspection and unlink.

## Compatibility boundary

The legacy gate remains a read-only compatibility signal. If a current writer
observes a live owner, it waits under its existing acquisition deadline. A
missing gate, a dead owner, or an aged incomplete publication permits the
queue head to attempt `.writer-lock`. Fresh malformed queue tickets from older
releases likewise retain their position until the stale threshold. If an older process creates its gate
after that observation, both versions still contend on `.writer-lock` before
entering the quota-critical section.

## Verification contract

The runtime image store test file preserves the four-writer quota assertion:
exactly one success, three quota refusals, and stored bytes within the
unchanged limit. Focused cases cover atomic ticket publication, interrupted
ticket recovery, a live legacy owner, fresh and aged incomplete legacy owner
records, preservation of owner inode and contents, and recovery of aged
incomplete legacy queue tickets. The full file is run on
the default SQLite and the minimum supported SQLite 3.39.4 in isolated gate
slots.
