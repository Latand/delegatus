import { NextRequest } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { forgeCacheView } from "@/lib/forge/cache";
import { taskRepository } from "@/lib/forge/resolve";
import { readNativeChatPullRequests } from "@/lib/forge/nativeChatPullRequests";
import { CHAT_PULL_REQUEST_BATCH } from "@/lib/forge/chatPullRequests";
import { deputyConversationRefs } from "@/lib/orchestrator/deputies";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { catalogEntryToFileEntry, conversationCatalogEntry } from "@/lib/scanner/conversationCatalog";
import { pathAllowed } from "@/lib/scanner/roots";
import { readTranscriptPullRequests } from "@/lib/search/transcriptSearch";
import { overlaySessionProjects } from "@/lib/session/titleProjection";
import { requestWorkspaceScope, workspaceRoute } from "@/lib/team/workspaceRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function workspaceGET(req: NextRequest): Promise<Response> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const headers = { "Cache-Control": "private, no-store" };
  const project = req.nextUrl.searchParams.get("project");
  const paths = [...new Set(req.nextUrl.searchParams.getAll("transcript"))];
  if (!project || paths.length > CHAT_PULL_REQUEST_BATCH || paths.some(path => !path || path.length > 2048)) {
    return Response.json({ error: "invalid conversation selection" }, { status: 400, headers });
  }
  const scope = requestWorkspaceScope(req);
  const deputies = deputyConversationRefs();
  const hiddenPaths = new Set(deputies?.paths ?? []);
  const hiddenIds = new Set(deputies?.conversationIds ?? []);
  const registry = hiddenIds.size ? agentRegistry() : null;
  const candidates = paths.flatMap(path => {
    const entry = conversationCatalogEntry(path);
    if (!entry || hiddenPaths.has(path)) return [];
    const owner = registry?.conversationForPath(path);
    return owner && hiddenIds.has(owner.id) ? [] : [catalogEntryToFileEntry(entry)];
  });
  overlaySessionProjects(candidates);
  const allowed = candidates.filter(row => row.project === project && (!scope || scope.canReadFile(row.project)));
  if (!allowed.length) return Response.json({}, { headers });
  const cache = forgeCacheView();
  const repository = scope && !scope.owner ? taskRepository({ project }) : null;
  const scopedCache = scope && !scope.owner
    ? { repository: (name: string) => name === repository ? cache.repository(name) : null }
    : cache;
  const indexed = readTranscriptPullRequests(allowed, scopedCache, { requireCurrent: Boolean(scope && !scope.owner) });
  for (const file of allowed) {
    if (file.root !== "claude-projects" || file.engine !== "claude" || !pathAllowed(file.path)) continue;
    const native = await readNativeChatPullRequests(file.path, scopedCache);
    // Claude records its actual chat attachments separately from references
    // made in prose. Match that history when the provider has it.
    if (native?.items.length) indexed[file.path] = native;
  }
  return Response.json(indexed, { headers });
}

export const GET = workspaceRoute("/api/conversations/pull-requests", workspaceGET, true);
