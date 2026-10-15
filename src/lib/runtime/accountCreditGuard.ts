import { accountManager } from "@/lib/accounts/manager";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { creditGuardBlock } from "@/lib/accounts/creditGuard";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import type { AgentRegistry } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { findPipelineRecord, loadPipelinesForRetirement } from "@/lib/pipelines/store";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { openRuntimeSwitch } from "@/lib/pipelines/runtimeSwitch";
import { activeOrchestratorSeats } from "@/lib/orchestrator/seats";
import { StructuredSendRefusedError, type EngineHost } from "./engineHost";
import { delegatusMessageOrigin } from "./agentMessageAuthor";
import { interruptionObligationDirectory, interruptionObligationStore, submittedContinuationOutcome, STAGE_CUT_RESOLUTION, REVIEWER_CUT_RESOLUTION } from "./interruptionObligations";

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

/** Stop every locally owned credited turn at the cutoff. The durable cut is
 * written before releasing its host. Ordinary stages retain their controller's
 * retry policy; other conversations keep one continuation behind the existing
 * conversation-scoped migration and delivery receipts. */
export async function enforceAccountCreditGuard(registry: AgentRegistry,
  hosts: readonly { key: SessionKey; host: EngineHost }[],
  stop: (key: SessionKey, host: EngineHost) => Promise<boolean>,
  operatorStopped: (conversationId: string, since: string) => Promise<boolean>): Promise<void> {
  const store = interruptionObligationStore(interruptionObligationDirectory(registry.filename));
  const blockedAccounts = new Set(registry.quotaObservations("codex")
    .filter(row => creditGuardBlock("codex", row.limits)).map(row => row.accountId));
  const stops = await Promise.allSettled(hosts.map(async item => {
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
    if (!store.list().some(cut => cut.reason === "account-guard" && cut.state === "owed" && cut.conversationId === conversation.id)) store.record({ conversationId: conversation.id, engine: "codex", hostKey: sessionKeyId(item.key), path: generation.path,
      owner: health?.pid ? { pid: health.pid, startIdentity: health.processStartIdentity } : entry.structuredHost?.process ?? null,
      claimEpoch: entry.claimEpoch, turnRef, boundary: "paid-credit-guard", reason: "account-guard",
      checkpoint: { lastEventKind: null, lastEventAt: Date.now() }, seat: seat ? { project: seat.project, seatEpoch: seat.seatEpoch } : null,
      ...(owner?.stage?.kind === "run" ? { answeredBy: STAGE_CUT_RESOLUTION } : reviewer ? { answeredBy: REVIEWER_CUT_RESOLUTION } : {}) });
    if (!await stop(item.key, item.host)) throw new Error("paid-credit guard could not confirm host termination");
  }));
  const failures = stops.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "paid-credit guard termination remains pending");
  for (const obligation of store.list()) {
    if (obligation.reason !== "account-guard") continue;
    if (obligation.state === "submitted") {
      const outcome = submittedContinuationOutcome(obligation, registry.readOnlySnapshot(), id => registry.canonicalConversationId(id));
      if (outcome) store.update(obligation.id, { state: outcome.state, resolvedAt: outcome.at ?? new Date().toISOString(), resolution: outcome.resolution });
    }
    if (obligation.state !== "owed") continue;
    const conversation = registry.conversation(obligation.conversationId);
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation || conversation.supersededBy) continue;
    if (obligation.seat && !activeOrchestratorSeats().some(seat => seat.project === obligation.seat!.project
      && seat.seatEpoch === obligation.seat!.seatEpoch && seat.conversationId?.startsWith("conversation_")
      && registry.canonicalConversationId(seat.conversationId as ViewerConversationId) === conversation.id)) {
      store.update(obligation.id, { state: "discharged", resolvedAt: new Date().toISOString(), resolution: "the orchestrator seat was rotated" });
      continue;
    }
    const moved = sessionKeyId({ engine: conversation.engine, sessionId: generation.id }) !== obligation.hostKey;
    const source = conversation.generations.find(item => sessionKeyId({ engine: conversation.engine, sessionId: item.id }) === obligation.hostKey);
    if (moved && (!conversation.migration?.creditGuard || conversation.migration.sourceGenerationId !== source?.id)) {
      store.update(obligation.id, { state: "discharged", resolvedAt: new Date().toISOString(), resolution: "another runtime selection moved the conversation" });
      continue;
    }
    const deliveries = registry.conversationDeliverySnapshot({ conversationId: conversation.id });
    if (Object.values(deliveries.heldDeliveries).some(delivery => delivery.clientMessageId !== obligation.id
      && delivery.state !== "failed" && Date.parse(delivery.createdAt) > Date.parse(obligation.recordedAt))) {
      store.update(obligation.id, { state: "discharged", resolvedAt: new Date().toISOString(), resolution: "a newer message continued the conversation" });
      continue;
    }
    const owner = pipelineOwner(conversation.id, registry);
    const eligible = () => {
      const current = pipelineOwner(conversation.id, registry);
      return !current || current.pipeline.state === "running" && !current.pipeline.closedAt
        && !current.attempt.suspension && !openRuntimeSwitch(current.attempt);
    };
    if (!eligible() || conversation.reconfigure?.status === "applying") continue;
    if (await operatorStopped(conversation.id, obligation.recordedAt)) {
      store.update(obligation.id, { state: "discharged", resolvedAt: new Date().toISOString(), resolution: "operator stopped the conversation after the guard" });
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
    const selection = recoveredSource?.kind === "available" ? recoveredSource
      : resolve("codex", { project, model: generation.launchProfile.model, requireCapacity: true,
        ...(moved ? { requestedId: generation.accountId } : { unavailableIds: generation.accountId ? [generation.accountId] : [] }) });
    if (selection.kind !== "available" || !selection.account.accountId) continue;
    const target = selection.account.accountId;
    const authorizeTarget = () => {
      if (!eligible()) throw new Error("paid-credit recovery lost pipeline custody");
      const selected = resolve("codex", { project, model: generation.launchProfile.model, requestedId: target, requireCapacity: true });
      if (selected.kind !== "available" || selected.account.accountId !== target) throw new Error("paid-credit recovery target is no longer admissible");
    };
    authorizeTarget();
    if (!moved && target !== generation.accountId) {
      registry.requestConversationReseat(conversation.id, target, undefined, undefined, true);
      requestAccountMigrationTick();
      continue;
    }
    const current = registry.conversation(conversation.id);
    if (current?.generations.at(-1)?.accountId !== target || moved && current.migration?.phase !== "committed") continue;
    authorizeTarget();
    const held = registry.holdDelivery(conversation.id,
      "The paid-credit guard stopped your previous turn. Continue the same work from the preserved transcript and checkout; verify interrupted operations before repeating them.",
      obligation.id, "text", [], null, { operationId: obligation.id, kind: "send", policy: "queue", turnId: null,
        origin: delegatusMessageOrigin("runtime-host", project, generation.launchProfile.cwd) });
    store.update(obligation.id, { state: "submitted", operationId: held.command.operationId, attempts: obligation.attempts + 1 });
    requestAccountMigrationTick();
  }
}
