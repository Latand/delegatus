# Streaming restoration of released host event windows

Released Claude, Codex and Copilot event windows refill through an asynchronous
journal scan when a reader attaches or the next send begins. Each host shares
one pending refill. Live appends populate the bounded window directly, and a
successful refill merges their original payloads with the historical suffix.
A failed refill preserves the live window and its required cursor for retry.

`FileRuntimeEventStore.scan` reads a fixed descriptor prefix in 64 KiB chunks,
validates every record with the parser used by `load`, checks every sequence,
and preserves the existing unterminated-tail rules. It yields between records
after four milliseconds of processing and has a sixty-second read deadline.
Memory scales with the configured window, the largest record and the read
buffer. Parsing one record remains synchronous. The scan reads without filling
the full-ledger cache or changing append-tail ownership.

The shared store contract adds an optional scan operation. The file store
provides it; custom in-memory stores retain their load fallback. The three
hosts consume it through `HostEventWindow.refill`; Codex applies its existing
activity timestamp projection before insertion. Journal writers, encoding,
sequence allocation, cache limits and recovery writes retain their contracts.

Startup still uses the full restore path for confirmations, turn boundaries
and adoption reconciliation. Historical replay requested outside the retained
window still uses the existing ledger replay API. Those broader reads are
outside this change. Existing host startup, adoption, replay and recovery tests
are included by the pre-push touched-test selector.

## Coverage

`src/lib/runtime/eventStore.streaming.test.ts` covers full-prefix JSON/event/sequence validation,
empty records, partial final records, valid unterminated records, UTF-8 chunk
boundaries, writer output after reopening, missing files, visitor/read failures,
deadlines before stream creation and during reading, replacement, truncation
and concurrent append. Expired reads reject with their refill origin and allow
the file to be reopened.

`src/lib/runtime/hostEventWindow.streaming.test.ts` covers a synthetic production-shaped history,
exact sequence/content hashes, previews and byte accounting, final cursors,
replay gaps, failed restoration followed by recovery, concurrent live suffixes,
eviction, oversized events, snapshot overlap, deferred attachment and cancellation.
Each host also exercises release, replay and its next send with both memory and
file stores. Fixtures contain deterministic synthetic data.

## Measurement procedure

Use a private copy of an unchanged historical journal. Run each sample in a new
Bun process with private HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR, and set
LLV_VIEWER_CONTROL_URL to a closed port. All processes run serially through the
heavy-command wrapper. The script prints aggregate measurements and hashes;
it never prints journal records or the input filename.

```
bun scripts/benchmark-host-event-window.ts "$TMPDIR/history.jsonl" base
bun scripts/benchmark-host-event-window.ts "$TMPDIR/history.jsonl" stream
```

Run modes in the order base, stream, stream, base, base, stream. The baseline
uses the synchronous `load` plus `restore` path. Streaming uses the production
`refill` path. Each process arms a 10 ms interval, waits 30 ms before starting,
and waits another 30 ms after reading. Peak RSS is the process high-water mark;
max timer delay is the largest interval excess over 10 ms. There is no forced
GC, active engine or live service. The copied input may benefit from the page
cache. Cache eviction is outside this procedure.
The script records runtime, platform and readable cgroup limits per sample.
An empty limits array means the worker mount did not expose those files.


## Recorded comparison

Linux x64, Bun 1.4.0, serial fresh processes through the installed project gate
with its default worker settings. Effective per-worker cgroup limits were
unavailable inside the worker mount; the shared work slice reported an aggregate
CPU quota of eighteen cores. Machine load and page cache were uncontrolled.
The immutable input copy was 163,130,633 bytes with 2,455 events. All samples
returned final cursor 2,455 and the same 285 events occupying 6,258,119 bytes.
The baseline and streaming processes both exited zero in every sample.

| Sample order | Mode | Peak RSS (MiB) | Max 10 ms timer delay (ms) | Read and restore (ms) |
| --- | --- | ---: | ---: | ---: |
| 1 | Baseline | 838.52 | 564.46 | 563.40 |
| 2 | Stream | 171.21 | 6.36 | 860.79 |
| 3 | Stream | 158.64 | 5.99 | 929.73 |
| 4 | Baseline | 823.57 | 776.60 | 776.07 |
| 5 | Baseline | 832.47 | 728.46 | 731.90 |
| 6 | Stream | 165.21 | 4.41 | 753.45 |

SHA-256 of the ordered retained sequence array in every sample:
`48bb3e4e9ee46a09a032c861dbbd83189abd7b52a0d4cb0c63429a5ea786d461`.
SHA-256 of the concatenated serialized window events in every sample:
`307a885621c95e4194be9111f8748cc8a91b57a679e2742cfd94f4414e832d51`.
The test fixture independently compares both sequences and exact serialized
contents without including private journal data.

The measured allocation and timer improvements concern this refill path.
Attribution to earlier service pauses or long-term heap growth remains unproven.
The source journal was read only to create the private copy; its inode, size
and modification time were checked around the copy. Both benchmark modes read
the copy without changing it. No production journal was modified or deleted.
