# Delivery succession verification

To continue a closed lane's PR, create a successor with the same delivery branch, remote and PR. Closing releases the delivery claim while host cleanup keeps its own custody. A running or uncertain publisher retains its fence until reconciliation. A completed comparison can request takeover of its closed owner's target, then publish its passed head. Refused or superseded takeover leaves an actionable park and a lifecycle event; a newer pause is preserved.

Verified on 2026-11-12 UTC with Bun 1.4.0. Initial main was `dfc99dce253fe29148b70d5840bf903cd1e47c19`. Main advanced to `34b741354731f3c63cc2531c6fee12b1dcd2f911`; its changes did not overlap the delivery code. The lane fast-forwarded before the final acceptance and store runs. The tested source files were compared byte-for-byte with the lane before committing.

## Commands and isolation

`GATE` below is the controller-provided installed `scripts/gate-slot.sh`. `TMPDIR` is the stage's assigned scratch root. Each table row ran one explicit file in a scratch export; `main-export` contained main plus the regression file, and `head-export` contained main plus the fix. No test ran in the delivery worktree or against live state.

The command for each test row was the following, substituting its export, sandbox, log and file columns. The diagnostic row additionally supplied `-t "parks a progressing"`. Rows marked `300s` set `LLV_OWNED_RUN_TIMEOUT_MS=300000` on the wrapper; earlier runs used its default. `bun run test` expands to `bun test --timeout=60000`. Recorder launch status is separate from the command exit reported here: each recording was reconciled once with `wait_for_check` through cleanup.

```sh
cd "$TMPDIR/$export"
bash "$GATE" --record "$TMPDIR/checks/$log.log"   env HOME="$TMPDIR/$sandbox/home"   XDG_CONFIG_HOME="$TMPDIR/$sandbox/config"   TMPDIR="$TMPDIR/$sandbox/tmp" LLV_STATE_DIR="$TMPDIR/$sandbox/state"   LLV_GATE_RUNNER=off bun run test "$file"
```

File abbreviations in the table:

- S: `src/lib/pipelines/deliverySuccession.test.ts`
- D: `src/lib/pipelines/store.test.ts`
- R: `src/lib/pipelines/remoteActions.test.ts`
- L: `src/lib/lifecycle/projector.test.ts`

All pass/fail counts below are tests. E is the number of `expect()` calls. Development runs remain recorded, including failures corrected before final verification.

| Log | Export | Sandbox | File | Limit | Exit | Pass / fail | E |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| base-succession | main-export | base-run | S | default | 1 | 0 / 4 | 63 |
| head-succession-1 | head-export | head-run | S | default | 1 | 2 / 2 | 77 |
| head-diag | head-export | diag-run | S, filtered | default | 1 | 0 / 2; 2 filtered | 30 |
| head-succession-2 | head-export | head-run-2 | S | default | 0 | 4 / 0 | 83 |
| head-succession-3 | head-export | head-run-3 | S | default | 1 | 3 / 8 | 71 |
| head-succession-4 | head-export | head-run-4 | S | default | 0 | 11 / 0 | 106 |
| head-store | head-export | store-run | D | default | 1 | 60 / 1 | 376 |
| base-store | main-export | base-store-run | D | default | 0 | 61 / 0 | 382 |
| head-store-2 | head-export | store-run-2 | D | default | 0 | 61 / 0 | 383 |
| head-remote | head-export | remote-run | R | default | 1 | 1 / 39; 1 runner error | 39 |
| base-remote | main-export | base-remote-run | R | default | 1 | 1 / 39; 1 runner error | 39 |
| head-succession-5 | head-export | head-run-5 | S | 300s | 0 | 15 / 0 | 178 |
| head-projector | head-export | projector-run | L | 300s | 1 | 7 / 1 | 29 |
| base-succession-final | main-export | base-run-final | S | 300s | 1 | 8 / 7 | 156 |
| base-projector | main-export | base-projector-run | L | 300s | 1 | 7 / 1 | 29 |
| head-succession-final | head-export | head-run-final | S | 300s | 0 | 16 / 0 | 194 |
| base-succession-exact-final | main-export | base-run-exact-final | S | 300s | 1 | 9 / 7 | 172 |
| integrated-succession | head-export | integrated-run | S | 300s | 0 | 16 / 0 | 194 |
| current-main-succession | main-export | current-main-run | S | 300s | 1 | 9 / 7 | 172 |
| integrated-store | head-export | integrated-store-run | D | 300s | 0 | 61 / 0 | 383 |

`integrated-*` and `current-main-*` use refreshed main. Earlier rows use the initial main and the development source present for that run. Failed development runs identified a matcher that mutated its argument, fixture IDs reused across tests, incomplete closed fixture cursors, and the previous ownership assertion. Final fixtures use label-derived IDs and fixed clocks.

## Final acceptance

The final regression file fails seven cases on refreshed main and passes all 16 after the fix. Its first case calls close on the owner, creates a successor through the production creation API with the same delivery target and PR, passes its stage, then reads the private bare remote to prove the successor commit reached the original delivery branch. The completed-comparison case settles takeover in a fresh controller process and publishes the existing passed head without a new agent attempt.

The remaining cases cover pending takeover holding the pass boundary; owner, epoch, hidden/closed lane, verdict, accepted-head and running-writer refusals; lock refusal; failed/superseded takeover events; and a newer pause, owner epoch or accepted head arriving across an awaited remote probe.

The store suite's original pending-close assertion passed on main and failed after the behavioral change. It now expects the delivery claim to be released and still requires pending host cleanup to prevent archival. All 61 store cases pass.

## Existing failures

The ordered outcomes of all 40 remote-action cases match between base and head: 1 pass, 39 fail and one runner error. Those fixtures use retired `review-loop` stages; six cases time out at the runner's per-test bound. The lifecycle file likewise matches base and head: 7 pass, one pause/resume failure caused by the retired fixture. These suites were compared in fresh isolation, and their unrelated fixture repairs are outside this change.

## Other checks

The first lint command used the same recorded wrapper and isolated environment, log `head-lint`, sandbox `lint-run`, execution limit 300 seconds:

```sh
bun run lint src/lib/pipelines/store.ts src/lib/pipelines/store.test.ts   src/lib/pipelines/engine.ts src/lib/pipelines/deliverySuccession.test.ts   src/lib/lifecycle/projector.ts
```

Exit 0: five files, no diagnostics. After extending the regression file, `bun run lint src/lib/pipelines/deliverySuccession.test.ts` ran directly in the scratch export, log `head-lint-final`: exit 0, one file, no diagnostics. ESLint is the project's lint script; the direct invocation was a focused lint check.

`git diff --check` ran after edits and at final source verification: exit 0, no whitespace errors. Comparing the five changed TypeScript files with the tested export found five identical files. Comparing normalized ordered base/head outcomes found 40 matching remote-action outcomes and eight matching lifecycle outcomes.

The publication privacy gate scanned all six changed paths in the scratch export, with its own HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, log `privacy-paths`: exit 0, `PRIVACY GATE: PASS`, zero findings. The command was:

```sh
LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json \
  bun scripts/privacy-publication-gate.ts --base origin/main --require-known-values \
  --paths src/lib/pipelines/store.ts src/lib/pipelines/store.test.ts \
  src/lib/pipelines/engine.ts src/lib/pipelines/deliverySuccession.test.ts \
  src/lib/lifecycle/projector.ts evidence/delivery-succession/verification.md
```

The plain delivery-worktree commit ran the installed project hooks: exit 0; staged whitespace and changed-file ESLint both passed, covering five TypeScript files with zero introduced errors and zero base errors. The stage handoff additionally records the final commit-range publication privacy check (`--check-commits --added-lines`).

Full-project typechecking, builds and the full suite belong to the pipeline's publication hook under the stage policy. This stage runs no push. The publication stage owns PR creation. This board task supplies no GitHub issue to close, so the handoff requests no issue-closing directive.
