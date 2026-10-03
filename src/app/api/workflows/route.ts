import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";
import { createWorkflowFromRequest, getWorkflowsWithTemplates } from "@/lib/workflows/engine";
import type { CreateWorkflowRequest, Workflow, WorkflowsResponse } from "@/lib/workflows/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<WorkflowsResponse>> {
  return NextResponse.json(getWorkflowsWithTemplates());
}

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; workflow: Workflow } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: CreateWorkflowRequest;
  try {
    body = (await req.json()) as CreateWorkflowRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const rawDir = typeof body.repoDir === "string" ? body.repoDir.trim() : "";
  if (!rawDir) return NextResponse.json({ error: "repository directory is required" }, { status: 400 });
  const repoDir = path.resolve(rawDir === "~" || rawDir.startsWith("~/") ? path.join(os.homedir(), rawDir.slice(1)) : rawDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repoDir);
  } catch {
    return NextResponse.json({ error: `directory does not exist: ${repoDir}` }, { status: 400 });
  }
  if (!stat.isDirectory()) return NextResponse.json({ error: `not a directory: ${repoDir}` }, { status: 400 });

  try {
    const result = (await createWorkflowFromRequest({ ...body, repoDir }));
    if (!result.workflow) {
      return NextResponse.json({ error: result.error ?? "could not create workflow" }, { status: result.status ?? 400 });
    }
    return NextResponse.json({ ok: true, workflow: result.workflow });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
