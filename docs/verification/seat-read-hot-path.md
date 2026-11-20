# Seat tick read paths

The hot path was checked on `origin/main` at `d51a786daa` before editing and
rechecked after integrating `3a14fe1b2e`:

- `src/lib/monitor/seatTickSources.ts` sends `seat-rule-reports` and
  `seat-reports` requests to `src/lib/filesResponse.worker.ts`, which calls
  `recordSeatRuleReports` and `seatTickReportRows` respectively.
- The worker's `seat-agenda` branch projects both `needsYouAnswer` forms and
  `seatAgendaAsks` after its imports and body read finish.
- `src/lib/monitor/seatTickController.ts` installs `ensureSeatTickCard` as the
  default card writer for checks and recoveries. Its unchanged-card preflight
  scans the board before deciding whether a task write is necessary.

Report preparation selects failed deliveries with `registryRowsMatching`.
The existing agent-origin, lost-owner, project, access and deduplication checks
still decide which outcomes become reports. The immutable registry reader's
existing journal reconciliation now also covers held-delivery state queries:
a peer changing a delivery after snapshot acquisition cannot change the
membership or order of that snapshot's report inputs.

Alias scopes enclose only synchronous predicates and projections. Store loads,
which can initialize legacy state, finish first; report appends and task write
transactions start after the scope returns. Explicit callback return types
reject asynchronous callbacks at compile time. The underlying alias helper and
its existing task-writer scope are unchanged.

## Reproduction

Run in private state through the source-export procedure:

```sh
bash scripts/gate-slot.sh bun scripts/check-source.ts -- bun scripts/profile-seat-reads.ts
```

The driver requires private `LLV_STATE_DIR` and a closed
`LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`; `check-source` supplies these plus
private HOME, XDG directories and TMPDIR. It constructs 34,623 deliveries,
including 752 failed rows, archives terminal history through the real store,
and prepares a board with 5,109 tasks, 1,299 conversations, 257 pipelines and
nine decision forms. IDs, insertion order and logical time are fixed.

Five alternating before/after registry samples each use a fresh reader process.
Registry timings measure selection and report projection after snapshot
preparation; each preparation time is retained separately. Seven samples per
board variant include snapshot acquisition in the optimized timing and warm
the same lazy stores before either variant. Timings depend on machine load;
the deterministic read counts and output hashes are the equivalence evidence.

| Measurement | Before | After |
| --- | ---: | ---: |
| Selected delivery rows | 34,623 | 752 |
| Delivery payload reads, including re-reads | 35,051 | 752 |
| Registry projection median | 2,026.15 ms | 115.11 ms |
| Median reader peak RSS | 323.77 MiB | 275.68 MiB |
| Task filter statSync calls | 25,545 | 5 |
| Task filter median | 298.48 ms | 0.58 ms |
| Complete agenda statSync calls | 9,125 | 5 |
| Complete agenda median | 116.07 ms | 11.58 ms |

Peak RSS covers the complete reader process, including module startup and
snapshot preparation. Every before/after output
hash matches, and every per-variant output is stable across repeated samples.
Raw samples and hashes are in `evidence/perf/seat-read-hot-path.json`.

## Regression checks

`src/lib/monitor/seatTickReports.reads.test.ts` compares serialized production
report inputs with the original expressions for legacy JSON, hot SQLite and
archived SQLite. It covers missing authorship, legacy project fallback, absent
and unverified lost-owner evidence, foreign projects, alias moves and a peer
commit after snapshot acquisition. It also checks the card preflight releases
its alias scope before a refused write and after predicate/read failures.

`src/lib/scanner/filesResponseWorker.test.ts` compares the resident worker's
complete serialized agenda against the original projection, including forms,
routed asks, foreign projects, consecutive alias moves, a refused body path and
a worker restart. Existing controller and registry tests are selected by the
repository's pre-push touched-tests planner.
