import { registryLivenessRows, registryRowProjection, registryRowsMatching, type RegistryRowProjector } from "@/lib/agent/sqliteRegistryStore";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  entryIsLive,
  identityAlive,
  livenessProbe,
  receiptIsLive,
  staleUndeliverableHeldDeliveryIds,
  type AccountLivenessOptions,
  type LivenessProbe,
} from "@/lib/agent/accountLiveness";
import { agentRegistry, type AgentRegistry, type RegistryConversation, type RegistryFile } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { forEachCooperatively } from "@/lib/cooperative";
import { loadFlows } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";
import {
  MIGRATION_INTENT_PROGRESS_TIMEOUT_MS,
  migrationIntentIsStale,
  ROLLED_BACK_MIGRATION_DELIVERY_REASON,
} from "@/lib/accounts/migration/intentLiveness";
import { procBackend } from "@/lib/proc";
import { readJsonCache, writeJsonDurably } from "@/lib/state/durableJson";
import { runtimeHostClient } from "@/lib/runtime/client";
import { reconcileDeadStructuredRegistryHostsOffLoop } from "@/lib/runtime/registry";
import { terminalizeStaleStructuredSpawns } from "@/lib/runtime/structuredSpawn";
import { isNativeCodexSubagentTranscript } from "@/lib/scanner/codexNative";
import { scanUserAuthoredMessagesCooperatively } from "@/lib/session/reader";
import type { FileEntry } from "@/lib/types";

import {
  evaluateReaper,
  runEvaluatedReaper,
  type HeadlessReviewerProcess,
  type ReaperAgentReport,
  type ReaperInput,
  type ReaperJournalRecord,
  type ReaperReport,
} from "./reaper";

/* Authorship proof budgets for one controller cycle (#287). */
const AUTHORSHIP_PATH_PASS_BYTES = 4 * 1024 * 1024;
const AUTHORSHIP_CYCLE_BUDGET_BYTES = 32 * 1024 * 1024;

const REPORT_FILE = () => statePath("reaper-report.json");
const STATE_FILE = () => statePath("reaper-state.json");
const JOURNAL_FILE = () => statePath("reaper-journal.ndjson");
const ROTATE_BYTES = 4 * 1024 * 1024;

interface ReaperState {
  version: 1;
  firstObservedAt: Record<string, string>;
  userAuthoredPaths: Record<string, true>;
  /* Path-scoped authorship freshness (issue #112). For every transcript the
     reaper has scanned to completion and found NOT owner-authored, the observed
     transcript mtime (seconds) at that scan. The board clears
     `authorshipUnverified` only when this per-path stamp is at least as fresh as
     the file's current mtime — a global "last cycle" timestamp would falsely
     certify a worker that exited before it was ever scanned, letting an
     unobserved user-authored transcript collapse. */
  scannedAt: Record<string, number>;
}

function readState(): ReaperState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8")) as Partial<ReaperState>;
    if (parsed.version === 1 && parsed.firstObservedAt && typeof parsed.firstObservedAt === "object") {
      return {
        version: 1,
        firstObservedAt: parsed.firstObservedAt,
        userAuthoredPaths: parsed.userAuthoredPaths && typeof parsed.userAuthoredPaths === "object"
          ? parsed.userAuthoredPaths as Record<string, true>
          : {},
        scannedAt: parsed.scannedAt && typeof parsed.scannedAt === "object" && !Array.isArray(parsed.scannedAt)
          ? parsed.scannedAt as Record<string, number>
          : {},
      };
    }
  } catch { /* first run or invalid state */ }
  return { version: 1, firstObservedAt: {}, userAuthoredPaths: {}, scannedAt: {} };
}

function atomicWrite(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filename);
}

/** Rewrites the state file for this cycle. `firstObservedAt` tracked pane
    hosts; it is kept empty because a state file without it reads as invalid
    and would drop the authorship stamps beside it. */
function updateObservationState(): ReaperState {
  const previous = readState();
  const state = {
    version: 1 as const,
    firstObservedAt: {},
    userAuthoredPaths: previous.userAuthoredPaths,
    scannedAt: previous.scannedAt,
  };
  atomicWrite(STATE_FILE(), state);
  return state;
}

function hasViewerWorkerLaunchPrompt(snapshot: ReturnType<AgentRegistry["snapshot"]>, pathname: string): boolean {
  return registryRowsMatching(snapshot, "receipts", "artifactPath", pathname).some((receipt) =>
    receipt.purpose === "launch"
    && receipt.artifactPath === pathname
    && receipt.launchProfile.role === "worker"
    && receipt.state === "completed");
}

function viewerFlowMessageAllowance(flows: Flow[], pathname: string): number {
  let count = 0;
  for (const flow of flows) {
    if (flow.kickoffDelivery?.path === pathname) count += 1;
    count += flow.rounds.filter((round) => round.relayDelivery?.path === pathname).length;
  }
  return count;
}

/* A HEADLESS reviewer is launched straight through the CLI (startHeadlessReview),
   not a Viewer spawn receipt, so its automated review instruction lands in the
   transcript as one user-role message that no launch/delivery allowance covers.
   Left uncounted, that single automated prompt would mark every finished headless
   reviewer owner-authored and pin it forever — the exact opposite of the
   immediate reviewer collapse #112 exists for. Grant the round's reviewer
   transcript one allowance for that startup prompt; a genuine owner message on
   top is the second and still trips the exemption.

   PANE reviewers are excluded: they launch through `spawnAgentWithPrompt`, whose
   completed worker receipt already grants the launch allowance via
   `hasViewerWorkerLaunchPrompt`. Adding a second allowance would let a pane
   reviewer carrying one automated prompt AND one genuine owner follow-up scan
   clean, collapsing an owner-touched card — a hard-constraint violation.

   The allowance is granted only with DETERMINISTIC launch provenance: the
   round's reviewer transcript basename must contain the round's own sessionId
   (claude pre-chooses it at spawn, codex reports it in the first event). A
   reviewerPath claimed by the same-CWD/latest-mtime heuristic
   (`maybeClaimReviewerPathByHeuristic`) can misattribute an owner-created
   transcript; discounting there would eat that owner's first genuine message.
   Absent/mismatched sessionId → no allowance → the automated prompt counts and
   the path stays protected (the safe side). */
function viewerReviewerLaunchAllowance(flows: Flow[], pathname: string): number {
  for (const flow of flows) {
    if (flow.reviewerMode !== "headless") continue;
    for (const round of flow.rounds) {
      if (round.reviewerPath !== pathname || !round.sessionId) continue;
      if (path.basename(pathname).includes(round.sessionId)) return 1;
    }
  }
  return 0;
}

/* A native subagent (a Claude `agent-*` session, or a Codex thread with a
   parent_thread_id) is spawned by its parent AGENT, not the owner, and its first
   turn is the parent's automated assignment — serialized as a user-role message
   with no Viewer receipt or flow delivery to cover it. Left uncounted, that one
   automated prompt marks every agent-spawned subtask owner-authored and pins it
   forever, so the spawned workers #112 targets never collapse. Provenance is
   deterministic from the scan entry (the `subagent` kind / native codex parent),
   so grant exactly one allowance for the assignment; a genuine owner message on
   top is the second and still trips the exemption. */
function viewerNativeSubagentAllowance(file: FileEntry | undefined): number {
  if (!file) return 0;
  if (file.root === "claude-projects" && file.kind === "subagent") return 1;
  if (file.root === "codex-sessions" && file.engine === "codex" && isNativeCodexSubagentTranscript(file.path, file.size)) return 1;
  return 0;
}

async function authorshipEvidence(
  snapshot: ReturnType<AgentRegistry["snapshot"]>,
  flows: Flow[],
  files: FileEntry[],
  priorUserAuthoredPaths: Readonly<Record<string, true>>,
  priorScannedAt: Record<string, number>,
): Promise<{
  userAuthoredPaths: Set<string>;
  unverifiedPaths: Set<string>;
  /* Path → observed transcript mtime (seconds) for every transcript scanned to
     completion and found NOT owner-authored. This is the path-scoped freshness
     the board needs to clear `authorshipUnverified` without falsely certifying
     an unscanned worker (issue #112). */
  verifiedCleanAt: Map<string, number>;
}> {
  /* Human authorship is sticky by contract. Re-reading a path after it has
     already crossed the owner-message threshold cannot change that verdict;
     it only burns through the full transcript again because authored paths do
     not receive a clean `scannedAt` stamp. Seed the current evidence from the
     durable map so every later controller cycle skips those files. */
  const userAuthoredPaths = new Set(Object.keys(priorUserAuthoredPaths));
  const unverifiedPaths = new Set<string>();
  const verifiedCleanAt = new Map<string, number>();
  /* Authorship scanning covers every quiet claude/codex transcript the scan
     sees: a finished headless reviewer is a detached process and an exited
     worker has no host at all, and without a clean stamp the board would pin
     them unverified forever (#112). A live file is skipped: it is board-exempt
     regardless and its mtime advances every write, so scanning it would churn
     without ever producing a usable stamp. */
  const fileByPath = new Map<string, FileEntry>();
  const targets = new Map<string, "claude" | "codex" | "copilot">();
  await forEachCooperatively(files, (file) => {
    fileByPath.set(file.path, file);
  });
  await forEachCooperatively(files, (file) => {
    if (file.engine !== "claude" && file.engine !== "codex" && file.engine !== "copilot") return;
    if (file.activity === "live") return;
    /* Already clean-stamped at or past the current mtime — no need to re-scan;
       the persisted stamp still stands (the caller keeps prior state entries). */
    const stamp = priorScannedAt[file.path];
    if (stamp !== undefined && stamp >= file.mtime) return;
    targets.set(file.path, file.engine);
  });
  /* Hard byte budgets (#287): one multi-gigabyte ownerless transcript may
     consume at most AUTHORSHIP_PATH_PASS_BYTES per controller cycle, and all
     authorship proofs together at most AUTHORSHIP_CYCLE_BUDGET_BYTES. An
     exhausted pass returns incomplete, the path stays protected as
     unverified, and the resumable checkpoint continues in the next cycle. */
  const authorshipReadBudget = { remaining: AUTHORSHIP_CYCLE_BUDGET_BYTES };
  await forEachCooperatively([...targets], async ([pathname, engine]) => {
    if (userAuthoredPaths.has(pathname) || unverifiedPaths.has(pathname)) return;
    const viewerMessageAllowance = (hasViewerWorkerLaunchPrompt(snapshot, pathname) ? 1 : 0)
      + viewerFlowMessageAllowance(flows, pathname)
      + viewerReviewerLaunchAllowance(flows, pathname)
      + viewerNativeSubagentAllowance(fileByPath.get(pathname));
    /* Stamp the mtime BEFORE reading: a transcript that grows during the scan
       ends up with a newer on-disk mtime than we record, so the board re-pins it
       as unverified until the next cycle rather than certifying content the
       reaper never saw. */
    let observedMtime: number | null = null;
    try {
      observedMtime = fs.statSync(pathname).mtimeMs / 1000;
    } catch {
      unverifiedPaths.add(pathname);
      return;
    }
    const scan = await scanUserAuthoredMessagesCooperatively(pathname, engine, viewerMessageAllowance + 1, {
      resume: true,
      maxBytes: AUTHORSHIP_PATH_PASS_BYTES,
      budget: authorshipReadBudget,
    });
    if (scan.count > viewerMessageAllowance) userAuthoredPaths.add(pathname);
    else if (!scan.complete) unverifiedPaths.add(pathname);
    else verifiedCleanAt.set(pathname, observedMtime);
  });
  return { userAuthoredPaths, unverifiedPaths, verifiedCleanAt };
}

function appendJournal(record: ReaperJournalRecord): void {
  const filename = JOURNAL_FILE();
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    if (fs.statSync(filename).size > ROTATE_BYTES) fs.renameSync(filename, `${filename}.1`);
  } catch { /* first write */ }
  fs.appendFileSync(filename, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
}

async function makeInput(
  registry: AgentRegistry,
  files: FileEntry[],
  state: ReaperState,
  now: number,
  overrides: ReaperActuationOverrides = {},
): Promise<ReaperInput> {
  const flows = (overrides.loadFlows ?? loadFlows)();
  const authorship = await authorshipEvidence(
    registry.readOnlySnapshot(),
    flows,
    files,
    state.userAuthoredPaths,
    state.scannedAt,
  );
  let stateChanged = false;
  for (const pathname of authorship.userAuthoredPaths) {
    if (state.userAuthoredPaths[pathname]) continue;
    state.userAuthoredPaths[pathname] = true;
    stateChanged = true;
  }
  for (const [pathname, observedMtime] of authorship.verifiedCleanAt) {
    if (state.scannedAt[pathname] === observedMtime) continue;
    state.scannedAt[pathname] = observedMtime;
    stateChanged = true;
  }
  if (stateChanged) atomicWrite(STATE_FILE(), state);
  return {
    now,
    reviewerProcesses: observeHeadlessReviewers(flows, overrides),
    flows,
    enabled: process.env.LLV_REAPER_ENABLED === "1",
  };
}

function observeHeadlessReviewers(flows: Flow[], overrides: ReaperActuationOverrides): HeadlessReviewerProcess[] {
  const pidAlive = overrides.pidAlive ?? ((pid: number) => procBackend.pidAlive(pid));
  const processIdentity = overrides.processIdentity ?? ((pid: number) => procBackend.processIdentity(pid));
  const processes: HeadlessReviewerProcess[] = [];
  for (const flow of flows) {
    if (flow.reviewerMode !== "headless") continue;
    for (const round of flow.rounds) {
      const pid = round.reviewerPid ?? null;
      const identity = round.reviewerIdentity ?? null;
      if (!pid || !identity || !pidAlive(pid) || processIdentity(pid) !== identity) continue;
      processes.push({ flowId: flow.id, round: round.n, pid, identity, path: round.reviewerPath });
    }
  }
  return processes;
}

interface HeadlessReviewerKillDeps {
  pidAlive(pid: number): boolean;
  processIdentity(pid: number): string | null;
  signal(pid: number, signal: NodeJS.Signals): void;
  sleep(milliseconds: number): Promise<void>;
  maxVerifyAttempts: number;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    process.kill(pid, signal);
  }
}

export async function killHeadlessReviewerIfMatches(
  expected: { pid: number; identity: string },
  overrides: Partial<HeadlessReviewerKillDeps> = {},
): Promise<boolean> {
  const deps: HeadlessReviewerKillDeps = {
    pidAlive: (pid) => procBackend.pidAlive(pid),
    processIdentity: (pid) => procBackend.processIdentity(pid),
    signal: signalProcessGroup,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    maxVerifyAttempts: 20,
    ...overrides,
  };
  const gone = () => !deps.pidAlive(expected.pid) || deps.processIdentity(expected.pid) !== expected.identity;
  if (gone()) return false;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      deps.signal(expected.pid, signal);
    } catch {
      if (gone()) return true;
      return false;
    }
    for (let attempt = 0; attempt < deps.maxVerifyAttempts; attempt += 1) {
      if (gone()) return true;
      if (attempt + 1 < deps.maxVerifyAttempts) await deps.sleep(25);
    }
  }
  return false;
}

async function actuateCandidate(
  registry: AgentRegistry,
  files: FileEntry[],
  state: ReaperState,
  agent: ReaperAgentReport,
  overrides: ReaperActuationOverrides = {},
): Promise<boolean> {
  if (agent.targetKind !== "process" || !agent.flowId || agent.round === null || !agent.processIdentity) return false;
  const current = evaluateReaper(await makeInput(registry, files, state, (overrides.now ?? Date.now)(), overrides));
  const candidate = current.agents.find((item) => item.targetKind === "process"
    && item.flowId === agent.flowId
    && item.round === agent.round
    && item.agentPid === agent.agentPid
    && item.processIdentity === agent.processIdentity);
  if (!candidate?.eligible) return false;
  return (overrides.killProcess ?? killHeadlessReviewerIfMatches)({ pid: agent.agentPid, identity: agent.processIdentity });
}

export interface ReaperActuationOverrides {
  loadFlows?: typeof loadFlows;
  pidAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => string | null;
  killProcess?: typeof killHeadlessReviewerIfMatches;
  now?: () => number;
  runtimeClient?: typeof runtimeHostClient;
  terminalizeStaleSpawns?: typeof terminalizeStaleStructuredSpawns;
}

/** Generalizes the issue #652 terminal convergence path. It retains the
    settled-migration predicate for uncertain attempts and also stops an intent
    whose progress bound expired or whose requested delivery lost its source
    owner. Every affected reservation becomes a durable failed record with an
    actionable cancellation reason. */
function migrationSourceHasLiveOwner(
  snapshot: RegistryFile,
  conversation: RegistryConversation,
  probe: LivenessProbe,
): boolean {
  const migration = conversation.migration;
  if (!migration) return false;
  const source = conversation.generations.find((generation) => generation.id === migration.sourceGenerationId);
  if (!source) return false;
  if (identityAlive(source.host?.tmuxHost?.agent, probe)) return true;
  if (Object.values(snapshot.entries).some((entry) =>
    entry.key.engine === conversation.engine
    && entry.artifactPath === source.path
    && entryIsLive(entry, probe))) return true;
  return registryRowsMatching(snapshot, "receipts", "conversationId", conversation.id).some((receipt) =>
    receipt.engine === conversation.engine
    && receipt.conversationId === conversation.id
    && receiptIsLive(snapshot, receipt, probe));
}

/* The hygiene pass needs two identity fields of every conversation and held
   delivery. Read through a projection, an archived row is parsed once for the
   life of the store; enumerating the rows themselves parsed the whole archive
   again for every migration intent on every pass. */
const MIGRATION_OWNERSHIP: RegistryRowProjector<"conversations", { id: RegistryConversation["id"]; intentId: string } | null> = {
  id: "reaper-migration-ownership-v1", collection: "conversations",
  project: conversation => conversation.migration ? { id: conversation.id, intentId: conversation.migration.intentId } : null,
};
const UNSETTLED_DELIVERIES: RegistryRowProjector<"heldDeliveries", { id: string; conversationId: string } | null> = {
  id: "reaper-unsettled-deliveries-v1", collection: "heldDeliveries",
  project: delivery => ["held", "assigned", "delivery-uncertain"].includes(delivery.state)
    ? { id: delivery.id, conversationId: delivery.conversationId } : null,
};

/** One reading of who owns what, shared by every intent of a hygiene pass. */
function migrationHygieneIndex(snapshot: RegistryFile): {
  ownedBy: (intentId: string) => RegistryConversation[];
  unsettledDeliveryIds: (conversationIds: ReadonlySet<string>) => string[];
} {
  const ownedIds = new Map<string, RegistryConversation["id"][]>();
  for (const [, owned] of registryRowProjection(snapshot, MIGRATION_OWNERSHIP)) {
    if (!owned) continue;
    const ids = ownedIds.get(owned.intentId);
    if (ids) ids.push(owned.id); else ownedIds.set(owned.intentId, [owned.id]);
  }
  const unsettled = registryRowProjection(snapshot, UNSETTLED_DELIVERIES)
    .flatMap(([, delivery]) => delivery ? [delivery] : []);
  return {
    ownedBy: (intentId) => (ownedIds.get(intentId) ?? [])
      .flatMap((id) => { const conversation = snapshot.conversations[id]; return conversation ? [conversation] : []; }),
    unsettledDeliveryIds: (conversationIds) => conversationIds.size
      ? unsettled.filter((delivery) => conversationIds.has(delivery.conversationId)).map((delivery) => delivery.id) : [],
  };
}

/**
 * The hygiene the inventory sidecar runs over accepted sends. Every write
 * waits for the registry lock off the loop (docs/design/
 * delivery-progress-and-drain.md, C4): the sidecar drains held sends too, so
 * a wait here would hold its own lanes. A write the lock refused leaves its
 * row for the next cycle; a refused ending skips its conversation's rollback,
 * so the pair stays together.
 */
export async function terminalizeStaleUndeliverableHeldDeliveries(
  registry: AgentRegistry,
  now: number = Date.now(),
  liveness: AccountLivenessOptions = {},
): Promise<string[]> {
  const snapshot = registry.readOnlySnapshot();
  const offLoop = async <T>(label: string, id: string | null, write: () => T): Promise<{ value: T } | null> => {
    const operationId = id ? snapshot.heldDeliveries[id]?.command.operationId ?? null : null;
    const written = await registry.deliveryWrite({ label, operationId }, write);
    return written.acquired ? { value: written.value } : null;
  };
  const probe = livenessProbe({ ...liveness, now: () => now });
  const terminalized = new Set<string>();
  for (const id of staleUndeliverableHeldDeliveryIds(snapshot, { ...liveness, now: () => now })) {
    const expected = snapshot.heldDeliveries[id]!;
    const settled = await offLoop("delivery.hygiene", id, () => registry.terminalizeStaleUndeliverableHeldDelivery(
      expected, { ...liveness, now: () => now },
    ));
    if (settled?.value?.state === "failed") terminalized.add(id);
  }
  const index = migrationHygieneIndex(snapshot);
  for (const intent of Object.values(snapshot.migrationIntents)) {
    const owned = index.ownedBy(intent.id);
    const ids = index.unsettledDeliveryIds(new Set(owned.map((conversation) => conversation.id)));
    /* A rolled-back migration owns only deliveries whose latest admission was
       inside its drain window (#972). A resend can reuse an older reservation,
       so `createdAt` alone does not prove ownership. */
    const rolledBackConversationIds = new Set<RegistryConversation["id"]>();
    for (const conversation of owned) {
      if (conversation.migration?.phase !== "rolled-back") continue;
      rolledBackConversationIds.add(conversation.id);
    }
    let activeIds: string[] = [];
    for (const id of ids) {
      const delivery = snapshot.heldDeliveries[id];
      if (!delivery || !rolledBackConversationIds.has(delivery.conversationId)) {
        activeIds.push(id);
        continue;
      }
      const settled = await offLoop("delivery.hygiene", id, () => registry.terminalizeRolledBackMigrationDelivery(
        id,
        intent.id,
        ROLLED_BACK_MIGRATION_DELIVERY_REASON,
      ));
      if (!settled?.value) {
        activeIds.push(id);
        continue;
      }
      terminalized.add(id);
    }
    /* Once its intent is settled and its owned deliveries are terminal, the
       rolled-back block is spent residue: clearing it here disarms every later
       hygiene pass that would otherwise keep matching this conversation. A
       still-draining intent keeps the block so the drain's own bookkeeping
       (progress accounting, per-conversation opt-out) stays intact; the
       atomic ownership fence above already protects new messages meanwhile. */
    if (intent.state !== "draining") {
      for (const conversationId of rolledBackConversationIds) {
        await offLoop("migration.rollback", null, () => registry.clearRolledBackConversationMigration(conversationId, intent.id));
      }
      continue;
    }
    const deliveryConversationIds = new Set(activeIds.map((id) =>
      snapshot.heldDeliveries[id]?.conversationId).filter((id): id is RegistryConversation["id"] => Boolean(id)));
    const noProgress = migrationIntentIsStale(snapshot, intent, now);
    if (!noProgress) {
      for (const conversation of owned) {
        if (conversation.migration?.phase !== "requested"
          || !deliveryConversationIds.has(conversation.id)
          || migrationSourceHasLiveOwner(snapshot, conversation, probe)) continue;
        const reason = `delivery cancelled because source conversation ${conversation.id} has no live owner; send again to authorize a fresh delivery`;
        let refused = false;
        for (const id of activeIds) {
          if (snapshot.heldDeliveries[id]?.conversationId !== conversation.id) continue;
          const settled = await offLoop("delivery.hygiene", id, () => registry.terminalizeHeldDelivery(id, reason));
          if (!settled) { refused = true; continue; }
          if (settled.value.state === "failed") terminalized.add(id);
        }
        if (refused) continue;
        const revision = conversation.migration.revision;
        await offLoop("migration.rollback", null, () => registry.rollbackConversationMigration(conversation.id, revision));
        activeIds = activeIds.filter((id) => snapshot.heldDeliveries[id]?.conversationId !== conversation.id);
      }
    }
    if (!noProgress) continue;
    const reason =
      `delivery cancelled because its owning account migration made no progress for ${MIGRATION_INTENT_PROGRESS_TIMEOUT_MS}ms; send again to authorize a fresh delivery`;
    if (!await offLoop("migration.stop", null, () => registry.setMigrationIntentState(intent.id, "stopped", intent.revision, reason))) continue;
    const settledSnapshot = registry.readOnlySnapshot();
    for (const id of activeIds) {
      if (settledSnapshot.heldDeliveries[id]?.state === "failed") terminalized.add(id);
    }
  }
  return [...terminalized];
}

export async function runReaperCycle(options: {
  registry?: AgentRegistry;
  files: FileEntry[];
  now?: number;
  actuation?: ReaperActuationOverrides;
}): Promise<ReaperReport> {
  const registry = options.registry ?? agentRegistry();
  const now = options.now ?? Date.now();
  /* Stale undeliverable held-delivery convergence (#652): a delivery-uncertain
     attempt whose owning migration has settled and whose conversation has no
     live host/receipt can never resolve, yet it keeps counting as an owed turn
     and blocks account removal forever. The reaper cycle terminalizes exactly
     what `conversationIsLive` has already stopped counting as live, so the
     registry stops carrying it as owed. Registry hygiene, never a process kill,
     so it runs regardless of `LLV_REAPER_ENABLED`; failure never blocks the
     reaper. */
  try {
    await terminalizeStaleUndeliverableHeldDeliveries(registry, now, {});
  } catch (error) {
    console.error("[reaper] stale undeliverable held-delivery convergence failed", error);
  }
  /* Durable launch/delivery convergence (#653/#922): reconcile either ordering
     of a terminal launch and its never-attempted initial delivery, including
     historical migration cancellations and promote-race assignments. Ambiguous
     attempted deliveries remain untouched. Pure registry mutation, independent
     of the runtime client, byte-stable when there is nothing to do. */
  try {
    /* Off the loop; refused, the next cycle converges it (C4). */
    if (registry.failedSpawnDeliveryCandidates()) {
      await registry.deliveryWrite({ label: "delivery.hygiene" }, () => registry.terminalizeFailedSpawnDeliveriesNow());
    }
  } catch (error) {
    console.error("[reaper] failed-spawn held-delivery convergence failed", error);
  }
  /* Completed structured conversations can retain a live Viewer writer claim
     after their recorded engine child exits without cleanup. Revalidate only
     those recorded PIDs and available start identities, then clear dead rows
     without signalling any process so ordinary recovery can claim them again. */
  try {
    await reconcileDeadStructuredRegistryHostsOffLoop(registry);
  } catch (error) {
    console.error("[reaper] dead structured-host ownership convergence failed", error);
  }
  /* Stale launch convergence (#334/#926): the reaper cycle is the while-running
     seam that turns dead-evidence pending receipts terminal and actuates due
     queued pins. Structured receipts wait for their required client. The pass
     is bounded and idempotent; its failure never blocks the reaper. */
  try {
    const inventorySidecar = process.env.LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER === "1";
    const hasSpawnWork = !inventorySidecar || registry.openSpawnReceipts().length > 0
      // A starting entry is never archived, so the liveness rows hold every one.
      || registryLivenessRows(registry.readOnlySnapshot()).entries.some(entry => entry.status === "starting");
    if (hasSpawnWork) {
      const runtimeClientForSpawns = (options.actuation?.runtimeClient ?? runtimeHostClient)();
      await (options.actuation?.terminalizeStaleSpawns ?? terminalizeStaleStructuredSpawns)(registry, runtimeClientForSpawns, {
        // The sidecar never activates the serving release, including after a
        // restart. Its pending launches still converge without owner backfill.
        repairFailures: !inventorySidecar,
      });
    }
  } catch (error) {
    console.error("[reaper] stale structured spawn convergence failed", error);
  }
  try {
    await registry.deliveryWrite({ label: "registry.archive" }, () => registry.archiveInactiveRows());
  } catch (error) {
    console.error("[reaper] registry archive convergence failed",error);
  }
  const state = updateObservationState();
  const report = evaluateReaper(await makeInput(registry, options.files, state, now, options.actuation));
  const completed = await runEvaluatedReaper(report, {
    actuate: (agent) => actuateCandidate(registry, options.files, state, agent, options.actuation),
    journal: appendJournal,
  });
  writeJsonDurably(REPORT_FILE(), completed);
  return completed;
}

export function readReaperReport(): ReaperReport | null {
  const parsed = readJsonCache(REPORT_FILE()) as ReaperReport | undefined;
  return parsed && typeof parsed === "object" && Array.isArray(parsed.agents) ? parsed : null;
}
