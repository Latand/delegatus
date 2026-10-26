import { readHostExit, type HostExitRecord } from "@/lib/runtime/hostExit";
import { performanceSpans } from "@/lib/performanceSpans";
import { hostTurnRecordIdentity, readHostTurnRecord } from "@/lib/runtime/eventStore";
import { engineRecordSince, processLaunchedAt } from "@/lib/runtime/liveness";
import { withoutExitBookkeeping } from "@/lib/pipelines/durableEvidence";
import { isTaskNotificationRecord } from "@/lib/pipelines/backgroundTasks";
import { recordValue, recordsValue } from "@/lib/scanner/json";
import { livenessProbe, receiptIsLive, receiptProcessEvidence, type LivenessProbe } from "@/lib/agent/accountLiveness";
import type { AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import { agentRegistry, conversationIdsResolvingTo, resolveConversationAlias, structuredClaimIdentity } from "@/lib/agent/registry";
import { registryLivenessRows, registryRowsMatching } from "@/lib/agent/sqliteRegistryStore";
import { isAbortError } from "@/lib/deadline";
import { hostProviderRetryAt } from "@/lib/limitsThrottle";
import { pipelineSelectionSource, loadPipelines } from "@/lib/pipelines/store";
import { flowSelectionSource, loadFlows } from "@/lib/flows/store";
import { readHistoryProjection, historyPipelineRef, historyHeadlessFlows, historyHeadlessFlowsForTarget, pruneHistoryHeadlessRounds, canPruneHistoryHeadlessRounds, historyHeadlessDeadRounds } from "@/lib/state/historyProjection";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { Flow } from "@/lib/flows/types";
import { completedFileScan } from "@/lib/scanner/scanCache";
import type { PendingPermissionRequest, PendingQuestionRequest } from "@/lib/runtime/permissionRequests";
import type { Engine, FileEntry } from "@/lib/types";
import { projectAliasResolver } from "@/lib/projects/aliases";
import { isCanonicalProjectId } from "@/lib/projects/identity";
import { namedProjectDirectory, ProjectNameRefusal, resolveNamedProject } from "@/lib/projects/nameResolution";

import {
  completedGenerationSelection,
  hydrateWithBudget,
  selectConversationEntries,
  type CompletedGenerationRead,
  type ConversationSelection,
  type ConversationSelectionRequest,
} from "./inventorySelection";
import {
  describeTranscriptPath,
  readLivenessTranscriptEvidence,
  transcriptFileIdentity,
  type LivenessTranscript,
  type LivenessTranscriptEvidence,
} from "./transcript";
import { entryOwners, headlessRoundVerdict, ownerProcessAlive, type RecordedOwner } from "./owners";
import { classifyAgentActivity, type AgentActivity, type AgentActivityFacts } from "./agentActivity";
import { activityProcessReader } from "./agentActivityProcesses";
import { DEFAULT_STALL_AFTER_MS } from "./limits";
export { DEFAULT_STALL_AFTER_MS } from "./limits";
import type { LifecycleState, LifecycleTurnState } from "./vocabulary";

/**
 * #645 — agent liveness and stall detection over the registries the Viewer
 * already maintains, so an orchestrator's 30-minute sweep stops being a
 * hand-rolled `stat`/`pgrep` loop outside the product.
 *
 * The snapshot answers one question per conversation: can this turn still make
 * progress? It reports the shared lifecycle vocabulary, never a second status
 * model, and it deliberately does not echo whatever a pipeline record claims —
 * a pipeline stuck at `running` over a dead host is exactly the failure this
 * exists to catch.
 */

/** A launch with no host evidence yet is `starting`, not `gone`. Mirrors the
    unproven-launch grace the reaper and blocker evaluation already agree on.
    Past it a launch that never produced host evidence is registry rot, and an
    old transcript with no registry entry at all is not "starting up" either. */
export const STARTING_GRACE_MS = 5 * 60_000;

export type AgentHostState = "alive" | "gone" | "unknown";

export type AgentLivenessReason =
  /** A live host with a turn that is still moving. */
  | "evidence_unverified"
  | "host_gone_turn_unverified"
  | "host_alive_turn_active"
  /** A live host with a settled turn — the agent is awaiting input. */
  | "host_alive_turn_idle"
  /** A matching durable stage settled an otherwise unknown native turn. */
  | "pipeline_stage_settled"
  /** A live host whose transcript has been silent past the stall threshold. */
  | "host_alive_transcript_silent"
  /** A live host reported that its engine is retrying a provider error inside
      this turn, and nothing the provider produced has superseded it (#2215). */
  | "provider_throttled"
  /** A live host holds a tool permission request nobody has answered (#2215):
      the turn waits on an answer, never on the provider. */
  | "permission_request"
  /** A live structured host is blocked on an operator question. */
  | "question"
  /** The zombie: an open turn whose host is gone. Nothing will ever finish it. */
  | "host_gone_turn_open"
  /** The host exited after its turn settled — a finished or killed stage. */
  | "host_gone_turn_settled"
  /** Admitted, no host evidence recorded yet, still inside the launch grace. */
  | "launch_unproven"
  /** No host evidence ever appeared and the transcript has aged out of the
      grace. An orphan hours old is not starting up; the turn state decides
      whether it is stranded (`stalled`) or simply over (`gone`). */
  | "launch_unproven_expired";

export interface AgentLivenessPipelineRef {
  pipelineId: string;
  stageId: string;
  attempt: number;
  /** A running claim alone proves no work. A settled attempt can resolve an
      unknown native turn only with matching ownership and no ongoing work. */
  reportedState: PipelineStageAttempt["state"];
  reportedPipelineState: Pipeline["state"];
  /** Pane-less attempts are structured-hosted; the reconciler treats their
      durable `busy` turn evidence as "wait forever", so they are the ones that
      strand. */
  paneId: string | null;
  /** Ownership carried with the ref, including when lookup fell back to a path. */
  conversationId?: string | null;
  agentPath?: string | null;
}

export interface AgentLivenessRecord {
  hostExit?: HostExitRecord | null;
  previousHostExit?: HostExitRecord;
  activity?: AgentActivity;
  verified?: boolean;
  previousPaths?: string[];
  conversationId: string | null;
  transcriptPath: string;
  project: string;
  engine: Engine;
  title: string;
  /** ISO timestamp of the newest durable transcript RECORD — tool traffic
      counts, not only assistant prose. Null without a verified record clock. */
  lastRecordAt: string | null;
  turnState: LifecycleTurnState;
  host: { state: AgentHostState; kind: "tmux" | "structured" | "headless" | "none"; pid: number | null };
  /** Shared vocabulary. `stalled` means the turn cannot progress on its own. */
  lifecycle: LifecycleState;
  reason: AgentLivenessReason;
  /** Provider retry deadline when `reason` is `provider_throttled`. */
  retryAt?: string | null;
  /** The pending request when `reason` is `permission_request`: the tool,
      what it would do, and the engine's reason for asking. */
  permission?: PendingPermissionRequest | null;
  /** The pending native question when `reason` is `question`. */
  question?: PendingQuestionRequest | null;
  /** Measured milliseconds since `lastRecordAt`; null without tail evidence. */
  silentForMs: number | null;
  /** Milliseconds this conversation has been silent while in the `stalled` or
      `gone` lifecycle; null when it is not stalled. */
  stalledForMs: number | null;
  pipeline: AgentLivenessPipelineRef | null;
  /**
   * Where this row's turn state came from (#860). The three states an operator
   * diagnosing a degraded snapshot has to tell apart:
   *
   * - `transcript` — the tail was read and interpreted.
   * - `unreadable` — the tail was read and could not be used (torn or racing
   *   append), so the scan projection answered.
   * - `projection` — no read was attempted: the evidence budget was already
   *   spent when this row came up.
   *
   * Only `transcript` rows become durable journal events; see
   * `projectLivenessEvents`.
   */
  evidenceSource: "transcript" | "unreadable" | "projection";
}

/**
 * Phase timings, in milliseconds and nothing else (#860).
 *
 * Deliberately identity-free: a timing report travels through logs and PR
 * bodies, so it carries numbers a reader can act on and never a path, a project
 * or an account.
 */
export interface AgentLivenessTimings {
  /** Reading the completed generation and applying filters and the row limit. */
  inventorySelectionMs: number;
  /** Registry, host and pipeline-lineage projection: the index build plus the
      per-row host and lineage resolution for every selected row. */
  journalProjectionMs: number;
  /** Bounded transcript-tail hydration. */
  evidenceReadMs: number;
  /** Assembling the records this call returns. */
  serializationMs: number;
  totalMs: number;
}

export interface AgentLivenessSelectionReport {
  /** `targeted` names a conversation or path; the others read the catalog. */
  scope: "targeted" | "project" | "corpus";
  /** Conversation rows in the generation this call consumed. */
  scanned: number;
  /** Rows matching project/liveness before the row limit. */
  matched: number;
  selected: number;
  /** Rows resolved by identity because the generation did not contain them yet:
      hosts younger than the generation. Non-zero means the catalog is behind
      the runtime, which is the one thing a clean-looking report must not hide. */
  recovered: number;
  /** More active hosts were missing from the generation than one call recovers,
      so the newest `HOSTED_RECOVERY_MAX` of them were resolved and the rest
      were not looked at. */
  recoveryTruncated: boolean;
  /** Active hosts the generation lacks, or the transcripts a targeted call
      named, that the answer budget ended before describing. They have no row
      in this answer; a later call resolves them. */
  recoveryPending: number;
  /** Rows a transcript tail read was attempted for; `unreadable` is the subset
      of those whose tail could not be used. */
  hydrated: number;
  unreadable: number;
  /** Selected rows with no tail evidence in this answer: a budget was exhausted
      before their read started or before it finished. Equals the number of `evidenceSource: "projection"`
      records by construction. */
  projected: number;
  generation: number | null;
  cacheStatus: ConversationSelection["cacheStatus"] | null;
  /** True only on the legacy whole-inventory adapter. */
  freshScan: boolean;
  evidenceBytes: number;
  budget: "complete" | "byte_budget" | "deadline";
}

export interface AgentLivenessSnapshot {
  observedAt: string;
  stallAfterMs: number;
  count: number;
  /** Project-scoped candidates whose project identity could not be resolved. */
  unresolvedProjectCount?: number;
  /** Conversations whose lifecycle is `stalled`, so a poller can branch on one
      number instead of scanning the list. */
  stalledCount: number;
  /** Compatibility alias of stalledCount: every stall now requires a tail. */
  stalledConfirmedCount: number;
  conversations: AgentLivenessRecord[];
  selection: AgentLivenessSelectionReport;
  timings: AgentLivenessTimings;
}

export interface AgentLivenessRequest {
  /** Seat progression alone may reconcile a current writer's closed idle turn.
      General liveness and update-drain readers retain native orphan work. */
  reconcileStructuredIdle?: boolean;
  conversationId?: string;
  transcriptPath?: string;
  project?: string;
  /** Restrict to conversations the scan still projects as live or stalled, or
      that the registry projection currently hosts. */
  liveOnly?: boolean;
  stallAfterMs?: number;
  limit?: number;
  /** The caller's lifetime. Cancelling it stops the generation read and starts
      no further transcript tails. */
  signal?: AbortSignal | null;
  /**
   * Wall-clock ceiling on transcript-tail hydration, measured from the moment
   * hydration STARTS — not from the start of the call. Selection may have
   * waited on a cold generation for tens of seconds; charging that wait to this
   * budget would spend it before the first tail is opened and answer the whole
   * request from the scan projection, exactly when the operator is asking why
   * nothing responds.
   */
  evidenceDeadlineMs?: number;
  /** Byte ceiling on transcript-tail hydration for this call. Defaults to the
      row limit's worth of full tails, so the budget can always cover the rows
      the limit admits. */
  evidenceByteBudget?: number;
  /** Tail reads in flight at once. */
  evidenceConcurrency?: number;
  /**
   * Wall clock the whole answer may take: the catalog wait, identity recovery
   * and transcript evidence share it. When it ends, hosts not yet described are
   * counted in `recoveryPending` and rows whose tail has not answered are
   * projected from the scan (`evidenceSource: "projection"`); their reads keep
   * running and a later call for the same unchanged file takes the result. A
   * targeted transcript not yet described is counted in `recoveryPending` too.
   * Omitted, each phase keeps only its own budget.
   */
  answerBudgetMs?: number;
}

/** Tail reads in flight at once. Small on purpose: a `limit: 10` read is ten
    reads total, and twenty concurrent callers must not multiply into a storm. */
export const DEFAULT_EVIDENCE_CONCURRENCY = 4;
/** Wall clock one call may spend on transcript evidence before the remaining
    rows fall back to the scan projection. */
export const DEFAULT_EVIDENCE_DEADLINE_MS = 2_000;
/** What one tail read actually costs, mirroring `readStableTailRecords`. */
export const EVIDENCE_TAIL_BYTES = 131_072;

/**
 * The default byte budget follows the row limit, so the two agree.
 *
 * A fixed budget cannot: at 8 MiB it admitted exactly sixty-four full tails
 * while the default limit is a hundred, so a default corpus read degraded rows
 * 65+ to the scan projection on EVERY call — deterministically the same rows,
 * and the journal gate then never recorded a stall for any of them. The budget
 * exists to stop a call from reading an unbounded volume; the row limit is
 * already that bound, and it is clamped to 200, so the ceiling here is 25 MiB.
 */
export function defaultEvidenceByteBudget(limit: number): number {
  return Math.max(1, limit) * EVIDENCE_TAIL_BYTES;
}

/** What a liveness read takes from the registry. The aliases are optional so an
    injected snapshot that predates them still reads; production always has them. */
export type LivenessRegistrySnapshot = Pick<RegistryFile, "entries" | "conversations">
  & Partial<Pick<RegistryFile, "conversationAliases" | "receipts" | "heldDeliveries">>;

/** Only recorded headless ownership is read by the liveness projection. */
export type LivenessFlow = Pick<Flow, "reviewerMode"> & {
  rounds: Pick<Flow["rounds"][number], "reviewerPid" | "reviewerIdentity" | "reviewerPath" | "reviewerConversationId">[];
};

export interface LivenessProjectionOptions { signal?: AbortSignal; deadlineMs?: number }

export interface AgentLivenessSources {
  now(): number;
  /** The clock the phase timings are read on. Production omits it and times on
      `performance.now()`; a test steps it to attribute exact milliseconds. */
  phaseClock?(): number;
  /**
   * Bounded selection over ONE completed scanner generation (#860): filters and
   * the row limit are applied to metadata the process already published, before
   * anything opens a transcript. Only a request that names no single
   * conversation calls it.
   */
  selectInventory?(
    request: ConversationSelectionRequest,
    options?: { signal?: AbortSignal | null },
  ): Promise<ConversationSelection>;
  /**
   * The legacy whole-inventory adapter, kept for injected callers that predate
   * the selection seam. Production never installs it: it is the fresh
   * whole-corpus sweep #860 exists to remove.
   */
  listFiles?(): Promise<FileEntry[]>;
  /** One transcript by path, described with no sweep of any kind. `strict`
      throws a stat failure other than a missing file, which otherwise reads
      as null like a path that names no file. */
  describeTranscript(transcriptPath: string, options?: { strict?: boolean }): Promise<LivenessTranscript | null>;
  registrySnapshot(): LivenessRegistrySnapshot;
  /** Keyed registry view for a conversation-only liveness request. */
  registrySnapshotForConversation?(conversationId: string): LivenessRegistrySnapshot;
  pipelines: {
    (): Pipeline[];
    forLiveness?: (targets: { conversationId: string | null; path: string }[], options?: LivenessProjectionOptions) => Promise<(AgentLivenessPipelineRef | null)[]>;
  };
  /** Active review-loop ownership, read only to resolve detached reviewers that
      intentionally have no structured-host registry entry. */
  flows?: { (): Flow[]; forLiveness?: (options?: LivenessProjectionOptions) => Promise<LivenessFlow[]>;
    forTarget?: (conversationIds: readonly string[], paths: readonly string[], options?: LivenessProjectionOptions) => Promise<LivenessFlow[]> };
  /** Turn state and newest-record freshness from ONE tail read. `strict`
      throws an I/O failure other than a missing file, which otherwise reads
      as null like a torn tail. */
  transcriptEvidence(
    engine: "claude" | "codex",
    transcriptPath: string,
    options?: { signal?: AbortSignal | null; strict?: boolean },
  ): Promise<LivenessTranscriptEvidence | null>;
  /** The file a transcript path names right now, or null when it names none.
      Evidence read in an earlier call is reused only under the same identity.
      Omitted, the file is stat'ed. */
  transcriptIdentity?(transcriptPath: string): Promise<string | null>;
  probe: LivenessProbe;
  workProcesses?: (pid: number) => NonNullable<AgentActivityFacts["workProcesses"]>;
  readHostTurnRecord?: typeof readHostTurnRecord;
}

export function productionLivenessSources(
  dependencies: { completedFileScan?: CompletedGenerationRead; catalogBudgetMs?: number } = {},
): AgentLivenessSources {
  const read = dependencies.completedFileScan ?? completedFileScan;
  return {
    now: () => Date.now(),
    /* Consumes the COMPLETED generation the process already published. One scan
       generation serves every catalog read; this one opens none of its own. */
    selectInventory: (request, options) => completedGenerationSelection(request, {
      completedFileScan: read,
      signal: options?.signal ?? null,
      ...(dependencies.catalogBudgetMs === undefined ? {} : { budgetMs: dependencies.catalogBudgetMs }),
    }),
    describeTranscript: describeTranscriptPath,
    registrySnapshot: () => agentRegistry().readOnlySnapshot(),
    registrySnapshotForConversation: conversationId => agentRegistry().livenessConversationSnapshot(conversationId),
    pipelines: Object.assign(() => loadPipelines(), { forLiveness: (targets: { conversationId: string | null; path: string }[], options: LivenessProjectionOptions = {}) =>
      readHistoryProjection(db => targets.map(target => historyPipelineRef(db, target.conversationId, target.path)), { ...options, collections: ["pipelines", "pipelines_archive"] }) }),
    flows: Object.assign(() => loadFlows(), {
      forLiveness: (options: LivenessProjectionOptions = {}) => {
        pipelineSelectionSource(); flowSelectionSource();
        return readHistoryProjection(historyHeadlessFlows, { ...options, collections: ["flows"] });
      },
      forTarget: (conversationIds: readonly string[], paths: readonly string[], options: LivenessProjectionOptions = {}) => {
        pipelineSelectionSource(); flowSelectionSource();
        return readHistoryProjection(db => historyHeadlessFlowsForTarget(db, conversationIds, paths), { ...options, collections: ["flows"] });
      },
    }),
    transcriptEvidence: readLivenessTranscriptEvidence,
    probe: livenessProbe(),
  };
}

/** A native Claude tool result can remain open after the writer closed its turn.
 * The old host can stop recording before the CLI writes its final tool frames.
 * A linked continuation predating the recovered writer belongs to that cut;
 * prompts, notifications and work after the writer started retain custody.
 * Only seat progression opts in; orphan work and release/drain custody keep
 * their existing readers.
 */
async function reconcileWriterIdle(
  evidence: LivenessTranscriptEvidence | null, path: string,
  registry: LivenessRegistrySnapshot, sources: AgentLivenessSources,
): Promise<LivenessTranscriptEvidence | null> {
  if (evidence?.turn !== "busy" || !evidence.nativeTail || !evidence.identity) return evidence;
  // Seat progression asks about the current generation's writer. A live
  // sibling at the same path keeps its own drain verdict through the census.
  const writerEntry = (snapshot: LivenessRegistrySnapshot): AgentRegistryEntry | null => {
    const id = conversationIdForPath(snapshot, path);
    const conversation = id ? canonicalConversation(snapshot, id) : null;
    const generation = conversation?.generations.at(-1);
    if (!generation || generation.path !== path) return null;
    return Object.values(snapshot.entries).find(current => current.artifactPath === path
      && current.key.engine === conversation!.engine && current.key.sessionId === generation.id) ?? null;
  };
  const entry = writerEntry(registry);
  const writerStamp = (snapshot: LivenessRegistrySnapshot): string | null => {
    const current = writerEntry(snapshot);
    if (!current) return null;
    const recorded = entryOwners(current, sources.probe).owners.find(candidate => candidate.role === "host"
      && candidate.structuredHost && candidate.writerEpoch !== null && ownerProcessAlive(candidate, sources.probe));
    const host = current?.structuredHost;
    const owner = current?.claimOwner ? structuredClaimIdentity(current.claimOwner) : null;
    const process = recorded?.identities[0];
    if (current.key.engine !== "claude" || host?.kind !== "claude-broker"
      || current.status !== "idle" || current.pendingAction !== null || host.activeTurnRef !== null
      || host.pendingAttention.length > 0 || (host.pendingPermissions?.length ?? 0) > 0
      || !owner?.startIdentity || !process?.startIdentity
      || !sources.probe.pidAlive(owner.pid) || sources.probe.processIdentity(owner.pid) !== owner.startIdentity
      || !sources.probe.pidAlive(process.pid) || sources.probe.processIdentity(process.pid) !== process.startIdentity
      || current.claimEpoch <= 0 || current.claimEpoch !== host.writerClaimEpoch) return null;
    const id = conversationIdForPath(snapshot, path);
    const conversation = id ? canonicalConversation(snapshot, id) : null;
    const generation = conversation?.generations.at(-1);
    if (!generation || conversation?.engine !== current.key.engine
      || generation.id !== current.key.sessionId || generation.path !== path) return null;
    return JSON.stringify([id, current.key, current.claimOwner, owner, process, current.claimEpoch,
      host.writerClaimEpoch, host.eventCursor, host.activeTurnRef, current.status, current.pendingAction]);
  };
  const stamp = writerStamp(registry);
  if (!stamp || !entry) return evidence;
  const sessionId = entry.key.sessionId;
  const ledger = (sources.readHostTurnRecord ?? readHostTurnRecord)(sessionId);
  if (ledger.state !== "read" || ledger.complete !== true || ledger.turn?.closed?.by !== "turn-ended"
    || !ledger.turn.closed.seq || ledger.latestStatus?.status !== "idle"
    || ledger.latestStatus.seq <= ledger.turn.closed.seq
    || ledger.lastActivitySeq === undefined || ledger.lastActivitySeq > ledger.turn.closed.seq
    || ledger.lastSeq !== entry.structuredHost!.eventCursor) return evidence;
  // A prompt admitted by the native CLI can precede its first provider frame.
  // Require ledger attribution or a proven continuation of the closed turn.
  if (evidence.nativeTail.integrity !== "complete") return evidence;
  const newestWork = evidence.nativeTail.records.findLast(record => record.type === "user" || record.type === "assistant");
  if (!newestWork || typeof newestWork.uuid !== "string") return evidence;
  const mirrored = ledger.framesBefore.some(frame => frame.uuid === newestWork.uuid && frame.turnId === ledger.turn!.turnId);
  if (mirrored) {
    if (engineRecordSince("claude", ledger, evidence.nativeTail) !== "empty") return evidence;
  } else {
    // File mtime can advance on status/cleanup writes long after the close.
    // The verified current process's birth is the recovery boundary instead.
    const startedAt = processLaunchedAt(entry.structuredHost!.process!.startIdentity);
    const anchor = ledger.framesBefore.at(-1);
    const records = evidence.nativeTail.records;
    const anchorIndex = anchor ? records.findLastIndex(record => record.uuid === anchor.uuid) : -1;
    if (startedAt === null || !anchor || anchor.turnId !== ledger.turn.turnId
      || (anchorIndex < 0 && !evidence.nativeTail.prefixTruncated) || ledger.framesAfter.length > 0) return evidence;
    let previousAt = Date.parse(String(anchorIndex < 0 ? anchor.timestamp ?? "" : records[anchorIndex]!.timestamp ?? ""));
    if (!Number.isFinite(previousAt) || previousAt >= startedAt) return evidence;
    const linked = new Set([anchor.uuid]);
    const work = new Set(withoutExitBookkeeping(records.slice(anchorIndex + 1), false)
      .filter(record => record.type === "user" || record.type === "assistant"));
    if (work.size === 0) return evidence;
    for (const record of records.slice(anchorIndex + 1)) {
      if (isTaskNotificationRecord(record) || record.type === "queue-operation"
        || record.type === "user" && !work.has(record)) return evidence;
      const connected = typeof record.parentUuid === "string" && linked.has(record.parentUuid);
      if (work.has(record)) {
        const at = Date.parse(String(record.timestamp ?? ""));
        const content = recordsValue(recordValue(record.message)?.content);
        if (!connected || record.isSidechain === true || typeof record.uuid !== "string" || !record.uuid || linked.has(record.uuid)
          || !Number.isFinite(at) || at < previousAt || at >= startedAt
          || record.type === "user" && (content.length === 0 || content.some(part => part.type !== "tool_result"))) return evidence;
        previousAt = at;
      }
      // Attachments can sit between a tool result and its next assistant frame.
      if (connected && typeof record.uuid === "string") linked.add(record.uuid);
    }
  }
  if (evidence.identity !== await transcriptFileIdentity(path)
    || stamp !== writerStamp(sources.registrySnapshot())
    || ledger.identity !== hostTurnRecordIdentity(sessionId)) return evidence;
  return { ...evidence, turn: "idle" };
}

function isoOrNull(ms: number | null): string | null {
  return ms !== null && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The registry entry that hosts a transcript, matched on the artifact path the
    entry itself records — the only correlation that survives a resumed pane.
    Several entries can record one transcript; a live one is preferred, so a
    dead row never answers for a live one beside it. */
function entryForPath(
  snapshot: Pick<RegistryFile, "entries">,
  transcriptPath: string,
  probe: LivenessProbe,
): AgentRegistryEntry | null {
  let first: AgentRegistryEntry | null = null;
  for (const entry of registryRowsMatching(snapshot as RegistryFile, "entries", "artifactPath", transcriptPath)) {
    if (hostEvidence(entry, probe).state === "alive") return entry;
    first ??= entry;
  }
  return first;
}

/**
 * The host verdict of one registry entry, folded over the owners the census
 * lists for it (docs/design/update-drain-liveness.md), so `agent_activity`
 * and the update drain share one process rule. A live owner answers first,
 * then a recorded process that is gone; a hosted row that records no process
 * is a launch inside its grace, then rot.
 */
function hostEvidence(
  entry: AgentRegistryEntry | null,
  probe: LivenessProbe,
): { state: AgentHostState; kind: "tmux" | "structured" | "headless" | "none"; pid: number | null } {
  if (!entry) return { state: "unknown", kind: "none", pid: null };
  const { owners, ownerless } = entryOwners(entry, probe);
  const kind = (owner: RecordedOwner) => owner.kind === "tmux" ? "tmux" as const : "structured" as const;
  const live = owners.find((owner) => ownerProcessAlive(owner, probe));
  if (live) return { state: "alive", kind: kind(live), pid: live.pid };
  const recorded = owners[0];
  if (recorded) return { state: "gone", kind: kind(recorded), pid: recorded.pid };
  if (ownerless?.updatedAt !== null && ownerless?.updatedAt !== undefined && probe.now() - ownerless.updatedAt < STARTING_GRACE_MS) {
    return { state: "unknown", kind: "none", pid: null };
  }
  return { state: "gone", kind: "none", pid: null };
}

/** Process ownership survives control phases and later review rounds. */
function headlessHostEvidence(
  flows: readonly LivenessFlow[],
  transcriptPath: string | null,
  conversationId: string | null,
  probe: LivenessProbe,
  registry: LivenessRegistrySnapshot,
): { state: AgentHostState; kind: "headless"; pid: number } | null {
  const canonicalId = conversationId ? canonicalConversationId(registry, conversationId) : null;
  let fallback: { state: AgentHostState; kind: "headless"; pid: number } | null = null;
  const deadConversationIds=conversationId&&canonicalId
    ? conversationIdsResolvingTo(registry as RegistryFile,canonicalId as `conversation_${string}`)
    : [conversationId,canonicalId].filter((value):value is string=>value!==null);
  const deadRounds=historyHeadlessDeadRounds(flows,transcriptPath,deadConversationIds);
  const candidates=[...flows.flatMap(flow=>flow.reviewerMode==="headless"?flow.rounds:[]),...deadRounds];
  candidates.sort((left,right)=>{
    const a=left as typeof left & {row_order?:number;row_key?:string;round?:number};
    const b=right as typeof right & {row_order?:number;row_key?:string;round?:number};
    if(a.row_order===undefined||b.row_order===undefined||a.row_key===undefined||b.row_key===undefined)return 0;
    return a.row_order-b.row_order||a.row_key.localeCompare(b.row_key)||(a.round??0)-(b.round??0);
  });
  for (const round of candidates) {
      if (!Number.isInteger(round.reviewerPid) || (round.reviewerPid ?? 0) <= 0
        || (!transcriptPath || round.reviewerPath !== transcriptPath)
        && (!canonicalId || !round.reviewerConversationId || canonicalConversationId(registry, round.reviewerConversationId) !== canonicalId)) continue;
      const verdict = headlessRoundProcess(round, probe);
      const host = { state: verdict === "unproven" ? "unknown" as const : verdict, kind: "headless" as const, pid: round.reviewerPid! };
      if (verdict === "alive") return host;
      if (!fallback || verdict === "unproven") fallback = host;
  }
  return fallback;
}

/**
 * What the process a headless round records says about itself (#2515), for a
 * bound or unbound round.
 *
 * `alive` is the recorded pid answering under its exact start identity. `gone`
 * is a pid that no longer answers, or one that answers under another start
 * identity. Anything short of either is `unproven`: no pid recorded, or an
 * identity that was not saved or cannot be read now.
 */
export function headlessRoundProcess(
  round: { reviewerPid?: number | null; reviewerIdentity?: string | null },
  probe: LivenessProbe,
): "alive" | "gone" | "unproven" {
  const pid=round.reviewerPid;
  if (!Number.isInteger(pid) || (pid ?? 0)<=0) return "unproven";
  const key=`${pid}:${round.reviewerIdentity ?? "?"}`;
  const shared=globalThis as typeof globalThis & {__delegatusHeadlessVerdictsV1?:WeakMap<object,Map<string,{verdict:"alive"|"gone"|"unproven";until:number}>>};
  const caches=shared.__delegatusHeadlessVerdictsV1 ??= new WeakMap();
  const cacheKey=probe.cacheKey ?? probe;
  let cache=caches.get(cacheKey);
  if(!cache){cache=new Map();caches.set(cacheKey,cache);}
  const now=probe.now();
  const prior=cache.get(key);
  if (prior && ((prior.verdict==="gone" && round.reviewerIdentity) || now<prior.until)) { cache.delete(key);cache.set(key,prior);return prior.verdict; }
  const verdict=headlessRoundVerdict(round,probe);
  const until=verdict==="gone" && round.reviewerIdentity ? Infinity : now+1000;
  cache.delete(key);cache.set(key,{verdict,until});
  while(cache.size>8192)cache.delete(cache.keys().next().value!);
  return verdict;
}

function turnStateFromEvidence(evidence: LivenessTranscriptEvidence | null, entry: LivenessTranscript): LifecycleTurnState {
  if (evidence) return evidence.turn;
  /* No readable durable artifact: fall back to the scan's own projection so a
     transient read failure still reports something honest. A targeted lookup
     carries no scan projection, and `unknown` is the honest answer there. */
  if (entry.activityReason === "jsonl_turn_open") return "busy";
  if (entry.activityReason === "jsonl_turn_completed") return "idle";
  return "unknown";
}

/**
 * The provider wait a conversation's own host reported (#2215), as the retry
 * deadline and the instant it was observed — or nothing.
 *
 * This used to be read off the ACCOUNT: the limits poller's own 429 from the
 * usage endpoint, applied to every busy turn on that account. A turn blocked on
 * anything at all then read as `provider_throttled`, with a `retryAt` that moved
 * each time the poller backed off again. Only the engine running the turn can
 * say it is retrying the provider, so only its report counts, and it expires one
 * refresh cadence past the deadline it named.
 */
function hostProviderRetry(
  entry: AgentRegistryEntry | null,
  now: number,
): { retryAt: string | null; throttledAt: number | null } {
  const retry = entry?.structuredHost?.providerRetry;
  const retryAt = hostProviderRetryAt(retry, now);
  if (!retry || retryAt === null) return { retryAt: null, throttledAt: null };
  const at = Date.parse(retry.at);
  return { retryAt, throttledAt: Number.isFinite(at) ? at : null };
}

/**
 * The whole decision table, pure and injectable so the zombie can be replayed
 * as a test instead of described in a comment.
 *
 * The case that matters: `host_gone_turn_open`. A pane-less structured attempt
 * whose transcript ends mid-turn while its host process is gone is reported
 * `stalled` immediately and unconditionally — no silence threshold, because the
 * turn has no process left that could ever advance it. The pipeline record for
 * that same attempt keeps claiming `running`; this surface refuses to echo it.
 *
 * `unknown` host evidence is aged. Reporting `starting` on it regardless of age
 * makes an orphaned transcript from last week look like a launch in progress —
 * the one answer an orchestrator must never get, since it implies waiting.
 */
export function evaluateLiveness(input: {
  host: { state: AgentHostState };
  turnState: LifecycleTurnState;
  silentForMs: number | null;
  stallAfterMs: number;
  turnVerified?: boolean;
  launchAgeMs?: number | null;
  startingGraceMs?: number;
  providerRetryAt?: string | null;
  providerThrottleAt?: number | null;
  providerProgressAt?: number | null;
  /** The oldest permission request the live host holds open, if any. */
  pendingPermission?: PendingPermissionRequest | null;
  pendingQuestion?: PendingQuestionRequest | null;
  settledStage?: boolean;
}): { lifecycle: LifecycleState; reason: AgentLivenessReason; retryAt?: string; permission?: PendingPermissionRequest; question?: PendingQuestionRequest } {
  if (input.host.state === "alive" && input.pendingQuestion) {
    return { lifecycle: "waiting", reason: "question", question: input.pendingQuestion };
  }
  /* An unanswered permission request is the turn's whole explanation: the
     engine waits for an answer, so the silence is neither a stall nor the
     provider (#2215). */
  if (input.host.state === "alive" && input.pendingPermission) {
    return { lifecycle: "waiting", reason: "permission_request", permission: input.pendingPermission };
  }
  const progressSupersedesThrottle = input.providerProgressAt !== null
    && input.providerProgressAt !== undefined
    && input.providerThrottleAt !== null
    && input.providerThrottleAt !== undefined
    && input.providerProgressAt > input.providerThrottleAt;
  if (input.host.state === "alive" && input.turnState === "busy" && input.providerRetryAt && !progressSupersedesThrottle) {
    return { lifecycle: "waiting", reason: "provider_throttled", retryAt: input.providerRetryAt };
  }
  if (input.turnVerified === false) {
    if (input.host.state === "gone") return { lifecycle: "gone", reason: "host_gone_turn_unverified" };
    if (input.host.state === "alive") return { lifecycle: "running", reason: "evidence_unverified" };
    return { lifecycle: (input.launchAgeMs ?? 0) < (input.startingGraceMs ?? STARTING_GRACE_MS) ? "starting" : "gone", reason: "launch_unproven" };
  }
  const silent = input.silentForMs !== null && input.silentForMs >= input.stallAfterMs;
  if (input.host.state === "gone") {
    return input.turnState === "busy"
      ? { lifecycle: "stalled", reason: "host_gone_turn_open" }
      : { lifecycle: "gone", reason: "host_gone_turn_settled" };
  }
  if (input.host.state === "unknown") {
    const grace = input.startingGraceMs ?? STARTING_GRACE_MS;
    /* Nothing to age it by leaves the launch the benefit of the doubt; any
       readable age past the grace takes it away. */
    if (input.silentForMs === null || input.silentForMs < grace) {
      return { lifecycle: "starting", reason: "launch_unproven" };
    }
    return input.turnState === "busy"
      ? { lifecycle: "stalled", reason: "launch_unproven_expired" }
      : { lifecycle: "gone", reason: "launch_unproven_expired" };
  }
  if (input.turnState === "idle") return { lifecycle: "waiting", reason: "host_alive_turn_idle" };
  if (input.turnState === "unknown" && input.settledStage) return { lifecycle: "waiting", reason: "pipeline_stage_settled" };
  if (silent) return { lifecycle: "stalled", reason: "host_alive_transcript_silent" };
  return { lifecycle: "running", reason: "host_alive_turn_active" };
}

/** The activity-aware verdict shared by agent activity and automatic waiting.
 * Tool and descendant-process evidence belongs to the supplied owner only. */
export function evaluateActivityLiveness(input: Parameters<typeof evaluateLiveness>[0] & {
  now: number;
  activityFacts?: AgentActivityFacts | null;
  workProcesses?: AgentActivityFacts["workProcesses"];
  unresolvedActivityOwnership?: boolean;
}) {
  const activity = input.turnVerified !== false && input.host.state === "alive" && input.turnState !== "idle"
    ? classifyAgentActivity({ ...input.activityFacts, lastRecordAt: input.silentForMs === null ? null : input.now - input.silentForMs,
      workProcesses: input.workProcesses }, input.now, input.stallAfterMs)
    : undefined;
  const silent = input.silentForMs !== null && input.silentForMs >= input.stallAfterMs;
  const verified = input.turnVerified !== false
    && !(input.host.state === "alive" && input.turnState !== "idle" && input.activityFacts?.backgroundVerified === false
      && activity?.state !== "checking" && silent)
    && !((input.activityFacts?.turnBoundaryVerified === false || input.unresolvedActivityOwnership)
      && activity?.state !== "checking" && silent);
  const verdict = evaluateLiveness({ ...input, turnVerified: verified,
    settledStage: input.settledStage && activity?.state !== "checking" && !input.activityFacts?.openCall,
    silentForMs: activity?.state === "checking" ? null : input.silentForMs });
  return { ...verdict, verified,
    activity: verified && (verdict.lifecycle === "running" || verdict.lifecycle === "stalled") ? activity : undefined };
}

/** The part of a liveness record that says whether a process still owns it. */
export type LivenessVerdict = Pick<AgentLivenessRecord, "lifecycle" | "reason" | "turnState">
  & { host: Pick<AgentLivenessRecord["host"], "state"> };

/**
 * Whether a process could still be working on the conversation a record names.
 *
 * This is the `liveOnly` filter of `agent_activity` and the update drain's
 * answer to "is this turn really running" (#2515). The two used to be separate
 * readings of the same registry, and they disagreed about every host that had
 * died: `agent_activity` listed three conversations while the drain counted
 * ninety-three turns and held every launch for hours. One predicate, so a dead
 * host reads the same wherever it is asked about.
 */
export function livenessRecordIsLive(record: LivenessVerdict): boolean {
  return record.lifecycle !== "gone" && record.host.state !== "gone" && record.reason !== "launch_unproven_expired";
}

/** The conversation an id names once the registry's aliases are followed. */
export function canonicalConversationId(registry: Pick<LivenessRegistrySnapshot, "conversationAliases">, conversationId: string): string {
  return registry.conversationAliases && conversationId.startsWith("conversation_")
    ? resolveConversationAlias({ conversationAliases: registry.conversationAliases }, conversationId as `conversation_${string}`)
    : conversationId;
}

function canonicalConversation(
  registry: LivenessRegistrySnapshot,
  conversationId: string,
): LivenessRegistrySnapshot["conversations"][string] | undefined {
  return registry.conversations[canonicalConversationId(registry, conversationId)];
}

/** Setup owns a conversation before its first transcript or host entry exists. */
function receiptHostEvidence(registry: LivenessRegistrySnapshot, conversationId: string | null, probe: LivenessProbe, artifactPath?: string) {
  const ownerId = conversationId ? canonicalConversationId(registry, conversationId) : null;
  let alive: { state: "alive"; kind: "structured" | "tmux"; pid: number; turnPending: boolean } | null = null;
  let gone = false;
  let unresolved = false;
  const candidates = new Map<string, RegistryFile["receipts"][string]>();
  for (const receipt of registryRowsMatching(registry as RegistryFile, "receipts", "conversationId", ownerId ? [ownerId, conversationId!] : [])) candidates.set(receipt.launchId, receipt);
  if (artifactPath) for (const receipt of registryRowsMatching(registry as RegistryFile, "receipts", "artifactPath", artifactPath)) candidates.set(receipt.launchId, receipt);
  for (const receipt of candidates.values()) {
    if ((!ownerId || canonicalConversationId(registry, receipt.conversationId) !== ownerId)
      && (!artifactPath || receipt.artifactPath !== artifactPath)) continue;
    const evidence = receiptProcessEvidence(receipt, probe);
    if (evidence?.state === "alive") {
      const candidate = { state: "alive" as const,
        kind: receipt.transport === "structured" ? "structured" as const : "tmux" as const, pid: evidence.process.pid,
        turnPending: receiptIsLive(registry as RegistryFile, receipt, probe) };
      if (candidate.turnPending) return candidate;
      alive ??= candidate;
    }
    if (evidence?.state === "gone") gone = true;
    else unresolved = true;
  }
  return alive ?? (gone && !unresolved ? { state: "gone" as const, kind: "none" as const, pid: null } : null);
}

/** A live open receipt keeps launch setup in flight even when another host is
    selected as the conversation's display host. */
function hasLiveReceiptCustody(registry: LivenessRegistrySnapshot, conversationId: string | null | undefined,
  artifactPath: string, probe: LivenessProbe): boolean {
  if (!conversationId) return false;
  const ownerId = canonicalConversationId(registry, conversationId);
  const candidates = new Map<string, RegistryFile["receipts"][string]>();
  for (const receipt of registryRowsMatching(registry as RegistryFile, "receipts", "conversationId",
    conversationIdsResolvingTo(registry as RegistryFile, ownerId as `conversation_${string}`))) candidates.set(receipt.launchId, receipt);
  for (const receipt of registryRowsMatching(registry as RegistryFile, "receipts", "artifactPath", artifactPath)) candidates.set(receipt.launchId, receipt);
  return [...candidates.values()].some(receipt =>
    (canonicalConversationId(registry, receipt.conversationId) === ownerId || receipt.artifactPath === artifactPath)
      && receiptIsLive(registry as RegistryFile, receipt, probe));
}

/** Pipeline attempts indexed by the conversation and transcript they own, so a
    stalled agent can be named with its stage lineage. */
function pipelineIndex(pipelines: Pipeline[]): {
  byConversation: Map<string, AgentLivenessPipelineRef>;
  byPath: Map<string, AgentLivenessPipelineRef>;
} {
  const byConversation = new Map<string, AgentLivenessPipelineRef>();
  const byPath = new Map<string, AgentLivenessPipelineRef>();
  for (const pipeline of pipelines) {
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (attempt.historical) continue;
        const ref: AgentLivenessPipelineRef = {
          pipelineId: pipeline.id,
          stageId: run.stageId,
          attempt: attempt.n,
          reportedState: attempt.state,
          reportedPipelineState: pipeline.state,
          paneId: attempt.paneId,
          conversationId: attempt.conversationId,
          agentPath: attempt.agentPath,
        };
        if (attempt.conversationId) byConversation.set(attempt.conversationId, ref);
        if (attempt.agentPath) byPath.set(attempt.agentPath, ref);
      }
    }
  }
  return { byConversation, byPath };
}

function transcriptFromEntry(entry: FileEntry): LivenessTranscript {
  return {
    path: entry.path,
    project: entry.project,
    title: entry.title,
    engine: entry.engine,
    mtimeMs: Number.isFinite(entry.mtime) ? entry.mtime * 1000 : Number.NaN,
    sizeBytes: Number.isFinite(entry.size) ? entry.size : undefined,
    conversationId: entry.conversationId ?? null,
    activity: entry.activity ?? null,
    activityReason: entry.activityReason ?? null,
  };
}

/** The conversation that owns a transcript, from the registry the snapshot has
    already read — a targeted lookup has no scan projection to carry one. */
export function conversationIdForPath(
  registry: Pick<LivenessRegistrySnapshot, "conversations" | "conversationAliases">,
  transcriptPath: string,
): string | null {
  for (const conversation of Object.values(registry.conversations)) {
    if (conversation.generations.some((generation) => generation.path === transcriptPath)
      || conversation.continuityPaths?.includes(transcriptPath)) return canonicalConversationId(registry, conversation.id);
  }
  return null;
}

function conversationPathIndex(
  registry: Pick<LivenessRegistrySnapshot, "conversations" | "conversationAliases">,
): Map<string, string> {
  const paths = new Map<string, string>();
  for (const conversation of Object.values(registry.conversations)) {
    const id = canonicalConversationId(registry, conversation.id);
    for (const path of [...conversation.generations.map(generation => generation.path), ...(conversation.continuityPaths ?? [])]) {
      // The existing lookup gives the first recorded owner precedence,
      // including when another conversation claims the same path later.
      if (!paths.has(path)) paths.set(path, id);
    }
  }
  return paths;
}

/** The transcripts the registry projection currently hosts. A completed
    generation can predate a launch by its whole refresh cadence, so liveness
    filtered on the scan projection alone would drop a conversation that started
    a minute ago — the correctness half of not sweeping the corpus (#860). */
function hostedTranscriptPaths(snapshot: LivenessRegistrySnapshot, probe: LivenessProbe): Set<string> {
  const hosted = new Set<string>();
  // Select durable owners before hydrating payloads; enumerating the registry
  // compatibility view makes every archived entry look like a candidate.
  const { entries, receipts } = registryLivenessRows(snapshot as RegistryFile);
  for (const entry of entries) {
    if (entry.artifactPath && hostEvidence(entry, probe).state === "alive") hosted.add(entry.artifactPath);
  }
  for (const receipt of receipts) {
    if (receiptProcessEvidence(receipt, probe)?.state !== "alive") continue;
    const path = receipt.artifactPath ?? canonicalConversation(snapshot, receipt.conversationId)?.generations.at(-1)?.path;
    if (path) hosted.add(path);
  }
  return hosted;
}

export function activeHeadlessTranscriptPaths(
  flows: LivenessFlow[],
  registry: LivenessRegistrySnapshot,
  probe: LivenessProbe,
  pruneConfirmedGone = false,
): Set<string> {
  const paths = new Set<string>();
  const prunedRounds:object[]=[];
  for (let flowIndex=0;flowIndex<flows.length;flowIndex++) {
    const flow=flows[flowIndex]!;
    if (flow.reviewerMode !== "headless") continue;
    for (let roundIndex=0;roundIndex<flow.rounds.length;) {
      const round=flow.rounds[roundIndex]!;
      if (!Number.isInteger(round.reviewerPid) || (round.reviewerPid ?? 0) <= 0) { roundIndex++; continue; }
      const verdict=headlessRoundProcess(round,probe);
      if (pruneConfirmedGone && verdict==="gone" && round.reviewerIdentity) { prunedRounds.push(round); flow.rounds.splice(roundIndex,1); continue; }
      const path = round.reviewerPath
        ?? (round.reviewerConversationId ? canonicalConversation(registry, round.reviewerConversationId)?.generations.at(-1)?.path : null);
      // Selection must retain every owner the final liveOnly predicate protects.
      // An unreadable identity cannot drop a recorded PID before it is judged.
      if (path && verdict !== "gone") paths.add(path);
      roundIndex++;
    }
    if(pruneConfirmedGone&&flow.rounds.length===0)flows.splice(flowIndex--,1);
  }
  if(prunedRounds.length)pruneHistoryHeadlessRounds(flows,prunedRounds);
  return paths;
}

/** Ceiling on identity recovery. Bounded by the registry's active hosts in
    practice; the cap keeps a rotted registry from turning a catalog read into a
    walk. */
export const HOSTED_RECOVERY_MAX = 64;

/**
 * The hosts the generation has not caught up with yet, resolved by identity.
 *
 * Widening the liveness filter rescues a hosted row the generation CONTAINS.
 * A launch newer than the generation has no row to widen onto: an orchestrator
 * that spawns an agent and immediately polls `agent_activity(project, liveOnly)`
 * would not see it until the next completed generation — up to the ordinary
 * refresh cadence away on a host with nothing else driving scans. The fresh
 * whole-corpus sweep this change removes used to hide that.
 *
 * One `stat`-and-describe per unseen active host, so the recovery cost tracks
 * the number of running agents rather than the size of the corpus.
 */
async function recoverHostedTranscripts(
  hostedPaths: ReadonlySet<string>,
  hostedSeen: ReadonlySet<string>,
  projectMatches: (entry: LivenessTranscript) => boolean,
  describe: AgentLivenessSources["describeTranscript"],
  answer: AnswerBudget,
): Promise<{ entries: LivenessTranscript[]; truncated: boolean; pending: number }> {
  const missing: string[] = [];
  for (const path of hostedPaths) {
    if (!hostedSeen.has(path)) missing.push(path);
  }
  if (missing.length === 0) return { entries: [], truncated: false, pending: 0 };
  /* The registry iterates oldest-entry-first, and recovery exists for the
     newest launches. Taking the head of an over-cap list would keep the stale
     active-status rot — permanently absent from every generation, so it fills
     the same slots on every call — and drop the agent that just started. */
  const truncated = missing.length > HOSTED_RECOVERY_MAX;
  const candidates = truncated ? missing.slice(-HOSTED_RECOVERY_MAX) : missing;
  const described = await Promise.all(candidates.map(async (path) => {
    try {
      return await describeWithin(path, describe, answer);
    } catch (error) {
      if (answer.cancelled()) throw error;
      /* A host whose transcript cannot be described is not evidence of
         anything; the rest of the answer still stands. */
      return null;
    }
  }));
  return {
    pending: described.filter((entry) => entry === ANSWER_SPENT).length,
    entries: described.filter((entry): entry is LivenessTranscript => entry !== null && entry !== ANSWER_SPENT
      && (entry.engine === "claude" || entry.engine === "codex" || entry.engine === "copilot")
      && projectMatches(entry)),
    truncated,
  };
}

/** Newest first, with an unreadable mtime ranked last rather than poisoning the
    comparator. */
function byNewest(left: LivenessTranscript, right: LivenessTranscript): number {
  const rank = (entry: LivenessTranscript) => Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : Number.NEGATIVE_INFINITY;
  return rank(right) - rank(left);
}

function livenessAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("liveness snapshot cancelled", "AbortError");
}

const ANSWER_SPENT = Symbol("liveness-answer-budget-spent");

/** The one clock a bounded answer shares between its phases. */
interface AnswerBudget {
  deadlineMs?: number;
  /** The work, or `ANSWER_SPENT` once the budget has ended. Rejects when the
      caller cancels, without waiting for the work to notice. */
  within<T>(work: Promise<T>): Promise<T | typeof ANSWER_SPENT>;
  spent(): boolean;
  /** Whether a clock runs at all; without one nothing is ever left behind. */
  bounded: boolean;
  cancelled(): boolean;
  release(): void;
}

function answerBudget(budgetMs: number | null, signal: AbortSignal | null): AnswerBudget {
  let over = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const ended = budgetMs === null ? null : new Promise<typeof ANSWER_SPENT>((resolve) => {
    timer = setTimeout(() => { over = true; resolve(ANSWER_SPENT); }, budgetMs);
  });
  const interrupted = signal === null ? null : new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(livenessAbortError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  void interrupted?.catch(() => undefined);
  return {
    deadlineMs: budgetMs === null ? undefined : performance.now() + budgetMs,
    within: <T>(work: Promise<T>) => {
      if (!ended && !interrupted) return work;
      /* The loser keeps running; its rejection has nobody left to read it. */
      void work.catch(() => undefined);
      return Promise.race([work, ...(ended ? [ended] : []), ...(interrupted ? [interrupted] : [])]);
    },
    spent: () => over,
    bounded: ended !== null,
    cancelled: () => signal?.aborted === true,
    release: () => {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    },
  };
}

/* A tail read the answer budget walked away from keeps running, and a later
   call takes its result instead of starting the read again, so a tail slower
   than the budget still becomes evidence. The result stays for the calls after
   that one too: dropping it on first use sent every other call back to the head
   of the list, where the re-read tails held all the slots and the rows behind
   them were never reached. What makes it reusable is the file, stat'ed on every
   call: the entry answers only for the identity it was read under. */
const CARRIED_EVIDENCE_IDLE_MS = 60_000;
const CARRIED_EVIDENCE_MAX = 256;
const carriedEvidence = new Map<string, {
  read: Promise<LivenessTranscriptEvidence | null>;
  /** The file as it was before the read started. A file that changed during
      the read no longer matches, and its newer evidence is read again. */
  identity: string;
  usedAt: number;
}>();

function takeCarriedEvidence(transcriptPath: string, identity: string): Promise<LivenessTranscriptEvidence | null> | null {
  const carried = carriedEvidence.get(transcriptPath);
  if (!carried) return null;
  carriedEvidence.delete(transcriptPath);
  if (carried.identity !== identity || performance.now() - carried.usedAt > CARRIED_EVIDENCE_IDLE_MS) return null;
  /* Re-inserted last: the map's order is its eviction order. */
  carriedEvidence.set(transcriptPath, { ...carried, usedAt: performance.now() });
  return carried.read;
}

function carryEvidence(transcriptPath: string, identity: string, read: Promise<LivenessTranscriptEvidence | null>): void {
  for (const [path, carried] of carriedEvidence) {
    if (carriedEvidence.size < CARRIED_EVIDENCE_MAX && performance.now() - carried.usedAt <= CARRIED_EVIDENCE_IDLE_MS) break;
    carriedEvidence.delete(path);
  }
  carriedEvidence.set(transcriptPath, { read, identity, usedAt: performance.now() });
  const drop = () => { if (carriedEvidence.get(transcriptPath)?.read === read) carriedEvidence.delete(transcriptPath); };
  /* An unreadable tail is no evidence to keep; the next call reads it again. */
  void read.then((evidence) => { if (evidence === null) drop(); }, drop);
}

/* The same for a description the budget walked away from: the stat keeps
   running and the next call for that path takes it, once. It is a snapshot of
   the file's size and mtime, which only rank the row and charge its read. */
const CARRIED_DESCRIPTION_MAX_AGE_MS = 10_000;
const carriedDescriptions = new Map<string, { work: Promise<LivenessTranscript | null>; startedAt: number }>();

async function describeWithin(
  transcriptPath: string,
  describe: AgentLivenessSources["describeTranscript"],
  answer: AnswerBudget,
): Promise<LivenessTranscript | null | typeof ANSWER_SPENT> {
  const carried = carriedDescriptions.get(transcriptPath);
  carriedDescriptions.delete(transcriptPath);
  const { work, startedAt } = carried && performance.now() - carried.startedAt <= CARRIED_DESCRIPTION_MAX_AGE_MS
    ? carried
    : { work: describe(transcriptPath), startedAt: performance.now() };
  const described = await answer.within(work);
  if (described === ANSWER_SPENT) {
    for (const [path, kept] of carriedDescriptions) {
      if (carriedDescriptions.size < CARRIED_EVIDENCE_MAX && performance.now() - kept.startedAt <= CARRIED_DESCRIPTION_MAX_AGE_MS) break;
      carriedDescriptions.delete(path);
    }
    carriedDescriptions.set(transcriptPath, { work, startedAt });
    void work.catch(() => { if (carriedDescriptions.get(transcriptPath)?.work === work) carriedDescriptions.delete(transcriptPath); });
  }
  return described;
}

function roundMs(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

/** One request-local resolution cache for catalog selection and host recovery.
 * Names and short keys use the same retained directory as other project reads;
 * canonical keys remain usable before a new host reaches that catalog. */
function livenessProjectSelection(project: string | undefined) {
  const unresolved = new Set<string>();
  if (!project) return { matches: () => true, unresolved };
  const canonical = projectAliasResolver();
  const requestedKey = canonical(project.trim());
  let directory: ReturnType<typeof namedProjectDirectory> | undefined;
  const resolve = (key: string): string => {
    const identity = canonical(key.trim());
    if (isCanonicalProjectId(identity)) return identity;
    directory ??= namedProjectDirectory({ includeActiveSeats: false }, isCanonicalProjectId(requestedKey) ? [requestedKey] : []);
    return resolveNamedProject(identity, directory);
  };
  let requested: string;
  try { requested = resolve(project); }
  catch (error) {
    if (!(error instanceof ProjectNameRefusal) || error.details.code !== "unknown_project") throw error;
    // Existing callers can still name an opaque legacy project key exactly.
    requested = requestedKey;
  }
  const resolutions = new Map<string, string | null>([[project, requested], [requested, requested]]);
  const matches = (entry: Pick<LivenessTranscript, "project" | "path">) => {
    let identity = resolutions.get(entry.project);
    if (identity === undefined) {
      try { identity = resolve(entry.project); }
      catch (error) {
        if (!(error instanceof ProjectNameRefusal)) throw error;
        identity = null;
      }
      resolutions.set(entry.project, identity);
    }
    if (identity === null) unresolved.add(entry.path);
    else unresolved.delete(entry.path);
    return identity === requested;
  };
  return { matches, unresolved };
}

/**
 * The liveness answer for a request, bounded end to end (#860).
 *
 * The order is the whole repair: project, liveness and the row limit are
 * applied to one COMPLETED scanner generation, and only the rows that survive
 * are hydrated — at bounded concurrency, under byte and time budgets, with the
 * caller's cancellation reaching both phases. Before this, ten rows of answer
 * cost a fresh whole-corpus sweep plus a sequential tail read per surviving row,
 * and a caller that timed out left all of it running.
 */
export async function agentLivenessSnapshot(
  request: AgentLivenessRequest,
  sources: AgentLivenessSources,
): Promise<AgentLivenessSnapshot> {
  const answer = answerBudget(
    Number.isFinite(request.answerBudgetMs) ? Math.max(0, request.answerBudgetMs as number) : null,
    request.signal ?? null,
  );
  try {
    return await livenessSnapshotWithin(request, sources, answer);
  } finally {
    answer.release();
  }
}

async function livenessSnapshotWithin(
  request: AgentLivenessRequest,
  sources: AgentLivenessSources,
  answer: AnswerBudget,
): Promise<AgentLivenessSnapshot> {
  const phaseClock = sources.phaseClock ?? (() => performance.now());
  const startedAt = phaseClock();
  const now = sources.now();
  const signal = request.signal ?? null;
  if (signal?.aborted) throw livenessAbortError(signal.reason);
  const stallAfterMs = Number.isFinite(request.stallAfterMs) && (request.stallAfterMs as number) > 0
    ? Math.floor(request.stallAfterMs as number)
    : DEFAULT_STALL_AFTER_MS;
  const limit = Math.max(1, Math.min(200, Number.isInteger(request.limit) ? request.limit as number : 100));

  const projectionStartedAt = phaseClock();
  const targeted = Boolean(request.transcriptPath || request.conversationId);
  const projectSelection = livenessProjectSelection(targeted ? undefined : request.project);
  const registry = performanceSpans.sync("liveness.snapshot", () => request.conversationId && sources.registrySnapshotForConversation
    ? sources.registrySnapshotForConversation(request.conversationId)
    : sources.registrySnapshot());
  // Archive rows are getters that check the database on every access. A
  // fallback through every entry must not enumerate every conversation for
  // each candidate. These indexes belong only to this captured snapshot.
  let paths: Map<string, string> | undefined;
  const conversationForPath = (path: string) => (paths ??= conversationPathIndex(registry)).get(path) ?? null;
  let entriesInRegistry: AgentRegistryEntry[] | undefined;
  const registryEntries = () => entriesInRegistry ??= Object.values(registry.entries);
  const pipelines = performanceSpans.sync("liveness.snapshot", () => pipelineIndex(targeted ? [] : sources.pipelines.forLiveness ? [] : sources.pipelines()));
  const projectionOptions = { ...(request.signal ? { signal: request.signal } : {}), deadlineMs: answer.deadlineMs };
  const flows = targeted
    ? request.conversationId && sources.flows?.forTarget
      ? await sources.flows.forTarget(conversationIdsResolvingTo(registry as RegistryFile,
        canonicalConversationId(registry, request.conversationId) as `conversation_${string}`),
      [...(canonicalConversation(registry, request.conversationId)?.generations.map(g => g.path) ?? []), ...(canonicalConversation(registry, request.conversationId)?.continuityPaths ?? [])], projectionOptions)
      : sources.flows?.() ?? []
    : await (sources.flows?.forLiveness ? sources.flows.forLiveness(projectionOptions) : sources.flows?.() ?? []);
  const hostedPaths = performanceSpans.sync("liveness.snapshot", () => targeted ? new Set<string>() : new Set([
    ...hostedTranscriptPaths(registry, sources.probe),
    ...activeHeadlessTranscriptPaths(flows, registry, sources.probe, Boolean(sources.flows?.forLiveness && canPruneHistoryHeadlessRounds(flows))),
  ]));
  const indexProjectionMs = phaseClock() - projectionStartedAt;

  const identityOf = sources.transcriptIdentity ?? transcriptFileIdentity;
  const readEntry = async (entry: LivenessTranscript, readSignal?: AbortSignal | null): Promise<LivenessTranscriptEvidence | null | typeof ANSWER_SPENT> => {
    if (answer.spent()) return ANSWER_SPENT;
    try {
        /* Only a bounded answer leaves reads behind, so only it pays the stat. */
        const identity = answer.bounded ? await answer.within(identityOf(entry.path).catch(() => null)) : null;
        if (identity === ANSWER_SPENT) return ANSWER_SPENT;
        const carried = identity === null ? null : takeCarriedEvidence(entry.path, identity);
        const read = carried
          ?? sources.transcriptEvidence(entry.engine as "claude" | "codex", entry.path, { signal: readSignal });
        const evidence = await answer.within(read);
        if (evidence === ANSWER_SPENT && identity !== null && !carried) carryEvidence(entry.path, identity, read);
        if (evidence === ANSWER_SPENT || request.reconcileStructuredIdle !== true) return evidence;
        const reconciled = await answer.within(reconcileWriterIdle(evidence, entry.path, registry, sources));
        return reconciled === ANSWER_SPENT ? evidence : reconciled;
      } catch (error) {
        /* One bad row costs one row. Cancellation is the exception: it is the
           caller going away, and it must still stop the pass. */
        if (readSignal?.aborted || isAbortError(error)) throw error;
        return null;
      }
  };
  // Hosted files are independent of catalog membership. Give their bounded
  // reads the time spent waiting for the catalog, with the same concurrency.
  const hostedEvidence = new Map<string, LivenessTranscriptEvidence | null | typeof ANSWER_SPENT>();
  const hostedDescriptions = new Map<string, LivenessTranscript>();

  /* Stat known generations together: a resumed writer can precede its host
     registry update, so generation order alone cannot choose it. */
  const requestedPaths = new Set<string>();
  if (request.transcriptPath) requestedPaths.add(request.transcriptPath);
  if (request.conversationId) {
    /* Through the aliases: a journal row or a card can still hold the id a
       conversation had before its canonical owner adopted it, and that id
       names the same transcript (#2515). */
    const conversation = canonicalConversation(registry, request.conversationId);
    for (const path of [...(conversation?.generations.map(g => g.path) ?? []), ...(conversation?.continuityPaths ?? [])]) requestedPaths.add(path);
  }

  const previousPaths = new Map<string, string[]>();
  const candidatePaths = new Map<string, Set<string>>();
  const unresolvedCurrentWriters = new Set<string>();
  for (const path of targeted ? requestedPaths : [...hostedPaths].slice(0, limit)) {
    const id = conversationForPath(path);
    const candidates = candidatePaths.get(id ?? path) ?? new Set<string>();
    candidates.add(path);
    const conversation = id ? canonicalConversation(registry, id) : null;
    for (const candidate of [...(conversation?.generations.map(g => g.path) ?? []), ...(conversation?.continuityPaths ?? [])]) candidates.add(candidate);
    candidatePaths.set(id ?? path, candidates);
  }
  const hostedRead = hydrateWithBudget(
    [...candidatePaths.values()].filter(paths => answer.bounded || paths.size > 1).slice(0, limit),
    () => EVIDENCE_TAIL_BYTES,
    async (paths, readSignal) => {
      const descriptions = await Promise.all([...paths].map(path => describeWithin(path, sources.describeTranscript, answer).catch(() => null)));
      const describedPaths = new Set(descriptions.flatMap((entry, index) => entry && entry !== ANSWER_SPENT ? [[...paths][index]] : []));
      const currentWriterPaths = new Set<string>();
      if (targeted) {
        for (const path of paths) {
          const entry = entryForPath(registry, path, sources.probe);
          if (entry && hostEvidence(entry, sources.probe).state === "alive") currentWriterPaths.add(path);
        }
      } else {
        for (const entry of registryEntries()) {
          if (hostEvidence(entry, sources.probe).state === "alive" && entry.artifactPath && paths.has(entry.artifactPath)) {
            currentWriterPaths.add(entry.artifactPath);
          }
        }
      }
      for (const path of currentWriterPaths) {
        if (!describedPaths.has(path)) unresolvedCurrentWriters.add(conversationForPath(path) ?? path);
      }
      const entries = descriptions.filter((entry): entry is LivenessTranscript => entry !== null && entry !== ANSWER_SPENT).sort(byNewest);
      if ([...currentWriterPaths].some(path => !describedPaths.has(path))) return;
      const entry = entries[0];
      if (!entry) return;
      for (const path of paths) hostedDescriptions.set(path, entry);
      previousPaths.set(entry.path, [...paths].filter(path => path !== entry.path));
      if (!targeted && [...paths].some(path => hostedPaths.has(path))) hostedPaths.add(entry.path);
      if (!projectSelection.matches(entry)) return;
      hostedEvidence.set(entry.path, await readEntry(entry, readSignal));
    },
    { concurrency: request.evidenceConcurrency ?? DEFAULT_EVIDENCE_CONCURRENCY,
      maxBytes: request.evidenceByteBudget ?? defaultEvidenceByteBudget(limit),
      deadlineAt: sources.now() + (request.evidenceDeadlineMs ?? DEFAULT_EVIDENCE_DEADLINE_MS), signal, now: sources.now },
  );
  void hostedRead.catch(() => undefined);

  const selectionStartedAt = phaseClock();
  let entries: LivenessTranscript[];
  /* Everything the selection phase knows; the hydration counters are filled in
     once the evidence pass has run. */
  let selection: Omit<AgentLivenessSelectionReport, "hydrated" | "unreadable" | "projected" | "evidenceBytes" | "budget">;
  if (targeted) {
    /* The targeted branch. A caller that named a specific target gets back what
       it named and nothing else — even an empty set. Falling through to the
       catalog would turn a stale alias into an unrelated read. */
    /* The description shares the answer's budget and its cancellation: a stat
       that outlives them is reported as not yet described, never waited out. */
    await hostedRead;
    const described = await Promise.all([...requestedPaths].slice(0, limit)
      .map((path) => hostedDescriptions.get(path) ?? describeWithin(path, sources.describeTranscript, answer).catch(() => null)));
    entries = described.filter((entry): entry is LivenessTranscript => entry !== null && entry !== ANSWER_SPENT);
    selection = {
      scope: "targeted",
      scanned: requestedPaths.size,
      matched: entries.length,
      selected: entries.length,
      recovered: 0,
      recoveryTruncated: false,
      recoveryPending: described.filter((entry) => entry === ANSWER_SPENT).length,
      generation: null,
      cacheStatus: null,
      freshScan: false,
    };
  } else {
    const selectionRequest: ConversationSelectionRequest = {
      project: request.project,
      projectMatches: projectSelection.matches,
      liveOnly: request.liveOnly,
      limit,
      hostedPaths,
    };
    let hostedSeen: ReadonlySet<string>;
    if (sources.selectInventory) {
      const selected = await sources.selectInventory(selectionRequest, { signal });
      entries = selected.entries.map(transcriptFromEntry);
      hostedSeen = selected.hostedSeen ?? new Set(selected.entries.map((entry) => entry.path));
      selection = {
        scope: request.project ? "project" : "corpus",
        scanned: selected.scanned,
        matched: selected.matched,
        selected: selected.entries.length,
        recovered: 0,
        recoveryTruncated: false,
        recoveryPending: 0,
        generation: selected.generation,
        cacheStatus: selected.cacheStatus,
        freshScan: selected.freshScan,
      };
    } else if (sources.listFiles) {
      const selected = selectConversationEntries(await sources.listFiles(), selectionRequest);
      entries = selected.entries.map(transcriptFromEntry);
      hostedSeen = selected.hostedSeen;
      selection = {
        scope: request.project ? "project" : "corpus",
        scanned: selected.scanned,
        matched: selected.matched,
        selected: selected.entries.length,
        recovered: 0,
        recoveryTruncated: false,
        recoveryPending: 0,
        generation: null,
        cacheStatus: null,
        freshScan: true,
      };
    } else {
      throw new Error("liveness needs an inventory source: install selectInventory");
    }

    /* Recovery and the completed generation share the same verified-owner
       priority. Order by freshness within each group before the final limit,
       so newer scan-only history cannot displace a recovered owner. */
    await hostedRead;
    const prefetched = [...new Set(hostedDescriptions.values())].filter(entry => hostedPaths.has(entry.path) && !hostedSeen.has(entry.path) && projectSelection.matches(entry));
    const recovery = await recoverHostedTranscripts(hostedPaths, new Set([...hostedSeen, ...prefetched.map(entry => entry.path)]), projectSelection.matches, async path => hostedDescriptions.get(path) ?? sources.describeTranscript(path), answer);
    recovery.entries.push(...prefetched);
    const known = new Set(entries.map((entry) => entry.path));
    const added = recovery.entries.filter((entry) => {
      if (known.has(entry.path)) return false;
      known.add(entry.path);
      return true;
    });
    if (added.length > 0 || recovery.truncated || recovery.pending > 0) {
      if (added.length > 0) entries = [...entries, ...added].sort((left, right) =>
        Number(hostedPaths.has(right.path)) - Number(hostedPaths.has(left.path))
        || byNewest(left, right),
      ).slice(0, limit);
      selection = {
        ...selection,
        matched: selection.matched + added.length,
        selected: entries.length,
        recovered: added.length,
        /* A capped recovery must not read as a complete one. */
        recoveryTruncated: recovery.truncated,
        recoveryPending: recovery.pending,
      };
    }
  }
  const inventorySelectionMs = phaseClock() - selectionStartedAt;
  if (signal?.aborted) throw livenessAbortError(signal.reason);

  await hostedRead;
  const unhostedGenerations = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (hostedDescriptions.has(entry.path)) continue;
    const id = conversationForPath(entry.path) ?? entry.conversationId;
    const conversation = id ? canonicalConversation(registry, id) : null;
    const paths = new Set([entry.path, ...(conversation?.generations.map(g => g.path) ?? []), ...(conversation?.continuityPaths ?? [])]);
    if (paths.size > 1) unhostedGenerations.set(id ?? entry.path, paths);
  }
  await Promise.all([...unhostedGenerations.values()].map(async paths => {
    const descriptions = await Promise.all([...paths].map(path => describeWithin(path, sources.describeTranscript, answer).catch(() => null)));
    const describedPaths = new Set(descriptions.flatMap((entry, index) => entry && entry !== ANSWER_SPENT ? [[...paths][index]] : []));
    const currentWriterPaths = new Set<string>();
    if (targeted) {
      for (const path of paths) {
        const entry = entryForPath(registry, path, sources.probe);
        if (entry && hostEvidence(entry, sources.probe).state === "alive") currentWriterPaths.add(path);
      }
    } else {
      for (const entry of registryEntries()) {
        if (hostEvidence(entry, sources.probe).state === "alive" && entry.artifactPath && paths.has(entry.artifactPath)) {
          currentWriterPaths.add(entry.artifactPath);
        }
      }
    }
    for (const path of currentWriterPaths) {
      if (!describedPaths.has(path)) unresolvedCurrentWriters.add(conversationForPath(path) ?? path);
    }
    if ([...currentWriterPaths].some(path => !describedPaths.has(path))) return;
    const newest = descriptions.filter((description): description is LivenessTranscript => description !== null && description !== ANSWER_SPENT).sort(byNewest)[0];
    if (!newest) return;
    for (const path of paths) hostedDescriptions.set(path, newest);
    previousPaths.set(newest.path, [...paths].filter(path => path !== newest.path));
  }));
  const folded = new Map<string, LivenessTranscript>();
  for (const original of entries) {
    const described = hostedDescriptions.get(original.path);
    const entry = described ? { ...described, title: original.title || described.title, conversationId: original.conversationId ?? described.conversationId } : original;
    const id = conversationForPath(entry.path) ?? entry.conversationId;
    const key = id ?? entry.path;
    const existing = folded.get(key);
    if (!existing || entry.mtimeMs > existing.mtimeMs) folded.set(key, { ...entry, conversationId: id });
    if (original.path !== entry.path) previousPaths.set(entry.path, [...new Set([...(previousPaths.get(entry.path) ?? []), original.path])]);
  }
  entries = [...folded.values()].filter(projectSelection.matches);
  selection.selected = entries.length;
  const hydratable = entries.filter((entry) => entry.engine === "claude" || entry.engine === "codex" || entry.engine === "copilot");
  const evidenceStartedAt = phaseClock();
  const deadlineMs = Number.isFinite(request.evidenceDeadlineMs) && (request.evidenceDeadlineMs as number) > 0
    ? Math.floor(request.evidenceDeadlineMs as number)
    : DEFAULT_EVIDENCE_DEADLINE_MS;

  const hydration = await hydrateWithBudget(
    hydratable,
    (entry) => Math.min(Number.isFinite(entry.sizeBytes) ? entry.sizeBytes as number : EVIDENCE_TAIL_BYTES, EVIDENCE_TAIL_BYTES),
    async (entry, hydrationSignal) => {
      const conversationId = conversationForPath(entry.path) ?? entry.conversationId;
      if (unresolvedCurrentWriters.has(conversationId ?? entry.path)) return null;
      if (hostedEvidence.has(entry.path)) return hostedEvidence.get(entry.path)!;
      return readEntry(entry, hydrationSignal);
    },
    {
      concurrency: Number.isFinite(request.evidenceConcurrency)
        ? Math.max(1, Math.floor(request.evidenceConcurrency as number))
        : DEFAULT_EVIDENCE_CONCURRENCY,
      maxBytes: Number.isFinite(request.evidenceByteBudget)
        ? Math.max(0, Math.floor(request.evidenceByteBudget as number))
        : defaultEvidenceByteBudget(limit),
      /* Anchored HERE, on the same clock the budget reads. A cold generation can
         take tens of seconds to publish; anchoring at the start of the call
         would hand hydration an already-expired budget. */
      deadlineAt: sources.now() + deadlineMs,
      signal,
      now: sources.now,
    },
  );
  const evidenceReadMs = phaseClock() - evidenceStartedAt;
  if (signal?.aborted) throw livenessAbortError(signal.reason);

  /* Projection, then assembly, as two passes over the same rows — so each phase
     timing measures the phase it is named after instead of splitting the
     per-row registry and lineage lookups across both. */
  const rowProjectionStartedAt = phaseClock();
  const narrowRefs = await sources.pipelines.forLiveness?.(hydratable.map(entry => ({ conversationId: conversationForPath(entry.path) ?? entry.conversationId, path: entry.path })), projectionOptions);
  let unreadable = 0;
  /* Rows whose tail answered. A read the answer budget left behind is not one. */
  let answered = 0;
  const processes = sources.workProcesses ?? activityProcessReader(now);
  const projected = performanceSpans.sync("liveness.snapshot", () => hydratable.map((entry, index) => {
    /* Three outcomes, kept apart: a read that produced evidence, a read that
       produced none, and a row the budget never reached. The counters below are
       derived from the same distinction, so the report and the per-row labels
       cannot disagree. */
    const read = hydration.results.get(index);
    const attempted = hydration.results.has(index) && read !== ANSWER_SPENT;
    const evidence = read === ANSWER_SPENT ? null : read ?? null;
    if (attempted) answered += 1;
    if (attempted && evidence === null) unreadable += 1;
    const turnState = turnStateFromEvidence(evidence, entry);
    /* Freshness is the newest RECORD, tool traffic included. Reading it off the
       last assistant prose message reports a live agent in a long tool stretch
       as stalled — the exact question this surface exists to answer. */
    const lastRecordMs = evidence?.lastRecordTs ?? null;
    const silentForMs = lastRecordMs !== null ? Math.max(0, now - lastRecordMs) : null;
    const conversationId = conversationForPath(entry.path) ?? entry.conversationId;
    const registryEntry = entryForPath(registry, entry.path, sources.probe)
      ?? (conversationId ? registryEntries().find(candidate => candidate.artifactPath && conversationForPath(candidate.artifactPath) === conversationId && hostEvidence(candidate, sources.probe).state === "alive") ?? null : null);
    const reviewerHost = headlessHostEvidence(flows, entry.path, conversationId, sources.probe, registry);
    const registeredHost = hostEvidence(registryEntry, sources.probe);
    const receiptHost = receiptHostEvidence(registry, conversationId, sources.probe, entry.path);
    // A current replacement host wins over the previous reviewer's death.
    const host = registeredHost.state === "alive" ? registeredHost : receiptHost?.state === "alive" ? receiptHost
      : reviewerHost ?? receiptHost ?? registeredHost;
    const providerThrottle = turnState === "busy" && host.state === "alive"
      ? hostProviderRetry(registryEntry, now)
      : { retryAt: null, throttledAt: null };
    const pendingPermission = host.state === "alive" && host.kind === "structured"
      ? registryEntry?.structuredHost?.pendingPermissions?.[0] ?? null
      : null;
    const pendingQuestion = host.state === "alive" && host.kind === "structured"
      ? registryEntry?.structuredHost?.pendingQuestions?.[0] ?? null
      : null;
    const pipeline = narrowRefs ? narrowRefs[index] : (conversationId ? pipelines.byConversation.get(conversationId) : undefined)
      ?? pipelines.byPath.get(entry.path) ?? null;
    const matchingStage = conversationId && pipeline?.conversationId
      ? canonicalConversationId(registry, pipeline.conversationId) === canonicalConversationId(registry, conversationId)
      : pipeline?.agentPath === entry.path;
    const stageConversationId = conversationId ?? pipeline?.conversationId;
    const settledStage = turnState === "unknown" && host.state === "alive" && evidence !== null && lastRecordMs !== null
      && matchingStage && pipeline && ["passed", "failed", "needs_decision", "skipped"].includes(pipeline.reportedState)
      && !registryEntry?.pendingAction && !registryEntry?.structuredHost?.activeTurnRef
      && !hasLiveReceiptCustody(registry, stageConversationId, entry.path, sources.probe)
      && (!stageConversationId || !registry.heldDeliveries || !registryRowsMatching(registry as RegistryFile,
        "heldDeliveries", "conversationId", conversationIdsResolvingTo(registry as RegistryFile,
          canonicalConversationId(registry, stageConversationId) as `conversation_${string}`)).some(delivery => delivery.state !== "delivered"));
    const verdict = evaluateActivityLiveness({
      host,
      turnState,
      silentForMs,
      stallAfterMs,
      now,
      turnVerified: evidence !== null && lastRecordMs !== null,
      activityFacts: evidence?.activityFacts,
      workProcesses: evidence !== null && lastRecordMs !== null && host.state === "alive" && turnState !== "idle" && host.pid !== null ? processes(host.pid) : [],
      unresolvedActivityOwnership: unresolvedCurrentWriters.has(conversationId ?? entry.path),
      launchAgeMs: now - entry.mtimeMs,
      // A recorded PID with an unreadable identity is held until proof of
      // death or replacement; it is not an unbound launch aging through grace.
      startingGraceMs: reviewerHost?.state === "unknown" ? Infinity : undefined,
      providerRetryAt: providerThrottle.retryAt,
      providerThrottleAt: providerThrottle.throttledAt,
      providerProgressAt: evidence?.providerProgressAt ?? null,
      pendingPermission,
      pendingQuestion,
      settledStage: Boolean(settledStage),
    });
    return {
      ...verdict,
      entry,
      conversationId,
      turnState,
      lastRecordMs,
      silentForMs: verdict.verified ? silentForMs : null,
      host,
      hostExit: host.state === "gone" ? readHostExit(registryEntry?.hostExitProcess ?? registryEntry?.structuredHost?.exitProcess ?? registryEntry?.structuredHost?.process) : null,
      previousHostExit: registryEntry?.previousHostExit,
      pipeline,
      evidenceSource: (!attempted ? "projection" : evidence !== null ? "transcript" : "unreadable") as AgentLivenessRecord["evidenceSource"],
    };
  }));
  const journalProjectionMs = indexProjectionMs + (phaseClock() - rowProjectionStartedAt);

  const serializationStartedAt = phaseClock();
  const conversations: AgentLivenessRecord[] = performanceSpans.sync("liveness.snapshot", () => projected.map((row) => ({
    ...(row.activity ? { activity: row.activity } : {}),
    verified: row.verified,
    conversationId: row.conversationId,
    transcriptPath: row.entry.path,
    previousPaths: previousPaths.get(row.entry.path) ?? [],
    project: row.entry.project,
    engine: row.entry.engine,
    title: row.entry.title,
    lastRecordAt: isoOrNull(row.lastRecordMs),
    turnState: row.turnState,
    // Setup evidence stays inside the registry verdict; the record names the host.
    host: { state: row.host.state, kind: row.host.kind, pid: row.host.pid },
    hostExit: row.hostExit,
    ...(row.previousHostExit ? { previousHostExit: row.previousHostExit } : {}),
    lifecycle: row.lifecycle,
    reason: row.reason,
    retryAt: row.retryAt ?? null,
    ...(row.permission ? { permission: row.permission } : {}),
    ...(row.question ? { question: row.question } : {}),
    silentForMs: row.silentForMs,
    stalledForMs: row.lifecycle === "stalled" || row.lifecycle === "gone" ? row.silentForMs : null,
    pipeline: row.pipeline,
    evidenceSource: row.evidenceSource,
  })));
  const serializationMs = phaseClock() - serializationStartedAt;

  return {
    observedAt: new Date(now).toISOString(),
    stallAfterMs,
    count: conversations.length,
    ...(projectSelection.unresolved.size ? { unresolvedProjectCount: projectSelection.unresolved.size } : {}),
    stalledCount: conversations.filter((record) => record.lifecycle === "stalled").length,
    stalledConfirmedCount: conversations
      .filter((record) => record.lifecycle === "stalled" && record.evidenceSource === "transcript").length,
    conversations,
    selection: {
      ...selection,
      hydrated: answered,
      unreadable,
      projected: hydratable.length - answered,
      evidenceBytes: hydration.bytes,
      budget: hydration.stopped === "complete" && answered < hydration.hydrated ? "deadline" : hydration.stopped,
    },
    timings: {
      inventorySelectionMs: roundMs(inventorySelectionMs),
      journalProjectionMs: roundMs(journalProjectionMs),
      evidenceReadMs: roundMs(evidenceReadMs),
      serializationMs: roundMs(serializationMs),
      totalMs: roundMs(phaseClock() - startedAt),
    },
  };
}
