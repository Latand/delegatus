# Stage test guidance

## Emitter inventory at the starting commit

The audit for #2860 found these instructions before changing assembly:

| Emitter | Guidance | Disposition |
| --- | --- | --- |
| `src/lib/pipelines/prompts.ts:105` | Every run stage receives `bash scripts/gate-slot.sh bun test <file>`. | Resolve the installed wrapper during server assembly; use the project's test command. |
| `src/lib/roles/defaults.ts:291` | The merger scaffold names `scripts/gate-slot.sh`. | Refer to the assembled gate guidance. |
| `src/lib/forge/autoRefresh.ts:59` | Automatic refresh injects a repo-relative wrapper. | Refer to the assembled gate guidance. |
| `src/lib/release/stages.ts:5` | Delegatus release stages name their own wrapper. | Retain: this generator releases Delegatus itself. |
| `src/lib/workflows/store.ts:62` and `:86` | Two seeded templates prescribe `bun test && bun run build`. | Let the existing project-check fallback apply. |
| `src/lib/workflows/prompts.ts:29` | Stage and fixer kickoffs interpolate the template's `verify` command. | Retain explicit project/template commands. |

The builder, reviewer and shared role rules already defer checks to project
instructions. Flow prompts add no runner or wrapper. The orchestrator mandate
and the fenced agent, runtime-host, MCP and attention areas contain no emitter
of this guidance. Relay fixture documentation and runtime comments describe
Delegatus checks; they do not assemble stage instructions.

The renderer is shared with browser previews. Installed-tool discovery belongs
to server assembly; the renderer receives its result as text. Missing tooling
must produce an explicit fallback, and project instructions determine the
runner and its file-selection syntax.

Assembly searches the Viewer's installed package ancestors, including a
standalone server's parent install. It checks the wrapper and its owned runner
and CPU admission companions before quoting the absolute wrapper path. Browser
previews say that resolution happens at launch. An incomplete installation
uses the explicit fallback: run the project's checks directly one at a time,
retain project deadlines and cleanup, and report the missing shared containment.

Only new workflow seeds lose the default test command. Saved templates and
explicit verification commands keep their selections.

## Verification

Before changing assembly, the three assembled-brief cases (a vitest project,
Delegatus itself and missing tooling) and the role/workflow default check all
failed on the starting code. They pass with the change. A standalone-install
case also executes the quoted wrapper from another checkout, including an
installation path containing whitespace and an apostrophe, and checks the
fallback when the owned runner is absent.

The historical small-input hashes normalize only the new guidance, preserving
their original framing assertions. Three hashes are already stale on the
starting commit; an isolated base replay produces exactly the same actual
hashes as the normalized changed code. The `early-switch-off` update-admission
case in `engine.creation.test.ts` also fails identically on the starting code.
