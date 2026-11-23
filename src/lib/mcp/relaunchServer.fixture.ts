import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { POST, GET, DELETE } from "@/app/api/mcp/route";
import { setMcpHttpDependenciesForTests } from "./http";
import { createMcpToolService, SqliteMcpReceiptStore } from "./server";
import { viewerMcpBindings, viewerMcpToolPolicy } from "./bindings";
import { agentRegistry } from "@/lib/agent/registry";

// A real route, policy and durable receipt store in a disposable Viewer process.
const directory = process.argv[2]!;
const receipts = new SqliteMcpReceiptStore(path.join(directory, "receipts.sqlite"));
const service = createMcpToolService(viewerMcpBindings(), receipts, viewerMcpToolPolicy());
setMcpHttpDependenciesForTests({ service: async () => service,
  conversationForCapability: capability => agentRegistry().conversationIdForSpawnCapabilityDigest(createHash("sha256").update(capability).digest("hex")) });
const listener = Bun.serve({ hostname: "127.0.0.1", port: Number(process.argv[3] ?? 0), async fetch(request) {
  const next = new NextRequest(request);
  if (request.method === "GET") return GET();
  if (request.method === "DELETE") return DELETE();
  const body = await next.clone().json() as { method?: string; params?: { arguments?: { clientRequestId?: string } } };
  const key = body.params?.arguments?.clientRequestId;
  if (key === "held-relaunch" || key === "held-mutation-relaunch") {
    fs.writeFileSync(path.join(directory, key), "1");
    await new Promise(() => {});
  }
  return POST(next);
} });
console.log(listener.url.origin);
