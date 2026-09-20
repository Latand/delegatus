/* FIRST, and before every other import: the claim has to precede the module
   graph below, which resolves the operator's state directory while it loads
   (#1905). See `@/lib/state/owner/mcp`. */
import "@/lib/state/owner/mcp";

import { discardWakatimeEnvironmentCredential } from "@/lib/wakatime/credential";

import { startViewerMcpServer } from "./server";

discardWakatimeEnvironmentCredential();

startViewerMcpServer().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
