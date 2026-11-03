import { NextRequest, NextResponse } from "next/server";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { canonicalProject } from "@/lib/projects/aliases";
import { projectIdentityFromRepositoryRoot } from "@/lib/projects/identity";
import { projectSetupRecipe, reviewSetupRecipe, setProjectSetupRecipe } from "@/lib/projects/setupRecipe";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Preview and approval share the existing operator boundary. The approval
 * submits the preview's digest, so a changed file cannot be approved unseen. */
async function write(request: NextRequest, approve: boolean): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) return NextResponse.json({ error: authority.error, code: "operator_only" }, { status: authority.status, headers });
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400, headers }); }
  if (!body || typeof body.project !== "string" || !body.project.trim() || body.project.length > 256) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400, headers });
  }
  const project = canonicalProject(body.project.trim());
  try {
    if (approve && body.recipe === null) {
      await setProjectSetupRecipe(project, null);
      return NextResponse.json({ ok: true, setup: null }, { headers });
    }
    if (typeof body.repoDir !== "string" || canonicalProject(projectIdentityFromRepositoryRoot(body.repoDir)?.project ?? "") !== project) {
      return NextResponse.json({ error: "REPOSITORY_MISMATCH" }, { status: 400, headers });
    }
    const reviewed = await reviewSetupRecipe(body.repoDir, body.recipe);
    if (approve && body.reviewedHash !== reviewed.hash) return NextResponse.json({ error: "SETUP_REVIEW_REQUIRED" }, { status: 409, headers });
    const setup = { command: reviewed.command, cwd: reviewed.cwd, hash: reviewed.hash, approvedAt: new Date().toISOString() };
    if (approve) await setProjectSetupRecipe(project, setup);
    return NextResponse.json({ ok: true, setup: approve ? setup : null, review: { command: reviewed.command, cwd: reviewed.cwd,
      hash: reviewed.hash, files: Object.fromEntries(Object.entries(reviewed.files).map(([name, bytes]) => [name, bytes.toString("utf8")])) } }, { headers });
  } catch {
    return NextResponse.json({ error: "SETUP_UNAVAILABLE", message: "could not read, validate or store setup; check the repository script and retry" }, { status: 409, headers });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> { return write(request, false); }
export async function PUT(request: NextRequest): Promise<NextResponse> { return write(request, true); }
export async function GET(request: NextRequest): Promise<NextResponse> {
  const project = request.nextUrl.searchParams.get("project");
  if (!project?.trim() || project.length > 256) return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400, headers });
  try { return NextResponse.json({ ok: true, setup: projectSetupRecipe(project.trim()) }, { headers }); }
  catch { return NextResponse.json({ error: "SETUP_UNAVAILABLE" }, { status: 409, headers }); }
}
