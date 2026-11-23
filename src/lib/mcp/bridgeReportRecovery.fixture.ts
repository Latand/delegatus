// A one-call MCP process used to prove that report recovery survives process exit.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { setSystemTime } from "bun:test";
import { shutdownTaskPageWorker } from "@/lib/links/taskPageWorker";
import { productionDomainDependencies, productionViewerControlDependencies, viewerMcpBindings } from "./bindings";
import { createMcpToolService, createViewerMcpServer, SqliteMcpReceiptStore } from "./server";

setSystemTime(new Date("2026-09-25T12:00:00Z"));
const bindings = viewerMcpBindings(undefined, productionViewerControlDependencies(true), {
  ...productionDomainDependencies,
  callerProject: () => "repo-report-delivery",
  callerAttribution: () => ({ kind: "manager", conversationId: "conversation_report_seat", role: "orchestrator" }),
  authorizedSeats: () => [{ conversationId: "conversation_report_seat", path: null, project: "repo-report-delivery" }],
  operatorLocale: () => "en",
  operatorTimeZone: () => "UTC",
  publicDenyList: () => ({ accounts: [], people: [], local: [], projects: [] }),
});
const receipts = new SqliteMcpReceiptStore(process.env.REPORT_RECEIPTS_FILE!);
const server = createViewerMcpServer(createMcpToolService(bindings, receipts, { permit: () => ({ allowed: true }) }));
const client = new Client({ name: "report-recovery-process", version: "1" });
try {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const result = await client.callTool({ name: "bridge_report", arguments: {
    clientRequestId: process.argv[2], key: "report-key", class: "completed", summary: "The lane finished.", coversOwed: true,
  } });
  process.stdout.write(`RECOVERY_RESULT ${JSON.stringify(result.structuredContent)}\n`);
} finally {
  await client.close();
  await server.close();
  receipts.close();
  await shutdownTaskPageWorker();
}
