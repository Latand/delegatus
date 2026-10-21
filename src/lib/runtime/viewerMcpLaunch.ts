type JsonObject = Record<string, unknown>;

/** Check the catalog the engine actually connected, before admitting work. */
export function assertViewerMcpTools(entries: unknown, stateDirectory: string): void {
  const viewer = Array.isArray(entries)
    ? entries.find(entry => entry && typeof entry === "object" && entry.name === "viewer") as JsonObject | undefined
    : undefined;
  const tools = viewer?.tools;
  const available = Array.isArray(tools)
    ? tools.some(tool => tool && typeof tool === "object" && typeof tool.name === "string" && tool.name.length > 0)
    : tools !== null && typeof tools === "object" && Object.keys(tools).length > 0;
  if (viewer && available && (viewer.status === undefined || viewer.status === "connected")) return;
  const detail = typeof viewer?.error === "string" ? viewer.error : !viewer ? "viewer server is missing"
    : viewer.status && viewer.status !== "connected" ? `viewer server is ${viewer.status}` : "viewer has no tools";
  throw new Error(`Viewer MCP launch failed: ${detail}; state directory ${stateDirectory}`);
}
