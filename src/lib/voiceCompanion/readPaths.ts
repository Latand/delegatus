import { namedProjectDirectory, resolveNamedProject, ProjectNameRefusal } from "@/lib/projects/nameResolution";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { transcriptSearchPage } from "@/lib/search/transcriptSearchPage";
import { viewerReadTools, productionDomainDependencies, type ViewerMcpDomainDependencies } from "@/lib/mcp/bindings";
import { boardSelection } from "@/lib/mcp/boardSelection";
import { budgetPage } from "@/lib/mcp/budgetPage";
import type { AgentLivenessSources } from "@/lib/lifecycle/liveness";
import { canonicalProject } from "@/lib/projects/aliases";
import { orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { readPrototypeReviews } from "@/lib/prototypeReview/read";
import { prototypeRoot, storedMediaPath, sniffPrototype } from "@/lib/prototypeReview/store";
import { openedAt } from "@/lib/artifact/localFile";
import type { BoardReadPaths } from "./boardReads";

/** In-process reads use the same implementations as MCP, without receipts or
 * lifecycle-journal writes. Search reuses its ordinary page handler. */
export function createCompanionBoardReadPaths(dependencies: { domain?: ViewerMcpDomainDependencies; liveness?: AgentLivenessSources;
  transcript?: Pick<ViewerMcpDomainDependencies, "pinnedTranscript" | "selectedContext"> } = {}): BoardReadPaths {
  const domain = { ...(dependencies.domain ?? productionDomainDependencies), fleetDetailBudgetBytes: 3_200, ...dependencies.transcript,
    // These reads belong to the authenticated operator's voice session.
    callerAttribution: () => ({ kind: "gateway" as const, conversationId: null, role: null }),
    ...(dependencies.liveness ? { livenessSources: () => dependencies.liveness! } : {}),
    refreshLifecycleJournal: () => ({ appended: 0 }) as ReturnType<ViewerMcpDomainDependencies["refreshLifecycleJournal"]>,
  };
  const searchHandles = new Map<string,{path:string;project:string}>();
  const activityPages = new WeakMap<(text: string) => string, object>();
  const defaultRedactor = (text: string) => text;
  const readsFor = (redactText?: (text: string) => string) => viewerReadTools(domain, { get: async pathname => {
    const answer = await transcriptSearchPage(new Request(`http://127.0.0.1${pathname}`), redactText);
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
    call: (name, args, redactText = defaultRedactor) => {
      const reads = readsFor(redactText);
      const context = { redactText };
      const target = name === "conversation_messages" || name === "agent_activity" ? searchHandles.get(String(args.conversationId)) : null;
      const selected = target ? {...args,conversationId:undefined,transcriptPath:target.path} : args;
      if (name === "agent_activity") {
        let pageOwner = activityPages.get(redactText);
        if (!pageOwner) { pageOwner = {}; activityPages.set(redactText,pageOwner); }
        return budgetPage(pageOwner, name, args, 4000, async () => {
          const source = await reads.agent_activity({ ...selected, cursor: undefined, limit: 200 }, context);
          const { conversations, ...meta } = source;
          return { rows: conversations as Record<string, unknown>[], meta: { ...meta, total: source.count }, upstream: null };
        }, false, typeof args.limit === "number" ? args.limit : 10);
      }
      return reads[name as keyof typeof reads](selected, context);
    },
    async projectFor(kind, id) {
      if (kind === "task") return task(id)?.project ?? null;
      if (kind === "pipeline") return domain.readPipelineRecord ? domain.readPipelineRecord(id)?.project ?? null
        : (domain.listPipelineRecords?.() ?? domain.getPipelines().pipelines).find(row => row.id === id)?.project ?? null;
      if(searchHandles.has(id)) return searchHandles.get(id)!.project;
      const selected = domain.selectedContext?.selectedConversation().resolve(id);
      return selected?.project ?? null;
    },
    projects() {
      const tasks = domain.taskSelectionSource?.();
      const records = tasks ? [] : (domain.listTaskRecords?.() ?? domain.loadTasks());
      const counts = tasks ? boardSelection(tasks.filename, "tasks").openTaskCounts(tasks)
        : [...new Set(records.map(row => row.project))].map(project => ({ project, count: records.filter(row => row.project === project && ["inbox", "assigned", "blocked"].includes(row.status)).length }));
      const pipelines = domain.pipelineSelectionSource?.();
      const keys = pipelines ? boardSelection(pipelines.filename, "pipelines").projectKeys(pipelines)
        : (domain.listPipelineRecords?.() ?? domain.getPipelines().pipelines).map(row => row.project);
      const directory = namedProjectDirectory(domain, [...counts.map(row => row.project), ...keys]);
      const totals = new Map<string, number>();
      for (const row of counts) { const key = directory.canonical(row.project); totals.set(key, (totals.get(key) ?? 0) + row.count); }
      return [...directory.labels].map(([project, displayName]) => ({ project, displayName, liveSeat: directory.active.has(project), openTaskCount: totals.get(project) ?? 0 }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.project.localeCompare(b.project));
    },
    recipient: project => orchestratorSeatFor(project).active?.conversationId ?? null,
    resolveProject(current, requested) {
      if (!requested && !current) throw new Error("PROJECT_REQUIRED");
      const tasks = domain.taskSelectionSource?.();
      const pipelines = domain.pipelineSelectionSource?.();
      const keys = [
        ...(tasks ? boardSelection(tasks.filename, "tasks").projectKeys(tasks) : (domain.listTaskRecords?.() ?? domain.loadTasks()).map(row => row.project)),
        ...(pipelines ? boardSelection(pipelines.filename, "pipelines").projectKeys(pipelines) : (domain.listPipelineRecords?.() ?? domain.getPipelines().pipelines).map(row => row.project)),
      ];
      const directory = namedProjectDirectory(domain, keys);
      // An omitted name uses the call's bound identity, even if another
      // project's display label happens to spell that key.
      if (!requested && current && directory.labels.has(directory.canonical(current))) return directory.canonical(current);
      try { return resolveNamedProject(requested ?? current!, directory); }
      catch (error) {
        if (error instanceof ProjectNameRefusal) throw Object.assign(new Error(error.details.code === "ambiguous_project" ? "PROJECT_AMBIGUOUS" : "PROJECT_REFUSED"), { candidates: error.details.candidateNames });
        throw error;
      }
    },
    review(id) { const row = task(id); if (!row) throw new Error("PROJECT_REFUSED"); return readPrototypeReviews(row); },
    prototypeTasks(project, taskId) {
      return (domain.listTaskRecords?.() ?? domain.loadTasks()).filter(row => canonicalProject(row.project) === canonicalProject(project)
        && (taskId ? row.id === taskId : !!row.prototypeReviews?.length || !!row.prototypeReviewReplica));
    },
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
