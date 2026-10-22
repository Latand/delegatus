# Release preparation under CPU load

The saved failure of `d97a20c5` on 2026-10-21 ran from 16:10:09.001Z to 16:30:09.903Z.
Its `install` step failed at 1,200,009 ms; `build` remained pending.
Revisions `db528f4d` and `d97a20c5` already gave compilation 45 minutes. The history's `build`
kind covers the preparation sequence, so its timeout detail alone did not
identify the failed step. `scripts/deploy-checkout.py` switches an already
verified build and does not create this build child.

Installation and compilation now start immediately in their own release scopes,
beside the aggregate agent work slice, at CPU weight 1000 without a CPU quota.
The npm distribution updater (`update-package`) and publication work retain
their existing work admission.
Nonempty output renews a 30-minute silence deadline. Total bounds are one hour
for installation and two hours for compilation. Both expiry paths preserve
queued exit I/O and await bounded cleanup. A restored running preparation fails
as interrupted. Generated release scopes stop all descendants, including after
the leader exits or its start identity becomes unreadable. Scope ownership travels
as explicit launch metadata; a command argument cannot grant cleanup authority.

`deployment_status.error` retains the failed step and cause through the apply
intent and checkout deployment ledger. Timeout detail includes elapsed minutes,
silence versus total deadline, and the load and CPU count at expiry. A refused
cleanup retains the timeout cause alongside the cleanup error. Legacy timeout
records remain readable.

The rehearsal used a scratch export of base `e2fbe4df412a8ba191543ac209254f86c472596b`
with this change overlaid, isolated HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and
TMPDIR, Bun 1.4.0, Next 16.3.8 and 24 logical CPUs. The final run started without
`.next` or `node_modules`; the Bun package cache was warm. Six Node worker
threads ran busy loops in one work scope capped at 300% CPU, from an explicit
ready barrier until the build finished. The load had a 40-minute independent
bound. The parent rehearsal had a 30-minute bound and stopped its recorded
processes in cleanup. One-minute system load was sampled every second.

After the load's ready signal, the real `realPorts().run` performed
`bun install --frozen-lockfile` with `work: update-install`, then
`bun run build` with `work: update-build`. The build command includes Next,
the MCP bundle and the gate bundle. Kernel readback inside the build scope
reported `cpu.weight=1000` and `cpu.max=max 100000`. Native scope tests also
verified publication work retained weight 100 and `cpu.max=60000 20000`.
All heavy checks and the rehearsal ran through the stage-provided gate wrapper.

| Run | Finished UTC | Install seconds | Build seconds | Total seconds | Load avg1 range | Result |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Final source rehearsal | 2026-10-21T18:45:28.943Z | 0.50 | 408.22 | 408.72 | 20.84–32.14 | All build phases passed; synthetic load still active |

Source digests for the final rehearsal:

| File | SHA-256 |
| --- | --- |
| `src/lib/runtime/cpuPlacement.ts` | `dee7bdca9f780a88ba95153993adec9039c2c08856899155607d5de9ac1a9748` |
| `src/lib/selfUpdate/steps.ts` | `f34ad9a912e5e72c537c3c90b6466bf3bfb3699a3b0ad7e6f9c55ba585df59af` |
| `src/lib/selfUpdate/service.ts` | `0342e47a5d9827b01c1eecc79afe083ad93c55955959787c760a82f2ec6b3c3d` |
| `src/lib/selfUpdate/types.ts` | `3d626d1b4f4cd437d960a2dc406e92ada2ae2a74af006f56056d3ee69c755966` |

Red tests reproduced pressure-held release work, fixed total expiry despite
progress, generic deployment errors, TERM-resistant children and descendants,
timeout cause loss during cleanup, unreadable leader identity, and successful
exit I/O queued at the silence deadline. Final checks cover both preparation
steps, silence and total bounds, real process restart, refusal, success and
late output. The ledger error also survives service replacement.

Baseline comparison used an immutable export of the same base under the same
isolated environment. These existing failures reproduced on both sides:

| File | Existing failures |
| --- | --- |
| `src/lib/selfUpdate/routes.test.ts` | Short-revision admission assertion; rollback-retry timeout |
| `src/lib/selfUpdate/safety.test.ts` | Existing port literals in unrelated fixture files |
| `src/lib/runtime/cpuPlacement.scope.test.ts` | Four nested-gate assertions refused by the inherited slot/user-namespace boundary; private tmux fixture timeout |

The immutable baseline export was checked against all 6,684 tracked blobs with
no mismatches. The focused checks pass 90 tests, plus four native scope cases
and 108 route cases after the two named baseline exclusions.

The final targeted commands are `bun test` with explicit paths for
`src/lib/selfUpdate/steps.test.ts`, `src/lib/runtime/cpuPlacement.test.ts`,
`src/lib/selfUpdate/deployments.test.ts` and `src/lib/selfUpdate/package.test.ts`;
the native scope file filtered to `publication keeps|release cleanup reaps`;
and the route file excluding only the two named baseline failures. Type checking
uses `node node_modules/typescript/bin/tsc --noEmit`; changed-file lint uses
`bun run lint` with explicit paths. Publication privacy uses the committed
fingerprints and commit inspection. No serving release was switched.
