import type { NextRequest } from "next/server";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { AttentionRequestError, readBoundedJson } from "@/lib/attention/validation";
import type { AttentionCallerAuthority } from "@/lib/attention/callerAuthority";
import { NEEDS_YOU_ROW_KINDS, type NeedsYouAnswer, type NeedsYouReadOptions } from "@/lib/attention/needsYouRead";
import { DismissalError } from "@/lib/attention/dismissals";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { permitNeedsYouRead } from "@/lib/mcp/toolAllowlist";
export interface NeedsYouRoutePorts {
  caller(request: NextRequest): { authority: AttentionCallerAuthority; seats: { conversationId: string; project: string | null }[]; maintainer: { conversationId: string; project: string | null; endedScheduledRun?: boolean } | null };
  read(project: string, options: NeedsYouReadOptions): Promise<NeedsYouAnswer>;
}
export function needsYouHandler(ports: NeedsYouRoutePorts) {
  return async (request: NextRequest): Promise<Response> => {
    const rejection = rejectCrossOrigin(request);
    if (rejection) return rejection;
    const headers = { "Cache-Control": "no-store" };
    try {
      const caller = ports.caller(request);
      const seats = caller.seats.map(s => ({ ...s, project: s.project ? canonicalOrchestratorProject(s.project) : null }));
      const maintainer = caller.maintainer ? { ...caller.maintainer, project: caller.maintainer.project ? canonicalOrchestratorProject(caller.maintainer.project) : null } : null;
      const first = permitNeedsYouRead(caller.authority, seats, maintainer, null);
      if (!first.allowed) return Response.json({ code: "NEEDS_YOU_READ_NOT_PERMITTED", error: first.error }, { status: 403, headers });
      const input = await readBoundedJson(request);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new DismissalError("INVALID_REQUEST", "read body must be an object");
      const fields = input as Record<string, unknown>;
      if (typeof fields.project !== "string" || !fields.project.trim() || fields.project.length > 4096) throw new DismissalError("INVALID_PROJECT", "name one project");
      const project = canonicalOrchestratorProject(fields.project.trim());
      const verdict = permitNeedsYouRead(caller.authority, seats, maintainer, project);
      if (!verdict.allowed) return Response.json({ code: "NEEDS_YOU_READ_NOT_PERMITTED", error: verdict.error }, { status: 403, headers });
      if (fields.kinds !== undefined && (!Array.isArray(fields.kinds) || fields.kinds.length > NEEDS_YOU_ROW_KINDS.length || fields.kinds.some(k => !NEEDS_YOU_ROW_KINDS.includes(k)))) throw new DismissalError("INVALID_KINDS", "unknown needs-you row kind");
      if (fields.full !== undefined && typeof fields.full !== "boolean" || fields.cursor !== undefined && (typeof fields.cursor !== "string" || fields.cursor.length > 4096)) throw new DismissalError("INVALID_REQUEST", "invalid full or cursor");
      const answer = await ports.read(project, { kinds: fields.kinds as NeedsYouReadOptions["kinds"], full: fields.full as boolean | undefined, cursor: fields.cursor as string | undefined });
      return Response.json(answer, { headers });
    } catch (error) {
      if (error instanceof DismissalError || error instanceof AttentionRequestError) return Response.json({ code: error.code, error: error.message }, { status: error.status, headers });
      throw error;
    }
  };
}
