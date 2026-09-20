import { claimStateOwner } from "@/lib/stateOwnership";

/**
 * The Viewer MCP server's owner claim, as a module rather than a line.
 *
 * `import "@/lib/state/owner/mcp";` must be the FIRST import of the MCP entry
 * point. A claim written in the entry's body runs after every module that
 * entry imports, and `./server`'s graph reaches `src/lib/inbox.ts`, which
 * resolves the inbox directory at module scope — so a late claim left the
 * server throwing `UnownedStateAccessError` before it could connect, and every
 * spawned agent lost its Viewer tools (#1905).
 */
claimStateOwner("mcp");
