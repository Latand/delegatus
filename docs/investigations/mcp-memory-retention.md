# Per-agent MCP memory, 2026-10-13

Issue #1816 reproduces on freshly fetched main
`8f103d02ec68ecae135c5a60d8bb14430ca207b7`, after the earlier delegation in
#2716. This session repeats the observation and candidate replay on the same
machine; earlier lane measurements are not used as the baseline.

## Step one: current main

One real MCP stdio child measured **124,612,608 bytes RSS at spawn** and
**263,147,520 bytes after the fixed replay and 30 seconds idle**. A subsequent
diagnostic full GC left 217,584,366 bytes of live heap. Its startup live heap
after GC was 40,574,902 bytes. The retained-object path is still present:
`agent_activity` reaches `productionLivenessSources.pipelines`, `getPipelines`
and the pipeline collection/projection caches. `SqliteStateCollection` retains
serialized and decoded records. Four MCP schema imports also reach registry
and scanner modules at startup.

The imported interrupted-lane change is retained after checking those paths.
It routes `list_pipelines`, `get_pipeline`, `read_prototype_review`,
`agent_activity` and `search_transcripts` through the existing authenticated
Viewer MCP endpoint, before loading local bindings. Pure constant modules
remove the eager imports. Existing export paths re-export the same constants.
No response schema, payload budget, collection cache or domain algorithm changes.

## Same-session replay

The benchmark uses real SDK stdio transport and the production tool service,
with a separate process serving the production MCP HTTP, prototype and search
handlers. It seeds 120 pipelines, six attempts in each of two stages
(44,733,021 JSON bytes), 200 transcript messages, one caller and one prototype
round. Each of three rounds reads, in order:

1. `list_pipelines(full:true,includeClosed:true,limit:200)`
2. `get_pipeline(pipelineId:"p0000001",full:true)`
3. `conversation_messages(limit:200,maxChars:16000)`
4. `read_prototype_review` for the seeded task
5. `agent_activity(full:true,limit:200)` for the seeded transcript
6. `search_transcripts(query:"fixture",order:"newest",limit:100,full:true)`

The full pipeline list keeps its existing byte budget and returns one whole
pipeline plus a cursor. Every request has a distinct, deterministic receipt key.
The candidate’s 18 answers carry 24,313,454 bytes including text and structured content.

Both processes use Bun 1.4.0 and fresh HOME, XDG, provider homes, TMPDIR and
LLV_STATE_DIR. The default control URL is closed; fixtures bind port 0. A private
PID namespace confines process discovery. No live state or live process is used.
The parent reads the child’s `/proc/<pid>/status` VmRSS in bytes, samples peaks
every 10 ms, and samples idle memory before requesting diagnostic GC. Spawn
means after MCP initialization, before any tool call or diagnostic GC.

| Measurement, MiB | Main | Candidate |
| --- | ---: | ---: |
| RSS at spawn, before diagnostic GC | 118.84 | 73.14 |
| RSS after startup diagnostic GC | 116.72 | 72.27 |
| Peak RSS | 297.82 | 110.56 |
| RSS after 30 seconds idle | 250.96 | 77.24 |
| RSS after subsequent diagnostic GC | 250.23 | 76.93 |
| Live heap after startup GC | 38.70 | 20.65 |
| Live heap after final GC | 207.50 | 16.13 |

Live heap is JSC `heapSize + extraMemorySize`. RSS includes allocator capacity;
polling may miss sub-10-ms peaks. This proves removal of retained graphs for the
replayed reads. Local bindings still initialize for other tools, and legacy
clients without a launch capability and health probes keep their local behavior.
The newly delegated reads require an available Viewer and valid launch capability;
failed forwarding never falls back to a local domain read.

## Answer comparison and latency

All 18 complete MCP results, including text blocks, match byte-for-byte after
these explicit normalizations: the independent sandbox roots and generated
caller conversation ids; activity observation timestamps, positive silence/stall
durations and phase durations; and the transcript cursor’s path/filter scope
hash. Zero/null timing values, phase field names, cursor offsets and record
fingerprints stay in the comparison. Object key order is preserved. Each text
block must exactly equal JSON serialization of its structured answer. No other
fields are removed. These differences arise from fresh fixtures and wall clocks.
The evidence records raw-response hashes and byte counts as well as normalized
payload/envelope hashes.

Latency is wall time around `client.callTool`, including receipt work, transport
and complete response parsing. Each row has three observations, with the first
call shown separately because it includes cold initialization:

| Tool | First call main → candidate, ms | Median main → candidate, ms |
| --- | ---: | ---: |
| `list_pipelines` | 165.45 → 140.67 | 88.32 → 32.87 |
| `get_pipeline` | 20.91 → 30.93 | 24.25 → 30.93 |
| `conversation_messages` | 385.50 → 319.07 | 385.50 → 260.44 |
| `read_prototype_review` | 127.40 → 180.73 | 62.19 → 36.77 |
| `agent_activity` | 163.23 → 45.70 | 50.10 → 28.83 |
| `search_transcripts` | 620.19 → 582.07 | 643.08 → 481.43 |

The complete 18-call sum was 4,162.55 → 3,019.08 ms. The added Viewer hop is
visible in the 6.68-ms median increase for `get_pipeline` and the 53.34-ms cold
increase for `read_prototype_review`. This is one paired run on a busy machine
under the shared gate’s 300% CPU quota, not a general latency bound. All raw
samples, timestamps, exact byte counts and hashes are in
[the replay evidence](../../evidence/mcp-large-reads-replay.json).

## Lifecycle follow-up

Review found one omitted reader: `lifecycle_events` loads the entire pipeline
collection while refreshing the journal, even for `mode:"query",limit:1`.
It now delegates through the same authenticated Viewer service. Query and
digest retain their original durable receipt keys; reconnecting and replaying
an acknowledged digest returns the original relay without advancing its cursor.
No journal, digest, collection-cache or domain implementation changed.

The same benchmark now appends that query to every round (21 calls total),
and the fixture serves an honestly empty runtime deployment ledger. This
follow-up measured the captured main baseline, the reviewed candidate before
this fix, and the fixed candidate on the same machine in the same session:

| Measurement, MiB | Main | Before lifecycle fix | Fixed |
| --- | ---: | ---: | ---: |
| RSS at spawn, before diagnostic GC | 121.00 | 73.50 | 73.06 |
| RSS after startup diagnostic GC | 113.96 | 72.91 | 72.27 |
| Peak RSS | 379.27 | 348.97 | 109.95 |
| RSS after 30 seconds idle | 246.97 | 293.98 | 77.29 |
| RSS after subsequent diagnostic GC | 243.16 | 284.00 | 77.00 |
| Live heap after startup GC | 38.68 | 20.65 | 20.65 |
| Live heap after final GC | 207.90 | 207.33 | 16.22 |

Both comparisons pass all 21 complete MCP answers with the normalizations
listed above. Lifecycle answers need no normalization: event ids, timestamps,
counts, journaled counts, cursors, receipt keys and event contents are identical.
The final live heap is smaller than the startup heap, so this replay no longer
retains the approximately 207 MiB pipeline graph in the per-agent process.

| Tool | First call main → fixed, ms | Median main → fixed, ms |
| --- | ---: | ---: |
| `list_pipelines` | 125.69 → 129.95 | 18.99 → 33.90 |
| `get_pipeline` | 12.32 → 21.42 | 14.13 → 22.52 |
| `conversation_messages` | 268.83 → 213.27 | 238.70 → 213.27 |
| `read_prototype_review` | 95.35 → 105.69 | 36.51 → 30.28 |
| `agent_activity` | 89.57 → 23.26 | 30.53 → 25.24 |
| `search_transcripts` | 515.74 → 529.68 | 468.34 → 493.86 |
| `lifecycle_events` | 339.28 → 366.69 | 21.69 → 38.19 |

Total observed call time was 2,943.60 ms on main, 3,339.47 ms before the
lifecycle fix, and 3,109.55 ms after it. Against main, the fixed replay adds
165.95 ms overall; lifecycle adds 27.41 ms cold and 16.50 ms at the median.
Against the reviewed candidate, lifecycle changes 656.50 → 366.69 ms cold
and 27.40 → 38.19 ms at the median. These are three observations per tool
under the existing shared gate, with uncontrolled concurrent machine activity;
they establish no general latency bound. Exact bytes, times and hashes for
all three samples are in the evidence file's `lifecycleExtension` object.

## Reproduction and regression protection

Export the named main commit to scratch and install frozen dependencies there;
use this change’s identical benchmark script in both checkouts. In each checkout,
run under private HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, with
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`. The benchmark further isolates its
children and requires an empty output directory:

```sh
bash scripts/gate-slot.sh bun scripts/mcp-memory-benchmark.ts "$BEFORE_OUTPUT"
bash scripts/gate-slot.sh bun scripts/mcp-memory-benchmark.ts "$AFTER_OUTPUT"
bun scripts/mcp-memory-benchmark.ts compare "$BEFORE_OUTPUT" "$AFTER_OUTPUT"
```

`largeReads.test.ts` guards the eager import graph and all eleven delegated tools,
including original receipt keys and native-work metadata. Its lifecycle query
and digest cases replay through the production HTTP boundary after reopening
the SQLite receipt store and reconnecting the stdio facade. Existing revocation,
replay, cancellation and no-fallback checks remain. `stdio.integration.test.ts`
answers 24 large calls across all eleven tools (both lifecycle modes), checks retained heap and absence of
a local receipt database, and exercises real stdio/HTTP independence from a held
pipeline lease and slow host. Its local-initialization retry coverage remains.

The initial tests copied onto the main export failed first in three cases: the eager
import boundary, delegated receipt/native-work routing, and repeated large reads.
The lifecycle extension fails first on the reviewed candidate in both receipt
cases, delegated routing and the repeated-large-read case. With delegation
enabled, the boundary file passes all eight tests. The extended stdio regression
answers 24 calls totaling 52,224,063 payload bytes; post-GC heap growth is
1,513,964 bytes, below a single answer's size, with no local receipt database.

The main/head comparison passes all nine selected files with zero new,
pre-existing, removed/skipped or flaky outcomes: MCP large reads, stdio, server,
HTTP, deployment reads and bindings; lifecycle digest, liveness and activity.
Each runs by explicit path in isolated state through the owned gate runner.
The MCP bundle build also passes. The comparison uses the captured main commit
above; its head sample includes this follow-up's working-tree changes.

The Viewer-memory (#2512), landing-board (#1838), account-lock (#1935),
automatic-update (#2515) and registry-refresh lanes’ areas are unchanged.
The automatic-update lane also edits `server.ts`, in separate tool-description
hunks; this change only adjusts its imports.
