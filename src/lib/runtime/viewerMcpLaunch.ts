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
  const status = viewer?.status ?? viewer?.runtimeStatus;
  const diagnostic = typeof viewer?.error === "string" ? viewer.error
    : typeof viewer?.toolsError === "string" ? viewer.toolsError : null;
  if (viewer && available && (status === undefined || status === "connected")) return;
  const detail = diagnostic ?? (!viewer ? "viewer server is missing"
    : status && status !== "connected" ? `viewer server is ${status}` : "viewer has no tools");
  throw new Error(`Viewer MCP launch failed: ${detail}; state directory ${stateDirectory}`);
}
