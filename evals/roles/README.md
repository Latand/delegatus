# Role prompt pilot harness

`pilot.v1.json` fixes the three synthetic cases, their A/B/C order, model requests, fixture commits, public file fences, and commitments for sealed regression and holdout material. Its opaque commitments are publishable; the sealed inputs remain outside candidate workspaces and this repository history.

The runner never calls a model, starts a worker, or retries a dispatch. `plan` only exports one root-owned Viewer request after model identity evidence admits the exact requested model and effort and root supplies the exact harness head. Root persists the request id and payload digest before using Viewer `spawn_agent`, then reads the original receipt on every uncertain outcome. `ingest` rejects identity or model drift. `score` makes an unrun, unreviewed, head-drifted, or forbidden-file candidate fail or remain incomplete.

Run under an isolated environment:

```sh
LLV_STATE_DIR="$PWD/.role-eval-state" HOME="$PWD/.role-eval-home" XDG_CONFIG_HOME="$PWD/.role-eval-xdg" TMPDIR="$PWD/.role-eval-tmp" bun scripts/role-eval.ts validate
LLV_STATE_DIR="$PWD/.role-eval-state" HOME="$PWD/.role-eval-home" XDG_CONFIG_HOME="$PWD/.role-eval-xdg" TMPDIR="$PWD/.role-eval-tmp" bun scripts/role-eval.ts prepare .role-eval-workspace
```

The harness is reviewed separately from the pilot. Its resulting state is **harness reviewed; real pilot pending**. The canonical evaluation task remains incomplete until root has run and scored all admitted cells, recorded the calibration review-fix-review cycle, and obtained an independent exact-head review of the results.
