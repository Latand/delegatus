# Residual synchronous readers

The 2026-10-16 audit identified repeated receipt collection reads and prototype
state access inside Viewer gaps. This change bounds the recurring reads while
preserving receipt selection, ownership checks, prototype answers and linked
metadata. The base is `4119ffba3a42530c74ff484d81bce1721db62485`.

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

Individual prototype reads select one task or seat round. `loadPrototypeTask`
serves `findPrototypeRound` and `taskForPrototype`; both readers and the mutation
writer validate the selected task and keep its previous validation error.
A task round update uses
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
no cache. A release awaiting its first import retains the existing legacy-file
read until promotion; keyed misses never fall back to a collection read. The
background worker keeps its schedule in the existing global owner
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
are keyed for ordinary failures; contradictory diagnostic identities select
only their two launch IDs in historical collection order. No timing gain is
claimed for unmeasured compatibility, publication or linked watermark work.

The measurement uses only synthetic records: 10,971 receipts (10,951 archived),
35,622,379 persisted receipt bytes, 1,705 tasks and 20 selected rounds. These row
counts match the retained-registry [receipt census](managed-update-failures.md)
and the 2026-10-15 task census in [cold-board-start.md](cold-board-start.md). The
task payload is recorded in the raw results. Each fresh process warms its stores, then runs nine bursts
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
| Receipt ownership | 13.549 | 0.039 | 274.001 | 0.794 |
| Prototype round read | 44.685 | 0.055 | 898.449 | 1.160 |
| Prototype round write | 117.513 | 5.229 | 2371.228 | 105.775 |

| Workload | Base bytes/call | Candidate bytes/call | Base bytes/burst | Candidate bytes/burst |
| --- | ---: | ---: | ---: | ---: |
| Receipt ownership | 244.15 | 10.50 | 4,883.00 | 210.00 |
| Prototype round read | 2,711.30 | 10.50 | 54,226.00 | 210.00 |
| Prototype round write | 7,415,821.85 | 332,263.20 | 148,316,437.00 | 6,645,264.00 |

| Run | Receipt ms/burst | Round-read ms/burst | Round-write ms/burst | Host load average |
| --- | ---: | ---: | ---: | --- |
| base-final-1 | 291.251 | 966.639 | 2439.030 | 5.82 5.08 5.18 |
| candidate-final-1 | 0.794 | 1.106 | 110.117 | 5.92 5.12 5.19 |
| base-final-2 | 274.001 | 894.110 | 2371.228 | 4.54 4.88 5.11 |
| candidate-final-2 | 0.965 | 1.160 | 105.775 | 4.42 4.85 5.10 |
| base-final-3 | 271.732 | 898.449 | 2223.738 | 3.54 4.59 5.00 |
| candidate-final-3 | 0.786 | 1.200 | 103.878 | 3.74 4.61 5.01 |

The small receipt and keyed-read byte totals are near the counter-read floor.
The prototype write path still performs durable per-round transactions; the
reported candidate burst is an intentionally dense twenty-write stress burst.
Production ticks admit sixteen delivery visits and preserve the asynchronous
state-lock deadline between operations.

Validation ran explicit test files in separate isolated processes through the
resource gate. The raw record lists all 38 selected files: 35 passed outright.
Six assertions also fail on the base with the same isolation: one MCP placement
stderr check, three startup checks, and two retained-history finalization stderr
checks. The base also fails one scheduled-retry fixture that the candidate
scopes to the startup spawn-effect query. The new receipt selection, peer-rebind,
prototype isolation, shared-owner,
linked watermark, paging, malformed selected-row refusals and real-process
restart regressions passed. The three selected-row refusals also pass on the
base and fail before the candidate validation correction.

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
fingerprints. The commit is scanned again before handover. Hosted
privacy-publication, privacy-tracker-audit and runtime-gate contexts run after pipeline publication and PR creation.

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
