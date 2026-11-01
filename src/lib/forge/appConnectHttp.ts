import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { refuseAnonymous, teamActor } from "@/lib/team";
import { prototypeWorld, type PrototypeWorld } from "@/lib/prototypeReview/world";
import { PrototypeError } from "@/lib/prototypeReview/input";
import { agentRegistry } from "@/lib/agent/registry";
import { canonicalProject } from "@/lib/projects/aliases";
import { AppConnectError, isAppConnectError, appConnectService, type AppConnectService } from "./appConnect";

export const appConnectInputSchema = z.object({
  clientRequestId: z.string().min(1).max(160), repository: z.string().min(1).max(1024), owner: z.string().min(1).max(39).optional(),
  permissions: z.record(z.string().regex(/^[a-z][a-z_]{0,63}$/), z.enum(["read", "write"])).optional(),
}).strict();
export interface AppConnectWorld extends PrototypeWorld { root(id: string): boolean }
const world: AppConnectWorld = { ...prototypeWorld,
  root: id => agentRegistry().mcpCallerSnapshot(id, [], process.env.LLV_ROOT_CONVERSATION_ID?.trim() || null).rootConversationId === id,
};

/** Authority is resolved again at every async boundary and before each replay. */
export async function appConnectPOST(request: NextRequest, service: AppConnectService = appConnectService(), source: AppConnectWorld = world): Promise<NextResponse> {
  const crossOrigin = rejectCrossOrigin(request); if (crossOrigin) return crossOrigin;
  const anonymous = refuseAnonymous(teamActor(request)); if (anonymous) return anonymous;
  try {
    const input = appConnectInputSchema.safeParse(await request.json());
    if (!input.success) throw new AppConnectError("invalid_request");
    const caller = source.caller(request);
    if (!caller.conversationId || !caller.project || source.stage(caller.conversationId)) throw new AppConnectError("not_permitted", 403);
    const authorize = () => {
      const current = source.caller(request);
      if (current.conversationId !== caller.conversationId || !current.project || canonicalProject(current.project) !== canonicalProject(caller.project!) ||
        source.stage(caller.conversationId!) || (!source.root(caller.conversationId!) && source.orchestrator(caller.project!) !== caller.conversationId)) throw new AppConnectError("not_permitted", 403);
    };
    authorize();
    const answer = await service.request(input.data, { conversationId: caller.conversationId, project: caller.project, operator: source.root(caller.conversationId), authorize });
    return NextResponse.json(answer, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PrototypeError && error.status === 403) error = new AppConnectError("not_permitted", 403);
    return NextResponse.json({ error: isAppConnectError(error) ? error.message : "App connection is unavailable", code: isAppConnectError(error) ? error.code : "app_connection_unavailable" },
      { status: isAppConnectError(error) ? error.status : 503 });
  }
}
