import { claimStateOwner } from "@/lib/stateOwnership";

/**
 * The owner claim of an operator-run script that administers live state, as a
 * module rather than a line.
 *
 * `import "…/state/owner/tool";` must be the FIRST import of such a script: a
 * claim in the script's body runs after every module it imports, and a module
 * that resolves state at load (`const TASKS_FILE = statePath("tasks.json")`)
 * has already been refused by then — which made the claims added to these
 * scripts dead code, admitted only when the variable was already in the
 * environment (#1905).
 *
 * A script that merely needs *a* state directory sets `LLV_STATE_DIR` instead
 * of importing this.
 */
claimStateOwner("tool");
