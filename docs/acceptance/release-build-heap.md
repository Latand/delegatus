# Release build TypeScript memory

The build at `4fb16340a333d40d58e9bc2c2ae8a128d5fc537d` reaches webpack
success and then exhausts a 4096 MiB Node old-space budget during TypeScript.
The repository config selects 3,627 roots, including 1,651 tests plus docs,
evals, scripts and spikes. The production config selects the application and
runtime-host sources, the Next config and generated route types. Imported
dependencies remain checked, including dependencies outside those roots.
Development and the full repository gate continue using `tsconfig.json`.

`next.config.ts` sets a 6144 MiB floor in `NODE_OPTIONS` during
`PHASE_PRODUCTION_BUILD`, before Next launches its TypeScript process. It
preserves other Node options and larger heap settings. Self-update's
`bun run build`, developer builds, Docker, CI and standalone packaging all
load this config. The setting uses JavaScript and works with native Windows
process launches. The production config is included in Docker and platform
CI admission so a later change to it receives those checks.

## Measurements

Linux, Node 22.16.0, Bun 1.4.0 and Next 16.3.6; isolated source exports,
fresh build caches, telemetry disabled, `NEXT_PUBLIC_RUNTIME_UI=1`.
Both release builds ran `bash scripts/gate-slot.sh bun run build`, with an
inherited 4096 MiB cap. The fixed config raises the TypeScript child to
6144 MiB. Build imports resolved disposable state; no serving state owner
was declared.

| Run | Result | Wall time including admission | TypeScript peak RSS | Largest process RSS |
| --- | --- | --- | --- | --- |
| Unmodified `4fb16340`, 4096 MiB | OOM after webpack success | 212.90 s | at least 4.16 GiB | 4.45 GiB |
| Fixed `df3fbf2b` source export, production config and 6144 MiB | Complete Next and MCP build | 156.83 s | 2.20 GiB | 4.40 GiB |
| Final source cold release build, 6144 MiB | Complete Next and MCP build | 227.87 s | 2.15 GiB | 4.38 GiB |
| Production-only cold `tsc`, 4096 MiB | Pass | 62.24 s | 2.05 GiB | 2.05 GiB |

The failed TypeScript process's last collections were at 4034.6 and
4034.2 MiB. Its RSS high-water mark was sampled from `/proc` every 200 ms;
the process aborted before it could report its final resource usage, so that
measurement is a lower bound. Successful processes also reported the OS peak
through `process.resourceUsage().maxRSS`; `/usr/bin/time -v` measured wall
time and the largest process RSS. A Node preload recorded each child's heap
limit, confirming a 6192 MiB total V8 heap limit for the 6144 MiB old-space
setting. The successful TypeScript child recorded 2.05 GiB heap usage at exit.
GC tracing in the final cold build recorded 2053 MiB of heap use. Wall times
include machine admission and are affected by concurrent work.

Production scoping reduces TypeScript peak RSS by at least 47%. Its complete
RSS fits within 2.20 GiB, leaving over 3.8 GiB between that upper bound on
heap usage and the configured old-space budget. Webpack determines the
largest process RSS of the whole build.

## Verification

- The heap regression was observed failing against the original config.
  It uses the installed Next config loader and TypeScript child launcher,
  verifies the 6 GiB floor, retains an 8 GiB setting and unrelated options,
  and refuses disabled type checking.
- The production config covers every existing non-test source root, including
  the runtime host. The full config retains tests and build tooling.
- A real TypeScript check rejects an invalid imported source outside the
  production roots and passes after correcting it; a test-only error stays
  outside the production check.
- Docker and platform admission regressions fail before the new config is
  registered and pass afterward.
- The fixed Viewer build loads all 24 server modules under Bun 1.4.0 and
  serves `GET /` with HTTP 200 using isolated state and an ephemeral port.
