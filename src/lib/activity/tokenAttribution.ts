import { agentRegistry, type RegistryConversation, type RegistryFile } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { claudeTranscriptOwnership } from "@/lib/accounts/claude";
import { codexHomeOwningSessionPath, listCodexAccounts } from "@/lib/accounts/codex";
import { findPipelineRecord } from "@/lib/pipelines/store";
import { existingTeamStore } from "@/lib/team/store";
import { accountKey, type UsageAttribution } from "./tokenUsage";
import type { TranscriptFacts } from "./transcriptExport";

export interface LaunchMemberDependencies {
  snapshot(id: string): RegistryFile | null;
  started(id: string, action: "agent.started" | "task.created"): string | null;
  spawnAuthor(launchIds: string[]): string | null;
  majority(id: string): string | null;
  pipeline(id: string): { srcConversationId: string | null; taskIds: string[] } | null;
}
const production: LaunchMemberDependencies = {
  snapshot(id) {
    const registry = agentRegistry();
    const conversation = registry.conversation(id as ViewerConversationId);
    const file = conversation?.generations.at(-1)?.path;
    return file ? registry.activityConversationSnapshot(file) : null;
  },
  started(id, action) {
    const event = existingTeamStore()?.events({ subjectId: id, actions: [action], limit: 50 }).findLast(e => e.actor.kind === "member");
    return event?.actor.kind === "member" ? event.actor.memberId : null;
  },
  spawnAuthor(ids) {
    const authors = existingTeamStore()?.messageAuthors(ids.map(id => `spawn_${id}`));
    for (const id of ids) { const row = authors?.get(`spawn_${id}`); if (row) return row.memberId; }
    return null;
  },
  majority(id) {
    return existingTeamStore()?.majorityMessageAuthor(id) ?? null;
  },
  pipeline: findPipelineRecord,
};

/** One cache per ingest pass; only keys on this conversation's launch chain are read. */
export function launchMemberResolver(overrides: Partial<LaunchMemberDependencies> = {}) {
  const deps = { ...production, ...overrides };
  const cache = new Map<string, string>();
  return (id: string, initial: RegistryFile, mode: "solo" | "team"): string => {
    if (mode === "solo") return "operator";
    const visited = new Set<string>();
    const resolve = (key: string, snapshot: RegistryFile | null, depth: number): string | null => {
      if (cache.has(key)) return cache.get(key)!;
      if (depth >= 8 || visited.size >= 8 || visited.has(key)) return null;
      visited.add(key);
      snapshot ??= deps.snapshot(key);
      const conversation = snapshot?.conversations[key];
      const receipts = Object.values(snapshot?.receipts ?? {}).filter(r => r.conversationId === key).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let member = deps.started(key, "agent.started") ?? deps.spawnAuthor(receipts.map(r => r.launchId));
      const parent = snapshot?.lineageEdges[key]?.parentConversationId ?? conversation?.launcher?.conversationId
        ?? receipts.find(r => r.parentConversationId)?.parentConversationId;
      if (!member && parent) member = resolve(parent, null, depth + 1);
      if (!member) {
        const stages = [...(snapshot?.memberships[key] ?? [])].filter(m => m.kind === "pipeline").sort((a,b) => b.createdAt.localeCompare(a.createdAt));
        const pipeline = stages[0] ? deps.pipeline(stages[0].containerId) : null;
        if (pipeline?.srcConversationId) member = resolve(pipeline.srcConversationId, null, depth + 1);
        if (!member) for (const task of pipeline?.taskIds ?? []) { member = deps.started(task, "task.created"); if (member) break; }
      }
      member ??= deps.majority(key);
      if (member) cache.set(key, member);
      return member;
    };
    try { const member = resolve(id, initial, 0) ?? "unattributed"; cache.set(id, member); return member; }
    catch { return "unattributed"; }
  };
}

/** Select the generation at the response's time, retaining account changes within a piece. */
export function usageAttribution(facts: TranscriptFacts, conversation: RegistryConversation | null, member: string): (at: number) => UsageAttribution {
  const profiles=[...(conversation?.generations??[])].sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt));
  const generations = profiles.filter(g => g.path === facts.path || conversation?.continuityPaths.includes(facts.path));
  let fallback: string | undefined;
  return at => {
    const generation = generations.findLast(g => Date.parse(g.createdAt) <= at);
    const profile=generation?.launchProfile??profiles.findLast(g=>Date.parse(g.createdAt)<=at)?.launchProfile;
    if (!generation?.accountId && fallback === undefined) {
      fallback = "unknown";
      try {
        if (facts.engine === "codex") {
          const home = codexHomeOwningSessionPath(facts.path);
          const found = listCodexAccounts().find(a => a.home === home)?.id;
          fallback = found ? accountKey("codex", found) : "unknown";
        } else {
          const owner = claudeTranscriptOwnership(facts.path);
          if (owner.kind === "owned" && (owner.source === "path" || owner.source === "recorded")) fallback = accountKey("claude", owner.accountId);
        }
      } catch { /* An inaccessible store cannot prove an account. */ }
    }
    return { account: generation?.accountId ? accountKey(facts.engine, generation.accountId) : fallback ?? "unknown", member,
      model: profile?.model ?? null, tier: profile?.serviceTier ?? null };
  };
}
