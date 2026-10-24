import os from "node:os";

import { NextRequest, NextResponse } from "next/server";

import { forgeCacheView } from "@/lib/forge/cache";
import { taskWorkLinks } from "@/lib/forge/resolve";
import { githubRunner } from "@/lib/monitor/githubEvidence";
import { preparePipelineRepository } from "@/lib/pipelines/initializeRepository";
import { resolvePipelineLink, type PipelineLinkPorts, type PipelineLinkResolution } from "@/lib/pipelines/linkSource";
import { pipelineRepoPreflightError } from "@/lib/pipelines/preflight";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import type { PipelineRepoPreflight } from "@/lib/pipelines/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { projectForCwd } from "@/lib/scanner/describe";
import { loadTasks } from "@/lib/tasks/store";
import { realExec } from "@/lib/workflows/provision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `gh api` reads answer in well under this; a stalled forge refuses instead. */
const GH_TIMEOUT_MS = 20_000;

type Dependencies = {
  preflight: (repoDir: string) => PipelineRepoPreflight | Promise<PipelineRepoPreflight>;
  ports: () => PipelineLinkPorts;
};

const defaults: Dependencies = {
  preflight: (repoDir) => preparePipelineRepository(repoDir, false, { cache: true }),
  ports: () => {
    const cache = forgeCacheView();
    return {
      gh: githubRunner(os.tmpdir(), GH_TIMEOUT_MS),
      exec: realExec,
      tasks: () => loadTasks(),
      pipelines: () => loadPipelinesForList(),
      projectForCwd,
      taskLinks: (task, pipelines) => taskWorkLinks(task, pipelines, cache).links,
      cache,
    };
  },
};

/**
 * Reads a pasted PR or issue link for the new-pipeline picker: the repository,
 * base and head it resolves to, and the open tasks already linked to it. It
 * creates nothing; the picker sends the answer's `request` fields through the
 * ordinary `POST /api/pipelines` as a draft.
 */
async function postSource(req: NextRequest, dependencies: Dependencies = defaults): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "invalid", error: "invalid JSON" }, { status: 400 });
  }
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as { link?: unknown; repoDir?: unknown } : null;
  const link = typeof body?.link === "string" ? body.link.trim() : "";
  const repoDir = typeof body?.repoDir === "string" ? body.repoDir.trim() : "";
  if (!link || !repoDir) {
    return NextResponse.json({ ok: false, code: "invalid", error: "link and repoDir are required" }, { status: 400 });
  }
  const admission = await dependencies.preflight(repoDir);
  if (!admission.ok) {
    return NextResponse.json({ ok: false, code: "repository", error: pipelineRepoPreflightError(admission), repositoryCode: admission.code, path: admission.path }, { status: 409 });
  }
  const result: PipelineLinkResolution = await resolvePipelineLink(link, admission.repoDir, dependencies.ports());
  if (result.ok) return NextResponse.json({ ok: true, repoDir: admission.repoDir, source: result.source });
  const status = result.code === "invalid" ? 400 : result.code === "not_found" ? 404 : result.code === "forge_unavailable" ? 502 : 409;
  return NextResponse.json(result, { status });
}

export const POST = Object.assign(
  (req: NextRequest) => postSource(req),
  { withDependencies: postSource },
);
