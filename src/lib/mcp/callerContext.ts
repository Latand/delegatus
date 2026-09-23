import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who is calling, for a tool call that arrived over the Viewer's shared HTTP
 * endpoint (`/api/mcp`).
 *
 * The stdio server runs one process per agent, so its caller is a fact about
 * the PROCESS: the spawn capability in its inherited environment and the
 * process tree it hangs under. The shared endpoint serves every agent from the
 * Viewer's own process, where neither exists — the Viewer's environment names
 * no agent and its ancestry leads to no agent host. So the identity travels
 * with the request instead: the capability the agent presented, authenticated
 * by the route before the call started, is bound to the call's async context
 * here, and the resolvers that read the environment and the process tree for a
 * stdio call read this in its place.
 *
 * Kept on `globalThis` because a Next route and the modules it imports can be
 * split across bundles, and a module-level instance would not be shared.
 */
export interface McpHttpCaller {
  /** The per-agent spawn capability the request presented. Never logged. */
  capability: string;
}

const STORE_KEY = Symbol.for("llv.mcp.httpCaller");

function store(): AsyncLocalStorage<McpHttpCaller> {
  const holder = globalThis as typeof globalThis & { [STORE_KEY]?: AsyncLocalStorage<McpHttpCaller> };
  holder[STORE_KEY] ??= new AsyncLocalStorage<McpHttpCaller>();
  return holder[STORE_KEY];
}

/** Run one tool call as the authenticated HTTP caller. */
export function runAsMcpHttpCaller<T>(caller: McpHttpCaller, operation: () => T): T {
  return store().run(caller, operation);
}

/** The HTTP caller of the call in progress, or null for a stdio call. */
export function currentMcpHttpCaller(): McpHttpCaller | null {
  return store().getStore() ?? null;
}
