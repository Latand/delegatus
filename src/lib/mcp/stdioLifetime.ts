import { bindMcpChildToParent } from "../../../bin/mcp-lifetime.mjs";

// Also cover clients that execute the bundled entry directly. This side effect
// precedes the application imports, including the native hook entry.
bindMcpChildToParent();
