# Brief fence verification

Implements the proposals in the #3916 analysis read from its analysis branch. The operator's November 12 requirement is paraphrased here: remove needless brief restrictions and prevent them from blocking their own acceptance.

## Changes and contract inventory

- `src/lib/orchestrator/prompt.ts`: mandate v69 requires a reason, authority, protected resource and continuation owner for added fences; traces acceptance against dependencies and effective role/controller limits; allows a bounded evidence report to retain explicit gaps. Exact shipped defaults upgrade on fresh intents; pending intent replay keeps its existing bytes.
- `src/lib/roles/defaults.ts`: scope protects outcomes and actual owners; builders validate in isolation and hand production work to the project's authorized owner; reviewer/verifier acceptance stays with their assigned artifact. Production authorization, personal holds, uncertain-operation protection and foreign ownership remain in force.
- `.claude/skills/delegatus-conveyor/SKILL.md`: stage preparation carries permitted dependent tests and adapters, with reasons for extra restrictions.
- `src/lib/pipelines/briefWarnings.ts`: advisory diagnostics include source, restriction, reason and conflicting criterion where detected. English indicators cover excluded tests/server dependencies, fixed SQL pattern limits, production writes and read-only actions. The seat performs the complete semantic/dependency check; these indicators do not establish semantic completeness or a measured change in model behavior. Four labelled reason fields in a restriction block suppress its reason reminder. Output is bounded to 24 items with explicit overflow reporting.
- `src/lib/pipelines/engine.ts`: the shared creation result covers direct creates, queued creates, request replay, task-assignment creates and normalized role defaults. The shared patch result covers draft edits, all graph edits, start, retry and decision continuation. Diagnostics are recomputed from the admitted record, including frozen role fences and explicit access. They never refuse or widen access and write no new stored schema.
- Consumers: MCP ordinary/queued `create_pipeline` acknowledgements and `pipeline_action`, plus HTTP collection POST and item PATCH. All carry `briefWarnings`; existing engine-connection warnings retain their separate contract. The controller continues to own publication. Internal task/release/refresh producers use the same engine entry point.

## Procedure and source state

Checks ran on November 12, 2026 UTC, with Bun 1.4.0, in scratch exports of initial main `c39bd873b1163f25cf2a5e1e489600b14103e476` overlaid with this change. Base rows use the unchanged commit with matching dependencies and isolation. The last main read was `f9571ba01c01a06065f177658bfed628a7f4bbd1`; its only additional file was an unrelated stage-panel test. The source manifest and raw logs are retained in the stage's private evidence directory under `brief-checks/`. No performance improvement is claimed.

`GATE` denotes the controller-supplied installed `scripts/gate-slot.sh`; `ROOT` is this stage's `brief-checks` scratch directory. Each table row launched once as:

```sh
env BRIEF_CHECK_ROOT="$ROOT" LLV_OWNED_RUN_TIMEOUT_MS=600000   bash "$GATE" --record "$TMPDIR/$log.log"   bash "$ROOT/run-check.sh" "$file" "${filter[@]}"
```

For unfiltered rows `filter=()`; selected controls set `filter=(-t "MCP acknowledges")` or `filter=(-t "advisory reasons")`. Base rows additionally set `BRIEF_CHECK_TREE=base`. The script creates fresh HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR below its scratch root, sets LLV_VIEWER_CONTROL_URL to the closed loopback port 1, sets LLV_GATE_RUNNER=off and executes the row's package command in its export. `brief-warnings-1`, `brief-admission-1` through `brief-admission-4`, and `brief-prompt-1` used one isolated home/state root; other rows use fresh roots per command. Native Git's ELF header was verified, and native Git leads the test PATH; export-only detached metadata borrows objects read-only. Delivery retains the launch's guarded Git path. Every recording was reconciled exactly once through `wait_for_check`, including cleanup. Exit below is the check's terminal status, independently of recorder-launch status.

`P/F` counts tests, `E` counts expectations and `filtered` counts deliberately excluded tests. Development failures remain listed.

| Log | Tree | Package command | Exit | P/F | E | Filtered | Runner errors |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| brief-warnings-1 | head | `bun run test src/lib/pipelines/briefWarnings.test.ts` | 0 | 15/0 | 32 | 0 | 0 |
| brief-admission-1 | head | `bun run test src/lib/pipelines/briefAdmission.test.ts` | 1 | 0/4 | 3 | 0 | 0 |
| brief-admission-2 | head | `bun run test src/lib/pipelines/briefAdmission.test.ts` | 1 | 0/4 | 3 | 0 | 0 |
| brief-admission-3 | head | `bun run test src/lib/pipelines/briefAdmission.test.ts` | 1 | 3/1 | 26 | 0 | 0 |
| brief-admission-4 | head | `bun run test src/lib/pipelines/briefAdmission.test.ts` | 0 | 4/0 | 29 | 0 | 0 |
| brief-prompt-1 | head | `bun run test src/lib/orchestrator/prompt.test.ts` | 1 | 38/8 | 316 | 0 | 0 |
| brief-prompt-base | base | `bun run test src/lib/orchestrator/prompt.test.ts` | 0 | 46/0 | 343 | 0 | 0 |
| brief-prompt-2 | head | `bun run test src/lib/orchestrator/prompt.test.ts` | 1 | 0/1 | 0 | 0 | 1 |
| brief-prompt-3 | head | `bun run test src/lib/orchestrator/prompt.test.ts` | 1 | 45/1 | 344 | 0 | 0 |
| brief-prompt-4 | head | `bun run test src/lib/orchestrator/prompt.test.ts` | 1 | 45/1 | 344 | 0 | 0 |
| brief-prompt-5 | head | `bun run test src/lib/orchestrator/prompt.test.ts` | 0 | 46/0 | 344 | 0 | 0 |
| brief-warnings-2 | head | `bun run test src/lib/pipelines/briefWarnings.test.ts` | 0 | 19/0 | 38 | 0 | 0 |
| brief-admission-5 | head | `bun run test src/lib/pipelines/briefAdmission.test.ts` | 0 | 4/0 | 29 | 0 | 0 |
| brief-roles-1 | head | `bun run test src/lib/pipelines/roles.test.ts` | 1 | 29/5 | 159 | 0 | 0 |
| brief-roles-base | base | `bun run test src/lib/pipelines/roles.test.ts` | 1 | 32/2 | 494 | 0 | 0 |
| brief-roles-2 | head | `bun run test src/lib/pipelines/roles.test.ts` | 1 | 32/2 | 494 | 0 | 0 |
| brief-registry-1 | head | `bun run test src/lib/roles/registry.test.ts` | 1 | 22/1 | 153 | 0 | 0 |
| brief-registry-base | base | `bun run test src/lib/roles/registry.test.ts` | 1 | 22/1 | 153 | 0 | 0 |
| brief-connection-1 | head | `bun run test src/lib/pipelines/engineConnectionRefusal.test.ts` | 1 | 0/4 | 0 | 0 | 0 |
| brief-connection-base | base | `bun run test src/lib/pipelines/engineConnectionRefusal.test.ts` | 1 | 0/4 | 0 | 0 | 0 |
| brief-mcp-1 | head | `bun run test src/lib/mcp/pipelineRoleFence.test.ts` | 1 | 4/3 | 55 | 0 | 0 |
| brief-mcp-base | base | `bun run test src/lib/mcp/pipelineRoleFence.test.ts` | 1 | 4/2 | 54 | 0 | 0 |
| brief-mcp-2 | head | `bun run test src/lib/mcp/pipelineRoleFence.test.ts` | 1 | 5/2 | 61 | 0 | 0 |
| brief-http-create-1 | head | `bun run test src/app/api/pipelines/route.test.ts` | 1 | 5/6 | 23 | 0 | 0 |
| brief-http-create-base | base | `bun run test src/app/api/pipelines/route.test.ts` | 1 | 5/6 | 23 | 0 | 0 |
| brief-http-patch-1 | head | `bun run test "src/app/api/pipelines/[id]/route.test.ts"` | 1 | 19/1 | 67 | 0 | 0 |
| brief-http-patch-base | base | `bun run test "src/app/api/pipelines/[id]/route.test.ts"` | 1 | 17/1 | 63 | 0 | 0 |
| brief-mcp-3 | head | `bun run test src/lib/mcp/pipelineRoleFence.test.ts` | 1 | 5/2 | 61 | 0 | 0 |
| brief-mcp-new | head | `bun run test src/lib/mcp/pipelineRoleFence.test.ts -t "MCP acknowledges"` | 0 | 1/0 | 7 | 6 | 0 |
| brief-http-new | head | `bun run test "src/app/api/pipelines/[id]/route.test.ts" -t "advisory reasons"` | 0 | 2/0 | 4 | 18 | 0 |
| brief-admission-final | head | `bun run test src/lib/pipelines/briefAdmission.test.ts` | 0 | 4/0 | 29 | 0 | 0 |
| brief-prompt-final | head | `bun run test src/lib/orchestrator/prompt.test.ts` | 0 | 46/0 | 344 | 0 | 0 |
| brief-http-final | head | `bun run test "src/app/api/pipelines/[id]/route.test.ts"` | 1 | 19/1 | 67 | 0 | 0 |
| brief-http-new-final | head | `bun run test "src/app/api/pipelines/[id]/route.test.ts" -t "advisory reasons"` | 0 | 2/0 | 4 | 18 | 0 |

| brief-http-create-final | head | `bun run test src/app/api/pipelines/route.test.ts` | 1 | 5/6 | 23 | 0 | 0 |
| brief-warnings-final | head | `bun run test src/lib/pipelines/briefWarnings.test.ts` | 0 | 19/0 | 38 | 0 | 0 |
| brief-admission-final-2 | head | `bun run test src/lib/pipelines/briefAdmission.test.ts` | 0 | 4/0 | 29 | 0 | 0 |
| brief-graph-final | head | `bun run test src/lib/pipelines/briefAdmission.test.ts` | 0 | 5/0 | 34 | 0 | 0 |

## Final outcomes and inherited failures

The last complete-file observations total **153 passed tests and 16 base-matching failures** across nine files. The 19 advisory cases, five real admission cases and 46 mandate lifecycle cases pass. Filtered transport controls additionally pass: one MCP case covering ordinary/queued creation and stage actions, and two HTTP cases covering POST/PATCH. New tests assert contracts, state, warnings and preserved authority; they add no prompt-wording assertions. The existing mandate fingerprint remains the repository's version-delivery contract.

The matching failures are:

| File | Matching failures | Base/head evidence |
| --- | ---: | --- |
| `src/lib/pipelines/roles.test.ts` | 2 | `brief-roles-base`, `brief-roles-2`: outdated expected Claude model catalog; 32 pass, 2 fail, 494 expectations on both |
| `src/lib/roles/registry.test.ts` | 1 | `brief-registry-base`, `brief-registry-1`: outdated expected Claude model catalog; 22 pass, 1 fail, 153 expectations on both |
| `src/lib/pipelines/engineConnectionRefusal.test.ts` | 4 | `brief-connection-base`, `brief-connection-1`: fixture directory has no Git metadata; 0 pass, 4 fail on both |
| `src/lib/mcp/pipelineRoleFence.test.ts` | 2 | `brief-mcp-base`, `brief-mcp-3`: existing reporter-policy expectation and caller fixture; head adds one passing transport case |
| `src/app/api/pipelines/route.test.ts` | 6 | `brief-http-create-base`, `brief-http-create-final`: existing creation fixtures receive 400; 5 pass, 6 fail, 23 expectations on both |
| `src/app/api/pipelines/[id]/route.test.ts` | 1 | `brief-http-patch-base`, `brief-http-final`: collection/detail fixture mismatch; head adds two passing transport cases. Existing full-file tests also log a refused tick to the isolated closed port. The new filtered cases install a local tick stub and run without that diagnostic. |

Early development failures exposed invalid fixture remotes/source input, an incorrect draft-edit action, a temporary syntax error, and the mandate/scaffold byte budgets. Their fixes retain the existing limits. The delivered mandate measures 30,300 bytes before explicit account names; both envelope tests and complete stored-default upgrade/replay tests pass. The scaffold-fit tests pass without raising the 12,000-character store cap. Other inherited failures remain deferred to their owners.

## Other checks

- `bun run lint` with the 12 changed TypeScript paths, under the same gate and isolation: `brief-lint-1` and `brief-lint-final`, both exit 0; 0 errors, 6 unused-variable warnings on unchanged binding lines. The pre-commit hook repeats the staged lint and whitespace checks.
- Mandate development probes: `bun -e` importing the mandate and computing its SHA-256, later also `Buffer.byteLength(orchestratorMandateForDelivery(...))`: six executions, five exit 0 and one exit 1 for the temporary syntax error. The successful final probe reports 30,300 bytes. Scaffold probes import role defaults/renderer and measure prompt length: four executions, all exit 0, 20 development measurements across base/head. These are size diagnostics, with final correctness established by the recorded tests.
- Repeated `git diff --check`: exit 0, zero whitespace findings. Native Git header probe: exit 0, one ELF signature. Final source/export byte comparison: exit 0, 13 matching code/test/skill files, zero mismatches. Base comparison validation: exit 0, all six final failing-name sets exactly match base.

Full suites, builds and standalone typecheck were excluded by the project's stage policy. Publication runs its required gates; the full suite belongs to the nightly workflow. This stage makes no claim about future CI, merge or production acceptance.


Additional final checks:

- `bun run lint src/lib/pipelines/briefWarnings.ts` through the same wrapper: `brief-lint-helper-final`, exit 0, one file, zero errors/warnings after the parser scan simplification.
- Full touched-file privacy command: `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json LLV_PRIVACY_OCR_LANGUAGES=eng+ukr bun scripts/privacy-publication-gate.ts --require-known-values --base origin/main --paths <the 14 changed paths>`. `brief-privacy-1`, exit 0, `PRIVACY GATE: PASS`, zero findings. Later source/report edits receive a final scan of their whole files before the commit.

The exact TypeScript lint arguments were:

```sh
bun run lint 'src/app/api/pipelines/[id]/route.test.ts' \
  'src/app/api/pipelines/[id]/route.ts' src/app/api/pipelines/route.ts \
  src/lib/mcp/bindings.ts src/lib/mcp/pipelineRoleFence.test.ts \
  src/lib/orchestrator/prompt.test.ts src/lib/orchestrator/prompt.ts \
  src/lib/pipelines/engine.ts src/lib/roles/defaults.ts \
  src/lib/pipelines/briefAdmission.test.ts src/lib/pipelines/briefWarnings.test.ts \
  src/lib/pipelines/briefWarnings.ts
```


Final whole-file renewal: `bun scripts/privacy-publication-gate.ts --require-known-values --base origin/main --paths src/lib/pipelines/briefWarnings.ts evidence/brief-fences/verification.md`, with the fingerprint/OCR environment above: `brief-privacy-final-files`, exit 0, two files, zero findings. The report-only read-back scan uses the same command with the report as its sole path. Final commit-hook and commit-publication receipts are included in the stage completion handover.


## Publication repair

The initial publication stopped at the full type check with TS2769 in `src/lib/pipelines/briefWarnings.test.ts:63`. The helper input was cast to `Pipeline`, while the identity assertion retained the narrower fixture type. The repair binds that typed input once and compares the returned reference against it. The identity assertion and all 38 test expectations remain intact; the repair changes no application source.

The branch merged main's stage-panel fixture correction at `f9571ba01c01a06065f177658bfed628a7f4bbd1` with a merge commit, preserving the accepted implementation and its initial base. All three ancestry checks (`git merge-base --is-ancestor` for the initial base, accepted implementation and origin/main against HEAD) exit 0. The repair itself changes one test. During verification, main advanced to `aae7208f2d0d67e0b4fc176188bf055e0fbd7bc2` (merge-queue withdrawal); that update was also merged unchanged and the resulting compiler inputs were checked again.

`REPAIR_ROOT` below names the stage's `brief-publication-repair` scratch root. Each row ran through the controller's installed gate, with a fresh HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR, closed loopback control URL and native Git first in PATH:

```sh
env REPAIR_ROOT="$ROOT" REPAIR_TREE="$tree" LLV_OWNED_RUN_TIMEOUT_MS=1200000 \
  bash "$GATE" --record "$TMPDIR/$log.log" \
  bash "$ROOT/run.sh" $arguments
```

The script executes `bun $arguments` in its selected export. Types use `bun x tsc --noEmit`, the `bunx tsc --noEmit` command used by publication. Each recorded run was reconciled once through `wait_for_check`, through terminal cleanup.

| Log | Tree | Arguments | Exit | Counts |
| --- | --- | --- | ---: | --- |
| repair-types-base | merged main plus accepted implementation, before repair | `x tsc --noEmit` | 2 | One TS2769 diagnostic, reproducing the refusal; two overload explanations |
| repair-brief-tests | repaired export | `run test src/lib/pipelines/briefWarnings.test.ts` | 0 | 19 pass, 0 fail, 38 expectations |
| repair-types-head | repaired export | `x tsc --noEmit` | 0 | Full project check, zero diagnostics |
| repair-types-current-main | repaired export plus main through `aae7208f` | `x tsc --noEmit` | 0 | Full project check, zero diagnostics |

The merged and repaired exports share the exact installed dependency graph read-only. The repaired test file was compared byte-for-byte with the delivery worktree after checking: exit 0, one matching file, zero mismatches. The comparison remains valid through this report-only update. Raw repair logs and the input digest are retained in the private stage evidence under `brief-checks/publication-repair/`. Commit hooks and the final `bun run privacy:check` receipt are handed over with the repair; the controller owns the publication retry and its remaining checks.


Repair commit hooks: `git commit -F <stage message file>` exited 0, checking one TypeScript file with zero lint errors and zero whitespace findings. The two repaired files passed the whole-file privacy scan (exit 0, zero findings); `bun run privacy:check` passed after the repair commit (exit 0, zero findings). The final compiler recheck above followed integration of the newer main and retained the same repaired test bytes. The subsequent documentation-only commit retains those compiler/test results and repeats the commit and publication privacy checks. The worktree handover includes the actual terminal receipts.
