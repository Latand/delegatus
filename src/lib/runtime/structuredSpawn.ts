import { operatorDecisionFormsRequired } from "@/lib/orchestrator/operatorDecisionForms";
import { ownerRelaySpawnAuthorized } from "@/lib/externalRelay/ownerAuthority";
import { assertSpawnMemoryAvailable } from "@/lib/agent/spawnMemory";
import { spawnDiagnosticErrorFor } from "@/lib/agent/spawnDiagnostics";
import { AgentMemoryCell, planAgentMemory } from "./agentMemory";
import { planAgentCpu, workloadForMemberships } from "./cpuPlacement";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AccountContext } from "@/lib/accounts/contracts";
import { launchServiceTier } from "./codexTurnProfile";
import { accountManager } from "@/lib/accounts/manager";
import { claudeSettingsPath } from "@/lib/accounts/claude";
import { claudeValidityFromLimitRead } from "@/lib/accounts/spawnHealth";
import { explicitLaunchProfileSandbox, launchProfileEngineReadOnly, type LaunchProfile, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { learnedRulesForLaunchProfile, memoryStartIdentity } from "@/lib/memory/roleLaunch";
import { codexNativeMemoryEnabled } from "@/lib/agent/codexSpawnPolicy";
import type { SpawnAccountAdmission } from "@/lib/agent/accountLiveness";
import { effectiveClaudePermissionMode, resolveCopilotBinary, type AgentEngine, type ResumeSpec } from "@/lib/agent/cli";
import { identityMaterializationFence, resolveConversationAlias, structuredClaimIdentity, type AgentRegistry, type AgentRegistryEntry, type ProcessIdentity, type RegistryFile, type SpawnReceipt, type StructuredHostColumns } from "@/lib/agent/registry";
import { sessionKey, sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { forEachStartupBatch } from "./startupWork";
import { readRuntimeSnapshot } from "./snapshotReads";
import { registryRowsMatching } from "@/lib/agent/sqliteRegistryStore";
import { yieldToRuntime } from "@/lib/cooperative";
import type { SpawnResponse } from "@/lib/agent/spawnResponse";
import { prepareManagedClaudeSpawnHome, viewerMcpTransportForLaunch } from "@/lib/agent/spawnPolicy";
import { claudeTranscriptPath } from "@/lib/agent/transcript";
import { statePath } from "@/lib/configDir";
import { readHotStateAuthority } from "@/lib/state/hotStateAuthority";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { rememberHandoffChild, persistHandoffLineage } from "@/lib/handoffLineage";
import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";
import { fetchClaudeLimits } from "@/lib/limits";
import { procBackend } from "@/lib/proc";
import { captureProcessIdentity, processIdentityStatus } from "@/lib/processIdentity";
import { signalProcessGroup } from "@/lib/processGroup";
import { hasUserAuthoredMessage } from "@/lib/session/reader";
import { isCurrentOperatorSeat } from "@/lib/orchestrator/managerAuthoritySources";
import { buildImagePayload, deleteInboxImages, spawnAgentWithPrompt } from "@/lib/tmux";
import { hardenedRedact } from "@/lib/view/compactText";

import { ClaudeStreamBrokerHost, type ClaudeStreamBrokerHostOptions } from "./claudeStreamBrokerHost";
import { CodexAppServerHost, type CodexAppServerHostOptions } from "./codexAppServerHost";
import { isRuntimeHostTransportFailure, withRuntimeRecoveryReads, RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import { supervisedRuntimeHostUnavailableReason } from "./flags";
import { StructuredHostAdoptionCleanupError, StructuredSessionMaterializationError, type EngineHost, type HostState, type SessionMaterializationEvidence } from "./engineHost";
import type { MessageOrigin } from "./messageOrigin";
import { agentMessageOrigin, delegatusMessageOrigin } from "./agentMessageAuthor";
import { isStructuredHostKind, runtimeHostKindForEngine, runtimeSettingsCapability, runtimeSteerCapability, type RuntimeOperationResult, type RuntimeSession, type RuntimeSnapshot } from "./contracts";
import { bindClaudeHostPersistence, bindCodexHostPersistence, bindCopilotHostPersistence, stopTerminalStructuredOrphan, type StructuredOrphanStopDependencies } from "./registry";
import { CopilotAcpHost, type CopilotAcpHostOptions } from "./copilotAcpHost";
import { publishStructuredDeliveryHost, releaseStructuredDeliveryHost, structuredDeliveryLastError, structuredDeliveryHostForConversation, retainUnpublishedStructuredLaunchHost, StructuredDeliveryControllerUnavailableError } from "./structuredDeliveryController";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { runtimeImageCapability, runtimeImageStore } from "./runtimeImageStore";
import { publishFilesRevision } from "./filesRevision";
import { parseStructuredImageRefs, structuredContent, type StructuredImageRef } from "./structuredContent";
import { TELEGRAM_GRANT_REVOKED_BEFORE_LAUNCH, TELEGRAM_SEAT_INACTIVE_BEFORE_LAUNCH } from "./telegramConnectorEnv";
import { STAGED_RECOVERY_PREFIX, stagedLaunchRecovery, type StagedLaunchRecovery } from "./stagedRecovery";
import type { SeatTickSources } from "@/lib/monitor/seatTickSources";

export type SpawnedStructuredHost = EngineHost & {
  /** Effective MCP transport when account config constrained the preference. */
  readonly viewerMcpTransport?: "stdio" | "http" | null;
  identity: { threadId: string; path: string | null } | { sessionId: string };
  onStateChange(listener: (state: HostState) => void): () => void;
  /** The canonical phrase of a terminal CLI exit, when the host recognized one
      (#1071). Absent on hosts whose engine reports no such diagnostic. */
  terminalExitReason?(): string | null;
};

export const INITIAL_MESSAGE_TIMEOUT_MS = 30_000;
const INITIAL_MESSAGE_POLL_MS = 250;
/** How long a launch's idempotent runtime calls keep retrying a transport
    failure (#2058). A launch about thirty seconds after a runtime-host handoff
    met calls near five seconds against a three-second budget; this spans the
    new host's warm-up and stays inside the durable setup bound. */
export const ADMISSION_RETRY_DEADLINE_MS = 30_000;
const ADMISSION_RETRY_BACKOFF_MS = 250;
const ADMISSION_RETRY_MAX_BACKOFF_MS = 2_000;
/**
 * Operational ownership bound for one synchronous setup generation. It gives
 * host start, binding, first delivery, and publication one five-minute caller
 * lifetime, then hands cleanup to durable reconciliation. Engine evidence can
 * establish a concrete failure earlier; this bound supplies no causal claim.
 */
export const STRUCTURED_SPAWN_DURABLE_SETUP_TIMEOUT_MS = 5 * 60_000;
export const READ_ONLY_STAGE_PERMISSION_PROFILE = "llv-read-only-stage";
const PINNED_SPAWN_HEALTH_TIMEOUT_MS = 600;

export function queuedPinnedSpawnTitle(locale: "en" | "uk", retryAt: string): string {
  const localized = locale === "uk" ? uk["spawnCard.pinUnavailableQueued"] : en["spawnCard.pinUnavailableQueued"];
  const template = typeof localized === "string" ? localized : en["spawnCard.pinUnavailableQueued"];
  return template.replace("{retryAt}", retryAt);
}

export async function resolvePinnedSpawnAdmission(
  engine: "claude" | "codex" | "copilot",
  account: AccountContext,
  /** The model the pinned launch names, so a tier weekly it does not draw on
      never refuses it (issues #1796, #1431). */
  model?: string | null,
): Promise<SpawnAccountAdmission> {
  /* Neither Codex nor Copilot exposes a pre-launch limit read here. */
  if (engine === "codex" || engine === "copilot") {
    return { kind: "admissible", basis: "current", stale: false, retryAt: null };
  }
  return claudeValidityFromLimitRead(await fetchClaudeLimits(
    path.join(account.home, ".credentials.json"),
    Date.now,
    PINNED_SPAWN_HEALTH_TIMEOUT_MS,
  ), Date.now(), model);
}

export interface StructuredHostAccessMaterialization {
  env: NodeJS.ProcessEnv;
  codex: {
    sandbox?: string;
    permissionProfile?: string;
    permissionProfileConfig?: string;
  };
  host: {
    forwardGitHubConfig?: boolean;
    releaseCleanup?: () => void;
  };
  scratchDirectory: string | null;
  cleanup(): void;
}

export type StructuredHostAccessPolicy = boolean | {
  /** Carried with the sandbox so pipeline callers must name both axes. The
      repository policy is enforced by pipeline settlement. */
  readOnly: boolean;
  sandbox: "full" | "restricted";
};

type DurableStructuredHostAccess = Pick<LaunchProfile, "readOnly" | "sandbox"> | null | undefined;

/** New pipeline profiles persist both axes. Profiles created before that split
    retain their legacy readOnly-to-sandbox behavior on adoption. */
export function structuredHostAccessPolicy(profile: DurableStructuredHostAccess): StructuredHostAccessPolicy {
  const sandbox = explicitLaunchProfileSandbox(profile);
  return sandbox
    ? { readOnly: profile?.readOnly === true, sandbox }
    : profile?.readOnly === true;
}

function githubConfigDirectory(sourceEnv: NodeJS.ProcessEnv): string {
  if (sourceEnv.GH_CONFIG_DIR) return sourceEnv.GH_CONFIG_DIR;
  const home = sourceEnv.HOME || os.homedir();
  return path.join(sourceEnv.XDG_CONFIG_HOME || path.join(home, ".config"), "gh");
}

/** Materialize the tool/network boundary. An explicit restricted pipeline
    profile uses workspace-write for either repository policy; settlement owns
    the read-only declared-output fence. A legacy boolean preserves the old
    read-only host profile for non-pipeline callers and stored sessions.

    Every pipeline stage (an explicit profile, either sandbox) runs with
    `TMPDIR` in its own scratch directory under `statePath("scratch")`, on the
    disk the state lives on, and the directory goes with the host (#1957). A
    reviewer's export of the head it reviews, about a gigabyte with its
    dependencies, used to land in the shared temp filesystem and stay there
    until the quota ran out. A full-access Claude stage keeps its
    `CLAUDE_CODE_TMPDIR` on the temp root it had, because that is where the
    Viewer finds the stage's background tasks. */
export function materializeStructuredHostAccess(
  policy: StructuredHostAccessPolicy,
  sourceEnv: NodeJS.ProcessEnv,
  capability: string | null,
  scratchParent?: string,
): StructuredHostAccessMaterialization {
  const baseEnv = {
    ...sourceEnv,
    ...(capability ? { LLV_SPAWN_CAPABILITY: capability } : {}),
  };
  const explicitAxes = typeof policy !== "boolean";
  const restricted = explicitAxes ? policy.sandbox === "restricted" : policy;
  if (!restricted && !explicitAxes) {
    return {
      env: baseEnv,
      codex: { sandbox: "danger-full-access" },
      host: { forwardGitHubConfig: true },
      scratchDirectory: null,
      cleanup: () => {},
    };
  }

  const resolvedScratchParent = scratchParent ?? statePath("scratch");
  fs.mkdirSync(resolvedScratchParent, { recursive: true, mode: 0o700 });
  const scratchDirectory = fs.mkdtempSync(path.join(resolvedScratchParent, restricted ? "llv-read-only-stage-" : "llv-stage-"));
  try {
    fs.chmodSync(scratchDirectory, 0o700);
    const temporaryDirectory = path.join(scratchDirectory, "tmp");
    fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
    const cleanup = () => fs.rmSync(scratchDirectory, { recursive: true, force: true });
    if (!restricted) {
      return {
        env: {
          ...baseEnv,
          TMPDIR: temporaryDirectory,
          CLAUDE_CODE_TMPDIR: sourceEnv.CLAUDE_CODE_TMPDIR || sourceEnv.TMPDIR || os.tmpdir(),
        },
        codex: { sandbox: "danger-full-access" },
        host: {
          forwardGitHubConfig: true,
          releaseCleanup: cleanup,
        },
        scratchDirectory,
        cleanup,
      };
    }
    const codex = explicitAxes
      ? { sandbox: "workspace-write" }
      : {
          permissionProfile: READ_ONLY_STAGE_PERMISSION_PROFILE,
          permissionProfileConfig: `permissions.${READ_ONLY_STAGE_PERMISSION_PROFILE}={extends=":read-only",filesystem={${JSON.stringify(scratchDirectory)}="write"}}`,
        };
    return {
      env: {
        ...baseEnv,
        TMPDIR: temporaryDirectory,
        GH_CONFIG_DIR: githubConfigDirectory(sourceEnv),
      },
      codex,
      host: {
        forwardGitHubConfig: true,
        releaseCleanup: cleanup,
      },
      scratchDirectory,
      cleanup,
    };
  } catch (error) {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Runtime admission calls carry the durable launch id as their idempotency
    key, so a replay lands on the original receipt. Production #367 saw
    simultaneous launches turn transient socket timeouts into terminal failed
    receipts; transport-level failures are retried before giving up, with a
    doubling backoff, until {@link ADMISSION_RETRY_DEADLINE_MS} has passed
    (#2058). The time spent counts both the clock and the backoff asked for,
    so a caller whose sleep returns at once still reaches the deadline. */
export async function withRuntimeAdmissionRetry<T>(
  request: () => Promise<T>,
  options: { deadlineMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? ADMISSION_RETRY_DEADLINE_MS;
  const startedAt = now();
  let backedOff = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (!isRuntimeHostTransportFailure(error)) throw error;
      const backoff = Math.min(ADMISSION_RETRY_MAX_BACKOFF_MS, ADMISSION_RETRY_BACKOFF_MS * 2 ** (attempt - 1));
      if (Math.max(now() - startedAt, backedOff) + backoff > deadlineMs) throw error;
      backedOff += backoff;
      await sleep(backoff);
    }
  }
}
const INITIAL_MESSAGE_DELIVERED = new Set(["delivered", "turn-started", "steered"]);
const INITIAL_MESSAGE_FAILED = new Set(["failed", "rejected", "uncertain", "interrupted"]);

export class StructuredInitialMessageTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredInitialMessageTimeoutError";
  }
}

export class StructuredTranscriptMaterializationError extends Error {
  constructor(timeoutMs: number) {
    super(`structured spawn startup reached its ${timeoutMs}ms durable setup bound without a readable transcript`);
    this.name = "StructuredTranscriptMaterializationError";
  }
}

function structuredTranscriptIsReadable(artifactPath: string): boolean {
  let descriptor: number | null = null;
  try {
    const stat = fs.statSync(artifactPath);
    if (!stat.isFile() || stat.size === 0) return false;
    descriptor = fs.openSync(artifactPath, "r");
    const maxValidationBytes = 8 * 1024 * 1024;
    const length = Math.min(stat.size, maxValidationBytes);
    const buffer = Buffer.allocUnsafe(length);
    if (fs.readSync(descriptor, buffer, 0, length, 0) !== length) return false;
    const text = buffer.toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as unknown;
        if (record && typeof record === "object" && !Array.isArray(record)) return true;
      } catch {
        // The writer may still be appending its first record; the next poll retries it.
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

async function waitForStructuredSessionMaterialization(
  host: SpawnedStructuredHost,
  artifactPath: string,
  clientMessageId: string,
  options: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    timeoutMs: number;
  },
): Promise<void> {
  const deadline = options.now() + options.timeoutMs;
  let lastEvidence: SessionMaterializationEvidence | null = null;
  for (;;) {
    const evidence = host.sessionMaterializationEvidence
      ? await host.sessionMaterializationEvidence(clientMessageId)
      : { state: "materialized" as const };
    if (evidence.state === "failed") throw new StructuredSessionMaterializationError(evidence.reason);
    lastEvidence = evidence;
    if (evidence.state === "materialized" && structuredTranscriptIsReadable(artifactPath)) return;
    if (evidence.state === "unavailable" && structuredTranscriptIsReadable(artifactPath)) return;
    const remaining = deadline - options.now();
    if (remaining <= 0) {
      if (lastEvidence.state === "absent") {
        throw new StructuredSessionMaterializationError(
          `${lastEvidence.reason}; startup reached its ${options.timeoutMs}ms durable setup bound`,
        );
      }
      if (lastEvidence.state === "unavailable") {
        throw new StructuredSessionMaterializationError(
          `structured spawn startup reached its ${options.timeoutMs}ms durable setup bound while session evidence was unavailable: ${lastEvidence.reason}`,
        );
      }
      throw new StructuredTranscriptMaterializationError(options.timeoutMs);
    }
    await options.sleep(Math.min(INITIAL_MESSAGE_POLL_MS, remaining));
  }
}

const STALE_SPAWN_PROCESS_REAP_ATTEMPTS = 20;
const STALE_SPAWN_PROCESS_REAP_POLL_MS = 25;

/** Reaps the detached engine group only while PID and start identity still
    match the staged host. A missing or recycled target already counts as gone;
    an unverifiable identity stays untouched. */
async function terminateVerifiedStructuredSpawnProcess(expected: ProcessIdentity): Promise<boolean> {
  if (expected.pid === process.pid || expected.startIdentity === null) return false;
  const matches = () => procBackend.processIdentity(expected.pid) === expected.startIdentity;
  if (!matches()) return true;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!signalProcessGroup(expected.pid, signal)) {
      try { process.kill(expected.pid, signal); }
      catch { return !matches(); }
    }
    for (let attempt = 0; attempt < STALE_SPAWN_PROCESS_REAP_ATTEMPTS; attempt += 1) {
      if (!matches()) return true;
      if (attempt + 1 < STALE_SPAWN_PROCESS_REAP_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, STALE_SPAWN_PROCESS_REAP_POLL_MS));
      }
    }
  }
  return !matches();
}

function structuredSpawnFailureReason(error: unknown): string {
  if (isRuntimeHostTransportFailure(error)) {
    return supervisedRuntimeHostUnavailableReason("structured spawn runtime host");
  }
  const message = error instanceof Error ? error.message : "structured spawn failed";
  return hardenedRedact(message).replace(/\s+/g, " ").trim().slice(0, 240) || "structured spawn failed";
}

function runtimeEntryStatus(session: RuntimeSession): "dead" | "live" | "idle" {
  if (session.host === "dead" || session.host === "unhosted") return "dead";
  if (session.turn === "running") return "live";
  return "idle";
}

function failedOperationReason(operation: RuntimeOperationResult | null, subject: string): string | null {
  const status = operation?.receipt.status;
  if (!status || !INITIAL_MESSAGE_FAILED.has(status)) return null;
  return operation.receipt.reason ?? `${subject} ended as ${status}`;
}

function reconciledInitialMessage(
  receipt: SpawnReceipt,
  status: string | undefined,
  runtimeDelivered: boolean,
): "pending" | "queued" | "delivered" | "failed" {
  if (receipt.state === "failed" || (status !== undefined && INITIAL_MESSAGE_FAILED.has(status))) return "failed";
  if (runtimeDelivered || receipt.state === "completed") return "delivered";
  if (status === "queued" || status === "pending" || status === "delivering") return "queued";
  return "pending";
}

/* Both first-message writes wait for the lock off the loop
   (docs/design/delivery-progress-and-drain.md, C2). Refused, the reservation
   stays as it was: the queue's terminal projection or the sweep settles a
   delivered one from the journal, and a claimed one is already uncertain. */
async function settleInitialMessageReservation(registry: AgentRegistry, launchId: string): Promise<void> {
  const clientMessageId = `spawn_${launchId}`;
  const reservation = Object.values(registry.readOnlySnapshot().heldDeliveries)
    .find((delivery) => delivery.clientMessageId === clientMessageId);
  if (reservation && reservation.state !== "delivered") {
    await registry.deliveryWrite({ label: "delivery.settle", operationId: reservation.command.operationId },
      () => registry.recordDeliveryOutcome(reservation.id, "delivered"));
  }
}

async function markInitialMessageTimeout(registry: AgentRegistry, launchId: string, error: StructuredInitialMessageTimeoutError): Promise<void> {
  const reservation = Object.values(registry.readOnlySnapshot().heldDeliveries)
    .find((delivery) => delivery.clientMessageId === `spawn_${launchId}`);
  if (reservation && reservation.state !== "delivered") {
    await registry.deliveryWrite({ label: "delivery.settle", operationId: reservation.command.operationId },
      () => registry.recordDeliveryOutcome(reservation.id, "delivery-uncertain", error.message));
  }
}

export async function waitForStructuredInitialMessage(
  client: RuntimeHostClient,
  operationId: string,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? INITIAL_MESSAGE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? INITIAL_MESSAGE_POLL_MS;
  const deadline = now() + timeoutMs;
  let lastStatus: string | undefined;
  let lastReadError: string | null = null;
  for (;;) {
    let operation: Awaited<ReturnType<RuntimeHostClient["operationStatus"]>> = null;
    try {
      operation = await client.operationStatus(operationId, { currentRetryLeaf: true });
      lastStatus = operation?.receipt.status ?? lastStatus;
      lastReadError = null;
    } catch (error) {
      lastReadError = error instanceof Error ? error.message : "runtime status read failed";
    }
    const status = operation?.receipt.status ?? lastStatus;
    if (status && INITIAL_MESSAGE_DELIVERED.has(status)) return;
    if (status && INITIAL_MESSAGE_FAILED.has(status)) {
      throw new Error(operation?.receipt.reason ?? `structured initial message ended as ${status}`);
    }
    if (now() >= deadline) {
      if (lastReadError) {
        throw new StructuredInitialMessageTimeoutError(`structured initial message status remained unavailable for ${timeoutMs}ms: ${lastReadError}`);
      }
      throw new StructuredInitialMessageTimeoutError(`structured initial message remained ${status ?? "pending"} for ${timeoutMs}ms`);
    }
    await sleep(Math.min(pollMs, deadline - now()));
  }
}

async function structuredSpawnEffectForLaunch(
  client: RuntimeHostClient,
  launchId: string,
  assertActive?: () => void,
): Promise<Record<string, unknown> | null> {
  let afterEventSeq = 0;
  while (true) {
    const batch = await client.effectBatch(["runtime.spawn"], afterEventSeq);
    assertActive?.();
    for (const effect of batch) {
      if (effect.payload.operationId === launchId) return effect.payload;
    }
    if (batch.length < 100) return null;
    const next = Math.max(...batch.map((effect) => effect.eventSeq));
    if (!Number.isSafeInteger(next) || next <= afterEventSeq) {
      throw new Error("structured spawn replay effect page did not advance");
    }
    afterEventSeq = next;
  }
}

interface LaunchReapOptions {
  assertActive?: () => void;
  recoveryFence?: (file: RegistryFile, receipt: SpawnReceipt) => boolean;
  /** The launch operation's journal status as last read, null when unread.
      Only a non-terminal status is failed, and an unread one only when
      `failUnreadOperation` says so. */
  spawnStatus: string | null;
  failUnreadOperation?: boolean;
  releaseHost?: (key: SessionKey) => Promise<boolean>;
  terminateHostProcess?: (expected: ProcessIdentity) => Promise<boolean>;
}

/**
 * Fails one launch and retires what it started: the terminal receipt is
 * claimed first, so a concurrent completion or same-key successor wins
 * atomically and this caller never releases a host it no longer owns; then
 * the runtime operation is failed, and the registered host is released or,
 * failing that, the recorded process is stopped while the row still names it.
 */
async function failStructuredLaunchAndReap(
  launchId: string,
  registry: AgentRegistry,
  client: RuntimeHostClient,
  reason: string,
  options: LaunchReapOptions,
): Promise<{ claimed: boolean; receipt: SpawnReceipt | null }> {
  options.assertActive?.();
  const failure = await registry.failStructuredSpawnOffLoop(launchId, reason, {
    recoveryFence: (file, receipt) => {
      // Lock admission can yield after the evidence read. A retired release
      // must not turn its cancelled observation into a terminal launch.
      options.assertActive?.();
      return options.recoveryFence?.(file, receipt) ?? true;
    },
  });
  if (!failure.claimed) {
    return { claimed: false, receipt: failure.receipt ?? registry.readOnlySnapshot().receipts[launchId] ?? null };
  }
  const spawnStatus = options.spawnStatus;
  if ((spawnStatus === null && options.failUnreadOperation)
    || spawnStatus === "pending" || spawnStatus === "queued" || spawnStatus === "delivering") {
    try {
      await client.transitionOperation(launchId, "failed", { reason });
    } catch (error) {
      spawnDiagnosticErrorFor(failure.receipt?.clientAttemptId, "[spawn] runtime operation failure did not settle during reconciliation", {
        launchId,
        error: structuredSpawnFailureReason(error),
      });
    }
  }
  const cleanup = failure.cleanup;
  if (cleanup) {
    let released = false;
    const entryBeforeRelease = registry.readOnlySnapshot().entries[sessionKeyId(cleanup.key)];
    if (cleanup.releaseRegisteredHost && entryBeforeRelease?.structuredHostOperationId === launchId) {
      try {
        released = await (options.releaseHost ?? releaseStructuredDeliveryHost)(cleanup.key);
      } catch (error) {
        spawnDiagnosticErrorFor(failure.receipt?.clientAttemptId, "[spawn] registered host release failed during reconciliation", {
          launchId,
          error: structuredSpawnFailureReason(error),
        });
      }
    }
    if (!released && cleanup.process) {
      const entryBeforeTermination = registry.readOnlySnapshot().entries[sessionKeyId(cleanup.key)];
      const stillOwned = cleanup.releaseRegisteredHost
        ? entryBeforeTermination?.structuredHostOperationId === launchId
        : entryBeforeTermination?.structuredHostOperationId == null
          && entryBeforeTermination.artifactPath === failure.receipt?.artifactPath
          && entryBeforeTermination.status === "dead"
          && entryBeforeTermination.claimOwner === null;
      if (stillOwned) {
        try {
          const terminated = await (options.terminateHostProcess ?? terminateVerifiedStructuredSpawnProcess)(cleanup.process);
          if (!terminated && cleanup.process.pid !== process.pid) {
            spawnDiagnosticErrorFor(failure.receipt?.clientAttemptId, "[spawn] staged host termination remained unconfirmed", {
              launchId,
              pid: cleanup.process.pid,
            });
          }
        } catch (error) {
          spawnDiagnosticErrorFor(failure.receipt?.clientAttemptId, "[spawn] staged host termination failed during reconciliation", {
            launchId,
            error: structuredSpawnFailureReason(error),
          });
        }
      }
    }
  }
  return { claimed: true, receipt: registry.readOnlySnapshot().receipts[launchId] ?? null };
}

export async function reconcileStructuredSpawnReplay(
  launchId: string,
  registry: AgentRegistry,
  client: RuntimeHostClient,
  options: {
    now?: () => number;
    timeoutMs?: number;
    releaseHost?: (key: SessionKey) => Promise<boolean>;
    terminateHostProcess?: (expected: ProcessIdentity) => Promise<boolean>;
    drainError?: (conversationId: string) => string | null;
    /** One startup pass may share historical identity evidence across failed
        receipts. Pending launches always read fresh state below. Live writer
        claims are still merged atomically by recoverStructuredSpawnFromEvidence. */
    failedReceiptSnapshot?: () => Promise<RuntimeSnapshot>;
    signal?: AbortSignal;
    assertActive?: () => void;
  } = {},
): Promise<SpawnReceipt & { initialMessage: "pending" | "queued" | "delivered" | "failed" }> {
  const assertActive = () => { options.signal?.throwIfAborted(); options.assertActive?.(); };
  assertActive();
  if (options.signal) client = withRuntimeRecoveryReads(client, options.signal);
  const evidenceOrNull = async <T>(read: Promise<T>): Promise<T | null> => {
    try { return await read; }
    catch (error) {
      assertActive();
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
      return null;
    } finally { assertActive(); }
  };
  const current = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
  if (!current) throw new Error("unknown spawn receipt");
  if (stagedLaunchRecovery(current)) {
    const recovered = await recoverStagedStructuredLaunch(launchId, registry, client, {
      now: options.now,
      assertActive,
      reap: { releaseHost: options.releaseHost, terminateHostProcess: options.terminateHostProcess, assertActive },
    });
    assertActive();
    return { ...recovered, initialMessage: recovered.state === "completed" ? "delivered" : "queued" };
  }
  if (current.state === "completed") {
    return { ...current, initialMessage: "delivered" };
  }
  if (current.state === "conflicted") {
    return { ...current, initialMessage: "failed" };
  }
  const [initialOperation, spawnOperation, runtime] = await Promise.all([
    evidenceOrNull(client.operationStatus(`spawn_message_${launchId}`, { currentRetryLeaf: true })),
    evidenceOrNull(client.operationStatus(launchId, { currentRetryLeaf: true })),
    evidenceOrNull(client.readSession
      ? client.readSession({ conversationId: current.conversationId }).then((session) => ({ sessions: session ? [session] : [] }))
      : current.state === "failed" && options.failedReceiptSnapshot
        ? options.failedReceiptSnapshot()
        : client.snapshot()),
  ]);
  assertActive();
  let operation = initialOperation;
  let effectHistoryUnavailable = false;
  if (!operation && current.state === "path-pending" && current.artifactPath) {
    /* Effect history can be unavailable during the same runtime-journal outage
       this replay is meant to bound. Missing evidence remains unconfirmed so
       the normal deadline path can settle the placeholder retry-safely. */
    const effect = await evidenceOrNull(structuredSpawnEffectForLaunch(client, launchId, assertActive).catch(error => {
      assertActive();
      effectHistoryUnavailable = true;
      throw error;
    }));
    assertActive();
    const prompt = typeof effect?.prompt === "string" ? effect.prompt : null;
    const imageRefs = parseStructuredImageRefs(effect?.images ?? [], 16);
    if (
      prompt !== null
      && imageRefs !== null
      && effect?.conversationId === current.conversationId
      && effect.cwd === current.cwd
      && (prompt.trim() || imageRefs.length)
    ) {
      const readmittedOrigin = spawnMessageOrigin(current, registry);
      const readmitted = await enqueueStructuredMessage({
        path: current.artifactPath,
        conversationId: current.conversationId,
        clientMessageId: `spawn_${launchId}`,
        operationId: `spawn_message_${launchId}`,
        launchId,
        text: prompt,
        imageRefs,
        admissionGuard: assertActive,
        ...(readmittedOrigin ? { origin: readmittedOrigin } : {}),
      }, {
        client: () => client,
        registry: () => registry,
        enabled: () => true,
      });
      assertActive();
      if (readmitted?.ok && readmitted.outcome !== "held") {
        operation = await evidenceOrNull(client.operationStatus(`spawn_message_${launchId}`, { currentRetryLeaf: true }));
      }
    }
  }
  const runtimeDelivered = Boolean(operation
    && operation.receipt.conversationId === current.conversationId
    && INITIAL_MESSAGE_DELIVERED.has(operation.receipt.status));
  const sessionMatches = runtime?.sessions.find((candidate) =>
    candidate.conversationId === current.conversationId
    && candidate.sessionKey.engine === current.engine
    && candidate.cwd === current.cwd
    && typeof candidate.artifactPath === "string"
    && (!current.key || sessionKeyId(candidate.sessionKey) === sessionKeyId(current.key))
    && (!current.artifactPath || candidate.artifactPath === current.artifactPath)) ?? null;
  const evidencePath = current.artifactPath ?? sessionMatches?.artifactPath ?? null;
  const transcriptMaterialized = Boolean(evidencePath
    && structuredTranscriptIsReadable(evidencePath));
  const transcriptDelivered = Boolean(evidencePath
    && hasUserAuthoredMessage(evidencePath, current.engine));
  /* A runtime delivery receipt establishes host acceptance. Session identity
     publication waits for transcript-backed persistence evidence. */
  if (transcriptDelivered || (runtimeDelivered && transcriptMaterialized)) {
    const evidence = sessionMatches ? {
      key: sessionMatches.sessionKey,
      artifactPath: sessionMatches.artifactPath!,
      cwd: current.cwd,
      accountId: current.accountId,
      launchProfile: current.launchProfile,
      status: runtimeEntryStatus(sessionMatches),
      host: null,
      structuredHost: isStructuredHostKind(sessionMatches.hostKind)
        ? {
          kind: sessionMatches.hostKind,
          endpoint: "runtime:reconciled",
          process: null,
          eventCursor: sessionMatches.revision,
          protocolVersion: null,
          writerClaimEpoch: 0,
          activeTurnRef: sessionMatches.activeTurnId,
          pendingAttention: sessionMatches.attentionIds,
          activeFlags: [],
        }
        : null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    } : undefined;
    const recovered = (await registry.deliveryWriteOrBusy({ label: "registry.recoverStructuredSpawnFromEvidence" }, registry.recoverStructuredSpawnFromEvidence.bind(registry, launchId, evidence)));
    if (recovered.kind === "settled") {
      return { ...recovered.receipt, initialMessage: "delivered" };
    }
  }
  const messageStatus = operation?.receipt.status;
  const runtimeSession = runtime?.sessions.find((candidate) => candidate.conversationId === current.conversationId
    && candidate.cwd === current.cwd
    && (!current.key || sessionKeyId(candidate.sessionKey) === sessionKeyId(current.key))) ?? null;
  const liveRuntimeSession = runtimeSession
    && (runtimeSession.host === "registering"
      || runtimeSession.host === "hosted"
      || runtimeSession.host === "recovering")
    ? runtimeSession
    : null;
  const operationStartedAt = operation ? Date.parse(operation.receipt.at) : Number.NaN;
  const stageStartedAt = Number.isFinite(operationStartedAt) ? operationStartedAt : Date.parse(current.createdAt);
  const ageMs = (options.now ?? Date.now)() - stageStartedAt;
  /* The five-minute ceiling is the spawn caller's durable setup contract. It
     covers host start, first-message delivery, and transcript publication as
     one bounded operation; the 30-second delivery-status poll is not reused as
     a session-creation verdict. */
  const timeoutMs = options.timeoutMs ?? STRUCTURED_SPAWN_DURABLE_SETUP_TIMEOUT_MS;
  let terminalReason = failedOperationReason(operation, "structured initial message")
    ?? failedOperationReason(spawnOperation, "structured spawn");
  if (!terminalReason && ageMs >= timeoutMs) {
    if (liveRuntimeSession && messageStatus === "queued") {
      const drainError = (options.drainError ?? structuredDeliveryLastError)(current.conversationId)
        ?? operation?.receipt.reason
        ?? `no delivery drain error was recorded before the ${timeoutMs}ms deadline`;
      terminalReason = `first message never drained: ${drainError}`;
    } else if (runtimeDelivered) {
      terminalReason = `structured spawn startup reached its ${timeoutMs}ms durable setup bound with no readable transcript after confirmed first-message delivery`;
    } else if (liveRuntimeSession) {
      terminalReason = `structured spawn durable setup remained incomplete for ${timeoutMs}ms`;
    } else if (effectHistoryUnavailable) {
      terminalReason = `structured spawn runtime effect history remained unavailable for ${timeoutMs}ms`;
    } else if (runtime) {
      terminalReason = `structured spawn runtime snapshot has no session after ${timeoutMs}ms`;
    } else {
      terminalReason = `structured spawn durable setup remained unconfirmed for ${timeoutMs}ms`;
    }
  }
  if (terminalReason) {
    const failure = await failStructuredLaunchAndReap(launchId, registry, client, terminalReason.slice(0, 240), {
      spawnStatus: spawnOperation?.receipt.status ?? null,
      releaseHost: options.releaseHost,
      terminateHostProcess: options.terminateHostProcess,
      assertActive,
    });
    if (!failure.claimed) {
      const settled = failure.receipt ?? current;
      return {
        ...settled,
        initialMessage: settled.state === "completed" ? "delivered" : "failed",
      };
    }
    return { ...(failure.receipt ?? current), initialMessage: "failed" };
  }
  const receipt = registry.spawnRecoverySnapshot([launchId]).receipts[launchId] ?? current;
  return {
    ...receipt,
    initialMessage: reconciledInitialMessage(receipt, messageStatus, runtimeDelivered),
  };
}

/* Foreground setup and the reaper share one five-minute ceiling. Transcript
   publication belongs to that complete startup contract; the shorter
   first-message status poll has no authority over session materialization. */
export const STALE_STRUCTURED_SPAWN_TIMEOUT_MS = STRUCTURED_SPAWN_DURABLE_SETUP_TIMEOUT_MS;
export const STALE_STRUCTURED_SPAWN_ACTUATION_CAP = 50;

function queuedPinnedSpawnForReceipt(receipt: SpawnReceipt): NonNullable<SpawnReceipt["queuedPinnedSpawn"]> | null {
  const queued = receipt.queuedPinnedSpawn;
  const recoverableTransportState = receipt.transport === "structured"
    ? receipt.state === "starting" && !receipt.key && !receipt.pane
    : receipt.transport === "tmux"
      && !receipt.key
      && ((receipt.state === "starting" && !receipt.pane)
        || ((receipt.state === "pane-bound" || receipt.state === "host-verified") && Boolean(receipt.pane)));
  return recoverableTransportState
    && receipt.purpose === "launch"
    && receipt.accountPin
    && Boolean(receipt.accountId)
    && queued?.accountId === receipt.accountId
    && queued.spec.engine === receipt.engine
    && queued.spec.cwd === receipt.cwd
    ? queued
    : null;
}

export interface StructuredSpawnRecoveryOptions {
  signal?: AbortSignal;
  /** Boot leaves terminal reporting to the controller's bounded repair pass. */
  repairFailures?: boolean;
  /** Startup reconciles receipts; the controller owns full queued host setup. */
  actuateQueuedSpawns?: boolean;
  reportProgress?: (progress: { examined: number; total: number; completed: number; deferred: number }) => void | Promise<void>;
  assertActive?: () => void;
  now?: () => number;
  timeoutMs?: number;
  actuationCap?: number;
  resolveSpawnAccount?: (engine: "claude" | "codex" | "copilot", accountId: string | null) => AccountContext;
  resolvePinnedSpawnAdmission?: (engine: "claude" | "codex" | "copilot", account: AccountContext) => Promise<SpawnAccountAdmission>;
  spawnStructuredConversation?: typeof spawnStructuredConversation;
  spawnTmuxAgent?: typeof spawnAgentWithPrompt;
  publishFilesRevision?: typeof publishFilesRevision;
  /** Recovery-only override for isolated admission fixtures. */
  curationSources?: SeatTickSources;
}

async function curatorReceiptAdmission(receipt: SpawnReceipt, registry: AgentRegistry, sources?: SeatTickSources): Promise<() => void> {
  if (receipt.agentRole !== "curator") return () => {};
  const [{ curatorRecoveryGuard }, { defaultSeatTickAdmissionSources }] = await Promise.all([
    import("@/lib/memory/curation/admission"), import("@/lib/monitor/seatTickAdmissionSources"),
  ]);
  return curatorRecoveryGuard(receipt.conversationId, {
    ...(sources ?? defaultSeatTickAdmissionSources()), registry: () => registry,
  });
}

async function failQueuedPinnedSpawn(
  registry: AgentRegistry,
  receipt: SpawnReceipt,
  reason: string,
): Promise<SpawnReceipt> {
  if (receipt.transport === "structured") {
    return (await registry.failStructuredSpawnOffLoop(receipt.launchId, reason)).receipt ?? receipt;
  }
  await registry.failSpawnOffLoop(receipt.launchId, reason);
  return registry.readOnlySnapshot().receipts[receipt.launchId] ?? receipt;
}

async function actuateQueuedPinnedSpawn(
  registry: AgentRegistry,
  client: RuntimeHostClient | null,
  receipt: SpawnReceipt,
  options: StructuredSpawnRecoveryOptions,
): Promise<SpawnReceipt> {
  const queued = queuedPinnedSpawnForReceipt(receipt);
  const admittedAuthority = readHotStateAuthority(path.dirname(registry.filename));
  const assertActive = () => {
    options.signal?.throwIfAborted();
    options.assertActive?.();
    const authority = readHotStateAuthority(path.dirname(registry.filename));
    if (!viewerReleaseOwnsTraffic() || authority?.mode === "fencing"
      || authority?.epoch !== admittedAuthority?.epoch || authority?.releaseRevision !== admittedAuthority?.releaseRevision) {
      throw new Error("queued launch lost Viewer release authority");
    }
  };
  assertActive();
  const currentTime = (options.now ?? Date.now)();
  if (!queued || Date.parse(queued.retryAt) > currentTime) return receipt;
  if (!ownerRelaySpawnAuthorized(receipt.clientAttemptId))
    return failQueuedPinnedSpawn(registry, receipt, "owner relay queued launch authorization revoked");
  let curatorAuthorize: () => void;
  try {
    curatorAuthorize = await curatorReceiptAdmission(receipt, registry, options.curationSources);
    assertActive();
    curatorAuthorize();
  } catch (error) {
    assertActive();
    return failQueuedPinnedSpawn(registry, receipt, structuredSpawnFailureReason(error));
  }
  const admissionClaim = receipt.transport === "tmux"
    ? (await registry.deliveryWriteOrBusy({ label: "registry.claimTmuxSpawnActuation" }, registry.claimTmuxSpawnActuation.bind(registry, receipt.launchId)))
    : (await registry.deliveryWriteOrBusy({ label: "registry.claimStartingStructuredSpawn" }, registry.claimStartingStructuredSpawn.bind(registry, receipt.launchId)));
  if (!admissionClaim.claimed || !admissionClaim.receipt.admissionOwner) return admissionClaim.receipt;
  const releaseIfCancelled = async () => {
    try { assertActive(); }
    catch (error) {
      await registry.deliveryWrite({ label: "spawn.queued-cancel", operationId: receipt.launchId }, () =>
        registry.releaseSpawnActuation(receipt.launchId, admissionClaim.receipt.admissionOwner!));
      throw error;
    }
  };
  const claimedQueue = queuedPinnedSpawnForReceipt(admissionClaim.receipt);
  if (!claimedQueue) {
    return failQueuedPinnedSpawn(registry, admissionClaim.receipt, "queued pinned spawn lost its durable admission payload");
  }
  /* This is the receipt's first execution: the queue held it before any
     process existed. Its task membership (#1586) is a prerequisite of that
     execution the same way it is at reservation — a receipt queued before the
     rule, or whose task was deleted while it waited, is bound now, and a store
     that cannot record the membership fails the launch instead of starting an
     agent outside every task. */
  try {
    await registry.admitRecoveredLaunch(admissionClaim.receipt);
  } catch (error) {
    await releaseIfCancelled();
    return failQueuedPinnedSpawn(registry, admissionClaim.receipt, structuredSpawnFailureReason(error));
  }
  await releaseIfCancelled();
  let account: AccountContext;
  let admission: SpawnAccountAdmission;
  try {
    account = (options.resolveSpawnAccount
      ?? ((engine, accountId) => accountManager.resolveSpawn(engine, accountId)))(receipt.engine, claimedQueue.accountId);
    if (account.engine !== receipt.engine || account.accountId !== claimedQueue.accountId) {
      throw new Error("queued pinned spawn resolved a different account");
    }
    admission = receipt.transport === "tmux" && Boolean(admissionClaim.receipt.pane)
      ? { kind: "admissible", basis: "current", stale: false, retryAt: null }
      : await (options.resolvePinnedSpawnAdmission ?? resolvePinnedSpawnAdmission)(receipt.engine, account);
  } catch (error) {
    await releaseIfCancelled();
    try { curatorAuthorize(); }
    catch (curationError) { error = curationError; }
    return failQueuedPinnedSpawn(registry, admissionClaim.receipt, structuredSpawnFailureReason(error));
  }
  await releaseIfCancelled();
  try { curatorAuthorize(); }
  catch (error) { return failQueuedPinnedSpawn(registry, admissionClaim.receipt, structuredSpawnFailureReason(error)); }
  if (admission.kind === "retry-at") {
    const nextRetryMs = Date.parse(admission.retryAt);
    if (!Number.isFinite(nextRetryMs) || nextRetryMs <= currentTime) {
      return failQueuedPinnedSpawn(registry, admissionClaim.receipt, "pinned account retry deadline did not advance");
    }
    const nextRetryAt = new Date(nextRetryMs).toISOString();
    const refreshed = (await registry.deliveryWriteOrBusy({ label: "registry.queuePinnedSpawn" }, registry.queuePinnedSpawn.bind(registry, receipt.launchId, {
      ...claimedQueue,
      retryAt: nextRetryAt,
    }, queuedPinnedSpawnTitle(claimedQueue.locale, nextRetryAt))));
    return refreshed.admissionOwner
      ? (await registry.deliveryWriteOrBusy({ label: "registry.releaseSpawnActuation" }, registry.releaseSpawnActuation.bind(registry, refreshed.launchId, refreshed.admissionOwner))).receipt
      : refreshed;
  }
  if (admission.kind === "unavailable") {
    return failQueuedPinnedSpawn(
      registry,
      admissionClaim.receipt,
      `pinned account is unavailable: ${admission.reason}`,
    );
  }
  if (!ownerRelaySpawnAuthorized(receipt.clientAttemptId))
    return failQueuedPinnedSpawn(registry, admissionClaim.receipt, "owner relay queued launch authorization revoked");
  let response: SpawnResponse | null = null;
  let tmuxImagePaths: string[] = [];
  try {
    if (receipt.transport === "tmux") {
      await releaseIfCancelled();
      curatorAuthorize();
      const images = claimedQueue.imageRefs.length
        ? (() => {
            const imageStore = runtimeImageStore();
            return claimedQueue.imageRefs.map((ref) => ({
              base64: imageStore.read(ref).toString("base64"),
              mime: ref.mime,
            }));
          })()
        : [];
      const bundle = buildImagePayload(claimedQueue.prompt, images);
      tmuxImagePaths = bundle.imagePaths;
      assertActive();
      await (options.spawnTmuxAgent ?? spawnAgentWithPrompt)(
        claimedQueue.spec,
        bundle.payload,
        admissionClaim.receipt,
      );
      assertActive();
      const launched = registry.readOnlySnapshot().receipts[receipt.launchId];
      if (launched?.state === "prompt-delivered" || launched?.state === "host-verified") {
        (await registry.deliveryWriteOrBusy({ label: "registry.markSpawnPathPending" }, registry.markSpawnPathPending.bind(registry, receipt.launchId)));
      }
    } else {
      if (!client) {
        throw new Error(supervisedRuntimeHostUnavailableReason("structured spawn runtime host"));
      }
      assertActive();
      response = await (options.spawnStructuredConversation ?? spawnStructuredConversation)({
        engine: receipt.engine,
        receipt: admissionClaim.receipt,
        spec: claimedQueue.spec,
        account,
        ["prompt"]: claimedQueue.prompt,
        imageRefs: claimedQueue.imageRefs,
        registry,
        client,
        authorize: () => {
          assertActive();
          if (!ownerRelaySpawnAuthorized(receipt.clientAttemptId))
            throw new Error("owner relay queued launch authorization revoked");
          curatorAuthorize();
        },
      });
    }
  } catch (error) {
    if (receipt.transport === "tmux") {
      await registry.failSpawnOffLoop(receipt.launchId, structuredSpawnFailureReason(error));
      const failed = registry.readOnlySnapshot().receipts[receipt.launchId] ?? admissionClaim.receipt;
      if (!failed.pane) deleteInboxImages(tmuxImagePaths);
      if (failed.queuedPinnedSpawn && failed.admissionOwner) {
        return (await registry.deliveryWriteOrBusy({ label: "registry.releaseSpawnActuation" }, registry.releaseSpawnActuation.bind(registry, failed.launchId, failed.admissionOwner))).receipt;
      }
      return failed;
    }
    const current = registry.readOnlySnapshot().receipts[receipt.launchId];
    if (current?.queuedPinnedSpawn && current.admissionOwner) {
      (await registry.deliveryWriteOrBusy({ label: "registry.releaseSpawnActuation" }, registry.releaseSpawnActuation.bind(registry, current.launchId, current.admissionOwner)));
    }
    throw error;
  }
  assertActive();
  if (claimedQueue.parentArtifactPath && response?.path) {
    try {
      rememberHandoffChild(response.path, claimedQueue.parentArtifactPath);
      persistHandoffLineage();
    } catch (error) {
      spawnDiagnosticErrorFor(receipt.clientAttemptId, "[spawn] queued handoff lineage persistence failed", {
        launchId: receipt.launchId,
        conversationId: receipt.conversationId,
        error,
      });
    }
  }
  if (response?.path && client && fs.existsSync(response.path)) {
    try {
      await (options.publishFilesRevision ?? publishFilesRevision)(client);
    } catch (error) {
      spawnDiagnosticErrorFor(receipt.clientAttemptId, "[spawn] queued transcript materialization refresh failed", {
        launchId: receipt.launchId,
        conversationId: receipt.conversationId,
        error,
      });
    }
  }
  return registry.readOnlySnapshot().receipts[receipt.launchId] ?? admissionClaim.receipt;
}

/** Bounded, idempotent convergence for stale non-terminal structured launches
    (#334/#1031): every launch older than the setup bound enters the replay
    reconciler, including rows with a live admission owner, a registering host,
    or a transcript that materialized late. Strong delivery evidence recovers
    the receipt; every other overdue launch settles as retry-safe failure and
    releases its registered host or reaps its verified staged process. Running
    the pass twice is a no-op because terminal receipts are skipped. Held
    deliveries and receipts remain durable.

    The same existing reaper tick actuates a valid queued pin once its durable
    deadline arrives. A future queue stays WAITING, while an incomplete queue
    follows the ordinary setup bound and cannot become immortal. */
export async function terminalizeStaleStructuredSpawns(
  registry: AgentRegistry,
  client: RuntimeHostClient | null,
  options: StructuredSpawnRecoveryOptions & {
    reconcile?: typeof reconcileStructuredSpawnReplay;
  } = {},
): Promise<{ examined: number; terminalized: string[]; recovered: string[] }> {
  const assertActive = () => { options.signal?.throwIfAborted(); options.assertActive?.(); };
  assertActive();
  if (client && options.signal) client = withRuntimeRecoveryReads(client, options.signal);
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? STALE_STRUCTURED_SPAWN_TIMEOUT_MS;
  const actuationCap = options.actuationCap ?? STALE_STRUCTURED_SPAWN_ACTUATION_CAP;
  const reconcile = options.reconcile ?? reconcileStructuredSpawnReplay;
  if (options.repairFailures !== false) {
    options.assertActive?.();
    await registry.deliveryWrite({ label: "spawn.failure-backfill" }, () => {
      options.assertActive?.();
      return registry.backfillFailedLaunchReporting(actuationCap);
    });
    for (const receipt of registry.failedSpawnReceipts(actuationCap)) {
      options.assertActive?.();
      registry.reportFailedLaunch(receipt, { now: now() });
    }
  }
  await registry.deliveryWrite({ label: "spawn.orphan-hygiene" }, () => {
    options.assertActive?.();
    options.signal?.throwIfAborted();
    return registry.terminalizeAbandonedSpawnEntries({ now: now(), timeoutMs, limit: actuationCap });
  });
  const openReceipts = registry.openSpawnReceipts();
  const snapshot = registry.spawnRecoverySnapshot(openReceipts.map(receipt => receipt.launchId));
  const terminalized: string[] = [];
  const recovered: string[] = [];
  let examined = 0;
  for (const receipt of openReceipts) {
    options.assertActive?.();
    if (examined >= actuationCap) break;
    if (receipt.state === "completed" || receipt.state === "failed" || receipt.state === "conflicted") continue;
    const queued = queuedPinnedSpawnForReceipt(receipt);
    if (queued) {
      if (options.actuateQueuedSpawns === false) continue;
      if (Date.parse(queued.retryAt) > now()) continue;
      if (receipt.transport === "structured" && !client) continue;
      examined += 1;
      try {
        const supersededReason = supersededQueuedSpawnReason(snapshot, receipt);
        const recoveredReceipt = supersededReason
          ? await failQueuedPinnedSpawn(registry, receipt, supersededReason)
          : await actuateQueuedPinnedSpawn(registry, client, receipt, options);
        if (recoveredReceipt.state === "failed" || recoveredReceipt.state === "conflicted") terminalized.push(receipt.launchId);
        else if (recoveredReceipt.state === "completed") recovered.push(receipt.launchId);
      } catch (error) {
        spawnDiagnosticErrorFor(receipt.clientAttemptId, "[reaper] queued pinned spawn recovery failed", {
          launchId: receipt.launchId,
          error,
        });
      }
      continue;
    }
    const createdMs = Date.parse(receipt.createdAt);
    if (!stagedLaunchRecovery(receipt) && (!Number.isFinite(createdMs) || now() - createdMs < timeoutMs)) continue;
    if (receipt.transport === "tmux") {
      const ownerlessPreSettlement = receipt.state === "starting"
        && !receipt.key
        && !receipt.pane
        && !receipt.admissionOwner;
      if (!ownerlessPreSettlement) continue;
      examined += 1;
      try {
        await registry.failSpawnOffLoop(
          receipt.launchId,
          `tmux spawn interrupted before durable queue publication or pane binding: ${receipt.launchId}`,
        );
        const failed = registry.readOnlySnapshot().receipts[receipt.launchId];
        if (failed?.state === "failed" || failed?.state === "conflicted") terminalized.push(receipt.launchId);
      } catch (error) {
        spawnDiagnosticErrorFor(receipt.clientAttemptId, "[reaper] stale tmux spawn reconciliation failed", {
          launchId: receipt.launchId,
          error,
        });
      }
      continue;
    }
    if (receipt.transport === null && !receipt.key && !receipt.pane && !receipt.verifiedHost
      && !receipt.admissionOwner && !receipt.queuedPinnedSpawn) {
      if (!client) continue;
      examined += 1;
      try {
        const operation = await client.operationStatus(receipt.launchId);
        assertActive();
        const effect = await structuredSpawnEffectForLaunch(client, receipt.launchId, assertActive);
        assertActive();
        const session = client.readSession
          ? await client.readSession({ conversationId: receipt.conversationId })
          : (await client.snapshot()).sessions.find(candidate => candidate.conversationId === receipt.conversationId);
        assertActive();
        if (operation || effect || session) continue;
        const failure = await registry.failStructuredSpawnOffLoop(receipt.launchId,
          `spawn interrupted before transport or runtime admission: ${receipt.launchId}`, {
            recoveryFence: (_file, current) => {
              assertActive();
              return current.transport === null && !current.key && !current.pane
                && !current.verifiedHost && !current.admissionOwner && !current.queuedPinnedSpawn
                && Number.isFinite(Date.parse(current.createdAt)) && now() - Date.parse(current.createdAt) >= timeoutMs;
            },
          });
        if (failure.claimed) terminalized.push(receipt.launchId);
      } catch (error) {
        assertActive();
        spawnDiagnosticErrorFor(receipt.clientAttemptId,"[reaper] unproven spawn reconciliation failed",{ launchId: receipt.launchId,error });
      }
      continue;
    }
    if (receipt.transport !== "structured") continue;
    if (!client) continue;
    examined += 1;
    try {
      const reconciled = await reconcile(receipt.launchId, registry, client, { now, timeoutMs, assertActive });
      if (reconciled.state === "failed") terminalized.push(receipt.launchId);
      else if (reconciled.state === "completed") recovered.push(receipt.launchId);
    } catch (error) {
      assertActive();
      spawnDiagnosticErrorFor(receipt.clientAttemptId, "[reaper] stale structured spawn reconciliation failed", {
        launchId: receipt.launchId,
        error,
      });
    }
  }
  return { examined, terminalized, recovered };
}

export interface StructuredSpawnInput {
  engine: AgentEngine;
  receipt: SpawnReceipt;
  spec: ResumeSpec;
  account: AccountContext;
  "prompt": string;
  imageRefs?: StructuredImageRef[];
  registry: AgentRegistry;
  client: RuntimeHostClient;
  /** Throws when the caller's owner no longer allows this launch's account.
      Asked again after each async boundary that precedes a side effect: once
      runtime admission returns, before the host starts, and once the host is
      set up, before it is published, by this call or by its staged probe. */
  authorize?: () => void | Promise<void>;
  /** Recovery hands its predecessor fence to the writer this spawn acquires.
      Both callbacks run synchronously beside the claim, before runtime RPC. */
  resumeAdmission?: {
    beforeClaim: () => void;
    claimed: (entry: AgentRegistryEntry) => void;
  };
}

function admittedStructuredLaunchInput(input: StructuredSpawnInput): StructuredSpawnInput {
  const receipt = input.registry.readOnlySnapshot().receipts[input.receipt.launchId];
  if (!receipt) throw new Error("structured spawn receipt is unavailable before launch");
  if (input.spec.launchProfile?.mcpServers.includes("telegram")
    && !receipt.launchProfile.mcpServers.includes("telegram")) {
    throw new Error(TELEGRAM_GRANT_REVOKED_BEFORE_LAUNCH);
  }
  if (receipt.launchProfile.mcpServers.includes("telegram") && receipt.telegramSeatGrant
    && !isCurrentOperatorSeat(receipt.parentConversationId ?? "", input.registry)) {
    throw new Error(TELEGRAM_SEAT_INACTIVE_BEFORE_LAUNCH);
  }
  return { ...input, receipt, spec: { ...input.spec, launchProfile: receipt.launchProfile } };
}

/** Memory preparation yields before native dispatch; a cancelled or changed
    receipt must not open an engine from its earlier options. */
function assertMemoryPreparedStartCurrent(input: StructuredSpawnInput): void {
  const current = admittedStructuredLaunchInput(input).receipt;
  if (["completed", "failed", "conflicted"].includes(current.state)
    || JSON.stringify(current.launchProfile) !== JSON.stringify(input.spec.launchProfile)) {
    throw Error("structured spawn changed during memory preparation");
  }
}

interface HostBinding {
  stopPersistence(): void | Promise<void>;
  unregister(): Promise<void>;
}

const FAILED_SPAWN_OPERATION_STATUSES = new Set([
  "failed",
  "rejected",
  "uncertain",
  "turn-started",
  "steered",
  "interrupted",
  "answered",
]);

async function projectDeadStructuredSpawn(
  client: RuntimeHostClient,
  receipt: SpawnReceipt,
  entry: { accountId: string | null; cwd: string },
  eventKey: string,
  identity?: { key: SessionKey; artifactPath: string },
): Promise<void> {
  const key = identity?.key ?? receipt.key;
  const artifactPath = identity?.artifactPath ?? receipt.artifactPath;
  if (!key || !artifactPath) return;
  await client.append({
    scope: { type: "session", id: receipt.conversationId },
    kind: "session-status",
    producer: {
      kind: runtimeHostKindForEngine(key.engine),
      eventKey,
    },
    payload: {
      conversationId: receipt.conversationId,
      sessionKey: key,
      hostKind: runtimeHostKindForEngine(key.engine),
      host: "dead",
      turn: "idle",
      provenance: "structured",
      accountId: entry.accountId,
      parentConversationId: receipt.parentConversationId,
      cwd: entry.cwd,
      artifactPath,
      capabilities: {
        ...runtimeSteerCapability(key.engine),
        structuredAttention: true,
        imageInput: runtimeImageCapability(key.engine, false),
        runtimeSettings: runtimeSettingsCapability(key.engine),
      },
      activeTurnId: null,
      writerClaim: null,
    },
  });
}

function resumeIdentityForReceipt(
  registry: AgentRegistry,
  receipt: SpawnReceipt,
): { key: SessionKey; artifactPath: string } | null {
  if (receipt.purpose !== "resume-successor") return null;
  const conversation = registry.conversation(receipt.conversationId);
  const source = conversation?.generations.find((generation) => generation.path === receipt.resumeSourcePath)
    ?? conversation?.generations.at(-1);
  return source ? { key: { engine: receipt.engine, sessionId: source.id }, artifactPath: source.path } : null;
}

/** Whether the engine session behind a staged identity actually exists (#1071).
    The only evidence is the transcript the engine writes when it creates the
    session — the same file `claude --resume` reads, so nothing weaker stands in
    for it. A registry row does not qualify: the broker opens its own row and
    emits an idle event the moment a child is spawned, before the CLI has
    created anything, so a promote inside that window would leave an event
    cursor pointing at a session that never existed. */
export function structuredSessionExists(
  identity: { artifactPath: string },
  exists: (candidate: string) => boolean = fs.existsSync,
): boolean {
  return Boolean(identity.artifactPath) && exists(identity.artifactPath);
}

export type StructuredClaudeLaunchForm =
  | { kind: "resume"; sessionId: string }
  | { kind: "fresh"; sessionId: string | undefined };

/** Which Claude CLI form a launch takes. Only a session with existence
    evidence is resumed: rebuilding a never-created session as
    `claude --resume <id>` makes the CLI exit with "No conversation found with
    session ID" and the launch can never succeed, however often it is retried.
    A retried fresh launch therefore re-runs the `--session-id` form under the
    SAME pre-allocated id, so the retry keeps the receipt's durable identity
    (#1071). */
export function structuredClaudeLaunchForm(
  input: Pick<StructuredSpawnInput, "receipt" | "registry" | "spec">,
  exists: (candidate: string) => boolean = fs.existsSync,
): StructuredClaudeLaunchForm {
  const identity = resumeIdentityForReceipt(input.registry, input.receipt);
  if (identity && structuredSessionExists(identity, exists)) {
    return { kind: "resume", sessionId: identity.key.sessionId };
  }
  return {
    kind: "fresh",
    sessionId: identity?.key.sessionId
      ?? (input.spec.transcript ? path.basename(input.spec.transcript, ".jsonl") : undefined),
  };
}

async function releaseAdoptionClaim(
  registry: AgentRegistry,
  claimed: AgentRegistryEntry,
  terminal: boolean,
): Promise<void> {
  if (!claimed.claimOwner || !claimed.structuredHost) return;
  if (terminal) {
    const projected = await registry.deliveryWriteOrBusy({ label: "registry.adoption-release-terminal" }, () => registry.setStructuredHostClaimed(claimed.key, {
      ...claimed.structuredHost!,
      endpoint: "stdio:released",
      process: null,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    }, "dead", claimed.claimOwner!, claimed.claimEpoch, true));
    if (projected) return;
  }
  await registry.deliveryWriteOrBusy({ label: "registry.adoption-release" }, () => registry.releaseStructuredHostClaim(claimed.key, claimed.claimOwner!, claimed.claimEpoch));
}

export interface StructuredSpawnDependencies {
  startHost?(input: StructuredSpawnInput, capability: string): Promise<SpawnedStructuredHost>;
  bindHost?(
    registry: AgentRegistry,
    key: SessionKey,
    host: SpawnedStructuredHost,
    claimOwner: string,
    claimEpoch: number,
    releasedStatus?: "unhosted" | "dead",
  ): Promise<() => void>;
  publishHost?(
    key: SessionKey,
    host: SpawnedStructuredHost,
    ownsOperation?: () => Promise<boolean>,
  ): Promise<() => Promise<void>>;
  deliverFirst?(input: StructuredSpawnInput, artifactPath: string): Promise<void | "held">;
  processIdentity?(): ProcessIdentity;
  durableSetupTimeoutMs?: number;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** Termination ladder seams for the orphan a resume stops (#2790). */
  orphanStop?: StructuredOrphanStopDependencies;
}

/** Why a queued launch from a previous generation must not be replayed, or
    null when it is still a legitimate replay candidate (#1071). Only a launch
    that never reached a live host qualifies, and only against a newer launch
    that demonstrably replaces THIS one. Two relations prove that: the durable
    supersedence edge, which a stage retry and a recovery spawn write naming the
    predecessor conversation, and an identical request digest, which a plain
    resubmission under a fresh idempotency key keeps. The digest alone is not
    enough — a retry that names its predecessor folds that name into its own
    digest, so the replacement's digest differs from the launch it replaces.
    An independent launch into the same working directory matches neither
    relation. Age alone proves nothing here, so a queued launch with no
    replacement keeps its established recovery. */
function supersededQueuedSpawnReason(
  snapshot: RegistryFile,
  receipt: SpawnReceipt,
): string | null {
  if (receipt.transport !== "structured" || receipt.purpose !== "launch") return null;
  if (receipt.state !== "starting" && receipt.state !== "path-pending") return null;
  if (receipt.artifactLifecycle !== "pending") return null;
  const entry = receipt.key ? snapshot.entries[sessionKeyId(receipt.key)] : null;
  if (entry?.structuredHost?.process || entry?.claimOwner) return null;
  const candidates = [
    ...registryRowsMatching(snapshot, "receipts", "supersedes.conversationId", receipt.conversationId),
    ...(receipt.requestDigest ? registryRowsMatching(snapshot, "receipts", "requestDigest", receipt.requestDigest) : []),
  ];
  const replaced = candidates.some((candidate) => {
    if (candidate.launchId === receipt.launchId) return false;
    if (candidate.transport !== "structured" || candidate.purpose !== "launch") return false;
    if (candidate.state === "failed" || candidate.state === "conflicted") return false;
    /* The explicit edge already names the launch it retires, so it carries its
       own direction and needs no timestamp ordering to establish one. */
    if (candidate.supersedes?.conversationId === receipt.conversationId) return true;
    return Boolean(receipt.requestDigest)
      && candidate.requestDigest === receipt.requestDigest
      && candidate.createdAt > receipt.createdAt;
  });
  return replaced
    ? "structured spawn was superseded by a newer launch of the same request"
    : null;
}

const recoveryGlobals = process as typeof process & { __llvSpawnRecoveryCursors?: WeakMap<AgentRegistry, string> };
const spawnRecoveryCursors = recoveryGlobals.__llvSpawnRecoveryCursors ??= new WeakMap<AgentRegistry, string>();

export async function recoverPendingStructuredSpawns(
  registry: AgentRegistry,
  client: RuntimeHostClient,
  options: StructuredSpawnRecoveryOptions = {},
): Promise<void> {
  const deadline = AbortSignal.timeout(20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const assertActive = () => { signal.throwIfAborted(); options.assertActive?.(); };
  client = withRuntimeRecoveryReads(client, signal);
  try {
    await recoverPendingStructuredSpawnPass(registry, client, { ...options, signal, assertActive });
  } catch (error) {
    // The phase budget defers durable work to later passes and the controller.
    // Operator cancellation and loss of release authority still reject boot.
    options.signal?.throwIfAborted();
    options.assertActive?.();
    if (!deadline.aborted) throw error;
  }
}

async function recoverPendingStructuredSpawnPass(
  registry: AgentRegistry,
  client: RuntimeHostClient,
  options: StructuredSpawnRecoveryOptions & { assertActive: () => void },
): Promise<void> {
  const assertActive = options.assertActive;
  const signal = options.signal;
  assertActive();
  await registry.prepareRecoveryIndexes(signal);
  /* Boot reconciliation shares the reaper's bounded contract so placeholders
     admitted by an older process settle before startup replay considers them. */
  await terminalizeStaleStructuredSpawns(registry, client, { ...options, assertActive, repairFailures: false, actuateQueuedSpawns: false });
  assertActive();
  const open = registry.openSpawnReceipts();
  const spawnEffects = new Map<string, Record<string, unknown>>();
  let afterEventSeq = 0;
  let batch = await client.effectBatch(["runtime.spawn"]);
  const activity = await readRuntimeSnapshot(client, "activity");
  assertActive();
  // One scalar watermark bounds the admitted work even while peers append.
  // The phase deadline interrupts reads; unresolved keys remain in the outbox.
  const watermark = activity.snapshotSeq;
  for (;;) {
    assertActive();
    for (const effect of batch) {
      if (effect.eventSeq > watermark) continue;
      const operationId = typeof effect.payload.operationId === "string" ? effect.payload.operationId : null;
      if (operationId) spawnEffects.set(operationId, effect.payload);
    }
    if (batch.length < 100 || batch.some(effect => effect.eventSeq >= watermark)) break;
    const next = Math.max(...batch.map(effect => effect.eventSeq));
    if (!Number.isSafeInteger(next) || next <= afterEventSeq) throw new Error("structured spawn recovery effect page did not advance");
    afterEventSeq = next;
    batch = await client.effectBatch(["runtime.spawn"], afterEventSeq);
  }
  const snapshot = registry.spawnRecoverySnapshot([...open.map(receipt => receipt.launchId), ...spawnEffects.keys()],
    activity.sessions.filter(session => session.host !== "dead").map(session => session.conversationId));

  // Historical failures need one identity snapshot for this pass. Fetching the
  // entire runtime once per failed receipt multiplies startup admission work
  // by both retained histories (#1552). Each receipt still
  // reads its current operations and crosses the registry's atomic settlement.
  // A failed snapshot stays unknown for this pass; it is never an empty snapshot.
  let failedReceiptRuntime: Promise<RuntimeSnapshot> | undefined;
  const failedReceiptSnapshot = () => failedReceiptRuntime ??= client.snapshot();

  let registeringConversationIds: Promise<Set<string>> | undefined;
  const registeringSessions = (): Promise<Set<string>> => registeringConversationIds ??= (async () => {
    const runtime = await client.snapshot().catch(() => null);
    return new Set((runtime?.sessions ?? [])
      .filter((session) => session.host === "registering")
      .map((session) => session.conversationId));
  })();

  const failedGroups = new Map<string, SpawnReceipt[]>();
  for (const receipt of Object.values(snapshot.receipts)) {
    if (receipt.state !== "failed" || receipt.transport === "tmux") continue;
    const id = registry.canonicalConversationId(receipt.conversationId);
    const group = failedGroups.get(id) ?? [];
    group.push(receipt);
    failedGroups.set(id, group);
  }
  await forEachStartupBatch([...failedGroups.values()], async (receipts) => {
    for (const receipt of receipts) {
      assertActive();
      await reconcileFailed(receipt);
    }
  }, assertActive);
  async function reconcileFailed(receipt: SpawnReceipt): Promise<void> {
    const reconciled = await reconcileStructuredSpawnReplay(receipt.launchId, registry, client, { failedReceiptSnapshot, assertActive });
    if (reconciled.state === "completed") return;
    /* The durable launch receipt failed, but its runtime spawn operation can
       survive as queued when the terminal transition itself timed out. The
       placeholder session then sits registering/unknown until someone closes
       the operation; the journal retires the placeholder on that transition. */
    const registering = client.readSession
      ? (await client.readSession({ conversationId: receipt.conversationId }).catch(() => null))?.host === "registering"
      : (await registeringSessions()).has(receipt.conversationId);
    assertActive();
    if (!registering) return;
    const operation = await client.operationStatus(receipt.launchId);
    assertActive();
    const status = operation?.receipt.status;
    if (operation
      && operation.receipt.conversationId === receipt.conversationId
      && (status === "pending" || status === "queued" || status === "delivering")) {
      await client.transitionOperation(receipt.launchId, "failed", {
        reason: (receipt.error ?? "structured spawn failed before runtime acknowledgement").slice(0, 240),
      });
    }
  }
  const ordered = Object.values(snapshot.receipts).sort((a, b) => a.launchId < b.launchId ? -1 : a.launchId > b.launchId ? 1 : 0);
  const cursor = spawnRecoveryCursors.get(registry);
  const next = cursor ? ordered.findIndex(receipt => receipt.launchId > cursor) : 0;
  const selected = next > 0 ? [...ordered.slice(next), ...ordered.slice(0, next)] : ordered;
  let examined = 0;
  let previous: string | undefined;
  const reportRecovery = async () => {
    if (!options.reportProgress) return;
    const current = registry.spawnRecoverySnapshot(selected.map(receipt => receipt.launchId));
    const completed = selected.filter(receipt => ["completed", "failed", "conflicted"].includes(current.receipts[receipt.launchId]?.state ?? "")).length;
    // Deferred identities remain durably pending; examining one never closes it.
    await options.reportProgress({ examined, total: selected.length, completed, deferred: selected.length - completed });
  };
  for (const observed of selected) {
    if (previous) spawnRecoveryCursors.set(registry, previous);
    assertActive();
    if (examined % 16 === 0) await reportRecovery();
    examined += 1;
    await yieldToRuntime();
    assertActive();
    // Commit this cursor only once its observation finishes. The read cut by
    // the deadline gets the first turn in the next pass, under the same keys.
    previous = observed.launchId;
    const fresh = registry.spawnRecoverySnapshot([observed.launchId]);
    const receipt = fresh.receipts[observed.launchId];
    if (!receipt) continue;
    const effect = spawnEffects.get(receipt.launchId);
    /* Re-validate before replay (#1071): a queued launch the previous
       generation accepted is not replayed verbatim by its successor. One whose
       replacement already exists settles as failed here, so a stale
       first-generation launch can never drain into a second builder beside the
       fresh one. A live admission owner does not exempt it: a promote overlaps
       the generations, so the previous container is routinely still running,
       and its deferred execution beside the replacement IS the duplicate the
       issue reports. */
    const supersededReason = supersededQueuedSpawnReason(fresh, receipt);
    if (supersededReason) {
      const stale = await client.operationStatus(receipt.launchId);
      assertActive();
      const failure = await registry.failStructuredSpawnOffLoop(receipt.launchId, supersededReason, {
        recoveryFence: (file, current) => {
          assertActive();
          return supersededQueuedSpawnReason(file, current) === supersededReason;
        },
      });
      if (!failure.claimed) continue;
      const staleStatus = stale?.receipt.status;
      if (staleStatus === "pending" || staleStatus === "queued" || staleStatus === "delivering") {
        await client.transitionOperation(receipt.launchId, "failed", { reason: supersededReason });
      }
      const staged = receipt.key ? snapshot.entries[sessionKeyId(receipt.key)] : null;
      if (staged) {
        await projectDeadStructuredSpawn(client, receipt, staged, `structured-spawn-superseded:${receipt.launchId}`);
      }
      continue;
    }
    if (receipt.state === "failed" && receipt.transport !== "tmux") continue;
    if (queuedPinnedSpawnForReceipt(receipt)) continue;
    if (receipt.state === "starting" && !receipt.key && receipt.transport !== "tmux") {
      // A recent pre-identity launch with a live admission owner cannot be
      // terminalized by startingRecovery. Its owner retains responsibility.
      const createdAt = Date.parse(receipt.createdAt);
      if (receipt.admissionOwner && processIdentityStatus(receipt.admissionOwner) !== "dead"
        && (!Number.isFinite(createdAt) || (options.now ?? Date.now)() - createdAt < (options.timeoutMs ?? STALE_STRUCTURED_SPAWN_TIMEOUT_MS))) continue;
      const operation = await client.operationStatus(receipt.launchId);
      if (receipt.transport !== "structured" && !effect && !operation) continue;
      let reason: string;
      if (operation?.receipt.status === "queued" || operation?.receipt.status === "pending" || operation?.receipt.status === "delivering") {
        reason = `structured spawn interrupted before identity staging: ${receipt.launchId}`;
      } else if (!operation) {
        reason = `structured spawn interrupted before runtime admission: ${receipt.launchId}`;
      } else {
        reason = operation.receipt.reason
          ?? `structured spawn operation ended as ${operation.receipt.status} before identity staging`;
      }
      assertActive();
      const failure = await registry.failStructuredSpawnOffLoop(receipt.launchId, reason, {
        recoveryFence: () => { assertActive(); return true; },
        startingRecovery: {
          now: (options.now ?? Date.now)(),
          timeoutMs: options.timeoutMs ?? STALE_STRUCTURED_SPAWN_TIMEOUT_MS,
        },
      });
      if (!failure.claimed) continue;
      if (operation?.receipt.status === "queued" || operation?.receipt.status === "pending" || operation?.receipt.status === "delivering") {
        await client.transitionOperation(receipt.launchId, "failed", { reason });
      }
      const identity = resumeIdentityForReceipt(registry, failure.receipt ?? receipt);
      let claimed: AgentRegistryEntry | null = null;
      if (identity) {
        const entry = registry.readOnlySnapshot().entries[sessionKeyId(identity.key)];
        if (entry?.structuredHost) {
          claimed = (await registry.deliveryWriteOrBusy({ label: "registry.claimStructuredHost" }, registry.claimStructuredHost.bind(registry, identity.key, captureProcessIdentity(process.pid), { allowUnhosted: true })));
          if (!claimed?.claimOwner) continue;
        }
        try {
          await projectDeadStructuredSpawn(
            client,
            receipt,
            entry ?? { accountId: receipt.accountId, cwd: receipt.cwd },
            `structured-spawn-failed:${receipt.launchId}`,
            identity,
          );
        } catch (error) {
          if (claimed) await releaseAdoptionClaim(registry, claimed, false);
          throw error;
        }
        if (claimed) await releaseAdoptionClaim(registry, claimed, true);
      }
      continue;
    }
    const createdAt = Date.parse(receipt.createdAt);
    if (receipt.admissionOwner && processIdentityStatus(receipt.admissionOwner) !== "dead"
      && (!Number.isFinite(createdAt) || (options.now ?? Date.now)() - createdAt < (options.timeoutMs ?? STALE_STRUCTURED_SPAWN_TIMEOUT_MS))) continue;
    if (stagedLaunchRecovery(receipt)) {
      await recoverStagedStructuredLaunch(receipt.launchId, registry, client, { assertActive, reap: { assertActive } });
      continue;
    }
    if (receipt.state !== "path-pending" || !receipt.key || !receipt.artifactPath) continue;
    const entry = snapshot.entries[sessionKeyId(receipt.key)];
    const operation = await client.operationStatus(receipt.launchId);
    assertActive();
    const status = operation?.receipt.status;
    if (status && FAILED_SPAWN_OPERATION_STATUSES.has(status)) {
      const stagedByAnotherOperation = typeof entry?.structuredHostOperationId === "string"
        && entry.structuredHostOperationId !== receipt.launchId;
      if (stagedByAnotherOperation) {
        await registry.failSpawnOffLoop(
          receipt.launchId,
          operation?.receipt.reason ?? `structured spawn operation ended as ${status}`,
          assertActive,
        );
        continue;
      }
      const ownedByFailedOperation = entry?.structuredHostOperationId === receipt.launchId
        || (entry?.structuredHostOperationId === undefined && entry?.pendingAction === "spawn");
      let recoveryClaim: AgentRegistryEntry | null = null;
      let releasedOwnedHost = false;
      if (entry?.structuredHost && !ownedByFailedOperation) {
        recoveryClaim = (await registry.deliveryWriteOrBusy({ label: "registry.claimStructuredHost" }, registry.claimStructuredHost.bind(registry, receipt.key, captureProcessIdentity(process.pid), { allowUnhosted: true })));
        if (!recoveryClaim?.claimOwner) {
          await registry.failSpawnOffLoop(
            receipt.launchId,
            operation?.receipt.reason ?? `structured spawn operation ended as ${status}`,
            assertActive,
          );
          continue;
        }
      }
      try {
        const releasedHost = await releaseStructuredDeliveryHost(receipt.key);
        releasedOwnedHost = ownedByFailedOperation && releasedHost;
        if (entry?.structuredHost && ownedByFailedOperation && !releasedHost) {
          recoveryClaim = (await registry.deliveryWriteOrBusy({ label: "registry.claimStructuredHost" }, registry.claimStructuredHost.bind(registry, receipt.key, captureProcessIdentity(process.pid), { allowUnhosted: true })));
          if (!recoveryClaim?.claimOwner) {
            throw new Error(`structured spawn failed host is still owned for ${receipt.launchId}`);
          }
        }
        if (entry) await projectDeadStructuredSpawn(
          client,
          receipt,
          entry,
          `structured-spawn-failed:${receipt.launchId}`,
        );
      } catch (error) {
        const failedClaim = recoveryClaim ?? (releasedOwnedHost ? entry : null);
        if (failedClaim) await releaseAdoptionClaim(registry, failedClaim, false);
        throw error;
      }
      await registry.failStructuredSpawnOffLoop(
        receipt.launchId,
        operation?.receipt.reason ?? `structured spawn operation ended as ${status}`,
        { recoveryFence: () => { assertActive(); return true; } },
      );
      continue;
    }
    if (status === "delivered") {
      /* A prior process may have written the runtime receipt before its
         registry settlement. Publish that staged identity only when the
         session artifact still supplies the persistence evidence. */
      if (!structuredTranscriptIsReadable(receipt.artifactPath)) continue;
      const hostReady = entry?.structuredHost?.process
        && entry.claimOwner
        && entry.status !== "dead"
        && entry.status !== "unhosted";
      if (hostReady) {
        const finalized = (await registry.deliveryWriteOrBusy({ label: "registry.finalizeStructuredSpawn" }, registry.finalizeStructuredSpawn.bind(registry, receipt.launchId)));
        if (finalized.kind === "conflict") throw new Error(`structured spawn recovery conflict: ${finalized.code}`);
      } else {
        if (!entry) throw new Error(`structured spawn recovery identity is unavailable for ${receipt.launchId}`);
        await releaseStructuredDeliveryHost(receipt.key);
        await projectDeadStructuredSpawn(
          client,
          receipt,
          entry,
          `structured-spawn-delivered-host-dead:${receipt.launchId}`,
        );
        assertActive();
        const settled = (await registry.deliveryWriteOrBusy({ label: "registry.recoverDeliveredStructuredSpawn" }, registry.recoverDeliveredStructuredSpawn.bind(registry, receipt.launchId)));
        if (settled.kind === "conflict") throw new Error(`structured spawn recovery conflict: ${settled.code}`);
      }
      continue;
    }
    if (!entry?.structuredHost || entry.status === "dead" || entry.status === "unhosted") continue;
    const prompt = typeof effect?.prompt === "string" ? effect.prompt : null;
    const imageRefs = parseStructuredImageRefs(effect?.images ?? [], 16);
    if (prompt === null || effect?.conversationId !== receipt.conversationId || effect?.cwd !== receipt.cwd) {
      throw new Error(`structured spawn recovery is missing durable prompt admission for ${receipt.launchId}`);
    }
    if (imageRefs === null) throw new Error(`structured spawn recovery has invalid image refs for ${receipt.launchId}`);
    if (prompt.trim() || imageRefs.length) {
      const origin = spawnMessageOrigin(receipt, registry);
      const delivered = await enqueueStructuredMessage({
        path: receipt.artifactPath,
        conversationId: receipt.conversationId,
        clientMessageId: `spawn_${receipt.launchId}`,
        operationId: `spawn_message_${receipt.launchId}`,
        launchId: receipt.launchId,
        text: prompt,
        imageRefs,
        admissionGuard: assertActive,
        ...(origin ? { origin } : {}),
      }, {
        client: () => client,
        registry: () => registry,
        enabled: () => true,
      });
      assertActive();
      if (!delivered?.ok) throw new Error(delivered?.error ?? `structured spawn recovery could not admit ${receipt.launchId}`);
      if (delivered.outcome === "held") continue;
      if (delivered.outcome !== "delivered") {
        // Durable admission is sufficient for boot. The delivery controller
        // owns transcript publication and settlement under the original key.
        continue;
      }
    }
    /* Delivery acceptance can precede lazy Codex rollout creation. Keep the
       receipt staged so replay exposes no identity while the host is live. */
    if (!structuredTranscriptIsReadable(receipt.artifactPath)) continue;
    await client.transitionOperation(receipt.launchId, "delivered");
    assertActive();
    const finalized = (await registry.deliveryWriteOrBusy({ label: "registry.finalizeStructuredSpawn" }, registry.finalizeStructuredSpawn.bind(registry, receipt.launchId)));
    if (finalized.kind === "conflict") throw new Error(`structured spawn recovery conflict: ${finalized.code}`);
  }
  if (previous) spawnRecoveryCursors.set(registry, previous);
  await reportRecovery();
}

function pendingColumns(engine: AgentEngine, eventCursor = 0, writerClaimEpoch = 0): StructuredHostColumns {
  return {
    kind: runtimeHostKindForEngine(engine),
    endpoint: "stdio:pending",
    process: null,
    eventCursor,
    protocolVersion: null,
    writerClaimEpoch,
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
  };
}

function hostIdentity(engine: AgentEngine, host: SpawnedStructuredHost, input: StructuredSpawnInput): { key: SessionKey; path: string } {
  if (engine === "codex") {
    const identity = host.identity as { threadId?: string; path?: string | null };
    if (!identity.threadId) throw new Error("structured Codex spawn returned no thread identity");
    if (!identity.path) throw new Error("structured Codex spawn feature gap: app-server returned no transcript path");
    const key = sessionKey("codex", identity.threadId);
    if (!key) throw new Error("structured Codex spawn returned an invalid thread identity");
    return { key, path: identity.path };
  }
  if (engine === "copilot") {
    const identity = host.identity as { sessionId?: string; path?: string };
    const key = identity.sessionId ? sessionKey("copilot", identity.sessionId) : null;
    if (!key || !identity.path) throw new Error("structured Copilot spawn returned no session identity");
    return { key, path: identity.path };
  }
  const identity = host.identity as { sessionId?: string };
  if (!identity.sessionId) throw new Error("structured Claude spawn returned no session identity");
  const key = sessionKey("claude", identity.sessionId);
  if (!key) throw new Error("structured Claude spawn returned an invalid session identity");
  return {
    key,
    path: input.spec.transcript ?? claudeTranscriptPath(input.spec.cwd, identity.sessionId, input.account.transcriptRoot),
  };
}

export interface StructuredClaudePermissionContext {
  agentInitiated: boolean;
  operatorAuthenticated: boolean;
  roleSpawn: boolean;
}

/** Viewer-managed role launches run autonomously behind prompt and tool
    fences, so a role spawn keeps the full-permission mode regardless of which
    capability lane admitted it; only a role-less agent-initiated spawn loses
    the bypass. */
export function structuredClaudePermissionMode(
  mode: string | null | undefined,
  context: StructuredClaudePermissionContext,
): string {
  if (!mode) return "default";
  if (mode !== "bypassPermissions") return mode;
  return !context.agentInitiated || context.operatorAuthenticated || context.roleSpawn ? mode : "default";
}

export function structuredClaudeSpawnPolicyBaseSettingsPath(
  account: Pick<AccountContext, "kind">,
  sharedSettingsPath: () => string | null = claudeSettingsPath,
): string | null {
  return account.kind === "managed" ? sharedSettingsPath() : null;
}

/**
 * Where one Claude host launch reads its configuration from (#1732).
 *
 * `claudeConfigDir` is what reaches `--mcp-config`. A launch without it is
 * handed a bare `--strict-mcp-config` and no server file at all, so the viewer
 * connector its launch profile granted is dropped without a word and the
 * session's next turn retracts every `mcp__viewer__*` tool as
 * `not_configured`. Boot adoption used to answer this for managed accounts
 * only, which is how a legacy-owned seat re-hosted across its own deploy came
 * back authorised and tool-less while a fresh spawn of the same account kept
 * its connector. Every launch — fresh, boot re-host, migration successor —
 * answers it from the owning account now, whatever its kind.
 */
export function claudeHostLaunchPaths(
  account: Pick<AccountContext, "kind" | "home">,
  sharedSettingsPath: () => string | null = claudeSettingsPath,
): { claudeConfigDir: string; mcpStatePath: string; spawnPolicyBaseSettingsPath: string | null } {
  return {
    claudeConfigDir: account.home,
    /* A managed home keeps its own `.claude.json`; the legacy home's sits
       beside it, one level up. */
    mcpStatePath: account.kind === "managed"
      ? path.join(account.home, ".claude.json")
      : path.join(path.dirname(account.home), ".claude.json"),
    spawnPolicyBaseSettingsPath: structuredClaudeSpawnPolicyBaseSettingsPath(account, sharedSettingsPath),
  };
}

/**
 * The Copilot host options for one launch (docs/design/copilot-engine.md 3.3).
 * Model and effort always come from the durable launch profile, on a fresh
 * start and on a resume alike: CLI 1.0.87 fixes them per process and does not
 * persist effort with the session.
 */
export function copilotHostOptions(
  input: Pick<StructuredSpawnInput, "spec" | "account">,
  access: Pick<StructuredHostAccessMaterialization, "env" | "host">,
  initialEventCursor?: number,
): CopilotAcpHostOptions {
  const profile = input.spec.launchProfile ?? {} as LaunchProfile;
  return {
    binary: resolveCopilotBinary(process.env),
    cwd: input.spec.cwd,
    copilotHome: input.account.home,
    accountId: input.account.accountId,
    model: profile.model ?? undefined,
    effort: profile.effort ?? undefined,
    /* The bypass mode is the only one that grants every tool up front; any
       other profile answers each permission request through attention. */
    allowAll: !launchProfileEngineReadOnly(profile) && (profile.permissionMode ?? "bypassPermissions") === "bypassPermissions",
    allowSubagents: profile.allowSubagents,
    mcpServers: profile.mcpServers,
    ...(access.host.releaseCleanup ? { releaseCleanup: access.host.releaseCleanup } : {}),
    initialEventCursor,
    env: access.env,
  };
}

/**
 * Starts (or, for a resume successor, adopts) the Copilot host of one
 * structured launch. `overrides` is the test seam the gated BYOK integration
 * test uses to add its loopback provider; production passes none.
 */
export async function startCopilotStructuredHost(
  input: StructuredSpawnInput,
  capability: string,
  overrides: Partial<CopilotAcpHostOptions> = {},
): Promise<CopilotAcpHost> {
  const profile = input.spec.launchProfile ?? {} as LaunchProfile;
  const resumeSessionId = structuredResumeSessionId(input);
  const initialEventCursor = resumeSessionId
    ? input.registry.readOnlySnapshot().entries[sessionKeyId({ engine: "copilot", sessionId: resumeSessionId })]?.structuredHost?.eventCursor
    : undefined;
  const access = materializeStructuredHostAccess(structuredHostAccessPolicy(profile), input.account.env, capability);
  const options = { ...copilotHostOptions(input, access, initialEventCursor), ...overrides };
  return resumeSessionId
    ? await CopilotAcpHost.adopt(resumeSessionId, options)
    : await CopilotAcpHost.start(options);
}

/** Production option builder shared by fresh and resumed Claude hosts. */
export async function claudeStructuredHostOptions(
  input: Pick<StructuredSpawnInput, "spec" | "account"> & Partial<Pick<StructuredSpawnInput, "receipt" | "registry">>,
  access: Pick<StructuredHostAccessMaterialization, "env" | "host">,
  initialEventCursor?: number,
  validateTelegramGrant?: () => void,
  agentRole?: string | null,
) {
  const profile = input.spec.launchProfile ?? {} as LaunchProfile;
  const launchPaths = claudeHostLaunchPaths(input.account);
  return {
    cwd: input.spec.cwd,
    claudeProjectsDir: input.account.transcriptRoot,
    ...launchPaths,
    providerAccount: Boolean(input.account.claudeProvider),
    allowSubagents: profile.allowSubagents,
    operatorDecisionForms: operatorDecisionFormsRequired(agentRole, input.spec.transcript),
    cleanMemory: profile.cleanMemory === true,
    appendSystemPrompt: await learnedRulesForLaunchProfile(profile, input.receipt && input.registry ? { engine: "claude", ...memoryStartIdentity(input.registry, input.receipt.conversationId), cwd: input.spec.cwd, home: input.account.home, env: access.env, claudeSettingsPath: launchPaths.spawnPolicyBaseSettingsPath, providerAccount: Boolean(input.account.claudeProvider) } : undefined),
    mcpServers: profile.mcpServers,
    validateTelegramGrant,
    readOnly: launchProfileEngineReadOnly(profile),
    restricted: profile.sandbox === "restricted",
    model: input.account.claudeProvider
      ? profile.model === "haiku" && input.account.claudeProvider.smallFastModel
        ? input.account.claudeProvider.smallFastModel
        : input.account.claudeProvider.model
      : profile.model ?? undefined,
    effort: profile.effort ?? undefined,
    permissionMode: effectiveClaudePermissionMode(profile),
    initialEventCursor,
    env: access.env,
    ...access.host,
  };
}

/**
 * The memory and CPU cell a structured host launches in. A fresh start, a
 * resume, boot adoption and a migration successor all build it here, so a host
 * keeps its class and its controls across restarts. Throws
 * CpuContainmentUnavailable for work that cannot be contained.
 */
export function structuredHostCell(registry: AgentRegistry, engine: string, sessionKey: string, conversationId: ViewerConversationId | null | undefined): AgentMemoryCell | null {
  const snapshot = registry.readOnlySnapshot();
  const liveAgents = Object.values(snapshot.entries).filter((entry) => entry.structuredHost && entry.status !== "dead" && entry.status !== "unhosted").length + 1;
  const cpu = planAgentCpu(workloadForMemberships(conversationId ? snapshot.memberships[registry.canonicalConversationId(conversationId)] : undefined));
  const plan = planAgentMemory({ engine, sessionKey, liveAgents, cpu });
  return plan ? new AgentMemoryCell(plan) : null;
}

/** Narrow external-engine seam for launch-path tests; production passes none. */
export async function defaultStartHost(
  input: StructuredSpawnInput,
  capability: string,
  engineProcess: {
    claude?: Partial<Pick<ClaudeStreamBrokerHostOptions, "spawnProcess" | "readAuthStatus">>;
    codex?: Partial<Pick<CodexAppServerHostOptions, "spawnProcess">>;
  } = {},
): Promise<SpawnedStructuredHost> {
  input = admittedStructuredLaunchInput(input);
  const memoryCell = structuredHostCell(input.registry, input.engine, input.receipt.launchId, input.receipt.conversationId);
  if (input.engine === "copilot") return await startCopilotStructuredHost(input, capability, {
    ...(memoryCell ? { memoryCell } : {}),
  });
  const profile = input.spec.launchProfile ?? {} as LaunchProfile;
  const validateTelegramGrant = profile.mcpServers.includes("telegram")
    ? () => { admittedStructuredLaunchInput(input); }
    : undefined;
  const resumeSessionId = structuredResumeSessionId(input);
  const initialEventCursor = resumeSessionId
    ? input.registry.readOnlySnapshot().entries[sessionKeyId({ engine: input.engine, sessionId: resumeSessionId })]?.structuredHost?.eventCursor
    : undefined;
  if (initialEventCursor !== undefined
    && (!Number.isSafeInteger(initialEventCursor) || initialEventCursor < 0)) {
    throw new Error("structured resume event cursor is invalid");
  }
  const access = materializeStructuredHostAccess(structuredHostAccessPolicy(profile), input.account.env, capability);
  const env = access.env;
  if (input.engine === "codex") {
    const nativeMemoryEnabled = await codexNativeMemoryEnabled(input.account.home, profile.allowSubagents, profile.cleanMemory === true);
    const options = {
      cwd: input.spec.cwd,
      codexHome: input.account.home,
      fileAuthCredentials: input.account.kind === "managed",
      serviceTier: launchServiceTier(profile),
      model: profile.model ?? undefined,
      effort: profile.effort ?? undefined,
      allowSubagents: profile.allowSubagents,
      operatorDecisionForms: operatorDecisionFormsRequired(input.receipt.agentRole, input.receipt.artifactPath ?? input.spec.transcript),
      cleanMemory: profile.cleanMemory === true,
      nativeMemoryEnabled,
      developerInstructions: await learnedRulesForLaunchProfile(profile, { engine: "codex", ...memoryStartIdentity(input.registry, input.receipt.conversationId), cwd: input.spec.cwd, home: input.account.home, env, nativeMemoryEnabled }),
      mcpServers: profile.mcpServers,
      validateTelegramGrant,
      /* Plugin grant from the durable profile (issue #687): present only for
         an operator-launched root session that did not opt out. */
      plugins: profile.plugins,
      ...access.codex,
      ...access.host,
      approvalPolicy: profile.permissionMode ?? undefined,
      initialEventCursor,
      env,
      ...engineProcess.codex,
      ...(memoryCell ? { memoryCell } : {}),
    };
    await input.authorize?.();
    assertMemoryPreparedStartCurrent(input);
    return resumeSessionId
      ? await CodexAppServerHost.adopt(resumeSessionId, options)
      : await CodexAppServerHost.start(options);
  }
  const form = structuredClaudeLaunchForm(input);
  const options = {
    ...await claudeStructuredHostOptions(input, { env, host: access.host }, initialEventCursor, validateTelegramGrant, input.receipt.agentRole),
    ...engineProcess.claude,
    ...(memoryCell ? { memoryCell } : {}),
  };
  await input.authorize?.();
  assertMemoryPreparedStartCurrent(input);
  return form.kind === "resume"
    ? await ClaudeStreamBrokerHost.adopt(form.sessionId, options)
    : await ClaudeStreamBrokerHost.start({ ...options, ...(form.sessionId ? { sessionId: form.sessionId } : {}) });
}

export function structuredResumeSessionId(
  input: Pick<StructuredSpawnInput, "receipt" | "registry">,
): string | null {
  return resumeIdentityForReceipt(input.registry, input.receipt)?.key.sessionId ?? null;
}

async function defaultBindHost(
  registry: AgentRegistry,
  key: SessionKey,
  host: SpawnedStructuredHost,
  claimOwner: string,
  claimEpoch: number,
  releasedStatus: "unhosted" | "dead" = "unhosted",
): Promise<() => void> {
  if (key.engine === "copilot") {
    return await bindCopilotHostPersistence(registry, key, host as CopilotAcpHost, claimOwner, claimEpoch, releasedStatus);
  }
  return key.engine === "codex"
    ? await bindCodexHostPersistence(registry, key, host as CodexAppServerHost, claimOwner, claimEpoch, releasedStatus)
    : await bindClaudeHostPersistence(registry, key, host as ClaudeStreamBrokerHost, claimOwner, claimEpoch, releasedStatus);
}

/**
 * Authorship of a spawn's FIRST message (#1117), from the receipt's recorded
 * delegation depth: 0 is an operator/external root whose prompt the operator
 * typed; a deeper launch was delegated, so its mandate is inter-agent traffic
 * from the parent conversation (named by its role when the registry knows one).
 * Legacy receipts without a depth stay unattributed — the feed must not guess.
 */
function spawnMessageOrigin(receipt: SpawnReceipt, registry: AgentRegistry): MessageOrigin | undefined {
  const membership = registry.readOnlySnapshot().memberships[receipt.conversationId]
    ?.find((entry) => entry.kind === "pipeline" || entry.kind === "flow");
  if (membership) return delegatusMessageOrigin(membership.kind, receipt.explicitProject ?? receipt.launchProfile.project, receipt.cwd);
  if (receipt.delegationDepth === 0) return { kind: "operator" };
  if (receipt.delegationDepth === null || receipt.delegationDepth === undefined) return undefined;
  return agentMessageOrigin(registry.readOnlySnapshot(), receipt.parentConversationId, receipt.parentConversationId
    ? registry.conversation(receipt.parentConversationId)?.agentRole : null);
}

async function defaultDeliverFirst(input: StructuredSpawnInput, artifactPath: string): Promise<void | "held"> {
  if (!input.prompt.trim() && !input.imageRefs?.length) return;
  const origin = spawnMessageOrigin(input.receipt, input.registry);
  const delivered = await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: input.receipt.conversationId,
    clientMessageId: `spawn_${input.receipt.launchId}`,
    operationId: `spawn_message_${input.receipt.launchId}`,
    launchId: input.receipt.launchId,
    text: input.prompt,
    imageRefs: input.imageRefs,
    ...(origin ? { origin } : {}),
  }, {
    client: () => input.client,
    registry: () => input.registry,
    enabled: () => true,
    authorizeDispatch: input.authorize,
  });
  if (!delivered?.ok) {
    const message = delivered?.error ?? "structured spawn first-message delivery was unavailable";
    if (delivered?.transportUncertain) throw new StructuredInitialMessageTimeoutError(message);
    throw new Error(message);
  }
  if (delivered.outcome === "held") return "held";
  if (delivered.outcome !== "delivered") {
    await waitForStructuredInitialMessage(input.client, delivered.operationId);
    await settleInitialMessageReservation(input.registry, input.receipt.launchId);
  }
}

/** The terminal reason a spawned host is already dead before its first message
    landed, or null when the host is still live (or cannot be read, which stays
    recoverable reconciliation work exactly as before). */
async function terminalHostExitReason(host: SpawnedStructuredHost | null): Promise<string | null> {
  if (!host) return null;
  let state: HostState;
  try { state = await host.health(); }
  catch { return null; }
  if (state.status !== "dead") return null;
  return host.terminalExitReason?.() ?? "structured spawn host exited before its first message";
}

async function cleanupHost(host: SpawnedStructuredHost | null, binding: HostBinding): Promise<void> {
  await host?.release();
  let unregisterError: unknown = null;
  try {
    await binding.unregister();
  } catch (error) {
    unregisterError = error;
  }
  await binding.stopPersistence();
  if (unregisterError) throw unregisterError;
}

export { stagedLaunchRecovery, type StagedLaunchRecovery };
export const STAGED_RECOVERY_BUDGET_MS = 10 * 60_000;
export const STAGED_RECOVERY_MAX_CHECKS = 16;
/**
 * How long a resume may take to publish its host (#2028, #2046).
 *
 * A resume re-opens a session that already exists: there is no first message
 * to deliver and no transcript to wait for, only a host to publish. A resume
 * that came back three seconds after the send that raised it, and runtime
 * calls measured near five seconds while a runtime-host handoff settled, both
 * fit well inside a minute. It stays far below the ten-minute settlement
 * window, so a resume that cannot publish is reported as its own failure
 * before the send it carried would be settled as unverified.
 */
export const RESUME_PUBLICATION_BOUND_MS = 60_000;

/**
 * Why a staged launch that no probe will ever advance must end now, or null.
 *
 * Two shapes: a resume still unpublished past its bound, and any recovery
 * stopped or out of budget before it published. Both were only flagged, so
 * their receipt stayed `path-pending` and the row stayed fenced for good
 * (#2028). A pipeline stage's own launch is left to the pipeline engine,
 * which fails it through its stage. Only `unpublished` qualifies: past that
 * phase a first message may have been dispatched.
 */
function unadvanceableStagedLaunch(
  receipt: SpawnReceipt,
  recovery: StagedLaunchRecovery | null,
  pipelineMember: boolean,
  now: number,
): string | null {
  if (!recovery || receipt.state !== "path-pending" || recovery.phase !== "unpublished") return null;
  const resume = receipt.purpose === "resume-successor";
  if (!resume && pipelineMember) return null;
  if (resume && now - recovery.startedAt >= RESUME_PUBLICATION_BOUND_MS) {
    return `host resume did not publish within ${RESUME_PUBLICATION_BOUND_MS / 1_000} s: ${recovery.reason}`;
  }
  if (recovery.stopped || now - recovery.startedAt >= STAGED_RECOVERY_BUDGET_MS || recovery.checks >= STAGED_RECOVERY_MAX_CHECKS) {
    return `${resume ? "host resume" : "launch"} did not publish: ${recovery.reason}`;
  }
  return null;
}

/** A dispatched launch is lookup-only. Once its observation budget ends and
 * every recorded owner is proven gone, it settles from transcript evidence or
 * reports failure. Pipeline attempts retain their engine's recovery policy. */
function lostStagedLaunch(
  file: RegistryFile,
  receipt: SpawnReceipt,
  now: number,
): boolean {
  const recovery = stagedLaunchRecovery(receipt);
  if (receipt.state !== "path-pending" || !recovery || recovery.phase === "unpublished") return false;
  if ((file.memberships[resolveConversationAlias(file, receipt.conversationId)] ?? []).some(member => member.kind === "pipeline")) return false;
  if (!recovery.stopped && now - recovery.startedAt < STAGED_RECOVERY_BUDGET_MS && recovery.checks < STAGED_RECOVERY_MAX_CHECKS) return false;
  if (receipt.admissionOwner && processIdentityStatus(receipt.admissionOwner) !== "dead") return false;
  const entry = receipt.key ? file.entries[sessionKeyId(receipt.key)] : null;
  if (entry?.structuredHost?.process && processIdentityStatus(entry.structuredHost.process) !== "dead") return false;
  if (entry?.claimOwner) {
    const owner = structuredClaimIdentity(entry.claimOwner);
    if (!owner || processIdentityStatus(owner) !== "dead") return false;
  }
  if (entry?.structuredTerminationSurvivors?.some(identity => processIdentityStatus(identity) !== "dead")) return false;
  return true;
}

/**
 * Settles a staged launch that will never publish as failed, and retires the
 * host it started (#2028). The receipt is claimed first, which also clears the
 * row's publication marker when the row names this launch, so the
 * conversation reads `reclaimed` and the next message resumes it cleanly. An
 * idle host of a finished stage loses nothing: its session is in its
 * transcript.
 */
export async function failStagedResume(
  launchId: string,
  registry: AgentRegistry,
  client: RuntimeHostClient,
  reason: string,
  options: Omit<LaunchReapOptions, "spawnStatus" | "failUnreadOperation"> = {},
): Promise<{ claimed: boolean; receipt: SpawnReceipt | null }> {
  const operation = await client.operationStatus(launchId).catch(() => null);
  options.assertActive?.();
  const failed = await failStructuredLaunchAndReap(launchId, registry, client, reason.slice(0, 240), {
    ...options,
    spawnStatus: operation?.receipt.status ?? null,
    failUnreadOperation: true,
  });
  if (failed.claimed) stagedContinuations.delete(launchId);
  return failed;
}
export async function writeStagedRecovery(registry: AgentRegistry, launchId: string, recovery: StagedLaunchRecovery, recoveryFence?: Parameters<AgentRegistry["preserveSpawnArtifactOwnership"]>[2]): Promise<boolean> {
  const observed = registry.spawnRecoverySnapshot([launchId]);
  const receipt = observed.receipts[launchId];
  const entry = receipt?.key ? observed.entries[sessionKeyId(receipt.key)] : null;
  const written = await registry.deliveryWriteOrBusy({ label: "registry.staged-recovery", operationId: launchId }, () =>
    registry.preserveSpawnArtifactOwnership(launchId, STAGED_RECOVERY_PREFIX + JSON.stringify(recovery), (file, latest) => {
      const current = latest.key ? file.entries[sessionKeyId(latest.key)] : null;
      return latest.error === receipt?.error && latest.state === receipt.state
        && current?.claimOwner === entry?.claimOwner && current?.claimEpoch === entry?.claimEpoch
        && (recoveryFence?.(file, latest) ?? true);
    }));
  if (!written && !recoveryFence) {
    const current = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
    if (current?.state === "completed" && current.conversationId === receipt?.conversationId) return true;
    throw new Error("staged launch ownership changed during registry admission");
  }
  return written;
}
export function isTransientStagedLaunchFailure(error: unknown): boolean {
  if (isRuntimeHostTransportFailure(error)) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string; status?: number }).code;
  if (["UNAUTHORIZED", "FORBIDDEN", "INVALID_REQUEST", "AUTH_REQUIRED", "ENOENT", "ECONNREFUSED"].includes(code ?? "")) return false;
  return ["ETIMEDOUT", "ECONNRESET", "EPIPE", "EBUSY", "HOST_BUSY", "RUNTIME_HOST_BUSY", "RUNTIME_HOST_UNAVAILABLE", "runtime-host-unavailable"].includes(code ?? "")
    || (error as Error & { status?: number }).status === 503
    || (error instanceof RuntimeHostUnavailableError && /\b(?:503|busy)\b/i.test(error.message))
    || error instanceof StructuredDeliveryControllerUnavailableError;
}
function stagedRecoveryFailureReason(error: unknown): string {
  return error instanceof Error ? hardenedRedact(error.message).replace(/\s+/g, " ").trim().slice(0, 240) : "runtime recovery failed";
}
type StagedContinuation = {
  host: SpawnedStructuredHost;
  owns: () => Promise<boolean>;
  publish: () => Promise<void>;
  deliver: () => Promise<void | "held">;
};
const stagedStore = process as typeof process & {
  __llvStagedContinuations?: Map<string, StagedContinuation>;
  __llvStagedRecoveryWork?: Map<string, Promise<SpawnReceipt>>;
};
const stagedContinuations = stagedStore.__llvStagedContinuations ??= new Map<string, StagedContinuation>();
const stagedRecoveryWork = stagedStore.__llvStagedRecoveryWork ??= new Map<string, Promise<SpawnReceipt>>();

/** One probe per wake. No sleep, new host, retry operation, or new message id.
 * Only the process holding the staged host can publish or dispatch. Other
 * controllers adopt the completed receipt without actuating this launch. */
export async function recoverStagedStructuredLaunch(
  launchId: string,
  registry: AgentRegistry,
  client: RuntimeHostClient,
  options: { now?: () => number; eligible?: () => boolean; assertActive?: () => void; reap?: Omit<LaunchReapOptions, "spawnStatus" | "failUnreadOperation">; curationSources?: SeatTickSources } = {},
): Promise<SpawnReceipt> {
  options.assertActive?.();
  const inFlight = stagedRecoveryWork.get(launchId);
  if (inFlight) return inFlight;
  const work = async (): Promise<SpawnReceipt> => {
    const read = () => registry.readOnlySnapshot().receipts[launchId]!;
    const receipt = read();
    if (!receipt) throw new Error("unknown staged launch receipt");
    let recovery = stagedLaunchRecovery(receipt);
    const now = options.now ?? Date.now;
    // Foreground setup owns this launch until it explicitly hands recovery
    // back. A different live process cannot race its publication or send.
    if (receipt.admissionOwner && processIdentityStatus(receipt.admissionOwner) !== "dead") return receipt;
    const memberships = registry.readOnlySnapshot().memberships[registry.canonicalConversationId(receipt.conversationId)] ?? [];
    const pipelineMember = memberships.some((membership) => membership.kind === "pipeline");
    /* Before the gates below: a launch that no process can advance is exactly
       the one that must end, whoever holds its host (#2028). */
    const unadvanceable = unadvanceableStagedLaunch(receipt, recovery, pipelineMember, now());
    if (unadvanceable) {
      const failed = await failStagedResume(launchId, registry, client, unadvanceable, { ...options.reap, assertActive: options.assertActive });
      return failed.receipt ?? read();
    }
    if (lostStagedLaunch(registry.readOnlySnapshot(), receipt, now())) {
      if (receipt.artifactPath && hasUserAuthoredMessage(receipt.artifactPath, receipt.engine)) {
        const entry = receipt.key ? registry.readOnlySnapshot().entries[sessionKeyId(receipt.key)] : null;
        const evidence = !entry && receipt.key ? {
          key: receipt.key, artifactPath: receipt.artifactPath, cwd: receipt.cwd ?? "", accountId: receipt.accountId,
          launchProfile: receipt.launchProfile, status: "dead" as const, host: null, structuredHost: null,
          claimEpoch: 0, claimOwner: null, pendingAction: null,
        } : undefined;
        const recovered = (await registry.deliveryWriteOrBusy({ label: "registry.recoverStructuredSpawnFromEvidence" }, registry.recoverStructuredSpawnFromEvidence.bind(registry, launchId, evidence)));
        if (recovered.kind === "settled") stagedContinuations.delete(launchId);
        return read();
      }
      const reason = `lost before its first turn: host exited after first-message dispatch (${recovery!.phase}); no transcript was written; last check: ${recovery!.reason}`;
      const failed = await failStagedResume(launchId, registry, client, reason, {
        ...options.reap,
        assertActive: options.assertActive,
        recoveryFence: (file, current) => current.error === receipt.error
          && current.artifactPath === receipt.artifactPath && lostStagedLaunch(file, current, now())
          && !(current.artifactPath && hasUserAuthoredMessage(current.artifactPath, current.engine)),
      });
      return failed.receipt ?? read();
    }
    // Pipeline launches are advanced only by the engine's outside-lease probe.
    // Startup reconciliation also runs under pipeline admission, and a generic
    // reaper must not dispatch through a paused or replaced attempt.
    if (!options.eligible && pipelineMember) return receipt;
    if (!recovery || receipt.state !== "path-pending" || recovery.stopped || now() < recovery.nextTryAt
      || options.eligible?.() === false) return receipt;
    const continuation = stagedContinuations.get(launchId);
    const host = continuation?.host ?? structuredDeliveryHostForConversation(receipt.conversationId);
    const writer = receipt.key ? registry.readOnlySnapshot().entries[sessionKeyId(receipt.key)] : null;
    // A successor with no local host still observes the original operations.
    // Publication and dispatch continue to require the current writer.
    const ownsHost = Boolean(host && writer?.claimOwner && receipt.key && (continuation ? await continuation.owns()
      : writer.claimOwner === `structured-host:${JSON.stringify(captureProcessIdentity(process.pid))}`));
    options.assertActive?.();
    if (!ownsHost && writer?.claimOwner) {
      const owner = structuredClaimIdentity(writer.claimOwner);
      // A replacement writer can be starting its host while the row retains
      // the previous native process. Its live or unverified claim still owns
      // setup, regardless of that old process's death.
      if (!owner || processIdentityStatus(owner) !== "dead") return receipt;
    }
    // Downtime before the first probe is not sixteen failed checks. Start its
    // bounded observation window once, persisted before the first I/O.
    if (recovery.checks === 0 && now() - recovery.startedAt >= STAGED_RECOVERY_BUDGET_MS) {
      recovery = { ...recovery, startedAt: now() };
    }
    let observedError = receipt.error;
    const matches = (latest: SpawnReceipt | undefined, entry: AgentRegistryEntry | null | undefined) => {
      options.assertActive?.();
      return latest?.state === "path-pending" && latest.conversationId === receipt.conversationId
        && latest.error === observedError
        && (latest.key ? receipt.key && sessionKeyId(latest.key) === sessionKeyId(receipt.key) : !receipt.key)
        && entry?.claimOwner === writer?.claimOwner && entry?.claimEpoch === writer?.claimEpoch
        && (ownsHost ? entry?.structuredHost?.writerClaimEpoch === writer!.claimEpoch : entry?.status === writer?.status)
        && options.eligible?.() !== false;
    };
    const current = () => {
      const snapshot = registry.readOnlySnapshot();
      return matches(snapshot.receipts[launchId], receipt.key ? snapshot.entries[sessionKeyId(receipt.key)] : null);
    };
    const persist = async (value: StagedLaunchRecovery) => {
      // Compare the recovery record and writer inside the transaction: another
      // observer's uncertainty or a replacement writer must win over this read.
      const written = await writeStagedRecovery(registry, launchId, value, (file, latest) => Boolean(matches(latest,
        receipt.key ? file.entries[sessionKeyId(receipt.key)] : null)));
      if (written) observedError = STAGED_RECOVERY_PREFIX + JSON.stringify(value);
      return written;
    };
    const stop = async (reason: string) => {
      await persist({ ...recovery!, stopped: true, reason });
      return read();
    };
    if (now() - recovery.startedAt >= STAGED_RECOVERY_BUDGET_MS || recovery.checks >= STAGED_RECOVERY_MAX_CHECKS) {
      return stop(`runtime host recovery exhausted after ${recovery.checks} checks; original launch and first-message operation inspected; last result: ${recovery.reason}`);
    }
    recovery = { ...recovery, checks: recovery.checks + 1 };
    // Persist the next wake before I/O, so a controller restart cannot reset it.
    recovery.nextTryAt = Math.min(recovery.startedAt + STAGED_RECOVERY_BUDGET_MS,
      now() + Math.min(60_000, 1_000 * 2 ** Math.min(recovery.checks, 6)));
    if (!await persist(recovery)) return read();
    try {
      // Read ORIGINAL ids. A timeout is unknown; it cannot stand in for null.
      const launch = await client.operationStatus(launchId);
      options.assertActive?.();
      const message = await client.operationStatus(`spawn_message_${launchId}`);
      options.assertActive?.();
      if (!current()) return read();
      for (const [id, operation] of [[launchId, launch], [`spawn_message_${launchId}`, message]] as const) {
        if (operation && (operation.receipt.operationId !== id || operation.receipt.conversationId !== receipt.conversationId)) {
          return stop("runtime operation identity conflicts with the staged launch");
        }
      }
      // A successor can observe a message the old controller never recorded.
      // Its presence fences replacement even while its receipt is queued.
      if (message && recovery.phase === "unpublished") {
        recovery = { ...recovery, phase: "uncertain" };
        if (!await persist(recovery)) return read();
      }
      if (launch && FAILED_SPAWN_OPERATION_STATUSES.has(launch.receipt.status)) return stop(launch.receipt.reason ?? `original launch ended as ${launch.receipt.status}`);
      const messageFailure = failedOperationReason(message, "original first message");
      if (messageFailure) return stop(messageFailure);
      if (!launch) throw new RuntimeHostUnavailableError("original launch operation is not visible", "HOST_BUSY");
      const delivered = recovery.phase === "delivered" || (message && INITIAL_MESSAGE_DELIVERED.has(message.receipt.status));
      if (delivered) {
        recovery = { ...recovery, phase: "delivered" };
        if (!await persist(recovery) || !current()) return read();
        if (!receipt.artifactPath || !structuredTranscriptIsReadable(receipt.artifactPath)) return read();
        await client.transitionOperation(launchId, "delivered");
        options.assertActive?.();
        if (!current()) return read();
        const entry = receipt.key ? registry.readOnlySnapshot().entries[sessionKeyId(receipt.key)] : null;
        const live = entry?.structuredHost?.process && entry.claimOwner && entry.status !== "dead" && entry.status !== "unhosted";
        if (!live && (entry?.structuredHost?.process || entry?.claimOwner)) return read();
        const result = (await registry.deliveryWriteOrBusy({ label: "registry.recoverStructuredSpawnFromEvidence" }, registry.recoverStructuredSpawnFromEvidence.bind(registry, launchId)));
        if (result.kind === "conflict") return stop(`staged launch settlement conflict: ${result.code}`);
        stagedContinuations.delete(launchId);
        return read();
      }
      // A send that may have crossed the wire is lookup-only, even when a
      // successful lookup says absent. A delayed request may still arrive.
      if (recovery.phase === "uncertain" || message) {
        await persist({ ...recovery, reason: `original first-message lookup: ${message?.receipt.status ?? "absent; publication remains uncertain"}` });
        return read();
      }
      if (!ownsHost || !host || !receipt.key || !receipt.artifactPath) throw new RuntimeHostUnavailableError("staged host is awaiting its original owner", "HOST_BUSY");
      if (continuation && !await continuation.owns()) return read();
      if (!current()) return read();
      let curatorAuthorize: () => void;
      try {
        curatorAuthorize = await curatorReceiptAdmission(receipt, registry, options.curationSources);
        options.assertActive?.();
        curatorAuthorize();
      } catch (error) {
        return stop(stagedRecoveryFailureReason(error));
      }
      if (continuation) await continuation.publish();
      else await publishStructuredDeliveryHost({ key: receipt.key, host: host as SpawnedStructuredHost }, async () => {
        if (!current()) return false;
        curatorAuthorize();
        return true;
      });
      if (!current() || (continuation && !await continuation.owns())) return read();
      curatorAuthorize();
      if (continuation) {
        // Persist uncertainty immediately before dispatch. A crash at this
        // boundary must never authorize a second first message.
        recovery = { ...recovery, phase: "uncertain" };
        if (!await persist(recovery) || !current()) return read();
        curatorAuthorize();
        const outcome = await continuation.deliver();
        if (current()) {
          recovery = outcome === "held"
            ? { ...recovery, phase: "unpublished", reason: "first message held before dispatch" }
            : { ...recovery, phase: "delivered", reason: "first message delivered; transcript publication pending" };
          await persist(recovery);
        }
      } else {
        const effect = await structuredSpawnEffectForLaunch(client, launchId, options.assertActive);
        if (!effect || effect.conversationId !== receipt.conversationId || effect.cwd !== receipt.cwd) return stop("original launch payload could not be verified");
        const images = parseStructuredImageRefs(effect.images ?? [], 16);
        if (typeof effect.prompt !== "string" || images === null) return stop("original launch payload is invalid");
        if (!current()) return read();
        curatorAuthorize();
        const origin = spawnMessageOrigin(receipt, registry);
        // Payload lookup and validation cannot publish a message. Keep their
        // failures retryable; uncertainty starts only at the dispatch boundary.
        recovery = { ...recovery, phase: "uncertain" };
        if (!await persist(recovery) || !current()) return read();
        curatorAuthorize();
        const result = await enqueueStructuredMessage({ path: receipt.artifactPath, conversationId: receipt.conversationId,
          clientMessageId: `spawn_${launchId}`, operationId: `spawn_message_${launchId}`, launchId, text: effect.prompt, imageRefs: images,
          ...(origin ? { origin } : {}), admissionGuard: () => { options.assertActive?.(); curatorAuthorize(); },
        }, { client: () => client, registry: () => registry, enabled: () => true });
        if (!result?.ok) {
          const reason = result?.error ?? "original first-message admission failed";
          if (result?.transportUncertain) throw new StructuredInitialMessageTimeoutError(reason);
          if (result?.status === 503) throw Object.assign(new Error(reason), { status: 503 });
          throw new Error(reason);
        }
        if (result.outcome === "held" && current()) {
          await persist({ ...recovery, phase: "unpublished", reason: "first message held before dispatch" });
        }
      }
      return read();
    } catch (error) {
      if (!current()) return read();
      if (!isTransientStagedLaunchFailure(error) && !(error instanceof StructuredInitialMessageTimeoutError)) return stop(stagedRecoveryFailureReason(error));
      await persist({ ...recovery, reason: stagedRecoveryFailureReason(error) });
      return read();
    }
  };
  const promise = work();
  stagedRecoveryWork.set(launchId, promise);
  try { return await promise; }
  finally { if (stagedRecoveryWork.get(launchId) === promise) stagedRecoveryWork.delete(launchId); }
}

export async function spawnStructuredConversation(
  input: StructuredSpawnInput,
  dependencies: StructuredSpawnDependencies = {},
): Promise<SpawnResponse> {
  const startHost = dependencies.startHost ?? defaultStartHost;
  const bindHost = dependencies.bindHost ?? defaultBindHost;
  const publishHost = dependencies.publishHost
    ?? ((key, host, ownsOperation) => publishStructuredDeliveryHost({ key, host }, ownsOperation));
  const deliverFirst = dependencies.deliverFirst ?? defaultDeliverFirst;
  const processIdentity = dependencies.processIdentity ?? (() => captureProcessIdentity(process.pid));
  const now = dependencies.now ?? Date.now;
  const admissionRetry = { now, ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}) };
  const operationId = input.receipt.launchId;
  const foregroundAdmissionOwner = input.receipt.admissionOwner;
  const resumeSessionId = structuredResumeSessionId(input);
  const resumeKey = resumeSessionId ? sessionKey(input.engine, resumeSessionId) : null;
  const resumeIdentity = resumeIdentityForReceipt(input.registry, input.receipt);
  let host: SpawnedStructuredHost | null = null;
  const binding: HostBinding = { stopPersistence: () => {}, unregister: async () => {} };
  let key: SessionKey | null = null;
  let forgetUnpublishedHost = () => {};
  let launchReleased = false;
  let adoptionClaim: AgentRegistryEntry | null = null;
  let adoptionClaimTransferred = false;
  let adoptionClaimContended = false;
  let durableSetupTimedOut = false;
  let durableSetupDeadline = 0;
  let materializationPending = false;
  let durableSetupTimer: ReturnType<typeof setTimeout> | null = null;
  let durableSetupTimeout: Promise<never> | null = null;
  const clearDurableSetupTimeout = () => {
    if (durableSetupTimer !== null) clearTimeout(durableSetupTimer);
    durableSetupTimer = null;
    durableSetupTimeout = null;
  };
  const withinDurableSetup = <T>(work: Promise<T>): Promise<T> => {
    if (!durableSetupTimeout) return work;
    return Promise.race([work, durableSetupTimeout]);
  };
  try {
    input = admittedStructuredLaunchInput(input);
    assertSpawnMemoryAvailable();
    const assertResumeSurvivorsRetired = () => {
      if (!resumeKey) return;
      const entry = input.registry.readOnlySnapshot().entries[sessionKeyId(resumeKey)];
      if ((entry?.structuredTerminationSurvivors?.length ?? 0) > 0) {
        throw new Error("structured resume host termination still has live survivors");
      }
    };
    /* Refuse before runtime admission, and repeat after its async boundary.
       A terminal failed spawn can clear structuredHost while its captured
       descendants remain alive; those identities fence every replacement. */
    assertResumeSurvivorsRetired();
    /* Bypass acceptance and project trust are staged in the managed home
       before runtime admission: no structured launch may ever wait at an
       interactive acceptance gate, whichever caller reached this point. */
    if (input.engine === "claude" && input.account.kind === "managed") {
      prepareManagedClaudeSpawnHome(input.account.home, input.spec.cwd);
    }
    const imageRefs = input.imageRefs ?? [];
    const content = input.prompt.trim() || imageRefs.length
      ? structuredContent(input.prompt, imageRefs)
      : null;
    // The journal can accept spawn before its RPC acknowledgement returns.
    // Publish setup ownership before that await so registering work stays live.
    if (resumeKey && resumeIdentity) {
      const claimResume = () => input.registry.deliveryWriteOrBusy({ label: "registry.resume-claim" }, () => {
        assertResumeSurvivorsRetired();
        input.resumeAdmission?.beforeClaim();
        return input.registry.claimStructuredHost(resumeKey, processIdentity(), {
          allowUnhosted: true, setupHost: pendingColumns(input.engine),
          setupEntry: { artifactPath: resumeIdentity.artifactPath, cwd: input.spec.cwd,
            accountId: input.account.accountId, launchProfile: input.spec.launchProfile },
        });
      });
      adoptionClaim = await claimResume();
      /* A terminal row over a live engine process refuses the claim (#2790).
         That process has no stream left and would write beside the resumed
         one, so it and every process it started are stopped by their
         recorded identities and the claim asked once more. A live writer
         claim still keeps it, and a survivor stays captured on the row. */
      if (!adoptionClaim?.claimOwner
        && await stopTerminalStructuredOrphan(input.registry, resumeKey, dependencies.orphanStop)) {
        assertResumeSurvivorsRetired();
        adoptionClaim = await claimResume();
      }
      if (!adoptionClaim?.claimOwner) {
        adoptionClaimContended = true;
        throw new Error("structured resume host claim is unavailable");
      }
      input.resumeAdmission?.claimed(adoptionClaim);
    }
    await withRuntimeAdmissionRetry(() => input.client.command({
      kind: "spawn",
      operationId,
      idempotencyKey: operationId,
      conversationId: input.receipt.conversationId,
      engine: input.engine,
      cwd: input.spec.cwd,
      "prompt": content?.content.text ?? "",
      ...(content?.content.images.length ? { images: content.content.images } : {}),
      ...(content ? { contentDigest: content.contentDigest } : {}),
      accountId: input.account.accountId,
      parentConversationId: input.receipt.parentConversationId,
      ...(input.receipt.purpose === "resume-successor" ? { sessionId: structuredResumeSessionId(input) } : {}),
    }), admissionRetry);
    input = admittedStructuredLaunchInput(input);
    assertResumeSurvivorsRetired();
    await input.authorize?.();
    const capability = (await input.registry.deliveryWriteOrBusy({ label: "registry.rotateSpawnCapabilityForReceipt" }, input.registry.rotateSpawnCapabilityForReceipt.bind(input.registry, input.receipt.launchId)));
    (await input.registry.deliveryWriteOrBusy({ label: "registry.setReceiptViewerMcpTransport" }, input.registry.setReceiptViewerMcpTransport.bind(input.registry, input.receipt.launchId, viewerMcpTransportForLaunch({ ...input.account.env, LLV_SPAWN_CAPABILITY: capability }))));
    const durableSetupTimeoutMs = dependencies.durableSetupTimeoutMs
      ?? STRUCTURED_SPAWN_DURABLE_SETUP_TIMEOUT_MS;
    durableSetupDeadline = now() + durableSetupTimeoutMs;
    durableSetupTimeout = new Promise<never>((_resolve, reject) => {
      durableSetupTimer = setTimeout(() => {
        durableSetupTimedOut = true;
        reject(materializationPending
          ? new StructuredSessionMaterializationError(
            `structured spawn startup reached its ${durableSetupTimeoutMs}ms durable setup bound while session materialization was pending`,
          )
          : new Error(`structured spawn durable host setup timed out after ${durableSetupTimeoutMs}ms`));
      }, durableSetupTimeoutMs);
      durableSetupTimer.unref?.();
    });
    const startingHost = startHost(input, capability);
    void startingHost.then(async (lateHost) => {
      if (!durableSetupTimedOut) return;
      try {
        await lateHost.release();
      } catch (error) {
        spawnDiagnosticErrorFor(input.receipt.clientAttemptId, "[spawn] late structured host could not be released after setup timeout", {
          launchId: input.receipt.launchId,
          error: structuredSpawnFailureReason(error),
        });
      }
    }, () => {});
    host = await withinDurableSetup(startingHost);
    if (host.viewerMcpTransport) (await input.registry.deliveryWriteOrBusy({ label: "registry.setReceiptViewerMcpTransport" }, input.registry.setReceiptViewerMcpTransport.bind(input.registry, input.receipt.launchId, host.viewerMcpTransport)));
    const identity = hostIdentity(input.engine, host, input);
    key = identity.key;
    if (resumeKey && sessionKeyId(key) !== sessionKeyId(resumeKey)) {
      throw new Error("structured resume returned a different session identity");
    }
    const stagedClaimEpoch = adoptionClaim?.claimEpoch ?? 0;
    const stagedClaimOwner = adoptionClaim?.claimOwner ?? null;
    const staged = (await input.registry.deliveryWriteOrBusy({ label: "registry.stageStructuredSpawn" }, input.registry.stageStructuredSpawn.bind(input.registry, input.receipt.launchId, {
      key,
      artifactPath: identity.path,
      cwd: input.spec.cwd,
      accountId: input.account.accountId,
      launchProfile: input.spec.launchProfile,
      status: "unhosted",
      host: null,
      structuredHost: pendingColumns(
        input.engine,
        adoptionClaim?.structuredHost?.eventCursor ?? 0,
        stagedClaimEpoch,
      ),
      claimEpoch: stagedClaimEpoch,
      claimOwner: stagedClaimOwner,
      pendingAction: "spawn",
    })));
    if (staged.kind === "conflict") throw new Error(`structured spawn registry conflict: ${staged.code}`);
    const stagedPath = identityMaterializationFence().allowsReceipt(staged.receipt, { structured: true })
      ? identity.path
      : null;
    const claimed = adoptionClaim
      ? staged.entry
      : (await input.registry.deliveryWriteOrBusy({ label: "registry.claimStructuredHost" }, input.registry.claimStructuredHost.bind(input.registry, key, processIdentity(), { allowUnhosted: true })));
    if (!claimed?.claimOwner) throw new Error("structured spawn host claim is unavailable");
    adoptionClaimTransferred = adoptionClaim !== null;
    binding.stopPersistence = await withinDurableSetup(
      bindHost(input.registry, key, host, claimed.claimOwner, claimed.claimEpoch),
    );
    /* Still unpublished: a refusal here enters the failure path below, which
       retires the host this launch started and fails its receipt. */
    await input.authorize?.();
    const ownsLaunch = async () => {
      if (durableSetupTimedOut || launchReleased) return false;
      const snapshot = input.registry.readOnlySnapshot();
      const current = snapshot.receipts[input.receipt.launchId];
      const entry = snapshot.entries[sessionKeyId(key!)];
      return Boolean(current
        && current.state !== "completed"
        && current.state !== "failed"
        && current.state !== "conflicted"
        && entry?.structuredHostOperationId === input.receipt.launchId);
    };
    /* The registration awaits the host and the journal after the check above,
       so it asks the account fence again at each of its own boundaries. A
       refusal there leaves the host unregistered and is raised once the
       registration returns, into the same failure path as any other. */
    const publishAuthorized = async (): Promise<() => Promise<void>> => {
      let refusal: { error: unknown } | null = null;
      const unregister = await publishHost(key!, host!, async () => {
        if (refusal || !await ownsLaunch()) return false;
        try {
          await input.authorize?.();
        } catch (error) {
          refusal = { error };
          return false;
        }
        return true;
      });
      const refused = refusal as { error: unknown } | null;
      if (refused) throw refused.error;
      return unregister;
    };
    const recovery: StagedLaunchRecovery = { phase: "unpublished", startedAt: now(), checks: 0, nextTryAt: now(), reason: "host publication pending" };
    await writeStagedRecovery(input.registry, operationId, recovery);
    const continuation: StagedContinuation = {
      host,
      owns: async () => await ownsLaunch() && input.registry.ownsStructuredHostClaim(key!, claimed.claimOwner!, claimed.claimEpoch),
      publish: async () => {
        await input.authorize?.();
        binding.unregister = await publishAuthorized();
        forgetUnpublishedHost();
      },
      deliver: async () => { await input.authorize?.(); return deliverFirst(input, identity.path); },
    };
    stagedContinuations.set(operationId, continuation);
    forgetUnpublishedHost = retainUnpublishedStructuredLaunchHost({ key, host, registry: input.registry,
      release: async () => {
        launchReleased = true;
        stagedContinuations.delete(operationId);
        await cleanupHost(host, binding);
      },
    });
    binding.unregister = await withinDurableSetup(publishAuthorized());
    forgetUnpublishedHost();
    if (!await ownsLaunch()) throw new Error("staged launch was released before publication completed");
    await writeStagedRecovery(input.registry, operationId, { ...recovery, phase: "uncertain", reason: "first-message acknowledgement pending" });
    let initialMessage: void | "held";
    let uncertainFirstMessage = false;
    try {
      await input.authorize?.();
      initialMessage = await withinDurableSetup(deliverFirst(input, identity.path));
    } catch (error) {
      /* Host identity and ownership are durable by this point. A caller
         timeout becomes reconciliation work and never enters host cleanup. */
      if (!(error instanceof StructuredInitialMessageTimeoutError)) throw error;
      /* A CLI that could not start at all — "No conversation found with session
         ID" and its immediate-exit siblings — leaves an already dead host and
         a first message that will never land. That is terminal, not a slow
         launch: it enters the failure path below so the receipt and its runtime
         operation settle as failed and the caller can resubmit, instead of
         reporting `queued` forever (#1071). */
      const terminal = await terminalHostExitReason(host);
      if (terminal) throw new Error(terminal);
      uncertainFirstMessage = true;
      await markInitialMessageTimeout(input.registry, input.receipt.launchId, error);
      initialMessage = "held";
    }
    if (initialMessage === "held") {
      if (!uncertainFirstMessage) {
        await writeStagedRecovery(input.registry, operationId, { ...recovery, reason: "first message held before dispatch" });
        // Retry admission through the same durable payload and client ids.
        continuation.deliver = () => defaultDeliverFirst(input, identity.path);
      }
      clearDurableSetupTimeout();
      (await input.registry.deliveryWriteOrBusy({ label: "registry.releaseStructuredSpawnAdmissionOwner" }, input.registry.releaseStructuredSpawnAdmissionOwner.bind(input.registry, input.receipt.launchId, input.receipt.admissionOwner ?? processIdentity())));
      return {
        ok: true,
        target: null,
        path: stagedPath,
        ...(input.engine === "claude"
          ? { effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default" }
          : {}),
        launchId: input.receipt.launchId,
        conversationId: input.receipt.conversationId,
        launched: true,
        retrySafe: false,
        initialMessage: "queued",
        state: "path-pending",
        transport: "structured",
      };
    }
    await writeStagedRecovery(input.registry, operationId, { ...recovery, phase: "delivered", reason: "transcript publication pending" });
    if (!content && !structuredTranscriptIsReadable(identity.path)) {
      clearDurableSetupTimeout();
      (await input.registry.deliveryWriteOrBusy({ label: "registry.releaseStructuredSpawnAdmissionOwner" }, input.registry.releaseStructuredSpawnAdmissionOwner.bind(input.registry, input.receipt.launchId, input.receipt.admissionOwner ?? processIdentity())));
      return {
        ok: true,
        target: null,
        path: stagedPath,
        ...(input.engine === "claude"
          ? { effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default" }
          : {}),
        launchId: input.receipt.launchId,
        conversationId: input.receipt.conversationId,
        launched: true,
        retrySafe: false,
        initialMessage: "pending",
        state: "path-pending",
        transport: "structured",
      };
    }
    if (content) {
      const sleep = dependencies.sleep
        ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      materializationPending = true;
      try {
        /* The id the engine wire actually carries: the drain stamps the spawn
           first message with the OPERATION id (`spawn_message_<launchId>`),
           not the held delivery's `spawn_<launchId>` clientMessageId, and the
           persisted rollout item echoes the wire id. Hunting the wrong id
           left materialization pending forever (#1332). */
        await withinDurableSetup(waitForStructuredSessionMaterialization(
          host,
          identity.path,
          `spawn_message_${input.receipt.launchId}`,
          {
            now,
            sleep,
            timeoutMs: Math.max(0, durableSetupDeadline - now()),
          },
        ));
      } finally {
        materializationPending = false;
      }
    }
    await withinDurableSetup(
      withRuntimeAdmissionRetry(() => input.client.transitionOperation(operationId, "delivered"), admissionRetry),
    );
    const settled = (await input.registry.deliveryWriteOrBusy({ label: "registry.finalizeStructuredSpawn" }, input.registry.finalizeStructuredSpawn.bind(input.registry, input.receipt.launchId)));
    stagedContinuations.delete(operationId);
    if (settled.kind === "conflict") throw new Error(`structured spawn registry conflict: ${settled.code}`);
    clearDurableSetupTimeout();
    return {
      ok: true,
      target: null,
      path: identityMaterializationFence().allowsReceipt(settled.receipt, { structured: true })
        ? identity.path
        : null,
      ...(input.engine === "claude"
        ? { effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default" }
        : {}),
      launchId: input.receipt.launchId,
      conversationId: settled.conversation.id,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
      transport: "structured",
    };
  } catch (error) {
    clearDurableSetupTimeout();
    const pending = input.registry.readOnlySnapshot().receipts[operationId];
    const recovery = stagedLaunchRecovery(pending);
    if (host && key && recovery && !durableSetupTimedOut && isTransientStagedLaunchFailure(error)) {
      await writeStagedRecovery(input.registry, operationId, { ...recovery, reason: stagedRecoveryFailureReason(error) });
      (await input.registry.deliveryWriteOrBusy({ label: "registry.releaseStructuredSpawnAdmissionOwner" }, input.registry.releaseStructuredSpawnAdmissionOwner.bind(input.registry, operationId, input.receipt.admissionOwner ?? processIdentity())));
      return { ok: true, target: null, path: null, launchId: operationId, conversationId: input.receipt.conversationId,
        launched: true, retrySafe: false, initialMessage: "queued", state: "path-pending", transport: "structured" };
    }
    stagedContinuations.delete(operationId);
    forgetUnpublishedHost();
    const failureReason = structuredSpawnFailureReason(error);
    await input.client.transitionOperation(operationId, "failed", {
      reason: failureReason,
    }).catch(() => {});
    if (!host && error instanceof StructuredHostAdoptionCleanupError) {
      host = error.host as SpawnedStructuredHost;
      if (resumeKey && adoptionClaim?.claimOwner) {
        key = resumeKey;
        binding.stopPersistence = await bindHost(
          input.registry,
          resumeKey,
          host,
          adoptionClaim.claimOwner,
          adoptionClaim.claimEpoch,
          "dead",
        );
      }
    }
    let cleanupError: unknown = null;
    try {
      await cleanupHost(host, binding);
    } catch (failure) {
      cleanupError = failure;
    }
    const transcriptFailureMustSettle = input.receipt.purpose === "launch"
      && (error instanceof StructuredTranscriptMaterializationError
        || error instanceof StructuredSessionMaterializationError);
    if (cleanupError !== null && !transcriptFailureMustSettle) throw error;
    let failedEntry: AgentRegistryEntry | null = null;
    let failedIdentity = resumeIdentity;
    if (key) {
      const entry = input.registry.readOnlySnapshot().entries[sessionKeyId(key)];
      if (entry) {
        failedEntry = entry;
        failedIdentity = { key, artifactPath: entry.artifactPath };
      }
    } else {
      if (resumeIdentity) {
        failedEntry = input.registry.readOnlySnapshot().entries[sessionKeyId(resumeIdentity.key)] ?? null;
      }
    }
    if (typeof failedEntry?.structuredHostOperationId === "string"
      && failedEntry.structuredHostOperationId !== input.receipt.launchId) {
      failedIdentity = null;
    }
    let projectionSucceeded = cleanupError === null;
    if (failedIdentity && !adoptionClaimContended && cleanupError === null) {
      try {
        await projectDeadStructuredSpawn(
          input.client,
          input.receipt,
          failedEntry ?? { accountId: input.account.accountId, cwd: input.spec.cwd },
          `structured-spawn-failed:${input.receipt.launchId}`,
          failedIdentity,
        );
      } catch {
        projectionSucceeded = false;
      }
    }
    if (adoptionClaim && (!adoptionClaimTransferred || !projectionSucceeded)) {
      await releaseAdoptionClaim(input.registry, adoptionClaim, projectionSucceeded);
    }
    const terminalFreshLaunch = input.receipt.purpose === "launch";
    if (projectionSucceeded || terminalFreshLaunch) {
      if (key) {
        await input.registry.failStructuredSpawnOffLoop(input.receipt.launchId, failureReason, {
          retainRegisteredHost: cleanupError !== null,
        });
      } else {
        await input.registry.failSpawnOffLoop(input.receipt.launchId, failureReason);
      }
    }
    if (cleanupError !== null) {
      spawnDiagnosticErrorFor(input.receipt.clientAttemptId, "[spawn] failed host cleanup remained unconfirmed", {
        launchId: input.receipt.launchId,
        error: structuredSpawnFailureReason(cleanupError),
      });
    }
    throw error;
  } finally {
    // This call no longer advances setup, including when cleanup/projection
    // failed. Hand recovery back without releasing a newer admission owner.
    if (foregroundAdmissionOwner) {
      await input.registry.deliveryWrite({ label: "spawn.admission.release", operationId },
        () => input.registry.releaseStructuredSpawnAdmissionOwner(operationId, foregroundAdmissionOwner));
    }
  }
}
