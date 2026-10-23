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
| 14. Old implementer publishes after approval | **done-now** | Stage preparation atomically transfers a worktree's Git ownership fence to its successor, including review stages. Old bindings refuse branch updates and pushes, including commits with `--no-verify`. Ownership is checked again after repository hooks. A fresh fix stage receives a new binding; the pipeline's review graph still controls its review. |

**left:** tags, releases, package publication and deployment require their own
publication stage. The broader finished-host retirement work in #3268 and the
remaining flow UI/engine removal stay with their existing lanes.

## Ownership contract

`prepareStageGitGuard` is the writer. Its existing two environment bindings
continue to identify the attempt receipt and worktree. `start.json` additionally
records the previous owner, so replay can finish an interrupted claim but
cannot reclaim a superseded one. Receipt settlement reads the existing fields
and ignores the additional field.

Each worktree's own Git directory holds one owner file, published with Git's
exclusive lock-file and rename convention. Its lifetime follows that Git
directory. A conflicting claim fails without waiting; a failed write retains
the previous owner and removes only its own temporary lock. No synchronous
shared-resource wait or performance gain is introduced.

The generated `stageAttemptGuardScript` reads the receipt's owner binding for
lane mutations. `agentHistoryGuardEnv` retains the existing environment-copy
contract and rechecks the fence after the repository hook while preserving
its arguments, input and refusal. Unrelated repositories keep their own hooks.
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
  previous owner and permit retry. A successor admitted during the starting
  head read retains ownership. Re-preparation is also checked in a fresh process.
- Every direct markdown and stage-guard importer test file is selected, along
  with Git-hook forwarding and flow-retirement regressions.
- TypeScript, touched-file ESLint, whitespace and the repository privacy gate
  are required before the hooks-enabled stage commit.
