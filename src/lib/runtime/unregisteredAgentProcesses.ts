import fs from "node:fs";
import { constants } from "node:os";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { structuredClaimIdentity, type AgentRegistry } from "@/lib/agent/registry";
import { registryHasStructuredProcess, registryKeysMatchingBounded } from "@/lib/agent/sqliteRegistryStore";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { observeAgentProcess } from "@/lib/agentState/process";
import { AgentTranscriptCache, fileSignature } from "@/lib/agentState/transcript";
import { procBackend } from "@/lib/proc";
import { captureProcessIdentity, sameRecordedProcessIdentity, type ProcessIdentity } from "@/lib/processIdentity";
import { withRecordedHostFence } from "@/lib/recordedChecks/hostFence";
import { recordedOwnerHeld } from "@/lib/recordedChecks/store";
import type { RuntimeHostClient } from "./client";
import type { RuntimeOperationCommand } from "@/lib/runtime/contracts";
import { readHostExit, readHostExitWriterBinding, recordHostStop, withHostStopOrigin } from "./hostExit";
import { blockingHostActivityFlags } from "./hostActivityFlags";
import { idleRetirementSession, OPEN_RETIREMENT_DELIVERIES, OPEN_SPAWN_RECEIPTS,
  retirementJournalEvidence, TERMINAL_SPAWN_RECEIPTS } from "./retirementOperation";

const PAGE_SIZE = 512;
const PROBE_LIMIT = 4;
const GRACE_MS = 1_000;
const transcripts = new AgentTranscriptCache(16);
let procDirectory: fs.Dir | undefined;

/** The kernel supplies the page cursor. A pass can advance through unrelated
 * processes without storing the machine's process table in the Viewer. */
async function* procPage(): AsyncGenerator<number> {
  const directory = procDirectory ??= await fs.promises.opendir("/proc");
  try {
    for (let index = 0; index < PAGE_SIZE; index++) {
      const row = await directory.read();
      if (!row) {
        procDirectory = undefined;
        await directory.close();
        return;
      }
      if (/^[1-9]\d*$/.test(row.name)) yield Number(row.name);
    }
  } catch (error) {
    if (procDirectory === directory) procDirectory = undefined;
    await directory.close().catch(() => undefined);
    throw error;
  }
}

async function* admittedPids(source: AsyncIterable<number>, admit: () => boolean): AsyncGenerator<number> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    // Check before pulling a PID. Dropping the next PID after exhausting
    // probes can skip the same process every time the directory wraps.
    while (admit()) {
      const next = await iterator.next();
      if (next.done || !admit()) return;
      yield next.value;
    }
  } finally {
    await iterator.return?.();
  }
}

function executableSignature(pid: number): string | null {
  try {
    return fileSignature(fs.statSync(`/proc/${pid}/exe`, { bigint: true }));
  } catch { return null; }
}

function launchDigest(pid: number): string | null {
  // The native environment authenticates the launch join. Read it only after
  // the independent native waiter has established installation custody.
  try {
    const fd = fs.openSync(`/proc/${pid}/environ`, "r");
    try {
      const bytes = Buffer.alloc(128 * 1024);
      const size = fs.readSync(fd, bytes);
      const matches = bytes.subarray(0, size).toString("utf8").split("\0").slice(0, -1)
        .filter(value => /^LLV_SPAWN_CAPABILITY=[\w-]{43}$/.test(value));
      return matches.length === 1 ? createHash("sha256").update(matches[0]!.slice("LLV_SPAWN_CAPABILITY=".length)).digest("hex") : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

interface NativeCustody {
  identities: ProcessIdentity[];
  scopeEngine: "claude" | "codex" | null;
}

export function agentScopeEngine(cgroup: string): "claude" | "codex" | null {
  const engine = /^0::\/(?:[^\n]*\/)?delegatus-agents\.slice\/(?:delegatus-agents-work\.slice\/)?delegatus-agent-(claude|codex)-[a-f0-9]{12}\.scope$/.exec(cgroup)?.[1];
  return engine === "claude" || engine === "codex" ? engine : null;
}

/** Read a bounded chain and then verify every link against the recorded
 * waiter and the captured process identities. No name or cwd grants custody. */
function nativeAncestry(native: ProcessIdentity, waiter: ProcessIdentity): NativeCustody | null {
  if (native.pid === waiter.pid) return null;
  const chain = [native];
  while (chain.length < 32) {
    const ppid = procBackend.readPpid(chain.at(-1)!.pid);
    if (ppid === null) break;
    chain.push(captureProcessIdentity(ppid));
  }
  if (chain.length === 32 || !chain.every((identity, index) => observeAgentProcess(identity) === "alive"
    && procBackend.readPpid(identity.pid) === (chain[index + 1]?.pid ?? null))) return null;
  if (chain.some(identity => sameRecordedProcessIdentity(identity, waiter))) {
    return { identities: chain, scopeEngine: null };
  }
  // A dedicated launch scope can keep the exact native CLI alive after its
  // waiter exits. The scope is only a discovery hint: readLaunch below still
  // requires the launch capability and durable native process identity.
  try {
    const cgroup = (pid: number) => fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
    const group = cgroup(native.pid);
    const engine = agentScopeEngine(group);
    if (!engine) return null;
    return { identities: [...chain, waiter], scopeEngine: engine };
  } catch { return null; }
}

function openPidfdLibrary() {
  try {
    // Viewer bundles also load under Node. Resolve the optional Bun builtin
    // at the Linux signal boundary, as the registry does for bun:sqlite.
    const ffi = process.getBuiltinModule?.("bun:ffi") as typeof import("bun:ffi") | undefined;
    return ffi?.dlopen("libc.so.6", {
      pidfd_open: { args: ["i32", "u32"], returns: "i32" },
      pidfd_send_signal: { args: ["i32", "i32", "ptr", "u32"], returns: "i32" },
    }) ?? null;
  } catch { return null; }
}
let pidfds: ReturnType<typeof openPidfdLibrary> | undefined;

interface OrphanSweepPorts {
  registry: AgentRegistry;
  ready(): boolean;
  noLocalWork(key: SessionKey, conversationId: string): boolean;
  treeIdle(identity: ProcessIdentity): boolean;
  client: Pick<RuntimeHostClient, "readSession" | "operationStatus" | "command">;
  pids?: AsyncIterable<number>;
  now?: () => number;
  idleMs: number;
}

export interface UnregisteredAgentOutcome {
  launchId: string;
  key: string;
  process: ProcessIdentity;
  outcome: "stopped" | "unresolved";
}

function readLaunch(ports: OrphanSweepPorts, native: ProcessIdentity, digest: string,
  ancestry: NativeCustody) {
  return ports.registry.agentStateRead(file => {
    if (registryHasStructuredProcess(file, ancestry.identities.map(identity => identity.pid))) return null;
    const [id, conflict] = registryKeysMatchingBounded(file, "receipts", [{ field: "spawnCapabilityDigest", value: digest }], 2);
    const receipt = id && !conflict ? file.receipts[id] : null;
    if (!receipt?.key || !receipt.artifactPath || (receipt.engine !== "claude" && receipt.engine !== "codex")
      || receipt.key.engine !== receipt.engine || (ancestry.scopeEngine && ancestry.scopeEngine !== receipt.engine)
      || receipt.transport !== "structured" || !TERMINAL_SPAWN_RECEIPTS.has(receipt.state)
      || receipt.queuedPinnedSpawn || receipt.pendingSpawnCapability
      || receipt.admissionOwner && observeAgentProcess(receipt.admissionOwner) !== "dead"
      || receipt.hostSetup?.adoptionClaimEpoch !== undefined && !receipt.hostSetup.cleanupConfirmed) return null;
    const engine = receipt.engine;
    const key = sessionKeyId(receipt.key);
    const entry = file.entries[key];
    if (entry && entry.artifactPath !== receipt.artifactPath) return null;
    // Positive evidence survives the release that cleared the live PID slot.
    // An inherited capability may name the same launch from a child. Require
    // the native identity recorded during setup or retained by this host row.
    if (!receipt.hostSetup?.processes.some(identity => identity.bootEpoch && sameRecordedProcessIdentity(native, identity))
      && !(entry?.structuredHostOperationId === receipt.launchId && entry.hostExitProcess?.bootEpoch
        && sameRecordedProcessIdentity(native, entry.hostExitProcess))) return null;
    const pathRows = registryKeysMatchingBounded(file, "entries", [{ field: "artifactPath", value: receipt.artifactPath }], 33);
    if (pathRows.length > 32 || pathRows.some(id => {
      const row = file.entries[id];
      if (!row || (row.status !== "dead" && row.status !== "unhosted") || row.host || row.pendingAction
        || row.structuredHost?.process || row.structuredHost?.scope || row.structuredHost?.memory?.unit
        || row.structuredTerminationSurvivors?.length
        || row.paneAgent && observeAgentProcess(row.paneAgent) !== "dead"
        || row.structuredHost?.activeTurnRef || row.structuredHost?.pendingAttention.length
        || blockingHostActivityFlags(row.structuredHost?.activeFlags ?? []).length) return true;
      const owner = row.claimOwner && structuredClaimIdentity(row.claimOwner);
      return !!row.claimOwner && (!owner || observeAgentProcess(owner) !== "dead");
    })) return null;
    const conversationId = receipt.conversationId;
    // A generation or alias replacement has independent owners. Only a
    // complete current generation join supports an automatic orphan stop.
    if (file.conversationAliases[conversationId] || registryKeysMatchingBounded(file, "conversationAliases",
      [{ field: "alias", value: conversationId }], 1).length) return null;
    const conversation = file.conversations[conversationId];
    const generation = conversation?.generations.at(-1);
    if (!conversation || conversation.supersededBy || conversation.engine !== engine
      || generation?.id !== receipt.key.sessionId || generation.path !== receipt.artifactPath
      || !["idle", "terminal"].includes(conversation.turn.state)
      || conversation.migration && !["committed", "rolled-back"].includes(conversation.migration.phase)) return null;
    if (registryKeysMatchingBounded(file, "receipts", [{ field: "conversationId", value: conversationId },
      { field: "state", value: OPEN_SPAWN_RECEIPTS }], 1).length
      || registryKeysMatchingBounded(file, "receipts", [{ field: "key.sessionId", value: receipt.key.sessionId },
        { field: "state", value: OPEN_SPAWN_RECEIPTS }], 1).length
      || registryKeysMatchingBounded(file, "heldDeliveries", [{ field: "conversationId", value: conversationId },
        { field: "state", value: OPEN_RETIREMENT_DELIVERIES }], 1).length) return null;
    const deliveryOwner = file.deliveryOperationOwners[`spawn_message_${receipt.launchId}`];
    if (deliveryOwner && (deliveryOwner.conversationId !== conversationId || !deliveryOwner.terminalState)) return null;
    // Re-read the authority fields under the same registry transaction.
    // Normalized profiles and lazy row objects can differ between reads of
    // the same durable state. Their presentation fields grant no custody.
    return {
      launchId: receipt.launchId, engine, key: { ...receipt.key }, conversationId, artifactPath: receipt.artifactPath,
      turn: { ...conversation.turn },
      receiptState: receipt.state,
      admittedAt: receipt.hostSetupStartedAt ?? receipt.createdAt,
      admissionOwner: receipt.admissionOwner ? { ...receipt.admissionOwner } : null,
      setupIdentities: receipt.hostSetup?.processes.map(identity => ({ ...identity })) ?? null,
      entryStatus: entry?.status ?? null,
      claimOwner: entry?.claimOwner ?? null,
      claimEpoch: entry?.claimEpoch ?? null,
      exitProcess: entry?.hostExitProcess ? { ...entry.hostExitProcess } : null,
      migrationRevision: conversation.migration?.revision ?? null,
    };
  });
}

/** Separate discovery from the registered retirement ladder. This process
 * has no live host row to release or entire process group to claim. Signal
 * only the exact native CLI, after durably journaling the stop for its waiter. */
export async function reconcileUnregisteredAgentProcesses(ports: OrphanSweepPorts): Promise<UnregisteredAgentOutcome[]> {
  if (process.platform !== "linux" || !ports.ready() || !ports.client.readSession) return [];
  const readSession = ports.client.readSession.bind(ports.client);
  const outcomes: UnregisteredAgentOutcome[] = [];
  const now = ports.now ?? Date.now;
  const protectedPids = new Set<number>();
  let ancestor: number | null = process.pid;
  while (ancestor !== null && protectedPids.size < 32) {
    protectedPids.add(ancestor);
    ancestor = procBackend.readPpid(ancestor);
  }
  if (ancestor !== null) return [];
  let probes = 0;
  for await (const pid of admittedPids(ports.pids ?? procPage(), () => ports.ready() && probes < PROBE_LIMIT)) {
    if (!ports.ready()) break;
    if (!Number.isSafeInteger(pid) || pid <= 1 || protectedPids.has(pid)) continue;
    const native = captureProcessIdentity(pid);
    const binding = readHostExitWriterBinding(native);
    const ancestry = binding && nativeAncestry(native, binding.process);
    if (!binding || !ancestry) continue;
    // Installed CLI commands can resolve to a versioned executable. The
    // native waiter and retained launch identify it, and this signature
    // guards an exec in the same PID while reconciliation is awaiting reads.
    const executable = executableSignature(pid);
    if (!executable) continue;
    const digest = launchDigest(pid);
    if (!digest) continue;
    const launch = readLaunch(ports, native, digest, ancestry);
    if (!launch || !ports.noLocalWork(launch.key, launch.conversationId)) continue;
    probes++;
    const current = () => {
      if (!ports.ready() || !ports.noLocalWork(launch.key, launch.conversationId) || recordedOwnerHeld(native)) return false;
      const owner = readHostExitWriterBinding(native);
      const chain = owner && sameRecordedProcessIdentity(owner.process, binding.process) && nativeAncestry(native, owner.process);
      return !!chain && executableSignature(pid) === executable && launchDigest(pid) === digest
        && isDeepStrictEqual(readLaunch(ports, native, digest, chain), launch) && ports.treeIdle(native);
    };
    if (!current()) continue;
    const transcript = await transcripts.acquire({ engine: launch.engine, path: launch.artifactPath, revision: launch.launchId,
      localRef: null, observedAt: now() });
    if (!current() || !transcript.transcript.determined || !transcript.turn.determined
      || transcript.turn.value.state !== "closed" || now() - transcript.transcript.value.mtimeMs < ports.idleMs) continue;
    const signature = transcript.transcript.value.signature;
    const authorized = () => {
      if (!current()) return false;
      try { return fileSignature(fs.statSync(launch.artifactPath, { bigint: true })) === signature; }
      catch { return false; }
    };
    const verifyRuntime = async () => {
      if (!authorized()) return false;
      const evidence = await retirementJournalEvidence(ports.client.operationStatus.bind(ports.client),
        launch.launchId, launch.conversationId, authorized);
      if (!evidence.settled || !authorized()) return false;
      try {
        const session = await readSession({ conversationId: launch.conversationId, artifactPath: launch.artifactPath }, { timeoutMs: 500 });
        return authorized() && !!session && idleRetirementSession(session, launch.conversationId, launch.key, launch.artifactPath);
      } catch { return false; }
    };
    const send = async (signal: "SIGTERM" | "SIGKILL") => {
      if (pidfds === undefined) pidfds = openPidfdLibrary();
      const libc = pidfds;
      if (!libc || !authorized() || !await verifyRuntime() || !authorized()) return false;
      // The journal transaction is the admission fence: a send that committed
      // first makes this idle-only kill refuse; once this kill is pending,
      // retirementInProgress prevents new sends until this exact signal ends.
      const session = await readSession({ conversationId: launch.conversationId, artifactPath: launch.artifactPath }, { timeoutMs: 500 });
      if (!authorized() || !session || !idleRetirementSession(session, launch.conversationId, launch.key, launch.artifactPath)
        || session.retirementBlocked !== false || !Number.isSafeInteger(session.revision) || !session.writerClaim) return false;
      const retirementId = `unregistered-retirement-${launch.launchId}`;
      let admitted;
      try {
        admitted = await ports.client.command({
          kind: "kill", operationId: retirementId, idempotencyKey: retirementId,
          conversationId: launch.conversationId, sessionKey: launch.key,
          onlyIfIdle: { revision: session.revision, writerClaim: session.writerClaim },
        } satisfies RuntimeOperationCommand);
      } catch { return false; }
      if (!authorized() || !["pending", "queued", "delivering", "delivered"].includes(admitted.receipt.status)) return false;
      const latest = await ports.client.operationStatus(retirementId, { timeoutMs: 500 });
      if (!authorized() || !latest || latest.operationId !== retirementId
        || latest.receipt.operationId !== retirementId
        || !["pending", "queued", "delivering", "delivered"].includes(latest.receipt.status)) return false;
      return ports.registry.deliveryWriteOrBusy({ label: "registry.unregistered-agent-stop", operationId: launch.launchId }, () => {
        if (!authorized()) return false;
        const fd = libc.symbols.pidfd_open(pid, 0);
        if (fd < 0) return false;
        try {
          if (!authorized()) return false;
          const origin = { path: "unregistered-agent-reconciliation", operationId: launch.launchId };
          const withdraw = withHostStopOrigin(origin, () => recordHostStop(native, signal, origin.path));
          const recorded = readHostExit(native)?.stop;
          if (recorded?.path === origin.path && recorded.operationId === origin.operationId && recorded.signal === signal
            && authorized() && libc.symbols.pidfd_send_signal(fd, constants.signals[signal], null, 0) === 0) return true;
          withdraw?.();
          return false;
        } finally { fs.closeSync(fd); }
      });
    };
    const gone = async () => {
      const until = performance.now() + GRACE_MS;
      while (ports.ready() && observeAgentProcess(native) === "alive" && performance.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return observeAgentProcess(native) === "dead";
    };
    try {
      const result = await withRecordedHostFence(native, async () => {
        if (!await send("SIGTERM")) return null;
        if (await gone() || await send("SIGKILL") && await gone()) return "stopped";
        return "unresolved";
      }, { waitMs: 50 });
      if (result) outcomes.push({ launchId: launch.launchId, key: sessionKeyId(launch.key), process: native, outcome: result });
    } catch {
      if (readHostExit(native)?.stop?.operationId === launch.launchId) {
        outcomes.push({ launchId: launch.launchId, key: sessionKeyId(launch.key), process: native, outcome: "unresolved" });
      }
    }
  }
  return outcomes;
}
