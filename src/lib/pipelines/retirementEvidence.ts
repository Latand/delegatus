import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { AGENT_STATE_POLICY } from "@/lib/agentState/model";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { performanceSpans } from "@/lib/performanceSpans";
import { pipelineEvidenceRevision, readCompactPipelineEvidence, readStateCollectionRevisions, stateEvidenceVersion, type CompactEvidenceCache } from "@/lib/state/sqliteStateStore";
import { isStoredPipeline } from "./store";
import { pipelineRetirementOwnership, type PipelineRetirementReason } from "./hostRetirement";
import type { RuntimeEngine, RuntimeProviderRecoveryRef } from "@/lib/runtime/contracts";
import type { Pipeline } from "./types";
import { readRecorded, recordedHostHeld } from "@/lib/recordedChecks/store";

type Reason = { name: PipelineRetirementReason; expiresAt: number };
type Claim = { pipeline: string; stage: string | null; attempt: number | null; publishing: boolean; recoverable: boolean; source: boolean; fenced: boolean; identities: string[]; reason?: Reason };
type Projection = { id: string; claims: Claim[]; releasedSources: string[] };
type Evidence = { compact: CompactEvidenceCache<Projection>; index: Map<string, Claim[]>; releasedSources: Set<string>; version: string; nextExpiry: number };
type Slot = { value?: Evidence; pending?: Promise<Evidence> };
// One owner across compiled bundles. Two cache entries, at most 16 MiB of compact
// claims each; no pipeline payload, report or transcript survives preparation.
const owner = process as typeof process & { __llvRetirementEvidence?: Map<string, Slot> };
const slots = owner.__llvRetirementEvidence ??= new Map<string, Slot>();
const MAX_BYTES = 16 * 1024 * 1024;
const pipelineCollections = ["pipelines", "pipelines_archive"];
const identity = (kind: string, value: string) => JSON.stringify([kind, value]);
const hostIdentity = (engine: string, sessionId: string) => ["engine-session", `${engine}:${sessionId}`] as const;
function timestamp(value: string | null | undefined): number {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : -Infinity;
}

function project(raw: unknown, now: number, idleMs: number): Projection {
  if (!isStoredPipeline(raw)) throw new Error("pipeline retirement ownership is unknown");
  const pipeline: Pipeline = raw;
  const { publishing, sourceHeld, attempts } = pipelineRetirementOwnership(pipeline);
  const laneSettledAt = Math.max(timestamp(pipeline.closedAt), timestamp(pipeline.merge?.mergedAt));
  const claims: Claim[] = [];
  const releasedSources: string[] = [];
  const add = (stage: string | null, attempt: number | null, values: ReadonlyArray<readonly [string, string | null | undefined]>, options?: {
    recoverable?: boolean; fenced?: boolean; reason?: Reason;
  }) => {
    const identities = values.flatMap(([kind, value]) => value ? [identity(kind, value)] : []);
    if (identities.length) claims.push({ pipeline: pipeline.id, stage, attempt, publishing,
      recoverable: options?.recoverable ?? false, fenced: options?.fenced ?? publishing,
      source: stage === null, identities, ...(options?.reason ? { reason: options.reason } : {}) });
  };
  if (sourceHeld) {
    add(null, null, [["conversation", pipeline.srcConversationId], ["path", pipeline.srcPath]]);
  }
  for (const { stageId, attempt, identities, held, released, reason, recoverable, fenced } of attempts) {
    if (released) {
      for (const [kind, value] of [["conversation", attempt.conversationId], ["path", attempt.agentPath]] as const) {
        if (value) releasedSources.push(identity(kind, value));
      }
    }
    if (held) add(stageId, attempt.n, identities.flatMap(host => [["conversation", host.conversationId], ["path", host.agentPath],
      ["session", host.sessionId], ["pane", host.paneId], ["launch", host.launchId]] as const), { recoverable, fenced });
    if (reason) {
      const attemptSettledAt = Math.max(timestamp(attempt.completedAt), timestamp(attempt.report?.at));
      const settledAt = reason === "terminal lane" ? Math.max(laneSettledAt, attemptSettledAt) : attemptSettledAt;
      const expiresAt = (Number.isFinite(settledAt) ? settledAt : timestamp(attempt.startedAt ?? pipeline.createdAt)) + idleMs;
      // A conversation alias can outlive the native generation. Bind the
      // short-lived waiver to its recorded session or legacy artifact/launch.
      if (expiresAt > now) add(stageId, attempt.n, [attempt.sessionId ? hostIdentity(attempt.effectiveRole.engine, attempt.sessionId)
        : attempt.agentPath ? ["path", attempt.agentPath] : ["launch", attempt.launchId]], { reason: { name: reason, expiresAt } });
    }
  }
  return { id: pipeline.id, claims, releasedSources };
}

function pipelineVersion(filename: string): string {
  const indexed = pipelineEvidenceRevision(filename);
  if (indexed !== null) {
    const revisions = readStateCollectionRevisions(filename, pipelineCollections);
    const active = revisions.get("pipelines"), archive = revisions.get("pipelines_archive");
    if (active != null && archive != null) return `${indexed}:${active}:${archive}`;
  }
  return stateEvidenceVersion(filename);
}

async function prepare(filename: string, version: string, now: number, idleMs: number, previous?: Evidence): Promise<Evidence> {
  let compact = await readCompactPipelineEvidence(filename, previous?.compact, raw => project(raw, now, idleMs));
  if (!compact) {
    const revisions = readStateCollectionRevisions(filename, pipelineCollections);
    if ([...revisions.values()].some(revision => revision !== null)
      || !absent(path.join(path.dirname(filename), "pipelines.json")) || !absent(path.join(path.dirname(filename), "pipelines-archive.json"))) {
      throw new Error("pipeline retirement evidence is unavailable");
    }
    compact = { identity: filename, rows: new Map() };
  }
  if (version !== pipelineVersion(filename)) throw new Error("pipeline retirement evidence changed");
  if (compact === previous?.compact) {
    if (previous.nextExpiry > now) return { ...previous, version };
    // Elapsed time can reclaim compact claims even when no row was edited.
    compact = { ...compact, rows: new Map(compact.rows) };
  }
  const index = new Map<string, Claim[]>(), ids = new Set<string>();
  // A released attempt also ends a successor's source-only custody. Keep the
  // other identity and every operational/publication claim independent.
  const releasedSources = new Set<string>();
  let bytes = 0, nextExpiry = Infinity, slice = performance.now();
  for (const [key, row] of compact.rows) {
    let { value } = row;
    if (ids.has(value.id)) throw new Error("pipeline retirement identities are contradictory");
    ids.add(value.id);
    if (value.claims.some(claim => claim.reason && claim.reason.expiresAt <= now)) {
      value = { ...value, claims: value.claims.filter(claim => !claim.reason || claim.reason.expiresAt > now) };
      compact.rows.set(key, { ...row, value });
    }
    bytes += Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_BYTES) throw new Error("pipeline retirement evidence exceeds its budget");
    for (const key of value.releasedSources) releasedSources.add(key);
    for (const claim of value.claims) {
      if (claim.reason) nextExpiry = Math.min(nextExpiry, claim.reason.expiresAt);
      for (const identityKey of claim.identities) {
        const held = index.get(identityKey) ?? []; held.push(claim); index.set(identityKey, held);
      }
    }
    if (performance.now() - slice >= 4) {
      await new Promise<void>(resolve => setTimeout(resolve, 0)); slice = performance.now();
    }
  }
  if (version !== pipelineVersion(filename)) throw new Error("pipeline retirement evidence changed");
  return { compact, index, releasedSources, version, nextExpiry };
}

function absent(filename: string): boolean {
  try { fs.statSync(filename); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

export type RetirementTarget = { conversations: readonly string[]; engine?: RuntimeEngine; sessionId?: string; agentPath?: string | null; paneId?: string | null; launchId?: string | null };
export type PipelineRetirementStanding = "held" | PipelineRetirementReason | null;
export type PipelineRetirementReader = ((target: RetirementTarget, recovery?: RuntimeProviderRecoveryRef) => boolean)
  & { sweepStanding(target: RetirementTarget): PipelineRetirementStanding };
/** Async validation precedes admission. The sweep refreshes the projection
 * after waits and fences synchronously on pipeline revisions and target custody. */
export async function pipelineRetirementReader(
  { now = Date.now(), idleMs = AGENT_STATE_POLICY.idleMs }: { now?: number; idleMs?: number } = {},
): Promise<PipelineRetirementReader> {
  return withViewerOperation("pipelines.retirement-evidence", async () => {
    const recordedVersion = readRecorded(store => store.version(), 0);
    const recorded = (target: RetirementTarget) => {
      if (readRecorded(store => store.version(), 0) !== recordedVersion) throw new Error("recorded check retirement evidence changed");
      return target.conversations.some(recordedHostHeld);
    };
    const filename = statePath("state.sqlite");
    if (absent(filename)) {
      // Positively absent pre-migration stores are empty; legacy data is never
      // silently skipped. A new store appearing invalidates this evidence.
      if (!absent(path.join(path.dirname(filename), "pipelines.json")) || !absent(path.join(path.dirname(filename), "pipelines-archive.json"))) throw new Error("pipeline retirement requires migrated evidence");
      const held = (target: RetirementTarget, sweep: boolean) => {
        if (sweep ? target.conversations.some(recordedHostHeld) : recorded(target)) return true;
        if (statePath("state.sqlite") !== filename || !absent(filename) || !absent(path.join(path.dirname(filename), "pipelines.json")) || !absent(path.join(path.dirname(filename), "pipelines-archive.json"))) throw new Error("pipeline retirement evidence changed");
        return false;
      };
      return Object.assign((target: RetirementTarget) => held(target, false),
        { sweepStanding: (target: RetirementTarget) => held(target, true) ? "held" as const : null });
    }
    const key = JSON.stringify([filename, idleMs]);
    let slot = slots.get(key);
    if (!slot) { slot = {}; slots.set(key, slot); }
    else { slots.delete(key); slots.set(key, slot); }
    while (slots.size > 2) slots.delete(slots.keys().next().value!);
    const databaseVersion = stateEvidenceVersion(filename);
    const version = pipelineVersion(filename);
    if (slot.value?.version !== version || slot.value.nextExpiry <= now) {
      const pending = slot.pending ??= prepare(filename, version, now, idleMs, slot.value);
      try { slot.value = await pending; }
      finally { if (slot.pending === pending) slot.pending = undefined; }
    }
    const evidence = slot.value!;
    const standing = (target: RetirementTarget, sweep: boolean, recovery?: RuntimeProviderRecoveryRef): PipelineRetirementStanding => withViewerOperation("pipelines.retirement-check", () => performanceSpans.sync("controller.ownership", () => {
      if (sweep ? target.conversations.some(recordedHostHeld) : recorded(target)) return "held";
      if (statePath("state.sqlite") !== filename || (sweep
        ? evidence.version !== pipelineVersion(filename)
        : evidence.version !== version || databaseVersion !== stateEvidenceVersion(filename))) throw new Error("pipeline retirement evidence changed");
      // The caller supplies every alias of this conversation. A release through
      // one alias also ends source custody through another; path custody is
      // independent and publication or an operational claim always survives.
      const releasedConversation = target.conversations.some(id => evidence.releasedSources.has(identity("conversation", id)));
      const keys = [...target.conversations.map(id => ({ key: identity("conversation", id), sourceReleased: releasedConversation })),
        ...([["session", target.sessionId], ["path", target.agentPath], ["pane", target.paneId], ["launch", target.launchId]] as const)
          .flatMap(([kind, value]) => value ? [{ key: identity(kind, value),
            sourceReleased: kind === "path" && evidence.releasedSources.has(identity(kind, value)) }] : [])];
      if (target.engine && target.sessionId) keys.push({ key: identity(...hostIdentity(target.engine, target.sessionId)), sourceReleased: false });
      let reason: PipelineRetirementReason | null = null;
      let ordinaryIdle = false;
      for (const { key, sourceReleased } of keys) for (const claim of evidence.index.get(key) ?? []) {
        if (claim.reason) {
          if (claim.reason.expiresAt > now && (!reason || claim.reason.name === "terminal lane")) reason = claim.reason.name;
          continue;
        }
        if (claim.source && !claim.publishing && sourceReleased) continue;
        if (recovery && !claim.publishing && claim.recoverable
          && claim.pipeline === recovery.pipelineId && claim.stage === recovery.stageId && claim.attempt === recovery.attempt) continue;
        if (!sweep || claim.fenced) return "held";
        // Ordinary pipeline ownership withholds the quiet-interval waiver.
        // The sweep's runtime checks still govern idle and abandoned hosts.
        ordinaryIdle = true;
      }
      return ordinaryIdle ? null : reason;
    }));
    return Object.assign((target: RetirementTarget, recovery?: RuntimeProviderRecoveryRef) => standing(target, false, recovery) === "held",
      { sweepStanding: (target: RetirementTarget) => standing(target, true) });
  });
}
