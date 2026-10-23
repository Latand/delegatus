# Nightly release leftovers

Rechecked on 2026-10-23 against main at `134a29c6`, then `faf57185`. The later
scanner/controller delta leaves the classifications and changed files untouched.
The continuation of the
post-release audit retains items 6, 11, 13 and 14 from issue #1999. Closing the
issue was insufficient evidence; the classifications below follow executable
entry points and regressions.

| Item | Result | Evidence |
| --- | --- | --- |
| 6. Findings held by a quota-exhausted flow implementer | **done-before** | S5 retired flow execution in #3181. `assertFlowExecution` refuses the legacy relay, recovery and persistence entry points; native pipelines own new fix stages. Restoring an alternative-engine legacy relay would restore retired execution. |
| 11. Phone link labels split inside words | **done-now** | Shared markdown anchors prefer word boundaries and allow emergency wrapping for unbroken URLs and paths. The existing phone driver checks readable labels, bare URLs, full URL labels and file links at 360, 390 and 430 px, en/uk, light/dark. |
| 13. Expanded reviewer-note cap and manual flow verdict adoption | **done-before** | `FLOW_RETIRED` and `STAGE_KIND_RETIRED` refuse new execution, restart, graph-copy and manual-action paths. Historical verdicts remain archive data. Native run stages carry their own reports and preserve oversized prompts through private prompt files; they do not use the legacy 2,000-character note transport. |
| 14. Old implementer publishes after approval | **done-now** | Stage preparation atomically transfers a worktree's Git ownership fence to its successor, including review stages. Old bindings refuse branch updates and pushes, including commits with `--no-verify`. Ownership is checked again on every successful hook exit, including when no repository hook runs. A fresh fix stage receives a new binding; the pipeline's review graph still controls its review. |

**left:** tags, releases, package publication and deployment require their own
publication stage. The broader finished-host retirement work in #3268 and the
remaining flow UI/engine removal stay with their existing lanes.

## Ownership contract

`prepareStageGitGuard` is the writer. Its existing two environment bindings
continue to identify the attempt receipt and worktree. `start.json` additionally
records the previous owner. Preparation requires a callback that revalidates
the durable activation after the initial Git-directory lookup and under the
claim lock before handoff. This prevents a delayed preparation from adopting
a successor as its predecessor. Replay can finish an interrupted claim but
cannot reclaim a superseded one. Receipt settlement reads the existing fields
and ignores the additional field.

Each worktree's own Git directory holds one owner file, published with Git's
exclusive lock-file and rename convention. Its lifetime follows that Git
directory. A conflicting claim fails without waiting; a failed write retains
the previous owner and removes only its own temporary lock. No synchronous
shared-resource wait or performance gain is introduced.

The generated `stageAttemptGuardScript` reads the receipt's owner binding for
lane mutations. `agentHistoryGuardEnv` retains the existing environment-copy
contract and rechecks the fence on every successful mutation exit while
preserving its arguments, input and refusal. Unrelated repositories keep their own hooks.
Controller publication uses `pipelinePublicationHookEnv`, which removes stage
bindings, and continues to publish the accepted commit through its own gate.
The real-Git publication and recovery suites cover those consumers, including
successor attempts, receipt ancestry and explicit repair.

This remains the existing cooperative Git-hook boundary. A command that
explicitly replaces the hook configuration or skips the push hook can bypass
it; this change does not add shell confinement. Stale locks after a process
dies inside a handoff fail closed under the usual Git lock-file convention.

## Rendered record

`evidence/phone-markdown-links/geometry.json` records the source digests, frame
names and character-range measurements. The case freezes its clock before
loading the fixture. The complete answer opens at the feed's bottom with page
focus; every link is visible together. Ordinary labels must have no split
words; every link must have zero clipped and zero covered characters.

The existing phone driver reproduces the frames with:

```sh
gate-remote --get evidence/phone-markdown-links/geometry.json \
  --get .artifacts/phone-markdown-links -- \
  env LLV_SWIPE_BROWSER_TEST=1 bun run test \
  src/components/mobile/issue1671Evidence.browser.test.tsx -t 'phone markdown links'
```

## Verification

All heavy commands use `gate-remote` and isolated home, config, temp and state
roots, with the Viewer control URL on a closed port. Explicit test files are
selected throughout. The stage report records each command and exit code.

- The base stylesheet fails the new wrapping case with a split ordinary word.
- The base Git guard allows the stale producer's commit and push and permits
  a restarted preparation to reclaim the worktree. The new regressions fail.
- The final guard refuses stale mutations before effects, preserves repository
  hook input and arguments, and allows an explicitly admitted successor.
- Disk-exhaustion probes at binding write and owner publication retain the
  previous owner and permit retry. A successor admitted during either the
  Git-directory lookup or starting-head read retains commit and push authority.
  Re-preparation is also checked in a fresh process.
- Direct importer test files cover the guard and pipeline activation wiring,
  along with Git-hook forwarding and flow-retirement regressions.
- Real-Git probes transfer ownership during the guard’s own commit and push
  work, with absent, self-forwarding and already-chained repository hooks.
  Each stale command refuses before either ref changes.
- TypeScript, touched-file ESLint, whitespace and the repository privacy gate
  are required before the hooks-enabled stage commit.

## Guard verification

Checked on 2026-10-23 against the stage-entry guards at `4d755e42`.
All test commands ran through `gate-remote`, with isolated home, configuration,
temporary and state directories. Files were selected explicitly.

- TypeScript: `bun node_modules/typescript/bin/tsc --noEmit --incremental false`
  exited 0 on the final source.
- ESLint on the eight touched TypeScript files exited 0, with five warnings
  on unchanged lines. The hooks-enabled source commit also passed staged
  whitespace, trusted-fingerprint privacy and ESLint.
- The importer selection resolves static and literal dynamic imports of
  `src/lib/git/agentHistoryGuard.ts`, `src/lib/git/stageAttemptGuard.ts`,
  `src/lib/pipelines/engine.ts` and `src/lib/pipelines/engine.fixture.ts`,
  including relative, alias, type and `require` imports. Adding the existing
  history-hook regression file gives 99 files. The completed run recorded
  `RAN_COUNT=99`, with 99 distinct file results and no missing selection.
- The complete final `src/lib/pipelines/stageAttemptPush.test.ts` passed.
  It covers absent, self-forwarding, already-chained and ordinary repository
  hooks, both preparation lookup races, successor commit/push authority,
  interrupted preparation replay and disk-write refusals.
- The final regression file against the entry guards produced seven expected
  failures and one pass: the previously covered starting-head race already
  refused. The new first-lookup and six successful-exit cases exposed the
  handed defects.
- Five additional Git identity, forge-credential, shell-policy, runtime-identity
  and isolation files passed. These and the importer selection cover 104
  distinct test files.
- All 29 initially red files were run whole on the entry revision. The
  follow-up batch recorded `RAN_COUNT=37`, including final checks and the
  negative control. A further 20 complete file runs checked canonical
  isolation and alternated head/base observations; `RAN_COUNT=20` matched
  the expected count.

Canonical isolation uses every directory variable from `isolatedEnvironment`
in `scripts/local-gate.ts`, its closed control URL and the neutral controller
Git identity. With those inputs, the Git, controller-pass and stage-account
binding files passed on both revisions. The normal parked-publication wrapper
and its isolated child mode also passed on both. Its initial wrapper run had
reached the existing 120-second child-process bound; no bound or assertion was
changed. Spawn-silence passed in two fresh whole-file runs per revision.

The failures retained in the comparison were also observed on the entry
revision, in the files below. The CPU-spacing assertion had passing and failing
whole-file observations on both revisions. Two fresh head recovery runs retained
only the same two held-activation assertions seen on entry; the eight extra
initial head failures did not recur. Entry recovery also showed other variable
failures. The role-memory file retained a matching child-teardown diagnostic.
These results remain verification notes outside the two handed guard defects.

- `src/app/api/pipelines/route.busy.test.ts`
- `src/components/BranchPane.spawn.dom.test.tsx`
- `src/lib/lifecycle/projector.test.ts`
- `src/lib/mcp/pipelineBusyAdmission.test.ts`
- `src/lib/mcp/pipelineRoleFence.test.ts`
- `src/lib/mcp/retryStageLaunch.integration.test.ts`
- `src/lib/memory/roleLane.test.ts`
- `src/lib/pipelines/backgroundTaskSettlement.test.ts`
- `src/lib/pipelines/engine.activation.test.ts`
- `src/lib/pipelines/engine.cpuAdmissionPolling.test.ts`
- `src/lib/pipelines/engine.recovery.part2.test.ts`
- `src/lib/pipelines/engine.routing.test.ts`
- `src/lib/pipelines/engineConnectionRefusal.test.ts`
- `src/lib/pipelines/remoteActions.test.ts`
- `src/lib/pipelines/severedStageRetry.test.ts`
- `src/lib/pipelines/severedTurnResume.test.ts`
- `src/lib/pipelines/stageCommitRepair.test.ts`
- `src/lib/pipelines/stageCompletion.test.ts`
- `src/lib/pipelines/stageHostGenerationClose.integration.test.ts`
- `src/lib/pipelines/stageHostTeardown.test.ts`
- `src/lib/pipelines/stagePublicationRepair.test.ts`
- `src/lib/pipelines/stageSizing.test.ts`
- `src/lib/pipelines/stageVerdictRequest.test.ts`
- `src/lib/projects/succession.test.ts`

Native queue integration requires an explicit test binary; real pipeline-host
access requires subscription authentication in its isolated test home. Those
opt-in cases kept their normal skips, as did already-retired flow cases.
Real Git commit/push probes and the non-authenticated identity/policy suites
passed.

Main advanced during verification to `800a26eb`, adding memory-cap and
producer-repair changes in two touched files. The prospective merge was clean
and retained both activation callbacks. In a disposable export of combined tree
`db7ee535fe1851bac1b1fcf8ebc31ad38872d94f`, the same TypeScript command exited 0
and the complete `src/lib/pipelines/publicationRecovery.test.ts` passed all 113
tests with 2,238 assertions. Both commands used `gate-remote` with canonical
isolated roots. The assigned branch was left unmerged.
