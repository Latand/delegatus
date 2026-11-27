import { waitForStateLock } from "@/lib/state/lockWait";
import { runtimeDataCorruptionCode } from "@/lib/runtime/dataCorruption";
import { schemaCompileFailure } from "@/lib/state/schemaCompatibility";
import { checkpointHotStateRollbackMirrorsForDemotion } from "./state/checkpointRollbackMirrors";
export { checkpointHotStateRollbackMirrorsForDemotion } from "./state/checkpointRollbackMirrors";
import { viewerLoopMonitor } from "@/lib/viewerLoopMonitor";
import { installServingNextRenderMonitor } from "@/lib/nextRenderMonitor";
import { installServingControlIngress } from "@/lib/mcp/controlIngress";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerReleaseTraffic";
import { discardUnsupportedApiCredentials } from "@/lib/environmentIsolation";
import { redactBounded } from "@/lib/monitor/redact";
import { RuntimeHostUnavailableError } from "@/lib/runtime/client";
import { structuredHostsEnabled } from "@/lib/runtime/flags";
import {
  acknowledgeHotStateFence,
  completeHotStatePreparation,
  hotStateWriterRevision,
  markHotStateActivationReady,
  markViewerReleaseReady,
  publishHotStateAuthority,
  readHotStateAuthority,
  type HotStateAuthority,
} from "@/lib/state/hotStateAuthority";
import { initializeStateCollectionsAsync as initializeStateCollections, markStateSqliteCutoverReady } from "@/lib/state/sqliteStateStore";
import { openStateMutationActivation } from "@/lib/state/stateMutationBarrier";
import { markStructuredHostStartupFailed, markStructuredHostStartupReady, markStructuredHostStartupRetryStarted } from "@/lib/runtime/startupStatus";
import { StructuredRuntimeRequirementError } from "@/lib/proc/darwinIdentity";
import { startupDiagnosticsQuiet } from "@/lib/startupDiagnostics";
import type { AgentRegistry } from "@/lib/agent/registry";
import { readAuto } from "@/lib/selfUpdate/auto";
import { activeDrain } from "@/lib/selfUpdate/drain";
import { markViewerHttpReady, viewerStartupPhases } from "@/lib/viewerReadiness";

/*
 * The Viewer's node-side startup runtime. This module (and everything it pulls
 * in — node: builtins included) must stay OUT of `src/instrumentation.ts`:
 * Next's dev fallback compiler builds that entry without node:-scheme support,
 * so any node: import reachable from it fails the compile and 500s every
 * request (the local QA `/api/files` regression). `register()` reaches this
 * module only through a dynamic import inside a statically-pruned
 * `NEXT_RUNTIME === "nodejs"` branch.
 */

const RELEASE_ACTIVATION_POLL_MS = 250;
const HOT_STATE_CUTOVER_STABLE_POLLS = 3;
const HOT_STATE_CUTOVER_MAX_POLLS = 12;
/* A deploy fence is transient: the adapter gives the fenced release 30s to
   quiesce, then switches or restores. A fence older than this is stuck. */
const HOT_STATE_FENCE_WAIT_MS = 120_000;

function hotStateFenceWaitMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const configured = Number(env.LLV_HOT_STATE_FENCE_WAIT_MS || HOT_STATE_FENCE_WAIT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : HOT_STATE_FENCE_WAIT_MS;
}

interface ActivationTimer {
  unref?(): unknown;
}

interface StructuredHostStartupOptions {
  signal?: AbortSignal;
  schedule?: (callback: () => void, delayMs: number) => ActivationTimer;
  initialRetryMs?: number;
  maxRetryMs?: number;
  jitterRatio?: number;
  random?: () => number;
  waitUntilReady?: boolean;
}

interface ViewerReleaseActivationOptions {
  pollMs?: number;
  schedule?: (callback: () => void, delayMs: number) => ActivationTimer;
  log?: (...args: unknown[]) => void;
  fenceRequest?: () => HotStateAuthority | null;
  onFenceRequested?: (request: HotStateAuthority) => void | Promise<void>;
  /** A fence this release processed was withdrawn while it stayed current. */
  onFenceWithdrawn?: () => void | Promise<void>;
  resumeWorktreeRecovery?: () => Promise<void>;
  onDemoted?: (context: { fenced: boolean }) => void | Promise<void>;
  /** Ends a process whose startup a fence interrupted, once that fence ends or
      outlasts `fenceWaitMs`. Without it the failure reaches the caller. */
  restartAfterFencedStartup?: (code: number) => unknown;
  fenceWaitMs?: number;
}

interface HotStateCutoverOptions {
  pollMs?: number;
  stablePolls?: number;
  maxPolls?: number;
  schedule?: (callback: () => void, delayMs: number) => ActivationTimer;
  legacySignature?: () => string;
  fenceWaitMs?: number;
  exit?: (code: number) => unknown;
  log?: (...args: unknown[]) => void;
}

export interface HotStateCutoverBoundary {
  authority: HotStateAuthority | null;
  reimportLegacy: boolean;
}

interface CurrentReleaseControllerLoaders {
  loadMemberRevocations?: () => Promise<{ startMemberRevocationWorker: () => void }>;
  loadFlowPipelineController: () => Promise<{ startFlowPipelineController: () => void }>;
  /** Optional for the same reason as the loaders below. The stale role
      mapping pass (docs/design/model-sizing-tiers.md §5). */
  loadRoleMappingRetirements?: () => Promise<{ applyRoleMappingRetirements: () => unknown }>;
  loadAccountMigrationController: () => Promise<{ startAccountMigrationController: () => Promise<void> }>;
  /** Optional so a test can supply the two controllers it exercises and get
      nothing else. Production always passes it. */
  loadTelegramReportScheduler?: () => Promise<{ ensureTelegramReportScheduler: () => void }>;
  /** Optional for the same reason. */
  loadTelegramBotPoller?: () => Promise<{ ensureTelegramBotPoller: () => void }>;
  loadExternalRelayPollers?: () => Promise<{ ensureExternalRelayPollers: () => void }>;
  /** Optional for the same reason. */
  loadTelegramConnectorBoot?: () => Promise<{ provisionTelegramConnectorAtStartup: () => Promise<unknown> }>;
  /** Optional for the same reason. */
  loadAgentStateService?: () => Promise<{ startAgentStateService: () => Promise<void> }>;
  loadStructuredHostRetirement?: () => Promise<{ startStructuredHostRetirement: () => void }>;
  /** Optional for the same reason. */
  loadSeatTick?: () => Promise<{ startSeatTick: () => boolean }>;
  /** Optional for the same reason. */
  loadDeputySweep?: () => Promise<{ startDeputySweep: () => void }>;
  /** Optional for the same reason. */
  loadTempSweep?: () => Promise<{ startTempSweep: () => void }>;
  loadDiskPressureWatch?: () => Promise<{ startDiskPressureWatch: () => void }>;
  /** Optional for the same reason. */
  loadTurboSweep?: () => Promise<{ startTurboSweep: () => void }>;
  /** Optional for the same reason. */
  loadWorktreeSweep?: () => Promise<{ startWorktreeSweep: () => void }>;
  /** Optional for the same reason. */
  loadAsksClassifier?: () => Promise<{ startAsksClassifier: () => void }>;
  /** Optional for the same reason. */
  loadAttentionReconcile?: () => Promise<{ startAttentionReconcile: () => void }>;
  loadLinkedBoardSync?: () => Promise<{ startLinkedBoardSync: () => void }>;
  /** Optional for the same reason. */
  loadDoneSweep?: () => Promise<{ startDoneSweep: () => void }>;
  loadSeatChannel?: () => Promise<{ startSeatChannel: () => void }>;
  loadPrototypeDelivery?: () => Promise<{ startPrototypeDeliveryWorker: () => void }>;
  loadAppConnect?: () => Promise<{ startAppConnectPoller: () => void }>;
  loadVoiceTimers?: () => Promise<{ startVoiceTimers: () => void }>;
  loadSelfUpdateAuto?: () => Promise<{ startSelfUpdateAuto: () => Promise<void> | void }>;
  loadCloudEnvironmentController?: () => Promise<{ startCloudEnvironmentController: () => void }>;
}

interface ViewerRuntimeActivationSteps {
  initializeOperatorCapability: () => Promise<void>;
  runIdentityMigration?: () => Promise<void> | void;
  runClaudeLoginRecovery?: () => Promise<void>;
  startStructuredHosts: (() => void) | null;
  startControllers: () => Promise<void>;
  publishHotStateActivation: () => void;
  publishViewerReleaseReady: () => void;
  refineBoard?: () => Promise<unknown>;
}

export { viewerReleaseOwnsTraffic };

/** Names the release that demoted this Viewer: the durable target that now
 * appoints its successor. A turn cut by this release records it as the
 * boundary of the continuation it is owed (#1835). */
export function viewerReleaseBoundary(
  readTarget: () => string = () => fs.readFileSync(statePath("viewer-release.json"), "utf8"),
): string {
  let target: string;
  try {
    target = readTarget();
  } catch {
    return `viewer-release:pid-${process.pid}`;
  }
  const digest = crypto.createHash("sha256").update(target).digest("hex").slice(0, 16);
  return `viewer-release:${digest}`;
}

function legacyHotStateSignature(): string {
  return ["flows.json", "pipelines.json", "pipelines-archive.json", "workflows.json"].map((name) => {
    const filename = statePath(name);
    try {
      const stat = fs.statSync(filename, { bigint: true });
      return `${name}:${stat.mtimeNs}:${stat.size}`;
    } catch {
      return `${name}:missing`;
    }
  }).join("|");
}

/** A release the deploy fenced and its supervisor restarted boots while the
 * adapter still holds the fence. It waits for the adapter to end it in this
 * release's favour, reading the target and the authority afresh on every poll,
 * so a switch to another release is never overwritten. A fence that outlasts
 * the bound, or traffic moving away, ends the process: a rejected
 * instrumentation hook leaves `next start` answering 500 for as long as it runs. */
async function awaitHotStateFenceEnd(
  directory: string,
  isCurrent: () => boolean,
  options: HotStateCutoverOptions,
): Promise<{ releaseRevision: string; authority: HotStateAuthority }> {
  const pollMs = options.pollMs ?? RELEASE_ACTIVATION_POLL_MS;
  const waitMs = options.fenceWaitMs ?? hotStateFenceWaitMs();
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const log = options.log ?? console.error;
  const deadline = Date.now() + waitMs;
  log(`[viewer release] booting under an active hot-state fence; waiting up to ${waitMs} ms for it to end`);
  try {
    for (;;) {
      // Ref'd on purpose: this wait is the startup's only pending work.
      await new Promise<void>((resolve) => { schedule(resolve, pollMs); });
      if (!isCurrent()) throw new Error("viewer release lost traffic during hot-state cutover");
      const releaseRevision = hotStateWriterRevision(directory);
      const authority = readHotStateAuthority(directory);
      if (releaseRevision !== null && authority && authority.mode !== "fencing"
        && authority.releaseRevision === releaseRevision) return { releaseRevision, authority };
      if (Date.now() >= deadline) throw new Error(`hot-state fence did not clear for this release within ${waitMs} ms`);
    }
  } catch (error) {
    log("[viewer release] startup cannot pass the hot-state fence; exiting so the supervisor restarts this release", error);
    (options.exit ?? process.exit)(1);
    throw error;
  }
}

/** A promoted first-SQLite release waits through the predecessor's demotion
 * poll and imports only after every legacy hot-state file is stable. */
export async function establishHotStateCutoverBoundary(
  isCurrent: () => boolean,
  options: HotStateCutoverOptions = {},
): Promise<HotStateCutoverBoundary> {
  const directory = path.dirname(statePath("state.sqlite"));
  let releaseRevision = hotStateWriterRevision(directory);
  const targetExists = releaseRevision !== null || fs.existsSync(statePath("viewer-release.json"));
  if (targetExists && releaseRevision === null) throw new Error("viewer release cannot publish hot-state authority");
  if (releaseRevision === null) {
    markStateSqliteCutoverReady(statePath("state.sqlite"));
    return { authority: null, reimportLegacy: false };
  }
  let authority = readHotStateAuthority(directory);
  if (authority?.mode === "fencing") {
    ({ releaseRevision, authority } = await awaitHotStateFenceEnd(directory, isCurrent, options));
  }
  if (authority?.mode === "sqlite" && authority.releaseRevision !== releaseRevision) {
    authority = publishHotStateAuthority(directory, "sqlite", releaseRevision);
    markStateSqliteCutoverReady(statePath("state.sqlite"));
    return { authority, reimportLegacy: false };
  }
  if (authority?.mode === "sqlite" && authority.releaseRevision === releaseRevision) {
    markStateSqliteCutoverReady(statePath("state.sqlite"));
    return { authority, reimportLegacy: false };
  }
  if (authority?.mode !== "preparing" || authority.releaseRevision !== releaseRevision) {
    authority = publishHotStateAuthority(directory, "preparing", releaseRevision);
  }
  const { hotStateMigrationApplied, hotStateMigrationDryRun } = await import("@/lib/state/hotStateMigration");
  if (hotStateMigrationApplied()) {
    markStateSqliteCutoverReady(statePath("state.sqlite"));
    return { authority, reimportLegacy: false };
  }
  const pollMs = options.pollMs ?? RELEASE_ACTIVATION_POLL_MS;
  const stablePolls = options.stablePolls ?? HOT_STATE_CUTOVER_STABLE_POLLS;
  const maxPolls = options.maxPolls ?? HOT_STATE_CUTOVER_MAX_POLLS;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const signature = options.legacySignature ?? legacyHotStateSignature;
  let previous = signature();
  let stable = 0;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    await new Promise<void>((resolve) => schedule(resolve, pollMs).unref?.());
    if (!isCurrent()) throw new Error("viewer release lost traffic during hot-state cutover");
    const current = signature();
    stable = current === previous ? stable + 1 : 0;
    previous = current;
    if (stable >= stablePolls) {
      hotStateMigrationDryRun();
      markStateSqliteCutoverReady(statePath("state.sqlite"));
      return { authority, reimportLegacy: true };
    }
  }
  throw new Error("legacy hot-state files did not quiesce during release cutover");
}

/** Run stateful startup immediately for the current release. A deployment
 * candidate polls the durable target and activates once promotion appoints it. */
export async function activateViewerRuntimeWhenCurrent(
  activate: () => Promise<void>,
  isCurrent: () => boolean,
  options: ViewerReleaseActivationOptions = {},
): Promise<void> {
  const pollMs = options.pollMs ?? RELEASE_ACTIVATION_POLL_MS;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const log = options.log ?? console.error;
  let started = false;
  let demoted = false;
  let fenceInProgress = false;
  let fenceObserved = false;
  /* Never cleared: a startup step can fail on a fence that has already been withdrawn. */
  let fenceSeen = false;
  let fencedEpoch: number | null = null;
  const monitor = () => {
    if (demoted) return;
    if (started && !isCurrent()) {
      demoted = true;
      void Promise.resolve(options.onDemoted?.({ fenced: fencedEpoch !== null })).catch((error) => {
        log("[viewer release] demotion checkpoint failed", error);
      });
      return;
    }
    const fence = started ? options.fenceRequest?.() ?? null : null;
    if (!fence || fence.mode !== "fencing") {
      if (!fenceInProgress && fenceObserved) {
        fenceObserved = false;
        fencedEpoch = null;
        void (async () => {
          await options.onFenceWithdrawn?.();
          if (isCurrent() && options.fenceRequest?.()?.mode !== "fencing") {
            await options.resumeWorktreeRecovery?.();
          }
        })().catch((error) => {
          log("[viewer release] withdrawn fence recovery failed", error);
        });
      }
    } else if (fencedEpoch !== fence.epoch && !fenceInProgress) {
      fenceObserved = true;
      fenceSeen = true;
      fenceInProgress = true;
      void Promise.resolve(options.onFenceRequested?.(fence)).then(() => {
        fencedEpoch = fence.epoch;
      }).catch((error) => {
        log("[viewer release] hot-state fence checkpoint failed", error);
      }).finally(() => {
        fenceInProgress = false;
      });
    }
    schedule(monitor, pollMs).unref?.();
  };
  const fenceHeld = () => fenceInProgress || options.fenceRequest?.()?.mode === "fencing";
  const start = async () => {
    if (started) return;
    started = true;
    schedule(monitor, pollMs).unref?.();
    try {
      await activate();
    } catch (error) {
      const restart = options.restartAfterFencedStartup;
      if (!restart || (!fenceSeen && !fenceHeld())) throw error;
      /* The fence aborted this startup for good. Stay alive while it stands, so
         the monitor can still acknowledge it, then hand over to a fresh boot. */
      log("[viewer release] a hot-state fence interrupted startup; restarting once it ends", error);
      const deadline = Date.now() + (options.fenceWaitMs ?? hotStateFenceWaitMs());
      while (fenceHeld() && Date.now() < deadline) {
        await new Promise<void>((resolve) => { schedule(resolve, pollMs); });
      }
      restart(1);
      throw error;
    }
  };
  if (isCurrent()) {
    await start();
    return;
  }
  const poll = () => {
    if (started) return;
    if (!isCurrent()) {
      schedule(poll, pollMs).unref?.();
      return;
    }
    void start().catch((error) => log("[viewer release] deferred runtime activation failed", error));
  };
  schedule(poll, pollMs).unref?.();
}

/** An install transfer the previous Viewer left between its first write and
    its cleanup is settled before any later startup step: finished when it
    committed, undone when not (docs/design/install-memory-transfer.md §4.7).
    A failure refuses activation, because the install would otherwise admit
    launches against a half-applied import; the journal stays, and the next
    start settles the same one. */
export async function settleInterruptedTransfers(
  recover: () => Promise<unknown> = async () => (await import("@/lib/transfer/importer")).recoverTransferImportsAtStartup(),
): Promise<void> {
  try { await recover(); }
  catch (error) {
    throw new Error(`activation refused: an interrupted install transfer could not be settled (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
}

export function accountControllerDelayMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const configured = Number(env.LLV_ACCOUNT_CONTROLLER_DELAY_MS ?? 0);
  return Number.isFinite(configured) ? Math.max(0, configured) : 0;
}

export function scheduleAccountMigrationController(start: () => Promise<void>, delayMs: number): void {
  const run = () => {
    start().catch((error) => { console.error("[account migration controller] initial durable reconciliation failed", error); });
  };
  const timer = setTimeout(() => {
    if (delayMs > 0) run();
    // A second zero-delay timer gives already queued readiness probes a turn.
    else setTimeout(run, 0).unref?.();
  }, delayMs);
  timer.unref?.();
}

export async function completeViewerReleaseDemotion(
  checkpoint: () => void | Promise<void>,
  exit: (code: number) => unknown = (code) => process.exit(code),
  log: (...args: unknown[]) => void = console.error,
  releaseStructuredHosts: () => Promise<unknown> = async () => {
    const { releaseStructuredDeliveryHostsForDemotion } = await import("@/lib/runtime/structuredDeliveryController");
    await releaseStructuredDeliveryHostsForDemotion();
  },
): Promise<void> {
  let failure: unknown = null;
  try {
    await releaseStructuredHosts();
  } catch (error) {
    failure = error;
  }
  try {
    await checkpoint();
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    log("[viewer release] demotion cleanup failed", failure);
    exit(1);
    return;
  }
  exit(0);
}

export async function initializeHotStateStoresAtStartup(
  boundary: HotStateCutoverBoundary = { authority: null, reimportLegacy: false },
  options: { afterCollectionImport?: (collection: string) => void; signal?: AbortSignal; onStep?: () => void } = {},
): Promise<HotStateAuthority | null> {
  const [flows, pipelines, workflows] = await Promise.all([
    import("@/lib/flows/store"),
    import("@/lib/pipelines/store"),
    import("@/lib/workflows/store"),
  ]);
  await initializeStateCollections(statePath("state.sqlite"), [
    flows.flowStateCollectionSeed(),
    ...pipelines.pipelineStateCollectionSeeds(),
    workflows.workflowStateCollectionSeed(),
  ], {
    reimportExisting: boundary.reimportLegacy,
    ...(options.afterCollectionImport ? { afterCollectionImport: options.afterCollectionImport } : {}),
  });
  options.onStep?.();
  flows.loadFlows();
  pipelines.loadPipelines();
  pipelines.loadArchivedPipelinesForList();
  workflows.loadWorkflows();
  options.onStep?.();
  // Requests consume the persisted narrow projections from their first call.
  const { readHistoryProjection } = await import("@/lib/state/historyProjection");
  await readHistoryProjection(() => undefined, { startup: true, signal: options.signal });
  options.onStep?.();
  // MCP readers cannot install missing receipt indexes in operator state.
  // Prepare the existing schema and legacy import under the serving owner's
  // startup fence, before a thread's first task call reaches its worker.
  const { openAsyncMcpReceiptStore } = await import("@/lib/mcp/server");
  await waitForStateLock("mcp.receipts.startup", async () => {
    const receipts = await openAsyncMcpReceiptStore(statePath("mcp-receipts.sqlite"), {
      legacyFilePath: statePath("mcp-receipts.json"),
    });
    receipts.close();
  }, { signal: options.signal });
  options.onStep?.();
  if (boundary.authority?.mode === "preparing") {
    return completeHotStatePreparation(path.dirname(statePath("state.sqlite")), boundary.authority);
  }
  return boundary.authority;
}

export async function startCurrentReleaseControllers(
  env: Readonly<Record<string, string | undefined>> = process.env,
  loaders: CurrentReleaseControllerLoaders = {
    loadFlowPipelineController: () => import("@/lib/pipelines/controller"),
    loadAccountMigrationController: () => import("@/lib/accounts/migration/controller"),
    loadTelegramReportScheduler: () => import("@/lib/telegram/reportRunner"),
    loadTelegramBotPoller: () => import("@/lib/telegram/bot/service"),
    loadExternalRelayPollers: () => import("@/lib/externalRelay/poller"),
    loadTelegramConnectorBoot: () => import("@/lib/telegram/connectorBoot"),
    loadAgentStateService: () => import("@/lib/agentState/service"),
    loadStructuredHostRetirement: () => import("@/lib/runtime/structuredHostRetirement"),
    loadSeatTick: () => import("@/lib/monitor/seatTickController"),
    loadTempSweep: () => import("@/lib/tempSweep"),
    loadDiskPressureWatch: () => import("@/lib/state/diskPressureWatch"),
    loadTurboSweep: () => import("@/lib/monitor/turboRuntime"),
    loadWorktreeSweep: () => import("@/lib/pipelines/worktreeSweep"),
    loadDeputySweep: () => import("@/lib/orchestrator/deputySweep"),
    loadRoleMappingRetirements: () => import("@/lib/roles/retirements"),
    loadAsksClassifier: () => import("@/lib/asks/controller"),
    loadAttentionReconcile: () => import("@/lib/attention/reconcileController"),
    loadLinkedBoardSync: () => import("@/lib/links/schedule"),
    loadDoneSweep: () => import("@/lib/done/sweep"),
    loadSeatChannel: () => import("@/lib/orchestrator/seatChannel"),
    loadPrototypeDelivery: () => import("@/lib/prototypeReview/deliveryWorker"),
    loadMemberRevocations: () => import("@/lib/team/memberRevocation"),
    loadAppConnect: () => import("@/lib/forge/appConnect"),
    loadVoiceTimers: () => import("@/lib/voiceCompanion/voiceTimersServer"),
    loadSelfUpdateAuto: () => import("@/lib/selfUpdate/auto"),
    loadCloudEnvironmentController: () => import("@/lib/projects/cloudEnvironmentController"),
  },
  options: { beforeSeatTick?: Promise<unknown>; onStep?: () => void } = {},
): Promise<void> {
  const loaded = async <T>(loading: T): Promise<Awaited<T>> => {
    const controller = await loading;
    if (loading) options.onStep?.();
    return controller;
  };
  /* Stale role mapping rows (docs/design/model-sizing-tiers.md §5) are reset
     once, by the release that owns traffic, before its controller launches
     anything from them. A failure leaves the file as it was. */
  try {
    const retirements = await loaded(loaders.loadRoleMappingRetirements?.());
    const outcome = await waitForStateLock("roles.retirements", () => retirements?.applyRoleMappingRetirements() as { state?: string; reset?: string[] } | undefined);
    if (retirements) options.onStep?.();
    if (outcome?.state === "written" && outcome.reset?.length) console.error(`[roles] reset stale mapping rows to their defaults: ${outcome.reset.join(", ")}`);
  } catch (error) {
    console.error("[roles] mapping retirement failed", error instanceof Error ? error.name : "unknown");
  }
  // Restore a durable update hold before any autonomous launch admission.
  try {
    const selfUpdate = await loaded(loaders.loadSelfUpdateAuto?.());
    await selfUpdate?.startSelfUpdateAuto();
    if (selfUpdate) options.onStep?.();
  } catch (error) {
    console.error("[self-update] auto start failed", error instanceof Error ? error.name : "unknown");
    const auto = readAuto(statePath("self-update", "auto.json"));
    // An expired raw lease still has durable custody during recovery. Refuse
    // autonomous startup until its owner can renew or release that custody.
    if (activeDrain() || (auto.drain && !auto.drain.overranAt && (auto.enabled || auto.drain.admitted || auto.managedPending))) throw error;
  }
  const { startFlowPipelineController } = await loaded(loaders.loadFlowPipelineController());
  startFlowPipelineController();
  try { (await loaded(loaders.loadCloudEnvironmentController?.()))?.startCloudEnvironmentController(); }
  catch { console.error("[cloud environments] preparation controller unavailable"); }
  /* The shared Telegram connector dies with the viewer container it is a child
     of (#1133), and the supervisor only ever started one when a consumer asked
     — so the Daily Report run after a restart was the thing that discovered it
     was gone, and failed. The release that owns traffic brings it back for an
     account that already has one. NOT awaited: verifying a connector takes
     tens of seconds and the release-ready marker must not sit behind it. */
  try {
    const connector = await loaded(loaders.loadTelegramConnectorBoot?.());
    if (connector) {
      void connector.provisionTelegramConnectorAtStartup()
        .catch((error) => console.error("[telegram connector] boot provisioning failed", error instanceof Error ? error.name : "unknown"));
    }
  } catch (error) {
    console.error("[telegram connector] boot provisioning unavailable", error instanceof Error ? error.name : "unknown");
  }
  /* The Daily Report timer (#1086) belongs to the release that owns traffic,
     like every other controller here. Starting it from the Telegram route
     alone would mean a standalone Viewer nobody has opened in a browser runs
     no report and catches up no missed slot. It is idempotent per process, and
     a failure to start it must not take the other controllers down with it. */
  try {
    const telegram = await loaded(loaders.loadTelegramReportScheduler?.());
    telegram?.ensureTelegramReportScheduler();
  } catch (error) {
    console.error("[telegram report] scheduler start failed", error instanceof Error ? error.name : "unknown");
  }
  /* The Telegram bot's update poller (docs/design/telegram-bot-account.md)
     reads for a connected bot in the release that owns traffic. It does
     nothing without a stored token, and its failure stays its own. */
  try {
    const bot = await loaded(loaders.loadTelegramBotPoller?.());
    bot?.ensureTelegramBotPoller();
  } catch (error) {
    console.error("[telegram bot] poller start failed", error instanceof Error ? error.name : "unknown");
  }
  try {
    const relays = await loaded(loaders.loadExternalRelayPollers?.());
    relays?.ensureExternalRelayPollers();
  } catch (error) {
    console.error("[external relay] poller start failed", error instanceof Error ? error.name : "unknown");
  }
  try {
    const agentState = await loaded(loaders.loadAgentStateService?.());
    await agentState?.startAgentStateService();
    if (agentState) options.onStep?.();
  } catch (error) {
    console.error("[agent state] service start failed", error instanceof Error ? error.name : "unknown");
  }
  /* Automatic structured host retirement (#747). It belongs to the release
     that owns traffic for a stronger reason than the others: ownership of a
     host and its live transports are process-scoped state of the process that
     bound the delivery queue, so this is the only process that can answer the
     predicate's questions or ask a host to shut down through its own
     lifecycle. Started before the account-controller switch below, because
     turning account migration off must not silently stop reclaiming hosts —
     retirement has its own off switch (`LLV_HOST_RETIREMENT_IDLE_HOURS=0`). */
  try {
    const retirement = await loaded(loaders.loadStructuredHostRetirement?.());
    retirement?.startStructuredHostRetirement();
  } catch (error) {
    console.error("[host retirement] sweep start failed", error instanceof Error ? error.name : "unknown");
  }
  /* The seat tick (#1245). It belongs here for the reason every controller
     above does — one clock, in the release that owns traffic. Starting here
     makes this the only process that starts a ticker, but not the only one that
     is running one: this activation is reached once, and a promoted successor
     leaves the predecessor alive with its timer armed. So the tick re-asks
     `viewerReleaseOwnsTraffic` at the top of every sweep and stops its own clock
     when the answer has turned, which is what makes a cross-process lock
     unnecessary rather than merely omitted. A rotation hands the tick over with
     nobody configuring anything, and a Viewer restart resumes it from the
     durable stamps rather than from a timer that happened to survive. */
  try {
    const seatTick = await loaded(loaders.loadSeatTick?.());
    if (options.beforeSeatTick) {
      void options.beforeSeatTick.then(() => seatTick?.startSeatTick()).catch(error => {
        console.error("[seat tick] project recovery is incomplete; actions remain held", error instanceof Error ? error.name : "unknown");
      });
    } else seatTick?.startSeatTick();
  } catch (error) {
    console.error("[seat tick] start failed", error instanceof Error ? error.name : "unknown");
  }
  /* Turbo (docs/design/turbo-mode.md §2.7): an episode stored on, or ended and
     not yet returned, resumes from its stored rows after a restart or deploy. */
  try {
    const turbo = await loaded(loaders.loadTurboSweep?.());
    turbo?.startTurboSweep();
  } catch (error) {
    console.error("[turbo] start failed", error instanceof Error ? error.name : "unknown");
  }
  /* The stale temp directory sweep (#1957): a killed test run, capture or
     stage host leaves its directory behind, and those filled the disk once.
     One clock is enough, so it runs here with the others; a second release
     sweeping the same roots would only find nothing left to remove.
     `LLV_TEMP_SWEEP_MAX_AGE_HOURS=0` turns it off. */
  try {
    const pressure = await loaded(loaders.loadDiskPressureWatch?.());
    pressure?.startDiskPressureWatch();
  } catch (error) {
    console.error("[disk pressure] watch start failed", error instanceof Error ? error.name : "unknown");
  }
  try {
    const tempSweep = await loaded(loaders.loadTempSweep?.());
    if (tempSweep) {
      const { AttemptTempStore } = await import("./runtime/attemptTempRetention");
      new AttemptTempStore().close();
      options.onStep?.();
    }
    tempSweep?.startTempSweep();
  } catch (error) {
    console.error("[temp sweep] start failed", error instanceof Error ? error.name : "unknown");
  }
  /* Merged lanes' worktrees (#2202), on the same clock for the same reason.
     `LLV_WORKTREE_SWEEP=0` turns it off, `dry-run` only reports. */
  try {
    const worktreeSweep = await loaded(loaders.loadWorktreeSweep?.());
    worktreeSweep?.startWorktreeSweep();
  } catch (error) {
    console.error("[worktree sweep] start failed", error instanceof Error ? error.name : "unknown");
  }
  /* "Asks you" (docs/research/attention-classifier.md §7), on the same clock
     for the same reason. Each sweep reads the switch first; off, it reads one
     small file and stops. */
  try {
    const asks = await loaded(loaders.loadAsksClassifier?.());
    asks?.startAsksClassifier();
  } catch (error) {
    console.error("[asks you] start failed", error instanceof Error ? error.name : "unknown");
  }
  /* Waits that no longer ask anyone leave «Waiting for you» on their own
     (docs/design/attention-auto-resolve.md), on the same clock. */
  try {
    const reconcile = await loaded(loaders.loadAttentionReconcile?.());
    reconcile?.startAttentionReconcile();
  } catch (error) {
    console.error("[attention reconcile] start failed", error instanceof Error ? error.name : "unknown");
  }
  /* A seat's deputy that was running when the Viewer stopped still has to end
     and tell its seat (docs/design/ghost-seat.md §5). The sweep stops itself
     when nothing is live, so this is one small read on an install that never
     asks in parallel. */
  try {
    const deputySweep = await loaded(loaders.loadDeputySweep?.());
    deputySweep?.startDeputySweep();
  } catch (error) {
    console.error("[deputy] sweep start failed", error instanceof Error ? error.name : "unknown");
  }
  /* Linked boards (docs/design/linked-installs.md M.5): the machine that
     typed a pairing code calls each linked install on its own schedule. With
     no link a tick reads two small files and stops. */
  try {
    const linkedBoards = await loaded(loaders.loadLinkedBoardSync?.());
    linkedBoards?.startLinkedBoardSync();
  } catch (error) {
    console.error("[linked boards] sync start failed", error instanceof Error ? error.name : "unknown");
  }
  /* «Готово» (docs/design/done-section.md §3): finished work is taken into
     its store on this clock, so an outcome no tab was open for is still there
     when the operator looks, after its own source has rolled over. */
  try {
    const done = await loaded(loaders.loadDoneSweep?.());
    done?.startDoneSweep();
  } catch (error) {
    console.error("[done] sweep start failed", error instanceof Error ? error.name : "unknown");
  }
  /* The operator's prototype decisions answer as soon as they are saved, and
     their messages go to the seat from here (docs/design/prototype-review-server.md).
     The first sweep attempts every decision still owed, so a decision saved
     while the Viewer restarted or a deploy ran goes out now. */
  try {
    const seatChannel = await loaded(loaders.loadSeatChannel?.());
    seatChannel?.startSeatChannel();
  } catch (error) {
    console.error("[seat channel] start failed", error instanceof Error ? error.name : "unknown");
  }
  try {
    const prototypeDelivery = await loaded(loaders.loadPrototypeDelivery?.());
    prototypeDelivery?.startPrototypeDeliveryWorker();
  } catch (error) {
    console.error("[prototype delivery] start failed", error instanceof Error ? error.name : "unknown");
  }
  try { (await loaded(loaders.loadMemberRevocations?.()))?.startMemberRevocationWorker(); }
  catch { console.error("[team revocation] recovery worker unavailable"); }
  try { (await loaded(loaders.loadAppConnect?.()))?.startAppConnectPoller(); }
  catch (error) { console.error("[forge app connect] start failed", error instanceof Error ? error.name : "unknown"); }
  /* Voice timers fire whether or not a page is open, and one that came due during a restart fires now. */
  try {
    const voiceTimers = await loaded(loaders.loadVoiceTimers?.());
    voiceTimers?.startVoiceTimers();
  } catch (error) {
    console.error("[voice timers] start failed", error instanceof Error ? error.name : "unknown");
  }
  if (env.LLV_ACCOUNT_CONTROLLER_DISABLED === "1") return;
  const { startAccountMigrationController } = await loaded(loaders.loadAccountMigrationController());
  scheduleAccountMigrationController(startAccountMigrationController, accountControllerDelayMs(env));
}

/** Keep the seat tick fenced through transient recovery failures. The signal
 * belongs to this Viewer generation, so a retired release cannot publish a
 * late success into its successor's gate. */
export async function retryWorktreeRecoveryUntilCommitted(
  recover: () => Promise<unknown>, signal: AbortSignal,
  onFailure: (error: unknown) => void = () => {}, delayMs = 1_000,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await recover();
      if (signal.aborted) throw signal.reason ?? new Error("Viewer generation retired during worktree recovery");
      return;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      onFailure(error);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, delayMs);
        function done() { signal.removeEventListener("abort", abort); resolve(); }
        function abort() { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason ?? new Error("Viewer generation retired")); }
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }
  throw signal.reason ?? new Error("Viewer generation retired before worktree recovery committed");
}

export async function initializeOperatorSpawnCapabilityAtStartup(
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: (line: string) => void = (line) => console.error(line),
): Promise<void> {
  const { ensureOperatorSpawnCapability, rotateOperatorSpawnCapability } = await import("@/lib/agent/operatorCapability");
  if (env.LLV_ROTATE_OPERATOR_SPAWN_CAPABILITY === "1") rotateOperatorSpawnCapability();
  else ensureOperatorSpawnCapability();

  /* NO KEY IS EMITTED, because none exists to emit. Rounds 9–10 printed an operator
     session secret here — to `/dev/tty` or an inherited descriptor, never to captured
     output — and the operator pasted it into the tab to unlock designation and voice.
     That ceremony was rejected after use: it broke one-click manager and one-click
     voice, and a reload put the tab back behind it. Same-origin is now the operator
     (see `operatorAuthority`), so startup has nothing secret to hand anyone.

     What remains is the AGENT capability on disk, ensured above: it identifies
     workers, and identifying a worker is the one distinction still made. */
  /* Under the CLI launcher its own banner names the URL, with the key when
     one gates this start. */
  if (startupDiagnosticsQuiet(env)) return;
  const port = env.PORT?.trim() || "8898";
  log(`[viewer] Open http://127.0.0.1:${port}.`);
}

export function runIdentityWaveMigrationWithoutBlockingStartup(
  run: () => unknown,
  log: (...args: unknown[]) => void = console.error,
  options: {
    maxAttempts?: number;
    initialRetryMs?: number;
    schedule?: (callback: () => void, delayMs: number) => ActivationTimer;
  } = {},
): void {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const initialRetryMs = Math.max(0, options.initialRetryMs ?? 5_000);
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  let attempts = 0;
  const failed = (error: unknown) => {
    if (attempts >= maxAttempts) {
      log("[identity-wave] registry migration failed; retry limit reached", { attempt: attempts, error });
      return;
    }
    const retryInMs = initialRetryMs * (2 ** (attempts - 1));
    log("[identity-wave] registry migration failed; retry scheduled", { attempt: attempts, retryInMs, error });
    schedule(attempt, retryInMs).unref?.();
  };
  const attempt = () => {
    attempts += 1;
    try {
      const result = run();
      if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(failed);
    } catch (error) { failed(error); }
  };
  attempt();
}

export type StructuredHostStartupErrorCategory =
  | "runtime-host-unavailable"
  | "timeout"
  | "registry-contention"
  | "transient-io"
  | "instrumentation-order"
  | "configuration"
  | "data-corruption"
  | "unknown-recoverable";

export interface StructuredHostStartupErrorClassification {
  disposition: "recoverable" | "terminal";
  category: StructuredHostStartupErrorCategory;
  action: string;
}

const TRANSIENT_IO_CODES = new Set([
  "EAGAIN",
  "EBUSY",
  "ECONNREFUSED",
  "ECONNRESET",
  "EINTR",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOENT",
]);

function startupErrorField(error: unknown, field: "code" | "name" | "message" | "hostKey" | "deadline"): string {
  if (typeof error !== "object" || error === null || !(field in error)) return "";
  const value = error[field as keyof typeof error];
  return typeof value === "string" ? value : "";
}

/** Known configuration and durable-data failures stop with repair guidance.
    The fallback class stays recoverable so an unexpected dependency blip
    cannot permanently remove delivery from a live Viewer process. */
export function classifyStructuredHostStartupError(
  error: unknown,
): StructuredHostStartupErrorClassification {
  const name = startupErrorField(error, "name");
  const code = startupErrorField(error, "code");
  const message = startupErrorField(error, "message");
  if (error instanceof StructuredRuntimeRequirementError || name === "StructuredRuntimeRequirementError") {
    return {
      disposition: "terminal",
      category: "configuration",
      action: "Correct the structured-host configuration and restart the Viewer.",
    };
  }
  if (name === "IncompatibleSchemaError" || schemaCompileFailure(error)) {
    return {
      disposition: "terminal",
      category: "configuration",
      action: "The state database holds a statement this SQLite cannot compile; it is not damaged. Run a Delegatus release that supports this SQLite, then restart the Viewer.",
    };
  }
  if (name === "RegistryParityError"
    || name === "RegistryBackendIdentityError"
    || runtimeDataCorruptionCode(error)
    || /corrupt .* SQLite row|SQLite row is malformed|schema is unsupported/i.test(message)) {
    return {
      disposition: "terminal",
      category: "data-corruption",
      action: "Repair or restore the reported state data, then restart the Viewer.",
    };
  }
  if (code === "structured-delivery-controller-unavailable") {
    return {
      disposition: "recoverable",
      category: "instrumentation-order",
      action: "Retry after the process controller publication becomes visible.",
    };
  }
  if (code === "ETIMEDOUT" || /\b(?:timed out|deadline exceeded)\b/i.test(message)) {
    return {
      disposition: "recoverable",
      category: "timeout",
      action: "Retry after the dependency response window.",
    };
  }
  if (name === "FileTransactionBusyError") {
    return {
      disposition: "recoverable",
      category: "registry-contention",
      action: "Retry after the active registry transaction releases its lock.",
    };
  }
  if (TRANSIENT_IO_CODES.has(code)) {
    return {
      disposition: "recoverable",
      category: "transient-io",
      action: "Retry after the local I/O dependency recovers.",
    };
  }
  if (error instanceof RuntimeHostUnavailableError
    || /^runtime host (?:is unavailable|request cancelled|response exceeds limit|returned invalid JSON|response id mismatch)$/i.test(message)) {
    return {
      disposition: "recoverable",
      category: "runtime-host-unavailable",
      action: "Retry after the runtime host becomes available.",
    };
  }
  return {
    disposition: "recoverable",
    category: "unknown-recoverable",
    action: "Retry with bounded backoff while the Viewer remains unavailable for structured delivery.",
  };
}

export async function runStructuredHostStartup(
  adopt: () => Promise<unknown>,
  log: (...args: unknown[]) => void = console.error,
  options: StructuredHostStartupOptions = {},
): Promise<void> {
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const maxRetryMs = options.maxRetryMs ?? 300_000;
  const jitterRatio = Math.min(Math.max(options.jitterRatio ?? 0.2, 0), 1);
  const random = options.random ?? Math.random;
  let retryMs = options.initialRetryMs ?? 5_000;
  let retryPending = false;
  let running = false;
  let finished = false;
  let attempts = 0;
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: unknown) => void) | null = null;
  const ready = options.waitUntilReady
    ? new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; })
    : null;

  const attempt = async (): Promise<void> => {
    if (running || finished) return;
    running = true;
    attempts += 1;
    markStructuredHostStartupRetryStarted();
    try {
      options.signal?.throwIfAborted();
      await adopt();
      options.signal?.throwIfAborted();
      markStructuredHostStartupReady();
      finished = true;
      options.signal?.removeEventListener("abort", aborted);
      resolveReady?.();
      if (attempts > 1) log("[structured hosts] startup adoption recovered", { attempts });
    } catch (error) {
      if (options.signal?.aborted) {
        markStructuredHostStartupFailed();
        finished = true;
        rejectReady?.(error);
        throw error;
      }
      const classification = classifyStructuredHostStartupError(error);
      const diagnostic = {
        message: redactBounded(startupErrorField(error, "message") || String(error), 1_000),
        hostKey: redactBounded(startupErrorField(error, "hostKey"), 160) || null,
      };
      const deadline = redactBounded(startupErrorField(error, "deadline"), 160)
        || (classification.category === "timeout" ? diagnostic.message : null);
      if (classification.disposition === "terminal") {
        markStructuredHostStartupFailed(classification.category, { deadline, hostKey: diagnostic.hostKey, nextRetryAt: null });
        finished = true;
        options.signal?.removeEventListener("abort", aborted);
        log("[structured hosts] startup adoption failed", {
          ...diagnostic,
          category: classification.category,
          attempt: attempts,
          action: classification.action,
        });
        rejectReady?.(error);
        throw error;
      }
      if (retryPending) return;
      const jitter = 1 + ((Math.min(Math.max(random(), 0), 1) * 2) - 1) * jitterRatio;
      const delayMs = Math.min(maxRetryMs, Math.max(0, Math.round(retryMs * jitter)));
      retryMs = Math.min(retryMs * 2, maxRetryMs);
      retryPending = true;
      markStructuredHostStartupFailed(classification.category, {
        deadline, hostKey: diagnostic.hostKey, nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
      });
      log("[structured hosts] startup adoption failed; retry scheduled", {
        ...diagnostic,
        category: classification.category, attempt: attempts, retryInMs: delayMs,
      });
      schedule(() => {
        if (!retryPending || running || finished) return;
        retryPending = false;
        // The attempt logs its classified failure; avoid duplicating it or
        // exposing an exception payload in a second log line.
        void attempt().catch(() => {});
      }, delayMs).unref?.();
    } finally {
      running = false;
    }
  };

  const aborted = () => {
    if (finished) return;
    markStructuredHostStartupFailed();
    // An executing attempt must settle before retirement can checkpoint.
    if (retryPending) rejectReady?.(options.signal?.reason);
  };
  options.signal?.addEventListener("abort", aborted, { once: true });

  if (ready) {
    try { await Promise.all([attempt(), ready]); }
    finally { options.signal?.removeEventListener("abort", aborted); }
    return;
  }
  await attempt();
}

export async function completeViewerRuntimeActivation(
  steps: ViewerRuntimeActivationSteps,
  onStep?: () => void,
): Promise<void> {
  await steps.initializeOperatorCapability();
  onStep?.();
  if (steps.runIdentityMigration) {
    await steps.runIdentityMigration();
    onStep?.();
  }
  steps.publishHotStateActivation();
  if (steps.runClaudeLoginRecovery) {
    await steps.runClaudeLoginRecovery();
    onStep?.();
  }
  const { retireLegacyCodexMemoryHooksAtStartup } = await import("@/lib/memory/hookMigration");
  await retireLegacyCodexMemoryHooksAtStartup();
  onStep?.();
  steps.startStructuredHosts?.();
  await steps.startControllers();
  onStep?.();
  steps.publishViewerReleaseReady();
  // The board can load its saved summary on demand. Its startup build and
  // attention refinement may scan the catalog and should run in the background.
  void steps.refineBoard?.().catch(error => {
    console.error("[attention reconcile] startup refinement failed", error instanceof Error ? error.name : "unknown");
  });
}

/** Registry artifacts are part of first-caller readiness: native caller
    admission performs one bounded index slice and refuses incomplete proofs. */
export async function prepareRegistryForNativeCallers(
  registry: Pick<AgentRegistry, "prepareReadOnlySnapshot" | "prepareNativeCallerArtifacts">,
  signal: AbortSignal,
  onSlice?: () => void,
): Promise<void> {
  await registry.prepareReadOnlySnapshot(signal, { onSlice });
  onSlice?.();
  await registry.prepareNativeCallerArtifacts(signal, { waitUntilReady: true, onSlice });
}

/** Check every state database before a store opens one (#1870 slice 10):
    a damaged one is replaced by its newest good backup, or starts empty. The
    returned `start` raises the board cards and arms the backup timer once the
    release is ready. A failed schema recovery blocks store initialization. */
export async function checkStateDatabasesBeforeStores(
  stateDirectory: string,
  onDatabaseChecked?: (done: number, total: number) => void,
): Promise<{ start(ownsTraffic: () => boolean): void }> {
  const { checkStateDatabasesInWorker, startStateDurability, SchemaRecoveryError } = await import("@/lib/state/durability");
  try {
    const incidents = await checkStateDatabasesInWorker(stateDirectory, onDatabaseChecked);
    return { start: (ownsTraffic) => { startStateDurability({ stateDirectory, incidents, ownsTraffic }); } };
  } catch (error) {
    if (error instanceof SchemaRecoveryError) throw error;
    console.error("[state durability] activation check failed", error instanceof Error ? error.message : String(error));
    return { start: () => {} };
  }
}

/** Retirement waits for startup mutations already admitted, and a late result
    cannot advance activation after its controller has aborted. */
export function createViewerStartupBarrier(controller: AbortController) {
  const pending = new Set<Promise<unknown>>();
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      const operation = (async () => {
        controller.signal.throwIfAborted();
        const result = await work();
        controller.signal.throwIfAborted();
        return result;
      })();
      pending.add(operation);
      void operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    },
    async quiesce(reason: Error): Promise<void> {
      controller.abort(reason);
      await Promise.allSettled([...pending]);
    },
  };
}

/** Keep the seat gate across fence epochs, and give each recovery attempt
 * its own signal so withdrawal can resume after the fenced worker exits. */
export function createViewerWorktreeRecovery(
  recover: (signal: AbortSignal, assertAuthority: () => void) => Promise<{ folded: number; leftAlone: number }>,
  hasAuthority: () => boolean,
) {
  let finish!: () => void;
  const committed = new Promise<void>(resolve => { finish = resolve; });
  let done = false;
  let active: { controller: AbortController; work: Promise<void> } | null = null;
  return {
    committed,
    async start() {
      if (done) return;
      if (active) return active.work;
      const controller = new AbortController();
      const { signal } = controller;
      const assertAuthority = () => {
        signal.throwIfAborted();
        if (!hasAuthority()) throw new Error("worktree recovery lost release authority");
      };
      const work = retryWorktreeRecoveryUntilCommitted(async () => {
        assertAuthority();
        await recover(signal, assertAuthority);
        assertAuthority();
        done = true;
        finish();
      }, signal, error => console.error("[worktree recovery] worker failed; retrying in this Viewer generation",
        error instanceof Error ? error.name : "unknown")).finally(() => { active = null; });
      active = { controller, work };
      return work;
    },
    async quiesce(reason: Error) {
      const attempt = active;
      if (!attempt) return;
      attempt.controller.abort(reason);
      await attempt.work.catch(() => {});
    },
  };
}

/** The full node-runtime startup sequence `src/instrumentation.ts` defers to. */
/**
 * The remembered phone-access choice gates this process before it serves a
 * single request (#2024): a Docker release container is started by
 * `next start` with no launcher in front of it, while the tailnet mapping
 * stays live in tailscaled across every deploy and restart. A gate that
 * cannot be put in place stops the process instead of serving ungated.
 */
export async function gatePhoneAccessBeforeServing(
  exit: (code: number) => never = process.exit,
  log: (line: string) => void = console.error,
): Promise<void> {
  const { PhoneGateRefusal, restorePhoneAccessGate, restoreLinksGate } = await import("@/lib/access/phoneAccess");
  try {
    await restoreLinksGate();
    await restorePhoneAccessGate();
  } catch (error) {
    if (!(error instanceof PhoneGateRefusal)) throw error;
    log(`[phone access] phone access is on and the access key cannot be put in place (${error.message}); refusing to serve the tailnet ungated. Fix the key file, or remove the phone-access file beside it to turn phone access off.`);
    exit(78);
  }
}

/** The identity gate in the proxy verifies an agent's capability against the
    registry (sign-in-and-team §4.2), through a lookup installed here because
    the proxy's own bundle must not import the registry. Installed before the
    Viewer serves anything; the registry itself opens on the first lookup. */
export async function installSpawnCapabilityResolverAtStartup(): Promise<void> {
  const [{ installSpawnCapabilityResolver }, { agentRegistry }] = await Promise.all([
    import("@/lib/agent/callerClaims"),
    import("@/lib/agent/registry"),
  ]);
  installSpawnCapabilityResolver((digest) => agentRegistry().conversationIdForSpawnCapabilityDigest(digest));
}

export async function registerViewerRuntime(): Promise<void> {
  const startup = viewerStartupPhases();
  startup.begin("http-ingress");
  viewerLoopMonitor.start();
  // The validated persisted catalog is prepared without contacting any server.
  void import("./voiceTools/hub").then(({ voiceToolHub }) => voiceToolHub().store.load())
    .catch(() => console.error("[voice-tools] REGISTRY_UNAVAILABLE"));
  // Background diagnostics never hold readiness or reach the runtime host.
  void import("./loopProfilerServing").then(({ startServingLoopProfiler }) => startServingLoopProfiler(viewerLoopMonitor)).catch(() => {});
  await installServingNextRenderMonitor();
  await installServingControlIngress();
  discardUnsupportedApiCredentials();

  startup.begin("access");
  await installSpawnCapabilityResolverAtStartup();
  await gatePhoneAccessBeforeServing();
  startup.begin("release-authority");
  const isCurrent = () => viewerReleaseOwnsTraffic();
  const hotStateDirectory = path.dirname(statePath("state.sqlite"));
  const releaseRevision = () => hotStateWriterRevision(hotStateDirectory);
  let activatedReleaseRevision: string | null = null;
  const startupAbort = new AbortController();
  const worktreeRecovery = createViewerWorktreeRecovery(async (signal, assertAuthority) => {
    const { recoverWorktreesInWorker } = await import("@/lib/state/durability");
    assertAuthority();
    return recoverWorktreesInWorker(hotStateDirectory, signal);
  }, () => {
    const authority = readHotStateAuthority(hotStateDirectory);
    return isCurrent() && authority?.mode !== "fencing" && (activatedReleaseRevision === null
      || (authority?.mode === "sqlite" && authority.releaseRevision === activatedReleaseRevision));
  });
  const startupBarrier = createViewerStartupBarrier(startupAbort);
  const quiesceStartup = async () => {
    const reason = new Error("structured startup retired by release handover");
    await Promise.all([startupBarrier.quiesce(reason), worktreeRecovery.quiesce(reason)]);
  };
  const assertStartupActive = () => {
    // Observe durable retirement at every phase/batch boundary, including
    // before the monitor's next poll and after an awaited transcript refresh.
    if (!isCurrent() || readHotStateAuthority(hotStateDirectory)?.mode === "fencing") {
      startupAbort.abort(new Error("structured startup lost release authority"));
    }
    startupAbort.signal.throwIfAborted();
  };
  const releaseHosts = async () => {
    const { stopRecordedCheckObserver } = await import("@/lib/recordedChecks/observer");
    stopRecordedCheckObserver();
    const { releaseStructuredHostsForViewerDemotion } = await import("@/lib/runtime/startup");
    await releaseStructuredHostsForViewerDemotion({ boundary: viewerReleaseBoundary() });
  };
  /* Until the cutover boundary is established this release holds no state: the
     adapter checkpoints a fence on its own, and a booting release that answered
     it would abort its own startup and run a second checkpoint beside it. */
  let cutoverEstablished = false;
  await activateViewerRuntimeWhenCurrent(async () => {
    /* This callback runs only in the process that owns the release and is
       about to serve traffic. It is the one place a state-mutating startup
       step — the #1870 imports, their rollback mirrors, the durability
       checks — is allowed to run at all; everywhere else the barrier refuses
       (#1905, a lane's `next build` importing the live account files). */
    openStateMutationActivation();
    const boundary = await establishHotStateCutoverBoundary(isCurrent);
    cutoverEstablished = true;
    activatedReleaseRevision = boundary.authority?.releaseRevision ?? null;
    assertStartupActive();
    const { startManagedRetirementGuard } = await import("@/lib/state/managedRetirementGuard");
    await startManagedRetirementGuard(hotStateDirectory, activatedReleaseRevision);
    startup.begin("state-compatibility");
    let stateSteps = 0;
    let stateTotal = 0;
    const stateStep = () => startup.progress(++stateSteps, stateTotal);
    const durability = await startupBarrier.run(() => checkStateDatabasesBeforeStores(hotStateDirectory, (done, total) => {
      // Ledger, role stores, four hot-state steps, legacy imports, transfers.
      stateTotal = total + 8;
      stateSteps = done;
      startup.progress(done, stateTotal);
    }));
    assertStartupActive();
    await startupBarrier.run(async () => {
      const { prepareDeliveryLedgerIndexes } = await import("@/lib/memory/deliveryLedger");
      await prepareDeliveryLedgerIndexes();
    });
    assertStartupActive();
    stateStep();
    const { sweepOldLearnedRulesFiles } = await import("@/lib/memory/roleLaunch");
    try { sweepOldLearnedRulesFiles(); } catch { console.warn("[role-memory] old launch-file cleanup unavailable"); }
    const { startRoleSelectionRetention } = await import("@/lib/memory/roleSelectionRetention");
    startRoleSelectionRetention();
    const { startRoleHistoryDrain } = await import("@/lib/memory/roleHistoryDrain");
    startRoleHistoryDrain();
    stateStep();
    const authority = await initializeHotStateStoresAtStartup(boundary, { signal: startupAbort.signal, onStep: stateStep });
    const { startServingHeapSeries } = await import("./heapSeries");
    startServingHeapSeries(viewerReleaseOwnsTraffic);
    const { ensureLegacyCollectionsImported } = await import("@/lib/state/legacyCollections");
    await ensureLegacyCollectionsImported();
    stateStep();
    await startupBarrier.run(() => settleInterruptedTransfers());
    stateStep();
    startup.begin("registry");
    let registrySlices = 0;
    const registrySlice = () => startup.progress(++registrySlices, 0);
    const { prepareAgentRegistry } = await import("@/lib/agent/registry");
    await startupBarrier.run(() => viewerLoopMonitor.run("registry.prepare", async () => {
      const registry = await prepareAgentRegistry(startupAbort.signal);
      registrySlice();
      // The snapshot also prepares recovery indexes and backfills endings.
      // The first authorized native caller needs the complete artifact index;
      // its synchronous lookup intentionally advances only one bounded batch.
      await prepareRegistryForNativeCallers(registry, startupAbort.signal, registrySlice);
    }));
    assertStartupActive();
    startup.begin("activation");
    let activationSteps = 0;
    const activationStep = () => startup.progress(++activationSteps, 0);
    const { cleanupFinishedWorkAtStartup } = await import("@/lib/attention/finishedWorkCleanup");
    await startupBarrier.run(() => cleanupFinishedWorkAtStartup(undefined, assertStartupActive));
    assertStartupActive();
    activationStep();
    let activatedAuthority: HotStateAuthority | null = null;
    const { retireCuratorPlaceholdersAtStartup } = await import("@/lib/memory/curation/cleanup");
    await startupBarrier.run(() => retireCuratorPlaceholdersAtStartup(undefined, assertStartupActive));
    activationStep();
    const { retireSeatRecoveryPlaceholdersAtStartup } = await import("@/lib/tasks/seatRecoveryCleanup");
    await startupBarrier.run(() => retireSeatRecoveryPlaceholdersAtStartup(undefined, assertStartupActive));
    assertStartupActive();
    activationStep();
    await completeViewerRuntimeActivation({
      initializeOperatorCapability: initializeOperatorSpawnCapabilityAtStartup,
      runClaudeLoginRecovery: async () => {
        const { recoverClaudeLoginsAtStartup } = await import("@/lib/accounts/claudeLogin");
        await recoverClaudeLoginsAtStartup();
      },
      runIdentityMigration: async () => {
        const { runIdentityWaveMigrationAtStartupOffLoop } = await import("@/lib/agent/identityWaveStartup");
        runIdentityWaveMigrationWithoutBlockingStartup(runIdentityWaveMigrationAtStartupOffLoop);
      },
      startStructuredHosts: structuredHostsEnabled()
        ? () => {
            const startup = startupBarrier.run(async () => {
              const { adoptStructuredHostsAtStartup } = await import("@/lib/runtime/startup");
              await runStructuredHostStartup(
                () => adoptStructuredHostsAtStartup({ assertActive: assertStartupActive, signal: startupAbort.signal }),
                console.error, { waitUntilReady: true, signal: startupAbort.signal },
              );
            });
            void startup.catch((error) => console.error("[structured hosts] background startup aborted", error));
          }
        : null,
      refineBoard: async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        // The legacy receipt can arrive after readiness. A withdrawn fence
        // resumes this work separately from the retired startup phases.
        startupAbort.signal.throwIfAborted();
        await worktreeRecovery.start();
        await startupBarrier.run(async () => {
          assertStartupActive();
          const { prepareBoardSummary } = await import("@/app/api/files/operatorProjection");
          assertStartupActive();
          await prepareBoardSummary(true);
        });
        await startupBarrier.run(() => viewerLoopMonitor.run("attention.reconcile", async () => {
          const { reconcileAttentionOnce } = await import("@/lib/attention/reconcileController");
          assertStartupActive();
          await reconcileAttentionOnce(undefined, assertStartupActive);
        }));
      },
      startControllers: async () => {
        await startCurrentReleaseControllers(process.env, undefined, { beforeSeatTick: worktreeRecovery.committed, onStep: activationStep });
        const { startRecordedCheckObserver } = await import("@/lib/recordedChecks/observer");
        await startRecordedCheckObserver();
      },
      publishHotStateActivation: () => {
        if (authority) activatedAuthority = markHotStateActivationReady(hotStateDirectory, authority);
        // A predecessor adapter launches by port. Once this process claims
        // activation, pin its own revision for every separately loaded bundle.
        if (activatedAuthority?.releaseRevision) {
          process.env.LLV_HOT_STATE_RELEASE_REVISION = activatedAuthority.releaseRevision;
          process.env.DELEGATUS_HOT_STATE_RELEASE_REVISION = activatedAuthority.releaseRevision;
        }
      },
      publishViewerReleaseReady: () => {
        if (activatedAuthority) markViewerReleaseReady(hotStateDirectory, activatedAuthority);
      },
    }, activationStep);
    durability.start(isCurrent);
    assertStartupActive();
    startup.finish();
    markViewerHttpReady();
    setImmediate(() => {
      void Promise.all([
        import("@/lib/telemetry/sender"), import("@/lib/selfUpdate/mode"), import("@/lib/runtime/client"),
      ]).then(([{ startInstallPing }, { productionModePorts }, { runtimeHostClient }]) => {
        assertStartupActive();
        startInstallPing(productionModePorts(runtimeHostClient()));
      }).catch(error => console.error("[install ping] startup failed", error instanceof Error ? error.name : "unknown"));
    });
  }, isCurrent, {
    restartAfterFencedStartup: (code) => process.exit(code),
    fenceRequest: () => {
      if (!cutoverEstablished) return null;
      const revision = releaseRevision();
      const authority = readHotStateAuthority(hotStateDirectory);
      return revision !== null
        && authority?.mode === "fencing"
        && authority.releaseRevision === revision
        ? authority
        : null;
    },
    onFenceRequested: async (request) => {
      await quiesceStartup();
      await (await import("@/lib/pipelines/provisioningJob")).stopProvisioningJobsForDemotion();
      await releaseHosts();
      const { checkpointHotStateRollbackMirrorsInWorker } = await import("@/lib/state/durability");
      const revisions = await viewerLoopMonitor.run("state.rollback-checkpoint", () => checkpointHotStateRollbackMirrorsInWorker(hotStateDirectory));
      acknowledgeHotStateFence(hotStateDirectory, request, revisions);
    },
    /* A cancelled deployment restores this release's authority but leaves the
       rollback mirrors writable, so an older release's MCP process could write
       one nothing reads. Re-running the import folds such writes in and puts
       the tombstones back. */
    onFenceWithdrawn: async () => {
      const revision = releaseRevision();
      const authority = readHotStateAuthority(hotStateDirectory);
      if (!isCurrent() || revision === null || authority?.mode !== "sqlite" || authority.releaseRevision !== revision) return;
      const { ensureLegacyCollectionsImported } = await import("@/lib/state/legacyCollections");
      if (!isCurrent() || readHotStateAuthority(hotStateDirectory)?.epoch !== authority.epoch) return;
      await ensureLegacyCollectionsImported();
      const currentAuthority = () => {
        const current = readHotStateAuthority(hotStateDirectory);
        return isCurrent() && current?.mode === "sqlite" && current.releaseRevision === revision && current.epoch === authority.epoch;
      };
      (await import("@/lib/pipelines/provisioningJob")).resumeProvisioningJobsAfterFenceWithdrawal(currentAuthority);
    },
    resumeWorktreeRecovery: worktreeRecovery.start,
    onDemoted: async ({ fenced }) => {
      await (await import("@/lib/pipelines/provisioningJob")).stopProvisioningJobsForDemotion();
      (await import("@/lib/projects/cloudEnvironmentController")).stopCloudEnvironmentController();
      try {
        const relays = await import("@/lib/externalRelay/poller");
        relays.stopExternalRelayPollers();
        const { declineHeldRelayRequests } = await import("@/lib/externalRelay/hold");
        await declineHeldRelayRequests(5000);
      } catch (error) {
        console.error("[external relay] poller stop failed", error instanceof Error ? error.name : "unknown");
      }
      /* The successor owns the Telegram connector from here: this Viewer
         stops starting or replacing one and ends the runner it started. */
      try {
        const connector = await import("@/lib/telegram/connector");
        await connector.retireTelegramConnectorSupervisor();
      } catch (error) {
        console.error("[telegram connector] retirement failed", error instanceof Error ? error.name : "unknown");
      }
      await quiesceStartup();
      await completeViewerReleaseDemotion(async () => {
        if (fenced) return;
        const authority = readHotStateAuthority(hotStateDirectory);
        if (!activatedReleaseRevision
          || authority?.releaseRevision !== activatedReleaseRevision
          || (authority.mode !== "sqlite" && authority.mode !== "fencing")) return;
        await checkpointHotStateRollbackMirrorsForDemotion();
      }, undefined, undefined, releaseHosts);
    },
  });
}
