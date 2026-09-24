import {
  agentRegistry,
  readOnlyConversationLookupFromSnapshot,
  type RegistryFile,
} from "@/lib/agent/registry";
import { conversationAgentRole } from "@/lib/agent/spawnAdmission";
import { canonicalProject } from "@/lib/projects/aliases";
import { UNRESOLVED_PROJECT } from "@/lib/projects/identity";
import { readTranscriptActivity, type TranscriptActivityRead } from "@/lib/search/transcriptSearch";
import { statePath } from "@/lib/configDir";

import { readHostsConfig } from "./hostSources";
import { ActivityStore, LOCAL_HOST_KEY, type StoredTurn } from "./store";

import {
  agentTurns,
  NO_ROLE,
  UNREGISTERED_ROLE,
  unionIntervals,
  type AgentConversation,
  type Interval,
} from "./method";

/*
 * The agent axis's source (docs/design/activity-dashboard.md, "Agent axis
 * calculation"). Agent turns come from Delegatus's activity store: this
 * host's ingest reads them from the raw transcripts as they are written, and
 * every host listed with a pull sends its own. Until this host's ingest has
 * finished its first pass, this host's turns are approximated from the
 * transcript search index instead: message rows (path, speaker and time,
 * never a body) joined to the registry for the conversation, its role and its
 * pipeline stage. Transcript paths stay here; what leaves is keyed by
 * conversation.
 */

/** Rows this long before the range are read so a turn that began before it
    and runs into it is seen whole. */
export const TURN_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const CACHE_MS = 60_000;

export interface AgentSourceRead {
  agents: AgentConversation[];
  index: { available: boolean; indexedAtMs: number | null };
  /** Where this host's turns came from: the ingest's own record, or the
      index while the ingest has not finished a pass. */
  local?: "ingest" | "index";
}

export interface AgentSourceDependencies {
  read(fromSec: number, toSec: number): TranscriptActivityRead;
  registrySnapshot(): RegistryFile;
  canonicalProject(project: string): string;
  /** The activity store, read-only; null before anything was recorded. */
  store?(): ActivityStore | null;
  /** The hosts whose turns are pulled here. */
  pulledHosts?(): string[];
}

const productionDependencies: AgentSourceDependencies = {
  read: readTranscriptActivity,
  registrySnapshot: () => agentRegistry().readOnlySnapshot(),
  canonicalProject,
  store: () => ActivityStore.openReadOnly(),
  pulledHosts: () => readHostsConfig(statePath("activity")).hosts.filter((host) => host.pull).map((host) => host.id),
};

/** Stored turns as conversations: each conversation's turns clipped to the
    range and to now, then unioned. */
export function turnConversations(
  turns: readonly StoredTurn[],
  keyPrefix: string,
  range: Interval,
  nowMs: number,
  canonical: (project: string) => string,
): AgentConversation[] {
  const upTo = Math.min(range.end, nowMs);
  const byConversation = new Map<string, AgentConversation>();
  for (const turn of turns) {
    const start = Math.max(turn.start, range.start);
    const end = Math.min(turn.end, upTo);
    if (end <= start) continue;
    const key = `${keyPrefix}${turn.conversation}`;
    const existing = byConversation.get(key);
    if (existing) {
      existing.activity.push({ start, end });
      continue;
    }
    const project = turn.project ? canonical(turn.project) : null;
    byConversation.set(key, {
      key,
      project: project && project !== UNRESOLVED_PROJECT ? project : null,
      engine: turn.engine,
      role: turn.role,
      pipelineId: turn.pipelineId,
      stageId: turn.stageId,
      activity: [{ start, end }],
    });
  }
  for (const conversation of byConversation.values()) conversation.activity = unionIntervals(conversation.activity);
  return [...byConversation.values()];
}

/** Registry provenance of one transcript. */
function provenance(snapshot: RegistryFile, lookup: ReturnType<typeof readOnlyConversationLookupFromSnapshot>, transcriptPath: string) {
  const conversation = lookup.conversationForPath(transcriptPath);
  if (!conversation) return { key: `path:${transcriptPath}`, role: UNREGISTERED_ROLE, pipelineId: null, stageId: null };
  const pipeline = (snapshot.memberships[conversation.id] ?? [])
    .filter((membership) => membership.kind === "pipeline")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return {
    key: conversation.id,
    role: conversationAgentRole(snapshot, conversation.id) ?? NO_ROLE,
    pipelineId: pipeline?.containerId ?? null,
    stageId: pipeline?.stageId ?? null,
  };
}

/**
 * Agent conversations with activity in `range`: each transcript's turns,
 * unioned per registry conversation (a conversation's generations are one
 * agent). The project is the scanner's attribution the index already holds —
 * the one the board groups by — through the project aliases.
 */
export function readAgentConversations(
  range: Interval,
  nowMs: number,
  dependencies: AgentSourceDependencies = productionDependencies,
): AgentSourceRead {
  let store: ActivityStore | null = null;
  try {
    store = dependencies.store?.() ?? null;
  } catch {
    /* No store: this host from the index, and no other host. */
  }
  try {
    const remote: AgentConversation[] = [];
    for (const host of store ? dependencies.pulledHosts?.() ?? [] : []) {
      remote.push(...turnConversations(store!.turns(host, range.start, range.end), `${host}:`, range, nowMs, dependencies.canonicalProject));
    }
    const local = store?.hostState(LOCAL_HOST_KEY);
    if (store && local?.coveredUntil !== null && local?.coveredUntil !== undefined) {
      const agents = turnConversations(store.turns(LOCAL_HOST_KEY, range.start, range.end), "", range, nowMs, dependencies.canonicalProject);
      return { agents: [...agents, ...remote], index: { available: true, indexedAtMs: local.readAt }, local: "ingest" };
    }
    const indexed = readIndexedAgentConversations(range, nowMs, dependencies);
    return { ...indexed, agents: [...indexed.agents, ...remote], local: "index" };
  } finally {
    store?.close();
  }
}

/** This host's agent conversations approximated from the search index. */
function readIndexedAgentConversations(
  range: Interval,
  nowMs: number,
  dependencies: AgentSourceDependencies,
): AgentSourceRead {
  const upTo = Math.min(range.end, nowMs);
  const read = dependencies.read(Math.floor((range.start - TURN_LOOKBACK_MS) / 1_000), Math.ceil(upTo / 1_000));
  if (!read.available) return { agents: [], index: { available: false, indexedAtMs: null } };
  const turns = agentTurns(read.rows, range, nowMs);
  if (!turns.size) return { agents: [], index: { available: true, indexedAtMs: read.indexedAtMs } };
  let snapshot: RegistryFile | null = null;
  try {
    snapshot = dependencies.registrySnapshot();
  } catch {
    /* An unreadable registry leaves every conversation unregistered; the
       agent time itself is still counted. */
  }
  const lookup = snapshot ? readOnlyConversationLookupFromSnapshot(snapshot) : null;
  const byConversation = new Map<string, AgentConversation>();
  for (const [transcriptPath, intervals] of turns) {
    const file = read.files.get(transcriptPath);
    if (!file) continue;
    const joined = snapshot && lookup
      ? provenance(snapshot, lookup, transcriptPath)
      : { key: `path:${transcriptPath}`, role: UNREGISTERED_ROLE, pipelineId: null, stageId: null };
    const project = dependencies.canonicalProject(file.project);
    const existing = byConversation.get(joined.key);
    if (existing) {
      existing.activity = unionIntervals([...existing.activity, ...intervals]);
      continue;
    }
    byConversation.set(joined.key, {
      key: joined.key,
      project: project && project !== UNRESOLVED_PROJECT ? project : null,
      engine: file.engine,
      role: joined.role,
      pipelineId: joined.pipelineId,
      stageId: joined.stageId,
      activity: intervals,
    });
  }
  return { agents: [...byConversation.values()], index: { available: true, indexedAtMs: read.indexedAtMs } };
}

const cache = new Map<string, { at: number; value: AgentSourceRead }>();
const CACHE_ENTRIES = 6;

/** The same read, kept for a minute per range and zone: switching the range
    back and forth reads the index once, and a turn appears only after the
    next index pass anyway. */
export function cachedAgentConversations(cacheKey: string, range: Interval, nowMs: number): AgentSourceRead {
  const hit = cache.get(cacheKey);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.value;
  const value = readAgentConversations(range, nowMs);
  cache.delete(cacheKey);
  cache.set(cacheKey, { at: nowMs, value });
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return value;
}
