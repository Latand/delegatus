import { yieldToRuntime } from "@/lib/cooperative";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { accountManager } from "@/lib/accounts/manager";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { creditGuardBlock } from "@/lib/accounts/creditGuard";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import type { AgentRegistry, RegistryConversation } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { findPipelineRecord, loadPipelinesForRetirement } from "@/lib/pipelines/store";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { openRuntimeSwitch } from "@/lib/pipelines/runtimeSwitch";
import { activeOrchestratorSeats } from "@/lib/orchestrator/seats";
import { StructuredSendRefusedError, type EngineHost } from "./engineHost";
import { delegatusMessageOrigin } from "./agentMessageAuthor";
import type { StructuredMessageRequest, StructuredMessageResult } from "./structuredMessageDelivery";
import { interruptionObligationDirectory, accountGuardObligationRevision, accountGuardObligationStore, submittedContinuationOutcome, STAGE_CUT_RESOLUTION, REVIEWER_CUT_RESOLUTION } from "./interruptionObligations";

function pipelineOwner(conversationId: string, registry?: AgentRegistry) {
  const conversation = registry?.conversation(conversationId as ViewerConversationId);
  const pipelines = conversation ? registry!.conversationMemberships(conversation.id)
    .filter(membership => membership.kind === "pipeline").flatMap(membership => {
      const pipeline = findPipelineRecord(membership.containerId);
      return pipeline ? [pipeline] : [];
    }) : loadPipelinesForRetirement();
  for (const pipeline of pipelines) {
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (attempt.conversationId === conversationId || attempt.conversationId && conversation
          && registry!.canonicalConversationId(attempt.conversationId as ViewerConversationId) === conversation.id) return { pipeline, attempt,
          stage: pipeline.stages.find(stage => stage.id === run.stageId) };
      }
    }
  }
  return null;
}

/** A stopped attempt retains its checkout until its controller replaces it.
 * Late sends and on-demand recovery cannot take that checkout back. */
export function assertPipelineTurnAllowed(conversationId: string, registry?: AgentRegistry): void {
  if (pipelineOwner(conversationId, registry)?.attempt.suspension) {
    throw new StructuredSendRefusedError("pipeline attempt is suspended; its controller owns recovery");
  }
}

interface GuardPassState {
  registryRevision: number;
  obligationRevision: number;
  hosts: unknown;
  fallbackAt: number;
  cursor: string;
  store: ReturnType<typeof accountGuardObligationStore>;
  running?: Promise<void>;
}
const shared = process as typeof process & { __llvAccountGuardPasses?: WeakMap<AgentRegistry, GuardPassState> };
const passes = shared.__llvAccountGuardPasses ??= new WeakMap<AgentRegistry, GuardPassState>();
export const ACCOUNT_GUARD_FALLBACK_MS = 30_000;

function recoveryCustody(conversation: RegistryConversation): string {
  const generation = conversation.generations.at(-1);
  const migration = conversation.migration;
  const reconfigure = conversation.reconfigure;
  return JSON.stringify([conversation.id, generation?.id, generation?.path, generation?.accountId,
    migration && [migration.operationId, migration.intentId, migration.revision, migration.phase, migration.targetId,
      migration.sourceGenerationId, migration.creditGuard],
    reconfigure && [reconfigure.operationId, reconfigure.revision, reconfigure.status]]);
}

/** Stop every locally owned credited turn at the cutoff. The durable cut is
 * written before releasing its host. Ordinary stages retain their controller's
 * retry policy; other conversations keep one continuation behind the existing
 * conversation-scoped migration and delivery receipts. */
async function runAccountCreditGuard(registry: AgentRegistry,
  hosts: readonly { key: SessionKey; host: EngineHost }[],
  stop: (key: SessionKey, host: EngineHost) => Promise<boolean>,
  operatorStopped: (conversationId: string, since: string) => Promise<boolean>,
  resumeCurrent: (request: StructuredMessageRequest) => Promise<StructuredMessageResult | null>): Promise<void> {
  const state = passes.get(registry)!;
  const store = state.store;
  const blockedAccounts = new Set(registry.quotaObservations("codex")
    .filter(row => creditGuardBlock("codex", row.limits)).map(row => row.accountId));
  const headlessStop = blockedAccounts.size ? import("@/lib/flows/engine")
    .then(({ enforceHeadlessAccountCreditGuard }) => enforceHeadlessAccountCreditGuard(registry, blockedAccounts)) : Promise.resolve();
  const stops = await Promise.allSettled([...hosts.map(async item => {
    if (item.key.engine !== "codex" || blockedAccounts.size === 0) return;
    const entry = registry.readOnlySnapshot().entries[sessionKeyId(item.key)];
    if (!entry?.artifactPath) return;
    const conversation = registry.conversationForPath(entry.artifactPath);
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation || generation.id !== item.key.sessionId) return;
    if (!generation.accountId || !blockedAccounts.has(generation.accountId)) return;
    const owner = pipelineOwner(conversation.id, registry);
    if (owner && openRuntimeSwitch(owner.attempt)) return;
    const reviewer = registry.conversationMemberships(conversation.id).some(membership => membership.kind === "flow" && membership.role === "reviewer");
    const seat = activeOrchestratorSeats().find(item => item.conversationId?.startsWith("conversation_")
      && registry.canonicalConversationId(item.conversationId as ViewerConversationId) === conversation.id);
    const health = await item.host.health().catch(() => null);
    const turnRef = health?.activeTurnRef ?? entry.structuredHost?.activeTurnRef ?? null;
    if (!turnRef && (health ? health.status !== "active" && health.status !== "attention" : entry.status !== "live")) return;
    const { obligation: currentCut } = await store.record({ conversationId: conversation.id, engine: "codex", hostKey: sessionKeyId(item.key), path: generation.path,
      owner: health?.pid ? { pid: health.pid, startIdentity: health.processStartIdentity } : entry.structuredHost?.process ?? null,
      claimEpoch: entry.claimEpoch, turnRef, boundary: "paid-credit-guard", reason: "account-guard",
      checkpoint: { lastEventKind: null, lastEventAt: Date.now() }, seat: seat ? { project: seat.project, seatEpoch: seat.seatEpoch } : null,
      ...(owner?.stage?.kind === "run" ? { answeredBy: STAGE_CUT_RESOLUTION } : reviewer ? { answeredBy: REVIEWER_CUT_RESOLUTION } : {}) });
    // A native directory cursor can move while older pointers are removed.
    // Verify an empty cleanup pass before stopping; each read still admits
    // at most 64 records, and each discharge keeps its ordinary durable row.
    for (;;) {
      let discharged = false;
      for await (const page of store.conversationPages(conversation.id)) for (const older of page) {
        if (older.id !== currentCut.id && older.reason === "account-guard" && older.state === "owed" && older.conversationId === conversation.id) {
          await store.update(older.id, { state: "discharged", resolvedAt: new Date().toISOString(), resolution: "a newer active turn owns recovery" });
          discharged = true;
          await yieldToRuntime();
        }
      }
      if (!discharged) break;
    }
    if (!await stop(item.key, item.host)) throw new Error("paid-credit guard could not confirm host termination");
  }), headlessStop]);
  const failures = stops.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "paid-credit guard termination remains pending");
  const { obligations: page, nextCursor, acknowledge } = await store.scanPage();
  for (const obligation of page) {
    if (obligation.reason !== "account-guard") continue;
    if (obligation.state === "submitted") {
      const outcome = submittedContinuationOutcome(obligation, registry.readOnlySnapshot(), id => registry.canonicalConversationId(id));
      if (outcome) {
        await store.update(obligation.id, { state: outcome.state, resolvedAt: outcome.at ?? new Date().toISOString(), resolution: outcome.resolution });
        continue;
      }
    }
    if (obligation.state !== "owed" && obligation.state !== "submitted") continue;
    const conversation = registry.conversation(obligation.conversationId);
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation || conversation.supersededBy) continue;
    if (obligation.seat && !activeOrchestratorSeats().some(seat => seat.project === obligation.seat!.project
      && seat.seatEpoch === obligation.seat!.seatEpoch && seat.conversationId?.startsWith("conversation_")
      && registry.canonicalConversationId(seat.conversationId as ViewerConversationId) === conversation.id)) {
      await store.update(obligation.id, { state: "discharged", resolvedAt: new Date().toISOString(), resolution: "the orchestrator seat was rotated" });
      continue;
    }
    const moved = sessionKeyId({ engine: conversation.engine, sessionId: generation.id }) !== obligation.hostKey;
    const sourceIndex = conversation.generations.findIndex(item => sessionKeyId({ engine: conversation.engine, sessionId: item.id }) === obligation.hostKey);
    const migrationSourceIndex = conversation.generations.findIndex(item => item.id === conversation.migration?.sourceGenerationId);
    // Each guard reseat starts at the latest generation. The cut and its
    // continuation identity still belong to the original interrupted turn.
    if (moved && (!conversation.migration?.creditGuard || sourceIndex < 0 || migrationSourceIndex < sourceIndex)) {
      await store.update(obligation.id, { state: "discharged", resolvedAt: new Date().toISOString(), resolution: "another runtime selection moved the conversation" });
      continue;
    }
    const owner = pipelineOwner(conversation.id, registry);
    const eligible = () => {
      const current = pipelineOwner(conversation.id, registry);
      return !current || current.pipeline.state === "running" && !current.pipeline.closedAt
        && !current.attempt.suspension && !openRuntimeSwitch(current.attempt);
    };
    if (!eligible() || conversation.reconfigure?.status === "applying") continue;
    const custody = recoveryCustody(conversation);
    if (await operatorStopped(conversation.id, obligation.recordedAt)) {
      await store.update(obligation.id, { state: "discharged", resolvedAt: new Date().toISOString(), resolution: "operator stopped the conversation after the guard" });
      continue;
    }
    // The stop may have failed after writing its cut. Never create a successor
    // while the source still has a registered or recorded resident host.
    const entry = registry.readOnlySnapshot().entries[obligation.hostKey];
    if (entry && entry.status !== "dead" && entry.status !== "unhosted") continue;
    const project = owner?.pipeline.project ?? conversationProjectKey(conversation.projectOwnership, generation.launchProfile);
    const resolve = accountManager.resolveProjectSpawn.bind(accountManager);
    const sourceCanResume = !conversation.migration || ["committed", "rolled-back"].includes(conversation.migration.phase);
    const recoveredSource = !moved && sourceCanResume && generation.accountId && !blockedAccounts.has(generation.accountId)
      ? resolve("codex", { project, model: generation.launchProfile.model, requireCapacity: true, requestedId: generation.accountId }) : null;
    let selection = recoveredSource?.kind === "available" ? recoveredSource
      : resolve("codex", { project, model: generation.launchProfile.model, requireCapacity: true,
        ...(moved ? { requestedId: generation.accountId } : { unavailableIds: generation.accountId ? [generation.accountId] : [] }) });
    if (moved && selection.kind !== "available") {
      selection = resolve("codex", { project, model: generation.launchProfile.model, requireCapacity: true,
        unavailableIds: generation.accountId ? [generation.accountId] : [] });
    }
    if (selection.kind !== "available" || !selection.account.accountId) continue;
    const target = selection.account.accountId;
    const authorizeTarget = () => {
      if (!eligible()) throw new Error("paid-credit recovery lost pipeline custody");
      const latest = registry.conversation(conversation.id);
      if (!latest || latest.supersededBy || latest.reconfigure?.status === "applying"
        || recoveryCustody(latest) !== custody) {
        throw new Error("paid-credit recovery lost conversation custody");
      }
      const latestProfile = latest?.generations.at(-1)?.launchProfile;
      const latestProject = pipelineOwner(conversation.id, registry)?.pipeline.project
        ?? conversationProjectKey(latest?.projectOwnership, latestProfile);
      const selected = resolve("codex", { project: latestProject, model: latestProfile?.model, requestedId: target, requireCapacity: true });
      if (selected.kind !== "available" || selected.account.accountId !== target) throw new Error("paid-credit recovery target is no longer admissible");
    };
    authorizeTarget();
    if (target !== generation.accountId) {
      await registry.deliveryWriteOrBusy({ label: "account-credit-guard.reseat", operationId: obligation.id }, () => {
        authorizeTarget();
        return registry.requestConversationReseat(conversation.id, target, undefined, undefined, true);
      });
      requestAccountMigrationTick();
      continue;
    }
    if (obligation.state === "submitted") continue;
    const current = registry.conversation(conversation.id);
    if (current?.generations.at(-1)?.accountId !== target || moved && current.migration?.phase !== "committed") continue;
    authorizeTarget();
    const deliveries = registry.conversationDeliverySnapshot({ conversationId: conversation.id });
    const newerDelivery = Object.values(deliveries.heldDeliveries).some(delivery => delivery.clientMessageId !== obligation.id
      && delivery.state !== "failed" && Date.parse(delivery.createdAt) > Date.parse(obligation.recordedAt));
    if (newerDelivery) {
      await store.update(obligation.id, { state: "discharged", resolvedAt: new Date().toISOString(), resolution: "a newer message continues the conversation" });
      requestAccountMigrationTick();
      continue;
    }
    const text = "The paid-credit guard stopped your previous turn. Continue the same work from the preserved transcript and checkout; verify interrupted operations before repeating them.";
    const origin = delegatusMessageOrigin("runtime-host", project, generation.launchProfile.cwd);
    if (!moved) {
      const result = await resumeCurrent({ conversationId: conversation.id, path: generation.path,
        clientMessageId: obligation.id, operationId: obligation.id, text, origin, recoveryAuthorityGuard: authorizeTarget });
      if (result?.ok) await store.update(obligation.id, { state: result.outcome === "delivered" ? "delivered" : "submitted",
        operationId: result.operationId, attempts: obligation.attempts + 1,
        ...(result.outcome === "delivered" ? { resolvedAt: new Date().toISOString(), resolution: "delivered" } : {}) });
      else throw new Error(result?.error ?? "credit-guard continuation could not be admitted");
      continue;
    }
    const held = await registry.deliveryWriteOrBusy({ label: "account-credit-guard.continue", operationId: obligation.id }, () => {
      authorizeTarget();
      return registry.holdDelivery(conversation.id,
      text,
      obligation.id, "text", [], null, { operationId: obligation.id, kind: "send", policy: "queue", turnId: null,
        origin });
    });
    await store.update(obligation.id, { state: "submitted", operationId: held.command.operationId, attempts: obligation.attempts + 1 });
    requestAccountMigrationTick();
  }
  acknowledge();
  state.cursor = nextCursor ?? "";
}

type GuardHosts = Parameters<typeof runAccountCreditGuard>[1];
export function enforceAccountCreditGuard(registry: AgentRegistry, hosts: GuardHosts | (() => GuardHosts),
  stop: Parameters<typeof runAccountCreditGuard>[2], operatorStopped: Parameters<typeof runAccountCreditGuard>[3],
  resumeCurrent: Parameters<typeof runAccountCreditGuard>[4], options: { onlyIfChanged?: boolean; now?: number } = {}): Promise<void> {
  let state = passes.get(registry);
  const directory = interruptionObligationDirectory(registry.filename);
  if (!state) {
    state = { registryRevision: -1, obligationRevision: -1, hosts: null, fallbackAt: 0, cursor: "",
      store: accountGuardObligationStore(directory) };
    passes.set(registry, state);
  }
  if (state.running) return state.running;
  const registryRevision = registry.accountCreditGuardRevision();
  const obligationRevision = accountGuardObligationRevision(directory);
  const hostToken = Array.isArray(hosts) && hosts.length === 0 ? null : hosts;
  const now = options.now ?? performance.now();
  if (options.onlyIfChanged && !state.cursor && state.registryRevision === registryRevision && state.obligationRevision === obligationRevision
    && state.hosts === hostToken && now < state.fallbackAt) return Promise.resolve();
  const current = state;
  const work = withViewerOperation("controller.account-credit-guard", () =>
    runAccountCreditGuard(registry, typeof hosts === "function" ? hosts() : hosts, stop, operatorStopped, resumeCurrent));
  current.running = work.then(() => {
    // Remember the revision that was actually inspected. Changes during any
    // await stay dirty, including a cut or receipt this pass wrote itself.
    current.registryRevision = registryRevision;
    current.obligationRevision = obligationRevision;
    current.hosts = hostToken;
    current.fallbackAt = now + ACCOUNT_GUARD_FALLBACK_MS;
  }).catch(error => {
    // Even a fallback pass can fail at an unchanged revision. Keep it dirty
    // until its retained page has been reconciled and acknowledged.
    current.cursor = "pending";
    throw error;
  }).finally(() => { current.running = undefined; });
  return current.running;
}
