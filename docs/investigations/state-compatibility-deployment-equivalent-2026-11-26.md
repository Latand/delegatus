# State compatibility under deployment-shaped CPU contention

Measured on 2026-11-26 with Bun 1.4.0 on a 24-logical-CPU Linux host. The
baseline was `c38535d43308f13c59e47b6f225e6e55e84beb72`; the final candidate
code was `1b5fe54fbfcd98c59877ffa52f6f7cc864149d3f`. Each boot served the real
revision-bound readiness route on an ephemeral loopback port and used a fresh
private state copy of the same synthetic fixture. The 6.8 GB agent registry
contained 1.4 million JSON-expression-indexed rows plus an 800,000-row history
table; the other three databases brought the complete fixture to 7.1 GB.

The temporary cgroup hierarchy reproduced the serving and gate placement:
the parent had a 20-CPU quota, the Viewer ran at weight 1000, and the work
slice ran at weight 100 with an 18-CPU quota. Six gate scopes each ran five
CPU burners at weight 10 and a three-CPU quota. Kernel readback was
`400000 20000` for the parent, `360000 20000` for the work slice, and
`60000 20000` for each gate scope. The Viewer scope read back weight 1000 and
no quota. Thirty burners stayed active through all six interleaved samples.
Every sample used the same 19 per-step probes for wall time, thread CPU,
scheduler runnable wait, physical reads, and worker nice value.

| Pair | Revision | Start–peak host load | Compatibility (s) | HTTP 200 (s) | Work-slice PSI `some` |
|---:|---|---:|---:|---:|---:|
| 1 | Baseline | 24.9–36.8 | 81.50 | 85.74 | 49.1% |
| 1 | Candidate | 37.3–37.6 | 6.73 | 8.51 | 47.5% |
| 2 | Candidate | 38.6–39.8 | 8.02 | 10.12 | 46.8% |
| 2 | Baseline | 38.5–39.6 | 80.28 | 82.80 | 49.1% |
| 3 | Baseline | 39.8–39.8 | 85.12 | 87.16 | 49.3% |
| 3 | Candidate | 40.9–41.0 | 6.87 | 8.90 | 48.0% |

The per-sample registry-check profiles were:

| Pair | Revision | Check | Wall (s) | CPU (s) | Runnable wait (s) | Physical reads | Nice |
|---:|---|---|---:|---:|---:|---:|---:|
| 1 | Baseline | `integrity_check` | 78.67 | 78.42 | 0.241 | 0 | 10 |
| 1 | Candidate | `quick_check` | 3.55 | 3.53 | 0.011 | 0 | 0 |
| 2 | Candidate | `quick_check` | 3.77 | 3.73 | 0.039 | 0 | 0 |
| 2 | Baseline | `integrity_check` | 76.96 | 76.62 | 0.343 | 0 | 10 |
| 3 | Baseline | `integrity_check` | 82.34 | 82.10 | 0.242 | 0 | 10 |
| 3 | Candidate | `quick_check` | 3.85 | 3.84 | 0.011 | 0 | 0 |

All six samples returned HTTP 200 for their requested revision. Median
compatibility fell from 81.50 s to 6.87 s; median readiness fell from 85.74 s
to 8.90 s. The registry check itself fell from 76.96–82.34 s to 3.55–3.85 s.
Its baseline CPU time was 76.62–82.10 s, with 0.24–0.34 s of runnable wait
and zero physical reads. The candidate check used 3.53–3.84 s CPU, with
0.01–0.04 s of runnable wait and zero physical reads. Similar work-slice PSI
across each pair confirms the synthetic gate pressure remained comparable.
The incident-shaped full scan was CPU-bound in the serving cgroup; removing
the worker's nice penalty alone did not materially shorten it.

During activation, `agent-registry.sqlite` now uses SQLite `quick_check`.
SQLite documents that it checks page and B-tree structure in O(N), while
`integrity_check` also verifies index-to-table consistency and uniqueness in
O(N log N) ([SQLite PRAGMA documentation](https://www.sqlite.org/pragma.html#pragma_integrity_check)).
The activation check still refuses structural corruption, incompatible schemas,
missing worker verdicts, and failed recovery; the existing regression tests
cover the damaged-database fallback and missing-verdict refusal. Full
`integrity_check` remains required when validating backup and schema-recovery
candidates. The activation quick check does not detect a logically mismatched
index or a duplicate violating a unique index; those checks remain on the full
recovery-validation path.

The earlier weighted table was discarded because it used a smaller fixture,
omitted candidate step probes, and reused one baseline row. The profiles above
are six fresh interleaved boots with one fixture, one probe configuration, and
verified effective CPU controls. No production state or stable listener was
used.

## Scratch recipe

1. Export the baseline and candidate commits into separate directories under
   the operating system temporary directory and symlink the installed
   `node_modules` tree into each export.
2. Seed `agent-registry.sqlite` with 1.4 million rows containing sixteen JSON
   fields and sixteen `(collection, json_extract(value_json, '$.fN'),
   row_order)` expression indexes. Add an 800,000-row history table with three
   ordinary indexes, plus the same 120,000-row state, 40,000-row receipt, and
   10,000-row handoff tables for every run. Record the four fixture file sizes
   and SHA-256 hashes before starting.
3. For each boot, copy all four fixture files into a fresh private state
   directory, read every copy to warm the file cache, and give the process a
   private home, config, data, cache, and temp directory. Set the control URL
   to closed loopback port 1 and bind the Viewer to port zero.
4. Apply the temporary phase and SQLite probes to both source exports. The
   SQLite probe records `performance.now()`, thread schedstat CPU and runnable
   nanoseconds, `/proc/self/io` physical reads, and worker nice for each check;
   seven phase probes divide the compatibility phase. Start the real
   instrumentation and readiness route, then poll for HTTP 200 with the exact
   revision query for at most 175 seconds.
5. Keep thirty CPU burner threads active in six work-slice scopes, five per
   scope. Read back `cpu.weight`, `cpu.max`, and the `some` total from each
   cgroup before and after the samples. Use the interleaved order shown in
   both tables and stop all six named scopes after the final boot.

The full 114-row, 19-step-per-sample profile is in
[state-compatibility-profiles-2026-11-26.csv](state-compatibility-profiles-2026-11-26.csv).
The retained per-sample JSON contains each full cgroup readback, fixture hashes,
and PSI deltas. The SQLite `quick_check` timing was also measured directly on
the same registry fixture under the same cgroup layout.
