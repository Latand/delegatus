# Transcript query worker

The HTTP transcript search route and the `search_transcripts` MCP tool now
use one resident query worker. SQLite reads, ranking, folding and excerpt
construction run there. The synchronous library entry remains available to
offline callers and drives the same query iterator, preserving result order,
cursors, scope resolution and page budgets.

The worker uses the existing helper lease, including retirement after a hard
owner exit. Requests are serial, with at most 64 pending jobs and a 30-second
deadline covering queue time and execution. A queued cancellation never
reaches SQLite; active cancellation or timeout ends the worker before another
query starts. Worker exits, protocol failures and queue exhaustion produce the
route's existing bounded 503 response. The next request can start a replacement.
The worker retires after 60 seconds idle or a reply reporting RSS above 512 MiB.

A trusted redactor receives the complete highlighted source through the worker
protocol before excerpting or byte limits. Its closure remains with the caller.
This preserves the voice companion's masking contract without transferring a
function or moving SQLite back into the Viewer. Named cursor and page-budget
errors are reconstructed in each caller's Next bundle so their HTTP 400 status
survives sharing the global worker across route bundles.

## Measurement method

The existing `scripts/transcript-search-bench.ts --production` driver serves
the compiled Next application in a separate process on port 0. Its load
generator starts a cheap missing-query request five milliseconds after each
search and records that request's latency and the Viewer's maximum event-loop
delay at one-millisecond resolution. Each reported cell is the median of five
warm repetitions. The packaged stdio MCP server is measured against the same
production server. The first search is recorded separately to expose startup
cost. Before ending that server, the driver explicitly closes its query worker
and waits for the helper to exit, satisfying the owning runner's cleanup check.

Both builds use the same invented seed-1429 corpus: 6,729 indexed conversations
and 250,000 messages, generated with `--conversations 7200 --messages 250000`.
Every measured HTTP response must retain that census. The isolated server runs
as a release candidate so autonomous catalog refresh cannot replace the fixture
with an empty sandbox inventory. Telemetry is disabled and the child environment
omits the launching agent's capability.

The baseline is main at `e5cd0ff3d7e5d2c58225f908ad5c0bb475d2ccd2`.
Both production builds use Bun 1.4.0 and Next 16.3.8. The before and after runs
are sequential on the same machine during parallel lane activity; wall times
include that contention. All measurements use fresh isolated state, home,
config and temporary directories; no live transcript database is read.

## Measured results

[All samples](transcript-search-worker.json) retain the same HTTP and MCP totals
for every query cell. Timings are milliseconds; loop delay is the median of
per-query maxima. The concurrency probe's idle median is 4.8 → 3.6 ms.

| Order | Query | Speaker | Search ms before → after | Concurrent cheap ms before → after | Loop delay ms before → after |
| --- | --- | --- | ---: | ---: | ---: |
| newest | `heliotrope` | user | 6.2 → 11.5 | 6.8 → 4.7 | 5.7 → 4.3 |
| newest | `heliotrope` | all | 6.9 → 12.3 | 5.3 → 5.5 | 6.5 → 5.0 |
| newest | `harbor granite` | user | 61.4 → 55.8 | 70.6 → 4.2 | 60.8 → 3.8 |
| newest | `harbor granite` | all | 96.0 → 85.8 | 95.6 → 4.4 | 95.6 → 4.0 |
| newest | `ledger` | user | 131.9 → 172.7 | 129.7 → 6.9 | 131.1 → 7.5 |
| newest | `ledger` | all | 296.0 → 270.6 | 300.9 → 4.0 | 299.7 → 4.0 |
| relevance | `heliotrope` | user | 15.1 → 24.4 | 14.8 → 7.0 | 14.6 → 5.7 |
| relevance | `heliotrope` | all | 16.3 → 29.3 | 15.1 → 7.2 | 15.1 → 6.6 |
| relevance | `harbor granite` | user | 160.0 → 235.6 | 162.0 → 5.9 | 159.7 → 6.3 |
| relevance | `harbor granite` | all | 280.1 → 285.1 | 295.4 → 4.2 | 288.6 → 5.9 |
| relevance | `ledger` | user | 420.5 → 392.1 | 432.8 → 5.5 | 418.9 → 7.1 |
| relevance | `ledger` | all | 608.9 → 473.7 | 627.6 → 4.0 | 617.8 → 4.8 |

| Order | Query | Packaged MCP ms before → after |
| --- | --- | ---: |
| newest | `heliotrope` | 17.0 → 11.8 |
| relevance | `heliotrope` | 29.5 → 16.5 |
| newest | `harbor granite` | 116.3 → 84.6 |
| relevance | `harbor granite` | 363.0 → 216.4 |
| newest | `ledger` | 327.4 → 247.7 |
| relevance | `ledger` | 602.7 → 473.8 |

The first rare search costs 10.2 → 88.0 ms, including worker startup in the
after run. Warm rare HTTP searches also gain several milliseconds of IPC
overhead. The common-word searches keep the Viewer available throughout the
SQL work; query wall times still reflect CPU and I/O contention. These numbers
measure responsiveness on the synthetic corpus and do not claim faster SQL.
Both benchmark commands exit successfully with no surviving owned processes.

## Reproduction

Run from a checkout with installed dependencies. Repeat at the baseline and
the worker revision with separate state directories and the same fixture.

```bash
task_root=$(mktemp -d /tmp/delegatus-search.XXXXXX)
mkdir -p "$task_root/home" "$task_root/config" "$task_root/tmp" "$task_root/state"
export HOME="$task_root/home" XDG_CONFIG_HOME="$task_root/config"
export TMPDIR="$task_root/tmp" LLV_STATE_DIR="$task_root/state"
export LLV_VIEWER_CONTROL_URL=http://127.0.0.1:9
export DELEGATUS_TELEMETRY=0 DO_NOT_TRACK=1 NEXT_TELEMETRY_DISABLED=1
bash scripts/gate-slot.sh bun run build
bash scripts/gate-slot.sh bun scripts/transcript-search-fixture.ts \
  "$task_root/corpus" --conversations 7200 --messages 250000 --seed 1429
bash scripts/gate-slot.sh bun scripts/transcript-search-bench.ts \
  "$task_root/corpus" --production --repeat 5 --json "$task_root/result.json"
```

Use the same production driver on both revisions. It extends the existing
benchmark without changing either revision's compiled route implementation.

## Focused verification

`transcriptSearchWorker.test.ts` compares every page against the synchronous
entry for both orders, all speaker selections, project scopes, copies, cursors
and trusted redaction. It covers active and queued cancellation, the shared
deadline, queue saturation, malformed frames, worker exit and recovery,
projector failure, cross-bundle domain errors and a hard-killed owner.

The existing transcript library, HTTP/MCP route and voice read-path tests run
by individual file path under isolated state. Both production builds, the full
type check, changed-file lint and the publication privacy gate are also checked.
