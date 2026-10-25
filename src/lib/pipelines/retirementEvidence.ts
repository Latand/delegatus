import fs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { performanceSpans } from "@/lib/performanceSpans";
import { readCompactPipelineEvidence, readStateCollectionRevisions, stateEvidenceVersion, type CompactEvidenceCache } from "@/lib/state/sqliteStateStore";
import { isStoredPipeline } from "./store";
import { pipelineAttemptMayBeWorking, pipelineAttemptReleased, pipelinePublicationHoldsHost } from "./hostRetirement";
import type { RuntimeProviderRecoveryRef } from "@/lib/runtime/contracts";
import type { Pipeline } from "./types";

type Claim = { pipeline: string; stage: string | null; attempt: number | null; publishing: boolean; recoverable: boolean; source: boolean; identities: string[] };
type Projection = { id: string; claims: Claim[]; releasedSources: string[] };
type Evidence = { compact: CompactEvidenceCache<Projection>; index: Map<string, Claim[]>; releasedSources: Set<string>; version: string };
type Slot = { value?: Evidence; pending?: Promise<Evidence> };
// One owner across compiled bundles. Two state roots, at most 16 MiB of compact
// claims each; no pipeline payload, report or transcript survives preparation.
const owner = process as typeof process & { __llvRetirementEvidence?: Map<string, Slot> };
const slots = owner.__llvRetirementEvidence ??= new Map<string, Slot>();
const MAX_BYTES = 16 * 1024 * 1024;
const identity = (kind: string, value: string) => JSON.stringify([kind, value]);
function project(raw: unknown): Projection {
  if (!isStoredPipeline(raw)) throw new Error("pipeline retirement ownership is unknown");
  const pipeline: Pipeline = raw;
  const publishing = pipelinePublicationHoldsHost(pipeline);
  const claims: Claim[] = [];
  const releasedSources: string[] = [];
  const add = (stage: string | null, attempt: number | null, values: Array<[string, string | null | undefined]>, recoverable = false) => {
    const identities = values.flatMap(([kind, value]) => value ? [identity(kind, value)] : []);
    if (identities.length) claims.push({ pipeline: pipeline.id, stage, attempt, publishing: !!publishing, recoverable, source: stage === null, identities });
  };
  if (publishing || !["completed", "closed"].includes(pipeline.state)) {
    add(null, null, [["conversation", pipeline.srcConversationId], ["path", pipeline.srcPath]]);
  }
  for (const run of pipeline.runs) {
    const latest = run.attempts.findLast(attempt => !attempt.historical);
    for (const attempt of run.attempts) {
      const activation = attempt.activation && attempt.activation.phase !== "settled";
      const released = pipelineAttemptReleased(pipeline, attempt, latest);
      if (!publishing && released && !activation) {
        for (const [kind, value] of [["conversation", attempt.conversationId], ["path", attempt.agentPath]] as const) {
          if (value) releasedSources.push(identity(kind, value));
        }
      }
      if (!publishing && !activation && (released || !pipelineAttemptMayBeWorking(attempt))) continue;
      add(run.stageId, attempt.n, [["conversation", attempt.conversationId], ["path", attempt.agentPath],
        ["session", attempt.sessionId], ["pane", attempt.paneId], ["launch", attempt.launchId]],
        run === pipeline.runs.find(candidate => candidate.stageId === run.stageId) && attempt === run.attempts.at(-1) && !attempt.historical);
    }
  }
  return { id: pipeline.id, claims, releasedSources };
}

async function prepare(filename: string, previous?: Evidence): Promise<Evidence> {
  const version = stateEvidenceVersion(filename);
  let compact = await readCompactPipelineEvidence(filename, previous?.compact, project);
  if (!compact) {
    const revisions = readStateCollectionRevisions(filename, ["pipelines", "pipelines_archive"]);
    if ([...revisions.values()].some(revision => revision !== null)
      || !absent(path.join(path.dirname(filename), "pipelines.json")) || !absent(path.join(path.dirname(filename), "pipelines-archive.json"))) {
      throw new Error("pipeline retirement evidence is unavailable");
    }
    compact = { identity: filename, rows: new Map() };
  }
  if (version !== stateEvidenceVersion(filename)) throw new Error("pipeline retirement evidence changed");
  if (compact === previous?.compact) return { ...previous, version };
  const index = new Map<string, Claim[]>(), ids = new Set<string>();
  // A released attempt also ends a successor's source-only custody. Keep the
  // other identity and every operational/publication claim independent.
  const releasedSources = new Set<string>();
  let bytes = 0, slice = performance.now();
  for (const { value } of compact.rows.values()) {
    if (ids.has(value.id)) throw new Error("pipeline retirement identities are contradictory");
    ids.add(value.id);
    bytes += Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_BYTES) throw new Error("pipeline retirement evidence exceeds its budget");
    for (const key of value.releasedSources) releasedSources.add(key);
    for (const claim of value.claims) for (const key of claim.identities) {
      const held = index.get(key) ?? []; held.push(claim); index.set(key, held);
    }
    if (performance.now() - slice >= 4) {
      await new Promise<void>(resolve => setTimeout(resolve, 0)); slice = performance.now();
    }
  }
  if (version !== stateEvidenceVersion(filename)) throw new Error("pipeline retirement evidence changed");
  return { compact, index, releasedSources, version };
}

function absent(filename: string): boolean {
  try { fs.statSync(filename); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

export type RetirementTarget = { conversations: readonly string[]; sessionId?: string; agentPath?: string | null; paneId?: string | null; launchId?: string | null };
/** Async validation precedes admission. Each synchronous signal fence performs
 * only version checks and target lookups; any intervening write refuses. */
export async function pipelineRetirementReader(): Promise<(target: RetirementTarget, recovery?: RuntimeProviderRecoveryRef) => boolean> {
  return withViewerOperation("pipelines.retirement-evidence", async () => {
    const filename = statePath("state.sqlite");
    if (absent(filename)) {
      // Positively absent pre-migration stores are empty; legacy data is never
      // silently skipped. A new store appearing invalidates this evidence.
      if (!absent(path.join(path.dirname(filename), "pipelines.json")) || !absent(path.join(path.dirname(filename), "pipelines-archive.json"))) throw new Error("pipeline retirement requires migrated evidence");
      return () => {
        if (statePath("state.sqlite") !== filename || !absent(filename) || !absent(path.join(path.dirname(filename), "pipelines.json")) || !absent(path.join(path.dirname(filename), "pipelines-archive.json"))) throw new Error("pipeline retirement evidence changed");
        return false;
      };
    }
    let slot = slots.get(filename);
    if (!slot) { slot = {}; slots.set(filename, slot); }
    else { slots.delete(filename); slots.set(filename, slot); }
    while (slots.size > 2) slots.delete(slots.keys().next().value!);
    if (slot.value?.version !== stateEvidenceVersion(filename)) {
      const pending = slot.pending ??= prepare(filename, slot.value);
      try { slot.value = await pending; }
      finally { if (slot.pending === pending) slot.pending = undefined; }
    }
    const evidence = slot.value!;
    return (target, recovery) => withViewerOperation("pipelines.retirement-check", () => performanceSpans.sync("controller.ownership", () => {
      if (statePath("state.sqlite") !== filename || evidence.version !== stateEvidenceVersion(filename)) throw new Error("pipeline retirement evidence changed");
      // The caller supplies every alias of this conversation. A release through
      // one alias also ends source custody through another; path custody is
      // independent and publication or an operational claim always survives.
      const releasedConversation = target.conversations.some(id => evidence.releasedSources.has(identity("conversation", id)));
      const keys = [...target.conversations.map(id => ({ key: identity("conversation", id), sourceReleased: releasedConversation })),
        ...([["session", target.sessionId], ["path", target.agentPath], ["pane", target.paneId], ["launch", target.launchId]] as const)
          .flatMap(([kind, value]) => value ? [{ key: identity(kind, value),
            sourceReleased: kind === "path" && evidence.releasedSources.has(identity(kind, value)) }] : [])];
      return keys.some(({ key, sourceReleased }) => evidence.index.get(key)?.some(claim => {
        if (claim.source && !claim.publishing && sourceReleased) return false;
        return !recovery || claim.publishing || !claim.recoverable
          || claim.pipeline !== recovery.pipelineId || claim.stage !== recovery.stageId || claim.attempt !== recovery.attempt;
      }));
    }));
  });
}
