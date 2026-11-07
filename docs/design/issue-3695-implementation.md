> “The base fetch and the remote reads bound their run time without depending on a GNU-only executable”
>
> Public requirement excerpt, 2026-11-05T16:36:24Z, [issue #3695](https://github.com/Latand/delegatus/issues/3695), Expected behaviour.

# Portable deadlines for pipeline provisioning

## Decision and scope

Replace five external `timeout` invocations with the deadline already provided by `realExec` and `realProvisionExec`. Change the publication fence's command recognizer in the same implementation. Keep the existing Git arguments, result classification, cancellation precedence and delivery ownership rules. Add no executor, dependency, configuration switch or fallback to unbounded execution.

This document plans source work only. It does not establish native macOS acceptance, merge readiness, deployment success or installed acceptance. The architecture stage changes this document alone. The later implementation remains on its assigned branch, under normal hooks, followed by three independent review rounds and the terminal recheck required by the task.

## Observed inputs

Observations were made on 2026-11-06, with a final source/requirement check at approximately 20:54 UTC. The assigned HEAD and the forge's main both remained `423bf964ed98d9dde744ad0f2c4f2dbf92ae146b`. The issue was open, last updated at its creation time, and both its comment count and the complete paginated comments endpoint returned zero comments.

The primary intake at `b728d185`, `docs/audits/recent-issue-intake-2026-11-06.md`, and the primary followthrough message timestamped 20:32:26.657 UTC identified five wrapper calls and the publication recognizer. Current source confirms those locations. These earlier records supplied hypotheses and ownership information; the probes below supply this stage's observations.

| Current location | Producer and consumer | Existing bound |
| --- | --- | --- |
| `src/lib/pipelines/git.ts:229` | `resolvePipelineBase`, used by pinned request paths and direct callers | Base fetch, 60 seconds |
| `src/lib/pipelines/git.ts:292` | `resolvePipelineBaseAsync`, called from controller provisioning outside the registry mutation | Base fetch, 60 seconds; forwards its AbortSignal |
| `src/lib/pipelines/git.ts:1790` | Private `readRemotePipelineBranch`; current-head reads, publication preflight, confirmation and recovery | Remote read, 5 seconds |
| `src/lib/pipelines/git.ts:2041` | `publishPipelineBranch`'s fenced executor classifies the preceding reader | Identifies the wrapped remote read after a dispatched write |
| `src/lib/pipelines/stageBranch.ts:111` | `observeStageBranchProtection`, before settlement | Remote branch existence, 5 seconds |
| `src/lib/pipelines/stageBranch.ts:114` | Same observer, after a nonempty existence answer | Forge protection lookup, 5 seconds |

`ProvisionExecPort` already accepts `timeoutMs`, environment overrides and inherited descriptors. `realProvisionExec` forwards those to `realExec`. The latter uses a detached process group on POSIX, sends SIGKILL to that owned group, drains pipes through `close`, and then removes its timer, abort listener and CPU-wait ledger. It returns the real signal and preserves a null exit status for stopped commands. It writes only its execution-budget ledger; the provisioning and publication consumers own their separate state effects.

The deadline measures execution time with existing CPU admission waits excluded. A direct Git fetch/read normally creates no such wait. This change must make no new unconditional wall-clock guarantee and must not alter admission accounting globally. Windows currently kills the direct child; this lane makes no new Windows descendant-cleanup claim.

## Reproduction before design

A tracked export of the assigned HEAD ran under Bun 1.4.0, through the prescribed owned gate runner, with separate HOME, config, state and temporary directories, the Viewer control URL on closed port 1, and remote gate execution disabled. Native Git created an isolated local bare remote and fixture repository. No live service, network Git target or existing pipeline was exercised.

The child PATH contained only native Git, with explicit PATH-scoped lookups proving both `timeout` and `gtimeout` absent. Both real base resolvers failed with `fetching origin/main: Executable not found in $PATH: "timeout"`. A pinned base resolved successfully. The identical real fetch invoked through `realProvisionExec` with `timeoutMs: 60000` succeeded. These are observations of the real resolver and executor, not a complete `create_pipeline` controller test.

A separate probe drove `currentPipelineRemoteBranchHead` with real Git and a local hanging SSH transport helper. At the injected exec seam, only the external wrapper was translated to the existing native deadline, shortened to 150 ms. Git and the helper recorded their PIDs. The executor returned `{ code: null, signal: "SIGKILL" }` with `command timed out after 150ms`; the consumer retained its existing bounded-remote-read diagnosis. Both recorded PIDs were absent before the assertion completed, while an independently started sentinel remained alive. The harness then stopped and awaited its own sentinel. The consumer's displayed five-second production bound was unchanged; the 150 ms probe is mechanism evidence, not a measurement of that production interval.

Direct deadline and abort probes also returned the existing SIGKILL/null-status shape; their diagnostic strings differed as expected. The two successful probe commands ran one explicit scratch test file each: two tests/22 assertions and one test/six assertions, both exit 0. An earlier harness attempt failed because `Bun.which` without an explicit PATH used the startup search path; that failed run is retained and supplies no missing-utility proof.

Private evidence under the stage evidence directory includes `baseline-probe.log`, `baseline-probe-v2.log`, `transport-probe.log`, their exit records, both probe sources and launchers, and the primary public requirement snapshot. This document deliberately contains no machine paths or process identifiers. No native Darwin test or final implementation test ran here.

## Exact implementation changes

1. In `git.ts`, replace the two base-fetch wrappers with `exec("git", ["fetch", "--no-tags", "origin", refspec], ...)`. For `ExecPort`, supply `undefined` as environment and the timeout in argument five. For `ProvisionExecPort`, preserve the signal in argument four and supply the timeout in argument five. Derive milliseconds from the existing 60-second constant, retaining the displayed `60s` diagnostic and the existing in-flight age calculation.
2. In `readRemotePipelineBranch`, invoke `git` directly with the existing `ls-remote --heads` target and the five-second timeout in `ExecOptions`. Keep the local-only shortcut, empty-remote result, SHA handling and `failure(step, result)` behavior. Update its Linux-only wrapper comment. Retain `killedAtBound`'s 124, 137 and SIGKILL compatibility; update its explanation without changing its result predicate.
3. In the fenced executor, recognize the direct bounded `git ls-remote` request instead of the old wrapper prefix. Include the five-second option and expected argument form in the predicate. Keep the target supplied by the persisted delivery record, the `writeStarted` condition and all existing authority/owner/epoch checks. Forward options through to the actual executor, including the existing inherited lock descriptor and additional descriptors. The read exception must never authorize a push, fetch, install or checks command.
4. In `stageBranch.ts`, call direct `git ls-remote` and direct `gh api` with `{ timeoutMs: 5000 }` in the fifth `ProvisionExecPort` argument and `undefined` in the signal position. Preserve branch/head-pinned observations, no-remote/local-remote behavior, unpublished-branch handling, protected-branch refusal, and fail-closed handling of missing, malformed or failed forge responses.
5. Update direct test adapters that recognize the old wrapper or reconstruct its argument positions. Every forwarding adapter must pass the original environment, signal, timeout and descriptors. Replace the three GNU-backed worktree-interruption fixtures in `git.test.ts` with the existing executor's deadline while retaining all their checkout-preservation assertions. Update the real resolver interruption fixture and publication race/transport interceptors too; a stale interceptor can silently stop injecting its failure.

The two production files are the complete production edit scope. `src/lib/workflows/provision.ts`, `engine.ts`, `types.ts`, stores, schemas, runtime-host code, deployment scripts and workflows remain read-only. A newly demonstrated defect in the shared executor requires sequencing with its owner and a revised scope before implementation.

## Shared changes and sequencing

All current open PR file lists were inspected. The only published overlap in the three production paths was [PR #3668](https://github.com/Latand/delegatus/pull/3668), head `25783bad3409d324eba222159b60dde76820235b`. Its actual Git hunks add prepared-integration checkout validation, read-only output staging handling and failed-push remote reconciliation. They leave the five wrappers and recognizer intact. Its successor checkout was clean at `baeb2d5ee3df99be228d050fcba7b5498ee1ab64`; its `git.ts` content matched the published head.

There is a concrete semantic test dependency: #3668's new “nonzero push answer” regression injects an unreadable reconciliation result using `command === "timeout"`. Direct Git would bypass that injection. Its changed active-rejection test also requires one readback after a refused push. Both assertions belong in the combined-tree acceptance, with only the command interceptor adapted. Keep the failed-push reconciliation body unchanged.

The local #3715 implementation was inspected at `09dd2aaf61164aa583e2f3c467fb4b32a1892f4a`. At the final recheck its HEAD had advanced to `a583fe2e55d7f203e5d8cf4843bf7e628f978aaf` through task-hold changes, with no additional production-path overlap and no published PR yet. Its current uncommitted `engine.settlement.test.ts` hunk strengthens remote-refusal history, accepted-verdict and no-producer-repair assertions; retain that hunk under its owner. It changes `engine.ts`, `types.ts`, publication classification helpers and their tests; its actual diff has no `git.ts` change. Its accepted-head preservation, remote-refusal parking and producer-repair suppression remain its owner's work. The combined source must retain those consumers of this lane's error results and run the owner's updated `engine.settlement.test.ts` separately as a read-only compatibility check.

The project-scoped open-lane inventory was paginated completely: 31 lanes. Comparing available open checkouts against their merge bases found no additional production-path overlap. Three unrelated retained checkouts were absent; their live bytes were unavailable, so this is not a claim about unpublished contents of deleted directories. A wider worktree scan also found a retained refresh checkout whose relevant dirty hunks reproduce code already present in the assigned source, and a non-open historical checkout with staged removals and untracked replacements. Neither supplies an implementation to adopt.

Recommended sequence: complete this narrow adapter implementation against its assigned base, then have the existing Git owner integrate it with #3668 and adapt that owner's direct test interceptor. Recheck the actual combined diff before any merge. If another owner changes remote-read meaning, cancellation ownership or the post-push reconciliation contract, stop shared semantic work for sequencing. Do not copy the integration feature, migrate schemas or create a replacement lane. The original uncertain launch remains untouched.

The #3668 format-six compatibility transition, retained-source checks and verified rollback gates for both installations remain independently required. This portability plan neither satisfies nor waives them. No combined implementation tree was built or tested during architecture.

## Keep-list and risks

Keep exact base/ref validation, pinned-base no-fetch behavior, the async local-only branch path, no stale-base fallback after a failed fetch, and cancellation checks before further provisioning. Preserve all existing worktree ownership and interrupted-checkout validation.

Keep immutable accepted SHA publication, delivery target/owner/epoch, operation idempotency, lock custody until child closure, revocation before dispatch and after waits, unknown-outcome reconciliation, and the existing retry budget. An unreadable confirmation cannot establish non-delivery or authorize another push. Preserve raw exit/signal evidence and the existing sanitized refusal classification. Do not normalize every nonzero or null exit to a timeout. The current classifier accepts SIGKILL for several stopped-command causes; this task must not silently redefine that shared behavior.

The highest risks are a shifted options argument, a forwarding adapter that drops the bound, a stale publication recognizer, a fixture that ceases to inject its fault, and loss of the post-failure readback when #3668 integrates. Real consumer regressions, explicit invocation records and the combined-tree review address those risks. No performance improvement is claimed.

## Acceptance and per-file checks

Use fresh tracked exports or detached isolated clones when tests need Git metadata. Each test file runs in a separate owned gate command with a fresh log and actual exit status. Apply `checkEnvironment` and `isolatedEnvironment` before importing stateful modules; isolate all project state roots, pin control URL to port 1 and use native Git with inherited fixture identities cleared. Store logs outside the worktree. Run no broad suite, build or standalone typecheck in these stages; normal publication hooks retain their checks.

The command form is `bash "$GATE_SLOT" bun test --timeout=60000 <one-explicit-test-file>`, where `GATE_SLOT` is the runner supplied by the stage. Use the authorized direct-run policy, with no recorder, custody handoff or adoption of an unknown result.

| File | Required behavior and check |
| --- | --- |
| `src/lib/pipelines/git.test.ts` | Normal and advanced local remote; both resolver ports without either timeout utility; pinned base; local-only async base; invalid ref; missing Git; refusal and transport failure; true deadline and abort. Real worktree creation retains its original checkout-preservation tests. Inspect options and actual results. Run the whole file separately. |
| `src/lib/pipelines/stageBranch.test.ts` (new direct test file) | Exercise the production observer with a real local Git checkout and bounded executable forge/transport fixtures. No timeout utility; absent branch; unprotected/protected branch; missing helper; malformed answer; denial; transport failure; expiry. Confirm branch/head pinning and refusal to adopt on failed observation. Run separately. |
| `src/lib/workflows/execAsync.test.ts` | Strengthen owned-child lifecycle evidence only: timeout, cancellation before launch, cancellation while transport is running, PID absence after completion, and a surviving unrelated sentinel. Keep the existing yielding, output-limit and byte-preservation tests. Run separately. Production executor remains unchanged. |
| `src/lib/pipelines/engine.provisioning.test.ts` | Add a production-builder/controller fixture for an ordinary internal lane without a pinned base, with real provisioning exec and PATH lacking the utility. Persisted base/head and transition out of provisioning must agree with the bare remote. A pinned lane skips fetch; a failed fetch parks with its cause and starts no stage. Stub agent launch so no actual agent is started. Run separately. |
| `src/lib/pipelines/git.test.ts`, combined with #3668 | Run real publication refusal, success, lost-answer and unreadable-readback cases. Include active revocation during a dispatched push, permission refusal before dispatch, final owner/epoch replacement, and one readback after every nonzero dispatched push. Require no duplicate push and unchanged unknown state. Update the owner's stale command interceptor under that integration. |
| `src/lib/pipelines/publicationRecovery.test.ts`, combined with #3715 | Read-only regression check on the combined source: completed privacy checks followed by remote refusal retain the accepted result and avoid a false producer repair. Keep actual privacy failure decisive. Run separately; no edits to its engine recovery implementation. |

Existing engine fixture adapters already accept direct Git as well as the wrapper. Avoid broad fixture cleanup. Add only the new test's faithful forwarding adapter if necessary. For meaningful base-red/head-green proof, run each newly targeted regression against pristine base and candidate exports with identical fixtures and environment. Run complete changed files on the candidate; compare only actual candidate failures with the baseline according to project policy. A skipped, queued, interrupted or missing run supplies no pass.

Native acceptance must execute the relevant provisioning, stage-protection and owned-transport cases on actual macOS, with both utility names absent, and on Linux. Record OS, Bun version, exact tested revision, test names/counts, exits and cleanup evidence. Run the actual five-second remote bound at least once, alongside shortened deterministic lifecycle cases. Check a production-default fetch bound through the consumer with recorded forwarded options; do not change production constants for tests.

The existing `macos-identity.yml` and `macos-newcomer.yml` explicitly select other tests; dispatching either unchanged cannot prove this fix. Native execution is therefore a concrete acceptance handoff: before source merge, the controller must arrange authorized macOS execution of the named files, or explicitly extend the existing CI test selection under the workflow owner's permissions. Workflow edits and external-machine access are outside this builder's scope. Keep source acceptance pending until the matching native result exists. A Linux PATH rehearsal is insufficient. No workflow was dispatched here.

## Deferred — not currently justified

A machine-wide macOS first-run prerequisite preflight and installation guidance for genuinely missing Git/gh remain the separate onboarding scope identified by the public issue. This change removes the erroneous GNU prerequisite and preserves existing tool failures; it does not claim to complete that broader expected-behavior bullet. Generic error-schema changes, a new process framework, automatic coreutils installation, timeout/gtimeout probing, global retry changes, platform-wide process cleanup, a dedicated capture driver and UI work are excluded.

Schema-six deployment, both-installation rollback verification, hotpatches, ordinary deployment and installed acceptance remain separate. No board/forge mutation, original-operation retry, process takeover, live-state cleanup, source staging or commit is part of this architecture stage.
