# Cold board startup audit

Measured 2026-10-15, against main `45d25ac796d5824713c9fb57d65f57efea61041b`.
This is a read-only investigation and a proposed implementation method. No
application change or before/after acceptance result is included.

The first substantive board response is `GET /api/files?view=summary`.
On the captured production data, three fresh processes with empty board caches
took **9.626 / 9.728 / 11.386 seconds to first byte**, including
**5.255–6.463 seconds in the scan envelope** and **3.232–3.886 seconds in the
projection-worker envelope**. Keeping the persisted scan reduced first-byte
time to **5.278–5.820 seconds**. The summary itself was about **33.4 MB**.

The recommended mechanism is to **persist the serialized operator summary,
serve that compatible representation first, and refine through the existing
worker**. Prepare the serving route's modules before handing it traffic: the
existing Next startup produces a separate 1.49–1.78-second Viewer loop pause.
The implementation must measure both process-start-to-data and
request-to-data; preparing before traffic improves the latter while moving
startup work earlier. The pinned acceptance wording permits release handover
preparation and specifies roughly one second from the first request. A strict
one-second bound from process creation has not been demonstrated here.

## Evidence and reproducibility

All times below are UTC on 2026-10-15 unless a different date is stated.
`$PRIVATE` denotes the retained private audit directory, created at
05:13:51.414313Z (basename `cold-board-audit-77nhtaj6` under the OS temporary
root); `$SOURCE` is its archive of the measured commit. `$INSTALL`,
`$LIVE_STATE` and the legacy transcript roots denote the existing installation,
without publishing its account names or absolute home paths. Raw bodies,
profiles, manifests and harnesses remain private because they contain production
content. No production HTTP endpoint was requested.

| Evidence | Command or query and time bounds | Result |
| --- | --- | --- |
| Main identity | `git rev-parse HEAD`; `git ls-remote origin refs/heads/main`, checked at 05:12:33Z | Both identify the commit above; the pipeline branch was left in place. |
| Earlier work | `search_transcripts` with project `delegatus`, queries `scan 1,677 worker 2,103` and `8478db36`; unscoped `"2.103" "scan"`; then `conversation_messages` on returned transcript paths, during 05:10–05:14Z | Recovered the earlier builder and audit conclusions; checked their claim against the committed investigation below. |
| Prior solution search | Project-scoped and unscoped `search_memory` for `cold board scan worker production`, `board cold startup`, `files response worker`; transcript search `"persisted summary" "cold"`, during 05:10–05:29Z | No applicable memory solution. The transcript result about scan-summary validity does not supply a persisted first-board representation. |
| Serving revision | `deployment_status({compact:true,limit:2})`, observed during 05:13–05:14Z | Installed revision `781ecd4c33482d7486683d19d61a8b0bc8c14d38`, deployment completed 00:28:32.843Z. These replay results concern main, rather than a timing observation of that serving process. |
| State capture | Python `sqlite3.connect("file:" + source + "?mode=ro", uri=True)`; `PRAGMA query_only=ON`; `source.backup(destination, pages=256, sleep=.005)`, 05:14:30.987485–05:14:32.762804Z | One immutable reference backup each of the state and registry databases. |
| Auxiliary capture | Same backup method for transcript-search and memory-index databases, 05:16:40.255211–05:16:42.741321Z; `cp -aL --reflink=auto` for transcript roots, with per-copy times in `evidence/transcript-copy.json` | Private transcript and index copies; no source writes. |
| Current route trace | `rg` and `nl -ba` on the files cited below, 05:12–05:35Z | The route can perform a task migration and persist caches; issuing a live GET would violate read-only access. |
| Baselines | Gate-wrapped `python3 "$PRIVATE/launch-v3.py" restart1 restart2 restart3 cold-final1 cold-final2 cold-final3`, 05:22:49.532444–05:23:50Z | Six isolated production-build runs; exact process/request times retained in each `result.json`. |
| Saved-byte feasibility | Gate-wrapped `python3 "$PRIVATE/launch-persist.py" persisted-read1 persisted-read2 persisted-read3`, 05:26:15.616897–05:26:21Z | Three separate minimal Bun processes serving one saved response body. |
| Integrity and cleanup | SHA-256 comparison of reference databases at 05:27:32.350Z; comparison of all three saved-byte responses and existence checks under `/proc` for the recorded PIDs at 05:33:44Z | Reference hashes unchanged; saved-byte responses identical; all 41 recorded application/helper PIDs, including excluded trials, absent. |

The earlier result is preserved at
`docs/investigations/viewer-load-stall-2026-10-13.md:531`: candidate cold first
files request **4,166.999 ms**, scan **1,677.1 ms**, worker **2,102.9 ms**;
old code **4,393.728 ms**. That experiment also measured the cold page separately
at 253.107 ms. The builder's recovered 2026-10-13T15:34:00.726Z message identifies
the warm-loop improvement from 20.49 seconds to 51.6 ms and explicitly leaves
cold startup separate.

Those numbers use the earlier generated production-size catalog: 37,471 rows,
121,702,694 payload bytes, 4,810 transcripts and a separately prepared pipeline
archive (`:477`). This audit uses a newer real copy and sends the files request
as the first HTTP request. The data, request order and CPU budget differ.
**The difference from 4.167 seconds does not establish a code regression.**

### Captured data and isolation

The database counts came from `SELECT count(*) FROM <table>` and, for state
collections, `SELECT collection,count(*),sum(length(value_json)) FROM
state_rows GROUP BY collection` against the backups. Payload lengths here are
SQLite text lengths, not UTF-8 wire sizes.

| Reference | Size / contents | SHA-256 |
| --- | --- | --- |
| `state.sqlite` | 156,934,144 bytes; 9,610 state rows; 34,613 changes; 259 active and 654 archived pipeline rows containing 108,482,401 payload characters; 1,805 task rows | `18a6233ac10e1d53d54e28a9bf02d619e1e233035d66736d95238f3e1e17617b` |
| `agent-registry.sqlite` | 416,198,656 bytes; 42,196 registry rows; 44,171 archive rows; 41,681 cold rows; 6,577 conversation-path rows | `6a2ae562770e08cb1d6133034c72b35fdf9f0c236d985e7b8bb07f72b8f8199f` |
| `transcript-search.sqlite` | 711,688,192 bytes | `790fcf99cd425c1d2e637c73230ae1aca266bd549f7b571698fde32054275d1a` |
| `memory-index.sqlite` | 48,521,216 bytes | `84bc8e42d4b72182568d0acd6e4bac46a7da3ecafff86b807d4b12effb764a83` |

Nine transcript roots supplied 9,990 copied files / 25,608,260,491 bytes,
including overlapping legacy and managed roots. Discovery deduplicated these
into 6,713 catalog entries and 565 scan files. The built summary contains
671 files after projection, 1,703 tasks, 234 pipelines, no flows and ten project
catalog rows. Persisted-scan runs contain 681 projected files. Store row counts
and visible summary counts describe different populations.

The reference backup is read-only source material. Each Viewer receives its own
disposable writable clone, because real stores, scan persistence and migration
checks require writes even during a data GET. Neither production nor the
reference backup is mounted writable. Transcript roots are read-only mounts at
their original logical paths, preserving identities already stored in the
database. Capturing separate databases and transcript files is not an atomic
cross-store snapshot; all runs replay the same captured set.

The namespace uses `bwrap --ro-bind / / --unshare-net --die-with-parent`, a
private writable run directory and a writable state-clone mount. Its only
network is private loopback. HOME, TMPDIR, XDG config/cache and physical state
are under the private temporary directory. `LLV_VIEWER_CONTROL_URL` points to
`http://127.0.0.1:1`; runtime sockets and deployment targets are private absent
paths. Structured hosts, account controllers, runtime events and the reaper
are disabled. A private release record pointing to port 1 defers current-release
activation. No runtime host is started, adopted, restarted or measured.

Consequently, these are **production-build data-path measurements with runtime
activation deferred**. Durability checks, adoption, controller startup and actual
release succession are traced in code below, but their elapsed time is outside
these measurements. Read-only filesystem metadata outside the copied roots can
still be observed. Clock/liveness-dependent output varies slightly across runs.

The source was exported with `git archive HEAD`. Its dependency directory came
from an existing checkout with byte-identical `bun.lock`; no installation ran in
the pipeline worktree. `bun run build` passed, including the MCP build, using
Bun 1.4.0 and Next 16.3.8. Heavy commands ran serially through the prescribed
`scripts/gate-slot.sh`, with `LLV_GATE_MEM=12G`. Recorded cgroup limits were
three CPU cores (`60000 20000`) and 12 GiB; the ancestor work limit was 18 cores.
First-request throttling was 165–219 ms for empty-cache runs and 426–626 ms for
persisted-scan runs. No memory-event counter increased in those intervals.
These are constrained-host measurements, with no claim about an unthrottled
production host's latency.

Each fresh process ran the equivalent of:

```sh
bun --cpu-prof --cpu-prof-name=main.cpuprofile --cpu-prof-dir="$RUN" \
  --preload "$PRIVATE/preload-v3.ts" --bun "$SOURCE/node_modules/.bin/next" \
  start "$SOURCE" --hostname 127.0.0.1 --port 0
curl --silent --show-error --max-time 120 \
  -D "$RUN/headers-0.txt" -o "$RUN/body-0.json" \
  -w '%{http_code} %{time_starttransfer} %{time_total} %{size_download}' \
  "$ASSIGNED_URL/api/files?view=summary"
```

The harness records PIDs when spawning, discovers the assigned port, and sends
the first request without a page or health warmup. A preload samples a 10 ms
timer in each application process, records synchronous JSON/filesystem calls
taking at least 10 ms, and records helper launches. Profiles and instrumentation
add overhead; every main baseline uses the same instrumentation. Timers retain
their intervals in private per-PID files. Cleanup signals only recorded owned
PIDs, and all were checked absent afterward.

The empty-cache treatment removes `files-scan-snapshot.json` and
`files-response-cache*` only from that run's new clone. It preserves the
production catalog index, databases and transcripts. Persisted-scan runs retain
the captured scan and response files. OS page caches were not flushed: “cold”
means a new Viewer and workers with the stated application caches empty.

Initial trials were excluded after discovering that the copied managed account
directories had overly permissive modes. `src/lib/accounts/codex.ts:173` checks
the home mode and `:206` filters unsafe homes. Copying source directory modes
restored the real discovery population before all six reported baselines.
Failed trials and their logs remain private; they are not substitutes for runs.

## Process and request timeline on current main

Line references in this section are for the measured commit. The runtime host,
Viewer, scanner and projection worker are distinct processes.

| Order / process | Work and source | Event-loop implication |
| --- | --- | --- |
| Stable listener: runtime host | `src/runtime-host/deploymentProxy.ts:25` reads the deployment target for accepted connections. `deployment.ts:356` coordinates candidate health, promotion and post-promotion health; `deploymentHealth.ts:101` checks release readiness. | It forwards traffic. It does not build this board projection. No runtime-host timing is claimed. |
| Viewer boot | `src/instrumentation.ts:39` folds environment aliases, claims the Viewer owner and imports runtime instrumentation. `src/lib/viewerInstrumentation.ts:907` installs loop monitoring, spawn capability resolution and phone access gating before release activation. | Imports execute in the Viewer process. The measured Next startup module loads contain long synchronous work. |
| Current-release activation | `viewerInstrumentation.ts:934` enters the release-fenced callback: establish cutover boundary, database durability checks, store initialization, legacy import, recovery and controllers (`:940`, `:952`, `:978`). Host adoption is launched through a guarded background task (`:968`). Release-ready publication follows activation (`:982`; `completeViewerRuntimeActivation` at `:820`). | This branch was intentionally deferred in the safe replay. It does not prebuild the first summary. A future pretraffic design must gate actual traffic, including the proxy target, rather than merely set a readiness field. |
| First HTTP request: Viewer | `src/app/api/files/route.ts:1` exports the projection handler. `operatorProjection.ts:623` reads revision/generation and scope, marks board presence, then awaits `cachedFileScan` (`:635`). `src/app/api/board/route.ts:15` serves board placement, so timing it would miss the substantive board cost. | The request is suspended while other Viewer work can run. This GET has side effects and was used only on private clones. |
| Scan cache: Viewer | `src/lib/scanner/scanCache.ts:820` loads and primes a complete persisted schema-12 snapshot once. With it, `:942` awaits membership probing and can return the completed snapshot while refresh proceeds. Without it, `:1030` waits for the first scan. Membership probing is in `catalogMembership.ts:34`; listings/stat calls are bounded and asynchronous. | Persisted-scan adoption saves most initial scan waiting, but still reaches projection construction. Priming, sorting and snapshot serialization include synchronous Viewer work. |
| Scan orchestration: Viewer → scanner child | `scanCache.ts:546` brackets membership-before, coordinated scan, membership-after and persisted-snapshot write. `scanCoordinator.ts:95` chooses the compiled worker, with an in-process fallback; `fileScanWorker.ts:125` launches the leased helper at nice 10. All reported runs actually launched it. | `files-scan` is this entire awaited envelope (`scanCache.ts:506`), including scheduling and parent continuations; it is not exclusive scanner CPU time. |
| Scanner child | `src/lib/fileScanner.worker.ts:28` calls `listFilesWithProjectCatalog`. `scanner/index.ts:334` supplies registry/cwd information; `discover.ts:560` discovers transcripts, canonicalizes projects and produces capped and uncapped catalogs. `index.ts:371` hydrates liveness/title/model metadata. `projectCatalog.ts:222` loads the persisted catalog index; `:295` persists it. | Filesystem traversal mixes asynchronous I/O and CPU work; index parsing/stringifying and writes can block this child's event loop. |
| Scan transport: scanner → Viewer | `fileScanner.worker.ts:24` serializes frames. `fileScanWorker.ts:170` parses stdout frames; `:231` publishes the full conversation catalog and schedules indexing. `scanCache.ts:326` synchronously serializes/writes/fsyncs the persisted scan snapshot. | Child serialization and Viewer parsing are separate costs. The asynchronous scan does not eliminate these Viewer holds. |
| Post-scan work: Viewer | `operatorProjection.ts:652` may run `ensureEmptyTaskBoardVisibilityMigration`; `src/lib/tasks/boardVisibilityMigration.ts:59` enters task mutation even to discover an existing migration marker. `operatorProjection.ts:223` derives the projection key from collection revisions and state signatures; `:282` consults registry diagnostics. | Store opening, parsing, signatures and a first-request migration check occur before the response worker. This is why a production GET was not used as a read-only probe. |
| Projection cache / dispatch: Viewer | `operatorProjection.ts:445` joins/reuses projections; `:494` sends a snapshot path when possible. `:678` warms the persisted response only for full operator responses; summary is excluded. `:549` persists only the unscoped full representation. `projectionQueue.ts:113` times the queued build. | A saved scan alone cannot satisfy a cold summary. The existing full-body cache and transport delta bases do not constitute a versioned summary bootstrap cache. |
| Projection worker launch | `src/lib/scanner/filesResponseWorker.ts:339` launches the compiled child at nice 10; `:435` sends its small request; `:499` serializes jobs. `src/lib/filesResponse.worker.ts:60` reads/parses the scan file. | `files-worker-build` includes spawn/module loading, build, serialization, result-file transport and parent resumption. Queue delay was 0.1 ms; the expensive part was executing the job. |
| Projection stores: worker | `src/app/api/files/response.ts:287` starts the build. `:318` reads the registry snapshot; `:342` builds launch cards and lookup state. `src/lib/agent/registry.ts:5503` delegates to `sqliteRegistryStore.ts:1175`; refresh, hot rows and lazy cold hydration are at `:1140` and `:1700`. | Synchronous SQLite reads, JSON decode/freeze, lineage/owner/liveness derivation and joins block the worker. The Viewer awaits their result. |
| Remaining projection: worker | `response.ts:699` loads flows; `:706` tasks; `:803` workflows; `:816` pipelines and embedded review overlays; `:837` project liveness/rate limits; `:958` finishes project catalogs/cwds and attention data. `tasks/store.ts:560`, `workflows/store.ts:290`, `pipelines/store.ts:1445` supply store caches/read paths. | These are cold per-process store/cache reads. Pipeline projection revives its own copies; this path does not require decoding the whole archived pipeline collection. |
| Summary serialization: worker | `response.ts:1000` selects the summary projection, serializes it, hashes it and constructs the response. `filesResponse.worker.ts:81` obtains the body text, writes a result file, parses the body again for health and records delta-base material (`:126`). | “Summary” still includes large task and related records. Serialization, health parsing and file writes are substantial worker holds. |
| Response transport: Viewer | `filesResponseWorker.ts:448` asynchronously reads the result body and cleans up its file. `operatorProjection.ts:689` adds representation/scan metadata, optionally chooses a certified delta, and optionally gzips (`:717`) before returning the response. | These runs requested a full uncompressed body. Body construction/copying and current-health overlays remain possible parent costs. Gzip was not measured. |
| Concurrent feed: Viewer | `src/lib/search/transcriptFeed.ts:100` schedules work after catalog publication. `:43` indexes transcript sources, refreshes memory and records activity. `src/lib/memory/service.ts:20` discovers roots for that refresh. | “Background” work still shares the Viewer event loop and CPU allocation before first data. Its readiness must be recorded when comparing runs. |

## Measured split

Every row below returned HTTP 200 and a parseable `board-summary` representation.
TTFB is curl's `time_starttransfer`; complete is curl's `time_total`.
Process→body uses the parent's timestamp immediately before `Popen` and after
curl completion, so includes process-launch/driver overhead. Values are ms.

| Empty-cache run / process start UTC | Viewer / scanner / projection PID | Port | Scan | Worker envelope | TTFB | Complete | Process→body | Viewer max timer gap |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| C1 / 05:23:12.960143 | 3626504 / 3626825 / 3627356 | 40761 | 5,361.3 | 3,231.8 | 9,625.521 | 9,643.282 | 9,950.009 | 1,719.3 |
| C2 / 05:23:24.521690 | 3627941 / 3628034 / 3628325 | 37929 | 5,255.0 | 3,620.3 | 9,727.974 | 9,756.700 | 9,955.587 | 1,486.3 |
| C3 / 05:23:36.745051 | 3629132 / 3629383 / 3629903 | 44781 | 6,463.4 | 3,885.8 | 11,385.997 | 11,409.174 | 11,653.876 | 1,775.7 |

First requests began at 05:23:13.261308 / 05:23:24.711024 /
05:23:36.979571Z and completed in the driver at 05:23:22.910152 /
05:23:34.477277 / 05:23:48.398927Z. Body sizes were 33,421,344 /
33,420,973 / 33,420,971 UTF-8 bytes.

TTFB minus scan, queue and worker envelope is approximately 1,032.3 / 852.6 /
1,036.7 ms. This is an unattributed remainder containing routing, startup,
store/key work and transport/scheduling. The startup timer gap can overlap an
awaited scan envelope, so adding that gap again would double-count time.

| Persisted-scan run / process start UTC | Viewer / scanner / projection PID | Port | Worker envelope | TTFB | Complete | Process→body | Viewer max timer gap |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| R1 / 05:22:49.532444 | 3624267 / 3624321 / 3624310 | 42105 | 3,912.3 | 5,699.483 | 5,723.344 | 5,894.594 | 1,510.1 |
| R2 / 05:22:57.479719 | 3624964 / 3625008 / 3624998 | 46689 | 3,509.7 | 5,278.215 | 5,310.482 | 5,498.874 | 1,495.0 |
| R3 / 05:23:04.828509 | 3625474 / 3625764 / 3625754 | 36311 | 3,895.0 | 5,819.789 | 5,842.134 | 6,026.764 | 1,599.5 |

The persisted scan was usable; the scanner also launched a membership refresh.
There was no awaited `files-scan` metric in these first responses. The body was
33,382,494 bytes in each run. This treatment still misses one second by a wide
margin.

The next requests in C1/C2/C3 had TTFB **93.251 / 235.135 / 203.158 ms** and
complete-body times **111.530 / 272.442 / 229.937 ms**. They followed response
parsing in the driver and a 150 ms wait. These are warm controls, not an “after”
implementation result or a claim that deferred initialization has fully settled.

### Projection worker detail

The response's Server-Timing fields give these nested spans. Aggregate rows
contain their component rows, so this table must not be summed vertically.

| Span, ms | C1 | C2 | C3 |
| --- | ---: | ---: | ---: |
| Registry aggregate | 1,540.5 | 1,677.7 | 1,832.0 |
| Session titles | 126.0 | 153.0 | 157.0 |
| Flow store | 2.0 | 2.6 | 2.2 |
| Task store | 56.3 | 67.5 | 73.6 |
| Authorship | 89.7 | 97.7 | 161.5 |
| Role titles, including workflow/pipeline reads and overlays | 439.4 | 560.4 | 520.8 |
| Flows/tasks/workflow aggregate | 715.0 | 883.5 | 917.3 |
| Project rate limits | 134.6 | 132.4 | 145.6 |
| Project cwd work | 280.0 | 302.6 | 339.9 |
| Projects aggregate | 457.6 | 480.8 | 536.3 |
| JSON/response construction span | 150.5 | 140.1 | 162.2 |

C1's worker trace further divides registry work into snapshot 357.3 ms,
launch projection 306.0 ms, parent closure 189.1 ms, receipt owners 119.3 ms,
supersedence 68.9 ms and turn liveness 499.6 ms. This demonstrates that merely
optimizing a SQL query leaves considerable derivation work.

The C1 synchronous-call probe recorded `JSON.stringify` at 103.5 ms for
30,908,942 JavaScript code units, body-file writing at 26.9 ms, body parsing for
health at 39.4 ms and delta-base writing at 40.4 ms in the projection worker.
The scanner serialized a 5,254,960-code-unit frame in 13.0 ms. The Viewer
recorded JSON parses of 27.4 ms and 10.3 ms for other frames/cache data.

### What blocks the event loop

The Viewer CPU profiles place the initial long pause under Next
`requirePage` → `loadComponentsImpl` → `unstable_preloadEntries`, through compiled
route/module loading. Installed Next sources are
`node_modules/next/dist/server/require.js:98`, `load-components.js:88` and
`next-server.js:515`. The production preload is started at `next-server.js:470`;
the method prepares and loads entries at `:515`. These synchronous module loads
execute inside the Viewer despite the asynchronous surrounding function.

Next's startup log is an insufficient readiness boundary:
`node_modules/next/dist/server/lib/start-server.js:276` discovers the bound port,
and `:308` logs readiness before subsequent config/request-handler loading.
The probe deliberately sends the request at this early listener boundary.

After the initial 2.2 seconds, the largest remaining Viewer gaps were
100.4 / 330.1 / 328.5 ms. Samples during C3's later gap map into memory-index
refresh/root discovery, scheduled by `transcriptFeed.ts:43`. This identifies a
competing path; it does not establish an exclusive SQL or filesystem duration
for that pause. Profiling and cgroup scheduling remain part of the observation.

Scanner maxima were 490.5 / 475.9 / 627.6 ms; projection-worker maxima were
1,692.9 / 1,833.4 / 2,010.2 ms. Those child holds delay the answer while leaving
the Viewer available to other work. The Viewer still has its own measured
holds above 50 ms. A change must avoid introducing another large synchronous
body parse, hash, stringify or read into that process and must observe the whole
refinement window, including the scheduled indexing work.

## Chosen mechanism and the browser boundary

Persist a completed, scoped operator summary as bytes with a small versioned
manifest. On restart, admit that artifact before scan, projection-key/store
initialization and first-request migration work; return it through the existing
authorization boundary. Start the normal scan/worker refinement once and let the
ordinary representation replace it. Preserve the body generation separately
from the current/target generation and preserve scope and epoch resets.
An invalid, absent, incompatible or unauthorized artifact must take an explicit
fallback. The implementation must retain current storage-health semantics;
an old body cannot certify current write health.

This needs a new summary bootstrap contract: the existing persisted full-body
path deliberately excludes summary (`operatorProjection.ts:678`), and delta-base
files are transport history. Calling `operatorBoardRepresentation()` is also
unsuitable as a cheap byte warmup: it parses the completed body in the Viewer
at `operatorProjection.ts:738`.

Serve asynchronously from prevalidated bytes and keep large validation,
serialization and compression work off the Viewer event loop. Prepare the
minimal route/module graph before traffic reaches the new Viewer. Full
prebuilding during handover remains a useful fallback for a missing artifact,
but carries 9.6–11.4 seconds of observed read-side construction and does not help
a restart lacking a predecessor unless startup deliberately waits. Cutting scan
and worker cost remains worthwhile; their measured independent magnitudes make
it a larger undertaking for this one-second first-response objective.

An isolated feasibility check served C1's exact saved bytes using
`Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response(Bun.file(body))})`.
It used the existing `candidateServerLoopProbe.ts` timer probe, three new
processes and the same gate allocation:

| Process start UTC / PID / port | TTFB ms | Complete ms | Process→body ms | Max timer gap ms |
| --- | ---: | ---: | ---: | ---: |
| 05:26:15.616897 / 3640053 / 46529 | 0.491 | 13.897 | 36.412 | 0.3 |
| 05:26:17.354216 / 3640183 / 37259 | 0.427 | 22.591 | 73.149 | 25.6 |
| 05:26:19.158247 / 3640318 / 46349 | 0.388 | 17.896 | 37.426 | 0.3 |

All three bodies match SHA-256
`76d1c2da5a9d487b2acfefb15af4b931c9df81735ded2234f504e2303b78a96c`.
This establishes that local byte serving is small relative to reconstruction.
It excludes Next, authorization, manifest validation, compression, refinement
and browser rendering, and therefore supplies **no candidate acceptance result**.
The short timer windows contain only four or five samples.

Browser persistence cannot be assumed at this size. Current main's
`src/hooks/useFiles.ts:1128` serializes the certified raw object before `:1132`
checks its length. `src/lib/client/filesSnapshotStore.ts:23` sets the cap to
`24 * 1024 * 1024` = 25,165,824. The check measures JavaScript code units even
though the constant names bytes. C1's 30,908,942-code-unit serialized body exceeds
it, so this summary is not persisted for a document reload.

The parallel payload audit relayed a later stored body at 05:19:39Z containing
33,532,418 UTF-8 bytes / 31,019,709 code units, 1,705 tasks, 238 pipelines and
686 files. It reported a 76,259-byte delta (10,698 bytes gzip) and Chromium cache
application times of 296.4 ms for full versus 3.6 ms for delta. Those are
**relayed measurements from a different snapshot**, not additional runs here.
Their persistence diagnosis is independently confirmed above on this commit.

The poll lane owns its proposed opt-in v2, legacy full/v1 behavior, explicit
epoch/scope resets and cache serialization. Cold-start work must consume that
contract without independently redefining it. A browser with no certified base
still needs a full initial representation. Server-side summary persistence can
remove reconstruction while leaving that transfer, parse and render cost intact.
Increasing the browser cap alone also leaves the pre-check stringify and server
cold build intact. First-data acceptance must therefore include an empty browser
store and a later document reload, using the eventual agreed cache contract.

## Before/after implementation method

1. Reuse these immutable reference databases and transcripts. Verify their
   hashes, directory modes and visible populations. Export baseline and candidate
   separately; use the same Bun, dependency lock, build mode, instrumentation,
   gate budget and isolated lifecycle settings. Record all PID launches, assigned
   port-0 listeners, UTC boundaries, cgroup throttle deltas and cleanup.
2. Run at least three fresh processes per side, interleaving baseline and
   candidate to reduce host-load drift. Preserve the three cache treatments
   explicitly: no board artifact; compatible persisted scan only; compatible
   serialized summary from a previous completed build. A newly implemented
   persisted artifact must be prepared by the candidate's real writer and reset
   from the same copy before every measured run. Keep missing/corrupt/version-
   incompatible artifact cases as separate fallback results.
3. Record process creation, listener readiness, route readiness, first request,
   first byte, complete body and first usable board separately. Do not hide
   pretraffic preparation inside an unreported startup wait. For handover,
   exercise the real proxy/readiness contract and time predecessor-to-successor
   traffic; that lifecycle test is additional to this deferred-activation audit.
4. Request the global summary first, then repeat the same scripted request
   sequence. Retain Server-Timing, HTTP status, response bytes, body hash,
   scope/epoch/generation metadata and first refinement completion. Measure full
   uncompressed and browser gzip paths separately. The actual integrated
   candidate must meet roughly one second from request to usable data in all
   three normal persisted-artifact cold starts. Report the slower fallback and
   process-start clocks explicitly.
5. Sample Viewer and child loops from before imports through completed
   refinement and settled scheduled indexing. Account for baseline holds and
   prohibit newly introduced Viewer holds above 50 ms. Profile a failing window;
   an awaited worker envelope cannot identify a parent-loop cause by itself.
   The current startup module-loading pause needs either preparation before
   traffic or a measured implementation that reduces it.
6. Verify eventual canonical content on the identical copy: project/file/task/
   pipeline membership, ordering, badges, attention and write-health state.
   Exercise stale persisted state followed by additions, removals, scope and
   epoch changes. Use the existing board browser test/capture drivers for fresh
   frames; include a cleared browser store, reload with a restored compatible
   store, and the oversized full response. Check refined rendered equality and
   browser parse/application time. No rendered equivalence is claimed by this
   read-only stage.
7. Run touched tests by explicit path under isolated HOME/XDG/TMP/state through
   the prescribed gate. Run privacy on changed publication files. Any eventual
   runtime-host change also requires `scripts/verify-runtime-host.ts`; required
   CI, including `bun-runtime`, belongs to that implementation's publication.

The available read access answered the investigation questions. Remaining
acceptance evidence is work for the implementation: the integrated summary
bootstrap, real release-handover timing, browser behavior and three paired
candidate runs. This audit changes only this report and leaves production,
repository code, the index and commit history unchanged.

Report validation: the local privacy gate passed with committed known-value
fingerprints and this file selected explicitly. `git diff --no-index --check
/dev/null docs/perf/cold-board-start.md` passed. No application test files were
changed; no test suite was run against production or the pipeline worktree.
The production build and isolated probes above ran only in the scratch export.
