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

Retirement closes the guardian's lease pipe. Windows terminates a process on
`SIGTERM` without running its JavaScript cleanup, so signaling the guardian
could leave a busy query holding stdout open. Before launching a helper, the guardian enters an anonymous Windows job with
a non-inheritable handle and kill-on-close enabled. Descendants inherit job
membership, which survives helper crashes and normal exits. Cleanup reads
that job's membership, retains each process handle and verifies its current
job membership before terminating it. The guardian waits for verified tree
closure on helper exit and requested retirement; its own abrupt exit also
closes the job. Replacement waits for confirmed closure. A caller's five-second retirement deadline leaves the shared
exit barrier pending, allowing a later confirmed exit to unblock the lane.

The worker lifecycle tests cover busy-query cancellation, timeout and shutdown
with an inherited-stream descendant, successful replacement, empty lease records,
and recovery after a late confirmed exit. Crash and normal exit cases wait
for a descendant holding inherited output, then require clean failure,
shutdown and replacement before test cleanup, while an unrelated peer stays
alive. These exit cases use a Node guardian behind a Bun bridge that waits
for pipe closure, with a Node descendant detached on Windows, so runtime-provided child
cleanup cannot mask a missing lease cleanup. A native Windows case also
hard-kills the guardian itself. The busy
tests emulate unhandled Windows termination on Unix, and the same file runs on the native Windows CI
runner under Bun 1.4.0 through the owned gate runner.

Windows job setup allows 15 seconds for cold PowerShell, `Add-Type` and CIM
initialization. The former five-second subprocess timeout closed the guardian
before it could launch the query worker: native runs 38182679998 and
38183666079 failed their first parity query after 5130.87 and 5088.33 ms.
The parity test already allowed 60 seconds and the request allowed 30 seconds.
The setup receipt is still mandatory; failed setup never admits a helper.
An isolated delayed-receipt regression failed at 5017 ms under the former
cut, and the native regression adds six seconds before real Windows ownership
setup to require successful containment beyond that cut. Both files run through
the owned gate runner on Windows. Query deadlines and Unix behavior are unchanged.

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

## Recheck after merging current main

A fresh production build at f2672a9ab28f1bc2f1e9f00c228d043ee0ca72da, merging main 2fa6519f486d85c973f71a2a2ea2514b9890ccac, repeated the same
five-sample benchmark against the seed-1429 corpus. Main's search implementation
is unchanged since the baseline above. The raw artifact retains this run under
recheck, including the build and main revisions and all HTTP/MCP samples.
Every HTTP response retained 6,729 conversations and 250,000 messages, and every
HTTP and MCP query cell retained its baseline total.

| Order | Query | Search before → after | Concurrent request before → after | Loop delay before → after |
| --- | --- | ---: | ---: | ---: |
| newest | rare word | 6.9 → 9.4 | 5.3 → 4.6 | 6.5 → 2.9 |
| newest | two common words | 96.0 → 84.1 | 95.6 → 4.0 | 95.6 → 4.2 |
| newest | very common word | 296.0 → 308.3 | 300.9 → 4.7 | 299.7 → 4.6 |
| relevance | rare word | 16.3 → 15.8 | 15.1 → 3.7 | 15.1 → 3.3 |
| relevance | two common words | 280.1 → 287.6 | 295.4 → 4.4 | 288.6 → 4.4 |
| relevance | very common word | 608.9 → 480.9 | 627.6 → 3.6 | 617.8 → 3.0 |

These cells include both speakers. Packaged MCP common-word medians were
317.6 ms (newest) and 475.9 ms (relevance), against 327.4 and 602.7 ms before.
Cold startup was 76.7 ms; the idle cheap-request median was 2.7 ms. Query wall
times include parallel lane contention; the Viewer remains responsive while
those queries execute.

The merged revision passed the isolated focused run (84 pass, zero fail, one
existing environment-gated standalone skip), full TypeScript, changed-file
lint, the production build and the publication privacy check. The production
benchmark exited successfully after closing its worker and server.
