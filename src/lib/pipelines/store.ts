import { withdrawPipelineMerge } from "./mergeSuccessor";
import { hostTerminationCheckpointCurrent, hostTerminationKey } from "./hostTerminationProof";
import { settleAttemptAccounting } from "./attemptAccounting";
import { declaredClassSchema } from "./accounting";
import { settleClosedPipelineAttempts } from "./closeAttempts";
import { assertPipelineNotRetiring, admitAttemptRetirement } from "./retirementClaim";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { agentRegistry } from "@/lib/agent/registry";
import { defaultStageFailEdge } from "./failEdgeBudget";
import { projectStoreSignature } from "@/lib/projects/persistence";
import { mergePublicationRecovery, publicationInterrupted, PUBLICATION_RETRY_DELAYS_MS, recordPublicationFailure, recoverablePublication } from "./publicationHistory";
import { deepFreeze } from "@/lib/deepFreeze";
import { forEachCooperatively, yieldToRuntime } from "@/lib/cooperative";
import { controllerPipelineKeys, controllerReferences, inheritControllerGuards } from "./controllerScope";
import { StateLockDeferredError, outsideStateLockWait, stateLockAttempt, stateLockProcessKind, waitForStateLock } from "@/lib/state/lockWait";
import { withWaitCorrelation } from "@/lib/blockingWaits";
import crypto from "node:crypto";
import { performanceSpans } from "@/lib/performanceSpans";
import { AsyncLocalStorage } from "node:async_hooks";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import fs from "node:fs";
import path from "node:path";
import { pipelineHasPullRequest } from "@/lib/forge/resolve";
import { deliveryPullRequestRepository } from "@/lib/forge/workLinks";
import { statePath } from "@/lib/configDir";
import { canonicalProject, projectAliasSnapshot, projectAliasResolver } from "@/lib/projects/aliases";
import { canonicalProjectKeys, replaceProjectKeySource } from "@/lib/projects/projectKeyIndex";
import { FileTransactionBusyError, refuseBusyBeforeAdmission } from "@/lib/state/fileTransaction";
import { jsonArrayRecordBytes, preservedRecordJson, rememberRecordBytes, registryRecordKey, reportRegistryRecord, stringifyRegistryDocument, type RegistryRecordIssue } from "@/lib/state/registryRecords";
import { initializeStateCollections, stateCollectionsInitialized, pipelineHasIntegrationMetadata, readStateCollectionRevisions, stateEvidenceVersion, pipelineEvidenceRevision, readPipelineRowsForTask, readRecipientPipelineEvidence, type PipelineRecipientSelection, readCompactPipelineEvidence, type CompactEvidenceCache, visitStateCollectionsRows, readStateCollectionsRows, StateSnapshotChangedError, SqliteStateCollection, type StateBoundedTransaction, type StateCollectionSeed } from "@/lib/state/sqliteStateStore";
import type { BoardTask } from "@/lib/tasks/types";
import { pipelineActivitySettled } from "./types";
import type { Pipeline, PipelineCreationIntent, PipelineDeliveryTarget, PipelinePublication, PipelineStage } from "./types";
import { PIPELINES_SCHEMA_VERSION, PIPELINE_ROLE_IDS, isPipeline, needsIntegrationReader, slugify } from "./storedRecord";
export { PIPELINES_SCHEMA_VERSION, isEffectiveRole, pipelineGraphError, isStoredPipeline, isPipelineConversationSource } from "./storedRecord";



/** Same opaque content revision used by MCP record acknowledgements. */
export function pipelineRevision(pipeline: Pipeline): string {
  return crypto.createHash("sha256").update(JSON.stringify(pipeline)).digest("hex");
}

/** Older registries are migrated in memory on load; the file is rewritten in
    the current shape by the next successful mutation, never by a read. */
const MIGRATABLE_SCHEMA_VERSIONS = new Set([2, 3, 4, PIPELINES_SCHEMA_VERSION]);
const pipelinesFile = () => statePath("pipelines.json");
const pipelinesArchiveFile = () => statePath("pipelines-archive.json");
const stateDatabaseFile = () => statePath("state.sqlite");
const artifactsRoot = () => statePath("pipelines");

type PipelineFile = { schemaVersion: number; pipelines: Pipeline[] };

export class PipelineStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PipelineStoreError";
  }
}

function atomicWriteJson(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, stringifyRegistryDocument(value), "utf8");
  fs.renameSync(temp, filePath);
}
function readJson(filePath: string): { raw: unknown; source: string } | undefined {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    return { raw: JSON.parse(source) as unknown, source };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PipelineStoreError(`could not read pipeline registry: ${filePath}`, { cause: error });
  }
}

/** Keyed raw reads keep queued effects fenced even when executable projections
 * correctly exclude an unsupported pipeline. */
export function pipelineRequiresNewerReader(id: string): boolean {
  if (PIPELINES_SCHEMA_VERSION >= 6) return false;
  return pipelineHasIntegrationMetadata(stateDatabaseFile(), id);
}

/** The seeded default action (#353): every pipeline, including a migrated v2
    empty shell, holds at least one implement conversation. Role-less claude/
    read-write defaults keep the seed independent of the role registry, so a
    read-only load can never fail on role resolution. */
function defaultImplementStage(): PipelineStage {
  return {
    id: "implement",
    kind: "run",
    "prompt": "{{task}}",
    next: null,
    onFail: null,
    effectiveRole: { roleId: null, engine: "claude", model: null, effort: null, access: "read-write", promptScaffold: null },
  };
}

/**
 * In-memory v2 → v3 migration (#353). Purely additive on history: every stage
 * gains `onFail: null`, every attempt/cursor gains `input: null` /
 * `activatedBy: null` (truthful "unknown provenance" — the engine's positional
 * fallback keeps an in-flight v2 pipeline running byte-identically), and a
 * zero-stage draft shell is seeded with the default implement stage. The file
 * itself is rewritten as v3 only by the next successful mutation.
 */
function migrateV2Pipeline(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const pipeline = raw as Record<string, unknown>;
  const stages = Array.isArray(pipeline.stages)
    ? (pipeline.stages as unknown[]).map((stage) => (stage && typeof stage === "object" ? { onFail: null, ...(stage as Record<string, unknown>) } : stage))
    : pipeline.stages;
  const runs = Array.isArray(pipeline.runs)
    ? (pipeline.runs as unknown[]).map((run) => (run && typeof run === "object" && Array.isArray((run as { attempts?: unknown }).attempts)
        ? {
            ...(run as Record<string, unknown>),
            attempts: (run as { attempts: unknown[] }).attempts.map((attempt) =>
              (attempt && typeof attempt === "object" ? { input: null, activatedBy: null, ...(attempt as Record<string, unknown>) } : attempt)),
          }
        : run))
    : pipeline.runs;
  const cursor = pipeline.cursor && typeof pipeline.cursor === "object"
    ? { input: null, activatedBy: null, ...(pipeline.cursor as Record<string, unknown>) }
    : pipeline.cursor;
  const migrated: Record<string, unknown> = { ...pipeline, stages, runs, cursor };
  if (migrated.state === "draft" && Array.isArray(migrated.stages) && migrated.stages.length === 0) {
    const seed = defaultImplementStage();
    migrated.stages = [seed];
    migrated.runs = [{ stageId: seed.id, attempts: [] }];
    migrated.cursor = { stageId: seed.id, state: "pending", input: null, activatedBy: null };
  }
  return migrated;
}

function migrateTaskIds(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return { taskIds: [], ...(raw as Record<string, unknown>) };
}

/** v4 accepted review-loop fail edges even though the embedded flow owns every
    review verdict and no engine path could traverse those edges. Clear that
    unreachable configuration before the v5 graph validator runs. */
function migrateReviewLoopFailEdges(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const pipeline = raw as Record<string, unknown>;
  if (!Array.isArray(pipeline.stages)) return raw;
  return {
    ...pipeline,
    ...(pipeline.delivery ? { delivery: structuredClone(pipeline.delivery) } : {}),
    ...(pipeline.creationRequest ? { creationRequest: { ...pipeline.creationRequest } } : {}),
    stages: pipeline.stages.map((stage) => {
      if (!stage || typeof stage !== "object" || Array.isArray(stage)) return stage;
      const record = stage as Record<string, unknown>;
      return record.kind === "review-loop" ? { ...record, onFail: null } : stage;
    }),
  };
}

function migratePipelineRecord(raw: unknown, schemaVersion: number): unknown {
  let migrated = schemaVersion === 2 ? migrateV2Pipeline(raw) : raw;
  if (schemaVersion < 4) migrated = migrateTaskIds(migrated);
  if (schemaVersion < 5) migrated = migrateReviewLoopFailEdges(migrated);
  return migrated;
}

export function loadPipelines(): Pipeline[] {
  return pipelineStore().snapshot();
}

export async function loadPipelinesAsync(): Promise<Pipeline[]> {
  return pipelineStore().snapshotAsync();
}

export function controllerPipelineRowOrder(): number {
  return pipelineStore().pipelineControllerRowOrder();
}

export async function selectControllerPipelines(kind: import("@/lib/state/pipelineControllerIndex").PipelineControllerSelection, throughOrder?: number): Promise<Pipeline[]> {
  return pipelineStore().pipelineControllerSelection(kind, throughOrder, controllerPipelineKeys());
}

/** Indexed row + scheduling generation, including writers that bypass the
 * collection revision. This read never decodes history or waits on a lease. */
export function controllerPipelineVersionNow(id: string): string {
  return pipelineStore().pipelineControllerVersion(id);
}
export async function controllerPipelineVersion(id: string): Promise<string> {
  return withViewerOperation("pipelines.controller-read", () => waitForStateLock("pipelines.controller-version", () => stateLockAttempt("pipelines.controller-version", () => performanceSpans.sync("controller.ownership", () => pipelineStore().pipelineControllerVersion(id)))));
}
export async function findControllerPipeline(id: string): Promise<Pipeline | null> {
  return waitForStateLock("pipelines.controller-candidate", () => stateLockAttempt("pipelines.controller-candidate", () => pipelineStore().pipelineControllerCandidate(id)));
}
export async function controllerAttemptWindow(id: string, after: number, stage: string) {
  return withViewerOperation("pipelines.controller-read", () => waitForStateLock("pipelines.controller-attempts", () =>
    stateLockAttempt("pipelines.controller-attempts", () => performanceSpans.sync("controller.lane", () => ({
      window: pipelineStore().pipelineAttemptWindow(id, after, 16), current: pipelineStore().pipelineCurrentReferences(id, stage),
    })))));
}
export async function controllerOtherTerminalHosts(id: string, selected: readonly number[]): Promise<boolean> {
  return withViewerOperation("pipelines.controller-read", () => waitForStateLock("pipelines.controller-attempts", () =>
    stateLockAttempt("pipelines.controller-attempts", () => performanceSpans.sync("controller.lane", () => pipelineStore().pipelineOtherTerminalHosts(id,selected)))));
}
export async function controllerHostHasLiveWork(target: import("./types").PipelineStageHostRef): Promise<boolean> {
  const identities: Array<[string, string]> = [];
  for (const kind of ["conversationId", "agentPath", "paneId", "launchId"] as const) if (target[kind]) identities.push([kind,target[kind]!]);
  if (target.conversationId) identities.push(["srcConversationId",target.conversationId]);
  if (target.agentPath) identities.push(["srcPath",target.agentPath]);
  return withViewerOperation("pipelines.controller-read", () => waitForStateLock("pipelines.controller-owners", () =>
    stateLockAttempt("pipelines.controller-owners", () => performanceSpans.sync("controller.ownership", () => pipelineStore().pipelineOwnerExists(identities,true)))));
}
export async function controllerFlowAttached(id: string): Promise<boolean> {
  return withViewerOperation("pipelines.controller-read", () => waitForStateLock("pipelines.controller-owners", () =>
    stateLockAttempt("pipelines.controller-owners", () => performanceSpans.sync("controller.ownership", () => pipelineStore().pipelineOwnerExists([["flow",id]],false)))));
}
export async function pipelineRecoveryWindow(after: { row_order: number; row_key: string }, limit: number) {
  return waitForStateLock("pipelines.provider-recovery-schedule", () => stateLockAttempt("pipelines.provider-recovery-schedule", () => pipelineStore().pipelineRecoveryWindow(after, limit)));
}

export async function selectPipelineControllerWork(now: number, excluded: readonly string[]) {
  return waitForStateLock("pipelines.controller-schedule", () => stateLockAttempt("pipelines.controller-schedule", () => pipelineStore().pipelineTickWork(now, excluded)));
}
export async function deferPipelineControllerWork(work: import("@/lib/state/pipelineControllerSchedule").PipelineTickWork) {
  return (await waitForStateLock("pipelines.controller-schedule", pipelineStore)).deferPipelineTick(work);
}
export async function pipelineControllerReady(now: number, excluded: readonly string[]) {
  return waitForStateLock("pipelines.controller-schedule", () => stateLockAttempt("pipelines.controller-schedule", () => pipelineStore().pipelineTickReady(now, excluded)));
}
export async function acknowledgePipelineControllerWork(work: import("@/lib/state/pipelineControllerSchedule").PipelineTickWork, cursor: number, dueAt: number) {
  return (await waitForStateLock("pipelines.controller-schedule", pipelineStore)).acknowledgePipelineTick(work, cursor, dueAt);
}

export type PipelineStartupOwnership = { id: string; attempts: Array<{ conversationId: string | null; agentPath: string | null; sessionId: string | null; state: string; suspended?: true }>;
  survivors: import("@/lib/processIdentity").ProcessIdentity[] };
type CompactPipelineEvidence = { key: string; ownership?: PipelineStartupOwnership; issue?: RegistryRecordIssue };
type PreparedPipelineEvidence = { pipelines: Pipeline[]; ownership?: PipelineStartupOwnership[]; issues: RegistryRecordIssue[]; signature: string };
let compactEvidence: CompactEvidenceCache<CompactPipelineEvidence> | undefined;
function startupOwnership(pipeline: Pipeline): PipelineStartupOwnership {
  const attempts = pipeline.runs.flatMap(run => run.attempts);
  return { id: pipeline.id,
    attempts: attempts.map(attempt => ({ conversationId: attempt.conversationId ?? null, agentPath: attempt.agentPath ?? null, sessionId: attempt.sessionId ?? null, state: attempt.state, ...(attempt.suspension ? { suspended: true as const } : {}) })),
    survivors: [...attempts, ...(pipeline.closeTeardown?.hosts ?? []).map(host => host.evidence)]
      .flatMap(host => host.unresolvedTermination?.survivors.map(identity => ({ ...identity })) ?? []),
  };
}
const admittedEvidence = new AsyncLocalStorage<{ current: PreparedPipelineEvidence | null }>();
const pendingEvidence = new Map<string, Promise<PreparedPipelineEvidence>>();
const evidenceCollections = ["pipelines", "pipelines_archive"];
// Only the health result survives a completed read. Historical pipeline bodies
// still live only for the admissions that need independent mutable copies.
let healthWitness: { signature: string; version: string; issues: RegistryRecordIssue[] } | undefined;

function evidenceFileIdentity(filename: string): string {
  try { const stat = fs.statSync(filename, { bigint: true }); return `${stat.dev}:${stat.ino}`; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
class PipelineEvidenceChangedError extends PipelineStoreError {}

function evidenceSignature(): string {
  return performanceSpans.sync("pipeline.identity", readEvidenceSignature);
}
function readEvidenceSignature(): string {
  const filename = stateDatabaseFile();
  const revisions = readStateCollectionRevisions(filename, evidenceCollections);
  const legacy = evidenceCollections.map(collection => {
    if (revisions.get(collection) !== null) return "sqlite";
    const file = collection === "pipelines" ? pipelinesFile() : pipelinesArchiveFile();
    try { const st = fs.statSync(file, { bigint: true }); return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
  });
  return JSON.stringify([filename, evidenceFileIdentity(filename), [...revisions], legacy, pipelineEvidenceRevision(filename)]);
}

/** Shared only while a fresh read is in flight. Complete historical payloads
    are released when the last admission using that read finishes. */
type PipelineEvidenceBudget = { deadline?: number; signal?: AbortSignal };

function assertPipelineEvidenceBudget(budget?: PipelineEvidenceBudget): void {
  budget?.signal?.throwIfAborted();
  if (budget?.deadline !== undefined && performance.now() >= budget.deadline) {
    throw new FileTransactionBusyError("pipeline evidence preparation deadline exceeded");
  }
}

async function preparePipelineEvidence(mode: "startup" | "health" | "ownership" = "startup", budget?: PipelineEvidenceBudget): Promise<PreparedPipelineEvidence> {
  assertPipelineEvidenceBudget(budget);
  const signature = evidenceSignature();
  assertPipelineEvidenceBudget(budget);
  const filename = stateDatabaseFile();
  // Share a cold read across writes to this database. Freshness still belongs
  // to each caller; a replacement file must start its own read.
  const pendingNamespace = JSON.stringify([filename, evidenceFileIdentity(filename)]);
  const pendingKey = `${pendingNamespace}:${mode}`;
  const existing = budget ? undefined : pendingEvidence.get(`${pendingNamespace}:startup`) ?? (mode !== "startup" ? pendingEvidence.get(`${pendingNamespace}:ownership`) ?? pendingEvidence.get(`${pendingNamespace}:health`) : undefined) ?? pendingEvidence.get(pendingKey);
  if (existing) {
    performanceSpans.event("pipeline.shared");
    const evidence = await existing;
    // A completed promise can remain here until its owner resumes. Recheck
    // both the joining caller's revision and writes since the producer checked.
    if (evidence.signature !== signature || evidence.signature !== evidenceSignature()) {
      throw new PipelineEvidenceChangedError("pipeline evidence changed during preparation");
    }
    return evidence;
  }
  const pending = withViewerOperation("pipelines.evidence", async () => {
    assertPipelineEvidenceBudget(budget);
    const pipelines: Pipeline[] = [];
    const issues: RegistryRecordIssue[] = [];
    if (mode !== "startup") {
      const prepared = await readCompactPipelineEvidence(stateDatabaseFile(), compactEvidence, (record, collection) => {
        const key = registryRecordKey(record);
        return performanceSpans.sync("pipeline.validate", () => isPipeline(record))
          ? { key, ownership: startupOwnership(record as Pipeline) }
          : { key, issue: pipelineRecordIssue(record, collection) };
      }, budget);
      assertPipelineEvidenceBudget(budget);
      if (prepared) {
        const identities = new Set<string>();
        const ownership: PipelineStartupOwnership[] = [];
        for (const { value } of prepared.rows.values()) {
          if (identities.has(value.key)) throw new PipelineStoreError("pipeline startup records have contradictory identities");
          identities.add(value.key);
          if (value.ownership) ownership.push(value.ownership);
          if (value.issue) issues.push(value.issue);
        }
        // Preserve revision-tagged validation even when this snapshot loses
        // its freshness race. The next read revalidates only changed rows.
        compactEvidence = prepared;
        if (signature !== evidenceSignature()) throw new PipelineEvidenceChangedError("pipeline evidence changed during preparation");
        return { pipelines, ownership, issues, signature };
      }
      compactEvidence = undefined;
    }
    const identities = new Set<string>();
    const ownership: PipelineStartupOwnership[] = [];
    const resolveProject = projectAliasResolver();
    const visit = (record: unknown, collection: string) => {
      assertPipelineEvidenceBudget(budget);
      const key = registryRecordKey(record);
      if (identities.has(key)) throw new PipelineStoreError("pipeline startup records have contradictory identities");
      identities.add(key);
      if (performanceSpans.sync("pipeline.validate", () => isPipeline(record))) {
        if (mode === "startup") pipelines.push(performanceSpans.sync("pipeline.revive", () => reviveLoadedPipeline(record as Pipeline, resolveProject)));
        else ownership.push(startupOwnership(record as Pipeline));
      } else issues.push(pipelineRecordIssue(record, collection));
    };
    const revisions = await visitStateCollectionsRows(stateDatabaseFile(), evidenceCollections, visit, budget);
    if ((revisions.get("pipelines") === null) !== (revisions.get("pipelines_archive") === null)) {
      throw new PipelineStoreError("pipeline startup collections are incomplete");
    }
    if (revisions.get("pipelines") === null) {
      for (const collection of evidenceCollections) {
        for (const record of parsePipelinesFile(collection === "pipelines" ? pipelinesFile() : pipelinesArchiveFile(), true)) {
          assertPipelineEvidenceBudget(budget);
          visit(record, collection);
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
    }
    assertPipelineEvidenceBudget(budget);
    if (signature !== evidenceSignature()) throw new PipelineEvidenceChangedError("pipeline evidence changed during preparation");
    return { pipelines, ...(mode === "startup" ? {} : { ownership }), issues, signature };
  });
  if (!budget) pendingEvidence.set(pendingKey, pending);
  try { return await pending; }
  finally { if (!budget && pendingEvidence.get(pendingKey) === pending) pendingEvidence.delete(pendingKey); }
}

/** Complete selected ownership, including attempts without membership. Never
 * shares the global preparation promise or initializes the archive index. */
async function prepareRecipientPipelineEvidence(selection: PipelineRecipientSelection, budget?: PipelineEvidenceBudget): Promise<PreparedPipelineEvidence> {
  assertPipelineEvidenceBudget(budget);
  const signature = evidenceSignature();
  const rows = readRecipientPipelineEvidence(stateDatabaseFile(), selection);
  const identities = new Set<string>();
  const ownership: PipelineStartupOwnership[] = [];
  const issues: RegistryRecordIssue[] = [];
  for (const row of rows) {
    assertPipelineEvidenceBudget(budget);
    const key = registryRecordKey(row.value);
    if (identities.has(key) || key !== row.key) throw new PipelineStoreError("recipient pipeline records have contradictory identities");
    identities.add(key);
    if (isPipeline(row.value)) ownership.push(startupOwnership(row.value));
    else issues.push(pipelineRecordIssue(row.value, row.collection));
  }
  if (issues.length) throw new PipelineStoreError("recipient pipeline authority contains unreadable or unknown rows");
  if (signature !== evidenceSignature()) throw new PipelineEvidenceChangedError("recipient pipeline evidence changed during preparation");
  return { pipelines: [], ownership, issues, signature };
}

/** Each supported identity independently retains custody, even before membership is recorded. */
export function pipelineStartupAttemptMatches(attempt: PipelineStartupOwnership["attempts"][number], selection: PipelineRecipientSelection): boolean {
  return !!(attempt.conversationId && selection.conversationIds.includes(attempt.conversationId)
    || attempt.agentPath && selection.agentPaths?.includes(attempt.agentPath)
    || attempt.sessionId && selection.sessionIds?.includes(attempt.sessionId));
}

export async function loadPipelineOwnershipForStartupAsync(ids?: readonly string[], conversationIds?: ReadonlySet<string>,
  targets: Pick<PipelineRecipientSelection, "agentPaths" | "sessionIds"> = {}): Promise<PipelineStartupOwnership[]> {
  const selection = { ...targets, ids: ids ?? [], conversationIds: [...conversationIds ?? []] };
  const evidence = admittedEvidence.getStore()?.current ?? await (ids && conversationIds
    ? prepareRecipientPipelineEvidence(selection) : preparePipelineEvidence("ownership"));
  const selected = ids && new Set(ids);
  return (evidence.ownership ?? evidence.pipelines.map(startupOwnership)).filter(row => !selected || selected.has(row.id)
    || row.attempts.some(attempt => pipelineStartupAttemptMatches(attempt, selection))).map(row => ({ ...row,
    attempts: row.attempts.map(attempt => ({ ...attempt })), survivors: row.survivors.map(identity => ({ ...identity })) }));
}

export async function loadPipelinesForStartupAsync(): Promise<Pipeline[]> {
  const evidence = admittedEvidence.getStore()?.current ?? await preparePipelineEvidence();
  if (evidence.ownership) throw new PipelineStoreError("full pipeline records require full startup admission");
  const result: Pipeline[] = [];
  let slice = performance.now();
  let resolveProject = projectAliasResolver();
  for (const pipeline of evidence.pipelines) {
    result.push(performanceSpans.sync("pipeline.copy", () => cloneLoadedPipeline(pipeline, resolveProject), 1));
    if (performance.now() - slice >= 4) {
      await performanceSpans.wait("pipeline.yield", () => yieldToRuntime());
      // A project move may have committed while this copy yielded.
      resolveProject = projectAliasResolver();
      slice = performance.now();
    }
  }
  return result;
}
export async function pipelineRegistryHealthAsync(recipient?: PipelineRecipientSelection): Promise<RegistryRecordIssue[]> {
  const admitted = admittedEvidence.getStore()?.current;
  if (admitted) return admitted.issues.map(issue => ({ ...issue }));
  if (recipient) return (await prepareRecipientPipelineEvidence(recipient)).issues;
  const signature = evidenceSignature();
  const version = stateEvidenceVersion(stateDatabaseFile());
  if (healthWitness?.signature === signature && healthWitness.version === version) {
    return healthWitness.issues.map(issue => ({ ...issue }));
  }
  healthWitness = undefined;
  const evidence = await preparePipelineEvidence("health");
  if (evidence.signature === signature && stateEvidenceVersion(stateDatabaseFile()) === version) {
    healthWitness = { signature, version, issues: evidence.issues.map(issue => ({ ...issue })) };
  }
  return evidence.issues.map(issue => ({ ...issue }));
}

/** Startup needs fresh, complete authority, including cold records. Read both
    collections in one SQLite snapshot without projection caches or lenient
    archive decoding. Before cutover, validate the legacy sources in memory;
    this evidence read never migrates or rewrites an unreadable source. */
function readCompletePipelineRecords(): unknown[] {
  const collections = readStateCollectionsRows(stateDatabaseFile(), ["pipelines", "pipelines_archive"]);
  const active = collections.get("pipelines");
  const archived = collections.get("pipelines_archive");
  if ((active === null) !== (archived === null)) {
    throw new PipelineStoreError("pipeline startup collections are incomplete");
  }
  const records = active === null && archived === null
    ? [...parsePipelinesFile(pipelinesFile(), true), ...parsePipelinesFile(pipelinesArchiveFile(), true)]
    : [...(active ?? []), ...(archived ?? [])];
  if (new Set(records.map(registryRecordKey)).size !== records.length) {
    throw new PipelineStoreError("pipeline startup records have contradictory identities");
  }
  return records;
}

export function loadPipelinesForStartup(): Pipeline[] {
  const prepared = admittedEvidence.getStore()?.current;
  if (prepared) {
    if (prepared.ownership) throw new PipelineStoreError("full pipeline records require full startup admission");
    const resolveProject = projectAliasResolver();
    return prepared.pipelines.map(pipeline => performanceSpans.sync("pipeline.copy", () => cloneLoadedPipeline(pipeline, resolveProject), 1));
  }
  return readCompletePipelineRecords().flatMap((record) => { const decoded = decodePipeline(record); return decoded ? [decoded] : []; });
}

/** Retirement needs positive evidence about every owner. An opaque or malformed
    row may hold live work; projection/startup's rejected-row isolation cannot
    establish that a host is unused. Never cache or migrate this evidence. */
export function loadPipelinesForRetirement(): Pipeline[] {
  return readCompletePipelineRecords().map((record) => {
    const decoded = decodePipeline(record);
    if (!decoded) throw new PipelineStoreError("pipeline retirement ownership is unknown");
    return decoded;
  });
}

function parsePipelinesFile(filename: string, strictPresence = false): unknown[] {
  const document = readJson(filename);
  const raw = document?.raw;
  // Ordinary legacy readers historically accept null as empty. Startup must
  // distinguish that malformed content from positive missing-file evidence.
  if (raw === undefined || (raw === null && !strictPresence)) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PipelineStoreError("pipeline registry must be an object");
  }
  const file = raw as Partial<PipelineFile>;
  if (typeof file.schemaVersion !== "number" || !MIGRATABLE_SCHEMA_VERSIONS.has(file.schemaVersion)) {
    throw new PipelineStoreError(`unsupported pipeline registry schema: ${String(file.schemaVersion)}`);
  }
  if (!Array.isArray(file.pipelines)) {
    throw new PipelineStoreError("pipeline registry contains malformed records");
  }
  const records = file.pipelines.map((pipeline) => {
    const migrated = migratePipelineRecord(pipeline, file.schemaVersion!);
    // Never normalize a record this release cannot understand.
    return isPipeline(migrated) ? reviveLoadedPipeline(migrated) : pipeline;
  });
  rememberRecordBytes(records, jsonArrayRecordBytes(document!.source, "pipelines"), isPipeline);
  return records;
}

export function planPipelineStateMigration(): {
  pipelines: { records: number; keys: string[] };
  archive: { records: number; keys: string[] };
} {
  const pipelines = parsePipelinesFile(pipelinesFile());
  const archive = parsePipelinesFile(pipelinesArchiveFile());
  return {
    pipelines: { records: pipelines.length, keys: pipelines.map(registryRecordKey) },
    archive: { records: archive.length, keys: archive.map(registryRecordKey) },
  };
}

/** Normalize defaults and project identity on decoded records. Nested config
    can retain input references; shared records need cloneLoadedPipeline. */
function reviveLoadedPipeline(pipeline: Pipeline, resolveProject: (project: string) => string = canonicalProject): Pipeline {
  const settledAttempts = pipeline.terminalReap?.settledAttempts
    ?? (pipeline.terminalReap?.settledAt
      ? pipeline.runs.flatMap((run) => run.attempts
          .filter((attempt) => Boolean(attempt.verdict || attempt.completedAt))
          .map((attempt) => `${run.stageId}:${attempt.n}`))
      : []);
  const outstandingHostKeys = new Set(pipeline.unconfirmedHosts?.map(hostTerminationKey));
  const revived: Pipeline = {
    ...pipeline,
    conversationSource: pipeline.conversationSource ? { ...pipeline.conversationSource } : undefined,
    closeTeardown: pipeline.closeTeardown ? structuredClone(pipeline.closeTeardown) : undefined,
    closeReport: pipeline.closeReport ? structuredClone(pipeline.closeReport) : undefined,
    project: resolveProject(pipeline.project),
    taskIds: [...pipeline.taskIds],
    ...(pipeline.taskClass ? { taskClass: { ...pipeline.taskClass } } : {}),
    proactiveTaskIds: pipeline.proactiveTaskIds ? [...pipeline.proactiveTaskIds] : undefined,
    creationIntent: pipeline.creationIntent ? { ...pipeline.creationIntent } : undefined,
    spec: typeof pipeline.spec === "string" ? pipeline.spec : undefined,
    ...(pipeline.inputContext ? { inputContext: structuredClone(pipeline.inputContext) } : {}),
    baseBranch: pipeline.baseBranch ?? "",
    baseRef: pipeline.baseRef ?? "",
    lastPassedCommit: pipeline.lastPassedCommit ?? "",
    publishedCommit: pipeline.publishedCommit ?? null,
    pausedState: pipeline.pausedState ?? null,
    stateDetail: pipeline.stateDetail ?? null,
    srcPath: pipeline.srcPath ?? null,
    srcConversationId: pipeline.srcConversationId ?? null,
    closedAt: pipeline.closedAt ?? null,
    hiddenAt: pipeline.hiddenAt ?? null,
    unconfirmedHosts: pipeline.unconfirmedHosts?.length
      ? pipeline.unconfirmedHosts.map((host) => ({ ...host }))
      : undefined,
    hostTerminationProofs: pipeline.hostTerminationProofs ? Object.fromEntries(Object.entries(pipeline.hostTerminationProofs)
      .filter(([key]) => outstandingHostKeys.has(key))
      .map(([key, proof]) => [key, { ...proof }])) : undefined,
    terminalReap: pipeline.terminalReap
      ? { ...pipeline.terminalReap, settledAttempts: [...settledAttempts] }
      : undefined,
    restored: undefined,
    stages: pipeline.stages.map((stage) => ({ ...stage, onFail: stage.onFail ?? null })),
    stageReports: pipeline.stageReports?.map((entry) => ({
      ...entry,
      ...(entry.provenanceAt === undefined ? {} : {
        provenanceAt: typeof entry.provenanceAt === "string" ? entry.provenanceAt : entry.at,
      }),
    })),
    cursor: pipeline.cursor
      ? { ...pipeline.cursor, input: pipeline.cursor.input ?? null, activatedBy: pipeline.cursor.activatedBy ?? null }
      : null,
    runs: pipeline.runs.map((run) => ({
      ...run,
      attempts: Array.isArray(run.attempts)
        ? run.attempts.map((attempt) => ({
            ...attempt,
            ...(attempt.accounting ? { accounting: structuredClone(attempt.accounting) } : {}),
            ...(attempt.setup ? { setup: { ...attempt.setup, command: [...attempt.setup.command] } } : {}),
            ...(attempt.startupOwnerWait ? { startupOwnerWait: { ...attempt.startupOwnerWait } } : {}),
            ...(attempt.roleMemoryDispatchWait ? { roleMemoryDispatchWait: { ...attempt.roleMemoryDispatchWait } } : {}),
            ...(attempt.roleMemoryDelivery ? { roleMemoryDelivery: { ...attempt.roleMemoryDelivery } } : {}),
            ...(attempt.suspension ? { suspension: { ...attempt.suspension } } : {}),
            ...(attempt.accountHolds ? { accountHolds: attempt.accountHolds.map((hold) => ({ ...hold })) } : {}),
            ...(attempt.runtimeSwitches ? { runtimeSwitches: structuredClone(attempt.runtimeSwitches) } : {}),
            launchId: attempt.launchId ?? null,
            conversationId: attempt.conversationId ?? null,
            sessionId: attempt.sessionId ?? null,
            agentPath: attempt.agentPath ?? null,
            paneId: attempt.paneId ?? null,
            ...(attempt.usageLimitedAccounts
              ? { usageLimitedAccounts: attempt.usageLimitedAccounts.map((limited) => ({ ...limited })) }
              : {}),
            providerRecoveryBudget: attempt.providerRecoveryBudget ? { ...attempt.providerRecoveryBudget,
              ...(attempt.providerRecoveryBudget.triedAccounts ? { triedAccounts: [...attempt.providerRecoveryBudget.triedAccounts] } : {}),
              ...(attempt.providerRecoveryBudget.failedAccounts ? { failedAccounts: [...attempt.providerRecoveryBudget.failedAccounts] } : {}) } : undefined,
            providerWait: attempt.providerWait ? { ...attempt.providerWait, condition: { ...attempt.providerWait.condition },
              ...(attempt.providerWait.stageRetry ? { stageRetry: { ...attempt.providerWait.stageRetry } } : {}),
              ...(attempt.providerWait.failedAccounts ? { failedAccounts: [...attempt.providerWait.failedAccounts] } : {}) } : undefined,
            providerRecoveries: attempt.providerRecoveries?.map((recovery) => ({ ...recovery, condition: { ...recovery.condition } })),
            flowId: attempt.flowId ?? null,
            expectedReviewHeadSha: attempt.expectedReviewHeadSha ?? null,
            reviewHeadSha: attempt.reviewHeadSha ?? null,
            reviewFlowSync: attempt.reviewFlowSync ? { ...attempt.reviewFlowSync } : undefined,
            startedAt: attempt.startedAt ?? null,
            completedAt: attempt.completedAt ?? null,
            input: attempt.input ?? null,
            activatedBy: attempt.activatedBy ?? null,
            output: attempt.output ?? null,
            verdict: attempt.verdict ?? null,
            ...(attempt.acceptedForReview === true ? { acceptedForReview: true as const } : {}),
            error: attempt.error ?? null,
            verdictRecovery: attempt.verdictRecovery ? { ...attempt.verdictRecovery } : undefined,
            ...(attempt.retiredLaunches
              ? { retiredLaunches: attempt.retiredLaunches.map((retired) => ({ ...retired })) }
              : {}),
            unresolvedTermination: attempt.unresolvedTermination
              ? { ...attempt.unresolvedTermination, survivors: attempt.unresolvedTermination.survivors.map((survivor) => ({ ...survivor })) }
              : undefined,
          }))
        : [],
    })),
  };
  settleClosedPipelineAttempts(revived, (pipeline, stageId, attempt) => {
    if (attempt.spawnCalls === 0) return "none";
    try {
      const base = `pipeline_${pipeline.id}_${stageId}_${attempt.n}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
      const receipts = agentRegistry().pipelineSpawnHistory(base);
      if (!receipts.length) return attempt.spawnCalls === undefined && attempt.startedAt ? "uncertain" : "none";
      if (receipts.every(receipt => receipt.state === "failed" && receipt.membershipAdmitted === false
        && !receipt.key && !receipt.pane && !receipt.verifiedHost && !receipt.artifactPath)) return "no-host";
      return receipts.some(receipt => receipt.state === "starting") ? "uncertain" : "launched";
    } catch {
      return "uncertain";
    }
  });
  return revived;
}

/** Detach every nested field before a mutable reader or session sees a shared
    decoded record, including configuration and historical attempt evidence. */
function cloneLoadedPipeline(pipeline: Pipeline, resolveProject: (project: string) => string = canonicalProject): Pipeline {
  return performanceSpans.sync("pipeline.copy", () => reviveLoadedPipeline(structuredClone(pipeline), resolveProject), 1);
}

/** Array slots detach on access. Length, direct lookup and append stay bounded;
 * enumeration/serialization still sees the complete authoritative history. */
function lazyControllerArray<T>(source: T[]): T[] {
  const target: typeof source = [];
  target.length = source.length;
  let inheritedLength = source.length;
  const deleted = new Set<string>();
  const index = (key: string | symbol) => typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
  const copyAt = (array: typeof source, key: string | symbol) => {
    const n = index(key);
    if (n >= 0 && n < inheritedLength && n < array.length && !Object.hasOwn(array, key) && !deleted.has(String(key))) {
      array[n] = performanceSpans.sync("pipeline.copy", () => structuredClone(source[n]!));
    }
  };
  return new Proxy(target, {
    get(array, key, receiver) {
      copyAt(array,key);
      return Reflect.get(array, key, receiver);
    },
    has: (array, key) => Reflect.has(array, key) || (index(key) >= 0 && index(key) < Math.min(inheritedLength,array.length) && !deleted.has(String(key))),
    set(array, key, value) {
      if (key === "length") inheritedLength = Math.min(inheritedLength, Number(value));
      deleted.delete(String(key));
      return Reflect.set(array, key, value);
    },
    deleteProperty(array, key) { deleted.add(String(key)); return Reflect.deleteProperty(array,key); },
    ownKeys(array) {
      const keys = new Set(Reflect.ownKeys(array));
      for (let n = 0; n < Math.min(inheritedLength,array.length); n++) if (!deleted.has(String(n))) keys.add(String(n));
      return [...keys];
    },
    getOwnPropertyDescriptor(array, key) {
      copyAt(array,key);
      return Reflect.getOwnPropertyDescriptor(array,key);
    },
  });
}

export function cloneControllerPipeline(pipeline: Pipeline): Pipeline {
  if (!controllerReferences(pipeline.id)) return cloneLoadedPipeline(pipeline);
  return performanceSpans.sync("pipeline.copy", () => {
    const copy: Pipeline = structuredClone({ ...pipeline, runs: [],
      terminalReap: pipeline.terminalReap ? { ...pipeline.terminalReap, settledAttempts: [] } : undefined });
    copy.runs = pipeline.runs.map(run => ({ ...run, attempts: lazyControllerArray(run.attempts) }));
    if (pipeline.terminalReap) copy.terminalReap!.settledAttempts = lazyControllerArray(pipeline.terminalReap.settledAttempts);
    inheritControllerGuards(pipeline,copy);
    return copy;
  }, 1);
}

const pipelineStores = new Map<string, {
  active: SqliteStateCollection<Pipeline>;
  archive: SqliteStateCollection<Pipeline>;
}>();

function decodePipeline(value: unknown, collection = "pipelines"): Pipeline | null {
  if (!isPipeline(value)) {
    pipelineRecordIssue(value, collection);
    return null;
  }
  return reviveLoadedPipeline(value);
}

/** Unknown vocabulary is diagnosed separately from a broken known shape. The
    substituted copy is used only to validate structure, never for execution. */
function pipelineRecordIssue(value: unknown, collection = "pipelines"): RegistryRecordIssue {
  if (needsIntegrationReader(value)) return reportRegistryRecord(collection, value, "unknown-but-preserved",
    "pipeline integration requires a newer reader; preserved without launch or settlement");
  const unknown: string[] = [];
  const copy = structuredClone(value);
  const visit = (node: unknown, location: string) => {
    if (!node || typeof node !== "object") return;
    for (const [key, item] of Object.entries(node)) {
      const row = node as Record<string, unknown>;
      let known: readonly string[] | undefined;
      let replacement = "pending";
      if (key === "roleId") { known = PIPELINE_ROLE_IDS; replacement = "builder"; }
      if (key === "kind" && /^stages\.\d+$/.test(location)) { known = ["run", "review-loop"]; replacement = "run"; }
      if (key === "state" && location === "") { known = ["draft", "provisioning", "running", "needs_decision", "needs_review", "paused", "completed", "closed"]; replacement = "paused"; }
      if (key === "pausedState" && location === "") { known = ["provisioning", "running", "needs_decision", "needs_review", "completed", "closed"]; replacement = "running"; }
      if (key === "state" && location === "cursor") known = ["pending", "spawning", "running", "reviewing", "committing"];
      if (key === "state" && /^runs\.\d+\.attempts\.\d+$/.test(location)) known = ["pending", "spawning", "running", "reviewing", "committing", "passed", "failed", "needs_decision", "skipped"];
      if (known && typeof item === "string" && item.length > 0 && !known.includes(item)) {
        unknown.push(`${location ? `${location}.` : ""}${key}=${item}`);
        row[key] = replacement;
      } else visit(item, location ? `${location}.${key}` : key);
    }
  };
  visit(copy, "");
  const unknownState = unknown.some((field) => field.startsWith("state="));
  // Different states admit different shapes (an empty draft, a completed lane
  // without a cursor). Try the known shapes instead of assigning one state's
  // constraints to a future vocabulary value.
  const forward = unknown.length > 0 && (unknownState && copy && typeof copy === "object"
    ? ["draft", "provisioning", "running", "needs_decision", "needs_review", "paused", "completed", "closed"]
      .some((state) => isPipeline({ ...copy, state }))
    : isPipeline(copy));
  return reportRegistryRecord(collection, value, forward ? "unknown-but-preserved" : "malformed",
    forward ? `unsupported vocabulary (${unknown.join(", ")}); preserved without launch or settlement` : undefined);
}

/** Fresh diagnostic field for health and auto-update readers. Corrupt JSON
    still throws through the authoritative SQLite snapshot reader. */
export function pipelineRegistryHealth(): RegistryRecordIssue[] {
  const prepared = admittedEvidence.getStore()?.current;
  if (prepared) return prepared.issues.map(issue => ({ ...issue }));
  const collections = readStateCollectionsRows(stateDatabaseFile(), ["pipelines", "pipelines_archive"]);
  return ["pipelines", "pipelines_archive"].flatMap((collection) => {
    const records = collections.get(collection) ?? parsePipelinesFile(collection === "pipelines" ? pipelinesFile() : pipelinesArchiveFile(), true);
    return records.filter((record) => !isPipeline(record)).map((record) => pipelineRecordIssue(record, collection));
  });
}

function pipelineHasRecordedHost(pipeline: Pipeline): boolean {
  return pipeline.runs.some(run => run.attempts.some(attempt => attempt.conversationId || attempt.agentPath || attempt.paneId));
}

function pipelineControllerActive(pipeline: Pipeline): boolean {
  if (pipeline.closeTeardown) return pipeline.closeTeardown.phase !== "settled"
    || Boolean(pipeline.unconfirmedHosts?.length || pipeline.closeReport?.unconfirmed.length || pipeline.closeReport?.stillRunning.length);
  if (pipeline.activationCloseRequested) return true;
  if (pipeline.state === "completed" || pipeline.state === "closed") {
    // A scoped controller holds an attempt window. Keep its eligibility
    // conservative; the scheduler checks host identity in the stored row.
    return Boolean(pipeline.unconfirmedHosts?.length) || (!pipeline.terminalReap?.settledAt
      && (pipeline.state === "completed" || controllerPipelineKeys()?.includes(pipeline.id) || pipelineHasRecordedHost(pipeline)));
  }
  return true;
}

export function pipelineStateCollectionSeeds(): [StateCollectionSeed<unknown>, StateCollectionSeed<unknown>] {
  return [
    {
      collection: "pipelines",
      schemaVersion: PIPELINES_SCHEMA_VERSION,
      compatibleSchemaVersions: [6],
      migrationId: "pipelines-json-v1",
      loadRecords: () => parsePipelinesFile(pipelinesFile()),
      key: registryRecordKey,
      recordJson: preservedRecordJson,
      controllerActive: (pipeline) => !isPipeline(pipeline) || pipelineControllerActive(pipeline),
    },
    {
      collection: "pipelines_archive",
      schemaVersion: PIPELINES_SCHEMA_VERSION,
      compatibleSchemaVersions: [6],
      migrationId: "pipelines-archive-json-v1",
      loadRecords: () => parsePipelinesFile(pipelinesArchiveFile()),
      key: registryRecordKey,
      recordJson: preservedRecordJson,
      controllerActive: () => false,
    },
  ];
}

/** The archive list keeps every lane's structure, ids, states and short
    values in memory. Role scaffolds, prompts, stage inputs, outputs and report
    texts are nine tenths of an archived lane and are read from its row when a
    reader asks for one. */
const ARCHIVED_PIPELINE_INLINE_TEXT = 512;

function stores(): { active: SqliteStateCollection<Pipeline>; archive: SqliteStateCollection<Pipeline> } {
  const filename = stateDatabaseFile();
  const held = pipelineStores.get(filename);
  if (held) return held;
  initializeStateCollections(filename, pipelineStateCollectionSeeds());
  const common = {
    readCacheKey: JSON.stringify(["pipeline-v1", PIPELINE_ROLE_IDS]),
    schemaVersion: PIPELINES_SCHEMA_VERSION,
    compatibleSchemaVersions: [6],
    busyMessage: "pipeline state is busy",
    key: (pipeline: Pipeline) => pipeline.id,
    decode: decodePipeline,
    preserveRejectedRecords: true,
    clone: cloneLoadedPipeline,
    cloneController: cloneControllerPipeline,
    decodeAuthority: () => JSON.stringify(projectAliasSnapshot()),
    decodeError: (error: unknown) => error instanceof PipelineStoreError
      ? error
      : new PipelineStoreError("pipeline registry contains malformed records", { cause: error }),
    validate: (pipeline: Pipeline) => {
      if (!hostTerminationCheckpointCurrent(pipeline)) throw new StateSnapshotChangedError();
      for (const run of pipeline.runs) for (const attempt of run.attempts.slice(-2)) {
        if (attempt.accounting) settleAttemptAccounting(attempt, pipeline.id);
      }
      releaseTerminalDelivery(pipeline);
      if (!isPipeline(pipeline)) {
        throw new PipelineStoreError("refusing to persist a malformed pipeline record");
      }
      assertPipelineNotRetiring(pipeline.id, () => pipelineRevision(pipeline));
    },
  };
  const active = new SqliteStateCollection<Pipeline>(filename, {
    ...common,
    collection: "pipelines",
    controllerActive: pipelineControllerActive,
    strictDecode: true,
  });
  const archive = new SqliteStateCollection<Pipeline>(filename, {
    ...common,
    collection: "pipelines_archive",
    decode: (value) => decodePipeline(value, "pipelines_archive"),
    strictDecode: true,
    deferTextLongerThan: ARCHIVED_PIPELINE_INLINE_TEXT,
  });
  const created = { active, archive };
  pipelineStores.set(filename, created);
  return created;
}

function pipelineStore(): SqliteStateCollection<Pipeline> {
  return stores().active;
}

function archiveStore(): SqliteStateCollection<Pipeline> {
  return stores().archive;
}

/** SQLite revisions, database identity and project aliases validate the shared
    read cache. The exported reader decides whether to copy its records. */
function cachedPipelines(): readonly Pipeline[] {
  return pipelineStore().loadReadonly();
}

/** Read-only load for request-path projections (issue #798): no lease, and the
    validated registry is cached against the SQLite collection revision.
    Every call still returns independently mutable records via the same revive
    pass `loadPipelines` uses, so a projection overlay can never write into the
    cache. */
export function loadPipelinesForProjection(): Pipeline[] {
  return cachedPipelines().map((pipeline) => withDeliveryPublicationDetail(cloneLoadedPipeline(pipeline)));
}

/** Reuse the lane card's existing publication/detail slot. Never persist this
    presentation overlay or feed it into a controller mutation. */
export function withDeliveryPublicationDetail(pipeline: Pipeline): Pipeline {
  const delivery = pipeline.delivery;
  if (!delivery) return pipeline;
  const publication = `Viewer publication: ${delivery.disposition}; owner ${delivery.ownerId}, epoch ${delivery.epoch}${delivery.publish === "disabled" ? "; disabled" : ""}`;
  const detail = pipeline.stateDetail;
  return { ...pipeline, stateDetail: detail?.includes(publication) ? detail : [detail, publication].filter(Boolean).join(" · ") };
}

/** The registry read behind bounded list projections (issue #863).
 *
 * Deliberately skips the per-caller `cloneLoadedPipeline` pass that every other
 * reader pays: a list page filters and slices these records and then copies only
 * the handful of scalars a row needs, so materializing mutable copies of 500
 * pipelines' nested stage/attempt history — for rows that are about to be
 * dropped, out of fields a list never returns — is pure waste.
 *
 * The price is that these ARE the cached records. Read them; never write them.
 * Anything that mutates a pipeline goes through `withPipelineMutation`, and
 * anything that overlays one takes `loadPipelinesForProjection`.
 */
const pipelineProjectKeys = new WeakMap<readonly Pipeline[], { aliases: string; projects: ReadonlySet<string> }>();
export function loadPipelinesForList(): readonly Pipeline[] {
  const pipelines = cachedPipelines();
  const aliases = JSON.stringify(projectAliasSnapshot().aliases);
  let membership = pipelineProjectKeys.get(pipelines);
  if (membership?.aliases !== aliases) {
    membership = { aliases, projects: canonicalProjectKeys(pipelines.map(pipeline => pipeline.project)) };
    pipelineProjectKeys.set(pipelines, membership);
  }
  replaceProjectKeySource("pipelines", membership.projects);
  return pipelines;
}

/** Seat startup fills and freezes the shared list with timer opportunities. */
export async function loadPipelinesForListAsync(): Promise<readonly Pipeline[]> {
  const rows = await pipelineStore().loadReadonlyAsync();
  if (!Object.isFrozen(rows)) {
    // Incremental snapshots retain frozen records. Only changed graphs owe
    // work; yielding for every retained row can exhaust a busy seat's budget.
    await forEachCooperatively(rows.filter(row => !Object.isFrozen(row)), row => { deepFreeze(row); }, { batchSize: 1, timeBudgetMs: 8 });
    Object.freeze(rows);
  }
  return loadPipelinesForList();
}

/** How long a pipeline mutation waits for the registry lease before it refuses
    (#1766). The default is the cap the attempt loop in the state store already
    imposed; `LLV_PIPELINE_LOCK_WAIT_MS` bounds it lower, which is what lets a
    test prove the wait cannot hang a request. The wait matters because the
    ordinary request mutations serialize their read and write. Controller
    reconciliation uses short revision-checked checkpoints instead. */
const DEFAULT_PIPELINE_LOCK_WAIT_MS = 30_000;

export function pipelineLockWaitMs(): number {
  const configured = Number(process.env.LLV_PIPELINE_LOCK_WAIT_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_PIPELINE_LOCK_WAIT_MS;
}

/** Serialize every production read-modify-write across Viewer and MCP processes.
 *
 * A refusal raised before `mutate` runs is a {@link StoreBusyBeforeAdmissionError}
 * (#1766): the lease was never taken, so nothing was read, written or reserved
 * and the same request may run again under the same idempotency key. A busy
 * error from inside the callback keeps its ordinary ambiguous meaning: an
 * earlier persist may have committed. Lease release never throws; failed
 * releases are retried in the background. */
export async function withPipelineMutation<T>(
  mutate: (pipelines: Pipeline[], persist: {
    (): Promise<void>;
    (records: readonly Pipeline[]): Promise<void>;
  }) => Promise<T> | T,
  observeHold?: (heldMs: number) => void,
): Promise<T> {
  return withViewerOperation("pipelines.mutation", () => refuseBusyBeforeAdmission(async (admitted) => (await waitForStateLock("pipelines.open", pipelineStore, { waitMs: pipelineLockWaitMs() })).mutate((pipelines, persist) => {
    admitted();
    return mutate(pipelines, persist);
  }, controllerPipelineKeys() ? context => {
    if (context.structural) throw new Error("controller jobs cannot replace the collection");
  } : undefined, false, pipelineLockWaitMs(), observeHold, controllerPipelineKeys())));
}

export async function withPipelineControllerMutation<T>(
  mutate: (pipelines: Pipeline[], persist: {
    (): Promise<void>;
    (records: readonly Pipeline[]): Promise<void>;
  }, assertCurrent: (pipeline: Pipeline) => void) => Promise<T> | T,
  observeHold?: (heldMs: number) => void,
  explicitOnly = false,
): Promise<T> {
  return withViewerOperation("pipelines.controller-mutation", () => performanceSpans.wait(explicitOnly ? "controller.admission" : "controller.reconcile", async () => (await waitForStateLock("pipelines.open", pipelineStore)).reconcileSnapshot(mutate, observeHold, explicitOnly, controllerPipelineKeys())));
}

/** Short startup state admission under the existing cross-process lease.
 * Callers finish host and transcript I/O before entering this callback.
 * Unavailable state or authority permits only the caller's deferred path.
 * Never reinterpret a failure inside admission as permission to run it again.
 */
export async function withPipelineStartupAdmission<T>(
  admit: (available: boolean, refusal?: unknown) => Promise<T>,
  phase = "startup evidence",
  observeHold?: (heldMs: number) => void,
  compact = false,
  options: { signal?: AbortSignal; waitMs?: number; recipient?: PipelineRecipientSelection } = {},
): Promise<T> {
  return withViewerOperation("pipelines.startup-admission", () => withWaitCorrelation({ label: `pipelines.startup-admission:${phase}` }, async () => {
    let entered = false;
    let prepared: PreparedPipelineEvidence | undefined;
    const waitMs = Math.max(0, Math.min(pipelineLockWaitMs(), options.waitMs ?? Infinity));
    const deadline = performance.now() + waitMs;
    try {
      const outcome = await waitForStateLock("pipelines.startup-admission", async () => {
        try {
          let evidence = prepared;
          const evidenceBudget = { ...(waitMs > 0 ? { deadline } : {}), signal: options.signal };
          if (!evidence) evidence = await (options.recipient ? prepareRecipientPipelineEvidence(options.recipient, evidenceBudget)
            : preparePipelineEvidence(compact ? "ownership" : "startup", evidenceBudget));
          assertPipelineEvidenceBudget(evidenceBudget);
          const store = pipelineStore();
          assertPipelineEvidenceBudget(evidenceBudget);
          // First migration changes authority. Refresh before taking the lease.
          if (!prepared) {
            assertPipelineEvidenceBudget(evidenceBudget);
            const currentSignature = evidenceSignature();
            assertPipelineEvidenceBudget(evidenceBudget);
            if (evidence.signature !== currentSignature) {
              evidence = await (options.recipient ? prepareRecipientPipelineEvidence(options.recipient, evidenceBudget)
            : preparePipelineEvidence(compact ? "ownership" : "startup", evidenceBudget));
            }
          }
          prepared = evidence;
          assertPipelineEvidenceBudget(evidenceBudget);
          const admitted = evidence;
          // Retain unchanged preparation while yielding to a local lease holder.
          // Never enqueue behind its callback: that could outlive this deadline
          // or cancellation. The outer async wait owns every acquisition retry.
          return await store.admit(async () => {
            options.signal?.throwIfAborted();
            if (waitMs > 0 && performance.now() >= deadline) throw new FileTransactionBusyError("pipeline startup admission deadline exceeded");
            const currentSignature = evidenceSignature();
            assertPipelineEvidenceBudget(evidenceBudget);
            if (admitted.signature !== currentSignature) throw new PipelineEvidenceChangedError("pipeline evidence changed before admission");
            entered = true;
            const scope = { current: admitted as PreparedPipelineEvidence | null };
            return outsideStateLockWait(() => admittedEvidence.run(scope, async () => {
              // Return a callback error as data across the retry boundary: even
              // a typed admission error here may follow an external effect.
              try { return { ok: true as const, value: await admit(true) }; }
              catch (error) { return { ok: false as const, error }; }
              finally { scope.current = null; }
            }));
          }, 0, heldMs => {
            if (heldMs > 100) console.warn(`[structured hosts] state lease exceeded budget ${JSON.stringify({
              pid: process.pid, role: process.env.LLV_STATE_OWNER ?? stateLockProcessKind(),
              phase, collection: "pipelines", heldMs: Math.round(heldMs), budgetMs: 100,
            })}`);
            observeHold?.(heldMs);
          });
        } catch (error) {
          // Lease observers and teardown also run after callback effects.
          if (entered) return { ok: false as const, error };
          if (error instanceof PipelineEvidenceChangedError) prepared = undefined;
          if (error instanceof PipelineEvidenceChangedError || error instanceof FileTransactionBusyError) {
            throw new StateLockDeferredError("pipelines.startup-admission", error instanceof PipelineEvidenceChangedError ? "sqlite" : "lease");
          }
          throw error;
        }
      }, { waitMs, signal: options.signal, subject: "pipelines" });
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (entered) throw error;
      performanceSpans.event("pipeline.refused", undefined, 0, true);
      return admit(false, error);
    }
  }));
}

export function deliveryJournal(pipeline: Pipeline, kind: NonNullable<Pipeline["delivery"]>["journal"][number]["kind"], reason: string, conversationId: string | null = null): void {
  const delivery = pipeline.delivery!;
  delivery.journal = [...delivery.journal, { at: new Date().toISOString(), kind, ownerId: delivery.ownerId, epoch: delivery.epoch, conversationId, reason }].slice(-100);
}

function releaseTerminalDelivery(pipeline: Pipeline): void {
  if (pipeline.state === "closed") withdrawPipelineMerge(pipeline, "Lane is closed", pipeline.closedAt ?? new Date().toISOString());
  const delivery = pipeline.delivery;
  // Host teardown keeps its own durable custody. Closing withdraws this
  // lane's right to start a publisher immediately; an existing writer below
  // still fences the target until its outcome has been reconciled.
  // Parks retain the lane's claim so its cursor can resume and publish.
  if (!delivery?.active || (pipeline.state !== "closed" && pipeline.state !== "completed")) return;
  // An interrupted external write remains fenced until its result is known.
  if (delivery.operation?.state === "running") return;
  delivery.active = false;
  delivery.publish = "disabled";
  delivery.releasedAt = pipeline.closedAt ?? new Date().toISOString();
  deliveryJournal(pipeline, "release", `pipeline ${pipeline.state}`);
}

/** A completed comparison can resume delivery at its passed terminal stage,
 * without repeating the work or inventing a review verdict. */
export function completedComparisonPass(pipeline: Pipeline): string | null {
  if (pipeline.state !== "completed" || pipeline.delivery?.disposition !== "comparison"
    || pipeline.hiddenAt || !/^[0-9a-f]{40}$/i.test(pipeline.lastPassedCommit)) return null;
  const terminal = pipeline.stages.filter(stage => {
    const attempt = pipeline.runs.find(run => run.stageId === stage.id)?.attempts.at(-1);
    return stage.next === null && attempt?.state === "passed" && attempt.verdict?.status === "pass"
      && attempt.completedAt && !attempt.historical;
  });
  return terminal.length === 1 ? terminal[0]!.id : null;
}

export function pipelineDeliveryLookup(query: { requestKey: string } | { repository: string; branch: string; active?: boolean }): Pipeline | null {
  return pipelineStore().pipelineLookup(query);
}

export function unclaimedPipelinePublications(): Pipeline[] {
  return pipelineStore().unclaimedPipelinePublications();
}

export async function controllerUnclaimedPublications(): Promise<Pipeline[]> {
  const keys = controllerPipelineKeys();
  if (!keys) return unclaimedPipelinePublications();
  const rows: Pipeline[] = [];
  for (const key of keys) {
    const row = await findControllerPipeline(key);
    if (row && !row.delivery && row.publication === "remote-branch" && row.state !== "completed" && row.state !== "closed") rows.push(row);
  }
  return rows;
}

export function withDeliveryMutation<R>(operation: (tx: StateBoundedTransaction<Pipeline>) => R): R {
  return pipelineStore().boundedPatch(16, operation);
}

export async function withDeliveryMutationAsync<R>(operation: (tx: StateBoundedTransaction<Pipeline>) => R, limit = 16, admissionDeadline = Infinity): Promise<R> {
  const remaining = () => Math.min(pipelineLockWaitMs(), Math.max(0, admissionDeadline - performance.now()));
  return refuseBusyBeforeAdmission(async (admitted) => (await waitForStateLock("pipelines.open", pipelineStore, { waitMs: remaining() })).boundedPatchAsync(limit, (tx) => {
    admitted();
    return operation(tx);
  }, remaining()));
}

/** A short state admission publishes the durable fence. The sweep owns its
 * lifetime outside this lease and re-reads authority before removing data. */
export async function claimAttemptRetirement(pipelineId: string, directory: string) {
  const owner = captureProcessIdentity(process.pid);
  return waitForStateLock("pipelines.retirement-claim", () => {
    const { active, archive } = stores();
    return active.boundedPatch(2, tx => {
      const pipeline = tx.get(pipelineId) ?? archive.get(pipelineId);
      return admitAttemptRetirement(pipelineId, directory, pipeline ? pipelineRevision(pipeline) : "missing", owner);
    }, undefined, { collection: archive, prepare: () => ({ records: [] }) });
  });
}

/** Called under the existing pipeline lease; indexed reads, no provisioning. */
export function assignPipelineDelivery(pipeline: Pipeline, target: PipelineDeliveryTarget, comparison = false,
  lookup: typeof pipelineDeliveryLookup = pipelineDeliveryLookup): void {
  const owner = lookup({ ...target, active: true });
  const previous = lookup(target);
  const epoch = owner?.delivery?.epoch ?? (comparison && previous?.delivery ? previous.delivery.epoch : (previous?.delivery?.epoch ?? 0) + 1);
  pipeline.delivery = {
    target, disposition: owner || comparison ? "comparison" : "owner",
    publish: owner || comparison ? "disabled" : "enabled",
    ownerId: owner?.id ?? (comparison ? previous?.delivery?.ownerId : undefined) ?? pipeline.id, epoch, active: !owner && !comparison, journal: [],
  };
  if (pipeline.delivery.disposition === "comparison") pipeline.publication = "internal";
  deliveryJournal(pipeline, pipeline.delivery.disposition === "owner" ? "claim" : "comparison",
    owner ? `target owned by ${owner.id} at epoch ${epoch}` : comparison ? "comparison requested; no active owner" : "target claimed", pipeline.srcConversationId);
}

export async function createPipelineWithDelivery(pipeline: Pipeline, target: PipelineDeliveryTarget, comparison = false, options: {
  requireOwner?: boolean;
  /** Monotonic deadline shared by store opening and writer admission. */
  admissionDeadline?: number;
  assertAuthority?: () => void;
  /** Outside the lease; repeated after contention before another create attempt. */
  prepare?: () => Promise<void>;
  /** Synchronous creation-only freshness guard under the writer lease. */
  admit?: () => void;
  /** Live authority and result scope, independent of source freshness. */
  admitReplay?: (pipeline: Pipeline) => void;
  onReplay?: () => void;
} = {}): Promise<Pipeline> {
  const replay = (tx: StateBoundedTransaction<Pipeline>) => {
    options.assertAuthority?.();
    if (pipeline.creationRequest) {
      const existing = tx.pipelineLookup({ requestKey: pipeline.creationRequest.key });
      if (existing) {
        options.admitReplay?.(existing);
        if (existing.creationRequest?.digest !== pipeline.creationRequest.digest) throw new Error("idempotency_conflict: creation arguments changed");
        options.onReplay?.();
        return existing;
      }
    }
    return null;
  };
  const create = (tx: StateBoundedTransaction<Pipeline>, preparationFailure?: { error: unknown }) => {
    const existing = replay(tx);
    if (existing) return existing;
    if (preparationFailure) throw preparationFailure.error;
    options.admit?.();
    const pullRequestRepository = target.pr ? deliveryPullRequestRepository(target) : null;
    if (options.requireOwner && (comparison || tx.pipelineLookup({ ...target, active: true })
      || tx.hasUnfinishedPipeline({ repository: target.repository, branch: target.branch,
        ...(target.pr && pullRequestRepository ? { pullRequestRepository, prNumber: target.pr,
          pullRequestMatches: (candidate, repository, number) => pipelineHasPullRequest(candidate as Pipeline, repository, number),
        } : {}),
      }))) {
      throw new Error("target already owned or has unfinished PR work; Delegatus could not claim the refresh delivery branch");
    }
    assignPipelineDelivery(pipeline, target, comparison, tx.pipelineLookup);
    tx.put(pipeline);
    return pipeline;
  };
  const limit = options.requireOwner ? 4096 : 16;
  const prepare = options.prepare;
  if (!prepare) return withDeliveryMutationAsync(create, limit, options.admissionDeadline);
  return refuseBusyBeforeAdmission(admitted => waitForStateLock("pipelines.create", async () => {
    const store = pipelineStore();
    // A committed replay needs live authorization, but no fresh source capture.
    const existing = store.boundedPatch(2, replay);
    if (existing) { admitted(); return existing; }
    let preparationFailure: { error: unknown } | undefined;
    try { await prepare(); }
    catch (error) { preparationFailure = { error }; }
    // One non-waiting admission attempt follows preparation. Contention retries
    // this whole operation, including preparation, with no Git under the lease.
    return store.boundedPatch(limit, tx => {
      admitted();
      // A peer may have committed while preparation was running or refused.
      return create(tx, preparationFailure);
    });
  }, { waitMs: Math.min(pipelineLockWaitMs(), Math.max(0, (options.admissionDeadline ?? Infinity) - performance.now())), subject: "pipelines" }));
}

export function deliveryOwnerError(pipeline: Pipeline, owner: Pipeline | null): string | null {
  const delivery = pipeline.delivery;
  if (delivery?.active && delivery.publish === "enabled" && delivery.disposition === "owner"
    && owner?.id === pipeline.id && owner.delivery?.epoch === delivery.epoch
    && pipeline.state !== "closed" && pipeline.state !== "completed") return null;
  return `Viewer publication denied: target owner is ${owner?.id ?? delivery?.ownerId ?? "unclaimed"} at epoch ${owner?.delivery?.epoch ?? delivery?.epoch ?? 0}; this lane must request explicit takeover`;
}

export async function takeoverPipelineDelivery(id: string, expectedOwner: string, expectedEpoch: number, reason: string, conversationId: string | null, admitted?: (pipeline: Pipeline) => boolean): Promise<{ pipeline?: Pipeline; error?: string; status?: number }> {
  return withDeliveryMutationAsync((tx) => {
    const pipeline = tx.get(id);
    if (!pipeline?.delivery) return { error: "pipeline has no delivery target", status: 409 };
    if (admitted && !admitted(pipeline)) return { error: "takeover admission superseded", status: 409 };
    const target = pipeline.delivery.target;
    const owner = tx.pipelineLookup({ ...target, active: true });
    const previous = owner ?? tx.pipelineLookup(target);
    if (!previous?.delivery || previous.delivery.ownerId !== expectedOwner || previous.delivery.epoch !== expectedEpoch) {
      return { error: `delivery owner changed: current owner ${previous?.delivery?.ownerId ?? "none"}, epoch ${previous?.delivery?.epoch ?? 0}`, status: 409 };
    }
    const activeOld = tx.get(expectedOwner);
    // Closed owners can be archived while a comparison lane remains active.
    // Read by id from both collections in this same transaction to retain the
    // exact owner record and its epoch fence after that move.
    const old = activeOld ?? tx.pipelineGet(expectedOwner);
    if (old?.delivery?.operation?.state === "running") return { error: `publisher ${expectedOwner} at epoch ${expectedEpoch} is in flight or its outcome is uncertain; reconcile it before takeover`, status: 409 };
    const completedStage = old?.state === "closed" ? completedComparisonPass(pipeline) : null;
    if (pipeline.state === "closed" || (pipeline.state === "completed" && !completedStage)) return { error: "a terminal lane cannot take ownership without a passed comparison and a closed owner", status: 409 };
    const refused = old?.delivery?.operation;
    if (old && refused?.state === "settled" && refused.result?.ok === false) {
      const attempt = old.runs.find(run => run.stageId === old.cursor?.stageId)?.attempts.at(-1);
      recordPublicationFailure(old, attempt, { operationId: refused.id, epoch: refused.epoch, at: new Date().toISOString(),
        cause: refused.result.failure?.retryableApp403 ? "app-git-403" : refused.result.failure?.retryableDeadline ? "infrastructure-deadline"
          : publicationInterrupted(refused.result) ? "interrupted" : "check-failure",
        detail: refused.result.error.slice(0, 400), recoverable: recoverablePublication(refused.result) },
      publicationInterrupted(refused.result) && !refused.result.failure ? [0, ...PUBLICATION_RETRY_DELAYS_MS.slice(1)] : PUBLICATION_RETRY_DELAYS_MS);
    }
    pipeline.publicationRecovery = mergePublicationRecovery(old?.publicationRecovery, pipeline.publicationRecovery);
    if (old?.delivery && activeOld) {
      withdrawPipelineMerge(old, `Merge superseded by delivery owner ${pipeline.id}`, new Date().toISOString());
      old.delivery.active = false;
      old.delivery.publish = "disabled";
      old.delivery.releasedAt = new Date().toISOString();
      deliveryJournal(old, "release", reason, conversationId);
      tx.put(old);
    }
    pipeline.delivery = { target, disposition: "owner", publish: "enabled", active: true,
      ownerId: pipeline.id, epoch: expectedEpoch + 1, journal: pipeline.delivery.journal };
    delete pipeline.publication;
    pipeline.publishedCommit = null;
    if (completedStage) {
      pipeline.state = "running";
      pipeline.closedAt = null;
      pipeline.pausedState = null;
      pipeline.cursor = { stageId: completedStage, state: "committing", input: null, activatedBy: null };
      pipeline.stateDetail = null;
    }
    deliveryJournal(pipeline, "takeover", reason, conversationId);
    const action = pipeline.remoteAction;
    if (action?.state === "pending" && action.action === "takeover"
      && action.takeover?.expectedOwner === expectedOwner && action.takeover.expectedEpoch === expectedEpoch
      && action.takeover.reason === reason
      && (action.actor?.kind === "agent" ? action.actor.conversationId : null) === conversationId) {
      // Ownership and its admitted outcome are one durable mutation. There
      // is no restart window in which the new epoch still has an old fence.
      pipeline.remoteAction = { ...action, state: "settled", settledAt: new Date().toISOString() };
      if (pipeline.stateDetail === "delivery takeover accepted; remote reconciliation pending") pipeline.stateDetail = null;
      deliveryJournal(pipeline, "recovery", "takeover remote verification settled", conversationId);
    }
    tx.put(pipeline);
    return { pipeline };
  });
}

export function savePipelines(pipelines: Pipeline[]): void {
  pipelineStore().replaceSync(pipelines);
  replaceProjectKeySource("pipelines", canonicalProjectKeys(pipelines.map(pipeline => pipeline.project)));
}

/** Settled records leave the hot registry after this long; the archive keeps
    the full record for the closed list and by-id reads. */
const SETTLED_PIPELINE_ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** Shared archive rows, validated by revision, database identity and decoder
 * authority. Projection consumers must never mutate this frozen graph.
 *
 * Contract of a listed lane. Its structure and every value up to
 * ARCHIVED_PIPELINE_INLINE_TEXT characters are in memory. A longer text (role
 * scaffold, prompt, spec, stage input, output, report text) is read from the
 * lane's row when a reader asks for it: one row read per lane, named
 * `state.deferred-text` in the loop-gap reads, with rows kept decoded up to
 * 32 MB. A reader that walks long text across the whole list therefore reads
 * every archived row once per walk; take `selectArchivedPipelines` or a by-id
 * read for that instead.
 *
 * A lane held across a rewrite of its own row keeps its listed values.
 * `JSON.stringify` of it serializes the current row whole, so a response is
 * one consistent record. A direct read of one of its long texts throws
 * StateSnapshotChangedError, because the listed version's text is gone and a
 * later version's text does not belong to the listed values. Archived rows
 * are written once when a lane settles, so this needs the same lane archived
 * again while a reader holds the list. */
export function loadArchivedPipelinesForList(): readonly Pipeline[] {
  const rows = archiveStore().loadReadonly();
  freezeArchive(rows);
  return rows;
}

export async function loadArchivedPipelinesForListAsync(): Promise<readonly Pipeline[]> {
  const rows = await archiveStore().loadReadonlyAsync();
  if (!Object.isFrozen(rows)) {
    await forEachCooperatively(rows.filter(row => !Object.isFrozen(row)), row => { deepFreeze(row); }, { batchSize: 1, timeBudgetMs: 8 });
    Object.freeze(rows);
  }
  return rows;
}

function freezeArchive(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeArchive(child);
  Object.freeze(value);
}

/** Cold records use the same per-record isolation and strict JSON parsing as
    the active collection. */
export function loadArchivedPipelines(): Pipeline[] {
  return archiveStore().snapshot();
}

export function selectArchivedPipelines(select: (pipeline: Pipeline) => boolean, limit: number): Promise<Pipeline[]> {
  return archiveStore().selectReadonlyAsync(select, limit);
}

/** Narrow attention reconciliation to archived owners named by the current
 * conversation memberships. The closed-lanes list remains the paged reader. */
export function loadArchivedPipelinesForOwnership(ids: readonly string[]): Pipeline[] {
  return [...new Set(ids)].flatMap(id => {
    const pipeline = archiveStore().get(id);
    return pipeline ? [pipeline] : [];
  });
}

/** Collection revision for rechecking a narrow archived-owner observation after admission. */
export function archivedPipelinesRevision(): number {
  return archiveStore().revision();
}

function pipelineSettledForArchive(pipeline: Pipeline, nowMs: number): boolean {
  // The receipt sweep reads the hot collection, even after closure or hiding.
  if (pipeline.merge?.effectUncertain) return false;
  if (!pipelineActivitySettled(pipeline)) return false;
  if (pipeline.unconfirmedHosts?.length) return false;
  if (["completed", "closed"].includes(pipeline.state) && !pipeline.closeTeardown && !pipeline.terminalReap?.settledAt
    && pipelineHasRecordedHost(pipeline)) return false;
  /* The task-finish sweep reads the hot collection and records its durable
     outcome on the marked lane. Keep that lane visible to the sweep while any
     linked mark is unresolved, including while another lane on the task is
     still open. Once every mark has a finish receipt, ordinary archival is
     safe (and a task reopened afterwards intentionally stays open). */
  const finishedTasks = new Set((pipeline.taskFinishes ?? []).map((finish) => finish.taskId));
  if (pipeline.state === "completed" && (pipeline.finishesTaskIds ?? []).some((taskId) => pipeline.taskIds.includes(taskId) && !finishedTasks.has(taskId))) return false;
  /* Closed records archive on closedAt. A discarded draft now closes like
     anything else (#1274), but records discarded before that fix are hidden
     with no closedAt at all, so their hiddenAt still stands in. Anything still
     actionable (running, needs_decision, visible drafts) stays hot. */
  const settledAt = pipeline.closedAt ?? (pipeline.state === "draft" ? pipeline.hiddenAt : null);
  if (!settledAt) return false;
  const parsed = Date.parse(settledAt);
  return Number.isFinite(parsed) && nowMs - parsed > SETTLED_PIPELINE_ARCHIVE_AFTER_MS;
}

/** Move settled records out of the hot registry. The former JSON path parsed
    and rewrote every record here; the archive collection now receives only the
    settled rows before the active collection drops them. */
export async function archiveSettledPipelines(
  nowMs = Date.now(),
  options: { beforeCommit?: () => void } = {},
): Promise<number> {
  return withViewerOperation("pipelines.controller-read", () => pipelineStore().moveMatchingTo(
    archiveStore(),
    (pipeline) => pipelineSettledForArchive(pipeline, nowMs),
    options,
  ));
}

export function checkpointPipelineRollbackMirrorsForDemotion(): { pipelines: number; pipelinesArchive: number } {
  const { active, archive } = stores();
  const pipelines = active.checkpointMirrorForDemotion((pipelines, revision, schemaVersion) => {
    atomicWriteJson(pipelinesFile(), { schemaVersion, _sqliteRevision: revision, pipelines });
  });
  const pipelinesArchive = archive.checkpointMirrorForDemotion((pipelines, revision, schemaVersion) => {
    atomicWriteJson(pipelinesArchiveFile(), { schemaVersion, _sqliteRevision: revision, pipelines });
  });
  return { pipelines, pipelinesArchive };
}

export async function checkpointPipelineRollbackMirrorsForDemotionAsync(): Promise<{ pipelines: number; pipelinesArchive: number }> {
  const { active, archive } = stores();
  const pipelines = await active.checkpointMirrorForDemotionAsync((pipelines, revision, schemaVersion) => {
    atomicWriteJson(pipelinesFile(), { schemaVersion, _sqliteRevision: revision, pipelines });
  });
  const pipelinesArchive = await archive.checkpointMirrorForDemotionAsync((pipelines, revision, schemaVersion) => {
    atomicWriteJson(pipelinesArchiveFile(), { schemaVersion, _sqliteRevision: revision, pipelines });
  });
  return { pipelines, pipelinesArchive };
}

/** Active collection source for the bounded MCP selection projection. */
export function pipelineSelectionSource() {
  const collection = pipelineStore();
  return { filename: stateDatabaseFile(), read: (id: string) => collection.get(id) };
}

/** Bind one in-flight operation to its store, avoiding state-path resolution
 * on every tick. Replacement at the same path is guarded by the connection. */
export function pipelineRecordReader(pipelineId: string) {
  const { active, archive } = stores();
  const authority = () => projectStoreSignature("project-aliases.json");
  return {
    version: active.pipelineRecordVersionReader(pipelineId, authority),
    read: () => active.get(pipelineId) ?? archive.get(pipelineId),
  };
}

/** Full-record read by id: the hot registry first, then the archive. */
export function findPipelineRecord(pipelineId: string): Pipeline | null {
  return pipelineStore().get(pipelineId) ?? archiveStore().get(pipelineId);
}

/** Task-local history, including archived lanes, without materializing every
    unrelated stage and attempt in the installation. */
export function loadPipelinesForTask(taskId: string): Pipeline[] {
  const filename = stateDatabaseFile();
  // Preserve the store's migration and schema admission for legacy installs.
  const rows = stateCollectionsInitialized(filename, pipelineStateCollectionSeeds())
    ? readPipelineRowsForTask(filename, taskId) : null;
  if (rows === null) return [...loadPipelinesForList(), ...loadArchivedPipelinesForList()]
    .filter(pipeline => pipeline.taskIds.includes(taskId));
  return rows.flatMap(row => {
    const pipeline = decodePipeline(row);
    return pipeline?.taskIds.includes(taskId) ? [pipeline] : [];
  });
}

/** Bounded feed for consumers that need task membership changes without loading
 * the full pipeline registry. The cursor follows the active collection log. */
export function pipelineTaskBindingSource() {
  const collection = pipelineStore();
  return {
    revision: () => collection.revision(),
    changesAfter: (revision: number, key: string, limit: number) => collection.changesAfter(revision, key, limit),
    parse: (valueJson: string) => {
      const pipeline = decodePipeline(JSON.parse(valueJson));
      if (!pipeline) throw new PipelineStoreError("invalid pipeline row in task-binding feed");
      return pipeline;
    },
  };
}

/** Validates durable task membership at the pipeline store seam. */
export function pipelineTaskLinkError(
  pipeline: Pick<Pipeline, "project">,
  taskIds: readonly string[],
  tasks: readonly BoardTask[],
  options: { allowMissing?: boolean } = {},
): string | null {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  for (const taskId of taskIds) {
    const task = tasksById.get(taskId);
    if (!task) {
      if (options.allowMissing) continue;
      return `task not found: ${taskId}`;
    }
    if (task.project !== pipeline.project) return `task project does not match pipeline project: ${taskId}`;
  }
  return null;
}


export function pipelineIdentity(id: string, task: string, repoDir: string): Pick<Pipeline, "worktreeDir" | "branch"> {
  const repoName = path.basename(repoDir);
  return {
    worktreeDir: path.join(path.dirname(repoDir), `${repoName}-pipeline-${id}`),
    branch: `pipeline/${slugify(task)}-${id}`,
  };
}

export function buildPipeline(input: {
  taskClass?: import("./accounting").DeclaredClass;
  id: string;
  task: string;
  taskIds?: string[];
  creationIntent?: PipelineCreationIntent;
  spec?: string;
  inputContext?: import("./prompts").StagePromptContext;
  project: string;
  repoDir: string;
  stages: PipelineStage[];
  srcPath: string | null;
  srcConversationId: string | null;
  srcDeputyConversationId?: string | null;
  now: string;
  state?: "draft" | "provisioning";
  publication?: PipelinePublication;
}): Pipeline {
  const identity = pipelineIdentity(input.id, input.task, input.repoDir);
  return {
    id: input.id,
    task: input.task,
    taskIds: [...new Set(input.taskIds ?? [])],
    ...(input.creationIntent ? { creationIntent: { ...input.creationIntent } } : {}),
    ...(input.spec ? { spec: input.spec } : {}),
    ...(input.inputContext ? { inputContext: structuredClone(input.inputContext) } : {}),
    taskClass: { ...declaredClassSchema.parse(input.taskClass ?? {}), project: input.project },
    project: input.project,
    repoDir: input.repoDir,
    ...identity,
    baseBranch: "",
    baseRef: "",
    baseRefPinned: false,
    lastPassedCommit: "",
    ...(input.publication ? { publication: input.publication } : {}),
    publishedCommit: null,
    stages: (JSON.parse(JSON.stringify(input.stages)) as PipelineStage[]).map((stage) => ({
      ...stage,
      onFail: defaultStageFailEdge(stage, stage.onFail),
    })),
    runs: input.stages.map((stage) => ({ stageId: stage.id, attempts: [] })),
    cursor: input.stages.length ? { admittedAt: input.state === "draft" || !Number.isFinite(Date.parse(input.now)) ? undefined : input.now, stageId: input.stages[0]!.id, state: "pending", input: null, activatedBy: null } : null,
    state: input.state ?? "provisioning",
    pausedState: null,
    stateDetail: null,
    srcPath: input.srcPath,
    srcConversationId: input.srcConversationId,
    ...(input.srcDeputyConversationId ? { srcDeputyConversationId: input.srcDeputyConversationId } : {}),
    createdAt: input.now,
    closedAt: null,
    hiddenAt: null,
  };
}

export function pipelineArtifactsDir(pipelineId: string): string {
  return path.join(artifactsRoot(), pipelineId);
}
