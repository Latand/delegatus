import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { agentRegistry, type ConversationLookup } from "@/lib/agent/registry";
import { forEachCooperatively } from "@/lib/cooperative";
import { initializeStateCollections, SqliteStateCollection, type StateCollectionSeed } from "@/lib/state/sqliteStateStore";
import { ROLE_DEFAULTS } from "@/lib/roles/defaults";
import { canonicalProject } from "@/lib/projects/aliases";
import { resolveRole } from "@/lib/roles/registry";
import { loadRoleDefinitionsOrDefaults } from "@/lib/roles/store";
import type { RoleDefinition } from "@/lib/roles/types";

import { isFlow, decodeFlow } from "@/lib/reviewHistory/decode";

import type { Flow, FlowPreset, Round } from "./types";

/* Resolve on every call, never bake at module load: a test that pins
   LLV_STATE_DIR after this module is first imported (import order across a
   suite is not guaranteed) must still redirect writes to its sandbox. Baking
   the path here once let a mis-ordered test clobber the user's real
   flows.json. */
const flowsFile = () => statePath("flows.json");
const stateDatabaseFile = () => statePath("state.sqlite");
const presetsFile = () => statePath("review-loop-presets.json");

/** A role override that passes the store's shape check can still fail the
    registry's semantic validation (e.g. a codex model not prefixed `gpt-`).
    Seed derivation must never crash on that — it falls back to the role's
    hardcoded default config instead of propagating the broken override. */
function flowRole(definitions: RoleDefinition[], role: "builder" | "reviewer" | "architect", params: Record<string, string> = {}): FlowPreset["implementer"] {
  if (role !== "builder") return { ...definitions.find((candidate) => candidate.id === role)!.config };
  const resolved = resolveRole(role, params, {}, definitions);
  if (resolved.ok) return { ...resolved.value.config };
  return { ...ROLE_DEFAULTS.find((candidate) => candidate.id === role)!.config };
}

/** New seed profiles derive their defaults from the role registry. */
export function seededPresetsFromRoles(): FlowPreset[] {
  const definitions = loadRoleDefinitionsOrDefaults();
  const builder = flowRole(definitions, "builder");
  const fixer = flowRole(definitions, "builder", { mode: "apply-fixes", domain: "general" });
  const reviewer = flowRole(definitions, "reviewer");
  const architect = flowRole(definitions, "architect");
  const presets: FlowPreset[] = [
    { name: "Astra medium → Astra xhigh", implementer: builder, reviewer },
    { name: "Terra low → Astra xhigh", implementer: fixer, reviewer },
    { name: "Astra medium → Opus 5", implementer: builder, reviewer: architect },
    { name: "Opus 5 → Astra xhigh", implementer: architect, reviewer },
    { name: "Sonnet → Astra xhigh", implementer: { engine: "claude", model: "sonnet", effort: "high" }, reviewer },
  ];
  return presets.map((preset) => ({ ...preset, managed: "role-registry" }));
}

/** The role-registry-backed fallback captured into new and legacy Codex flows. */
export function configuredReviewerFallback(): FlowPreset["reviewer"] {
  return flowRole(loadRoleDefinitionsOrDefaults(), "architect");
}

export const FLOWS_SCHEMA_VERSION = 3;

type FlowFile = { schemaVersion?: unknown; flows?: unknown };
type PresetFile = { presets?: unknown };

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, filePath);
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function readFlowStateJson(): unknown | null {
  let source: string;
  try {
    source = fs.readFileSync(flowsFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("could not read legacy flow state", { cause: error });
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("legacy flow state contains malformed JSON", { cause: error });
  }
}


function isPreset(value: unknown): value is FlowPreset {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preset = value as Partial<FlowPreset>;
  return typeof preset.name === "string" && isRoleConfig(preset.implementer) && isRoleConfig(preset.reviewer) && (preset.managed === undefined || preset.managed === "role-registry");
}

function isRoleConfig(value: unknown): value is FlowPreset["implementer"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const role = value as Partial<FlowPreset["implementer"]>;
  return (
    (role.engine === "claude" || role.engine === "codex") &&
    (role.model === null || typeof role.model === "string") &&
    (role.effort === null || typeof role.effort === "string")
  );
}

/** Seed missing names only: persisted selections, including formerly managed
    seeds, belong to the operator and are never migrated on read. */
export function mergeSeededPresets(presets: FlowPreset[], seeds = seededPresetsFromRoles()): FlowPreset[] {
  const names = new Set(presets.map((preset) => preset.name));
  return [...seeds.filter((preset) => !names.has(preset.name)), ...presets];
}

let flowsCache: { signature: string; flows: Flow[] } | null = null;
const flowStores = new Map<string, SqliteStateCollection<Flow>>();
const flowSnapshots = new WeakMap<Flow[], Map<string, string>>();

function rememberFlowSnapshot(flows: Flow[]): Flow[] {
  flowSnapshots.set(flows, new Map(flows.map((flow) => [flow.id, JSON.stringify(flow)])));
  return flows;
}

function flowsFileSignature(): string {
  return flowStore().signature();
}

/** Fresh per-call copies of every layer a caller may write (flow and round
    rows) — the same freshness depth the parse path produces — so the cached
    records stay pristine while callers mutate and save their copies. Deeper
    config leaves are shared; nothing mutates their internals in place. */
function reviveCachedFlows(flows: Flow[]): Flow[] {
  return flows.map((flow) => ({
    ...flow,
    hostClaim: flow.hostClaim ? { ...flow.hostClaim } : null,
    rounds: flow.rounds.map((round) => ({ ...round })),
  }));
}

/** The normalized flow projection keeps the signature cache introduced for
    the JSON store. Its invalidation source is now the SQLite collection
    revision, including revisions committed by another process. */
export function loadFlows(): Flow[] {
  const before = flowsFileSignature();
  if (flowsCache?.signature === before) return rememberFlowSnapshot(reviveCachedFlows(flowsCache.flows));
  const parsed = flowStore().snapshot();
  const after = flowsFileSignature();
  if (before === after) flowsCache = { signature: after, flows: parsed };
  return rememberFlowSnapshot(reviveCachedFlows(parsed));
}

/** Keyed full reads for the bounded MCP flow list projection. */
export function flowSelectionSource() {
  const collection = flowStore();
  return { filename: stateDatabaseFile(), read: (id: string) => collection.get(id) };
}

export function loadFlow(flowId: string): Flow | null {
  return flowStore().get(flowId);
}

function flowControllerActive(flow: Flow): boolean {
  return ![
    "approved",
    "done_comment",
    "needs_decision",
    "closed",
  ].includes(flow.state);
}

export function flowStateCollectionSeed(): StateCollectionSeed<Flow> {
  return {
    collection: "flows",
    schemaVersion: FLOWS_SCHEMA_VERSION,
    migrationId: "flows-json-v1",
    loadRecords: parseFlowsFromDisk,
    key: (flow: Flow) => flow.id,
    controllerActive: flowControllerActive,
  };
}

export function loadFlowsForTick(): Flow[] {
  return flowStore().snapshotForController();
}

/** A relay hold persisted before `resetKnown` existed always carried the
    provider's own deadline in `until`, so it reads back as a known reset
    (#611). Without this, an in-flight hold written by the previous process
    would come back looking like an unknown reset and be surfaced as one. */
function normalizeRelayHold(hold: Round["relayHold"]): Round["relayHold"] {
  return hold ? { ...hold, resetKnown: hold.resetKnown ?? true } : null;
}

function parseFlowsFromDisk(): Flow[] {
  const raw = readFlowStateJson();
  if (raw === null) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("legacy flow state must be an object");
  }
  const file = raw as FlowFile;
  if (!Array.isArray(file.flows) || !file.flows.every(isFlow)) {
    throw new Error("legacy flow state contains malformed records");
  }
  const flows = file.flows;
  return flows.map((flow) => ({
    ...flow,
    project: canonicalProject(flow.project),
    revision: flow.revision ?? 0,
    targetSha: flow.targetSha ?? null,
    implementerConversationId: flow.implementerConversationId ?? null,
    reviewerFallback: flow.reviewerFallback === undefined && flow.roles.reviewer.engine === "codex"
      ? configuredReviewerFallback()
      : flow.reviewerFallback ?? null,
    pausedState: flow.pausedState ?? null,
    kickoffDelivery: flow.kickoffDelivery ?? null,
    hostClaim: flow.hostClaim ?? null,
    rounds: flow.rounds.map((round) => ({
      ...round,
      reviewerConversationId: round.reviewerConversationId ?? null,
      /* A null snapshot is meaningful (issue #117 retry resets it so the launch
         re-picks a fresh account/role), so it is preserved rather than backfilled;
         reviewerRoleFor falls back to flow.roles.reviewer for a null/absent value. */
      reviewerRole: round.reviewerRole ?? null,
      attemptedAccounts: round.attemptedAccounts ?? [],
      autoRetryCount: round.autoRetryCount ?? 0,
      sessionId: round.sessionId ?? null,
      reviewerPid: round.reviewerPid ?? null,
      reviewerIdentity: round.reviewerIdentity ?? null,
      reviewHeadSha: round.reviewHeadSha ?? null,
      spawnStartedAt: round.spawnStartedAt ?? null,
      launchId: round.launchId ?? null,
      launchLeaseUntil: round.launchLeaseUntil ?? null,
      relayStartedAt: round.relayStartedAt ?? null,
      relayRetryCount: round.relayRetryCount ?? 0,
      relayDeliveryAttempt: round.relayDeliveryAttempt ?? 0,
      relayDeliveryTransport: round.relayDeliveryTransport ?? null,
      relayRetryAt: round.relayRetryAt ?? null,
      relayRetryRequiresIdempotency: round.relayRetryRequiresIdempotency ?? false,
      relayDelivery: round.relayDelivery ?? null,
      relayPendingSettlement: round.relayPendingSettlement ?? null,
      relayHold: normalizeRelayHold(round.relayHold),
      terminalAt: round.terminalAt ?? null,
      error: round.error ?? null,
    })),
  }));
}

export function planFlowStateMigration(): { records: number; keys: string[] } {
  const records = parseFlowsFromDisk();
  return { records: records.length, keys: records.map((flow) => flow.id) };
}


function flowStore(): SqliteStateCollection<Flow> {
  const filename = stateDatabaseFile();
  const held = flowStores.get(filename);
  if (held) return held;
  initializeStateCollections(filename, [flowStateCollectionSeed()]);
  const store = new SqliteStateCollection(filename, {
    collection: "flows",
    schemaVersion: FLOWS_SCHEMA_VERSION,
    busyMessage: "flow state is busy",
    key: (flow) => flow.id,
    decode: (value) => decodeFlow(value, { project: canonicalProject, reviewerFallback: configuredReviewerFallback }),
    clone: (flow) => reviveCachedFlows([flow])[0]!,
    controllerActive: flowControllerActive,
    strictDecode: true,
    decodeError: (error) => new Error("flow SQLite state contains a malformed row", { cause: error }),
  });
  flowStores.set(filename, store);
  return store;
}

export function checkpointFlowRollbackMirrorForDemotion(): number {
  return flowStore().checkpointMirrorForDemotion((flows, revision) => {
    atomicWriteJson(flowsFile(), { schemaVersion: FLOWS_SCHEMA_VERSION, _sqliteRevision: revision, flows });
  });
}

export async function checkpointFlowRollbackMirrorForDemotionAsync(): Promise<number> {
  return flowStore().checkpointMirrorForDemotionAsync((flows, revision) => {
    atomicWriteJson(flowsFile(), { schemaVersion: FLOWS_SCHEMA_VERSION, _sqliteRevision: revision, flows });
  });
}

function reconcileFlowImplementer(flow: Flow, registry: ConversationLookup): boolean {
  if (flow.implementerConversationId?.startsWith("conversation_")) {
    const current = registry.conversation(flow.implementerConversationId as `conversation_${string}`)?.generations.at(-1)?.path;
    if (current && current !== flow.implementerPath) { flow.implementerPath = current; return true; }
    return false;
  }
  const owner = registry.conversationForPath(flow.implementerPath);
  if (!owner) return false;
  flow.implementerConversationId = owner.id;
  const current = owner.generations.at(-1)?.path;
  if (current) flow.implementerPath = current;
  return true;
}

function reconcileFlowRound(round: Round, registry: ConversationLookup): boolean {
  if (round.reviewerConversationId?.startsWith("conversation_")) {
    const current = registry.conversation(round.reviewerConversationId as `conversation_${string}`)?.generations.at(-1)?.path;
    if (current && current !== round.reviewerPath) { round.reviewerPath = current; return true; }
    return false;
  }
  if (!round.reviewerPath) return false;
  const owner = registry.conversationForPath(round.reviewerPath);
  if (!owner) return false;
  round.reviewerConversationId = owner.id;
  const current = owner.generations.at(-1)?.path;
  if (current) round.reviewerPath = current;
  return true;
}

type ConversationBinding = { path: string | null; conversationId: string | null };
type ImplementerBinding = { path: string; conversationId: string | null };
type FlowOwnershipPatch = {
  id: string;
  implementer: { before: ImplementerBinding; after: ImplementerBinding } | null;
  rounds: { n: number; before: ConversationBinding; after: ConversationBinding }[];
};

function sameBinding(pathname: string | null, conversationId: string | null | undefined, expected: ConversationBinding): boolean {
  return pathname === expected.path && (conversationId ?? null) === expected.conversationId;
}

function mergeFlowOwnershipPatches(patches: readonly FlowOwnershipPatch[]): void {
  if (patches.length === 0) return;
  const current = loadFlows();
  const currentById = new Map(current.map((flow) => [flow.id, flow]));
  let changed = false;
  for (const patch of patches) {
    const flow = currentById.get(patch.id);
    if (!flow) continue;
    if (patch.implementer && sameBinding(flow.implementerPath, flow.implementerConversationId, patch.implementer.before)) {
      flow.implementerPath = patch.implementer.after.path;
      flow.implementerConversationId = patch.implementer.after.conversationId;
      changed = true;
    }
    for (const roundPatch of patch.rounds) {
      const round = flow.rounds.find((candidate) => candidate.n === roundPatch.n);
      if (!round || !sameBinding(round.reviewerPath, round.reviewerConversationId, roundPatch.before)) continue;
      round.reviewerPath = roundPatch.after.path;
      round.reviewerConversationId = roundPatch.after.conversationId;
      changed = true;
    }
  }
  if (changed) saveFlows(current);
}

export function reconcileFlowConversationOwnership(registry: ConversationLookup = agentRegistry()): void {
  const flows = loadFlows();
  let dirty = false;
  for (const flow of flows) {
    dirty = reconcileFlowImplementer(flow, registry) || dirty;
    for (const round of flow.rounds) dirty = reconcileFlowRound(round, registry) || dirty;
  }
  if (dirty) saveFlows(flows);
}

export async function reconcileFlowConversationOwnershipCooperatively(registry: ConversationLookup = agentRegistry()): Promise<void> {
  const flows = loadFlows();
  const patches: FlowOwnershipPatch[] = [];
  await forEachCooperatively(flows, async (flow) => {
    const implementerBefore = { path: flow.implementerPath, conversationId: flow.implementerConversationId ?? null };
    const implementerChanged = reconcileFlowImplementer(flow, registry);
    const roundPatches: FlowOwnershipPatch["rounds"] = [];
    await forEachCooperatively(flow.rounds, (round) => {
      const before = { path: round.reviewerPath, conversationId: round.reviewerConversationId ?? null };
      if (reconcileFlowRound(round, registry)) {
        roundPatches.push({
          n: round.n,
          before,
          after: { path: round.reviewerPath, conversationId: round.reviewerConversationId ?? null },
        });
      }
    });
    if (implementerChanged || roundPatches.length > 0) {
      patches.push({
        id: flow.id,
        implementer: implementerChanged ? {
          before: implementerBefore,
          after: { path: flow.implementerPath, conversationId: flow.implementerConversationId ?? null },
        } : null,
        rounds: roundPatches,
      });
    }
  });
  mergeFlowOwnershipPatches(patches);
}

function comparableFlow(flow: Flow): string {
  const content: Flow = { ...flow };
  delete content.revision;
  return JSON.stringify(content);
}

function replaceFlow(target: Flow, source: Flow): void {
  for (const key of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[key];
  Object.assign(target, structuredClone(source));
}

function prepareFlowRevisions(flows: readonly Flow[]): void {
  for (const flow of flows) {
    const stored = flowStore().get(flow.id) ?? undefined;
    if (stored && flow.revision !== undefined && flow.revision < (stored.revision ?? 0)) {
      replaceFlow(flow, stored);
      continue;
    }
    flow.revision = stored && comparableFlow(stored) === comparableFlow(flow)
      ? stored.revision ?? 0
      : (stored?.revision ?? 0) + 1;
  }
}

export function saveFlows(flows: Flow[]): void {
  const baseline = flowSnapshots.get(flows);
  if (!baseline) {
    flowStore().replaceSync(flows, { beforePersist: prepareFlowRevisions });
    rememberFlowSnapshot(flows);
    return;
  }
  const localIds = new Set(flows.map((flow) => flow.id));
  const changed = flows.filter((flow) => baseline.get(flow.id) !== JSON.stringify(flow));
  const removed = [...baseline.keys()].filter((id) => !localIds.has(id));
  flowStore().patchSync(() => {
    prepareFlowRevisions(changed);
    const acceptedDeletes = removed.filter((id) => {
      const current = flowStore().get(id);
      return current !== null && JSON.stringify(current) === baseline.get(id);
    });
    return { records: changed, deleteKeys: acceptedDeletes };
  });
  rememberFlowSnapshot(flows);
}

/** Persist a known changed subset while preserving every omitted flow row. */
export function saveFlowRows(flows: Flow[]): void {
  if (flows.length === 0) return;
  flowStore().replaceSync(flows, {
    mergeOmitted: true,
    beforePersist: prepareFlowRevisions,
  });
}

/** Read selected durable rows and prepare their replacements while holding the
 * process-shared collection lease. */
export function patchFlowRows(
  flowIds: Iterable<string>,
  prepare: (current: Flow[]) => readonly Flow[],
): void {
  const ids = [...new Set(flowIds)];
  if (ids.length === 0) return;
  const store = flowStore();
  store.patchSync(() => {
    const current = ids.flatMap((id) => {
      const flow = store.get(id);
      return flow ? [flow] : [];
    });
    const records = prepare(current);
    prepareFlowRevisions(records);
    return { records };
  });
}

/** Re-read and mutate flow state under the process-shared SQLite lease. */
export async function withFlowMutation<T>(mutate: (flows: Flow[], persist: () => void) => T): Promise<T> {
  return await flowStore().mutate(mutate, ({ dirtyRecords }) => prepareFlowRevisions(dirtyRecords));
}

/** Hold the flow collection lease while a cross-store consumer projects one exact
    durable generation. The callback cannot mutate flows through this interface. */
export function withFlowSnapshot<T>(read: (flows: readonly Flow[]) => T): T {
  return flowStore().withSnapshotSync(read);
}

export function loadPresets(): FlowPreset[] {
  const raw = readJson(presetsFile()) as PresetFile | null;
  const presets = Array.isArray(raw?.presets) ? raw.presets.filter(isPreset) : [];
  const merged = mergeSeededPresets(presets);
  if (JSON.stringify(merged) !== JSON.stringify(presets)) savePresets(merged);
  return merged;
}

export function savePresets(presets: FlowPreset[]): void {
  atomicWriteJson(presetsFile(), { presets });
}

export { flowArtifactsDir, findingsPathFor, outputPathFor, stderrPathFor, stdoutPathFor } from "@/lib/reviewHistory/artifacts";
export { atomicWriteText } from "@/lib/agent/artifacts";
export { normalizeFindings } from "@/lib/review/findings";
