import { searchUnavailable } from "@/lib/search/unavailable";
import { canonicalProject } from "@/lib/projects/aliases";
import { MEMORY_KINDS, type MemoryKind } from "@/lib/memory/parsers";
import { memoryIndex } from "@/lib/memory/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim() ?? "";
  const kind = params.get("kind") ?? undefined;
  const project = params.get("project")?.trim();
  const maxBytes = Number(params.get("maxBytes"));
  const responseBudget = Number.isInteger(maxBytes) && maxBytes >= 256 && maxBytes <= 16_000 ? maxBytes : 16_000;
  if (!query || query.length > 2000 || (project && project.length > 256)
    || (params.has("maxBytes") && (!Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > 16_000))) {
    return Response.json({ error: "q is required (at most 2000 characters); project is at most 256 characters" }, { status: 400 });
  }
  if (kind !== undefined && !MEMORY_KINDS.includes(kind as MemoryKind)) {
    return Response.json({ error: "unknown memory kind" }, { status: 400 });
  }
  const parsedLimit = Number(params.get("limit"));
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.max(1, Math.min(20, Math.trunc(parsedLimit))) : 10;
  try {
    return Response.json(memoryIndex().search({ query, project: project ? canonicalProject(project) : undefined, kind: kind as MemoryKind | undefined, limit, maxBytes: responseBudget }));
  } catch (error) {
    return searchUnavailable("memory", error);
  }
}

/** Opening a hit only appends a local outcome. Engine stores are never opened for writing. */
export async function POST(request: Request): Promise<Response> {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || typeof body.id !== "string" || !/^m_[a-zA-Z0-9_]{1,62}$/.test(body.id)
    || typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 256
    || (body.maxBytes !== undefined && (!Number.isInteger(body.maxBytes) || body.maxBytes < 256 || body.maxBytes > 16_000))
    || (body.project !== undefined && (typeof body.project !== "string" || !body.project.trim() || body.project.length > 256))
    || (body.conversationId != null && (typeof body.conversationId !== "string" || body.conversationId.length > 256))) {
    return Response.json({ error: "id and bounded requestId are required; project and conversationId must be bounded strings" }, { status: 400 });
  }
  try {
    const item = memoryIndex().open(body.id, body.requestId, body.conversationId ?? null, body.project ? canonicalProject(body.project.trim()) : undefined, body.maxBytes ?? 16_000);
    return item ? Response.json({ item }) : Response.json({ error: "memory entry not found" }, { status: 404 });
  } catch (error) {
    return searchUnavailable("memory", error);
  }
}
