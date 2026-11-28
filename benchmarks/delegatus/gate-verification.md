# Offline benchmark gate verification

The pinned manifest leaves launch disabled. Offline preflight reports
`allowed: false` and `modelLaunches: 0` with exit 2. With no binding, it lists
all 24 missing observations across G1–G7.

| Gate | Boundary still open |
| --- | --- |
| G1 | Effective process roots, subscription auth, sterile instructions and denial of live-state access. |
| G2 | Composed task, controller and engine inputs. The positive parent canary, negative role canaries, start/resume checks and memory/lesson write isolation must be observed on those inputs. |
| G3 | Complete effective reader inventory and negative canaries for each reader, including shell, filesystem, Git, instructions, skills and MCP. Cross-arm state and future/hidden inputs must be denied. |
| G4 | Denial of paid credentials, clients and selector/curator access. The local whole-pack retrieval path needs its own observation. |
| G5 | Usage from the actual parser, aggregate limits across retries and observed interruption and cleanup of owned work. |
| G6 | Exact task, package and worktree links against the selected isolated registry, plus current-seat lineage and visible MCP stages. The offline check can observe the links and refusal controls. The lineage boundary remains open. |
| G7 | Retrospective quarantine, locked disposable packages, actual reference-oracle runs and the effective payload for blind judges. |

For G6, run `bun benchmarks/delegatus/run.ts check-task-links "$binding"`
with an isolated state directory and disposable parent, package and linked
worktree directories under the physical `TMPDIR`. Set `LLV_STATE_DIR` to that
state directory. The binding's `taskLinks` contains `src`, `taskIds`,
`parentRepoDir` and one `{task, repoDir, worktreeDir}` per registered task.
Exit 0 means the probe returned observations. Each result carries its own
`passed` value. An unavailable probe exits 2 and returns an empty object.

The probe reads the exact task IDs via `loadTasksByIds`, resolves the
parent, package and worktree projects and observes the worktree's Git
backing repository using the product scanner. It calls
`pipelineTaskLinkError` for the package and worktree bindings and the
wrong-project and missing-task controls. Each result includes the manifest,
effective input, reader and driver digests along with the raw outcomes.
Persist each result in its own owner-only file, then put its path and SHA-256
digest in `gateResults` under the matching proof name. The
`preflight "$binding"` command re-runs the check and compares the entire
observed result with that file. A harness-only binding still refuses every
proof. A matching local G6 receipt describes the selected scratch registry
and checkout layout. Current-seat authority needs its own observation.

The offline driver has no check for the remaining runtime boundaries and no
authenticated source for an independent verdict. Those requirements remain
open. Changing the synthetic fixture's top-level classification used to
clear every proof and reach the offline interlock. The regression control
performs that same change with every evidence file and digest intact and now
gets all 24 named refusals.

Run the offline controls with isolated HOME, XDG_CONFIG_HOME, TMPDIR,
LLV_STATE_DIR and a closed loopback Viewer control URL.

```sh
bash scripts/gate-slot.sh bun scripts/check-source.ts -- bun test ./benchmarks/delegatus/run.test.ts
bun benchmarks/delegatus/run.ts preflight
```

The Git and registry fixtures in the test exercise positive G6 links and
wrong-project, missing-task, same-project lookalike, changed-input and
rehashed-result refusals. The positive fixture leaves
`G6: current-seat-visible-lineage` in the preflight refusal. The preflight
command without a binding exits 2 and includes every proof in the table.
