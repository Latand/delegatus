import { NextRequest, NextResponse } from "next/server";

import { listFiles } from "@/lib/scanner";
import {
  applyTaskCuratorProposals,
  collectTaskCuratorInputs,
  collectTaskCuratorProjects,
  type TaskCuratorProposal,
} from "@/lib/tasks/curator";
import { taskForResponse } from "@/lib/prototypeReview/read";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hoursParam(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function intParam(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export async function GET(req: NextRequest): Promise<NextResponse | NextResponse<ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const hours = hoursParam(req.nextUrl.searchParams.get("hours"), 1, 24);
  const context = intParam(req.nextUrl.searchParams.get("context"), 4, 12);
  const project = req.nextUrl.searchParams.get("project")?.trim() || null;
  const files = await listFiles();
  const now = new Date();
  const lookbackMs = hours * 60 * 60 * 1000;
  const inputs = collectTaskCuratorInputs(files, { now, lookbackMs, contextMessages: context, project });
  const projects = collectTaskCuratorProjects(files, { now, lookbackMs });
  return NextResponse.json({
    ok: true,
    window: {
      since: new Date(now.getTime() - lookbackMs).toISOString(),
      until: now.toISOString(),
    },
    project,
    projects,
    instructions: {
      apply: "POST /api/tasks/curator with { proposals: [{ inputId, title }] }",
      title: "Write a short task title in your own words. Use one line, up to 96 characters.",
      selectivity: "Create only separate tasks that are worth tracking on the board.",
      scope: "Omit ?project to capture all projects. Add ?project=<name> to scope to one; see `projects` for the choices.",
    },
    inputs,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; created: unknown[]; skipped: unknown[] } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { proposals?: unknown; hours?: unknown };
  try {
    body = (await req.json()) as { proposals?: unknown; hours?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.proposals)) {
    return NextResponse.json({ error: "proposals must be an array" }, { status: 400 });
  }

  const hours = typeof body.hours === "number" && Number.isFinite(body.hours) && body.hours > 0 ? Math.min(body.hours, 72) : 6;
  const files = await listFiles();
  const result = applyTaskCuratorProposals(files, body.proposals as TaskCuratorProposal[], {
    now: new Date(),
    lookbackMs: hours * 60 * 60 * 1000,
  });
  return NextResponse.json({ ok: true, created: result.created.map((task) => taskForResponse(req, task)), skipped: result.skipped });
}
