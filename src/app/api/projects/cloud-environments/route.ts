import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { canonicalProject } from "@/lib/projects/aliases";
import { cloudEnvironmentActor } from "@/lib/projects/cloudEnvironmentAuthority";
import { readCloudEnvironmentBindings, setCloudEnvironmentOverride } from "@/lib/projects/codexCloudEnvironments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const projectSchema = z.string().trim().min(1).max(256);
const accountSchema = z.string().regex(/^[A-Za-z0-9_~-]{1,200}$/);
const mutationSchema = z.object({ action: z.literal("set"), project: projectSchema, accountId: accountSchema,
  environmentId: z.string().max(200).nullable(), expectedRevision: z.number().int().nonnegative(), clientRequestId: z.string().min(1).max(200) }).strict();
async function workspaceGET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) {
    return NextResponse.json({ error: "duplicate Cloud environment query field" }, { status: 400, headers });
  }
  const parsed = z.object({ project: projectSchema, accountId: accountSchema.optional(), after: z.string().max(1024).optional(), limit: z.coerce.number().int().min(1).max(100).optional() })
    .safeParse(Object.fromEntries(params));
  if (!parsed.success) return NextResponse.json({ error: "invalid Cloud environment request" }, { status: 400, headers });
  try {
    return NextResponse.json({ ok: true, project: canonicalProject(parsed.data.project), ...readCloudEnvironmentBindings(parsed.data.project, parsed.data) }, { headers });
  } catch { return NextResponse.json({ error: "Cloud environment bindings are unreadable" }, { status: 503, headers }); }
}
async function workspacePOST(request: NextRequest) {
  const origin = rejectCrossOrigin(request); if (origin) return origin;
  const body: unknown = await request.json().catch(() => null);
  const parsed = mutationSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid Cloud environment override" }, { status: 400, headers });
  const input = parsed.data, project = canonicalProject(input.project);
  const actor = cloudEnvironmentActor(request, project);
  if (!actor) return NextResponse.json({ error: "Cloud environment overrides require the operator or this project's designated seat" }, { status: 403, headers });
  try {
    const result = await setCloudEnvironmentOverride({ ...input, project, actor, assertCurrent: () => {
      if (cloudEnvironmentActor(request, project) !== actor) throw new Error("Cloud environment override authority changed");
    } });
    return NextResponse.json(result, { status: result.ok ? 200 : 409, headers });
  } catch { return NextResponse.json({ error: "Cloud environment override could not be stored" }, { status: 503, headers }); }
}
export const GET = workspaceRoute("/api/projects/cloud-environments", workspaceGET);
export const POST = workspaceRoute("/api/projects/cloud-environments", workspacePOST);
