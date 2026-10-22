Pipeline history read measurements for #3031.

Base: `db528f4d85d7d2ced1ad771455de393543f3de45`. Candidate source is identified
by the SHA-256 digests in `progress.json`. Both revisions used the candidate's
`src/lib/pipelines/startupResponsiveness.test.ts` and identical dependencies.
The two regression cases were red on the base before the implementation changed.

Run the following command in scratch exports of the base and candidate, with
isolated `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `TMPDIR`, `LLV_STATE_DIR`
and `LLV_VIEWER_CONTROL_URL=http://127.0.0.1:1`:

```sh
bash scripts/gate-slot.sh bun test ./src/lib/pipelines/startupResponsiveness.test.ts -t 'history evidence (keeps|callers)'
```

Measured on Bun 1.4.0, with three sequential base/candidate pairs in one gate
admission and a fresh process and state root per sample. Each fixture has 48
retained rows and one active row. One direct SQLite commit changes the active
row after the reader obtains its snapshot. The retry interval measures the
next health read; the overlap interval measures two concurrent health/ownership
callers, including the controlled write. No extra background load was added.
The host exposes 24 logical CPUs; all samples recorded the same 1/5/15-minute
load average, 30.76 / 28.83 / 28.59. Raw samples, exact timestamp, commands and
source digests are in `progress.json`.

| Workload | Decodes before, each run | Decodes after, each run | Median ms before | Median ms after |
| --- | --- | --- | --- | --- |
| Retry after rejected snapshot | 49 | 1 | 20.84 | 14.99 |
| Two overlapping callers | 98 | 49 | 25.89 | 19.85 |

These are observations for the synthetic workload under the recorded machine
load. The decode counts establish the reduction in repeated validation work;
the timing samples do not establish a production latency guarantee.
