import path from "node:path";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mcp/route";
import { retainedLivenessFixture } from "@/lib/lifecycle/liveness.retained.fixture";
import { productionDomainDependencies, viewerMcpBindings, viewerMcpToolPolicy, type ViewerMcpDomainDependencies } from "./bindings";
import { createMcpToolService, SqliteMcpReceiptStore } from "./server";
import { setMcpHttpDependenciesForTests } from "./http";
import { FLEET_NOW } from "./agentFleet.fixture";

/** Real route, policy and durable receipts over the production retained fixture. */
export function retainedMcpFixture() {
  const f = retainedLivenessFixture();
  const receipts = new SqliteMcpReceiptStore(path.join(f.directory, "mcp-receipts.sqlite"));
  const dependencies: ViewerMcpDomainDependencies = {
    ...productionDomainDependencies,
    registrySnapshot: () => f.registry.readOnlySnapshot(),
    callerAttribution: () => ({ kind: "gateway", conversationId: null, role: null }),
    authorizedSeats: () => [],
    livenessSources: () => f.sources,
    completedFileScan: f.completedFileScan,
    listPipelineRecords: () => [f.pipeline],
    readFleetSessions: () => ({ sessions: [], stale: false }),
    accountLimitsSource: () => ({ accounts: { claude: [], codex: [], copilot: [] },
      active: { claude: null, codex: null, copilot: null }, observations: { claude: {}, codex: {}, copilot: {} }, now: FLEET_NOW }),
    refreshLifecycleJournal: () => ({ appended: 0, skipped: 0, throttled: false }),
  };
  const service = createMcpToolService(viewerMcpBindings(undefined, undefined, dependencies), receipts, viewerMcpToolPolicy(dependencies));
  const capability = "r".repeat(43);
  setMcpHttpDependenciesForTests({ service: async () => service,
    conversationForCapability: value => value === capability ? f.conversationId : null });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => POST(new NextRequest(request)) });
  return { f, capability, listener, close() {
    listener.stop(true); setMcpHttpDependenciesForTests(null); receipts.close(); f.close();
  } };
}
