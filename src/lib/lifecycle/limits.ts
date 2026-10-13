/** Silence under a live host that turns running into stalled. A dead host
 * over an open turn needs no threshold. Shared with the MCP argument schema. */
export const DEFAULT_STALL_AFTER_MS = 10 * 60_000;
