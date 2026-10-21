import { AccountMutationBusyError } from "@/lib/accounts/accountMutation";
import type { AccountContext } from "@/lib/accounts/contracts";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import { resolveContinuityAccount } from "@/lib/accounts/manager";
import { emptyLaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import type { ResumeSpec } from "@/lib/agent/cli";
import { agentRegistry, type AgentRegistry, type ProcessIdentity, type RegistryFile, type SpawnBeginResult } from "@/lib/agent/registry";
import { conversationAgentRole } from "@/lib/agent/spawnAdmission";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { cachedLimitsProvenance } from "@/lib/limits";
import { captureProcessIdentity, processIdentityMayOwn } from "@/lib/processIdentity";
import { derivedSpawnTitle, durableSemanticTitle } from "@/lib/title";
import { activeDrain } from "@/lib/selfUpdate/drain";
import { DeliveryAdmissionRefusedError, type DeliveryAdmissionGuard } from "@/lib/deliveryAdmission";
import type { MessageOrigin } from "./messageOrigin";

import { accountPark, type AccountPark } from "./accountPark";
import { runtimeHostClient, type RuntimeHostClient } from "./client";
import { reconcileDeadStructuredRegistryHostOffLoop } from "./registry";
import { restartCutEvidenceHolds } from "./restartCutHold";
import { assertPipelineTurnAllowed } from "./accountCreditGuard";
import { StructuredRecoveryContendedError } from "./structuredRecoveryContention";
import { stagedLaunchRecovery } from "./stagedRecovery";
import {
  failStagedResume,
  recoverStagedStructuredLaunch,
  RESUME_PUBLICATION_BOUND_MS,
  spawnStructuredConversation,
} from "./structuredSpawn";
import { spawnTransport } from "./spawnTransport";
import { runtimeSwitchRetirementReason } from "@/lib/pipelines/runtimeSwitchFence";
import { findPipelineRecord } from "@/lib/pipelines/store";
import { instanceCpuPrioritySource } from "./cpuAdmissionScope";
import { cpuPriorityEnv } from "./cpuPriority";

export interface StructuredRecoveryRequest {
  /** Fresh autonomous seat authority, re-read after recovery's lock waits. */
  admissionGuard?: DeliveryAdmissionGuard;
  /** Seat authority after reservation, independent of this launch's new identity. */
  authorityGuard?: () => void;
  path: string;
  conversationId?: string | null;
  origin?: MessageOrigin;
  operationId?: string;
  /** Immutable journal admission time when no registry reservation exists. */
  admittedAt?: string;
}

/** No successor receipt exists yet; callers keep the original message queued. */
export class StructuredRecoveryHeldForUpdateError extends Error {
  constructor(message = "new autonomous recovery is held for the automatic update") {
    super(message);
    this.name = "StructuredRecoveryHeldForUpdateError";
  }
}

/** Startup holds a predecessor's row until its restart cut evidence is decided
    (docs/design/restart-cut-recognition.md): nothing retires or replaces it
    before then, whoever asks. The caller keeps its message queued. */
function assertRestartCutEvidenceDecided(key: SessionKey): void {
  if (restartCutEvidenceHolds(sessionKeyId(key))) {
    throw new StructuredRecoveryHeldForUpdateError("recovery is held until the conversation's restart cut evidence is decided");
  }
}

function assertRecoveryAdmission(request: StructuredRecoveryRequest, registry: AgentRegistry): void {
  if (request.origin?.kind !== "agent") return;
  const hold = activeDrain();
  if (!hold) return;
  const acceptedAt = request.operationId ? registry.deliveryAdmissionAtForOperation(request.operationId) : null;
  const accepted = Date.parse(acceptedAt ?? request.admittedAt ?? "");
  if (!Number.isFinite(accepted) || accepted >= Date.parse(hold.since)) throw new StructuredRecoveryHeldForUpdateError();
}

export interface StructuredRecoveryResult {
  target: null;
  path: string;
  conversationId: ViewerConversationId;
  spawned: boolean;
  /** Rechecked when a recovered conversation accepts its queued message. */
  admissionGuard?: DeliveryAdmissionGuard;
  /** Set when the live host handed back cannot accept a turn yet because the
      provider has parked its account (#611). The host is healthy and keeps its
      claim; what it cannot do is start a turn before `hold.until`. A caller
      that can wait must hold the message rather than enqueue it — a queued
      item nobody watches is exactly the stall this reports. When
      `hold.resetKnown` is false the provider named no reset, so `until` is the
      bounded recheck the park reports instead of a deadline: the caller waits
      the same way, and says the reset is unknown while it does. */
  hold?: AccountPark | null;
}

/** Resolves whether the account behind a live host is parked by the provider.
    Injectable so a test states the provider's answer instead of reaching for
    the machine's limits cache. */
export type StructuredHostParkResolver = (
  engine: "claude" | "codex",
  accountId: string | null,
  snapshot: Pick<RegistryFile, "quotaObservations">,
  model?: string | null,
) => AccountPark | null;

const defaultParkResolver: StructuredHostParkResolver = (engine, accountId, snapshot, model) => accountPark(engine, accountId, {
  quotaObservation: (forEngine, id) => snapshot.quotaObservations[forEngine]?.[id],
  limitsProvenance: cachedLimitsProvenance,
  model,
});

export interface StructuredRecoveryDependencies {
  registry?: AgentRegistry;
  client?: RuntimeHostClient | null;
  transport?: () => "tmux" | "structured";
  resolveAccount?: (engine: "claude" | "codex" | "copilot", accountId: string | null, project: string | null) => AccountContext;
  spawn?: typeof spawnStructuredConversation;
  processIdentity?: () => ProcessIdentity;
  requestDeliveryDrain?: () => void;
  park?: StructuredHostParkResolver;
  ownership?: {
    operationId: string;
    revision: number;
    owns: () => Promise<boolean>;
    /** Synchronous durable recheck for destructive writes after admission. */
    assertCurrent?: () => void;
    releaseHost: (key: SessionKey) => Promise<boolean>;
    /** Throws when the operation's owner no longer allows the account the
        successor host would start on. A recorded account resumes through
        continuity, which asks no project pool, so the owner is asked here. */
    authorizeAccount?: (accountId: string | null) => void | Promise<void>;
  };
  /** The staged-launch probe and settlement a resume's publication is driven
      through; tests substitute the runtime boundary behind them. */
  probeStagedLaunch?: typeof recoverStagedStructuredLaunch;
  failStagedLaunch?: typeof failStagedResume;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A resume whose publication ended in failure (#2046), including an immediate
    terminal exit or a staged attempt that exhausted its publication bound. */
export class StructuredResumeUnpublishedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "StructuredResumeUnpublishedError";
  }
}

const RESUME_PUBLICATION_POLL_MS = 1_000;

/**
 * Drives a resume that came back staged to publication, or to a failure that
 * names why, within {@link RESUME_PUBLICATION_BOUND_MS} (#2046).
 *
 * A resume used to be answered "did not publish its transcript" the moment
 * its launch came back staged, while it went on publishing: the send that
 * raised it failed, and an identical resend seconds later found the host up.
 * The send now waits for the resume it caused. The probe is the launch's own
 * staged recovery, admitted here whatever the conversation belongs to: a
 * resume carries no first message, so the probe can only publish the host.
 */
async function awaitResumePublication(
  launchId: string,
  registry: AgentRegistry,
  client: RuntimeHostClient,
  dependencies: StructuredRecoveryDependencies,
  authorize: () => Promise<void>,
): Promise<string | null> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const probe = dependencies.probeStagedLaunch ?? recoverStagedStructuredLaunch;
  const staged = registry.readOnlySnapshot().receipts[launchId];
  const deadline = (stagedLaunchRecovery(staged)?.startedAt ?? now()) + RESUME_PUBLICATION_BOUND_MS;
  for (;;) {
    /* The probe may publish a host that no continuation of this process holds,
       so the owner is asked before each one. A refused resume ends here: its
       receipt fails and the host it started is retired. */
    try {
      await authorize();
    } catch (error) {
      await (dependencies.failStagedLaunch ?? failStagedResume)(launchId, registry, client,
        error instanceof Error ? error.message : "structured recovery account is no longer allowed");
      throw error;
    }
    const receipt = await probe(launchId, registry, client, { now, eligible: () => true });
    if (receipt.state === "completed") return receipt.artifactPath;
    if (receipt.state === "failed" || receipt.state === "conflicted") {
      throw new StructuredResumeUnpublishedError(receipt.error ?? "host resume did not publish");
    }
    if (now() >= deadline) {
      const reason = `host resume did not publish within ${RESUME_PUBLICATION_BOUND_MS / 1_000} s: ${stagedLaunchRecovery(receipt)?.reason ?? "publication pending"}`;
      const failed = await (dependencies.failStagedLaunch ?? failStagedResume)(launchId, registry, client, reason);
      const settled = failed.receipt ?? registry.readOnlySnapshot().receipts[launchId];
      if (settled?.state === "completed") return settled.artifactPath;
      throw new StructuredResumeUnpublishedError(settled?.error ?? reason);
    }
    await sleep(Math.min(RESUME_PUBLICATION_POLL_MS, Math.max(0, deadline - now())));
  }
}

/**
 * Ends the resume that fences a row whose recorded process still lives, when
 * that resume can no longer publish (#2028). Such a row made every recovery
 * throw {@link StructuredRecoverySynchronizingError} for good: the relay or
 * drain that meets the fence is where it gets settled. Answers whether the
 * fencing launch left its staged state, so the caller reads the row again.
 */
async function settleParkedResumeFence(
  registry: AgentRegistry,
  key: SessionKey,
  client: RuntimeHostClient | null,
  dependencies: StructuredRecoveryDependencies,
): Promise<boolean> {
  if (!client) return false;
  const snapshot = registry.readOnlySnapshot();
  const launchId = snapshot.entries[sessionKeyId(key)]?.structuredHostOperationId;
  const receipt = launchId ? snapshot.receipts[launchId] : null;
  if (!launchId || !receipt || receipt.purpose !== "resume-successor"
    || receipt.state !== "path-pending" || !stagedLaunchRecovery(receipt)) return false;
  const settled = await (dependencies.probeStagedLaunch ?? recoverStagedStructuredLaunch)(launchId, registry, client, {
    now: dependencies.now,
  });
  return settled.state !== "path-pending";
}

/** A live structured process is still fenced while its durable row carries a
    lifecycle action. Spawning a successor in that window cannot claim the
    existing writer and would perturb the live runtime session first. */
export class StructuredRecoverySynchronizingError extends Error {
  constructor() {
    super("structured recovery is synchronizing while a live host owner remains");
    this.name = "StructuredRecoverySynchronizingError";
  }
}

class StructuredRecoverySupersededError extends Error {
  constructor() {
    super("structured recovery operation is superseded");
    this.name = "StructuredRecoverySupersededError";
  }
}

interface RecoveryCandidate {
  conversationId: ViewerConversationId;
  engine: "claude" | "codex" | "copilot";
  key: SessionKey;
  path: string;
  accountId: string | null;
  /** The project this conversation's work belongs to, so a resume that has to
      CHOOSE an account draws from that project's pool (#1279). */
  project: string | null;
  parentConversationId: ViewerConversationId | null;
  spec: ResumeSpec;
  /** A non-terminal row's recorded structured process is alive or
      unverifiable, so recovery must not issue a successor spawn while the
      durable row is unsettled. */
  hostProcessLive: boolean;
  /** The registered host is process-alive, claim-owned and not terminal. */
  hostLive: boolean;
  /** The provider limit parking that live host's account, if any. */
  park: AccountPark | null;
  /** A live host the provider has NOT parked: ready to receive a turn. */
  publishReady: boolean;
}

export function structuredHostProcessAlive(identity: ProcessIdentity | null): boolean {
  return identity ? processIdentityMayOwn(identity) : false;
}

const recoveryStore = globalThis as typeof globalThis & {
  __llvStructuredRecovery?: Map<string, Promise<StructuredRecoveryResult | null>>;
};
const recoveries = recoveryStore.__llvStructuredRecovery ??= new Map();
export function structuredRecoveryPending(conversationId: string): boolean {
  return [...recoveries.keys()].some(key => key.includes(`:${conversationId}:`));
}

function candidateFor(
  registry: AgentRegistry,
  request: StructuredRecoveryRequest,
  durableProfileWins = false,
  park: StructuredHostParkResolver = defaultParkResolver,
): RecoveryCandidate | null {
  const conversation = request.conversationId?.startsWith("conversation_")
    ? registry.conversation(request.conversationId as `conversation_${string}`)
    : registry.conversationForPath(request.path);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return null;
  const key = { engine: conversation.engine, sessionId: generation.id } as const;
  const snapshot = registry.readOnlySnapshot();
  const entry = snapshot.entries[sessionKeyId(key)];
  /* Captured survivors fence every replacement path, including recovery whose
     old root is already dead. Only a successful termination retry can verify
     and clear this evidence. */
  if ((entry?.structuredTerminationSurvivors?.length ?? 0) > 0) return null;
  if (entry?.host) return null;
  /* Structured cutover covers every registered transcript. Historical Codex
     and Claude sessions reach their pane-less host through this recovery path,
     including conversations that predate registry entries. A verified live
     tmux owner returned above keeps ownership until that process exits. */
  const terminal = entry?.status === "dead" || entry?.status === "unhosted";
  const hostProcessLive = Boolean(!terminal
    && structuredHostProcessAlive(entry?.structuredHost?.process ?? null));
  const hostLive = Boolean(hostProcessLive
    && entry?.claimOwner
    && entry.pendingAction === null
    && !terminal);
  /* #611: a process-alive claim-owned host whose account the provider has
     parked cannot accept a turn, however alive it looks. Readiness says so
     here, so the enqueue that would sit `queued` past the parked window never
     happens; the host itself is untouched and keeps its claim. An exhaustion
     the provider named no reset for withholds publication the same way: it is
     reported with the bounded recheck the park carries, so the caller waits a
     wait that ends rather than enqueuing into a spent account. */
  const hostAccountId = entry?.accountId ?? generation.accountId ?? null;
  const inheritedProfile = emptyLaunchProfile(durableProfileWins ? {
    ...(entry?.launchProfile ?? {}),
    ...generation.launchProfile,
    cwd: generation.launchProfile.cwd || entry?.launchProfile?.cwd || entry?.cwd,
  } : {
    ...generation.launchProfile,
    ...(entry?.launchProfile ?? {}),
    cwd: entry?.launchProfile?.cwd || generation.launchProfile.cwd || entry?.cwd,
  });
  /* Copilot reports no plan limits (design 3.11), so nothing can park it. */
  const hostPark = hostLive && conversation.engine !== "copilot"
    ? park(conversation.engine, hostAccountId, snapshot, inheritedProfile.model)
    : null;
  const publishReady = hostLive && !hostPark;
  const inheritedTitle = durableSemanticTitle(generation.launchProfile.title, 120)
    ?? durableSemanticTitle(entry?.launchProfile?.title, 120);
  const profile = emptyLaunchProfile({
    ...inheritedProfile,
    title: inheritedTitle ?? derivedSpawnTitle(
      "recovery",
      inheritedProfile.goal?.objective ?? inheritedProfile.cwd,
      "Conversation recovery",
    ),
  });
  const recordedParent = snapshot.lineageEdges[conversation.id]?.parentConversationId
    ?? profile.parentConversationId;
  const parentConversationId = recordedParent && recordedParent !== conversation.id
    ? registry.canonicalConversationId(recordedParent)
    : null;
  return {
    conversationId: conversation.id,
    engine: conversation.engine,
    key,
    path: generation.path,
    accountId: generation.accountId ?? entry?.accountId ?? null,
    /* A getter, because deriving a project can read the disk and most calls
       here never reach the account resolution — a live host is handed straight
       back. The MERGED profile, not the generation's own: a conversation the
       Viewer ADOPTED rather than spawned carries an empty generation profile,
       and the registry entry's durable one, folded in above, is the only thing
       left naming a project or a cwd to derive one from. */
    get project() { return conversationProjectKey(conversation.projectOwnership, profile); },
    parentConversationId: parentConversationId === conversation.id ? null : parentConversationId,
    spec: {
      command: "",
      cwd: profile.cwd,
      windowName: "structured-resume",
      engine: conversation.engine,
      "transcript": generation.path,
      launchProfile: profile,
    },
    hostProcessLive,
    hostLive,
    park: hostPark,
    publishReady,
  };
}

/** The live host as recovery hands it back. A publish-ready host is returned
    exactly as before; a host that is alive but not publish-ready is returned
    with the park that makes it unready, so the caller can wait for it instead
    of enqueuing into a host that cannot start the turn. */
function liveHostResult(candidate: RecoveryCandidate): StructuredRecoveryResult {
  return {
    target: null,
    path: candidate.path,
    conversationId: candidate.conversationId,
    spawned: false,
    ...(candidate.publishReady ? {} : { hold: candidate.park }),
  };
}

async function recoverCandidate(
  request: StructuredRecoveryRequest,
  dependencies: StructuredRecoveryDependencies,
  registry: AgentRegistry,
  candidate: RecoveryCandidate,
): Promise<StructuredRecoveryResult | null> {
  const ownership = dependencies.ownership;
  const assertOwnership = async (): Promise<void> => {
    const retired = runtimeSwitchRetirementReason(candidate.conversationId, registry);
    if (retired) throw new Error(retired);
    if (ownership && !await ownership.owns()) throw new StructuredRecoverySupersededError();
    assertPipelineTurnAllowed(candidate.conversationId, registry);
  };
  const owner = (dependencies.processIdentity ?? (() => captureProcessIdentity(process.pid)))();
  return registry.withOperationLock(candidate.key, owner, async () => {
    await assertOwnership();
    /* Again under the lock: a startup pass may have held the row meanwhile. */
    assertRestartCutEvidenceDecided(candidate.key);
    const park = dependencies.park ?? defaultParkResolver;
    let current = candidateFor(registry, request, Boolean(ownership), park);
    if (!current) return null;
    const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
    if (current.hostProcessLive && !current.hostLive
      && await settleParkedResumeFence(registry, current.key, client, dependencies)) {
      current = candidateFor(registry, request, Boolean(ownership), park);
      if (!current) return null;
    }
    if (current.hostProcessLive && !current.hostLive) {
      throw new StructuredRecoverySynchronizingError();
    }
    /* A host wrapper can disappear before its live Viewer writer releases the
       claim. Retire that claim only through the registry's PID/start-identity
       check; a live or unverifiable host remains fenced. */
    if (!current.hostLive) {
      request.admissionGuard?.();
      if (await reconcileDeadStructuredRegistryHostOffLoop(registry, current.conversationId, current.key, () => {
        request.admissionGuard?.();
        assertRestartCutEvidenceDecided(candidate.key);
      })) {
        request.admissionGuard?.(current.key);
      }
      current = candidateFor(registry, request, Boolean(ownership), park);
      if (!current) return null;
    }
    if (current.hostLive) {
      /* A parked host is reported held, never replaced: the park belongs to the
         account, so a successor would start parked too, and terminating this
         one would throw away the very continuation the caller is trying to
         reach. An explicit ownership takeover still reseats. */
      if (!ownership) return {
        ...liveHostResult(current),
        ...(request.admissionGuard ? { admissionGuard: request.admissionGuard } : {}),
      };
      const releasedKey = current.key;
      const releasedEntry = registry.readOnlySnapshot().entries[sessionKeyId(releasedKey)];
      const releasedCustody = releasedEntry ? {
        claimEpoch: releasedEntry.claimEpoch,
        claimOwner: releasedEntry.claimOwner,
        writerClaimEpoch: releasedEntry.structuredHost?.writerClaimEpoch ?? null,
        process: releasedEntry.structuredHost?.process ?? null,
      } : null;
      await ownership.releaseHost(releasedKey);
      await assertOwnership();
      await registry.deliveryWriteOrBusy({ label: "registry.terminateStructuredHost" }, () => {
        request.authorityGuard?.();
        ownership.assertCurrent?.();
        assertPipelineTurnAllowed(candidate.conversationId, registry);
        return registry.terminateStructuredHost(releasedKey, undefined, [], releasedCustody);
      });
      await assertOwnership();
      current = candidateFor(registry, request, true, park);
      if (!current) return null;
    }
    if (!client) throw new Error("structured recovery runtime host is unavailable");
    /* #1279: a resume whose conversation RECORDS an account continues on it —
       the session lives in that home and nothing is being chosen. A resume of a
       conversation that records none was choosing one, silently, from engine
       routing; that half now asks the project's pool and its capacity like
       every other automatic pick, and refuses before the spawn reservation
       exists when the binding record cannot be read. */
    const account = (dependencies.resolveAccount ?? resolveContinuityAccount)(
      current.engine,
      current.accountId,
      current.project,
    );
    let admissionGuard = request.admissionGuard;
    const assertAuthority = () => {
      assertRecoveryAdmission(request, registry);
      const retired = runtimeSwitchRetirementReason(current.conversationId, registry);
      if (retired) throw new Error(retired);
      request.authorityGuard?.();
    };
    const assertAccountAuthorized = async (): Promise<void> => {
      assertAuthority();
      admissionGuard?.();
      await ownership?.authorizeAccount?.(account.accountId ?? null);
      assertAuthority();
      admissionGuard?.();
    };
    let begun: SpawnBeginResult;
    try {
      await assertAccountAuthorized();
      begun = await registry.beginSpawnRequestAsync({
          engine: current.engine,
          cwd: current.spec.cwd,
          transport: "structured",
          accountId: account.accountId,
          conversationId: current.conversationId,
          parentConversationId: current.parentConversationId,
          purpose: "resume-successor",
          origin: { kind: "successor" },
          expectedArtifactPath: current.path,
          launchProfile: current.spec.launchProfile,
        }, () => {
          // Recheck authority after both authorization and writer admission.
          assertAuthority();
          admissionGuard?.();
        });
    } catch (error) {
      /* #1716: the lock throws its typed busy refusal from the acquire, before
         the reservation's transaction is admitted, so this recovery reserved
         nothing and started nothing and may be tried again. Only this call can
         say so: the same error raised later in recovery reaches the caller
         unchanged. */
      if (error instanceof AccountMutationBusyError) throw new StructuredRecoveryContendedError(error);
      throw error;
    }
    if (begun.kind !== "created") throw new Error("structured recovery reservation is unavailable");
    const launchId = begun.receipt.launchId;
    const surface = request.origin?.kind === "agent"
      ? request.origin.role === "seat-tick" ? "seat-tick" : "agent"
      : request.origin?.kind === "operator" ? "operator" : "unspecified";
    console.error(`[structured recovery] reserved ${launchId}; source=${surface}`);
    const predecessorOperation = registry.readOnlySnapshot().entries[sessionKeyId(current.key)]?.structuredHostOperationId;
    let claimed = false;
    let predecessorEpoch = 0;
    let successorEpoch: number | null = null;
    let ownsSuccessor = () => false;
    try {
      await assertOwnership();
    } catch (error) {
      await registry.failSpawnOffLoop(begun.receipt.launchId, "structured recovery operation was superseded");
      throw error;
    }
    try {
      await assertAccountAuthorized();
    } catch (error) {
      /* Off the loop (rule c). Refused for the lock, the launch is left to the
         stale-launch convergence (C5) and the held send to the next pass. */
      await registry.failSpawnOffLoop(begun.receipt.launchId, "structured recovery account is no longer allowed");
      throw error;
    }
    let response: Awaited<ReturnType<typeof spawnStructuredConversation>>;
    try {
      const pipelineTaskIds = registry.conversationMemberships(current.conversationId)
        .filter(membership => membership.kind === "pipeline")
        .flatMap(membership => findPipelineRecord(membership.containerId)?.taskIds ?? []);
      const recoveredAccount = {
        ...account,
        env: { ...account.env, ...cpuPriorityEnv(instanceCpuPrioritySource(pipelineTaskIds)) },
      };
      response = await (dependencies.spawn ?? spawnStructuredConversation)({
        engine: current.engine,
        receipt: begun.receipt,
        spec: current.spec,
        account: recoveredAccount,
        "prompt": "",
        registry,
        client,
        authorize: assertAccountAuthorized,
        resumeAdmission: {
          beforeClaim: () => {
            assertAuthority(); admissionGuard?.();
            predecessorEpoch = registry.readOnlySnapshot().entries[sessionKeyId(current.key)]?.claimEpoch ?? 0;
          },
          claimed: claim => {
            const claimOwner = claim.claimOwner;
            const claimEpoch = claim.claimEpoch;
            if (claimEpoch !== predecessorEpoch + 1 || claim.structuredHostOperationId !== predecessorOperation)
              throw new DeliveryAdmissionRefusedError("structured-recovery-superseded");
            successorEpoch = claimEpoch;
            ownsSuccessor = () => !!claimOwner && registry.ownsStructuredHostClaim(current.key, claimOwner, claimEpoch);
            // The spawn supplies the claim it just acquired, before yielding.
            // Later checks accept only this reservation and this writer.
            admissionGuard = () => {
              assertAuthority();
              if (!request.authorityGuard) request.admissionGuard?.();
              const snapshot = registry.readOnlySnapshot();
              const receipt = snapshot.receipts[launchId];
              const entry = snapshot.entries[sessionKeyId(current.key)];
              if (!claimOwner || !receipt || receipt.conversationId !== current.conversationId
                || receipt.accountId !== account.accountId || receipt.purpose !== "resume-successor"
                || receipt.state === "failed" || receipt.state === "conflicted"
                || entry?.claimOwner !== claimOwner || entry.claimEpoch !== claimEpoch
                || entry.structuredHost?.writerClaimEpoch !== claimEpoch
                || entry.structuredHostOperationId !== (receipt.key ? launchId : predecessorOperation)) {
                throw new DeliveryAdmissionRefusedError("structured-recovery-superseded");
              }
            };
            claimed = true;
            admissionGuard();
          },
        },
      });
    } catch (error) {
      // A terminal CLI exit can throw before returning the staged response.
      // Only its settled receipt and released host prove unpublished failure;
      // unconfirmed cleanup or an unsettled receipt keeps the original retry.
      if (error instanceof DeliveryAdmissionRefusedError) throw error;
      await assertOwnership();
      // A failed spawn releases its own claim. Classify that terminal receipt
      // with current authority; its released writer cannot pass the live guard.
      if (!claimed) admissionGuard?.();
      await ownership?.authorizeAccount?.(account.accountId ?? null);
      assertAuthority();
      const snapshot = registry.readOnlySnapshot();
      const receipt = snapshot.receipts[begun.receipt.launchId];
      const entry = snapshot.entries[sessionKeyId(current.key)];
      if ((receipt?.state === "failed" || receipt?.state === "conflicted")
        && (successorEpoch === null || entry?.claimEpoch === successorEpoch)
        && (!entry?.structuredHostOperationId || entry.structuredHostOperationId === launchId || entry.structuredHostOperationId === predecessorOperation)
        && !entry?.host && !entry?.claimOwner && !entry?.structuredHost?.process
        && !entry?.pendingAction && !(entry?.structuredTerminationSurvivors?.length)) {
        throw new StructuredResumeUnpublishedError(receipt.error ?? (error instanceof Error ? error.message : "host resume did not publish"));
      }
      throw error;
    }
    let publishedPath = response.ok ? response.path : null;
    /* A staged resume with no path has not published its host yet. One that
       names its path has, and only its transcript is pending. */
    if (response.ok && !publishedPath && response.state === "path-pending") {
      publishedPath = await awaitResumePublication(response.launchId ?? begun.receipt.launchId, registry, client, dependencies, assertAccountAuthorized)
        ?? current.path;
    }
    if (!response.ok || !publishedPath) throw new Error("structured recovery host did not publish its transcript");
    try {
      await assertOwnership();
      await assertAccountAuthorized();
    } catch (error) {
      if (ownsSuccessor()) {
        const successorEntry = registry.readOnlySnapshot().entries[sessionKeyId(current.key)];
        const successorCustody = successorEntry ? {
          claimEpoch: successorEntry.claimEpoch,
          claimOwner: successorEntry.claimOwner,
          writerClaimEpoch: successorEntry.structuredHost?.writerClaimEpoch ?? null,
          process: successorEntry.structuredHost?.process ?? null,
        } : null;
        await ownership?.releaseHost(current.key);
        await registry.deliveryWriteOrBusy({ label: "registry.terminateStructuredHost" }, () => {
          request.authorityGuard?.();
          ownership?.assertCurrent?.();
          assertPipelineTurnAllowed(current!.conversationId, registry);
          if (ownsSuccessor()) registry.terminateStructuredHost(current!.key, undefined, [], successorCustody);
        });
      }
      throw error;
    }
    (dependencies.requestDeliveryDrain ?? requestAccountMigrationTick)();
    return {
      target: null,
      path: publishedPath,
      conversationId: current.conversationId,
      spawned: true,
      ...(admissionGuard ? { admissionGuard } : {}),
    };
  });
}

export async function recoverDeadStructuredConversation(
  request: StructuredRecoveryRequest,
  dependencies: StructuredRecoveryDependencies = {},
): Promise<StructuredRecoveryResult | null> {
  if ((dependencies.transport ?? spawnTransport)() !== "structured") return null;
  const registry = dependencies.registry ?? agentRegistry();
  if (dependencies.ownership && !await dependencies.ownership.owns()) {
    throw new StructuredRecoverySupersededError();
  }
  const candidate = candidateFor(
    registry,
    request,
    Boolean(dependencies.ownership),
    dependencies.park ?? defaultParkResolver,
  );
  if (!candidate) return null;
  const retired = runtimeSwitchRetirementReason(candidate.conversationId, registry);
  if (retired) throw new Error(retired);
  let admittedRequest = request;
  const admissionSnapshot = registry.readOnlySnapshot();
  if (conversationAgentRole(admissionSnapshot, candidate.conversationId) === "curator") {
    const [{ curatorRecoveryGuard }, { defaultSeatTickAdmissionSources }] = await Promise.all([
      import("@/lib/memory/curation/admission"), import("@/lib/monitor/seatTickAdmissionSources"),
    ]);
    const curatorGuard = await curatorRecoveryGuard(candidate.conversationId, {
      ...defaultSeatTickAdmissionSources(), registry: () => registry,
    });
    const admissionGuard: DeliveryAdmissionGuard = key => {
      request.admissionGuard?.(key);
      curatorGuard();
    };
    admittedRequest = { ...request, admissionGuard, authorityGuard: () => {
      (request.authorityGuard ?? request.admissionGuard)?.();
      curatorGuard();
    } };
    admissionGuard();
  }
  assertRestartCutEvidenceDecided(candidate.key);
  const recoveryKey = dependencies.ownership
    ? `${registry.filename}:${candidate.conversationId}:${dependencies.ownership.operationId}:${dependencies.ownership.revision}`
    : `${registry.filename}:${candidate.conversationId}:${request.operationId ?? "operator"}`;
  const pending = recoveries.get(recoveryKey);
  if (pending) {
    admittedRequest.admissionGuard?.();
    if (!admittedRequest.admissionGuard && !admittedRequest.authorityGuard) return pending;
    return pending.then((result: StructuredRecoveryResult | null) => result && {
      ...result,
      admissionGuard: () => {
        result.admissionGuard?.();
        (admittedRequest.authorityGuard ?? admittedRequest.admissionGuard)?.();
      },
    });
  }
  if (candidate.hostLive && !dependencies.ownership) return { ...liveHostResult(candidate), ...(admittedRequest.admissionGuard ? { admissionGuard: admittedRequest.admissionGuard } : {}) };
  const recovery = recoverCandidate(admittedRequest, dependencies, registry, candidate);
  recoveries.set(recoveryKey, recovery);
  try {
    return await recovery;
  } finally {
    if (recoveries.get(recoveryKey) === recovery) recoveries.delete(recoveryKey);
  }
}
