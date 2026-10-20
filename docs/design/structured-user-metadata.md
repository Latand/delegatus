# Structured-user metadata

The server encoder publishes a compact record before returning its marker.
Codex start, steer, history injection and native queue preparation await that
encoder. The native queue persists the prepared input and rechecks ownership
before dispatch. Start, steer and injection recheck their writer and turn after
publication. Test fixtures that use the server encoder also await it; the pure
wire codec and legacy fixture remain synchronous.

Publication uses asynchronous file writes, file sync, immutable hard-link
publication, bounded byte comparison, renewal of the collection grace period,
and directory sync. The existing asynchronous file-transaction admission orders
publication and collection across processes. A failed sync refuses delivery;
retrying, including after restart, publishes the same identity and completes
durability again. A different body at that identity is refused.

The synchronous metadata reader remains available to existing transcript,
pipeline evidence, memory, selected-context and delivery-history consumers.
The browser uses `POST /api/structured-user/provenance`: the shared origin and
Host gate runs before consuming the body, the streamed body is limited to
16 KiB and five seconds, and batches contain at most 100 validated references.
The route reads records asynchronously and returns `Cache-Control: no-store`.
The browser retains resolved references in its current transcript window,
including explicit missing records, and retries failed or unanswered batches
after 1.5, 4 and 10 seconds. The server action has been removed.

The background transcript feed owns retention. A complete, successfully indexed
inventory can attempt collection at most once per day; its checkpoint survives
restart. Discovery also walks retained scanner roots and Codex archived-session
directories, preserving copies outside the board window and deduplicated
catalog. A degraded Codex account registry makes discovery incomplete, so the
fallback default-account view cannot authorize deletion. Per-source reference
projections are validated against file identity, size, mtime and ctime, and only
changed sources are streamed again. Source and retained-directory identities
are rechecked after publication admission and around each unlink; if they change
at that boundary, the in-flight metadata link is restored. Native queue
inputs in the runtime journal protect their references even before a rollout
contains them. The journal is opened read-only with no busy wait; missing schema,
contention, unreadable sources, changed sources and exceeded discovery bounds
refuse collection. An incomplete or superseded scan cannot delete metadata.

Records become eligible after thirty days without publication or retry and only
when the complete reference census does not mention them. Each pass removes at
most 256 eligible records, under the same admission as publication, rechecking
age after admission. Source projections for removed transcripts are discarded.
Discovery is bounded to 100,000 paths, directories, references and queue rows;
each persisted source projection and queue record is limited to 4 MiB. Exceeding
a bound keeps metadata for a later, repaired census. Publication, provenance and
retention register separate Viewer loop-monitor operation labels. These changes
make no throughput or latency improvement claim.
