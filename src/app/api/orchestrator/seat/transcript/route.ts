import { stat } from "node:fs/promises";
import path from "node:path";

import { readAgentSessionTarget } from "@/lib/agent/registry";
import { orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { catalogEntryToFileEntry, conversationCatalogEntry } from "@/lib/scanner/conversationCatalog";
import { describe } from "@/lib/scanner/describe";
import { pathAllowedWithRoots, scanRootEntries } from "@/lib/scanner/roots";
import { createTranscriptPathCanonicalizer } from "@/lib/scanner/transcriptIdentity";
import { requestWorkspaceScope, workspaceConversationResolver, workspaceDenied, workspaceRoute } from "@/lib/team/workspaceRoute";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "private, no-store" };

async function readSeatTranscript(request: Request): Promise<Response> {
  const project = new URL(request.url).searchParams.get("project")?.trim();
  if (!project) return Response.json({ error: "project is required" }, { status: 400, headers });
  const { active } = orchestratorSeatFor(project);
  const conversationId = active?.conversationId ?? null;
  const answer = (file: ReturnType<typeof catalogEntryToFileEntry> | null) =>
    Response.json({ conversationId, file }, { headers });
  if (!active || !conversationId) return answer(null);

  // Resolve the current, materialized generation using the same keyed read as
  // the session route. The stored activation path covers older seat records.
  const target = await readAgentSessionTarget(conversationId, active.path ?? "", request.signal);
  const roots = scanRootEntries();
  if (target.unavailable || !target.path.endsWith(".jsonl") || !pathAllowedWithRoots(target.path, roots)) return answer(null);
  const exact = conversationCatalogEntry(target.path);
  const pathname = exact ? target.path : createTranscriptPathCanonicalizer(roots.map(([, directory]) => directory))(target.path);
  const scope = requestWorkspaceScope(request);
  if (scope && !scope.owner) {
    const resolveProject = await workspaceConversationResolver({ skipColdKeyInitialization: true });
    if (!scope.canReadFile(resolveProject(target.path) ?? resolveProject(pathname))) return workspaceDenied("seat-transcript");
  }
  const metadata = await stat(pathname).catch(() => null);
  if (!metadata?.isFile()) return answer(null);
  const size = metadata.size;
  const mtime = metadata.mtimeMs / 1000;
  let entry = exact ?? conversationCatalogEntry(pathname);
  if (!entry) {
    // A cold catalog can describe the designated file directly under its
    // registered root. Only this file's header is needed.
    const root = roots.filter(([, directory]) => pathname.startsWith(directory + path.sep))
      .sort((left, right) => right[1].length - left[1].length)[0];
    if (!root) return answer(null);
    entry = {
      ...describe(root[0], root[1], pathname, metadata),
      root: root[0],
      name: path.relative(root[1], pathname),
      path: pathname,
      firstPrompt: "",
      size,
      mtime,
    };
  }
  const currentSeat = orchestratorSeatFor(project).active;
  if (currentSeat?.seatEpoch !== active.seatEpoch || currentSeat.conversationId !== conversationId || currentSeat.path !== active.path) {
    return answer(null);
  }
  return answer({ ...catalogEntryToFileEntry({ ...entry, size, mtime }), conversationId });
}

export const GET = workspaceRoute("/api/orchestrator/seat/transcript", (request: Request) =>
  withViewerOperation("seat.transcript", () => readSeatTranscript(request)));
