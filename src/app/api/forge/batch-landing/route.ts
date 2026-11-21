import type { NextRequest } from "next/server";
import { z } from "zod";
import { callerConversationId } from "@/lib/agent/operatorAuthority";
import { agentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { boundedRepository } from "@/lib/forge/workLinks";
import { releaseBatchLanding, reserveBatchLanding } from "@/lib/pipelines/store";
import { canonicalProject } from "@/lib/projects/aliases";
import { projectIdentityFromRemote, projectIdentityFromRepositoryRoot } from "@/lib/projects/identity";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { readBoundedJson } from "@/lib/view/validation";

export const runtime = "nodejs";

const repositoryName = z.string().refine(boundedRepository).transform(value => value.toLowerCase());
const target = z.object({
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  headRepository: repositoryName,
  branch: z.string().min("refs/heads/".length + 1).max(1024).startsWith("refs/heads/"),
});
const reservation = z.object({ id: z.uuid(), repository: repositoryName });
const requestBody = z.discriminatedUnion("action", [
  reservation.extend({ action: z.literal("reserve"), admitUntil: z.number().int(), targets: z.array(target).min(2).max(256) }),
  reservation.extend({ action: z.literal("release") }),
]);

class BatchLandingForbidden extends Error {}

export async function POST(request: NextRequest): Promise<Response> {
  const rejected = rejectCrossOrigin(request);
  if (rejected) return rejected;
  const caller = callerConversationId(request);
  if (!caller) return Response.json({ error: "Batch landing requires a merger launch capability" }, { status: 403 });
  const parsed = requestBody.safeParse(await readBoundedJson(request, 256 * 1024).catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid batch landing request" }, { status: 400 });
  const { id, repository } = parsed.data;
  const project = projectIdentityFromRemote(`https://github.com/${repository}`, "/")!.project;
  let generationId: string | null = null;
  const assertAuthority = () => {
    const conversation = agentRegistry().conversation(caller as ViewerConversationId);
    const generation = conversation?.generations.at(-1);
    const cwd = generation?.launchProfile?.cwd;
    const scope = conversation?.projectOwnership?.project
      ?? (cwd ? projectIdentityFromRepositoryRoot(cwd)?.project : undefined);
    if (callerConversationId(request) !== caller || !conversation || conversation.agentRole !== "merger"
      || conversation.supersededBy || !generation || generation.archivedAt || (generationId && generationId !== generation.id)
      || !scope || canonicalProject(scope) !== canonicalProject(project)) {
      throw new BatchLandingForbidden("Batch landing requires a merger launched for this repository");
    }
    generationId = generation.id;
  };
  try {
    assertAuthority();
    if (parsed.data.action === "reserve") {
      const { admitUntil, targets } = parsed.data;
      const remaining = admitUntil - Date.now();
      if (remaining <= 0 || remaining > 20_000) return Response.json({ error: "Batch landing admission deadline expired" }, { status: 409 });
      const conflict = await reserveBatchLanding(id, repository, targets.map(entry => ({
        prRepository: repository, prNumber: entry.number, headRepository: entry.headRepository, branch: entry.branch,
      })), assertAuthority, performance.now() + remaining);
      if (conflict) return Response.json({ error: conflict }, { status: 409 });
    } else await releaseBatchLanding(id, repository, assertAuthority);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof BatchLandingForbidden) return Response.json({ error: error.message }, { status: 403 });
    console.error("[batch landing] reservation registry unavailable", error);
    return Response.json({ error: "Batch landing reservation registry unavailable" }, { status: 503 });
  }
}
