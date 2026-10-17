# Residual synchronous readers

The 2026-10-16 audit identified repeated receipt collection reads and prototype
state access inside Viewer gaps. This change bounds the recurring reads while
preserving receipt selection, ownership checks, prototype answers and linked
metadata. The base is `d84e0e2e2578075a63024e4d7d08a9070c321c1a`.

Receipt checks select by conversation, path, capability digest, client attempt,
state or pending capability operation. Conversation aliases are expanded before
selection when the old predicate canonicalized them. Selection stays inside the
existing lazy registry transaction, including staged insertions, edits and
deletions, and preserves collection order. Held receipt views repair indexed
selections from their change journal after peer writes, keeping the original
cut and order. Account liveness uses the existing
active-owner projection. Scanner tier hydration yields between sixteen current
paths. The seat report uses the registry owner's retained parent projection.

Receipt fields are written by launch admission and replay, provisional-owner
adoption, capability staging/rotation/discard and migration commit. Legacy import,
whole-store replacement and archive copies also carry them. The new indexes are
partial receipt indexes prepared through `prepareRecoveryIndexes`; SQLite maintains
them for every producer. Archive lookups validate the mapped version by its full
identity. The existing seat-child index and malformed-mapping recovery remain
unchanged. Plain JSON compatibility fixtures keep their previous selection rules.

Individual prototype reads select one task or seat round. A task round update uses
`boundedPatch(2)` and the existing completion/default and revision stamps. The
only producer of that new write API is `mutatePrototypeRound`: decisions, delivery
bookkeeping and Telegram post outcomes all enter through it. Publication retains
the existing whole-board retention transaction; seat rounds and Telegram poll
metadata retain their existing write paths. No task identity, tombstone, wire
schema or default changes. Linked bookkeeping compares the task's replicated
groups first; a semantic group change retains the existing project-watermark
calculation. Peer rows stay shared and unchanged.

The task-list projections have one process owner across compiled bundles. Weak
keys tie derived views to the existing collection owner's eviction (eight slots,
256 MiB of source text); held views remain immutable. Keyed prototype reads add
no cache. The background worker keeps its schedule in the existing global owner
and retains only cursor keys as new state. Each production tick reads at most
sixteen tasks and sixteen seat rounds, visits at most sixteen owed deliveries,
and starts at most sixteen pending posts and sixteen poll reconciliations. Its
round-robin order admits later decisions while earlier ones remain pending.
Cold/explicit sweeps yield between pages. Retry identities, backoff, exhaustion
and per-round dispatch fences remain unchanged.

The remaining complete receipt traversals serve legacy normalization/migration,
explicit release ownership censuses or already-scoped recovery snapshots. The
old synchronous service-tier census remains as a compatibility helper; both
production scanner entries use the paged keyed reader. Diagnostic receipt reads
are keyed for ordinary failures; contradictory diagnostic identities preserve
their historical collection-order fallback. No timing gain is claimed for
unmeasured compatibility, publication or linked watermark work.

The measurement uses only synthetic records: 10,971 receipts (10,951 archived),
35,622,379 persisted receipt bytes, 1,705 tasks and 20 selected rounds. These row
counts match the retained-registry qualification fixture and the 2026-10-15 task
census in [cold-board-start.md](cold-board-start.md). The task payload is recorded
in the raw results. Each fresh process warms its stores, then runs nine bursts
of twenty calls per workload, yielding between bursts. There are no concurrent
writers, HTTP requests or agent processes in the fixture. The host's ambient
load and available resource observations are retained per run.

The command is `bun scripts/measure-residual-readers.ts <output.json> <label>`,
run through `scripts/gate-slot.sh` with isolated HOME, XDG config/cache/data,
TMPDIR, Codex/Claude homes and `LLV_STATE_DIR`, an unset `LLV_STATE_OWNER`,
`NODE_ENV=test` and `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:9`. Use the same
script in an export of the base and candidate, alternating base/candidate for
three pairs. Each output records the logical fixture digest, source digests,
interpreter, timestamp, workload and per-call/per-burst statistics. Compare
identical fixture digests and candidate source digests before aggregating.

The synchronous durations measure a synchronous call's elapsed time, including
scheduling delay. Read bytes come from `/proc/thread-self/io` `rchar`, with the
small counter-read overhead included. They measure kernel reads on that thread;
SQLite's user-space cache can answer calls without a kernel read. Per-call byte
figures allocate a twenty-call burst's total equally. The independent process
CPU totals include background instrumentation threads. These observations do
not establish a production-wide gap share or attribute the audit's independent
kernel bytes to one SQL connection.

The final three alternating pairs were measured on 2026-10-17 under Bun 1.4.0.
All six runs have fixture digest `b0df54796b164cc9f8e065619345f062f3e586ce11af146ef28218a245a6052b`.
The candidate source digests were rechecked against the delivered files. The
[raw record](../../evidence/performance/residual-readers.json) retains all six
runs and their maxima. Tables use the median of the three process medians; a
burst is twenty calls. Call and burst medians are calculated independently.

| Workload | Base ms/call | Candidate ms/call | Base ms/burst | Candidate ms/burst |
| --- | ---: | ---: | ---: | ---: |
| Receipt ownership | 14.839 | 0.041 | 302.619 | 0.848 |
| Prototype round read | 52.188 | 0.055 | 1058.355 | 1.121 |
| Prototype round write | 154.454 | 6.796 | 2984.082 | 145.808 |

| Workload | Base bytes/call | Candidate bytes/call | Base bytes/burst | Candidate bytes/burst |
| --- | ---: | ---: | ---: | ---: |
| Receipt ownership | 242.25 | 10.50 | 4,845.00 | 210.00 |
| Prototype round read | 2,701.70 | 10.50 | 54,034.00 | 210.00 |
| Prototype round write | 7,415,815.10 | 332,259.00 | 148,316,302.00 | 6,645,180.00 |

| Run | Receipt ms/burst | Round-read ms/burst | Round-write ms/burst | Host load average |
| --- | ---: | ---: | ---: | --- |
| base-5 | 300.110 | 1051.537 | 2712.544 | 6.90 5.27 6.16 |
| work-5 | 0.845 | 1.096 | 128.065 | 7.07 5.33 6.17 |
| base-6 | 302.619 | 1553.806 | 2984.082 | 8.70 6.10 6.39 |
| work-6 | 1.081 | 1.169 | 145.808 | 8.65 6.13 6.40 |
| base-7 | 318.433 | 1058.355 | 3256.332 | 8.83 6.55 6.53 |
| work-7 | 0.848 | 1.121 | 162.307 | 8.87 6.63 6.55 |

The small receipt and keyed-read byte totals are near the counter-read floor.
The prototype write path still performs durable per-round transactions; the
reported candidate burst is an intentionally dense twenty-write stress burst.
Production ticks admit sixteen delivery visits and preserve the asynchronous
state-lock deadline between operations.

Validation ran explicit test files in separate isolated processes through the
resource gate. The raw record lists all 38 selected files: 35 passed outright.
Seven assertions also fail on the base with the same isolation: one MCP placement
stderr check, four startup checks, and two retained-history finalization stderr
checks. The new receipt selection, peer-rebind, prototype isolation, shared-owner,
linked watermark, paging and real-process restart regressions passed.

Typecheck and changed-file ESLint passed. `bun run build` passed. Under Bun 1.4.0,
`bun scripts/verify-viewer-runtime.ts` loaded 25/25 compiled server modules and
served `GET /` with status 200; `--codex-socket` exercised the compiled route's
transport. `bun scripts/verify-runtime-host.ts` passed its two-generation
succession and held both endpoints. The native Codex verifier passed engine-only
selections for 0.154.0 and 0.159.0, plus the shared selection.

The runtime probes used the existing Viewer verifier in the scratch export with
`TMPDIR` covering its whole private sandbox. Socket paths retained the owned
process-fd alias and refused an external temporary-directory fallback. These
harness adaptations keep config, inbox and sockets inside the stage scratch tree.

The tracker-audit fixtures passed (17 cases, English and Ukrainian OCR installed).
Publication privacy passed for the delivered files with the committed
fingerprints. The commit is scanned again before handover. Hosted privacy-publication, privacy-tracker-audit and runtime-gate
contexts run after pipeline publication and PR creation.

After deployment, capture an equivalent thirty-minute window with fleet size
and serving revision recorded:

```sh
journalctl --user -u '<serving unit>' --utc --all \
  --since '<window start>' --until '<window end>' -o cat --no-pager \
  | grep -a -E 'viewer loop-gap|blocking-wait' > residual-reader-journal.log
```

For `registry.receipts.all` and `prototype.state`, compare retained synchronous
milliseconds inside gaps, maximum milliseconds in one gap, counts and share of
gap time. Record omitted/dropped aggregates and sampler degradation alongside
those values. The SQL wrapper names indexed `.all()` selections with the same
`registry.receipts.all` label, so successful deployment can retain that label.
Its synchronous time should fall. Check that no new synchronous wait above
50 ms appears, and that decisions, retries and capability revocations still
settle. Use the serving runtime's own deploy timestamp for the window boundary.
