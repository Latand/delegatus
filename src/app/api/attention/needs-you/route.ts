import type { NextRequest } from "next/server";
import { agentRegistry } from "@/lib/agent/registry";
import { callerConversationId } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { maintainerCallerOf } from "@/lib/boardMaintenance/guard";
import { authorizedManagerSeats } from "@/lib/orchestrator/authority";
import { productionManagerAuthoritySources } from "@/lib/orchestrator/managerAuthoritySources";
import { liveRootSession } from "@/lib/root/adopt";
import { readNeedsYou } from "@/lib/attention/needsYouRead";
import { needsYouHandler } from "./handler";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = needsYouHandler({
  caller(request) {
    const id = callerConversationId(request);
    if (!request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER)) return { authority: { kind: "root", conversationId: null }, seats: [], maintainer: null };
    if (!id) return { authority: { kind: "unidentified" }, seats: [], maintainer: null };
    const snapshot = agentRegistry().readOnlySnapshot();
    const root = liveRootSession({ conversations: Object.values(snapshot.conversations), configuredRootId: process.env.LLV_ROOT_CONVERSATION_ID ?? null });
    return { authority: root?.conversationId === id ? { kind: "root", conversationId: id } : { kind: "worker", conversationId: id, role: null },
      seats: authorizedManagerSeats(productionManagerAuthoritySources()), maintainer: maintainerCallerOf(id, snapshot) };
  }, read: readNeedsYou,
});
export function POST(request: NextRequest) { return handler(request); }
