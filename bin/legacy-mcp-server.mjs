#!/usr/bin/env node

/* `agent-log-viewer-mcp` is the MCP launcher's name before the rename to
   delegatus (docs/design/rename-delegatus.md §3.3). stdout is the MCP protocol
   channel, so the notice goes to stderr only and nothing here writes a byte to
   stdout before the launcher's first protocol frame. */
process.stderr.write("agent-log-viewer-mcp is now delegatus-mcp; this command keeps working.\n");
await import("./mcp-server.mjs");
