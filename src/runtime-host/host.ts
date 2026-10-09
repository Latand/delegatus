import { canonicalNativeQueueProof, type NativeQueueCompactedProof, type NativeQueueTransition } from "@/lib/runtime/nativeQueueContracts";
import { isStructuredHostKind, parseRuntimeScope, RUNTIME_RECEIPT_STATUSES, RuntimeIdempotencyConflictError, type RuntimeEvent, type RuntimeEventInput, type RuntimeOperationCommand, type RuntimeOperationReceipt, type RuntimeReceiptStatus, type RuntimeSocketRequest, type RuntimeSocketResponse, type RuntimeTransitionDetails } from "@/lib/runtime/contracts";
import { structuredHostsEnabled } from "@/lib/runtime/flags";
import { consumeRuntimeEvent, RuntimeConsumerDeferredError, type RuntimeConsumerPorts } from "@/lib/runtime/consumers";

import { RuntimeJournal } from "./journal";
import type { ViewerDeploymentCoordinator } from "./deployment";
import type { McpHealthProbeAdmissions } from "./mcpHealthProbeAdmission";
import { PreserializedJson } from "./preserializedJson";
import type { RuntimeHostReadyEvidence } from "./runtimeHostStartup";

export { RuntimeHostFence } from "./runtimeHostFence";

// These engine publications have no orchestration effect in consumeRuntimeEvent.
// Keep this allowlist explicit: new kinds and terminal events retain the barrier.
const DURABLE_ENGINE_PUBLICATIONS = new Set([
  "turn-started", "delta", "item", "attention", "attention-resolved", "limits",
  "voice-transcript", "voice-chunk", "native-queue-changed",
  "voice-delivery-progress", "voice-delivery-acknowledged",
]);

/** When the operation that ran this turn was admitted, for a completion
    notice's run time (spawn-completion-notice §2). Consumer-only: the stored
    event is unchanged. */
function turnStartedAt(receipts: readonly RuntimeOperationReceipt[] | undefined, turnId: unknown): string | null {
  if (typeof turnId !== "string" || !turnId) return null;
  const receipt = receipts?.find((candidate) => candidate.turnId === turnId);
  return receipt ? receipt.admittedAt ?? receipt.at : null;
}

export class RuntimeHost {
  private consumerQueue: Promise<void> = Promise.resolve();
  private readonly consumerFailures = new Map<string, number>();
  /** Events a consumer deferred (a fenced or busy state write), and the one
      timer that retries them. */
  private readonly deferredEvents = new Set<string>();
  private deferredRetry: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly journal: RuntimeJournal,
    private readonly consumers?: RuntimeConsumerPorts,
    private readonly deployments?: ViewerDeploymentCoordinator,
    private readonly structuredHosts = structuredHostsEnabled(),
    private readonly signalFlowPipelineProgress?: () => void,
    private readonly mcpHealthProbeAdmissions?: McpHealthProbeAdmissions,
    private readonly runtimeHostHealth?: () => RuntimeHostReadyEvidence,
    private readonly deferredRetryMs = 5_000,
  ) {
    if (consumers && journal.isWritable()) journal.registerConsumer("orchestration");
  }

  async recoverConsumers(): Promise<number> {
    if (!this.consumers) return 0;
    return this.runConsumerExclusive(async () => {
      let recovered = 0;
      while (true) {
        const events = this.journal.unconsumedEvents("orchestration");
        if (events.length === 0) return recovered;
        for (const event of events) {
          try {
            await this.consume(event);
          } catch (error) {
            /* A deferred event stays owed and its retry is scheduled; the
               events after it wait behind it, as they would behind a failure. */
            if (error instanceof RuntimeConsumerDeferredError) return recovered;
            throw error;
          }
          recovered += 1;
        }
      }
    });
  }

  private runConsumerExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.consumerQueue.then(work);
    this.consumerQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private consumeExclusive(event: RuntimeEvent): Promise<void> {
    if (!this.consumers) return Promise.resolve();
    return this.runConsumerExclusive(() => this.consume(event));
  }

  private async consume(event: RuntimeEvent): Promise<void> {
    if (!this.consumers || this.journal.consumerCompleted(event.eventId, "orchestration", event.seq)) return;
    const session = event.scope.type === "session" ? this.journal.sessionState(event.scope.id) : null;
    const startedAt = event.kind === "turn-ended" ? turnStartedAt(session?.recentReceipts, event.payload.turnId) : null;
    const consumerEvent = event.kind === "turn-ended" && session
      ? { ...event, payload: {
          ...event.payload,
          ...(session.flowId && typeof event.payload.flowId !== "string" ? { flowId: session.flowId } : {}),
          ...(startedAt ? { turnStartedAt: startedAt } : {}),
        } }
      : event;
    try {
      for (const projection of await consumeRuntimeEvent(consumerEvent, this.consumers)) {
        await this.consume(this.journal.append(projection));
      }
      this.consumerFailures.delete(event.eventId);
      this.deferredEvents.delete(event.eventId);
      this.journal.markConsumerCompleted(event.eventId, "orchestration");
    } catch (error) {
      if (error instanceof RuntimeConsumerDeferredError) {
        if (!this.deferredEvents.has(event.eventId)) {
          this.deferredEvents.add(event.eventId);
          console.error(`[runtime consumer] deferred event ${event.eventId} until its write is admitted: ${error.message}`);
        }
        this.scheduleDeferredRetry();
        throw error;
      }
      const failures = (this.consumerFailures.get(event.eventId) ?? 0) + 1;
      this.consumerFailures.set(event.eventId, failures);
      if (failures >= 3) {
        console.error(`[runtime consumer] quarantined event ${event.eventId} after ${failures} failures`);
        this.journal.markConsumerCompleted(event.eventId, "orchestration");
        this.consumerFailures.delete(event.eventId);
        this.deferredEvents.delete(event.eventId);
      }
      throw error;
    }
  }

  /** One pending retry at a time; it replays every owed event in order, so
      a deferred event lands as soon as the fence that refused it lifts. */
  private scheduleDeferredRetry(): void {
    if (this.deferredRetry) return;
    this.deferredRetry = setTimeout(() => {
      this.deferredRetry = null;
      if (this.journal.isWritable()) void this.recoverConsumersBestEffort();
    }, this.deferredRetryMs);
    this.deferredRetry.unref?.();
  }

  private async recoverConsumersBestEffort(): Promise<void> {
    try { await this.recoverConsumers(); }
    catch { console.error("[runtime consumer] recovery deferred after a consumer failure"); }
  }

  async handle(request: RuntimeSocketRequest, options: { signal?: AbortSignal } = {}): Promise<RuntimeSocketResponse> {
    try {
      let result: unknown;
      if (request.method === "runtime-host-health") {
        if (!this.runtimeHostHealth) throw new Error("runtime-host startup evidence is unavailable");
        result = this.runtimeHostHealth();
      } else if (request.method === "snapshot") result = new PreserializedJson(this.journal.snapshotJson(Array.isArray(request.params?.voiceBodiesFor)
        ? request.params.voiceBodiesFor.filter((id): id is string => typeof id === "string").slice(0, 1)
        : undefined));
      else if (request.method === "session-read") result = this.journal.readSession({
        conversationId: request.params?.conversationId as string | undefined,
        artifactPath: request.params?.artifactPath as string | undefined,
      });
      else if (request.method === "events") result = this.journal.replay(Number(request.params?.after ?? 0));
      else if (request.method === "wait") result = await this.journal.waitForEvents(
        Number(request.params?.after ?? 0),
        Number(request.params?.timeoutMs ?? 15_000),
        options.signal,
      );
      else if (request.method === "append" || request.method === "append-session-fenced" || request.method === "operation") {
        const event = request.params?.event as RuntimeEventInput;
        if (request.method === "append-session-fenced" && (!event?.scope || parseRuntimeScope(event.scope).type !== "session"
          || event.kind !== "session-status" || !Number.isSafeInteger(event.expectedSessionRevision)
          || event.expectedSessionRevision! < 0)) {
          throw new Error("a fenced session append requires a session-status event and its observed revision");
        }
        const publishedBefore = this.journal.publishedSeq();
        const appended = this.journal.append(event);
        const newlyPublished = appended.seq > publishedBefore;
        if (newlyPublished && appended.kind === "turn-ended") {
          try { this.signalFlowPipelineProgress?.(); }
          catch { console.error("[flow pipeline controller] committed terminal wake failed"); }
        }
        // Enqueue before answering, on the same FIFO as terminal/operation work.
        // The journal's durable checkpoints still own completion and replay.
        const consumption = this.consumeExclusive(appended).catch(() => {
          console.error("[runtime consumer] committed event will retry asynchronously");
        });
        const durableEnginePublication = request.method === "append"
          && event.effect === undefined && event.operationId === undefined
          && appended.scope.type === "session"
          && isStructuredHostKind(appended.producer.kind)
          && appended.producer.eventKey?.startsWith("engine-host:") === true
          && DURABLE_ENGINE_PUBLICATIONS.has(appended.kind);
        if (!durableEnginePublication) await consumption;
        result = request.method === "operation" && event.operationId
          ? { operationId: event.operationId, state: "accepted", seq: appended.seq, revision: appended.revision }
          : appended;
      } else if (request.method === "command" || request.method === "guarded-command") {
        const command = request.params?.command as RuntimeOperationCommand;
        if (request.method === "guarded-command" && !(command?.kind === "send" && command.onlyIfIdle
          || command?.kind === "kill" && command.onlyIfIdle && command.providerRecovery)) {
          throw new Error("guarded runtime command requires a recovery fence");
        }
        result = this.journal.executeOperation(command);
        setImmediate(() => { void this.recoverConsumersBestEffort(); });
      } else if (request.method === "operation-status") {
        const currentRetryLeaf = request.params?.currentRetryLeaf;
        if (currentRetryLeaf !== undefined && typeof currentRetryLeaf !== "boolean") {
          throw new Error("operation retry leaf option is invalid");
        }
        result = currentRetryLeaf
          ? this.journal.currentRetryResult(String(request.params?.operationId ?? ""))
          : this.journal.operationResult(String(request.params?.operationId ?? ""));
      } else if (request.method === "operation-delivery-action") {
        const action = request.params?.action;
        if (action !== "discard" && action !== "retry") {
          throw new Error("runtime delivery action is invalid");
        }
        result = this.journal.claimDeliveryAction(
          String(request.params?.operationId ?? ""),
          action,
        );
      } else if (request.method === "operation-retry") {
        if (!this.structuredHosts) throw new Error("structured hosts are disabled");
        const nextIdempotencyKey = request.params?.nextIdempotencyKey;
        if (nextIdempotencyKey !== undefined && typeof nextIdempotencyKey !== "string") {
          throw new Error("retry idempotency key is invalid");
        }
        const requireHostedConversationId = request.params?.requireHostedConversationId;
        if (requireHostedConversationId !== undefined
          && (typeof requireHostedConversationId !== "string" || !requireHostedConversationId.trim())) {
          throw new Error("retry hosted conversation is invalid");
        }
        result = this.journal.retryOperation(
          String(request.params?.operationId ?? ""),
          nextIdempotencyKey,
          typeof requireHostedConversationId === "string" ? { requireHostedConversationId } : {},
        );
      } else if (request.method === "effect-batch") {
        if (!this.structuredHosts) throw new Error("structured hosts are disabled");
        const kinds = request.params?.kinds;
        if (kinds !== undefined && (!Array.isArray(kinds) || kinds.some((kind) => typeof kind !== "string"))) {
          throw new Error("runtime effect kinds are invalid");
        }
        const afterEventSeq = request.params?.afterEventSeq ?? 0;
        if (typeof afterEventSeq !== "number" || !Number.isSafeInteger(afterEventSeq) || afterEventSeq < 0) {
          throw new Error("runtime effect cursor is invalid");
        }
        result = this.journal.effectBatch(100, kinds as string[] | undefined, afterEventSeq);
      } else if (request.method === "producer-cursor") {
        const producerKind = request.params?.producerKind;
        const eventKeyPrefix = request.params?.eventKeyPrefix;
        if (typeof producerKind !== "string" || !producerKind || producerKind.length > 128
          || typeof eventKeyPrefix !== "string" || !eventKeyPrefix || eventKeyPrefix.length > 512) {
          throw new Error("runtime producer cursor is invalid");
        }
        result = this.journal.producerCursor(producerKind, eventKeyPrefix);
      } else if (request.method === "native-queue-read") {
        if (typeof request.params?.conversationId !== "string") throw new Error("conversationId is invalid");
        result = this.journal.nativeQueueRead(request.params.conversationId);
      } else if (request.method === "native-queue-transition") {
        if (!this.structuredHosts) throw new Error("structured hosts are disabled");
        const transition = request.params?.transition as NativeQueueTransition | undefined;
        if (!transition || !["prepared", "acknowledged", "observed-queued", "withdrawn", "removed", "refused", "uncertain", "proven"].includes(transition.phase)) throw new Error("native queue transition is invalid");
        result = this.journal.nativeQueueTransition(String(request.params?.operationId ?? ""), transition);
      } else if (request.method === "native-queue-settle-compacted") {
        if (!this.structuredHosts) throw new Error("structured hosts are disabled");
        const params = request.params as Partial<NativeQueueCompactedProof> | undefined;
        const binding = params?.binding;
        const proof = canonicalNativeQueueProof(params?.proof);
        if (typeof params?.conversationId !== "string" || typeof params.entryId !== "string"
          || !binding || typeof binding !== "object" || typeof binding.threadId !== "string" || (binding.accountId !== null && typeof binding.accountId !== "string")
          || !proof) throw new Error("native queue compacted proof is invalid");
        result = this.journal.nativeQueueSettleCompacted({ conversationId: params.conversationId, entryId: params.entryId,
          binding: { threadId: binding.threadId, accountId: binding.accountId }, proof });
      } else if (request.method === "operation-transition") {
        if (!this.structuredHosts) throw new Error("structured hosts are disabled");
        const status = request.params?.status;
        if (status !== "queued"
          && status !== "delivering"
          && status !== "applying"
          && status !== "delivered"
          && status !== "applied"
          && status !== "interrupted"
          && status !== "answered"
          && status !== "failed"
          /* #862: a compaction whose evidence never arrived is terminal and
             unverified, which is a different fact from a failed control. */
          && status !== "uncertain") {
          throw new Error("runtime operation transition status is invalid");
        }
        const details = request.params?.details;
        const fromStatuses = request.params?.fromStatuses;
        const retirementClaim = request.params?.retirementClaim as import("@/lib/runtime/contracts").RuntimeRetirementClaim | undefined;
        if (retirementClaim !== undefined && (!retirementClaim || typeof retirementClaim.executorId !== "string"
          || !retirementClaim.executorId || !retirementClaim.process
          || !Number.isSafeInteger(retirementClaim.process.pid) || retirementClaim.process.pid <= 0
          || typeof retirementClaim.process.startIdentity !== "string" || !retirementClaim.process.startIdentity
          || typeof retirementClaim.process.bootEpoch !== "string" || !retirementClaim.process.bootEpoch)) {
          throw new Error("runtime retirement claim is invalid");
        }
        const awaitProjection = request.params?.awaitProjection;
        if (awaitProjection !== undefined && typeof awaitProjection !== "boolean") {
          throw new Error("runtime operation projection retention flag is invalid");
        }
        if (fromStatuses !== undefined && (!Array.isArray(fromStatuses)
          || fromStatuses.some((candidate) => typeof candidate !== "string"
            || !RUNTIME_RECEIPT_STATUSES.includes(candidate as RuntimeReceiptStatus)))) {
          throw new Error("runtime operation transition fence is invalid");
        }
        result = this.journal.transitionOperation(
          String(request.params?.operationId ?? ""),
          status as Exclude<RuntimeReceiptStatus, "pending">,
          details && typeof details === "object" ? details as RuntimeTransitionDetails : {},
          {
            ...(fromStatuses ? { fromStatuses: fromStatuses as RuntimeReceiptStatus[] } : {}),
            ...(retirementClaim ? { retirementClaim } : {}),
            ...(awaitProjection === true ? { awaitProjection: true } : {}),
          },
        );
      } else if (request.method === "operation-projection-ack") {
        if (!this.structuredHosts) throw new Error("structured hosts are disabled");
        const operationIds = request.params?.operationIds;
        if (!Array.isArray(operationIds) || operationIds.some((operationId) => typeof operationId !== "string" || !operationId)) {
          throw new Error("runtime projection acknowledgement ids are invalid");
        }
        result = this.journal.acknowledgeTerminalProjection(operationIds as string[]);
      } else if (request.method === "viewer-deployment-request") {
        if (!this.deployments) throw new Error("viewer deployments are disabled");
        result = await this.deployments.requestViewerDeployment({
          revision: typeof request.params?.revision === "string" ? request.params.revision : undefined,
          ref: typeof request.params?.ref === "string" ? request.params.ref : undefined,
          idempotencyKey: String(request.params?.idempotencyKey ?? ""),
        });
      } else if (request.method === "viewer-deployment-cancel") {
        if (!this.deployments) throw new Error("viewer deployments are disabled");
        result = this.deployments.cancelViewerDeployment(String(request.params?.deploymentId ?? ""));
      } else if (request.method === "viewer-deployment-list") {
        const { limit, cursor, compact } = request.params ?? {};
        if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit))) throw new Error("deployment list limit is invalid");
        if (cursor !== undefined && typeof cursor !== "string") throw new Error("deployment list cursor is invalid");
        if (compact !== undefined && typeof compact !== "boolean") throw new Error("deployment list compact option is invalid");
        result = this.journal.listViewerDeployments({ limit, cursor, compact });
      } else if (request.method === "viewer-deployment-find") {
        if (!this.deployments) throw new Error("viewer deployments are disabled");
        const idempotencyKey = request.params?.idempotencyKey;
        if (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 200 || /[\r\n]/.test(idempotencyKey)) {
          throw new Error("deployment idempotencyKey is invalid");
        }
        result = await this.deployments.findViewerDeploymentByIdempotencyKey(idempotencyKey);
      } else if (request.method === "viewer-deployment-read") {
        if (!this.deployments) throw new Error("viewer deployments are disabled");
        result = this.deployments.readViewerDeployment(String(request.params?.deploymentId ?? ""));
      } else if (request.method === "mcp-health-probe-admission") {
        result = this.mcpHealthProbeAdmissions?.consume(request.params?.capability) ?? false;
      } else throw new Error("runtime request method is unsupported");
      return { id: request.id, ok: true, result };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : "runtime request failed",
        ...(error instanceof RuntimeIdempotencyConflictError ? { code: error.code } : {}),
      };
    }
  }
}
