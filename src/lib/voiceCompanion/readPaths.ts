import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { GET as searchTranscriptPage } from "@/app/api/search/transcripts/route";
import { viewerReadTools, productionDomainDependencies, type ViewerMcpDomainDependencies } from "@/lib/mcp/bindings";
import { budgetPage } from "@/lib/mcp/budgetPage";
import type { AgentLivenessSources } from "@/lib/lifecycle/liveness";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { projectCurationSnapshot } from "@/lib/projects/curation";
import { reportHeaderName } from "@/lib/projects/settings";
import { conversationCatalogSnapshot } from "@/lib/scanner/conversationCatalog";
import { activeOrchestratorSeats, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { readPrototypeReviews } from "@/lib/prototypeReview/read";
import { prototypeRoot, storedMediaPath, sniffPrototype } from "@/lib/prototypeReview/store";
import { openedAt } from "@/lib/artifact/localFile";
import type { BoardReadPaths } from "./boardReads";

/** In-process reads use the same implementations as MCP, without receipts or
 * lifecycle-journal writes. Search reuses its ordinary page handler. */
export function createCompanionBoardReadPaths(dependencies: { domain?: ViewerMcpDomainDependencies; liveness?: AgentLivenessSources;
  transcript?: Pick<ViewerMcpDomainDependencies, "pinnedTranscript" | "selectedContext"> } = {}): BoardReadPaths {
  const domain = { ...(dependencies.domain ?? productionDomainDependencies), ...dependencies.transcript,
    ...(dependencies.liveness ? { livenessSources: () => dependencies.liveness! } : {}),
    refreshLifecycleJournal: () => ({ appended: 0 }) as ReturnType<ViewerMcpDomainDependencies["refreshLifecycleJournal"]>,
  };
  const searchHandles = new Map<string,{path:string;project:string}>();
  const activityPages = {};
  const reads = viewerReadTools(domain, { get: async pathname => {
    const answer = await searchTranscriptPage(new Request(`http://127.0.0.1${pathname}`));
    if (!answer.ok) throw new Error("SEARCH_UNAVAILABLE");
    const page = await answer.json();
    for (const row of page.items ?? []) if (typeof row.transcriptPath === "string" && typeof row.project === "string") {
      const handle = `voice_transcript_${createHash("sha256").update(row.transcriptPath).digest("hex").slice(0,32)}`;
      searchHandles.set(handle,{path:row.transcriptPath,project:canonicalProject(row.project)}); row.conversationId = handle;
    }
    while(searchHandles.size > 1024) searchHandles.delete(searchHandles.keys().next().value!);
    return page;
  }, post: async () => { throw new Error("TOOL_NOT_ALLOWED"); } });
  const task = (id: string) => {
    const selection = domain.taskSelectionSource?.();
    return selection ? selection.read(id) : (domain.listTaskRecords?.() ?? domain.loadTasks()).find(row => row.id === id);
  };
  return {
    call: (name, args) => {
      const target = name === "conversation_messages" || name === "agent_activity" ? searchHandles.get(String(args.conversationId)) : null;
      const selected = target ? {...args,conversationId:undefined,transcriptPath:target.path} : args;
      if (name === "agent_activity") return budgetPage(activityPages, name, args, 4000, async () => {
        const source = await reads.agent_activity({ ...selected, cursor: undefined, limit: 200 });
        const { conversations, ...meta } = source;
        return { rows: conversations as Record<string, unknown>[], meta: { ...meta, total: source.count }, upstream: null };
      }, false, typeof args.limit === "number" ? args.limit : 10);
      return reads[name as keyof typeof reads](selected);
    },
    async projectFor(kind, id) {
      if (kind === "task") return task(id)?.project ?? null;
      if (kind === "pipeline") return domain.readPipelineRecord ? domain.readPipelineRecord(id)?.project ?? null
        : (domain.listPipelineRecords?.() ?? domain.getPipelines().pipelines).find(row => row.id === id)?.project ?? null;
      if(searchHandles.has(id)) return searchHandles.get(id)!.project;
      const selected = domain.selectedContext?.selectedConversation().resolve(id);
      return selected?.project ?? null;
    },
    recipient: project => orchestratorSeatFor(project).active?.conversationId ?? null,
    resolveProject(current, requested) {
      if (!requested) { if (!current) throw new Error("PROJECT_REQUIRED"); return canonicalProject(current); }
      if (current && canonicalProject(requested) === canonicalProject(current)) return canonicalProject(current);
      const names = new Map<string, Set<string>>();
      const add = (key: string, name?: string) => {
        key = canonicalProject(key);
        for (const value of [key, name, reportHeaderName(key)]) if (value) {
          const label = value.trim().toLowerCase(); const keys = names.get(label) ?? new Set<string>(); keys.add(key); names.set(label, keys);
        }
      };
      for (const [key, name] of Object.entries(projectAliasSnapshot().displayNames)) add(key, name);
      for (const row of projectCurationSnapshot().manualProjects) add(row.project, row.displayName);
      for (const row of conversationCatalogSnapshot()) add(row.project, row.projectName);
      for (const seat of activeOrchestratorSeats()) add(seat.project);
      const matches = names.get(requested.trim().toLowerCase());
      if (matches?.size !== 1) throw new Error(matches?.size ? "PROJECT_AMBIGUOUS" : "PROJECT_REFUSED");
      return [...matches][0]!;
    },
    review(id) { const row = task(id); if (!row) throw new Error("PROJECT_REFUSED"); return readPrototypeReviews(row); },
    async frame(id, reviewId, mediaId) {
      const row = task(id); const review = row && readPrototypeReviews(row).rounds.find(round => round.id === reviewId);
      const media = review?.variants.flatMap(variant => variant.frames.flatMap(frame => [frame.image, ...(frame.original ? [frame.original] : [])]))
        .find(media => media.id === mediaId && media.available);
      if (!media || !media.mime.startsWith("image/") || media.bytes > 4 * 1024 * 1024) throw new Error("FRAME_UNAVAILABLE");
      const candidate = storedMediaPath(await fs.realpath(prototypeRoot()), reviewId, media);
      const file = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== media.bytes || !await openedAt(file, candidate)) throw new Error("FRAME_UNAVAILABLE");
        const bytes = Buffer.alloc(media.bytes); let offset = 0;
        while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new Error("FRAME_UNAVAILABLE"); offset += read.bytesRead; }
        if (!sniffPrototype(media.mime, bytes.subarray(0,512)) || createHash("sha256").update(bytes).digest("hex") !== media.id) throw new Error("FRAME_UNAVAILABLE");
        return { mime: media.mime, data: bytes.toString("base64") };
      } finally { await file.close(); }
    },
  };
}
export const companionBoardReadPaths = createCompanionBoardReadPaths();
