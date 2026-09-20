import { discardWakatimeEnvironmentCredential } from "@/lib/wakatime/credential";
import { STATE_OWNER_ENV } from "@/lib/stateOwnership";

import { startViewerMcpServer } from "./server";

discardWakatimeEnvironmentCredential();

/* The MCP server keeps its receipts beside the state it reports on, so it may
   resolve the operator's state directory — and only that (#1905): a startup
   migration still belongs to the serving Viewer. */
if (!process.env[STATE_OWNER_ENV]) process.env[STATE_OWNER_ENV] = "mcp";
startViewerMcpServer().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
