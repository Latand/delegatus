import type {
  AgentHostStatus,
  AgentRegistry,
  AgentRegistryEntry,
  ProcessIdentity,
  RegistryConversation,
  RegistryFile,
  StructuredHostColumns,
  StructuredTerminationCapture,
} from "@/lib/agent/registry";
import { adoptionRefusal } from "@/lib/links/adoptionGuard";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import {
  captureProcessIdentity,
  processIdentityMayOwn,
  processIdentityProvenDead,
  processIdentityStatus,
  sameRecordedProcessIdentity,
} from "@/lib/processIdentity";

import { CodexAppServerHost, type CodexAppServerHostOptions } from "./codexAppServerHost";
import { ClaudeStreamBrokerHost, type ClaudeStreamBrokerHostOptions } from "./claudeStreamBrokerHost";
import type { CopilotAcpHost } from "./copilotAcpHost";
import { StructuredHostAdoptionCleanupError, type HostState } from "./engineHost";
import { structuredHostsEnabled } from "./flags";
import { conversationTurnLiveness, type TurnLivenessDependencies } from "./liveness";
import { restartCutEvidenceHolds } from "./restartCutHold";
import { verifiedSignalDomainProcesses } from "./agentSignalSandbox";
import { isDeepStrictEqual } from "node:util";
import type { StructuredHostTerminationDependencies } from "./structuredHostControl";

export { structuredHostsEnabled };

export async function startCodexStructuredHost(
  options: CodexAppServerHostOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexAppServerHost> {
  if (!structuredHostsEnabled(env)) throw new Error("structured hosts are disabled");
  return CodexAppServerHost.start(options);
}

export async function startClaudeStructuredHost(
  options: ClaudeStreamBrokerHostOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeStreamBrokerHost> {
  if (!structuredHostsEnabled(env)) throw new Error("structured hosts are disabled");
  return ClaudeStreamBrokerHost.start(options);
}

function registryStatus(state: HostState): AgentHostStatus {
  if (state.status === "active" || state.status === "attention") return "live";
  if (state.status === "idle") return "idle";
  if (state.status === "unhosted") return "unhosted";
  return "dead";
}

function registryProcess(state: HostState): ProcessIdentity | null {
  if (state.signalDomain && (state.pid !== null || state.signalDomain.retired !== true)) return { ...state.signalDomain.native };
  return state.pid === null ? null : captureProcessIdentity(state.pid, undefined, state.processStartIdentity);
}

export function codexHostColumns(state: HostState, writerClaimEpoch: number): StructuredHostColumns {
  return {
    kind: "codex-app-server",
    endpoint: state.endpoint,
    process: registryProcess(state),
    eventCursor: state.eventCursor,
    protocolVersion: state.protocolVersion,
    writerClaimEpoch,
    activeTurnRef: state.activeTurnRef,
    pendingAttention: state.pendingAttention,
    ...(state.memory ? { memory: state.memory } : {}),
    ...(state.signalDomain ? { signalDomain: state.signalDomain } : {}),
    activeFlags: state.activeFlags,
  };
}

export function claudeHostColumns(state: HostState, writerClaimEpoch: number): StructuredHostColumns {
  return {
    kind: "claude-broker",
    endpoint: state.endpoint,
    process: registryProcess(state),
    eventCursor: state.eventCursor,
    protocolVersion: state.protocolVersion,
    writerClaimEpoch,
    activeTurnRef: state.activeTurnRef,
    pendingAttention: state.pendingAttention,
    ...(state.pendingPermissions?.length ? { pendingPermissions: state.pendingPermissions } : {}),
    ...(state.pendingToolUses?.length ? { pendingToolUses: state.pendingToolUses } : {}),
    ...(state.providerRetry ? { providerRetry: state.providerRetry } : {}),
    ...(state.memory ? { memory: state.memory } : {}),
    ...(state.signalDomain ? { signalDomain: state.signalDomain } : {}),
    ...(state.ended ? { ended: state.ended } : {}),
    activeFlags: state.activeFlags,
  };
}

export function copilotHostColumns(state: HostState, writerClaimEpoch: number): StructuredHostColumns {
  return {
    kind: "copilot-acp",
    endpoint: state.endpoint,
    process: registryProcess(state),
    eventCursor: state.eventCursor,
    protocolVersion: state.protocolVersion,
    writerClaimEpoch,
    activeTurnRef: state.activeTurnRef,
    pendingAttention: state.pendingAttention,
    ...(state.memory ? { memory: state.memory } : {}),
    ...(state.signalDomain ? { signalDomain: state.signalDomain } : {}),
    activeFlags: state.activeFlags,
  };
}

export async function persistCodexHost(
  registry: AgentRegistry,
  key: SessionKey,
  host: CodexAppServerHost,
  claimOwner: string,
  writerClaimEpoch: number,
): Promise<AgentRegistryEntry> {
  const state = await host.health();
  const persisted = registry.setStructuredHostClaimed(
    key,
    codexHostColumns(state, writerClaimEpoch),
    registryStatus(state),
    claimOwner,
    writerClaimEpoch,
  );
  if (!persisted) throw new Error("structured host writer claim is stale");
  return persisted;
}

export interface StructuredHostPersistenceOptions {
  cursorDebounceMs?: number;
  /** Termination ladder seams for the tree a host stop captured (#2790). */
  terminationStop?: StructuredOrphanStopDependencies;
  /** How long a captured tree that outlived its ladder waits before the next one. */
  terminationRetryMs?: number;
}

interface ObservableStructuredHost {
  health(): Promise<HostState>;
  release(): Promise<void>;
  setWriterFence(check: () => boolean): void;
  onStateChange(listener: (state: HostState) => void): () => void;
  setTerminationCapture?(listener: ((root: number, tree: readonly ProcessIdentity[]) => boolean) | null): void;
}

const DEFAULT_TERMINATION_RETRY_MS = 5_000;
const HOST_STOP_SOURCE = "structured-host-stop";

export const DEFAULT_CURSOR_DEBOUNCE_MS = 30_000;

/** The row is held by a termination's captured tree and this writer still owns
    its claim. The write waits; nothing about the host is decided by it. */
class StructuredHostWriteHeld extends Error {
  constructor() { super("structured host row is held by a captured termination tree"); }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameMaterialHostState(left: HostState, right: HostState): boolean {
  return left.status === right.status
    && left.endpoint === right.endpoint
    && left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && isDeepStrictEqual(left.signalDomain, right.signalDomain)
    && left.protocolVersion === right.protocolVersion
    && left.activeTurnRef === right.activeTurnRef
    && sameStrings(left.pendingAttention, right.pendingAttention)
    && (left.providerRetry?.at ?? null) === (right.providerRetry?.at ?? null)
    && (left.memory?.kills ?? 0) === (right.memory?.kills ?? 0)
    && (left.memory?.lastKill?.fatal ?? false) === (right.memory?.lastKill?.fatal ?? false)
    && sameStrings(left.activeFlags, right.activeFlags);
}

async function bindStructuredHostPersistence(
  registry: AgentRegistry,
  key: SessionKey,
  host: ObservableStructuredHost,
  claimOwner: string,
  writerClaimEpoch: number,
  releasedStatus: "unhosted" | "dead",
  columnsFromState: (state: HostState, writerClaimEpoch: number) => StructuredHostColumns,
  options: StructuredHostPersistenceOptions,
): Promise<() => void> {
  host.setWriterFence(() => registry.ownsStructuredHostClaim(key, claimOwner, writerClaimEpoch));
  let lastPersistedState: HostState;
  /* Whether the tree holding the row is the one this host's own stop
     captured. Another stop's capture is that stop's to finish, so this
     binding gives its terminal write up to it; its own it finishes itself. */
  let ownCapture = false;
  const persist = (state: HostState, terminal = false): AgentRegistryEntry => {
    const columns = columnsFromState(state, writerClaimEpoch);
    const persisted = registry.setStructuredHostClaimed(
      key,
      /* `unhosted` releases the writer claim permanently. Keeping its wrapper
         PID would make the released row appear owned for every successor. */
      terminal && state.status === "unhosted" ? { ...columns, process: null } : columns,
      terminal && releasedStatus === "dead" ? "dead" : registryStatus(state),
      claimOwner,
      writerClaimEpoch,
      terminal,
    );
    if (!persisted) {
      /* Two refusals share one null. A captured termination tree holds the row
         while this writer still owns it; a lost claim means another writer does. */
      if ((!terminal || ownCapture) && registry.structuredHostWriteHeldByTermination(key, claimOwner, writerClaimEpoch)) {
        throw new StructuredHostWriteHeld();
      }
      throw new Error("structured host writer claim is stale");
    }
    lastPersistedState = structuredClone(state);
    return persisted;
  };
  try {
    persist(await host.health());
  } catch (error) {
    await host.release();
    throw error;
  }

  const cursorDebounceMs = Number.isFinite(options.cursorDebounceMs)
    ? Math.max(0, options.cursorDebounceMs!)
    : DEFAULT_CURSOR_DEBOUNCE_MS;
  let failed = false;
  let stopped = false;
  let claimReleased = false;
  let pendingState: HostState | null = null;
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe = () => {};
  /* A host stop signals its child's process group, and a tool that left the
     group keeps writing in the worktree after the child exits (#2790). The
     tree the host read before its first signal is captured onto the row, and
     the terminal write that releases this claim waits until the shared ladder
     proves every captured process gone. Until then the row keeps its root,
     its capture and this claim, so no successor can claim it. */
  let heldTerminal: HostState | null = null;
  let settling = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const terminationRetryMs = Number.isFinite(options.terminationRetryMs)
    ? Math.max(0, options.terminationRetryMs!)
    : DEFAULT_TERMINATION_RETRY_MS;
  /* The host signals nothing until this answers true (#2790). A row that
     still records the host's child takes the tree whoever holds its claim:
     the capture is what refuses a successor once the child is gone. Only a
     row that records another process has no place for it, and there the stop
     goes ahead as it always did. A capture the registry refused answers
     false, so the child keeps running and keeps its own fence. */
  host.setTerminationCapture?.((rootPid, tree) => {
    const entry = registry.readOnlySnapshot().entries[sessionKeyId(key)];
    const root = entry?.structuredHost?.process ?? null;
    if (!entry || !root || root.pid !== rootPid) return true;
    if (!root.startIdentity || !root.bootEpoch) return false;
    const prior = (entry.structuredTerminationSurvivors?.length ?? 0) > 0;
    const capture = registry.captureStructuredTerminationSurvivors(key, root, tree, HOST_STOP_SOURCE);
    if (!capture) return false;
    /* Another stop's capture is that stop's to finish, unless this one named
       a process it had not. */
    if (!failed && entry.claimOwner === claimOwner && entry.claimEpoch === writerClaimEpoch
      && (!prior || capture.added.length > 0)) ownCapture = true;
    return true;
  });

  const clearCursorTimer = () => {
    if (cursorTimer === null) return;
    clearTimeout(cursorTimer);
    cursorTimer = null;
  };
  const releaseClaim = () => {
    if (claimReleased) return;
    claimReleased = true;
    registry.releaseStructuredHostClaim(key, claimOwner, writerClaimEpoch);
  };
  const fail = () => {
    if (failed) return;
    failed = true;
    stopped = true;
    pendingState = null;
    clearCursorTimer();
    unsubscribe();
    releaseClaim();
    /* A release that could not record its child's tree sends nothing and
       says so; the child keeps its own fence, so nothing here awaits it. */
    void host.release().catch(() => undefined);
  };
  const persistPending = () => {
    const state = pendingState;
    pendingState = null;
    clearCursorTimer();
    if (state) persist(state);
  };
  const schedulePending = () => {
    if (cursorTimer !== null) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = null;
      if (failed || stopped || pendingState === null) return;
      const state = pendingState;
      try {
        persistPending();
      } catch (error) {
        /* A refused checkpoint has two meanings. Held by a captured termination
           tree while this writer still owns its claim, it waits one more
           period: a withdrawn stop lets it land, and a termination that
           proceeds ends the process itself. Only a lost claim means another
           writer owns the row, and only that ends this host. */
        if (error instanceof StructuredHostWriteHeld) {
          pendingState ??= state;
          schedulePending();
          return;
        }
        fail();
      }
    }, cursorDebounceMs);
    cursorTimer.unref?.();
  };
  const settleHeldTerminal = () => {
    if (settling || failed || heldTerminal === null) return;
    settling = true;
    void endHostStopCapture(registry, key, claimOwner, writerClaimEpoch, options.terminationStop)
      .catch(() => "retry" as const)
      .then((outcome) => {
        settling = false;
        const state = heldTerminal;
        if (failed || state === null) return;
        if (outcome === "lost") {
          heldTerminal = null;
          fail();
          return;
        }
        if (outcome === "settled") {
          try {
            persist(state, true);
            heldTerminal = null;
            claimReleased = true;
            stopped = true;
            unsubscribe();
            return;
          } catch (error) {
            if (!(error instanceof StructuredHostWriteHeld)) {
              heldTerminal = null;
              fail();
              return;
            }
          }
        }
        settleTimer = setTimeout(() => {
          settleTimer = null;
          settleHeldTerminal();
        }, terminationRetryMs);
        settleTimer.unref?.();
      });
  };
  const stop = () => {
    if (stopped) return;
    /* The held terminal write releases the claim once the tree is gone. */
    if (heldTerminal !== null) {
      stopped = true;
      unsubscribe();
      return;
    }
    try {
      persistPending();
    } catch (error) {
      /* A held final checkpoint is dropped; the caller stopping this binding
         keeps deciding about the host. */
      if (!(error instanceof StructuredHostWriteHeld)) {
        fail();
        return;
      }
    }
    stopped = true;
    unsubscribe();
    releaseClaim();
  };

  unsubscribe = host.onStateChange((state) => {
    if (failed || stopped) return;
    const terminal = state.status === "unhosted" || (state.status === "dead" && state.pid === null);
    if (heldTerminal !== null) {
      if (terminal) heldTerminal = structuredClone(state);
      return;
    }
    if (!terminal && sameMaterialHostState(lastPersistedState, state)) {
      pendingState = structuredClone(state);
      schedulePending();
      return;
    }
    pendingState = null;
    clearCursorTimer();
    try {
      persist(state, terminal);
      if (terminal) {
        claimReleased = true;
        stopped = true;
        unsubscribe();
      }
    } catch (error) {
      if (error instanceof StructuredHostWriteHeld) {
        if (terminal) {
          heldTerminal = structuredClone(state);
          settleHeldTerminal();
          return;
        }
        pendingState = structuredClone(state);
        schedulePending();
        return;
      }
      fail();
    }
  });
  if (stopped) unsubscribe();
  return stop;
}

/** Ends what a host stop captured on its own row, once the host's child is
    gone: `settled` when no capture remains, `retry` while one still may run,
    and `lost` when the row or the claim moved on and the capture is no
    longer this binding's to finish. */
async function endHostStopCapture(
  registry: AgentRegistry,
  key: SessionKey,
  claimOwner: string,
  claimEpoch: number,
  dependencies: StructuredOrphanStopDependencies = {},
): Promise<"settled" | "retry" | "lost"> {
  const ours = (entry: AgentRegistryEntry | undefined, root: ProcessIdentity) => Boolean(entry)
    && entry!.structuredHost?.process != null
    && sameRecordedProcessIdentity(entry!.structuredHost.process, root)
    && (entry!.claimOwner === null || (entry!.claimOwner === claimOwner && entry!.claimEpoch === claimEpoch));
  const entry = registry.readOnlySnapshot().entries[sessionKeyId(key)];
  const root = entry?.structuredHost?.process ?? null;
  if (!entry || !root || !ours(entry, root)) return "lost";
  if ((entry.structuredTerminationSurvivors?.length ?? 0) === 0) return "settled";
  if (await endRecordedStructuredTree(registry, key, root, HOST_STOP_SOURCE,
    (current) => ours(current, root), dependencies)) return "settled";
  return ours(registry.readOnlySnapshot().entries[sessionKeyId(key)], root) ? "retry" : "lost";
}

export async function bindCodexHostPersistence(
  registry: AgentRegistry,
  key: SessionKey,
  host: CodexAppServerHost,
  claimOwner: string,
  writerClaimEpoch: number,
  releasedStatus: "unhosted" | "dead" = "unhosted",
  options: StructuredHostPersistenceOptions = {},
): Promise<() => void> {
  return bindStructuredHostPersistence(
    registry,
    key,
    host,
    claimOwner,
    writerClaimEpoch,
    releasedStatus,
    codexHostColumns,
    options,
  );
}

export async function bindClaudeHostPersistence(
  registry: AgentRegistry,
  key: SessionKey,
  host: ClaudeStreamBrokerHost,
  claimOwner: string,
  writerClaimEpoch: number,
  releasedStatus: "unhosted" | "dead" = "unhosted",
  options: StructuredHostPersistenceOptions = {},
): Promise<() => void> {
  return bindStructuredHostPersistence(
    registry,
    key,
    host,
    claimOwner,
    writerClaimEpoch,
    releasedStatus,
    claudeHostColumns,
    options,
  );
}

export async function bindCopilotHostPersistence(
  registry: AgentRegistry,
  key: SessionKey,
  host: CopilotAcpHost,
  claimOwner: string,
  writerClaimEpoch: number,
  releasedStatus: "unhosted" | "dead" = "unhosted",
  options: StructuredHostPersistenceOptions = {},
): Promise<() => void> {
  return bindStructuredHostPersistence(
    registry,
    key,
    host,
    claimOwner,
    writerClaimEpoch,
    releasedStatus,
    copilotHostColumns,
    options,
  );
}

export interface AdoptedCodexHost {
  key: SessionKey;
  host: CodexAppServerHost;
}

export interface AdoptedClaudeHost {
  key: SessionKey;
  host: ClaudeStreamBrokerHost;
}

export type StructuredHostAdoptionFilter = (entry: AgentRegistryEntry) => boolean;
export type StructuredHostAdoptionProgress = (entry: AgentRegistryEntry) => void;
const STRUCTURED_CLAIM_PREFIX = "structured-host:";
const ORPHAN_TERM_GRACE_MS = 250;
const ORPHAN_KILL_GRACE_MS = 1_000;

function claimOwnerBlocksOrphanReap(claimOwner: string | null): boolean {
  if (!claimOwner) return false;
  if (!claimOwner.startsWith(STRUCTURED_CLAIM_PREFIX)) return true;
  let identity: Partial<ProcessIdentity>;
  try { identity = JSON.parse(claimOwner.slice(STRUCTURED_CLAIM_PREFIX.length)) as Partial<ProcessIdentity>; }
  catch { return true; }
  if (!Number.isInteger(identity.pid) || identity.pid! <= 0) return true;
  return processIdentityMayOwn({
    pid: identity.pid!,
    startIdentity: typeof identity.startIdentity === "string" ? identity.startIdentity : null,
    ...(typeof identity.bootEpoch === "string" ? { bootEpoch: identity.bootEpoch } : {}),
  });
}

/** Clears one structured ownership claim only when its recorded engine process
    identity is provably gone. */
export function reconcileDeadStructuredRegistryHost(
  registry: AgentRegistry,
  conversationId: RegistryConversation["id"],
  key: SessionKey,
): boolean {
  const entry = registry.readOnlySnapshot().entries[sessionKeyId(key)];
  const structuredProcess = entry?.structuredHost?.process;
  if (!entry || !structuredProcess) return false;
  return Boolean(registry.terminateInactiveStructuredHost(conversationId, key, {
    process: structuredProcess,
    claimEpoch: entry.claimEpoch,
  }));
}

/** Bounded reconciliation pass for completed conversation rows. Active conversation
    recovery stays demand-driven. `shouldRetain` protects rows the same startup
    pass will re-host; every other terminal row releases its dead process claim.
    By default a row startup holds for its restart cut evidence is retained. */
export function reconcileDeadStructuredRegistryHosts(
  registry: AgentRegistry,
  shouldRetain: StructuredHostAdoptionFilter = (entry) => restartCutEvidenceHolds(sessionKeyId(entry.key)),
): void {
  const snapshot = registry.readOnlySnapshot();
  for (const conversation of Object.values(snapshot.conversations)) {
    if (conversation.turn.state !== "terminal" && !conversation.supersededBy) continue;
    const generation = conversation.generations.at(-1);
    if (!generation) continue;
    const key = { engine: conversation.engine, sessionId: generation.id } as const;
    const entry = snapshot.entries[sessionKeyId(key)];
    if (!entry?.structuredHost?.process || shouldRetain(entry)) continue;
    reconcileDeadStructuredRegistryHost(registry, conversation.id, key);
  }
}

async function waitForVerifiedProcessExit(processIdentity: ProcessIdentity, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!processIdentityProvenDead(processIdentity) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return processIdentityProvenDead(processIdentity);
}

/** Ends one process the registry recorded, fenced on its full identity. A
    recycled pid or boot epoch belongs to another process and receives no signal. */
async function terminateVerifiedProcess(processIdentity: ProcessIdentity): Promise<boolean> {
  const status = processIdentityStatus(processIdentity);
  if (status === "dead") return true;
  if (processIdentity.pid === process.pid || status !== "alive") return false;
  try { process.kill(processIdentity.pid, "SIGTERM"); } catch { /* process exited */ }
  if (await waitForVerifiedProcessExit(processIdentity, ORPHAN_TERM_GRACE_MS)) return true;
  try { process.kill(processIdentity.pid, "SIGKILL"); } catch { /* process exited */ }
  return waitForVerifiedProcessExit(processIdentity, ORPHAN_KILL_GRACE_MS);
}

/** Ends an orphaned engine process and every process it started, fenced on
    the identity the row records, and true only once all of them are proven
    gone (#2790). Signalling the recorded pid alone let a detached shell or
    tool the engine started outlive it, still writing in the worktree, while
    a successor claimed the session beside it; once its parent had exited no
    later walk could find it. So the tree is captured onto the row before the
    first signal and ended through the same ladder an operator kill uses.
    Whatever outlives that ladder stays captured on the row, which refuses
    every claim, so no successor starts and no identity is dropped until a
    later stop confirms each one gone. */
async function terminateVerifiedStructuredOrphan(
  registry: AgentRegistry,
  key: SessionKey,
  processIdentity: ProcessIdentity,
  claimOwner: string | null,
  dependencies: StructuredOrphanStopDependencies = {},
): Promise<boolean> {
  if (claimOwnerBlocksOrphanReap(claimOwner)) return false;
  return endRecordedStructuredTree(registry, key, processIdentity, "structured-orphan-stop",
    (current) => !claimOwnerBlocksOrphanReap(current?.claimOwner ?? null), dependencies);
}

/** Ends the process a row records and every process captured beside it,
    through the shared identity-fenced ladder, and true only once each is
    proven gone. `mayEnd` is asked again before every signal, against the row
    as it is then: a claim taken or the row rebound while the ladder waited
    means the tree is no longer this stop's to end. Whatever outlives the
    ladder stays captured on the row. */
async function endRecordedStructuredTree(
  registry: AgentRegistry,
  key: SessionKey,
  processIdentity: ProcessIdentity,
  source: string,
  mayEnd: (current: AgentRegistryEntry | undefined) => boolean,
  dependencies: StructuredOrphanStopDependencies,
): Promise<boolean> {
  const { startIdentity, bootEpoch } = processIdentity;
  if (!startIdentity || !bootEpoch) return false;
  const engine = key.engine;
  if (engine !== "claude" && engine !== "codex" && engine !== "copilot") return false;
  const { terminateStructuredHostTree } = await import("./structuredHostControl");
  const root: ProcessIdentity = { pid: processIdentity.pid, startIdentity, bootEpoch };
  const recordedDomain = registry.readOnlySnapshot().entries[sessionKeyId(key)]?.structuredHost?.signalDomain;
  const domainProcesses = recordedDomain ? verifiedSignalDomainProcesses(recordedDomain) : [];
  if (!domainProcesses || (recordedDomain && !sameRecordedProcessIdentity(recordedDomain.native, root))) return false;
  let capture: StructuredTerminationCapture | null = null;
  const authorize = (): { status: 409; error: string } | null => {
    const current = registry.readOnlySnapshot().entries[sessionKeyId(key)];
    const recorded = current?.structuredHost?.process ?? null;
    if (!current || !recorded || !sameRecordedProcessIdentity(recorded, root)) {
      return { status: 409, error: "the row no longer records this process" };
    }
    if (!mayEnd(current)) return { status: 409, error: "a live writer claim owns this process" };
    return null;
  };
  const outcome = await terminateStructuredHostTree({
    kind: "structured", pid: root.pid, startIdentity, bootEpoch, engine, sessionId: key.sessionId, conversationId: null,
    seat: null, turnBusy: null, owned: false, lastActiveAt: null,
  }, {
    retainedSurvivors: [...registry.readOnlySnapshot().entries[sessionKeyId(key)]?.structuredTerminationSurvivors ?? [], ...domainProcesses],
    authorize,
    /* No runtime holds this tree: an orphan's claim owner is gone, and a
       host stop's own child has already exited. */
    terminateOwnedHost: async () => false,
    persistCapturedTree: (identities) => {
      capture = registry.captureStructuredTerminationSurvivors(key, root, identities, source);
      return capture !== null;
    },
    withdrawCapturedTree: () => {
      if (capture) registry.withdrawStructuredTerminationSurvivors(key, root, capture, source);
    },
    retireRegistryEntry: (target, expected, confirmed) =>
      registry.settleStructuredTerminationSurvivors(target, expected, confirmed, source),
    ...dependencies,
  });
  if (outcome.ok) return true;
  if (outcome.terminationStarted && outcome.survivors.length > 0) {
    registry.recordStructuredTerminationSurvivors(key, root, outcome.survivors);
  }
  return false;
}

/** Test seams for the termination ladder an orphan stop runs. */
export type StructuredOrphanStopDependencies = Pick<StructuredHostTerminationDependencies,
  "signal" | "sleep" | "graceMs" | "deadlineMs" | "protectedPids">;

/** Stops the engine process a terminal row still records, and everything it
    started, once no live writer claim owns that row, so a claim refused over
    it can be asked again (#2790). The row says its stream is gone: nothing
    can deliver to that process, and a successor started beside it would be a
    second writer in its worktree. True only when every captured process is
    proven gone; survivors stay on the row and refuse the claim. */
export async function stopTerminalStructuredOrphan(
  registry: AgentRegistry,
  key: SessionKey,
  dependencies: StructuredOrphanStopDependencies = {},
): Promise<boolean> {
  const entry = registry.readOnlySnapshot().entries[sessionKeyId(key)];
  const orphan = entry?.structuredHost?.process ?? null;
  if (!entry || !orphan || (entry.status !== "dead" && entry.status !== "unhosted")) return false;
  return terminateVerifiedStructuredOrphan(registry, key, orphan, entry.claimOwner ?? null, dependencies);
}

/**
 * Ends a structured host process that evidence shows is severed, for a caller
 * that has already established nothing in this Viewer owns it (#1282).
 *
 * This is the gap the incident fell into. `terminateInactiveStructuredHost`
 * refuses while the recorded process is alive — correctly, since a live host is
 * usually somebody's live work — and the claim owner is this Viewer itself, so
 * the orphan reap above refuses too. A host adopted at boot but never claimed by
 * the delivery controller satisfies both refusals at once and becomes
 * unkillable: the operator's kill effect blocks the conversation's whole drain
 * forever, taking every message queued behind it with it.
 *
 * The two fences that make the signal safe are independent of each other: the
 * caller has proven no registration resolves this host, and the liveness
 * decision has proven from process and transcript evidence that the turn is
 * severed (#1281). A host that is working, or that cannot be shown not to be,
 * is left strictly alone.
 */
export async function reapSeveredStructuredHost(
  registry: AgentRegistry,
  conversationId: RegistryConversation["id"],
  key: SessionKey,
  dependencies: TurnLivenessDependencies = {},
): Promise<{ reaped: boolean; reason: string } | null> {
  const entry = registry.readOnlySnapshot().entries[sessionKeyId(key)];
  const structuredProcess = entry?.structuredHost?.process;
  if (!structuredProcess) return null;
  const liveness = await conversationTurnLiveness(registry, conversationId, dependencies);
  if (liveness?.state !== "severed") return null;
  if (sessionKeyId(liveness.key) !== sessionKeyId(key)) return null;
  return { reaped: await terminateVerifiedProcess(structuredProcess), reason: liveness.reason };
}

/** Reconciles claimable structured ownership for rows excluded by startup adoption. */
export async function demoteSkippedStructuredRegistryHosts(
  registry: AgentRegistry,
  shouldAdopt: StructuredHostAdoptionFilter,
  admit: <T>(entry: AgentRegistryEntry, mutation: () => T) => Promise<T | undefined> = async (_entry, mutation) => mutation(),
  orphanStop: StructuredOrphanStopDependencies = {},
): Promise<void> {
  const rows = Object.values(registry.readOnlySnapshot().entries).filter((entry) =>
    entry.structuredHost && !shouldAdopt(entry));
  for (const [index, entry] of rows.entries()) {
    if (index > 0 && index % 16 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const host = entry.structuredHost!;
    const alreadyDead = entry.status === "dead"
      && host.process === null
      && entry.claimOwner === null
      && host.endpoint === "stdio:released"
      && host.activeTurnRef === null
      && host.pendingAttention.length === 0
      && host.activeFlags.length === 0;
    if (alreadyDead) continue;
    const conversation = registry.conversationForPath(entry.artifactPath);
    if (conversation) {
      const reconciled = await admit(entry, () => reconcileDeadStructuredRegistryHost(registry, conversation.id, entry.key));
      if (reconciled === undefined || reconciled) continue;
    }
    const owner = captureProcessIdentity(process.pid);
    try {
      await registry.withOperationLock(entry.key, owner, async () => {
        const current = registry.readOnlySnapshot().entries[sessionKeyId(entry.key)];
        if (!current?.structuredHost || shouldAdopt(current)) return;
        /* A PID-only claim cannot prove ownership across reboot. Runtime and
           transcript signals already excluded this row from adoption, so the
           startup demotion may replace that unverifiable owner and settle the
           retained receipt through the ordinary terminal path. */
        let claimed = await admit(entry, () => registry.claimStructuredHost(entry.key, owner, {
          allowUnhosted: true,
          reclaimUnverifiedOwner: true,
        }));
        if (claimed === undefined) return;
        if (!claimed) {
          const current = registry.readOnlySnapshot().entries[sessionKeyId(entry.key)];
          const orphan = current?.structuredHost?.kind === "claude-broker"
            ? current.structuredHost.process
            : null;
          if (orphan && current && !shouldAdopt(current)
            && await terminateVerifiedStructuredOrphan(registry, entry.key, orphan, current.claimOwner ?? null, orphanStop)) {
            claimed = await admit(entry, () => registry.claimStructuredHost(entry.key, owner, {
              allowUnhosted: true,
              reclaimUnverifiedOwner: true,
            }));
          }
        }
        if (!claimed?.structuredHost || !claimed.claimOwner) return;
        const claim = claimed;
        const columns = claimed.structuredHost;
        const demoted = await admit(entry, () => registry.setStructuredHostClaimed(entry.key, {
          ...columns,
          endpoint: "stdio:released",
          process: null,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        }, "dead", claim.claimOwner!, claim.claimEpoch, true));
        if (demoted === undefined) {
          registry.releaseStructuredHostClaim(entry.key, claim.claimOwner!, claim.claimEpoch);
          return;
        }
        if (!demoted) throw new Error("structured host writer claim is stale");
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "agent registry is busy") {
        if (error instanceof Error) Object.assign(error, { hostKey: sessionKeyId(entry.key) });
        throw error;
      }
    }
  }
}

/** Boot seam: resume selected durable Codex rows when structured hosting is enabled. */
export async function adoptCodexRegistryHosts(
  registry: AgentRegistry,
  optionsFor: (entry: AgentRegistryEntry) => CodexAppServerHostOptions,
  env: NodeJS.ProcessEnv = process.env,
  shouldAdopt: StructuredHostAdoptionFilter = () => true,
  processed?: StructuredHostAdoptionProgress,
  dependencies: {
    adoptHost?: (sessionId: string, options: CodexAppServerHostOptions) => Promise<CodexAppServerHost>;
    onAdopted?: (item: AdoptedCodexHost) => void;
    claimHost?: (entry: AgentRegistryEntry, owner: ProcessIdentity) => Promise<AgentRegistryEntry | null>;
    /** The ownership check before `adopt`; production resolves the tasks. */
    admit?: (entry: AgentRegistryEntry, snapshot: RegistryFile) => { error: string } | null;
    /** Termination ladder seams for an orphan stopped before adoption (#2790). */
    orphanStop?: StructuredOrphanStopDependencies;
  } = {},
): Promise<AdoptedCodexHost[]> {
  if (!structuredHostsEnabled(env)) return [];
  const rows = Object.values(registry.readOnlySnapshot().entries).filter((entry) =>
    entry.key.engine === "codex"
    && entry.structuredHost?.kind === "codex-app-server"
    && shouldAdopt(entry));
  const adopted: AdoptedCodexHost[] = [];
  for (const [index, entry] of rows.entries()) {
    if (index > 0 && index % 16 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const owner = captureProcessIdentity(process.pid);
    try {
      await registry.withOperationLock(entry.key, owner, async () => {
        const current = registry.readOnlySnapshot().entries[sessionKeyId(entry.key)];
        if (!current?.structuredHost || !shouldAdopt(current)) return;
        let claimed = (dependencies.claimHost ? await dependencies.claimHost(entry, owner) : registry.claimStructuredHost(entry.key, owner, { allowUnhosted: true }));
        if (!claimed) {
          const current = registry.readOnlySnapshot().entries[sessionKeyId(entry.key)];
          const orphan = current?.structuredHost?.kind === "codex-app-server"
            ? current.structuredHost.process
            : null;
          if (orphan
            && current
            && shouldAdopt(current)
            && await terminateVerifiedStructuredOrphan(registry, entry.key, orphan, current.claimOwner ?? null, dependencies.orphanStop)) {
            const retry = registry.readOnlySnapshot().entries[sessionKeyId(entry.key)];
            if (!retry?.structuredHost || !shouldAdopt(retry)) return;
            claimed = (dependencies.claimHost ? await dependencies.claimHost(entry, owner) : registry.claimStructuredHost(entry.key, owner, { allowUnhosted: true }));
          }
        }
        if (!claimed?.structuredHost) return;
        if (!shouldAdopt(claimed)) {
          registry.releaseStructuredHostClaim(entry.key, claimed.claimOwner!, claimed.claimEpoch);
          return;
        }
        /* M.4 seam 4: reopening the process is new work for every task the
           conversation holds; one that runs on another linked machine leaves
           the row stopped and opens nothing. */
        const refused = (dependencies.admit ?? adoptionRefusal)(claimed, registry.readOnlySnapshot());
        if (refused) {
          console.error(`[linked boards] boot adoption of ${sessionKeyId(entry.key)} refused: ${refused.error}`);
          registry.setStructuredHostClaimed(entry.key, {
            ...claimed.structuredHost,
            endpoint: "stdio:released",
            process: null,
            activeTurnRef: null,
            pendingAttention: [],
            activeFlags: [],
          }, "dead", claimed.claimOwner!, claimed.claimEpoch, true);
          return;
        }
        try {
          const options = {
            ...optionsFor(claimed),
            initialEventCursor: claimed.structuredHost.eventCursor,
          };
          /* The production static method calls `this.open`; keep its class
             receiver instead of extracting it into an unbound function. */
          const host = dependencies.adoptHost
            ? await dependencies.adoptHost(entry.key.sessionId, options)
            : await CodexAppServerHost.adopt(entry.key.sessionId, options);
          await bindCodexHostPersistence(registry, entry.key, host, claimed.claimOwner!, claimed.claimEpoch);
          adopted.push({ key: entry.key, host });
          dependencies.onAdopted?.({ key: entry.key, host });
        } catch (error) {
          if (error instanceof StructuredHostAdoptionCleanupError
            && error.host instanceof CodexAppServerHost) {
            try {
              await bindCodexHostPersistence(
                registry,
                entry.key,
                error.host,
                claimed.claimOwner!,
                claimed.claimEpoch,
                "dead",
              );
              await error.host.release();
            } catch { /* retain the live process and claim until its late reap is observed */ }
            return;
          }
          // A refused cell (work that cannot be contained) or a failed open; the next message relaunches it.
          console.error(`[structured hosts] boot adoption of ${sessionKeyId(entry.key)} failed: ${error instanceof Error ? error.message : String(error)}`);
          registry.setStructuredHostClaimed(entry.key, {
            ...claimed.structuredHost,
            endpoint: "stdio:released",
            process: null,
            activeTurnRef: null,
            pendingAttention: [],
            activeFlags: [],
          }, "dead", claimed.claimOwner!, claimed.claimEpoch, true);
        }
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "agent registry is busy") {
        if (error instanceof Error) Object.assign(error, { hostKey: sessionKeyId(entry.key) });
        throw error;
      }
    } finally {
      processed?.(entry);
    }
  }
  return adopted;
}


/** Boot seam: resume selected durable Claude broker rows when structured hosting is enabled. */
export async function adoptClaudeRegistryHosts(
  registry: AgentRegistry,
  optionsFor: (entry: AgentRegistryEntry) => ClaudeStreamBrokerHostOptions,
  env: NodeJS.ProcessEnv = process.env,
  shouldAdopt: StructuredHostAdoptionFilter = () => true,
  processed?: StructuredHostAdoptionProgress,
  dependencies: {
    adoptHost?: (sessionId: string, options: ClaudeStreamBrokerHostOptions) => Promise<ClaudeStreamBrokerHost>;
    onAdopted?: (item: AdoptedClaudeHost) => void;
    claimHost?: (entry: AgentRegistryEntry, owner: ProcessIdentity) => Promise<AgentRegistryEntry | null>;
    /** The ownership check before `adopt`; production resolves the tasks. */
    admit?: (entry: AgentRegistryEntry, snapshot: RegistryFile) => { error: string } | null;
    /** Termination ladder seams for an orphan stopped before adoption (#2790). */
    orphanStop?: StructuredOrphanStopDependencies;
  } = {},
): Promise<AdoptedClaudeHost[]> {
  if (!structuredHostsEnabled(env)) return [];
  const rows = Object.values(registry.readOnlySnapshot().entries).filter((entry) =>
    entry.key.engine === "claude"
    && entry.structuredHost?.kind === "claude-broker"
    && shouldAdopt(entry));
  const adopted: AdoptedClaudeHost[] = [];
  for (const [index, entry] of rows.entries()) {
    if (index > 0 && index % 16 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const owner = captureProcessIdentity(process.pid);
    try {
      await registry.withOperationLock(entry.key, owner, async () => {
        const eligible = registry.readOnlySnapshot().entries[sessionKeyId(entry.key)];
        if (!eligible?.structuredHost || !shouldAdopt(eligible)) return;
        let claimed = (dependencies.claimHost ? await dependencies.claimHost(entry, owner) : registry.claimStructuredHost(entry.key, owner, { allowUnhosted: true }));
        if (!claimed) {
          const current = registry.readOnlySnapshot().entries[`claude:${entry.key.sessionId}`];
          const orphan = current?.structuredHost?.kind === "claude-broker"
            ? current.structuredHost.process
            : null;
          if (orphan
            && current
            && shouldAdopt(current)
            && await terminateVerifiedStructuredOrphan(registry, entry.key, orphan, current.claimOwner ?? null, dependencies.orphanStop)) {
            const retry = registry.readOnlySnapshot().entries[sessionKeyId(entry.key)];
            if (!retry?.structuredHost || !shouldAdopt(retry)) return;
            claimed = (dependencies.claimHost ? await dependencies.claimHost(entry, owner) : registry.claimStructuredHost(entry.key, owner, { allowUnhosted: true }));
          }
        }
        if (!claimed?.structuredHost) return;
        if (!shouldAdopt(claimed)) {
          registry.releaseStructuredHostClaim(entry.key, claimed.claimOwner!, claimed.claimEpoch);
          return;
        }
        /* M.4 seam 4: reopening the process is new work for every task the
           conversation holds; one that runs on another linked machine leaves
           the row stopped and opens nothing. */
        const refused = (dependencies.admit ?? adoptionRefusal)(claimed, registry.readOnlySnapshot());
        if (refused) {
          console.error(`[linked boards] boot adoption of ${sessionKeyId(entry.key)} refused: ${refused.error}`);
          registry.setStructuredHostClaimed(entry.key, {
            ...claimed.structuredHost,
            endpoint: "stdio:released",
            process: null,
            activeTurnRef: null,
            pendingAttention: [],
            activeFlags: [],
          }, "dead", claimed.claimOwner!, claimed.claimEpoch, true);
          return;
        }
        try {
          const options = {
            ...optionsFor(claimed),
            initialEventCursor: claimed.structuredHost.eventCursor,
          };
          /* Claude adoption has the same receiver-bound static open seam. */
          const host = dependencies.adoptHost
            ? await dependencies.adoptHost(entry.key.sessionId, options)
            : await ClaudeStreamBrokerHost.adopt(entry.key.sessionId, options);
          await bindClaudeHostPersistence(registry, entry.key, host, claimed.claimOwner!, claimed.claimEpoch);
          adopted.push({ key: entry.key, host });
          dependencies.onAdopted?.({ key: entry.key, host });
        } catch (error) {
          if (error instanceof StructuredHostAdoptionCleanupError
            && error.host instanceof ClaudeStreamBrokerHost) {
            try {
              await bindClaudeHostPersistence(
                registry,
                entry.key,
                error.host,
                claimed.claimOwner!,
                claimed.claimEpoch,
                "dead",
              );
              await error.host.release();
            } catch { /* retain the live process and claim until its late reap is observed */ }
            return;
          }
          // A refused cell (work that cannot be contained) or a failed open; the next message relaunches it.
          console.error(`[structured hosts] boot adoption of ${sessionKeyId(entry.key)} failed: ${error instanceof Error ? error.message : String(error)}`);
          registry.setStructuredHostClaimed(entry.key, {
            ...claimed.structuredHost,
            endpoint: "stdio:released",
            process: null,
            activeTurnRef: null,
            pendingAttention: [],
            activeFlags: [],
          }, "dead", claimed.claimOwner!, claimed.claimEpoch, true);
        }
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "agent registry is busy") {
        if (error instanceof Error) Object.assign(error, { hostKey: sessionKeyId(entry.key) });
        throw error;
      }
    } finally {
      processed?.(entry);
    }
  }
  return adopted;
}
