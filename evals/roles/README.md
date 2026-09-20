# Role prompt pilot harness

This versioned, synthetic dataset has three materialized fixture families and nine fixed A/B/C cells. `prepare` creates deterministic local Git bases, candidate-only workspaces, and executable public controls. A correct control exits successfully; defective and seeded variants deliberately fail. Candidate workspaces never contain graders, holdouts, sibling candidates, or the B brief for A/C.

Sealed grader and holdout packages are deliberately external to this public repository. Their directory-byte commitments are in the manifest. Give `prepare` a private sealed root only at root-managed evaluation time; it verifies the commitments in place and never copies their bytes or history into candidates.

`plan` exports, but never dispatches, one exact `spawn_agent` payload. Root must persist its returned intent before invoking Viewer, use the canonical task id and parent conversation id, and recover uncertain outcomes only under the original client request key. Unsupported or unresolved models remain blocked. The payload supplies the identical task/shared constraints to every arm; only B appends a frozen, no-code planner brief. The prompt bars history, sibling, hidden-grader, holdout, and prior-candidate searches.

`score` consumes receipt-bound evidence rather than caller-provided pass booleans. It requires public and sealed grader records, forbidden-action audit, final-head independent approval, and desktop plus phone pixel/geometry inspection for the UI fixture. Missing evidence cannot pass. Measurements use `role-eval.result.v1`: stage/round records keep provider versus tool/build timing separate, record missing usage/cost as `unknown`, and pin role/runtime/dependency/browser hashes. They do not sum overlapping categories.

Run only in an isolated environment:

```sh
LLV_STATE_DIR="$PWD/.role-eval-state" HOME="$PWD/.role-eval-home" XDG_CONFIG_HOME="$PWD/.role-eval-xdg" TMPDIR="$PWD/.role-eval-tmp" bun scripts/role-eval.ts validate
LLV_STATE_DIR="$PWD/.role-eval-state" HOME="$PWD/.role-eval-home" XDG_CONFIG_HOME="$PWD/.role-eval-xdg" TMPDIR="$PWD/.role-eval-tmp" bun scripts/role-eval.ts prepare .role-eval-workspace
LLV_STATE_DIR="$PWD/.role-eval-state" HOME="$PWD/.role-eval-home" XDG_CONFIG_HOME="$PWD/.role-eval-xdg" TMPDIR="$PWD/.role-eval-tmp" bun test evals/roles
```

The harness has simulated checks only. Root still owes nine fresh, sequential Viewer trials, a real review-fix-review calibration, sealed grading, a per-case report with denominators, and an exploratory-only recommendation. No trial has run and no routing default may change from this harness alone.
