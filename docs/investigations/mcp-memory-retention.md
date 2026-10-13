# Per-agent MCP memory, 2026-10-13

Issue #1816 still reproduced on main `7140fa6739dfd3fb4712878325a8ae19b2e1b8b4`,
after the earlier delegation change in #2716. The remaining local heavy reads
load pipeline collections and their serialized/parsed cache entries into each
agent's process. This change extends the existing authenticated Viewer path to
`list_pipelines`, `get_pipeline`, `read_prototype_review`, `agent_activity` and
`search_transcripts`. It also gives the MCP schema pure imports for memory
kinds, liveness defaults, selected-tail limits and pipeline page limits.

The exported constants and tool arguments are unchanged. The former import
paths re-export the constants. The stdio service still initializes local
bindings lazily for tools outside the delegated set. Legacy ancestry-only
clients and admitted health probes retain their existing local behavior.

## Observation before changing product code

At 01:45:27 UTC, read-only `/proc` observations found 42 live MCP server
children: RSS minimum 120.3 MiB, median 278.6 MiB, maximum 1,013.0 MiB.
The four largest pairs were:

| Engine | MCP child RSS, MiB | Launcher RSS, MiB | Agent RSS, MiB | MCP age, minutes |
| --- | ---: | ---: | ---: | ---: |
| Claude | 1,013.0 | 47.6 | 323.5 | 125.7 |
| Claude | 916.0 | 49.6 | 275.3 | 100.2 |
| Claude | 853.3 | 44.3 | 328.8 | 65.9 |
| Codex | 801.1 | 51.9 | 193.6 | 107.7 |

These are individual processes, identified by parentage, without adding the
agent or launcher to the MCP figure. The deployment status named
`40451576b3eece32dbfd1d6b87e8a2f9846f1905`; the two largest children's checkouts
and executables independently confirmed that revision and Bun 1.4.0. That
revision has the same delegated-read set as the measured main. The live sample
is descriptive: it does not prove growth over time. No live process was
signalled, garbage-collected, restarted or attached to a profiler.

## Controlled replay

The benchmark uses real stdio transport, the production tool service, a
separate process serving the production MCP HTTP and prototype route handlers,
and synthetic state. HOME, XDG, state, provider homes and temporary directories
are isolated. A private PID namespace prevents process discovery from reaching
live agents. Every listener binds port 0.

There are 120 pipelines with six attempts in each of two stages (44,733,021
JSON bytes), 200 generated transcript messages, one caller and one prototype
round. Each of three rounds calls `list_pipelines(full:true)`,
`get_pipeline(full:true)`, `conversation_messages(limit:200,maxChars:16000)`,
`read_prototype_review`, and `agent_activity(full:true)`, in that order.
The full list retains its existing byte-budget pagination: this call returns
one complete pipeline and a cursor. No response budget is changed.

The confirmation pair below uses one sample per revision on this machine and
Bun 1.4.0. The first run, made before product edits, peaked at 315.12 MiB
and idled at 238.21 MiB on main; its record is also retained in the evidence:

| Measurement, MiB | Main before | Candidate after |
| --- | ---: | ---: |
| RSS after initialization and diagnostic GC | 117.64 | 71.75 |
| Peak RSS, sampled every 10 ms | 316.88 | 135.32 |
| RSS after 30 seconds idle | 248.85 | 93.46 |
| RSS after subsequent diagnostic GC | 248.06 | 93.46 |
| Live heap at initialization | 38.62 | 20.60 |
| Live heap after subsequent diagnostic GC | 207.49 | 16.08 |

Live heap is JSC `heapSize + extraMemorySize`. Idle RSS is measured before the
final GC. Peak polling can miss spikes shorter than 10 ms; RSS also includes
allocator capacity. These measurements establish the removal of retained
graphs for this sequence, without claiming a bound on every possible tool mix.

The largest first-round increase followed `agent_activity`: its
`productionLivenessSources.pipelines` calls `getPipelines`, reaching the
module-level pipeline stores and projection cache. `SqliteStateCollection`
keeps both `valueJson` and decoded records in its collection cache. Subsequent
calls reuse those process-lifetime objects. Delegation gives those caches one
Viewer owner. No shared cache implementation was changed; the #2512 and
98f51a9f lanes were consulted and their cache work remains separate.

All 15 answers compare equal after normalizing the synthetic sandbox path and
conversation id, the activity observation timestamp and duration measurements, and the transcript
cursor's path/filter scope hash. Cursor offsets, record fingerprints,
pagination, content, non-timing metadata and result codes are compared. Timing field names remain
in the comparison; positive elapsed-clock values vary between runs. The normalized
answer sizes per round are about 374 KB, 374 KB, 3.22 MB, 11 KB and 1.5 KB.
The [machine-readable evidence](../../evidence/mcp-large-reads-replay.json)
includes per-answer SHA-256 hashes and byte counts.

## Reproduction and regression protection

Run each revision with the same benchmark script, frozen dependencies, and
fresh isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR. Output directories
must be empty. The benchmark additionally isolates its own child environment.

```sh
bash scripts/gate-slot.sh bun scripts/mcp-memory-benchmark.ts "$BEFORE_OUTPUT"
bash scripts/gate-slot.sh bun scripts/mcp-memory-benchmark.ts "$AFTER_OUTPUT"
bun scripts/mcp-memory-benchmark.ts compare "$BEFORE_OUTPUT" "$AFTER_OUTPUT"
```

`largeReads.test.ts` checks the eager import boundary, delegated arguments and
native-work metadata, capability revocation, replay, cancellation and refusal
without local fallback. Its expanded routing test failed on main before the
fix. `stdio.integration.test.ts` exercises repeated large answers through all
five requested reads, asserts bounded retained heap and no local receipt file,
and preserves the held-lease/slow-host latency assertions through a real
separate HTTP tool service. Its local-initialization retry case remains in
place.
