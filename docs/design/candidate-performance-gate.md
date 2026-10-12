# Candidate performance gate

Status: in force since the incident behind #2760, #2761 and #2762.

## What went wrong

Release 05d66b73 (#2714) moved terminal registry history into an archive
(`registry_cold` mapping onto immutable `registry_archive` versions) and read
it back through the `registry_records` view. Every probe the deployment ran
passed, because every probe ran against an empty registry. Against the
retained history of a long-running installation, about 30,000 rows of which
more than nine in ten were cold, the release was unusable:

1. **Keyed reads scanned the archive (#2760, fixed by #2762).** The view took
   a cold row's identity from the archive, so `WHERE collection=? AND
   row_key=?` could not use the mapping's primary key and every keyed read
   walked every cold row.
2. **Every grant-bearing write assembled the whole registry.** A row claiming
   more than the baseline MCP grant is decided against the rows that attest
   to it (#739). Readers already decided that from the subject's attestors;
   mutations still assembled the whole file once cold rows existed, reading
   about 20,000 payloads per write, and serializing the written row assembled
   it again.
3. **Board projections rematerialized history.** The projection worker built
   a conversation lookup by enumerating every conversation once per launch,
   enumerated every held delivery once per launch card, resolved every
   lineage edge and membership through a separate registry read transaction
   for a pinned scope, and walked whole collections in half a dozen other
   passes. Each archived row costs a payload read, a parse, a normalization
   and a freeze, and the archive's reader cache holds 128 rows, so each pass
   paid for the whole history again. The first build ran past the worker's
   60 s timeout.
4. **Field lookups by operation id walked the collection.** With identity
   taken from the mapping, a lookup on `command.operationId` could not start
   from the archive's expression index.
5. **Builds queued without bound.** Eight scopes queued eight serialized
   builds; the last one finished 98 s after it was asked for, and the
   worker's timeout only started counting at dispatch.

## What changed

- `registry_records` joins a cold mapping to its archive version on the
  version id **and** the identity, so a field lookup starts from the
  archive's expression index and confirms each hit through the mapping's full
  primary key. A mapping whose archive version names another row would drop
  out of that view; while one exists the conserving form (identity from the
  mapping alone) stays installed and the store warns. Only damage produces one.
- A mutation over a registry with cold rows decides a grant-bearing row from
  the row, its attestors and the transaction's own rewrites of them, once per
  transaction, as readers already did. A row decided in the transaction is
  serialized without being decided again.
- `registry_generation_identities` indexes each conversation generation's
  entry key and path, kept current by triggers on `registry_rows` for every
  writer, including a predecessor release during handover. The grant
  decision finds a subject's attesting conversations through it.
- The cold key set is refreshed from the change journal, and a new row's
  position comes from the two order indexes; neither scans the history.
- The archive pass selects candidates one collection at a time. The single
  disjunction it replaced parsed every payload under the write lock, 0.7 s
  per reaper cycle whether or not anything moved.
- `registryRowProjection` reads a narrow projection of every row of a
  collection. Over the SQLite view an archived version is projected once and
  kept while it is current, because archived versions never change. The
  projection passes in `/api/files` (launch routes and cards, receipt
  ownership, supersedence, owed deliveries, authorship, rate limits, title and
  project attribution, structured liveness, the pin family walk) read those
  projections, and full rows only for the few rows they select.
- The read-only conversation lookup answers each path from the relational
  path index, and launch cards find their initial delivery by operation id.
- The projection queue (`src/app/api/files/projectionQueue.ts`) refuses a
  build when 16 builds already wait and discards one that waited 30 s; the
  scope then serves its last representation. A queued build is discarded when
  the scope already holds a body for the same input. Queue wait and build
  time are reported separately (`files-worker-queue`, `files-worker-build`).

## The gate

`verify-candidate` now runs two rehearsals inside throwaway containers from
the candidate image, without network or mounts: the runtime-host rehearsal
(#1254) and this gate (`src/runtime-host/candidatePerformanceRun.ts`). A
candidate passes only when both pass. A refused candidate is retired before
anything is switched, and the release that was serving keeps serving
(`ViewerDeploymentCoordinator`, phase `candidate-health`).

The runner builds a synthetic registry (`registryPerformanceDataset.ts`):
about 30,000 rows, the newest 2,200 terminal rows still hot as a bounded
archive pass leaves them, large operation-owner and receipt payloads,
operator roots holding the Telegram grant with delegated children claiming
it, receipts naming conversations that never existed, receipts whose parent
contradicts their lineage edge, children with no edge at all, live hosts,
and held and uncertain deliveries. It then returns the registry to the
schema the previous release left and acts as a Viewer opening it, with nothing
of the caller's environment but its `PATH`, so provider homes and Claude Code's
task directory are the sandbox's own:

- **First boot**: the registry opens and upgrades, the first snapshot is
  taken, and a cold projection worker builds the first board projection.
- **Warm operation**: this process writes grant-bearing rows every 60 ms
  while a second process does the same over its own connection; keyed
  operation-id reads run beside them; eight board scopes, each pinning a
  different conversation, poll through the real `/api/files` handler and its
  resident worker.
- **Release handover**: a successor process opens the same registry, runs the
  archive pass and decides the same grants while the first process keeps
  writing and serving.

Run it locally with `bun scripts/verify-viewer-runtime.ts --performance`
(add `--scale 0.1` for a quick structural run; only the full scale is a
verdict).

### Bounds and why

| Bound | Limit | Why |
| --- | --- | --- |
| Warm grant-bearing write | p95 ≤ 350 ms, max ≤ 500 ms | SQLite writes run on the Viewer's thread. The fixed path measures single-digit milliseconds; the limits leave room for a contended machine and for one write waiting behind an archive pass, and stop well before the 1.2–1.4 s writes the whole-file decision cost. |
| Viewer event-loop delay | p95 ≤ 50 ms, max ≤ 500 ms | 50 ms is where board input and live updates start to lag. The maximum admits one archive pass or one collection, never a stall a person notices as a frozen board. |
| Projection worker | cold ≤ 8 s; warm p95 ≤ 1 s, max ≤ 2 s | The first build spawns the worker, takes the first snapshot and decides every archived grant once; it measures about 4–5 s on an idle machine. Warm builds after a write refresh the snapshot and rerun the passes from cached projections. The worker's own timeout is 60 s. |
| Eight-scope requests, queue wait included | p95 ≤ 5 s, max ≤ 10 s; queue depth ≤ 8; no timeout retirement | Each scope coalesces into one build, so eight scopes can never queue more than eight builds; a cold scope's first request waits for every build ahead of it, which these limits bound. |
| Successor ready | ≤ 15 s | Open, snapshot and one archive pass under a live writer; measured about 6 s. |
| Failures | no SQLITE_BUSY, no runtime timeout, no failed write | A refused or timed-out write loses the work it carried, which no latency bound measures. |
| Evidence | pending and uncertain deliveries byte-identical and hot; live entries keep owner, claim and host; every MCP grant decided the same by writers and the successor | Speed bought by dropping evidence or authority is a regression the latency bounds cannot see. |
| Stability | once writes, the handover and the archive pass are over and their builds have finished, every scope shows exactly the rows it showed before the first write | Writers only restamp live entries and archiving conserves rows, so any row that appears or disappears is the projection flapping under load, which reads as conversations vanishing from the board. |

The latency numbers are the bounds the post-incident audit proposed. They
were kept because the fixed code meets them with margin on an idle machine.

### Proving the gate refuses

`--induce-slow-ms <n>` holds every write of the gate's own writer for `n` ms,
as a slow candidate would. `candidatePerformanceRun.test.ts` runs it and
requires the refusal to name the breached bounds while every evidence
invariant still holds; `deployment.test.ts` requires a refused candidate to
be retired with the previous release still current. A report that passes
with breaches, without measurements or under an induced delay is read as a
refusal.

### What the gate does not cover

The gate drives the board through its HTTP handler. A candidate container has
no browser and no network, so the gate renders nothing. Rendering stays with the
existing browser drivers (`AGENTS.md`, "Rendered evidence").
