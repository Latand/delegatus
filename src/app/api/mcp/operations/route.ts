import { NextRequest, NextResponse } from "next/server";

import { MCP_OPERATIONS_MAX_LIMIT, readMcpOperations, type McpOperationsPage } from "@/lib/mcp/operationsFeed";
import { openMcpReceiptsReadOnly } from "@/lib/mcp/receiptsDatabase";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A project's `create_pipeline` and `update_task` operations, read only from
 * the MCP receipt rows (#1695 C5). `project` is required; `after` is the
 * cursor a previous page returned, and without it the newest rows answer;
 * `limit` is clamped to 1..50. Nothing is claimed, settled or replayed here.
 */
export async function GET(req: NextRequest): Promise<NextResponse<McpOperationsPage | ApiError>> {
  const params = req.nextUrl.searchParams;
  const project = params.get("project")?.trim();
  if (!project) return NextResponse.json({ error: "project is required" }, { status: 400 });
  const rawAfter = params.get("after")?.trim() || null;
  const after = rawAfter === null ? null : /^\d+$/.test(rawAfter) ? Number(rawAfter) : Number.NaN;
  if (after !== null && !Number.isSafeInteger(after)) {
    return NextResponse.json({ error: "after must be a sequence a previous page returned" }, { status: 400 });
  }
  const rawLimit = params.get("limit");
  const limit = rawLimit && /^\d+$/.test(rawLimit) ? Number(rawLimit) : MCP_OPERATIONS_MAX_LIMIT;
  let byDigest: Map<string, { id: string; project: string }> | null = null;
  const pipelineForDigest = (digest: string) => {
    if (!byDigest) {
      byDigest = new Map();
      try {
        for (const pipeline of loadPipelinesForList()) {
          if (pipeline.creationReceipt) byDigest.set(pipeline.creationReceipt.requestDigest, { id: pipeline.id, project: pipeline.project });
        }
      } catch {
        /* The receipt rows still answer on their own. */
      }
    }
    return byDigest.get(digest) ?? null;
  };
  let db: ReturnType<typeof openMcpReceiptsReadOnly> = null;
  try {
    db = openMcpReceiptsReadOnly();
    return NextResponse.json(readMcpOperations(db, { project, after, limit }, { pipelineForDigest }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "MCP receipts unreadable" }, { status: 500 });
  } finally {
    db?.close();
  }
}
