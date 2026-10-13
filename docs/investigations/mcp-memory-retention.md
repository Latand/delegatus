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

`largeReads.test.ts` guards the eager import graph and all ten delegated tools,
including original receipt keys and native-work metadata. Existing revocation,
replay, cancellation and no-fallback checks remain. `stdio.integration.test.ts`
answers 20 large calls across all ten tools, checks retained heap and absence of
a local receipt database, and exercises real stdio/HTTP independence from a held
pipeline lease and slow host. Its local-initialization retry coverage remains.

The final tests copied onto the main export fail first in three cases: the eager
import boundary, delegated receipt/native-work routing, and repeated large reads.
On the candidate both files pass (6 boundary tests and 34 stdio integration tests).
The 20 synthetic stdio answers total 43,520,051 payload bytes; post-GC heap growth
is 1,364,088 bytes, below a single answer’s size. The slow-host case makes exactly
one snapshot request and the three independent reads finish in 159–262 ms while
that dependency is held for three seconds.

The Viewer-memory (#2512), landing-board (#1838), account-lock (#1935),
automatic-update (#2515) and registry-refresh lanes’ areas are unchanged.
The automatic-update lane also edits `server.ts`, in separate tool-description
hunks; this change only adjusts its imports.
