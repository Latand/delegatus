# Pipeline archive residency and done sweep

L2 of `docs/perf/main-thread-blocking-audit.md`, measured 2026-10-18.
Base: `7ef6d95aa`. The audit subsequently merged as #3053; the moving main
adds only that document relative to this base. No production change was made.

The four projection readers use `loadArchivedPipelinesForList`: done, task
album, seat tick and board report. It returns one deeply frozen graph from the
revision/identity/decoder-authority cache. Done and album no longer keep private
60-second copies. Startup uses the same accessor. The mutable accessor remains
for archive maintenance and the worktree sweep helper.

The archive owns one process-global slot with a 512 MiB bound, independent of
the eight-slot, 256 MiB hot LRU. A new archive identity or decoder authority
clears the preceding slot. An oversized fill answers its caller and clears the
slot immediately. Byte-pressure eviction emits a collection-only diagnostic,
at most once per minute across compiled modules. Its limiter resets on process
restart. The budgets count UTF-16 source bytes, as the existing cache does;
they do not cap the decoded graph's heap or process RSS.

## Shared paths checked

`SqliteStateCollection.refreshReadCache` and `publishCache` select the archive
slot only for the full `pipelines_archive` collection. `controllerRow` keeps
its existing small keyed cache in the shared LRU. Both publication paths use
`rememberCollectionReadCache`; other collections default to the shared pool.
Archive moves, row writes, decoding, aliases and schema versions are unchanged.
Frozen consumers iterate records or copy their outer arrays. Mutable snapshots
still clone nested values. Tests exercise a later archive commit through all
three production worlds without waiting for a TTL.

ESLint restricts the mutable import in server code, including aliases, relative
imports, dynamic destructuring and namespace accesses. Tests, fixtures, workers
and the existing worktree sweep helper are excluded. Startup uses the frozen
accessor and needs no exception.

## Measurement

Raw measurements, input digests and exact final source hashes are in
`evidence/perf/pipeline-archive.json`. The state copy holds 251 hot pipelines,
966 archived pipelines, 2,466 tasks and 865 done items. Cache accounting is
63.0 MiB hot and 218.4 MiB archive. No production rows or transcript text are
published. The seed was assembled from read-only database snapshots and flat
file copies at the times in the artifact; it is not an atomic snapshot across
stores. Every before/after process receives the same seed bytes.

The procedure is M4 of the audit: extract its `probe.ts` and
`profile-view.ts`, export the base and candidate to scratch, and give each case
its own seed copies. Include the copied forge links, limits history and runtime
journal for the done world, and pin `LLV_RUNTIME_JOURNAL` to that journal copy.
Use the pinned gate wrapper, Bun 1.4.0 and `NODE_ENV=production`; isolate HOME,
XDG_CONFIG_HOME, XDG_CACHE_HOME, CODEX_HOME, TMPDIR and LLV_STATE_DIR, set the
Viewer control URL to a closed port and both sweeps to dry-run.

There are two fresh processes per case and budget, six passes per D2/T6-pass
process and the 12-read L,L,A,A,L,A,L,A,L,A,L,A eviction sequence. The 512 MiB
variant changes only the shared `MAX_BYTES` constant; the dedicated archive
bound stays 512 MiB. For the candidate, replace `p.loadArchivedPipelines()` in
the probe with `p.loadArchivedPipelinesForList()`. Add
`rssBytes: process.memoryUsage().rss` to each row; retain the original deltas.
Profiles retain the 1 ms sampling interval and count exact frames named
`loadArchivedPipelines`. Setup and the T6 reset stay outside the timer.
T6 clears the old private copy, warms the hot list, then runs the production
world through `runDoneSweepOnce`, leaving frame copy/recovery/media removal
out. Successive done passes may write their own copy. No forced GC is used.

A second T6 case and profile select the world's existing empty-forge fallback
on both versions, keeping pending album tiers present. Wrap `world.album` to
count calls and reset that counter before each timed pass and profile. Every
one of these passes and profiles performed four album lookups. This case
prevents settled done rows from hiding thumbnail work.

The final cases ran from 19:12:29Z to 19:17:23Z. External load was recorded,
rather than controlled: one-minute load 6.39–9.71 before and 6.88–9.42 after.
These are observed costs under those conditions, not a controlled-load ratio.

| Case | Before wall ms | After wall ms | Before / after maximum loop lateness ms |
| --- | ---: | ---: | ---: |
| D2 warm | 209.102–250.151 | 0.297–0.536 | 265.3 / 21.1 |
| T6-evict, 256 MiB, archive after hot | 634.781–890.975 | 0.325–0.537 | 931.8 / 27.6 |
| T6-evict, 256 MiB, hot after archive | 93.153–120.690 | 0.176–0.359 | 144.1 / 19.9 |
| T6-evict, 512 MiB, archive after hot | 230.136–340.258 | 0.303–0.411 | 363.8 / 18.2 |
| T6-evict, 512 MiB, hot after archive | 0.205–0.461 | 0.166–0.319 | 30.9 / 19.3 |
| T6-pass warm, copied forge | 785.385–1,130.215 | 59.133–72.090 | 1,233.2 / 129.5 |
| T6-pass warm, four album lookups | 1,033.014–1,608.905 | 80.324–101.152 | 1,847.3 / 80.8 |

Warm means indices 1–5 for D2 and T6-pass; alternating archive reads use indices
5,7,9,11 and hot reads 4,6,8,10. Cold fills remain expensive and are recorded
separately. Every measured warm alternating read is below 1 ms and every warm
T6 pass stays below 250 ms of timer lateness, including the album case.

## Bounding thumbnail work

After archive churn was removed, diagnostic profiles localized remaining work
to repeated scanner-root enumeration and prototype-review reads. The album now
captures the scanner-root list once per read. Each candidate path and root
still passes the existing realpath and relay checks on every use; a new world
sees added roots. The original `pathAllowed` signature remains unchanged;
`pathAllowedWithRoots` supplies the explicit snapshot path.

Done returns the empty round tier directly for tasks holding no local or
replicated rounds. Other round reads share a cache of at most 64 entries owned
by that pass. Eviction causes a fresh tier read; a new world sees new decisions.
A refused tier is retried by a new world. The projection yields to native peers
between thumbnail resolutions so their synchronous reads cannot accumulate
across all lanes in one turn. Tests cover native peer progress, cache eviction,
read refusal and fresh-world recovery.

Final `profile-view.ts done` runs have 61/59 samples; the four-album profiles
have 86/81, with none under `loadArchivedPipelines` or the removed archive-copy
wrapper. Baseline default profiles have 765/759 samples, including 645/608
under `archivedPipelines`; the album profiles have 1,585/1,295, including
651/555 under that wrapper. The exact mutable-reader counter is also zero on
the baseline because Bun inlines it; that counter alone proves no improvement.
The replayed timings, cache residency and guards in source supply the comparison.
No conclusion uses 48-hour re-arm chain totals: attention reconciliation shares
those chains. `done.sweep` labels the complete async pass, including ownership
checks and errors. Deterministic gap-record tests verify active and completed
attribution.

## RSS

Before, archive-after-hot calls at 256 MiB added 217–413 MB of RSS per call;
after, their deltas were 0–0.20 MB. At 512 MiB the candidate's deltas were also
0–0.20 MB. These deltas include allocator and GC effects. Peak sampled process
RSS over the alternating replay was 929 MB before and 543 MB after (512 MiB
variant: 668 / 544 MB). The default done replay sampled at most 1,498 / 915 MB;
the four-album replay sampled at most 2,460 / 903 MB. The candidate pays its
initial decode and keeps that graph resident. These figures compare residency
with current churn without claiming an RSS bound or a production memory saving.

## Acceptance and verification

1. The cache test fills the measured 64:218 MiB ratio, checks both directions,
   exact caps and overflow, builds two separate modules and restarts the real
   owner twice. The SQLite test uses real 30/110/8 MiB character payloads and
   verifies no second decode of the hot/archive/task working set. On the base,
   the working set evicts and the second pass decodes three extra rows.
2. Production done, album and seat adapters consume the same deeply frozen
   archived record, preserve nested data and observe the next archive revision.
   Mutable copies remain independent. Existing done, album, seat, board-report
   and archive/store tests pass. Album privacy cases cover relay paths, outside
   roots, symlink retargeting, deletion and the next read's new roots.
3. Repeated copied-state results meet the 1 ms read and 250 ms warm pass limits,
   including four album lookups per pass. Profiles contain no mutable archive
   path after the change. Native peer progress fails on the base and passes here.
4. The native ESLint restriction and executable cases prevent the mutable reader
   from returning to projection imports.

Tests run individually through the pinned gate wrapper, with fresh isolated
HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, CODEX_HOME, TMPDIR and LLV_STATE_DIR:

- `src/lib/state/collectionReadCache.test.ts`
- `src/lib/state/sqliteStateStore.readCache.test.ts`
- `src/lib/pipelines/store.reads.test.ts`
- `src/lib/pipelines/store.test.ts`
- `src/lib/done/world.test.ts`
- `src/lib/done/project.test.ts`
- `src/lib/taskAlbum/album.test.ts`
- `src/lib/scanner/roots.claude.test.ts`
- `src/lib/monitor/seatTickSources.test.ts`
- `src/lib/orchestrator/boardReportRun.test.ts`
- `scripts/eslintServerArchive.test.ts`

The eleven files pass 247 tests. One initial seat-discovery run exceeded Bun's
five-second default under higher load. Its isolated base comparison passed in
3.5 s; the full head file then passed with a 30 s per-test deadline. The store
file used that deadline too. Other files used the default. Typecheck and
changed-file lint run separately. Hosted checks `typecheck`,
`privacy-publication`, `privacy-tracker-audit` and `runtime-gate` remain required
on future publication. This stage does not push or deploy; production
`done.sweep` durations remain a follow-up observation.
