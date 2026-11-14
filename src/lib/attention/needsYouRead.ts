import type { BridgeReportLogV1 } from "@/lib/bridge/types";
import type { Locale } from "@/lib/i18n/core";
import { orchestratorSeatFor } from "@/lib/orchestrator/seats";
import type { Pipeline } from "@/lib/pipelines/types";
import type { AutoView } from "@/lib/selfUpdate/auto";
import type { BoardTask } from "@/lib/tasks/types";
import type { AttentionDismissalV1 } from "./dismissals";
import { needsYouAnswer, needsYouEntries, type NeedsYouAnswer, type NeedsYouBody, type NeedsYouReadOptions, type NeedsYouRowKind } from "./needsYouProjection";

export * from "./needsYouProjection";

/** Sources are selected before imports or reads. Each wait shares the route's cutoff. */
export interface NeedsYouReadSources {
  seat?(project: string, signal: AbortSignal): Promise<string | null>;
  board(signal: AbortSignal): Promise<NeedsYouBody>;
  tasks(signal: AbortSignal): Promise<readonly BoardTask[]>;
  pipelines(signal: AbortSignal): Promise<readonly Pipeline[]>;
  dismissals(signal: AbortSignal): Promise<AttentionDismissalV1[]>;
  reports(signal: AbortSignal): Promise<BridgeReportLogV1 | null>;
  admissions(signal: AbortSignal): Promise<{ conversationId: string; at: string }[]>;
  identity(signal: AbortSignal): Promise<(id: string) => string>;
  ended(project: string, signal: AbortSignal, remainingMs: number): Promise<{ ids: Set<string>; complete: boolean }>;
  decision(signal: AbortSignal): Promise<AutoView["decision"]>;
  locale(signal: AbortSignal): Promise<Locale>;
}
const productionSources: NeedsYouReadSources = {
  seat: async project => orchestratorSeatFor(project).active?.conversationId ?? null,
  board: async signal => (await import("@/app/api/files/operatorProjection")).operatorBoardRepresentation(signal),
  tasks: async signal => { const store = await import("@/lib/tasks/store"); signal.throwIfAborted(); return store.loadTasksForList(); },
  pipelines: async signal => { const store = await import("@/lib/pipelines/store"); signal.throwIfAborted(); return store.loadPipelinesForList(); },
  dismissals: async signal => { const store = await import("./dismissals"); signal.throwIfAborted(); return store.readAttentionDismissals().records; },
  reports: async signal => { const store = await import("@/lib/bridge/store"); signal.throwIfAborted(); return store.readBridgeReportLog(); },
  admissions: async signal => { const store = await import("@/lib/suggestions/store"); signal.throwIfAborted(); return store.readReplySuggestionsFile().admissions; },
  identity: async signal => {
    const registry = await import("@/lib/agent/registry");
    signal.throwIfAborted();
    const snapshot = await registry.agentRegistry().prepareReadOnlySnapshot(signal);
    signal.throwIfAborted();
    const lookup = registry.readOnlyConversationLookupFromSnapshot(snapshot);
    return id => lookup.canonicalConversationId(id as `conversation_${string}`);
  },
  ended: async (project, signal, remainingMs) => {
    const liveness = await import("@/lib/lifecycle/liveness");
    signal.throwIfAborted();
    const snapshot = await liveness.agentLivenessSnapshot({ project, signal, limit: 200, evidenceDeadlineMs: Math.min(1000, remainingMs) }, liveness.productionLivenessSources());
    return { ids: new Set(snapshot.conversations.filter(row => row.lifecycle === "gone" && row.conversationId).map(row => row.conversationId!)), complete: snapshot.selection.budget === "complete" };
  },
  decision: async signal => { const store = await import("@/lib/selfUpdate/instance"); signal.throwIfAborted(); return (await store.selfUpdateService().snapshot()).auto?.decision ?? null; },
  locale: async signal => { const store = await import("@/lib/operator/settings"); signal.throwIfAborted(); return store.operatorLocale() ?? "en"; },
};

export const NEEDS_YOU_READ_BUDGET_MS = 3500;
export async function readNeedsYou(project: string, options: NeedsYouReadOptions = {}, order: "panel" | "stale-first" = "panel", sources: NeedsYouReadSources = productionSources): Promise<NeedsYouAnswer> {
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + NEEDS_YOU_READ_BUDGET_MS);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error("attention read budget exhausted")), Math.max(0, deadlineAt - Date.now()));
  const unavailable: string[] = [];
  const omissions: string[] = [];
  const source = async <T>(name: string, read: (signal: AbortSignal) => Promise<T>, fallback: T): Promise<T> => {
    if (signal.aborted || Date.now() >= deadlineAt) { omissions.push(name); return fallback; }
    let abort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      const value = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return read(signal); }), cancelled]);
      // A native read can run beyond expiry before its timer gets a turn.
      if (signal.aborted || Date.now() >= deadlineAt) { omissions.push(name); return fallback; }
      return value;
    } catch { unavailable.push(name); omissions.push(name); return fallback; }
    finally { signal.removeEventListener("abort", abort); }
  };
  try {
    const wants = (kinds: readonly NeedsYouRowKind[]) => !options.kinds || options.kinds.some(kind => kinds.includes(kind));
    const conversations = wants(["decision", "question", "plan", "permission", "delivery", "launch", "memory", "ask"]);
    const boardNeeded = conversations || wants(["lane-decision", "lane-review", "prototype"]);
    const body = boardNeeded ? await source("board", () => sources.board(signal), { files: [], pipelines: [], tasks: [] }) : { files: [], pipelines: [], tasks: [] };
    const tasks = boardNeeded ? await source("tasks", sources.tasks, []) : [];
    const pipelines = boardNeeded ? await source("pipelines", sources.pipelines, []) : [];
    const seatConversationId = wants(["prototype"]) && sources.seat ? await source("seat", signal => sources.seat!(project, signal), null) : null;
    const dismissals = boardNeeded ? await source("dismissals", sources.dismissals, []) : [];
    const reports = wants(["decision"]) ? await source("bridge", sources.reports, null) : null;
    const admissions = conversations ? await source("reply-suggestions", sources.admissions, []) : [];
    const canonicalConversationId = conversations ? await source("identity", sources.identity, (id: string) => id) : (id: string) => id;
    const liveness = conversations ? await source("liveness", () => sources.ended(project, signal, Math.max(0, deadlineAt - Date.now())), { ids: new Set<string>(), complete: false }) : { ids: new Set<string>(), complete: true };
    if (!liveness.complete) { unavailable.push("liveness"); omissions.push("liveness"); }
    const decision = wants(["update"]) ? await source("self-update", sources.decision, null) : null;
    const locale = options.locale ?? await source("locale", sources.locale, "en");
    if (needsYouEntries(body, null, Date.now() / 1000, project).some(entry => entry.kind === "pipeline" && (!body.workLinks?.pipelines[entry.row.pipeline.id] || body.workLinks.pipelines[entry.row.pipeline.id].links.some(link => link.kind === "pr" && link.state === null)))) unavailable.push("forge");
    // A partial collection cannot validate a cursor into missing data.
    const answer = needsYouAnswer(body, decision, Date.now() / 1000, project, { tasks, pipelines, dismissals, reports, admissions, seatConversationId, ended: liveness.ids, canonicalConversationId, workLinks: body.workLinks, unavailable }, { ...options, signal, deadlineAt, ...(omissions.length ? { cursor: undefined } : {}), locale }, order);
    if (omissions.length) Object.assign(answer, { partial: true, omissions: [...new Set([...omissions, ...(answer.omissions ?? [])])], countIsLowerBound: true });
    while (Buffer.byteLength(JSON.stringify(answer)) > 24_000 && answer.rows.length) { answer.rows.pop(); answer.omittedCount++; }
    if (answer.partial) delete answer.nextCursor;
    return answer;
  } finally { clearTimeout(timer); }
}
