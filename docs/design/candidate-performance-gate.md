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
6. **A release's activation walked the whole history.** Once a successor was
   appointed, its structured-host startup re-read every conversation, entry,
   receipt and delivery several times over: a copy of the whole registry per
   inventory, a whole-file grant decision per host it claimed and per
   capability it rotated, a keyed registry transaction per retained
   conversation, and a reread of every archived row after each commit of any
   writer, because the archived-row cache was keyed by the commit stamp and
   held 128 rows. Over 30,000 rows that held the successor's event loop for
   13 s right after promotion and its re-hosting of live workers past 45 s;
   the incumbent's demotion took long enough per host that a working agent's
   transcript moved under it and the hand-over was refused.

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
  build when 16 builds already wait, and a build still waiting 30 s after it
  arrived leaves the queue then, freeing its slot, whether or not the build
  ahead of it has finished; the scope then serves its last representation. A
  queued build is discarded when the scope already holds a body for the same
  input. Queue wait and build time are reported separately
  (`files-worker-queue`, `files-worker-build`), and every finished build
  reaches the queue's observers, however many the bounded diagnostic history
  has let go.
- Archived rows whose reading depends only on their immutable version (and,
  for a grant-bearing row, the decision pinned on it) stay normalized across
  commits, bounded at 48 MB of stored payload; operation owners, which
  normalize against their deliveries, keep the per-commit cache. What a
  snapshot derives from the archive mapping alone is kept with the mapping.
- The structured-host startup and the release demotion read by index: the
  inventory finds each observation's owners through the path and generation
  identity indexes, a single entry's grant decision reads only the
  conversations that attest to it, capability rotation and a launch's failed
  first message read their rows by key, a host's conversation and an
  obligation's deliveries are found by index, open-work sweeps read only rows
  the archive has not taken (archived rows are terminal by its rules), and
  aliases resolve against the snapshot in hand. Each startup phase begins on
  a turn of the event loop of its own. A row the incumbent hands over while
  the successor's pass runs makes that pass retry instead of leaving the row
  to on-demand hosting.

- The requests a board page makes while it is open read by index or from the
  rows the archive cannot hold. Eight browser views over the history showed
  what the HTTP measurements had not: `/api/accounts` enumerated every
  conversation once per completed account migration, `/api/log/provenance`
  read every held delivery and operation owner of the history for one
  conversation, `/api/account-project-bindings` read every conversation to
  find the busy ones, and a board write read every conversation twice. A
  conversation that carries a migration or an open turn is never archived, so
  the first two read hot rows; provenance reads one conversation's deliveries
  and owners through the conversation index; the board write reads a narrow
  projection of each conversation's paths. The host-badge poll
  (`/api/conversation-host/targets`) answers from the last completed scan:
  waiting for a rescan to take in a new transcript held every view's first
  poll for 7-8 s.
- The one-time identity wave decides title cleanup from one pass over the
  entries and receipts. It asked each conversation to walk both collections,
  which over this much history held a fresh registry's first boot for more
  than a minute. A registry that has run it, as every installation with this
  much history has, skips it, and the synthetic dataset carries its marker.

## The gate

`verify-candidate` now runs two rehearsals inside throwaway containers from
the candidate image, without network or mounts: the runtime-host rehearsal
(#1254) and this gate (`src/runtime-host/candidatePerformanceRun.ts`). A
candidate passes only when both pass. A refused candidate is retired before
anything is switched, and the release that was serving keeps serving
(`ViewerDeploymentCoordinator`, phase `candidate-health`). The adapter
computes the verdict again from the measurements against the bounds the
deploying release holds: a report whose measurements are missing, garbled or
over a bound is refused whatever its own `ok` says. A `verify-candidate`
answer that carries no performance report, or no runtime-host rehearsal, is
refused too: it reads exactly like an adapter that skipped them. Only
`verify-promoted`, which reads the release already serving, owes neither.

The gate runs in the candidate's gate image: the `candidate-gate` stage of the
`Dockerfile`, which is the runtime image plus Debian's Chromium. The deploy
adapter builds it beside the candidate from the same source and cache and
removes it once the gate ran or the candidate is retired. Chromium sits on the
runtime's system stage, which no source change touches, so the browser layer
is built once and a deploy only copies the application over it. The serving
image carries no browser. A revision whose `Dockerfile` has no such stage runs
the gate in its own image, finds no browser and is refused.

The runner builds a synthetic registry (`registryPerformanceDataset.ts`):
about 30,000 rows over eight working directories, the newest 2,200 terminal
rows still hot as a bounded archive pass leaves them, large operation-owner
and receipt payloads, operator roots holding the Telegram grant with
delegated children claiming it, receipts naming conversations that never
existed, receipts whose parent contradicts their lineage edge, children with
no edge at all, held and uncertain deliveries, transcripts for the newest 320
conversations, and four live workers whose rows the previous release left
live with their turns open. It returns the registry to the schema the
previous release left. Then it plays the runtime host and the deployment
around two Viewer releases, each its own process, with nothing of the
caller's environment but its `PATH`:

- **First boot**: release A opens and upgrades the registry, takes the first
  snapshot and builds the first board projection with a cold projection
  worker, its event loop watched from before the registry opens. Its
  structured-host startup re-hosts the four workers: processes that write a
  progress step into their transcripts every second and answer on a socket,
  each resumed from its transcript, as `codex resume` resumes.
- **Warm operation**: release A writes grant-bearing rows every 60 ms while a
  separate process does the same over its own connection, keyed operation-id
  reads run beside them, and eight board scopes, each pinning a different
  conversation, are asked of A over HTTP.
- **Release handover**: release B boots beside A, runs the archive pass,
  decides the same grants and builds its own first projection while A keeps
  writing and serving. Once B is ready the serving target names it, the way
  promotion does: A demotes through `completeViewerReleaseDemotion`, handing
  each worker over and exiting with the demotion's code, and B's production
  structured-host startup re-hosts every worker; only the engine it starts is
  synthetic. The board is asked of whichever release the target names.

- **The board in a browser**: once the releases are done, the candidate's own
  production build (`next start` over the image's `.next`) serves the history
  they left, and eight Chromium views at 1440 × 900, each pinning its own
  conversation, open the board while two writer processes keep writing
  grant-bearing rows (`src/runtime-host/candidateBrowserRun.ts`). Each view
  must draw its board, keep its selection, receive board answers while the
  writers run and answer a wheel turn. A request's time runs from the page
  issuing it to its last byte, so a wait for one of the browser's six
  connections counts: the operator waits through it too.

Every board answer is compared with its scope's settled answer from before
the first write; every worker is pinged twice a second and its progress read
back from its transcript. A successor that exits without its report, is
killed, or never becomes ready is a failed release: the target never moves,
release A keeps serving and keeps its workers, and the gate refuses.

Every child of the gate runs with the gate's private root as its `TMPDIR`, so
its home, configuration and state sit under its own temp root. Run from a
stage whose temp directory lies under the operator's `state/scratch`, a
sibling `TMPDIR` left them outside every temp root the child knew, the child
read them as the operator's, and its registry open was refused before it
measured anything. The board driver's server and writers get their capture
root as `TMPDIR` for the same reason.

Run it locally with `bun scripts/verify-viewer-runtime.ts --performance`
after `bun run build`, with `CHROME_BIN` naming a Chromium; without a build or
a browser the board is not measured and the run is refused. `--scale 0.1` is a
quick structural run and is always refused, because only the full dataset is a
verdict; it skips the browser, as does a run under an induced fault.

### Bounds and why

| Bound | Limit | Why |
| --- | --- | --- |
| First boot | registry open ≤ 2 s, first snapshot ≤ 2 s, open to first usable board ≤ 10 s; event loop ≤ 1 s | The upgrade and the first snapshot are synchronous; each is bounded apart from the cold build so a slow open cannot hide behind a fast projection. Measured: open 0.1–0.2 s, snapshot 0.5–0.7 s, first board 5–7 s. |
| Release activation | each release ≤ 15 s from appointment to its startup ready with every worker re-hosted; event loop ≤ 1.5 s | The activation re-reads retained history for the hosts it adopts. Measured 4–6 s and 0.4–1.3 s after this change; 13 s of event loop and no re-hosting within 45 s before it. |
| Warm grant-bearing write | p95 ≤ 350 ms, max ≤ 500 ms | SQLite writes run on the Viewer's thread. The fixed path measures single-digit milliseconds; the limits leave room for a contended machine and for one write waiting behind an archive pass, and stop well before the 1.2–1.4 s writes the whole-file decision cost. |
| Viewer event-loop delay while serving | p95 ≤ 50 ms, max ≤ 500 ms | Each release outside its boot and its activation, measured by a 10 ms timer's lateness. 50 ms is where board input and live updates start to lag; the maximum admits one archive pass, never a stall a person notices as a frozen board. |
| Projection worker | cold ≤ 8 s; warm p95 ≤ 1 s, max ≤ 2 s | Every warm build of both releases, collected as each finishes; the cold build is the one each process started first. The worker runs the candidate's source. |
| Eight-scope requests, queue wait included | p95 ≤ 5 s, max ≤ 10 s; queue depth ≤ 8; no timeout retirement; no failure across the transition | Each scope coalesces into one build, so eight scopes can never queue more than eight builds. |
| Successor | ready ≤ 15 s; first projection ≤ 8 s; every live worker re-hosted ≤ 15 s after the switch | Open, snapshot, one archive pass and a first projection under a live writer; then the hand-over. |
| Live workers | all re-hosted by the successor and answering at the end; no progress step lost or repeated; no gap over 20 s; no ping unanswered outside the switch window | A worker is the operator's agent: the transition may pause it, never lose its place or leave it without a host. |
| Failures | no SQLITE_BUSY, no runtime timeout, no failed write; the successor reports and exits 0; the incumbent's demotion exits 0 | A refused or timed-out write loses the work it carried, which no latency bound measures. |
| Evidence | pending and uncertain deliveries byte-identical and hot; every MCP grant decided the same by writers and the successor | Speed bought by dropping evidence or authority is a regression the latency bounds cannot see. |
| Stability | every measured answer of every scope carries the rows, conversations and projects of its settled answer from before the first write, and its pinned conversation; no answer is empty | Rows that appear, vanish or change project read as conversations jumping on the board. The history spans eight projects, so the board's ten-project window holds all of it whichever project a write makes the newest. |
| Browser views | each of eight views: board drawn ≤ 10 s from navigation; `/api/files` p95 ≤ 5 s, max ≤ 10 s; any other API request ≤ 10 s; main thread ≤ 1 s before the board drew, p95 ≤ 50 ms and max ≤ 500 ms after; a wheel answered ≤ 500 ms; selection held, no missing-conversation notice, a board answer while the writers ran; ≥ 50 writes, none failed | What the operator sees is the page, not the handler. The HTTP bounds above held while the page took 15-19 s to draw: `/api/accounts` enumerated every conversation of the history once per completed account migration, through a lazy reader that stats the database twice per row, and held the server's thread for two thirds of a minute-long run ("What changed" lists the page's other whole-history reads). |
| Sufficiency | full dataset (≥ 29,000 rows, ≥ 90 % cold); ≥ 50 writes per writer, ≥ 20 keyed reads, ≥ 8 warm builds, ≥ 64 board requests, ≥ 8 compared rounds, ≥ 2 workers, pending and uncertain deliveries present | A run that measured nothing passes nothing. |

The latency numbers are the bounds the post-incident audit proposed, with the
first-boot and activation bounds added here. They were kept because the fixed
code meets them, on a machine whose 24 cores carried a load near 23 from
other agents while it ran.

### Proving the gate refuses

`candidatePerformanceRun.test.ts` runs the gate against faults it injects and
requires the refusal to name them while every evidence invariant still holds:
`--induce-slow-ms <n>` holds every write of release A for `n` ms; a runtime
shim through `LLV_CANDIDATE_PERFORMANCE_BIN` makes release B exit 7 without a
report, which leaves A serving and hosting its workers, and the same output
read through the deployment adapter refuses the candidate; `--induce
worker-kill` kills a re-hosted worker. `deployment.test.ts` requires a refused
candidate to be retired with the previous release still current, and an
adapter answer without a performance report, read through the real
host-command adapter, to be retired the same way. The full pass runs with
`LLV_CANDIDATE_PERFORMANCE_FULL=1` and needs a production build and
`CHROME_BIN`. A report that passes with breaches, without or with garbled
measurements, without the browser views, or under an induced fault is read as
a refusal.

### Rendered evidence

The board driver's case `BOARD_CAPTURE_CASE=registry-history` in
`scripts/capture-board-geometry.ts` runs the same browser half
(`candidateBrowserRun.ts`, same bounds) against a local production build and
keeps each view's requests, its opening sequence and a frame of it, for
reading what holds a connection when a bound is breached. Run it with
`CHROME_BIN` set after `bun run build`.

Through `scripts/gate-slot.sh` the whole case shares one scope's CPU quota,
300 % by default: the production server, eight Chromium renderers, two writers
and the driver on three CPUs. The renderers' script work then delays the
server's own answers and the board draws at about ten seconds, at its bound.
Give the scope room for eight browsers, `LLV_WORK_SCOPE_CPU_QUOTA=1200`, to
measure the server rather than the quota; the gate's container has no such
quota.
