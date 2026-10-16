# Pipeline repository initialization

The acceptance specification was pinned on 2026-10-16. The base was
`917189ae562def76980341620987479ab2813cfc` on `origin/main`.

| Acceptance | Implementation | Regression evidence |
| --- | --- | --- |
| A: create and board start | `initializeRepository.ts` prepares an inspected baseline on `main`; creation returns the inventory and records a bridge report. The picker checks eligibility without writing. | `repositoryInitialization.test.ts` exercises board eligibility, creation, empty folders, existing ignore rules and executable modes. HTTP route and MCP compact-answer tests verify both response projections. |
| B: safety | Canonical-root checks, bounded snapshots, secret detection, explicit Git path selection, isolated Git configuration and identity checks precede installation. Existing ignore files receive appended exclusions. | Repository tests cover home/state roots, symlinked state, foreign metadata, nested repositories, secret-bearing content, UTF-16 content, large files, count/byte refusal, inherited hooks/identity and existing linked worktrees. Byte refusal is repeated in a new process. |
| C: succession | The initializer uses the existing `projectSuccessionFor` and `recordProjectSuccessions` path. State writes use `waitForStateLock`. A durable Git receipt supports recovery and report deduplication. | `succession.test.ts` preserves the seat, task and pre/post-initialization conversations. Repository tests exercise concurrent creators, a fresh process and both fresh/replay writes under a real SQLite peer lock while an independent timer advances. |
| D: local publication | The initializer creates no remote and uses the existing local delivery path. | The local-lane regression provisions a real worktree and completes its stage; its execution ports refuse fetch, push and forge commands. MCP checks the local publication acknowledgement. |

The shared contract has no new request field. Its producers are MCP creation,
HTTP creation, task assignment and draft start/update. The existing preflight
port carries optional initialization metadata; the engine result, HTTP echo and
MCP acknowledgement expose it. Pipeline records keep their existing schema.
The first-commit receipt lives inside Git metadata. The bridge log stores the
operator inventory, and existing project aliases carry succession across stores.

Regression runs use explicit file paths under isolated HOME, config, state and
temporary roots. Source, probes and rendered captures run in scratch exports.
No runtime or agent directory sweep is used.

Before implementation, the initial A–D cases failed on main at their missing
behavior. The final 25-case repository file was also replayed on merged main
`e7507d58863450a1f45b1a93d2b27a059ca13c6e`: 24 failures and one passing
existing-repository safeguard. The added succession, MCP and
picker-refusal cases also failed on main. The two HTTP cases failed with 400
where successful creation and a reasoned safety refusal were required.
The former HTTP test expecting every plain folder to fail is replaced by those
two cases because plain folders are now accepted by the specification.

Run the focused checks through the project's gate wrapper, one file at a time:

```sh
bash scripts/gate-slot.sh bun test src/lib/pipelines/repositoryInitialization.test.ts
bash scripts/gate-slot.sh bun test src/lib/projects/succession.test.ts
bash scripts/gate-slot.sh bun test src/lib/mcp/compactAnswers.test.ts
bash scripts/gate-slot.sh bun test src/app/api/pipelines/route.test.ts
bash scripts/gate-slot.sh bun test src/app/api/pipelines/preflight/route.test.ts
bash scripts/gate-slot.sh bun test src/lib/pipelines/preflight.test.ts
bash scripts/gate-slot.sh bun test src/components/pipelines/PipelineTemplatePicker.dom.test.tsx
```

The existing kanban browser driver has a `pipeline repository initialization`
case. Set `LLV_KANBAN_BROWSER_TEST=1` and `CHROME_BIN`, then run its explicit path
with `-t 'pipeline repository initialization'`. It captures ready and refused
pickers at 390 and 1280 pixels in both languages and themes. Its measurements
are recorded in `evidence/pipeline-repository-initialization/readings.json`.

Final focused results: 25 repository-initialization tests, 7 succession tests,
10 HTTP creation tests, 9 repository-preflight tests, 3 preflight-route tests,
8 picker DOM tests and the 16-frame browser case passed. The MCP file passed
its new initialization and replay regression. Its older compact-answer size
assertion produced the same 1,728-byte result against a 1,600-byte limit on
both main and the candidate; it is pre-existing. The broader explicit
`engine.creation.test.ts` run passed 95 cases and failed two existing cases:
`early-switch-off` expected a second spawn and got one, and the common-Git-dir
serialization fixture tried writing into a missing hooks directory. Running
those exact two cases on merged main reproduced both failures.

TypeScript (`tsc --noEmit`), changed-file ESLint and the privacy publication
gate passed.

This change makes no performance claim.
