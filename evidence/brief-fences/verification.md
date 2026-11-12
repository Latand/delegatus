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


## Current-main successor

On November 12, 2026, this successor fetched `origin/main` at `aae7208f2d0d67e0b4fc176188bf055e0fbd7bc2`. The inherited source was `bad7b57d10c0961546df7589b135f763949bdfac`. `git merge --no-ff --no-commit origin/main` exited 0 with “Already up to date”: existing merge commits `66bc32df90` and `c92583b9e6` already preserve current main. The final fetch and ancestry check also exited 0; no additional merge was available.

The full-file MCP run exposed a new fixture failure: its preceding case opened the process-wide agent registry, then deleted its directory while the connection remained open. The new acknowledgement case subsequently failed with an unavailable database. `src/lib/mcp/pipelineRoleFence.test.ts` now calls the existing registry cleanup helper before deleting each sandbox. All assertions remain; application source is unchanged by this successor. The new case passes both after the earlier cases and alone.

Checks ran in detached scratch exports with the identical installed dependency graph; package manifests, lockfile, Bun configuration, compiler configuration and test preload matched across base and head. Each compiler, test and lint command received fresh HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR, native Git first in PATH, no inherited spawn capability, and a closed loopback control URL. The stage worktree was used only for editing and committing. No production action or performance gain is claimed.

`GATE` below denotes the installed controller-supplied gate wrapper; `ROOT` denotes the stage-owned `brief-successor` scratch directory. The exact retained `run.sh` selects its export, installs the isolation above, records full output and the actual child exit, and executes its remaining arguments unchanged. Heavy commands ran sequentially in three recorded wrapper invocations (types, file campaign, repair/compiler/lint); each recording received one terminal `wait_for_check` reconciliation, including cleanup. Each wrapper used `LLV_OWNED_RUN_TIMEOUT_MS=1200000`.

```sh
bash "$GATE" --record "$TMPDIR/successor-types.log" bash "$ROOT/run.sh" head typecheck bun x tsc --noEmit
bash "$GATE" --record "$TMPDIR/successor-tests.log" python3 "$ROOT/campaign.py"
bash "$GATE" --record "$TMPDIR/successor-repair.log" bash "$ROOT/repair-checks.sh"
```

The file campaign invokes `bash "$ROOT/run.sh" "$tree" "$label" bun run test "$file"` once per row. Failing head files receive two full base runs in separate fresh roots. The repair script repeats the MCP file, then its filtered advisory case, then the exact publication compiler, then the twelve-path lint command already listed above. Raw command logs, exits, timestamps, source digests, scripts and reconciliation records are retained in the stage evidence under `brief-successor/`.

| File (argument to `bun run test`) | Final head exit | Passed / failed | Expectations | Base exit, twice | Base passed / failed | Base expectations |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| `src/lib/pipelines/briefWarnings.test.ts` | 0 | 19 / 0 | 38 | not needed | — | — |
| `src/lib/pipelines/briefAdmission.test.ts` | 0 | 5 / 0 | 34 | not needed | — | — |
| `src/lib/orchestrator/prompt.test.ts` | 0 | 46 / 0 | 344 | not needed | — | — |
| `src/lib/mcp/pipelineRoleFence.test.ts` | 1 | 6 / 1 | 66 | 1, 1 | 5 / 1 | 59 |
| `src/app/api/pipelines/[id]/route.test.ts` | 1 | 19 / 1 | 67 | 1, 1 | 17 / 1 | 63 |
| `src/app/api/pipelines/route.test.ts` | 1 | 5 / 6 | 23 | 1, 1 | 5 / 6 | 23 |
| `src/lib/pipelines/roles.test.ts` | 1 | 32 / 2 | 494 | 1, 1 | 32 / 2 | 494 |
| `src/lib/roles/registry.test.ts` | 1 | 22 / 1 | 153 | 1, 1 | 22 / 1 | 153 |
| `src/lib/pipelines/engineConnectionRefusal.test.ts` | 1 | 0 / 4 | 0 | 1, 1 | 0 / 4 | 0 |

Final full-file observations total **154 passes, 15 base-matching failures and 1,219 expectations across nine explicit paths**. All fifteen failing test identities match both fresh base observations. The compiler and lint are green; complete test files remain red solely for those inherited assertions. The existing closed-port tick diagnostic appears on both sides. There are zero unmatched runner errors. The same inherited failure categories listed earlier remain, with the MCP file now down to its single reporter-policy assertion. The seat owns any follow-up for those base defects.

| Additional command / procedure | Exit | Counts |
| --- | ---: | --- |
| Initial `bun x tsc --noEmit` | 0 | Full project, zero diagnostics |
| Renewed `bun x tsc --noEmit` after fixture cleanup | 0 | Full project, zero diagnostics |
| `bun run test src/lib/mcp/pipelineRoleFence.test.ts -t "MCP acknowledges"` | 0 | 1 pass, 0 fail, 6 filtered, 7 expectations |
| Twelve-path `bun run lint` command listed above | 0 | 12 files, 0 errors, 6 warnings on unchanged bindings |
| Whole-file privacy scan of all 14 inherited changed paths | 0 | `PRIVACY GATE: PASS`, zero findings |
| Whole-file privacy renewal of `src/lib/mcp/pipelineRoleFence.test.ts` | 0 | 1 file, zero findings |
| Whole-file privacy renewal of this final ledger | 0 | 1 file, zero findings |
| `git diff --check` | 0 | Zero whitespace findings |
| Final failure/log reconciliation | 0 | 9 head files; every red file matches 2 base samples; 0 new failures or unmatched runner errors |
| Code/export byte comparison | 0 | 13 code/test/skill files, zero mismatches |

The initial campaign exited 1, with 153 passes, 16 failures and 1,213 expectations over nine head files; it also ran twelve base samples. Its extra failure was the new MCP acknowledgement case described above. Its initial MCP observation was 5 passes, 2 failures and 60 expectations. The repaired full-file rerun exits 1 with 6 passes, 1 inherited failure and 66 expectations. The repair/compiler/lint wrapper exits 0, and final reconciliation classifies every remaining failure against both base runs. These development receipts remain retained.

The privacy command for each whole-file scan is `bun scripts/privacy-publication-gate.ts --require-known-values --base origin/main --paths <listed paths>`, with `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json` and `LLV_PRIVACY_OCR_LANGUAGES=eng+ukr`. The final report receives its own whole-file scan; commit-hook and post-commit `bun run privacy:check` receipts are included in the stage handoff. The controller owns remote publication, PR creation and its publication gates; the PR body must retain `Closes #3916`.

Verification evidence read-back: 2026-11-12T09:35:20Z. This documentation-only handoff retains the checked code and configuration.


## Publication refusal repair

The publication of the accepted `820b17d7` tree was refused on November 12, 2026: privacy, types and lint passed; touched tests reported six new failures, 25 pre-existing failures, two removed/skipped cases and two flaky cases. The controller retained a truncated output tail without the six new failure names. Its refused operation did not publish the branch. The focused nine-file observations above remain historical evidence for that selection, and do not establish a passing publication gate.

This repair fetched main at `2614b079b3` and merged it with the normal two-parent commit `563cd13e92`. There were no conflicts. Both `bad7b57d` and fetched main remain ancestors; all 14 accepted feature files match the accepted tree byte-for-byte. The merge adds main's seat SQLite migration. The normal commit hook checked staged whitespace and 37 TypeScript files, exiting 0 with zero introduced lint errors.

Checks used fresh HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR per command, native Git first in PATH, a closed loopback control URL and the identical installed dependency graph. They ran only in scratch exports. `GATE` is the installed controller-supplied wrapper and `ROOT` is the stage-owned `brief-publication-refusal` scratch directory. Every recorded wrapper received exactly one terminal `wait_for_check` reconciliation. The actual child exit and full output were retained separately from the wrapper's exit.

```sh
LLV_OWNED_RUN_TIMEOUT_MS=1200000 bash "$GATE" --record "$TMPDIR/refusal-recover.log" bash "$ROOT/recover.sh"
LLV_OWNED_RUN_TIMEOUT_MS=2400000 bash "$GATE" --record "$TMPDIR/refusal-full-publication.log" bash "$ROOT/run.sh" gate full-publication bun scripts/local-gate.ts pre-push
LLV_OWNED_RUN_TIMEOUT_MS=1200000 bash "$GATE" --record "$TMPDIR/refusal-targeted.log" bash "$ROOT/targeted.sh"
```

The recovery script invokes `bun run test` for the settlement and MCP server files below in sequence. The targeted script invokes the provider-reset and busy-route files on head and main, one file per fresh process. The full publication procedure is unmodified and runs without a push. Its code inputs are the committed merged tree. Outer execution allowances retain cleanup room; the project's own file and test-run budgets remain unchanged.

| Command | Tree | Actual exit | Counts |
| --- | --- | ---: | --- |
| `bun run test src/lib/pipelines/engine.settlement.test.ts` | merged head | 0 | 121 pass, 0 fail, 1,016 expectations |
| `bun run test src/lib/mcp/server.test.ts` | merged head | 0 | 103 pass, 0 fail, 2,672 expectations |
| `bun run test src/lib/pipelines/engine.providerReset.part3.test.ts` | merged head | 0 | 27 pass, 0 fail, 177 expectations |
| Same provider-reset command | main | 0 | 27 pass, 0 fail, 177 expectations |
| `bun run test src/app/api/pipelines/route.busy.test.ts` | merged head | 1 | 0 pass, 1 fail, 1 between-tests error before collection |
| Same busy-route command | main | 1 | 0 pass, 1 fail, same fixture error before collection |
| `bun scripts/local-gate.ts pre-push` | merged head | 1 | Complete procedure failed; no push attempted |
| Publication privacy phase | merged head | 0 | Zero findings |
| Publication types phase (`bunx tsc --noEmit`) | merged head | 0 | Zero diagnostics; 415 seconds |
| Publication eslint phase | merged head | 0 | Zero introduced errors; 13 seconds |
| Publication touched-test phase | merged head | 1 | 83 selected paths; head budget expired with 65 complete |
| Publication Linux backend and Linux tests | merged head | unjudged | Both stopped after touched tests failed |

The hook failed before it could produce a complete head/base comparison. Several files hit runner deadlines; late files were interrupted when the shared 15-minute head-run budget expired. The busy-route file produced no JUnit report. Its direct head/base runs both fail while creating the caller transcript because the effective fixture transcript directory is absent. The provider-reset file's 26 assertions that failed in the concurrent hook sample all pass in its separate complete-file head and base runs. These observations do not establish that every remaining hook failure is inherited or fixed.

The hook also printed surviving-owned-process diagnostics. A subsequent read of all 23 exact recorded process/start identities found none still alive; zero processes were stopped by this repair. This reconciles the reported identities after terminal cleanup and does not turn the failed gate into a pass.

The unchanged pre-push procedure remains red. This repair has not established publication acceptance. Finishing it requires a separate investigation of the shared test-runner budget/diagnostics and inherited fixture setup; no gate, hook, timeout policy or accepted feature file was changed to obtain a pass. Raw procedures, manifests, source preservation proof, full logs, command exits, terminal receipts and process-identity reconciliation are retained under the stage evidence directory `brief-publication-refusal/`. No performance gain is claimed.
