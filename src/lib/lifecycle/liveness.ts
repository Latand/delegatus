import { identityAlive, livenessProbe, receiptProcessEvidence, type LivenessProbe } from "@/lib/agent/accountLiveness";
import type { AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";
import { agentRegistry, resolveConversationAlias, structuredClaimIdentity } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { isAbortError } from "@/lib/deadline";
import { hostProviderRetryAt } from "@/lib/limitsThrottle";
import { getPipelines } from "@/lib/pipelines/engine";
import type { Pipeline, PipelineStageAttempt } from "@/lib/pipelines/types";
import { loadFlows } from "@/lib/flows/store";
import type { Flow } from "@/lib/flows/types";
import { completedFileScan } from "@/lib/scanner/scanCache";
import type { PendingPermissionRequest } from "@/lib/runtime/permissionRequests";
import type { Engine, FileEntry } from "@/lib/types";

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

/** Silence under a LIVE host that turns `running` into `stalled`. A dead host
    over an open turn needs no threshold: it can never progress. */
export const DEFAULT_STALL_AFTER_MS = 10 * 60_000;

/** A launch with no host evidence yet is `starting`, not `gone`. Mirrors the
    unproven-launch grace the reaper and blocker evaluation already agree on.
    Past it a launch that never produced host evidence is registry rot, and an
    old transcript with no registry entry at all is not "starting up" either. */
export const STARTING_GRACE_MS = 5 * 60_000;

export type AgentHostState = "alive" | "gone" | "unknown";

export type AgentLivenessReason =
  /** A live host with a turn that is still moving. */
  | "host_alive_turn_active"
  /** A live host with a settled turn — the agent is awaiting input. */
  | "host_alive_turn_idle"
  /** A live host whose transcript has been silent past the stall threshold. */
  | "host_alive_transcript_silent"
  /** A live host reported that its engine is retrying a provider error inside
      this turn, and nothing the provider produced has superseded it (#2215). */
  | "provider_throttled"
  /** A live host holds a tool permission request nobody has answered (#2215):
      the turn waits on an answer, never on the provider. */
  | "permission_request"
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
  /** What the pipeline record currently claims. Reported for contrast, never
      used as liveness evidence — a stale `running` here is the bug, not the
      answer (see the pane-less structured attempt in `pipelines/engine.ts`). */
  reportedState: PipelineStageAttempt["state"];
  reportedPipelineState: Pipeline["state"];
  /** Pane-less attempts are structured-hosted; the reconciler treats their
      durable `busy` turn evidence as "wait forever", so they are the ones that
      strand. */
  paneId: string | null;
}

export interface AgentLivenessRecord {
  conversationId: string | null;
  transcriptPath: string;
  project: string;
  engine: Engine;
  title: string;
  /** ISO timestamp of the newest durable transcript RECORD — tool traffic
      counts, not only assistant prose (falls back to the transcript's own mtime
      when no record carries a timestamp). */
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
  /** Milliseconds since `lastRecordAt`; always reported so a caller can apply
      its own threshold without a second read. */
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
  /** Conversations whose lifecycle is `stalled`, so a poller can branch on one
      number instead of scanning the list. */
  stalledCount: number;
  /**
   * The subset of `stalledCount` whose silence was measured from a transcript
   * read rather than the generation's file mtime (#860).
   *
   * A generation can be a refresh cadence old while the stall threshold is ten
   * minutes, so a projection-backed row can read as stalled after resuming.
   * This is the number that carries the same discipline the journal applies —
   * a headline "N stalled" should prefer it.
   */
  stalledConfirmedCount: number;
  conversations: AgentLivenessRecord[];
  selection: AgentLivenessSelectionReport;
  timings: AgentLivenessTimings;
}

export interface AgentLivenessRequest {
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
  & Partial<Pick<RegistryFile, "conversationAliases" | "receipts">>;

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
  /** One transcript by path, described with no sweep of any kind. */
  describeTranscript(transcriptPath: string): Promise<LivenessTranscript | null>;
  registrySnapshot(): LivenessRegistrySnapshot;
  pipelines(): Pipeline[];
  /** Active review-loop ownership, read only to resolve detached reviewers that
      intentionally have no structured-host registry entry. */
  flows?(): Flow[];
  /** Turn state and newest-record freshness from ONE tail read. */
  transcriptEvidence(
    engine: "claude" | "codex",
    transcriptPath: string,
    options?: { signal?: AbortSignal | null },
  ): Promise<LivenessTranscriptEvidence | null>;
  /** The file a transcript path names right now, or null when it names none.
      Evidence read in an earlier call is reused only under the same identity.
      Omitted, the file is stat'ed. */
  transcriptIdentity?(transcriptPath: string): Promise<string | null>;
  probe: LivenessProbe;
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
    pipelines: () => getPipelines().pipelines,
    flows: () => loadFlows(),
    transcriptEvidence: readLivenessTranscriptEvidence,
    probe: livenessProbe(),
  };
}

function isoOrNull(ms: number | null): string | null {
  return ms !== null && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** The registry entry that hosts a transcript, matched on the artifact path the
    entry itself records — the only correlation that survives a resumed pane. */
function entryForPath(
  snapshot: Pick<RegistryFile, "entries">,
  transcriptPath: string,
): AgentRegistryEntry | null {
  for (const entry of Object.values(snapshot.entries)) {
    if (entry.artifactPath === transcriptPath) return entry;
  }
  return null;
}

function hostEvidence(
  entry: AgentRegistryEntry | null,
  probe: LivenessProbe,
): { state: AgentHostState; kind: "tmux" | "structured" | "headless" | "none"; pid: number | null } {
  if (!entry) return { state: "unknown", kind: "none", pid: null };
  const hosted = entry.status === "starting" || entry.status === "live" || entry.status === "idle" || entry.status === "handoff";
  const structured = entry.structuredHost?.process ?? null;
  const tmux = entry.host
    ? {
        state: identityAlive(entry.host.agent, probe) || identityAlive(entry.host.panePid, probe) ? "alive" as const : "gone" as const,
        kind: "tmux" as const,
        pid: entry.host.agent.pid,
      }
    : null;
  const structuredEvidence = structured
    ? {
        state: identityAlive(structured, probe) ? "alive" as const : "gone" as const,
        kind: "structured" as const,
        pid: structured.pid,
      }
    : null;

  // Status can lag host admission or termination. Recorded live ownership is
  // the same evidence for liveOnly and restart admission, including a child
  // that survived termination and is still fenced by its saved identity.
  if (tmux?.state === "alive") return tmux;
  if (structuredEvidence?.state === "alive") return structuredEvidence;
  const survivor = entry.structuredTerminationSurvivors?.find((identity) => identityAlive(identity, probe));
  if (survivor) return { state: "alive", kind: "structured", pid: survivor.pid };
  // An admitted resume claims the old row before awaiting host setup. Its
  // controller owns that setup even while the row still says dead and has
  // no host process. The matching writer epoch makes this a current claim.
  if (entry.claimOwner && entry.claimEpoch > 0 && entry.structuredHost?.writerClaimEpoch === entry.claimEpoch) {
    const owner = structuredClaimIdentity(entry.claimOwner);
    if (owner && identityAlive(owner, probe)) return { state: "alive", kind: "structured", pid: owner.pid };
  }
  if (!hosted) {
    const recorded = tmux ?? structuredEvidence;
    return recorded ? { ...recorded, state: "gone" } : { state: "gone", kind: "none", pid: null };
  }
  if (tmux) return tmux;
  if (structuredEvidence) return structuredEvidence;

  /* A hosted status with no recorded process is either a launch still being
     admitted or registry rot; the grace decides which. */
  const updatedAt = Date.parse(entry.updatedAt);
  const young = Number.isFinite(updatedAt) && probe.now() - updatedAt < STARTING_GRACE_MS;
  return { state: young ? "unknown" : "gone", kind: "none", pid: null };
}

/** Process ownership survives control phases and later review rounds. */
function headlessHostEvidence(
  flows: readonly Flow[],
  transcriptPath: string | null,
  conversationId: string | null,
  probe: LivenessProbe,
  registry: LivenessRegistrySnapshot,
): { state: AgentHostState; kind: "headless"; pid: number } | null {
  const canonicalId = conversationId ? canonicalConversationId(registry, conversationId) : null;
  let fallback: { state: AgentHostState; kind: "headless"; pid: number } | null = null;
  for (const flow of flows) {
    if (flow.reviewerMode !== "headless") continue;
    for (const round of flow.rounds) {
      if (!Number.isInteger(round.reviewerPid) || (round.reviewerPid ?? 0) <= 0
        || (!transcriptPath || round.reviewerPath !== transcriptPath)
        && (!canonicalId || !round.reviewerConversationId || canonicalConversationId(registry, round.reviewerConversationId) !== canonicalId)) continue;
      const verdict = headlessRoundProcess(round, probe);
      const host = { state: verdict === "unproven" ? "unknown" as const : verdict, kind: "headless" as const, pid: round.reviewerPid! };
      if (verdict === "alive") return host;
      if (!fallback || verdict === "unproven") fallback = host;
    }
  }
  return fallback;
}

/**
 * The process verdict of the headless round that owns this conversation
 * (#2515), including a process whose start identity cannot be proven.
 *
 * A headless launch writes its process only to the flow round; the registry
 * row keeps no host for it. This is the same process evidence the liveness
 * record uses, including when the transcript is missing or moved. A round
 * with no recorded pid adds no process evidence to the conversation's verdict.
 * An unbound dispatch is held separately by its launch markers.
 */
export function headlessReviewerProcess(
  flows: readonly Flow[],
  conversationId: string,
  transcriptPath: string | null,
  probe: LivenessProbe,
  registry: LivenessRegistrySnapshot,
): "alive" | "gone" | "unproven" | null {
  const host = headlessHostEvidence(flows, transcriptPath, conversationId, probe, registry);
  return host ? host.state === "unknown" ? "unproven" : host.state : null;
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
  const pid = round.reviewerPid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "unproven";
  if (!probe.pidAlive(pid)) return "gone";
  const currentIdentity = probe.processIdentity(pid);
  if (!round.reviewerIdentity || !currentIdentity) return "unproven";
  return currentIdentity === round.reviewerIdentity ? "alive" : "gone";
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
  startingGraceMs?: number;
  providerRetryAt?: string | null;
  providerThrottleAt?: number | null;
  providerProgressAt?: number | null;
  /** The oldest permission request the live host holds open, if any. */
  pendingPermission?: PendingPermissionRequest | null;
}): { lifecycle: LifecycleState; reason: AgentLivenessReason; retryAt?: string; permission?: PendingPermissionRequest } {
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
  /* An unanswered permission request is the turn's whole explanation: the
     engine waits for an answer, so the silence is neither a stall nor the
     provider (#2215). */
  if (input.pendingPermission) {
    return { lifecycle: "waiting", reason: "permission_request", permission: input.pendingPermission };
  }
  const progressSupersedesThrottle = input.providerProgressAt !== null
    && input.providerProgressAt !== undefined
    && input.providerThrottleAt !== null
    && input.providerThrottleAt !== undefined
    && input.providerProgressAt > input.providerThrottleAt;
  if (input.turnState === "busy" && input.providerRetryAt && !progressSupersedesThrottle) {
    return { lifecycle: "waiting", reason: "provider_throttled", retryAt: input.providerRetryAt };
  }
  if (input.turnState === "idle") return { lifecycle: "waiting", reason: "host_alive_turn_idle" };
  if (silent) return { lifecycle: "stalled", reason: "host_alive_transcript_silent" };
  return { lifecycle: "running", reason: "host_alive_turn_active" };
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

export interface ConversationRegistryHost {
  /** The host verdict `agent_activity` derives from the same row. */
  state: AgentHostState;
  /** A process the row records still answers under its recorded identity,
      whatever status word the row carries. */
  processAlive: boolean;
}

/** Setup owns a conversation before its first transcript or host entry exists. */
function receiptHostEvidence(registry: LivenessRegistrySnapshot, conversationId: string | null, probe: LivenessProbe, artifactPath?: string) {
  const ownerId = conversationId ? canonicalConversationId(registry, conversationId) : null;
  let gone = false;
  let unresolved = false;
  for (const receipt of Object.values(registry.receipts ?? {})) {
    if ((!ownerId || canonicalConversationId(registry, receipt.conversationId) !== ownerId)
      && (!artifactPath || receipt.artifactPath !== artifactPath)) continue;
    const evidence = receiptProcessEvidence(receipt, probe);
    if (evidence?.state === "alive") return { state: "alive" as const,
      kind: receipt.transport === "structured" ? "structured" as const : "tmux" as const, pid: evidence.process.pid };
    if (evidence?.state === "gone") gone = true;
    else unresolved = true;
  }
  return gone && !unresolved ? { state: "gone" as const, kind: "none" as const, pid: null } : null;
}

/**
 * Host evidence for a conversation's current generation, read off its registry
 * row and launch receipt (#2515).
 *
 * A liveness record needs a transcript the scanner can describe, so an id whose
 * transcript was deleted or moved has no record at all. The row still says who
 * hosts the conversation, and that is the whole question a restart asks: `gone`
 * proves no process owns it, and `processAlive` names one that does. Null when
 * the registry holds no row to read, which proves nothing either way.
 */
export function conversationRegistryHost(
  registry: LivenessRegistrySnapshot,
  conversationId: string,
  probe: LivenessProbe,
): ConversationRegistryHost | null {
  const conversation = canonicalConversation(registry, conversationId);
  const generation = conversation?.generations.at(-1);
  const entry = conversation && generation
    ? registry.entries[sessionKeyId({ engine: conversation.engine, sessionId: generation.id })] ?? entryForPath(registry, generation.path)
    : null;
  const registered = entry ? hostEvidence(entry, probe) : null;
  const host = registered?.state === "alive" ? registered
    : receiptHostEvidence(registry, conversationId, probe) ?? registered;
  if (!host) return null;
  return {
    state: host.state,
    processAlive: host.state === "alive",
  };
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

/** The transcripts the registry projection currently hosts. A completed
    generation can predate a launch by its whole refresh cadence, so liveness
    filtered on the scan projection alone would drop a conversation that started
    a minute ago — the correctness half of not sweeping the corpus (#860). */
function hostedTranscriptPaths(snapshot: LivenessRegistrySnapshot, probe: LivenessProbe): Set<string> {
  const hosted = new Set<string>();
  for (const entry of Object.values(snapshot.entries)) {
    if (entry.artifactPath && hostEvidence(entry, probe).state === "alive") hosted.add(entry.artifactPath);
  }
  for (const receipt of Object.values(snapshot.receipts ?? {})) {
    if (receiptProcessEvidence(receipt, probe)?.state !== "alive") continue;
    const path = receipt.artifactPath ?? canonicalConversation(snapshot, receipt.conversationId)?.generations.at(-1)?.path;
    if (path) hosted.add(path);
  }
  return hosted;
}

function activeHeadlessTranscriptPaths(
  flows: readonly Flow[],
  registry: LivenessRegistrySnapshot,
  probe: LivenessProbe,
): Set<string> {
  const paths = new Set<string>();
  for (const flow of flows) {
    if (flow.reviewerMode !== "headless") continue;
    for (const round of flow.rounds) {
      if (!Number.isInteger(round.reviewerPid) || (round.reviewerPid ?? 0) <= 0) continue;
      const path = round.reviewerPath
        ?? (round.reviewerConversationId ? canonicalConversation(registry, round.reviewerConversationId)?.generations.at(-1)?.path : null);
      // Selection must retain every owner the final liveOnly predicate protects.
      // An unreadable identity cannot drop a recorded PID before it is judged.
      if (path && headlessRoundProcess(round, probe) !== "gone") paths.add(path);
    }
  }
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
  project: string | undefined,
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
      && (!project || entry.project === project)),
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
  const registry = sources.registrySnapshot();
  const pipelines = pipelineIndex(sources.pipelines());
  const flows = sources.flows?.() ?? [];
  const hostedPaths = new Set([
    ...hostedTranscriptPaths(registry, sources.probe),
    ...activeHeadlessTranscriptPaths(flows, registry, sources.probe),
  ]);
  const indexProjectionMs = phaseClock() - projectionStartedAt;

  /* A conversation id names its current generation's transcript; that is the
     only path whose liveness is meaningful. */
  const requestedPaths = new Set<string>();
  const targeted = Boolean(request.transcriptPath || request.conversationId);
  if (request.transcriptPath) requestedPaths.add(request.transcriptPath);
  if (request.conversationId) {
    /* Through the aliases: a journal row or a card can still hold the id a
       conversation had before its canonical owner adopted it, and that id
       names the same transcript (#2515). */
    const conversation = canonicalConversation(registry, request.conversationId);
    const path = conversation?.generations.at(-1)?.path;
    if (path) requestedPaths.add(path);
  }

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
    const described = await Promise.all([...requestedPaths].slice(0, limit)
      .map((path) => describeWithin(path, sources.describeTranscript, answer)));
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
    const recovery = await recoverHostedTranscripts(hostedPaths, hostedSeen, request.project, sources.describeTranscript, answer);
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

  const hydratable = entries.filter((entry) => entry.engine === "claude" || entry.engine === "codex" || entry.engine === "copilot");
  const evidenceStartedAt = phaseClock();
  const deadlineMs = Number.isFinite(request.evidenceDeadlineMs) && (request.evidenceDeadlineMs as number) > 0
    ? Math.floor(request.evidenceDeadlineMs as number)
    : DEFAULT_EVIDENCE_DEADLINE_MS;
  const identityOf = sources.transcriptIdentity ?? transcriptFileIdentity;
  const hydration = await hydrateWithBudget(
    hydratable,
    (entry) => Math.min(Number.isFinite(entry.sizeBytes) ? entry.sizeBytes as number : EVIDENCE_TAIL_BYTES, EVIDENCE_TAIL_BYTES),
    async (entry, hydrationSignal) => {
      if (answer.spent()) return ANSWER_SPENT;
      try {
        /* Only a bounded answer leaves reads behind, so only it pays the stat. */
        const identity = answer.bounded ? await answer.within(identityOf(entry.path).catch(() => null)) : null;
        if (identity === ANSWER_SPENT) return ANSWER_SPENT;
        const carried = identity === null ? null : takeCarriedEvidence(entry.path, identity);
        const read = carried
          ?? sources.transcriptEvidence(entry.engine as "claude" | "codex", entry.path, { signal: hydrationSignal });
        const evidence = await answer.within(read);
        if (evidence === ANSWER_SPENT && identity !== null && !carried) carryEvidence(entry.path, identity, read);
        return evidence;
      } catch (error) {
        /* One bad row costs one row. Cancellation is the exception: it is the
           caller going away, and it must still stop the pass. */
        if (hydrationSignal?.aborted || isAbortError(error)) throw error;
        return null;
      }
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
  let unreadable = 0;
  /* Rows whose tail answered. A read the answer budget left behind is not one. */
  let answered = 0;
  const projected = hydratable.map((entry, index) => {
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
    const lastRecordMs = evidence?.lastRecordTs ?? (Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : null);
    const silentForMs = lastRecordMs !== null ? Math.max(0, now - lastRecordMs) : null;
    const registryEntry = entryForPath(registry, entry.path);
    const conversationId = entry.conversationId ?? conversationIdForPath(registry, entry.path);
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
    return {
      entry,
      conversationId,
      turnState,
      lastRecordMs,
      silentForMs,
      host,
      ...evaluateLiveness({
        host,
        turnState,
        silentForMs,
        stallAfterMs,
        // A recorded PID with an unreadable identity is held until proof of
        // death or replacement; it is not an unbound launch aging through grace.
        startingGraceMs: reviewerHost?.state === "unknown" ? Infinity : undefined,
        providerRetryAt: providerThrottle.retryAt,
        providerThrottleAt: providerThrottle.throttledAt,
        providerProgressAt: evidence?.providerProgressAt ?? null,
        pendingPermission,
      }),
      pipeline: (conversationId ? pipelines.byConversation.get(conversationId) : undefined)
        ?? pipelines.byPath.get(entry.path)
        ?? null,
      evidenceSource: (!attempted ? "projection" : evidence !== null ? "transcript" : "unreadable") as AgentLivenessRecord["evidenceSource"],
    };
  });
  const journalProjectionMs = indexProjectionMs + (phaseClock() - rowProjectionStartedAt);

  const serializationStartedAt = phaseClock();
  const conversations: AgentLivenessRecord[] = projected.map((row) => ({
    conversationId: row.conversationId,
    transcriptPath: row.entry.path,
    project: row.entry.project,
    engine: row.entry.engine,
    title: row.entry.title,
    lastRecordAt: isoOrNull(row.lastRecordMs),
    turnState: row.turnState,
    host: row.host,
    lifecycle: row.lifecycle,
    reason: row.reason,
    retryAt: row.retryAt ?? null,
    ...(row.permission ? { permission: row.permission } : {}),
    silentForMs: row.silentForMs,
    stalledForMs: row.lifecycle === "stalled" || row.lifecycle === "gone" ? row.silentForMs : null,
    pipeline: row.pipeline,
    evidenceSource: row.evidenceSource,
  }));
  const serializationMs = phaseClock() - serializationStartedAt;

  return {
    observedAt: new Date(now).toISOString(),
    stallAfterMs,
    count: conversations.length,
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
