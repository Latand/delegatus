import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import { accountManager } from "@/lib/accounts/manager";
import { advanceConversationMigration } from "@/lib/accounts/migration/coordinator";
import { RegisteredSuccessorProvider } from "@/lib/accounts/migration/provider";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { agentRegistry, REGISTRY_WRITER_BUSY, type AgentRegistry, type RegistryConversation } from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";

import type { StructuredReconfigureEffect } from "./structuredDeliveryQueue";
import { recoverDeadStructuredConversation } from "./structuredRecovery";

export type StructuredReconfigureOutcome = "applied" | "pending";

class StructuredReconfigureSupersededError extends Error {
  constructor() {
    super("superseded");
    this.name = "StructuredReconfigureSupersededError";
  }
}

/** The operation was withdrawn before its claim, or the switch it owned was cancelled (#1705): it never applies. */
export class StructuredReconfigureCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "StructuredReconfigureCancelledError";
  }
}

const settledElsewhere = (error: unknown) => error instanceof StructuredReconfigureSupersededError || error instanceof StructuredReconfigureCancelledError;
/** A registry write the lock refused: nothing was settled, and the queue keeps
    the switch listed (docs/design/delivery-progress-and-drain.md, C3). */
const registryBusy = (error: unknown) => error instanceof Error && error.message === REGISTRY_WRITER_BUSY;
const SETTLE_WRITE_ATTEMPTS = 6;

async function releaseStructuredHost(key: SessionKey): Promise<boolean> {
  const { releaseStructuredDeliveryHost } = await import("./structuredDeliveryController");
  return await releaseStructuredDeliveryHost(key);
}

export interface StructuredReconfigureDependencies {
  registry?: AgentRegistry;
  validateAccount?: (engine: "claude" | "codex", accountId: string) => Promise<void>;
  resolveAccount?: typeof accountManager.resolveSpawn;
  releaseHost?: (key: SessionKey) => Promise<boolean>;
  recover?: typeof recoverDeadStructuredConversation;
  ownsOperation?: () => Promise<boolean>;
  migrate?: (
    conversationId: ViewerConversationId,
    targetAccountId: string,
    registry: AgentRegistry,
    ownsOperation: () => Promise<boolean>,
    reconfigureOperationId?: string,
  ) => Promise<RegistryConversation>;
}

async function validateAccountAuthentication(engine: "claude" | "codex", accountId: string): Promise<void> {
  const account = await accountManager.status(engine, accountId, true);
  if (account.auth.state !== "authenticated") throw new Error(`${engine} account requires authentication`);
}

async function migrateConversation(
  conversationId: ViewerConversationId,
  targetAccountId: string,
  registry: AgentRegistry,
  ownsOperation: () => Promise<boolean>,
  reconfigureOperationId?: string,
): Promise<RegistryConversation> {
  /* The established provider keeps one Viewer conversation identity while it
     creates an account-owned resume artifact. Codex forks the rollout under
     the target sessions root; Claude resumes the same native session id under
     the target config root. Registry continuity paths keep scanner output on
     the existing card, lineage edge, and task assignments. */
  return await advanceConversationMigration(
    conversationId,
    registry,
    new RegisteredSuccessorProvider(),
    { ownsOperation, reconfigureOperationId },
  );
}

function profilePatch(effect: StructuredReconfigureEffect) {
  return { model: effect.model, effort: effect.effort, fast: effect.fast };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function applyStructuredReconfigure(
  effect: StructuredReconfigureEffect,
  dependencies: StructuredReconfigureDependencies = {},
): Promise<StructuredReconfigureOutcome> {
  const registry = dependencies.registry ?? agentRegistry();
  const conversationId = effect.conversationId as ViewerConversationId;
  const conversation = registry.conversation(conversationId);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) throw new Error("viewer conversation is unknown");
  const engine = conversation.engine;
  const key = { engine, sessionId: generation.id } as const;
  const targetAccountId = effect.accountId ?? generation.accountId;
  const switchingAccount = Boolean(effect.accountId && effect.accountId !== generation.accountId);
  if (engine === "copilot" && switchingAccount) {
    throw new Error("a Copilot session stays in its account's COPILOT_HOME; account changes require a new conversation");
  }
  const ownsOperation = dependencies.ownsOperation ?? (async () => true);
  const release = dependencies.releaseHost ?? releaseStructuredHost;
  const recover = dependencies.recover ?? recoverDeadStructuredConversation;
  const inheritedApplyingOperation = conversation.reconfigure?.status === "applying";

  if (!await ownsOperation()) throw new StructuredReconfigureSupersededError();
  /* Off the loop (docs/design/delivery-progress-and-drain.md, C3): it binds
     the conversation's kept deliveries. Refused, nothing changed, and the
     queue keeps the switch listed for its next pass. */
  const claimed = await registry.deliveryWrite({ label: "delivery.reconfigure", operationId: effect.operationId },
    () => registry.claimConversationReconfigure(conversationId, {
      operationId: effect.operationId,
      revision: effect.eventSeq,
      profile: profilePatch(effect),
      ...(effect.previousProfile ? { previousProfile: effect.previousProfile } : {}),
      ...(effect.accountId ? { accountId: effect.accountId } : {}),
    }));
  if (!claimed.acquired) throw new Error(REGISTRY_WRITER_BUSY);
  const claim = claimed.value;
  if (claim.kind === "withdrawn") throw new StructuredReconfigureCancelledError();
  if (claim.kind === "stale") throw new StructuredReconfigureSupersededError();
  if (claim.state.status === "cancelled") throw new StructuredReconfigureCancelledError();
  if (claim.state.status === "applied") return "applied";
  if (claim.state.status === "failed") throw new Error(claim.state.error ?? "structured reconfigure failed");

  const settle = async (status: "applied" | "failed", error: unknown = null): Promise<void> => {
    if (!await ownsOperation()) throw new StructuredReconfigureSupersededError();
    /* The switch itself has already happened or failed by now, so a settle
       the lock refused is asked for again before it is given up; given up,
       nothing is settled either way and the queue keeps the switch listed. */
    let written: { acquired: true; value: ReturnType<AgentRegistry["settleConversationReconfigure"]> } | { acquired: false } = { acquired: false };
    for (let attempt = 0; attempt < SETTLE_WRITE_ATTEMPTS && !written.acquired; attempt += 1) {
      written = await registry.deliveryWrite({ label: "delivery.reconfigure", operationId: effect.operationId },
        () => registry.settleConversationReconfigure(
          conversationId,
          effect.operationId,
          effect.eventSeq,
          status,
          status === "failed" ? failureMessage(error) : null,
        ));
    }
    if (!written.acquired) throw new Error(REGISTRY_WRITER_BUSY);
    const settled = written.value;
    if (settled.kind === "stale") throw new StructuredReconfigureSupersededError();
  };

  const ownsDurableReconfigure = async (status: "applying" | "failed"): Promise<boolean> => {
    if (!await ownsOperation()) return false;
    const owner = registry.conversation(conversationId)?.reconfigure;
    return owner?.operationId === effect.operationId
      && owner.revision === effect.eventSeq
      && owner.status === status;
  };

  const recoveryOwnership = (status: "applying" | "failed") => ({
    operationId: effect.operationId,
    revision: effect.eventSeq,
    owns: () => ownsDurableReconfigure(status),
    releaseHost: release,
  });

  if (switchingAccount) {
    try {
      await (dependencies.validateAccount ?? validateAccountAuthentication)(engine as "claude" | "codex", targetAccountId!);
      (dependencies.resolveAccount ?? accountManager.resolveSpawn)(engine, targetAccountId);
    } catch (error) {
      await settle("failed", error);
      if (inheritedApplyingOperation) {
        const restored = await recover({ path: generation.path, conversationId }, {
          registry,
          ownership: recoveryOwnership("failed"),
        });
        if (!restored) throw new Error("structured conversation preflight rollback recovery is unavailable");
      }
      throw error;
    }
  }

  const restoreCommittedSuccessor = async (successorId: string): Promise<void> => {
    if (!await ownsDurableReconfigure("failed")) throw new StructuredReconfigureSupersededError();
    const latest = registry.conversation(conversationId);
    const successor = latest?.generations.at(-1);
    if (!latest || latest.migration?.phase !== "committed" || successor?.id !== successorId) {
      throw new Error("committed structured successor is unavailable for profile restoration");
    }
    const successorKey = { engine: latest.engine, sessionId: successor.id } as const;
    await release(successorKey);
    if (!await ownsDurableReconfigure("failed")) throw new StructuredReconfigureSupersededError();
    registry.terminateStructuredHost(successorKey);
    if (!await ownsDurableReconfigure("failed")) throw new StructuredReconfigureSupersededError();
    const restored = await recover({ path: successor.path, conversationId }, {
      registry,
      ownership: recoveryOwnership("failed"),
    });
    if (!restored) throw new Error("structured successor profile restoration is unavailable");
    if (!await ownsDurableReconfigure("failed")) throw new StructuredReconfigureSupersededError();
  };

  if (effect.accountId
    && effect.accountId === generation.accountId
    && conversation.migration?.phase === "committed") {
    try {
      const predecessor = conversation.generations.at(-2);
      if (predecessor) {
        const predecessorKey = { engine: conversation.engine, sessionId: predecessor.id } as const;
        await release(predecessorKey);
        registry.terminateStructuredHost(predecessorKey);
      }
      if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
      await release(key);
      if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
      registry.terminateStructuredHost(key);
      if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
      const recovered = await recover({ path: generation.path, conversationId }, {
        registry,
        ownership: recoveryOwnership("applying"),
      });
      if (!recovered) throw new Error("structured successor profile application is unavailable");
      if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
      await settle("applied");
      return "applied";
    } catch (error) {
      if (settledElsewhere(error) || registryBusy(error)) throw error;
      await settle("failed", error);
      await restoreCommittedSuccessor(generation.id);
      throw error;
    }
  }

  /* The owner this executor claimed was cancelled while it ran: nothing more is requested or applied. */
  const ownerCancelled = () => {
    const owner = registry.conversation(conversationId)?.reconfigure;
    return owner?.operationId === effect.operationId && owner.revision === effect.eventSeq && owner.status === "cancelled";
  };

  if (switchingAccount) {
    try {
      registry.requestConversationReseat(conversationId, targetAccountId!, {
        operationId: effect.operationId,
        revision: effect.eventSeq,
      });
    } catch (error) {
      if (ownerCancelled()) throw new StructuredReconfigureCancelledError();
      throw error;
    }
    const committedSuccessorAfterCapturedPredecessor = (): RegistryConversation["generations"][number] | null => {
      const latest = registry.conversation(conversationId);
      if (!latest) return null;
      const predecessorIndex = latest.generations.findIndex((candidate) =>
        candidate.id === generation.id && candidate.path === generation.path);
      const predecessor = latest.generations[predecessorIndex];
      const successor = latest.generations[predecessorIndex + 1];
      const current = latest.generations.at(-1);
      if (predecessorIndex < 0
        || !predecessor
        || predecessor.archivedAt === null
        || !successor
        || successor.accountId !== targetAccountId
        || !current
        || (current.id === predecessor.id && current.path === predecessor.path)) return null;
      return successor;
    };
    const cleanupCommittedPredecessorAfterSupersedence = async (): Promise<void> => {
      const successor = committedSuccessorAfterCapturedPredecessor();
      if (!successor) return;
      await release(key);
      const confirmed = committedSuccessorAfterCapturedPredecessor();
      if (!confirmed || confirmed.id !== successor.id || confirmed.path !== successor.path) return;
      registry.terminateStructuredHost(key);
    };
    let committedSuccessorId: string | null = null;
    try {
      const migrated: RegistryConversation = await (dependencies.migrate ?? migrateConversation)(
        conversationId,
        targetAccountId!,
        registry,
        ownsOperation,
        effect.operationId,
      );
      const owner = registry.conversation(conversationId)?.reconfigure;
      if (ownerCancelled()) throw new StructuredReconfigureCancelledError();
      if (!await ownsOperation()
        || owner?.operationId !== effect.operationId || owner.revision !== effect.eventSeq) {
        await cleanupCommittedPredecessorAfterSupersedence();
        throw new StructuredReconfigureSupersededError();
      }
      const current = migrated.generations.at(-1);
      if (migrated.migration?.phase === "failed-recoverable") {
        throw new Error(migrated.migration.error ?? "account switch failed");
      }
      if (current?.accountId !== targetAccountId || migrated.migration?.phase !== "committed") {
        return "pending";
      }
      committedSuccessorId = current.id;
      await release(key);
      registry.terminateStructuredHost(key);
      await settle("applied");
      return "applied";
    } catch (error) {
      if (settledElsewhere(error) || registryBusy(error)) throw error;
      await settle("failed", error);
      if (committedSuccessorId) await restoreCommittedSuccessor(committedSuccessorId);
      throw error;
    } finally {
      // Admission may have ticked while this executor still owned the switch.
      // Wake again after commit so its assigned messages dispatch immediately.
      if (committedSuccessorId) requestAccountMigrationTick();
    }
  }

  try {
    if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
    await release(key);
    if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
    registry.terminateStructuredHost(key);
    if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
    const recovered = await recover({ path: generation.path, conversationId }, {
      registry,
      ownership: recoveryOwnership("applying"),
    });
    if (!recovered) throw new Error("structured conversation recovery is unavailable");
    if (!await ownsDurableReconfigure("applying")) throw new StructuredReconfigureSupersededError();
    await settle("applied");
    return "applied";
  } catch (error) {
    if (settledElsewhere(error) || registryBusy(error)) throw error;
    await settle("failed", error);
    await recover({ path: generation.path, conversationId }, {
      registry,
      ownership: recoveryOwnership("failed"),
    }).catch(() => null);
    throw error;
  }
}
