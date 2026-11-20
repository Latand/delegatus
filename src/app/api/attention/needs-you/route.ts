import { workspaceRoute } from "@/lib/team/workspaceRoute";
import type { NextRequest } from "next/server";
import { agentRegistry, registryLiveRootSession } from "@/lib/agent/registry";
import { callerConversationId } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { maintainerCallerOf } from "@/lib/boardMaintenance/guard";
import { authorizedManagerSeats } from "@/lib/orchestrator/authority";
import { productionManagerAuthoritySources } from "@/lib/orchestrator/managerAuthoritySources";
import { readNeedsYou } from "@/lib/attention/needsYouRead";
import { needsYouHandler } from "./handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = needsYouHandler({
  caller(request) {
    const id = callerConversationId(request);
    if (!request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER)) return { authority: { kind: "root", conversationId: null }, seats: [], maintainer: null };
    if (!id) return { authority: { kind: "unidentified" }, seats: [], maintainer: null };
    const registry = agentRegistry();
    const snapshot = registry.readOnlySnapshot();
    const root = registryLiveRootSession(registry, process.env.LLV_ROOT_CONVERSATION_ID ?? null, snapshot);
    return { authority: root?.conversationId === id ? { kind: "root", conversationId: id } : { kind: "worker", conversationId: id, role: null },
      seats: authorizedManagerSeats(productionManagerAuthoritySources()), maintainer: maintainerCallerOf(id, snapshot) };
  }, read: readNeedsYou,
});
function workspacePOST(request: NextRequest) { return handler(request); }

export const POST = workspaceRoute("/api/attention/needs-you", workspacePOST);
