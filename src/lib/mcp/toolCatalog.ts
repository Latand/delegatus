/** An independent declaration in initialize, compared with tools/list by the
 * deploying generation. Keep this module free of the server's binding graph. */
export const MCP_TOOL_CATALOG_CAPABILITY = "delegatus/tool-catalog";
export const MCP_DEPLOYMENT_CONTRACT = ["deployment_status", "board_snapshot"] as const;

export function candidateDeclaredTools(experimental: Record<string, unknown> | undefined, listed: string[]): readonly string[] {
  // Releases before the declaration existed still support rollback and
  // bootstrap: their own tools/list is their catalog. Never substitute the
  // installed prober's catalog. A present, broken declaration is refused.
  if (!experimental || !Object.hasOwn(experimental, MCP_TOOL_CATALOG_CAPABILITY)) return listed;
  const value = experimental[MCP_TOOL_CATALOG_CAPABILITY] as { version?: unknown; tools?: unknown } | null;
  if (!value || value.version !== 1 || !Array.isArray(value.tools) || value.tools.length < 1 || value.tools.length > 1024
    || value.tools.some(name => typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(name))
    || new Set(value.tools).size !== value.tools.length) {
    throw new Error("MCP candidate tool catalog is invalid. Retrying the same image will not help; choose a corrected release.");
  }
  return value.tools as string[];
}
