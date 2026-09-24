/* Fold DELEGATUS_* into LLV_* before the claim below reads the environment
   (docs/design/rename-delegatus.md §5). */
import "../../../../bin/envAlias.mjs";
import { claimStateOwner } from "@/lib/stateOwnership";

/**
 * The deploy adapter's owner claim, as a module rather than a line.
 *
 * `import "…/state/owner/deployAdapter";` must be the FIRST import of the
 * adapter entry point, for the reason spelled out in `./tool`: the adapter's
 * import graph resolves the state directory at module scope, long before any
 * statement in the entry runs. In production the runtime host that spawns the
 * adapter has already exported `LLV_STATE_OWNER=runtime-host`, so this claim
 * is what admits the adapter when it is run standalone (#1905).
 */
claimStateOwner("deploy-adapter");
