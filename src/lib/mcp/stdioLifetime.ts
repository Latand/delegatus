import { bindMcpChildToParent } from "../../../bin/mcp-lifetime.mjs";
import { installMcpLifecycle } from "../../../bin/mcp-lifecycle.mjs";

// Also cover clients that execute the bundled entry directly. This side effect
// precedes the application imports, including the native hook entry.
installMcpLifecycle(process.argv.includes("--native-caller-hook") ? "mcp-native-hook" : "mcp-stdio");
bindMcpChildToParent();
