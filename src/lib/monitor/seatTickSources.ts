import type { OverdueTaskCursor } from "@/lib/state/sqliteStateStore";
import { overdueSweepCursor, shownOverdueDates } from "./seatTickReminders";
import { performanceSpans } from "@/lib/performanceSpans";
import { forEachCooperatively as forEachSharedRow } from "@/lib/cooperative";
import { forEachSeatTickRow as forEachCooperatively, seatTickYield as yieldToRuntime, assertSeatTickWork, guardedSeatTickPort } from "./seatTickWork";
import { deepFreeze } from "@/lib/deepFreeze";
import { projectAliasResolver, projectAliasSnapshot } from "@/lib/projects/aliases";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { shortId } from "@/lib/shortIds";
import { seatTickCatchUp } from "./seatTick";
import { withdrawRuntimeWake } from "@/lib/orchestrator/seatChannel";
import { defaultSeatTickAdmissionSources } from "./seatTickAdmissionSources";
import { readReleaseProject } from "@/lib/release/store";
import { readSeatTurnOutcome, type SeatTurnOutcome } from "./seatAuthIncident";
import { recoverSeatQuota } from "./seatQuotaRecovery";
import { effectiveWorkerLimit } from "@/lib/operator/workerLimit";
import { projectWorkerCounts } from "@/lib/orchestrator/workerCount";
import { contextWindowPolicyFor } from "@/lib/orchestrator/contextPolicy";
import { contextReading, readOrchestratorTranscriptFacts } from "@/lib/orchestrator/health";
import type { SeatContextUsage } from "./seatAutoRotation";
import { readDiskPressure, diskPressureLabel, diskPressureWakeReady, type DiskPressure } from "@/lib/state/diskPressure";
import { maintenanceRuns } from "@/lib/boardMaintenance/store";
import { memoryProblemSignals, prepareMemoryProblemRead } from "@/lib/memory/roleProblems";
import { maintenanceRunIsLive, type MaintenanceRun } from "@/lib/boardMaintenance/types";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { liveFreshObservation } from "@/lib/accounts/accountProjection";
import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import fs from "node:fs";
import path from "node:path";
import { RUNNING_PAGE, RUNNING_ROTATE, SeatTickAccounting, type AccountingChild, type AccountingOwner, type TicketPosition } from "./seatTickAccounting";
import { OUTCOME_LIMIT, readChildLedger } from "./seatTickChildLedger";

import {
  agentRegistry,
  readOnlyConversationLookupFromSnapshot,
  resolveConversationAlias,
  SPAWN_STARTING_ADMISSION_LEASE_MS,
  type AgentRegistryEntry,
  type RegistryFile,
  type SeatChildrenPage,
  type SpawnLineageEdge,
  type SpawnReceipt,
} from "@/lib/agent/registry";
import { linkedContext, machineLabel, runsHere } from "@/lib/links/linked";
import { sessionKeyFromTranscript, sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { statePath } from "@/lib/configDir";
import { readAuto, type AutoState } from "@/lib/selfUpdate/auto";
import { readJsonCache } from "@/lib/state/durableJson";
import { pageFromEvents, readLifecycleJournal } from "@/lib/lifecycle/journal";
import { refreshLifecycleJournal } from "@/lib/lifecycle/projector";
import { scopedReportId } from "@/lib/bridge/store";
import { recordDeploySnapshots } from "@/lib/bridge/taskChanges";
import type { SeatTickReportRow } from "./seatTickReports";
import { operatorLocale } from "@/lib/operator/settings";
import { bridgeReportsEnabled } from "@/lib/projects/settings";
import { viewerRepositoryProjects } from "@/lib/projects/viewerRepository";
import viewerPackageManifest from "../../../package.json";
import type { AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import { orchestratorMandateCarriesTickContract } from "@/lib/orchestrator/prompt";
import { canonicalOrchestratorProject, orchestratorSeatEverHeld, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { activeSeatsByCurrentProject } from "@/lib/orchestrator/seatProjectIdentity";
import { pipelineCompletedUnreviewed, pipelineReviewSummary } from "@/lib/pipelines/failEdgeBudget";
import { loadArchivedPipelinesForList, loadArchivedPipelinesForListAsync, loadPipelinesForList, loadPipelinesForListAsync } from "@/lib/pipelines/store";
import { projectTaskPipelineIds } from "@/lib/pipelines/taskBinding";
import { PIPELINE_MERGE_LIVE_STATES, type Pipeline } from "@/lib/pipelines/types";
import { runtimeHostClient, type RuntimeHostClient } from "@/lib/runtime/client";
import type { RuntimeReceiptStatus } from "@/lib/runtime/contracts";
import { latestLedgerDeployment, ledgerDeployment, ledgerDeployments } from "@/lib/runtime/deploymentLedger";
import { findSeatDeploymentByKey, recoverSeatDeploymentRequests, seatDeploymentsFor, type SeatDeploymentRecord } from "@/lib/orchestrator/seatDeployments";
import {
  journalVerdict,
  lookupOriginalSend,
  resolveOriginalSend,
  resolveSendReceipt,
  sendReceiptFor,
  SEND_UNVERIFIED_REASON,
  type OriginalSendBinding,
  type OriginalSendEvidence,
  type SendReceipt,
  type SendReceiptState,
  type SendResendGuidance,
} from "@/lib/runtime/sendSettlement";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { scanRootEntries } from "@/lib/scanner/roots";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";
import type { StructuredHostRetirementReport } from "@/lib/runtime/structuredHostRetirement";
import { loadTasks, loadTasksForList, loadTasksForListAsync, overdueTasks, type OverdueBoardTask } from "@/lib/tasks/store";
import { telegramPostSignals } from "@/lib/prototypeReview/telegramPostSignals";
import { loadSeatRounds } from "@/lib/prototypeReview/seatRounds";
import type { BoardTask } from "@/lib/tasks/types";

import { evidenceFromPipelineCooperatively, evidenceFromPipelines, evidenceFromTasks } from "./evidence";
import type { EvidenceItem } from "./types";
import { openPullRequestsForRepo, type OpenPullRequestsResult } from "./githubEvidence";
import { redactBounded } from "./redact";
import {
  FINGERPRINT_UNREAD,
  SEAT_TICK_WAKE_INTERVAL_MS,
  seatTickSourceGapAfterFailure,
  seatTickSourceRetryDue,
  seatTickWakeDue,
  seatTurnProgressing,
} from "./seatTick";
import { effectiveSeatTickSettings, type SeatTickSettings } from "./seatTickSettings";
import type { PipelineSummary, TaskSummary } from "./viewerApi";
import {
  SEAT_TICK_CHILDREN_GAPS,
  type SeatTickActivity,
  type SeatTickCheckInput,
  type SeatTickChildInput,
  type SeatTickChildrenGap,
  type SeatTickDeployInput,
  type SeatTickEventInput,
  type SeatTickOutstandingWake,
  type SeatTickOwnLaneInput,
  type SeatTickPipelineInput,
  type SeatTickReportsInput,
  type SeatTickPolicy,
  type SeatTickProjectState,
  type SeatTickPullRequestGap,
  type SeatTickPullRequestInput,
  type SeatTickSeatInput,
  type SeatTickSignalInput,
  type SeatTickSourceGap,
  type SeatTickTaskInput,
  type SeatTickTranscriptGap,
  type SeatTickWorkerAskInput,
} from "./types";

/**
 * Everything the pre-check reads (issue #1245), and nothing else.
 *
 * Every source here is durable and already written by the Viewer: the seat
 * store, the pipeline store, the board, the lifecycle journal, the liveness
 * plane, the deployment ledger and the host retirement report. No transcript is
 * scanned by this module and no model is called — the one transcript read in
 * the whole check belongs to `agent_activity`'s own bounded evidence pass,
 * which is where the answer to "is this turn still moving?" already lives.
 */

/** How much of the lifecycle journal one check carries. A backlog can no longer
    bury a live event behind this bound: the history in front of it is sealed
    away by the check that read it (#1285), so the pages advance at the check
    interval and cost nothing, rather than at one paid wake apiece. */
const EVENT_PAGE = 200;
/** Open pull requests one check reads. Bounds the `gh` answer, not the lanes:
    a project with more open pull requests than this has other problems. */
const PULL_REQUEST_LIMIT = 60;
/** Optional GitHub enrichment must leave most of the check budget for delivery. */
const PULL_REQUEST_ENRICHMENT_BUDGET_MS = 200;
/** Finished lanes examined for local commits per check, in bounded Git batches.
    The persisted lane cursor advances subsequent checks and survives restarts. */
const LOCAL_FINISHED_LANE_LIMIT = 60;
const LOCAL_GIT_BATCH_SIZE = 8;
const LOCAL_GIT_TIMEOUT_MS = 250;
/** Bounded pull request title carried into a wake item. */
const PULL_REQUEST_TITLE_LIMIT = 120;
/** Liveness rows one project's check asks for. */
const LIVENESS_LIMIT = 60;
/** Bounded child title carried into a wake item. */
const CHILD_TITLE_LIMIT = 120;
/** Bounded title of a settled lane the seat launched (#1749). */
const OWN_LANE_TITLE_LIMIT = 120;
/** How much of a failed provisioning's reason a wake line carries (#1799).
    The reason is a git error, so it is bounded and redacted like every other
    clause the tick composes. */
const OWN_LANE_DETAIL_LIMIT = 160;
/** Settled lanes of the seat's own one check carries. The decision bounds the
    agenda again at {@link SeatTickPolicy.itemsPerWake}; this bounds the READ,
    so a seat that launched two hundred lanes in its epoch projects a page of
    them rather than all of them. Newest settlement first, because the lane the
    seat just finished is the one it is standing next to. */
const OWN_LANE_LIMIT = 20;

/**
 * What became of a wake the delivery layer accepted and kept.
 *
 * Asked of whichever layer is actually holding it, never of a mirror of that
 * layer. `retained` means it is still the holder's to deliver, so no stamp of
 * the tick's may move; `landed` means the seat has it; `dropped` means the
 * holder settled it without ever delivering it, so the next check may raise it
 * again; `unknown` means the holder could not be asked, which is not evidence
 * of anything and leaves the wake outstanding.
 *
 * `uncertain` (#1465) is the answer the holder gives when it ENDED the send
 * without proving arrival either way — a host that took the message and died,
 * a settlement deadline that passed with no journal to ask. It is not a drop:
 * the seat may have the message, so raising it again under a new key could
 * wake the seat twice. And it is not a landing: nothing the wake carried may
 * be acknowledged on it. The controller keeps it under its original key and
 * puts it on the board.
 *
 * `absent` (#1465) is the record AFFIRMING it holds nothing under the key, for
 * a send that was never given an operation to ask about: the layer refused
 * before reserving anything. It is not proof of loss, so it settles nothing —
 * but it is what licenses the controller to re-dispatch
 * under the same key, which the layer's per-key reservation keeps from ever
 * producing a second copy. Absence beside an operation id is `unknown`.
 */
export type SeatTickWakeState = "retained" | "landed" | "dropped" | "unknown" | "uncertain" | "absent";

/**
 * What taking a retained wake back achieved.
 *
 * `too-late` is the answer this whole mechanism has to be able to give: the
 * holder had already let the payload go, so the replaced seat may have received
 * it. Reporting it as a revocation would be the silent version of the defect
 * the tick exists to prevent, so it is named instead.
 */
export type SeatTickWithdrawal = "withdrawn" | "too-late" | "unknown";

/** Runtime receipt statuses the host has not finished with. `delivering` and
    `applying` are the drain's own in-flight window: still not landed, and no
    longer safe to take back. */
const RUNTIME_QUEUED: ReadonlySet<string> = new Set(["pending", "queued"]);
const RUNTIME_IN_FLIGHT: ReadonlySet<string> = new Set(["delivering", "applying"]);
const RUNTIME_LANDED: ReadonlySet<string> = new Set(["delivered", "applied", "answered"]);

/** The delivery the Viewer registry is holding under this wake's idempotency
    key. The key is the tick's own and carries the project, the seat epoch and
    the state fingerprint, so it identifies one wake across the whole file. */
function registryDeliveryFor(wake: SeatTickOutstandingWake): { id: string; state: string } | null {
  const found = Object.values(agentRegistry().readOnlySnapshot().heldDeliveries)
    .find((delivery) => delivery.clientMessageId === wake.clientMessageId);
  return found ? { id: found.id, state: found.state } : null;
}

/** The runtime journal's receipt for one operation, as far as the tick reads
    it: the status the drain left it in, and the reason written beside it. */
export interface SeatTickJournalReceipt {
  status: RuntimeReceiptStatus;
  reason: string | null;
}

/**
 * What the tick knows about a wake beside its verdict, kept so the verdict can
 * be argued with: which operation the delivery record holds under the wake's
 * key, what that record says of it, and what the runtime journal answered when
 * it was asked. A wake that has been fenced for two days is only as useful as
 * the evidence someone can check against it.
 */
export interface SeatTickWakeEvidence {
  /** The operation the record holds under the key, or the one the wake itself
      names. Null when neither names one. */
  operationId: string | null;
  /** The durable delivery record's own answer, when it holds one. */
  record: { state: SendReceiptState; reason: string | null; resend: SendResendGuidance | null; settledAt: string | null } | null;
  /** The runtime journal's receipt when it was asked; `no-record` when it was
      asked and holds nothing under the operation; `unreachable` when the ask
      itself failed; `unasked` when nothing called for asking it. */
  journal: SeatTickJournalReceipt | "no-record" | "unreachable" | "unasked";
  /** What this read wrote onto the delivery record from the journal's own
      terminal verdict: `lost` settles the old reservation as proven never
      executed, `delivered` records the arrival the record never learned of,
      and `refused` is a record that could not take the verdict — compacted
      to its owner row, or absorbing — so the release rests on the journal
      alone. The wake raised in a released attempt's place is a new message
      to both layers either way (#1672). Absent when nothing was written. */
  recorded?: "delivered" | "lost" | "refused";
  /** A late canonical Claude echo, bound to the original operation and payload. */
  confirmation?: "claude-ledger";
}

/** A holder's answer with the evidence it rests on. A bare
    {@link SeatTickWakeState} is the same answer with no evidence to show. */
export interface SeatTickWakeObservation {
  state: SeatTickWakeState;
  evidence: SeatTickWakeEvidence | null;
}

/** One operation's receipt off the runtime journal, following a retried send
    to the leaf the drain actually holds. Null is the journal holding no record
    under the id. Throws when the host cannot be asked. */
export async function journalReceipt(operationId: string, client: RuntimeHostClient): Promise<SeatTickJournalReceipt | null> {
  const current = await client.operationStatus(operationId, { currentRetryLeaf: true });
  return current ? { status: current.receipt.status, reason: current.receipt.reason ?? null } : null;
}

/**
 * What one journal receipt proves about the wake.
 *
 * An operation the host has no record of is `unknown` (#1465), never a drop:
 * absence is an observation about the journal, and a journal that was rotated,
 * replaced or never reached is not proof that nothing was delivered. The
 * durable delivery record is what proves a loss, and {@link wakeStateFromRecord}
 * asks it first. `interrupted` and the terminal-but-unverified `uncertain` are
 * exactly that — a send ended without proof either way.
 *
 * `failed` and `rejected` are the journal's own proof of non-execution: the
 * delivery queue writes them only where the send never reached the engine,
 * and writes `uncertain` wherever it may have. One `failed` is not that proof
 * — the settlement writes it, carrying its unverified reason, on a runtime
 * host too old to accept the word `uncertain` — so it reads as the unverified
 * ending it is.
 */
export function journalWakeState(receipt: SeatTickJournalReceipt | null): SeatTickWakeState {
  if (!receipt) return "unknown";
  const status = receipt.status;
  if (RUNTIME_QUEUED.has(status) || RUNTIME_IN_FLIGHT.has(status)) return "retained";
  if (RUNTIME_LANDED.has(status)) return "landed";
  if (status === "failed" && receipt.reason === SEND_UNVERIFIED_REASON) return "uncertain";
  if (status === "failed" || status === "rejected") return "dropped";
  return "uncertain";
}

/** The runtime host's own verdict on the operation carrying this wake: the
    receipt, classified. */
export async function runtimeWakeState(operationId: string, client: RuntimeHostClient): Promise<SeatTickWakeState> {
  return journalWakeState(await journalReceipt(operationId, client));
}

/** The send a journal verdict is written back onto. */
export interface WakeRecordTarget {
  conversationId: string;
  operationId: string;
  /** The reservation's own id while the record still holds it; null once it
      has been compacted down to the owner row, which nothing can re-arm. */
  deliveryId: string | null;
}

export interface WakeRecordPorts {
  lookup: (binding: OriginalSendBinding) => Promise<OriginalSendEvidence>;
  /** Ends an in-flight send of the tick's own, or reports it still in flight.
      Absent, the read is inert: an in-flight send is reported retained and
      nothing is ended — the shape a diagnostic read takes. */
  settle?: (operationId: string) => Promise<SendReceipt | null>;
  /** The runtime journal's receipt under an operation id, or null when it
      holds none. May throw when the host cannot be asked. */
  journal: (operationId: string) => Promise<SeatTickJournalReceipt | null>;
  /** Reads canonical engine confirmation when the journal cannot settle the send.
      Missing or unreadable evidence never proves non-delivery. */
  confirmed?: (wake: SeatTickOutstandingWake, operationId: string) => Promise<boolean>;
  /** Writes an authoritative terminal verdict (journal or confirmed engine
      arrival) onto a record the settlement ended without one, and answers
      with the record as it then reads — or
      null when nothing could be written. Absent, the read is inert and the
      journal's verdict is reported as what it proves. */
  settleFromJournal?: (target: WakeRecordTarget, receipt: SeatTickJournalReceipt) => Promise<SendReceipt | null>;
}

/**
 * What the durable delivery record says became of the wake, read under the
 * idempotency key the tick itself bound before the send (#1465, on the #1490
 * contract).
 *
 * The record is asked before any journal: a reservation that the settlement
 * ended is the answer whatever the journal remembers, and the resend guidance
 * it carries is the only thing that distinguishes a PROVEN loss (`safe`, the
 * fenced disposition) from a send that merely could not be verified
 * (`verify-first`). A send still in flight is ended by the settlement itself
 * — this operation is the tick's own, so the tick is the caller entitled to
 * end it — and that answer is classified the same way; inside the settlement
 * window it comes back unchanged, which is `retained`.
 *
 * A record ended WITHOUT proof is not the last word either. The settlement
 * writes `unverified` from whatever it could see at its deadline — a journal
 * with no record yet, a host it could not reach, an executor already in
 * flight — and the tick recorded the send without any operation handle, so
 * until now nothing ever asked the journal about the operation the record
 * names. It is asked here, and only its own terminal verdicts count
 * ({@link journalWakeState}): `delivered` credits the wake, `rejected` and a
 * genuine `failed` release it, and everything else — `uncertain`, an open
 * status, no record, an unreachable host — leaves the record's answer
 * standing. A late canonical Claude confirmation can also prove arrival when
 * the journal no longer has an answer. Absence and silence are never read as
 * non-execution.
 *
 * Absence under the key is not a loss either. A wake the record never held
 * but the runtime queued (a legacy row, a mirror that was compacted) is asked
 * of the runtime; with nothing to ask, the answer is `absent` and the wake
 * stays outstanding under its key.
 */
export async function wakeStateFromRecord(wake: SeatTickOutstandingWake, ports: WakeRecordPorts): Promise<SeatTickWakeObservation> {
  const asked = async (operationId: string): Promise<SeatTickJournalReceipt | "no-record" | "unreachable"> => {
    try {
      return (await ports.journal(operationId)) ?? "no-record";
    } catch {
      return "unreachable";
    }
  };
  const evidence = await ports.lookup({ conversationId: wake.conversationId, clientMessageId: wake.clientMessageId, text: wake.text });
  if (evidence.kind === "absent") {
    if (!wake.operationId) return { state: "absent", evidence: { operationId: null, record: null, journal: "unasked" } };
    const journal = await asked(wake.operationId);
    const state = typeof journal === "string" ? "unknown" : journalWakeState(journal);
    return { state, evidence: { operationId: wake.operationId, record: null, journal } };
  }
  if (evidence.kind !== "found") return { state: "unknown", evidence: { operationId: wake.operationId, record: null, journal: "unasked" } };
  const withRecord = (receipt: SendReceipt, journal: SeatTickWakeEvidence["journal"]): SeatTickWakeEvidence => ({
    operationId: evidence.operationId,
    record: { state: receipt.state, reason: receipt.reason, resend: receipt.resend, settledAt: receipt.settledAt },
    journal,
  });
  if (!evidence.current.readable) return { state: "unknown", evidence: withRecord(evidence.receipt, "unreachable") };
  let current = evidence.current.value;
  if (current.state === "in-flight") {
    if (!ports.settle) return { state: "retained", evidence: withRecord(current, "unasked") };
    const settled = await ports.settle(evidence.operationId);
    if (!settled) return { state: "unknown", evidence: withRecord(current, "unasked") };
    if (settled.state === "in-flight") return { state: "retained", evidence: withRecord(settled, "unasked") };
    current = settled;
  }
  if (current.state === "delivered") {
    // A caller may supply the generic resolver's late-confirmation projection.
    // Preserve the provenance even when it has already projected arrival.
    if (evidence.receipt.state !== "delivered" && ports.confirmed) {
      let confirmed = false;
      try { confirmed = await ports.confirmed(wake, evidence.operationId); } catch { /* The delivered receipt still stands. */ }
      if (confirmed) {
        const journal = await asked(evidence.operationId);
        const written = await ports.settleFromJournal?.(
          { conversationId: wake.conversationId, operationId: evidence.operationId, deliveryId: evidence.deliveryId },
          { status: "delivered", reason: null },
        );
        return { state: "landed", evidence: { ...withRecord(written ?? evidence.receipt, journal), confirmation: "claude-ledger",
          ...(written?.state === "delivered" ? { recorded: "delivered" } : {}) } };
      }
    }
    return { state: "landed", evidence: withRecord(current, "unasked") };
  }
  /* `safe` is the fenced, proven non-delivery and the only failure the record
     alone can license raising the wake again on. */
  if (current.resend === "safe") return { state: "dropped", evidence: withRecord(current, "unasked") };
  const journal = await asked(evidence.operationId);
  const proven = typeof journal === "string" ? "unknown" : journalWakeState(journal);
  if (proven !== "landed" && proven !== "dropped" && ports.confirmed) {
    let confirmed = false;
    try { confirmed = await ports.confirmed(wake, evidence.operationId); }
    catch { /* A failed confirmation read leaves the original uncertainty standing. */ }
    if (confirmed) {
      const written = await ports.settleFromJournal?.(
        { conversationId: wake.conversationId, operationId: evidence.operationId, deliveryId: evidence.deliveryId },
        { status: "delivered", reason: null },
      );
      return { state: "landed", evidence: { ...withRecord(written ?? current, journal), confirmation: "claude-ledger",
        ...(written?.state === "delivered" ? { recorded: "delivered" } : {}) } };
    }
  }
  if (typeof journal === "string") return { state: "uncertain", evidence: withRecord(current, journal) };
  if (proven !== "landed" && proven !== "dropped") {
    return { state: proven === "unknown" ? "uncertain" : proven, evidence: withRecord(current, journal) };
  }
  if (!ports.settleFromJournal) return { state: proven, evidence: withRecord(current, journal) };
  /* The journal's verdict goes onto the record before it is acted on, so the
     record and the journal stop disagreeing about a send whose fate the
     journal has decided. The release does not depend on the write taking:
     the wake raised in a released attempt's place is a new message under a
     new key (#1672), so a record that cannot take the verdict — compacted to
     its owner row, or absorbing — changes nothing about it. It is said on the
     evidence, and the journal's own proof is what the release rests on. */
  const written = await ports.settleFromJournal({ conversationId: wake.conversationId, operationId: evidence.operationId, deliveryId: evidence.deliveryId }, journal);
  if (proven === "landed") {
    return { state: "landed", evidence: { ...withRecord(written ?? current, journal), ...(written?.state === "delivered" ? { recorded: "delivered" } : {}) } };
  }
  if (written?.resend === "safe") return { state: "dropped", evidence: { ...withRecord(written, journal), recorded: "lost" } };
  return { state: "dropped", evidence: { ...withRecord(written ?? current, journal), recorded: "refused" } };
}

/**
 * Take the wake out of the runtime host's queue.
 *
 * This is the same operation transition the delivery drain itself issues to
 * abandon an effect: it settles the receipt and completes the outbox row inside
 * one immediate transaction, so the drain cannot pick the effect up afterwards.
 * Marking the Viewer's registry mirror instead would leave the host's queue
 * untouched and the wake would still be delivered.
 *
 * An operation already in the drain's hands is deliberately NOT transitioned.
 * The engine write may have happened, and failing the receipt underneath a
 * drain that is about to settle it would break that drain for a claim the tick
 * cannot honestly make anyway.
 */
export { withdrawRuntimeWake } from "@/lib/orchestrator/seatChannel";

function overdueTaskInputs(sources: SeatTickSources, project: string, now: number, openTasks: ReadonlySet<string>, shown: readonly string[]): SeatTickTaskInput[] {
  return performanceSpans.sync("seat-tick.project", () => {
    return (sources.overdueTasks?.(project, now, shownOverdueDates(shown, now), overdueSweepCursor(shown, now), shownOverdueDates(shown, now, true)) ?? []).slice(0, 51).map(task => ({
      id: task.id, title: task.text.split(/\r?\n/, 1)[0]!, status: task.status,
      owned: task.chosen === true ? openTasks.has(task.id) : taskEvidenceFor(task).owner !== null,
      updatedAt: task.updatedAt, createdAt: task.createdAt, dueAt: task.dueAt,
      dueHistory: task.dueHistory, priority: task.priority, hold: task.hold, overdueSweep: task.overdueSweep,
    }));
  });
}

export interface SeatTickSources {
  prepareRead?: () => Promise<void>;
  /** Warm problem credit without preparing general history for a deploy wake. */
  prepareMemoryProblems?: () => Promise<void>;
  memoryProblems?: (project: string, shown: readonly string[], recipient: { conversationId: string; seatEpoch: number } | null) => SeatTickSignalInput[];
  recordRuleReports?: (project: string, at: string) => void | Promise<void>;
  /** The waits «Waiting for you» routes to this project's seat
      (docs/design/attention-auto-resolve.md), read from the board projection
      the panel itself reads. Absent: none. */
  workerAsks?: (project: string) => Promise<readonly SeatTickWorkerAskInput[]>;
  seatTurnOutcome?: (conversationId: string) => Promise<SeatTurnOutcome | null>;
  recoverQuota?: (project: string) => Promise<boolean>;
  seatContextUsage?: (conversationId: string) => SeatContextUsage | null;
  diskPressure?: () => Promise<DiskPressure>;
  maintenanceRuns?: (project: string) => readonly MaintenanceRun[];
  seatFor: typeof orchestratorSeatFor;
  /** Whether an orchestrator ever held the project (#2170). Absent: assumed,
      so a missing seat is reported as it always was. */
  seatEverHeld?: (project: string) => boolean;
  /** Projects that currently hold an active seat. */
  activeSeats: () => string[];
  workerCounts?: typeof projectWorkerCounts;
  pipelines: () => readonly Pipeline[];
  /** Settled lanes the hot store has already let go of (#1289). Cold storage,
      so it is read only once a check has decided it would pay for a `gh`
      subprocess anyway — and it has to be read at all because the obligation a
      finished lane leaves behind outlives the lane's three days of residence. */
  archivedPipelines: () => readonly Pipeline[];
  archivedPipelinesAsync?: () => Promise<readonly Pipeline[]>;
  tasks: () => readonly BoardTask[];
  overdueTasks?: (project: string, now: number, shown: readonly string[], cursor: OverdueTaskCursor | null, known: readonly string[]) => readonly OverdueBoardTask[];
  registry: () => ReturnType<typeof agentRegistry>;
  /** The registry's own activity verdict — `agent_activity`'s answer, which is
      the only thing this module is allowed to call a stall. */
  liveness: (request: { reconcileStructuredIdle?: boolean; project?: string; conversationId?: string; stallAfterMs: number; limit: number }) => Promise<AgentLivenessRecord[]>;
  /** The lifecycle journal, read whole and paged in-process, so the tick's own
      cursor decides what is unread rather than a cursor that advanced at poll
      time. */
  lifecycleJournal: typeof readLifecycleJournal;
  /** The most recently started deployment, read in recency order rather than
      sliced off an ordering that has nothing to do with time. */
  latestDeployment: typeof latestLedgerDeployment;
  /** The deployments one seat conversation started (#2063), as
      `deploy_exact_sha` recorded them. Absent reads as none, which is how a
      harness that does not model deploys stays exactly as it was. */
  seatDeployments?: (conversationId: string) => readonly SeatDeploymentRecord[];
  /** Serialized, read-only recovery of an original deployment admission. */
  deploymentByKey?: typeof findSeatDeploymentByKey;
  /** One deployment off the ledger by id (#2063). Absent reads as none. */
  deployment?: typeof ledgerDeployment;
  retirementReport: () => StructuredHostRetirementReport | null;
  /** The retirement journal's sweeps finished at or after `sinceMs` (#1818).
      Absent reads as none. */
  retirementJournal?: (sinceMs: number) => RetirementJournalWindow;
  /** The project's own tick settings (#1275), read fresh per check so a change
      an agent just recorded takes effect at the very next check rather than at
      the next deploy. A project nobody configured reads the defaults. */
  settings: (project: string) => SeatTickSettings;
  /** Open pull requests in the project's repository (#1289), through the same
      `gh` seam as the proposal source. Read at most once per wake interval, and
      only for a project that has a finished lane to attribute one to: a
      subprocess per project per five-minute check would be a cost the tick's
      whole design is arranged to avoid. Answers with a result rather than a
      list, because "no pull request is open" and "nobody could be asked" are
      the two facts this reason must never confuse. */
  openPullRequests: (options: { cwd: string; limit: number }) => Promise<OpenPullRequestsResult>;
  /** Whether the layer holding a retained wake still has it, and whether the
      seat ever got it. The tick's stamps move on this answer and nothing else.
      The production answer carries its evidence; a bare state is the same
      answer with none to show. */
  wakeState: (wake: SeatTickOutstandingWake) => Promise<SeatTickWakeState | SeatTickWakeObservation>;
  /** The durable delivery record under a key the tick bound before a send
      (#1465), for the send whose outcome never came back at all. Read-only.
      Absent means the production lookup over the process registry. */
  originalSend?: (binding: OriginalSendBinding) => Promise<OriginalSendEvidence>;
  /** Take a retained wake back from that same layer, before it can reach a seat
      that has been replaced. The reason is stored where the payload is. */
  withdrawWake: (wake: SeatTickOutstandingWake, reason: string) => Promise<SeatTickWithdrawal>;
  now: () => number;
  /** Runs the lifecycle projection over the pipelines before the journal is
      paged, so stage events reach `lane-event` (docs/design/orchestrator-reports.md
      §1.9). Absent: the journal is read as it stands. */
  refreshLifecycle?: (pipelines: readonly Pipeline[]) => void;
  /** The report log, the project's Bridge reports setting and the operator's
      language (§5.1). Absent: the check keeps no report ledger, as with bridge
      reports off. */
  reports?: {
    log: (project: string) => readonly SeatTickReportRow[] | Promise<readonly SeatTickReportRow[]>;
    enabled: (project: string) => boolean;
    operatorLocale: () => "en" | "uk" | null;
  };
  /** Snapshots of the board's task statuses at each settled deploy, taken in
      the controller pass before the decision (§3.8). Absent: none taken. */
  recordDeploySnapshots?: (project: string) => void;
}

/**
 * The production ports behind {@link wakeStateFromRecord}: the durable delivery
 * record, the tick's own settlement, and the runtime journal over the host
 * socket. `end: false` leaves the settlement out, which makes the read inert —
 * what a diagnostic surface may do, and what a check may not.
 */
export function wakeRecordPorts(options: { end: boolean }): WakeRecordPorts {
  return {
    lookup: (binding) => resolveOriginalSend(binding),
    confirmed: confirmedClaudeWakeDelivery,
    ...(options.end ? { settle: (operationId: string) => resolveSendReceipt(operationId), settleFromJournal: (target, receipt) => settleRecordFromJournal(agentRegistry(), target, receipt) } : {}),
    journal: async (operationId) => {
      const client = runtimeHostClient();
      if (!client) throw new Error("runtime host socket is unavailable");
      return journalReceipt(operationId, client);
    },
  };
}

/**
 * Claude keeps a late replay echo after its send promise has timed out. The
 * runtime journal may already have forgotten that operation, so consult the
 * broker's durable confirmation under the operation the ORIGINAL key owns.
 * Text equality alone grants nothing: key, recipient, operation, generation
 * and content digest must all bind the confirmation to this wake. The read
 * never dispatches and a queued entry never proves that the input arrived.
 */
export async function confirmedClaudeWakeDelivery(wake: SeatTickOutstandingWake, operationId: string): Promise<boolean> {
  const file = agentRegistry().readOnlySnapshot();
  const found = lookupOriginalSend(file, { conversationId: wake.conversationId, clientMessageId: wake.clientMessageId, text: wake.text });
  if (found.kind !== "found" || found.operationId !== operationId) return false;
  const conversation = readOnlyConversationLookupFromSnapshot(file).conversation(wake.conversationId as ViewerConversationId);
  if (!conversation || conversation.engine !== "claude") return false;
  const delivery = found.deliveryId ? file.heldDeliveries[found.deliveryId] : null;
  const owner = file.deliveryOperationOwners[operationId];
  const digest = delivery?.contentDigest ?? owner?.contentDigest;
  if (!digest || (delivery?.command ?? owner?.command)?.kind !== "send") return false;
  const generations = delivery?.generationId
    ? conversation.generations.filter(generation => generation.id === delivery.generationId)
    : conversation.generations;
  const { FileClaudeDeliveryLedger } = await import("@/lib/runtime/claudeStreamBrokerHost");
  const ledger = new FileClaudeDeliveryLedger();
  for (const generation of generations) {
    const entry = ledger.load(generation.id).find(candidate => candidate.entry.id === operationId);
    if (entry?.delivered && entry.entry.contentDigest === digest) return true;
  }
  return false;
}

/**
 * The journal's terminal verdict, written onto the delivery record the way the
 * settlement and the controller's startup reconcile write it — through the
 * repository's one classifier of what a status proves — and only where it
 * proves something: an unverified verdict adds nothing to a record that
 * already says so. A `delivered` is projected under the operation, which the
 * record accepts over a failed reservation; a `lost` goes onto the reservation
 * itself, because that is the row the same-key replay re-arms from, and a
 * reservation already compacted away cannot be re-armed at all.
 */
export async function settleRecordFromJournal(
  registry: ReturnType<typeof agentRegistry>,
  target: WakeRecordTarget,
  receipt: SeatTickJournalReceipt,
): Promise<SendReceipt | null> {
  const verdict = journalVerdict(receipt.status, receipt.reason);
  /* Only what {@link journalWakeState} would act on: the settlement's own
     unverified `failed` classifies as lost here and is not one. */
  if (!verdict || verdict.disposition === "unverified" || journalWakeState(receipt) === "uncertain") return null;
  /* Off the loop (docs/design/delivery-progress-and-drain.md, C2); refused,
     it answers null like an undecidable verdict, and the next tick reads it
     again. */
  try {
    const correlation = { label: "delivery.settle", operationId: target.operationId };
    if (verdict.state === "delivered") {
      const written = await registry.deliveryWrite(correlation, () => registry.recordDeliveryOutcomeForOperation(
        target.conversationId as ViewerConversationId, target.operationId, "delivered", null, "delivered"));
      if (!written.acquired) return null;
    } else if (target.deliveryId) {
      const deliveryId = target.deliveryId;
      const written = await registry.deliveryWrite(correlation,
        () => registry.recordDeliveryOutcome(deliveryId, "failed", receipt.reason ?? verdict.reason, "lost"));
      if (!written.acquired) return null;
    } else {
      return null;
    }
  } catch {
    return null;
  }
  return sendReceiptFor(registry.readOnlySnapshot(), target.operationId);
}

function seatProjectResolver(): (project: string) => string {
  const resolve = projectAliasResolver();
  return project => resolve(project.trim());
}

export function defaultSeatTickSources(): SeatTickSources {
  const admission = defaultSeatTickAdmissionSources();
  let preparing: Promise<void> | undefined;
  let preparingMemoryProblems: Promise<void> | undefined;
  const prepareMemoryProblems = () => preparingMemoryProblems ??= prepareMemoryProblemRead().finally(() => { preparingMemoryProblems = undefined; });
  return {
    ...admission,
    prepareMemoryProblems,
    prepareRead: () => preparing ??= withViewerOperation("seat-tick.prepare", () => performanceSpans.wait("seat-tick.prepare", async () => {
      await loadPipelinesForListAsync();
      await loadTasksForListAsync();
      await prepareMemoryProblems();
    })).finally(() => { preparing = undefined; }),
    liveness: query => query.project ? withViewerOperation("seat-tick.liveness", () => performanceSpans.wait("seat-tick.liveness", async () => {
      const { runSeatSourceInWorker } = await import("@/lib/scanner/filesResponseWorker");
      const { completedFileScan, completedFileScanDescriptor } = await import("@/lib/scanner/scanCache");
      await completedFileScan();
      const scan = completedFileScanDescriptor();
      if (!scan) throw new Error("seat liveness inventory is not published yet");
      const answer = await runSeatSourceInWorker({ type: "seat-liveness", query, scan });
      const current = completedFileScanDescriptor();
      if (current?.epoch !== scan.epoch || current.generation !== scan.generation) throw new Error("seat liveness inventory changed");
      return JSON.parse(answer.body) as AgentLivenessRecord[];
    })) : admission.liveness(query),
    memoryProblems: memoryProblemSignals,
    recordRuleReports: (project, at) => withViewerOperation("seat-tick.rule-reports", () => performanceSpans.wait("seat-tick.rule-reports", async () => {
      const { runSeatSourceInWorker } = await import("@/lib/scanner/filesResponseWorker");
      await runSeatSourceInWorker({ type: "seat-rule-reports", project, at });
    })),
    seatContextUsage: (conversationId) => {
      const conversation = agentRegistry().conversation(conversationId as never);
      const generation = conversation?.generations.at(-1);
      if (!conversation || !generation || (conversation.engine !== "claude" && conversation.engine !== "codex")) return null;
      const model = generation.launchProfile?.model ?? null;
      const facts = readOrchestratorTranscriptFacts(generation.path, null);
      const policy = contextWindowPolicyFor(conversation.engine, model, facts);
      const reading = contextReading({ policy, facts });
      return { engine: conversation.engine, model, tokens: reading.tokens, windowTokens: reading.limit, estimated: reading.estimated };
    },
    seatTurnOutcome: async (conversationId) => {
      const conversation = agentRegistry().conversation(conversationId as never);
      const generation = conversation?.generations.at(-1);
      if (!conversation || !generation || (conversation.engine !== "claude" && conversation.engine !== "codex")) return null;
      return readSeatTurnOutcome(conversation.engine, generation.path);
    },
    recoverQuota: recoverSeatQuota,
    maintenanceRuns,
    /* Seats under the project they serve now (#1874): a seat keyed by its
       folder's old identity is the seat of the key its lanes are written to. */
    seatEverHeld: (project) => orchestratorSeatEverHeld(project),
    activeSeats: () => activeSeatsByCurrentProject().map((seat) => seat.project),
    workerCounts: projectWorkerCounts,
    pipelines: () => deepFreeze(loadPipelinesForList()),
    archivedPipelines: () => loadArchivedPipelinesForList(),
    archivedPipelinesAsync: () => withViewerOperation("seat-tick.prepare", loadArchivedPipelinesForListAsync),
    tasks: () => loadTasksForList(),
    overdueTasks: (project, now, shown, cursor, known) => overdueTasks(project, now, undefined, shown, cursor, known),
    lifecycleJournal: readLifecycleJournal,
    seatDeployments: (conversationId) => seatDeploymentsFor(conversationId),
    deploymentByKey: findSeatDeploymentByKey,
    deployment: (deploymentId) => ledgerDeployment(deploymentId),
    diskPressure: () => readDiskPressure(),
    retirementReport: () => {
      const report = readJsonCache(statePath("host-retirement-report.json"));
      return report && typeof report === "object" ? report as StructuredHostRetirementReport : null;
    },
    retirementJournal: (sinceMs) => readRetirementJournalWindow(statePath("host-retirement-journal.ndjson"), sinceMs),
    workerAsks: (project) => withViewerOperation("seat-tick.worker-asks", () => performanceSpans.wait("seat-tick.worker-asks", async () => {
      const { operatorSeatAgenda } = await import("@/app/api/files/operatorProjection");
      return operatorSeatAgenda(project);
    })),
    openPullRequests: (options) => openPullRequestsForRepo(options),
    /* One rule for both halves: ask, and act on, the layer that is actually
       holding the payload. A send the runtime host queued belongs to the runtime
       host — the registry row beside it is a mirror, and settling a mirror stops
       nothing. A send parked behind an account migration never reached a host at
       all, and there the registry reservation IS the retention. */
    wakeState: async (wake) => wakeStateFromRecord(wake, wakeRecordPorts({ end: true })),
    originalSend: (binding) => resolveOriginalSend(binding),
    withdrawWake: async (wake, reason) => {
      if (wake.operationId) {
        const client = runtimeHostClient();
        return client ? withdrawRuntimeWake(wake.operationId, reason, client) : "unknown";
      }
      const delivery = registryDeliveryFor(wake);
      if (!delivery) return "unknown";
      if (delivery.state === "delivered") return "too-late";
      if (delivery.state !== "held") return "unknown";
      /* Off the loop; refused, the withdrawal is undecided. The row is asked
         again inside the write: an attempt may have claimed it while the
         writer was held, and then it is not withdrawn. */
      const registry = agentRegistry();
      const operationId = registry.readOnlySnapshot().heldDeliveries[delivery.id]?.command.operationId ?? null;
      const withdrawn = await registry.deliveryWrite({ label: "delivery.withdraw", operationId },
        () => registry.withdrawHeldDelivery(delivery.id, operationId, reason));
      return withdrawn.acquired ? withdrawn.value : "unknown";
    },
    refreshLifecycle: (pipelines) => {
      refreshLifecycleJournal({ pipelines: [...pipelines] });
    },
    reports: {
      log: (project) => withViewerOperation("seat-tick.reports", () => performanceSpans.wait("seat-tick.reports", async () => {
        const { runSeatSourceInWorker } = await import("@/lib/scanner/filesResponseWorker");
        return JSON.parse((await runSeatSourceInWorker({ type: "seat-reports", project })).body) as SeatTickReportRow[];
      })),
      enabled: (project) => bridgeReportsEnabled(project),
      operatorLocale: () => operatorLocale(),
    },
    recordDeploySnapshots: (project) => {
      if (!viewerOwnProjectKeys().includes(project)) return;
      snapshotSettledDeploys(project, ledgerDeployments(DEPLOY_SNAPSHOT_WINDOW), loadTasks);
    },
  };
}

/**
 * A board snapshot for every terminal deployment in the ledger's newest
 * window that has none yet (docs/design/orchestrator-reports.md §3.8). The
 * ledger holds every deployment of this install, whoever started it, so the
 * operator's deploys and one a rotated seat started get one too; the seat's
 * own record is never consulted. Idempotent by deployment id. Returns how many
 * snapshots were written.
 */
export function snapshotSettledDeploys(
  project: string,
  read: ReturnType<typeof ledgerDeployments>,
  tasks: () => readonly BoardTask[],
): number {
  if (read.state !== "ok") return 0;
  const terminal = read.value.filter((deployment) => deployment.terminal);
  if (terminal.length === 0) return 0;
  return recordDeploySnapshots(project, terminal.map((deployment) => ({
    deploymentId: deployment.deploymentId,
    revision: deployment.revision,
    phase: deployment.phase,
    terminal: deployment.terminal,
    updatedAt: deployment.updatedAt,
  })), tasks());
}

/** Terminal deployments each pass looks at for a missing snapshot (§3.8). */
const DEPLOY_SNAPSHOT_WINDOW = 20;

/** The projects the Viewer's own deployments build: its repository under
    every name it is known by, folded through the operator's aliases. */
export function viewerOwnProjectKeys(): string[] {
  const configured = process.env.LLV_VIEWER_CANONICAL_REMOTE?.trim();
  const remote = configured || viewerPackageManifest.repository.url.trim();
  return [...new Set(viewerRepositoryProjects(remote, process.cwd()).map(canonicalOrchestratorProject))];
}

/**
 * The report log as one check reads it (§5.1): the project's manager reports
 * and the ids they discharge.
 */
async function reportsInput(project: string, sources: SeatTickSources): Promise<SeatTickReportsInput | undefined> {
  const port = sources.reports;
  if (!port) return undefined;
  try {
    /* A row is the project's when its key folds to the project: a seat recorded
       before its folder changed key filed under the old one, and those rows
       still discharge what they covered. */
    const manager = (await port.log(project)).filter((report) => !!report.project && report.origin?.kind === "manager"
      && (report.project === project || canonicalOrchestratorProject(report.project) === project));
    const filedUnder = [...new Set([project, ...manager.map((report) => report.project!)])];
    const reportedIds = new Set<string>();
    let lastReportAt: string | null = null;
    let latestCoversOwedAt: string | null = null;
    for (const report of manager) {
      reportedIds.add(report.id);
      for (const id of report.covers ?? []) reportedIds.add(id);
      if (!lastReportAt || Date.parse(report.at) > Date.parse(lastReportAt)) lastReportAt = report.at;
      if (report.coversOwedAt && (!latestCoversOwedAt || Date.parse(report.coversOwedAt) > Date.parse(latestCoversOwedAt))) latestCoversOwedAt = report.coversOwedAt;
    }
    return {
      bridgeReports: port.enabled(project),
      operatorLocale: port.operatorLocale(),
      lastReportAt,
      reportedIds: [...reportedIds],
      reportIdsFor: (key) => filedUnder.map((filed) => scopedReportId(filed, key)),
      latestCoversOwedAt,
    };
  } catch {
    /* An unreadable log keeps no ledger this check: nothing is discharged or
       recorded from evidence that could not be read. */
    return undefined;
  }
}

/* Report history is useful on a deploy wake, but its production reader shares
   a serial worker with unrelated projects. Give an already-fast read a chance
   to enrich the message; a queued or slow read must never hold the deploy
   obligation behind that worker. The worker owns its own eventual timeout. */
const DEPLOY_WAKE_REPORTS_BUDGET_MS = 50;

async function deployWakeReportsInput(project: string, sources: SeatTickSources): Promise<SeatTickReportsInput | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reportsInput(project, sources),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), DEPLOY_WAKE_REPORTS_BUDGET_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * A lane the seat could still act on.
 *
 * `hiddenAt` is part of the predicate because hiding something and then
 * reporting it as work is a contradiction on its own terms (#1274). A draft the
 * operator discarded before this fix landed carries `hiddenAt` with `state:
 * "draft"` and `closedAt: null`, and read as open it was parked by the stall
 * rule at every check — an hourly wake carrying a lane whose only exit verb was
 * the one the operator had just refused to press. Records written from now on
 * settle properly (`discardDraft`); this clause is what retires the ones
 * already on disk.
 *
 * `dismissedAt` is there for the same reason, reversibly. A lane the operator
 * dismissed off the board is still running or parked, but it is not work the
 * seat is asked to act on, so it raises no stalled, interval or pull-request
 * wake. {@link laneSettlement} already honoured it; the open set did not, and a
 * dismissed parked lane woke the seat at every interval. `undismiss` clears the
 * field and the lane is open evidence again.
 */
function isOpen(pipeline: Pipeline): boolean {
  return !pipeline.closedAt && !pipeline.hiddenAt && !pipeline.dismissedAt
    && pipeline.state !== "completed" && pipeline.state !== "closed";
}

/**
 * A lane that RAN and reached the end, which is the only kind whose pull
 * request is an obligation (#1289).
 *
 * A hidden record is excluded on the same reasoning as {@link isOpen}: a
 * discarded draft never ran, so nothing it names was ever published and there
 * is nothing for it to have left behind.
 */
function isFinished(pipeline: Pipeline): boolean {
  return !pipeline.hiddenAt && (!!pipeline.closedAt || pipeline.state === "completed" || pipeline.state === "closed");
}

/** The projection `evidence.ts` correlates on, built in-process rather than
    fetched over HTTP: movement is attempt-level, never `createdAt`. */
export function pipelineSummary(pipeline: Pipeline): PipelineSummary {
  const activityAt = [
    pipeline.pausedAt,
    pipeline.resumedAt,
    ...pipeline.runs.flatMap((run) => run.attempts.flatMap((attempt) => [attempt.startedAt, attempt.completedAt])),
  ].filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  return {
    id: pipeline.id,
    task: pipeline.task,
    project: pipeline.project,
    state: pipeline.state,
    createdAt: pipeline.createdAt,
    closedAt: pipeline.closedAt,
    ...(pipeline.spec ? { spec: pipeline.spec } : {}),
    activityAt,
  };
}

/**
 * What settled about a lane, or nothing (#1749).
 *
 * Read off the lane's own record rather than the lifecycle journal, because the
 * journal entry for a lane that has since finished is history the check seals
 * away without a wake — which is exactly how a pipeline that completed inside
 * the minute before a tick reached the seat as no item at all.
 *
 * A lane explicitly closed, hidden or dismissed is no longer on the seat's
 * board. Completion writes closedAt automatically, so that timestamp cannot
 * stand for the seat hearing that the lane completed (#2081).
 */
function laneSettlement(pipeline: Pipeline): SeatTickOwnLaneInput["settled"] | null {
  if (deeplyFrozen(pipeline) && seatProjectionHost.__llvSeatTickPipelineSettlement?.has(pipeline)) {
    return seatProjectionHost.__llvSeatTickPipelineSettlement.get(pipeline) ?? null;
  }
  if (pipeline.hiddenAt || pipeline.dismissedAt || pipeline.state === "closed") return null;
  const attempts = pipeline.runs.flatMap((run) => run.attempts);
  /* #1938: a spent review budget left an unreviewed head. It is never
     "completed", and it outranks the passed fix attempt it ended on. */
  if (pipeline.state === "needs_review" || pipeline.pausedState === "needs_review") return "needs_review";
  if (pipeline.state === "completed") return "completed";
  if (pipeline.state === "needs_decision" || pipeline.pausedState === "needs_decision") {
    /* A lane that parked with no attempt behind it never ran a stage, so what
       stopped it is its own provisioning (#1799): the base fetch or the
       worktree the controller makes after the create call was answered. The
       seat is told that as what it is, with the reason, rather than as a lane
       "parked on a decision" it would have to go and read. */
    return attempts.length === 0 ? "provisioning-failed" : "needs_decision";
  }
  /* Otherwise the lane is still open, and only its newest attempt can say it
     stopped: a stage that failed — a spawn that never came up among them —
     leaves the lane holding an attempt in that state with nothing after it. A
     lane whose newest attempt is running or pending is simply working. */
  const newest = attempts.reduce<typeof attempts[number] | null>((held, attempt) => {
    const at = Date.parse(attempt.completedAt ?? attempt.startedAt ?? "");
    const heldAt = held ? Date.parse(held.completedAt ?? held.startedAt ?? "") : Number.NEGATIVE_INFINITY;
    return Number.isFinite(at) && at >= heldAt ? attempt : held;
  }, null);
  if (newest?.state === "failed") return "failed";
  if (newest?.state === "needs_decision") return "needs_decision";
  /* The answer the seat's own create call could not give it (#1799): the call
     is answered while the base is still unresolved, so "the lane you asked for
     is up and its first stage is running" arrives here instead. It is the
     lane's FIRST attempt and only its first — past that the lane is simply
     working, and the interval agenda already lists it as open.

     A lane still in `provisioning` has not been provisioned; one that is
     running with no attempt yet is between the two and settles nothing. */
  if (pipeline.state === "running" && attempts.length === 1) return "provisioned";
  return null;
}

/** Newest movement instant of a lane, for the backlog bound the decision
    applies; `createdAt` when nothing has moved since. */
function laneMovedAt(pipeline: Pipeline): string | null {
  if (deeplyFrozen(pipeline)) {
    const cached = seatProjectionHost.__llvSeatTickPipelineMovement?.get(pipeline);
    if (cached !== undefined) return cached ?? pipeline.createdAt ?? null;
  }
  const summary = pipelineSummary(pipeline);
  const newest = summary.activityAt.reduce<string | null>((held, at) =>
    !held || Date.parse(at) > Date.parse(held) ? at : held, null);
  return newest ?? pipeline.createdAt ?? null;
}

/**
 * The seat's own settled lanes (#1749).
 *
 * `srcConversationId` is what makes a lane the seat's: the pipeline store
 * records the transcript that created it, so a lane the operator or another
 * agent opened settles onto their board and never onto this seat's wake.
 */
/** How many other open pipelines a finished marked lane's task waits on
    (#2187 §5.3), the most over its tasks; absent when none waits. */
export function taskWaitField(pipeline: Pipeline): { taskWaits?: number } {
  const open = Math.max(0, ...(pipeline.taskFinishWaits ?? []).map((wait) => wait.open.length));
  return open > 0 ? { taskWaits: open } : {};
}

function ownSettledLanes(
  project: string,
  seat: SeatTickSeatInput | null,
  announced: readonly string[],
  pipelines: readonly Pipeline[],
  catchUp = false,
): SeatTickOwnLaneInput[] {
  const canonicalProject = seatProjectResolver();
  if (!seat) return [];
  /* The HOT store only, and deliberately: a settled lane lives there for three
     days, which is the same window the decision's backlog bound keeps this
     reason inside. A lane old enough to have been archived is past the bound
     before it could be read, so paying for cold storage on every check would
     buy nothing — and the archive read is the one #1289 kept behind a check
     that had already decided to pay for a subprocess. */
  const candidates: Array<{ pipeline: Pipeline; settled: NonNullable<SeatTickOwnLaneInput["settled"]>; updatedAt: string | null }> = [];
  const before = (left: typeof candidates[number], right: typeof candidates[number]) => {
    const time = (value: string | null) => value ? Date.parse(value) : Number.NaN;
    return (time(right.updatedAt) || 0) - (time(left.updatedAt) || 0) || left.pipeline.id.localeCompare(right.pipeline.id);
  };
  for (const pipeline of pipelines) {
    if (canonicalProject(pipeline.project) !== project) continue;
    if (pipeline.srcConversationId !== seat.conversationId) continue;
    const settled = laneSettlement(pipeline);
    if (!settled) continue;
    /* The legacy bare id announced only provisioning. A later state is new
       news, and a landed wake records that state separately (#2081). */
    if (announced.includes(`${pipeline.id}:${settled}`)
      || (settled === "provisioned" && announced.includes(pipeline.id))) continue;
    const candidate = { pipeline, settled, updatedAt: laneMovedAt(pipeline) };
    if (!catchUp && candidates.length === OWN_LANE_LIMIT && before(candidate, candidates.at(-1)!) >= 0) continue;
    let low = 0, high = candidates.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (before(candidate, candidates[mid]!) < 0) high = mid;
      else low = mid + 1;
    }
    candidates.splice(low, 0, candidate);
    if (!catchUp && candidates.length > OWN_LANE_LIMIT) candidates.pop();
  }
  return candidates.map(({ pipeline, settled, updatedAt }) => ({
      id: pipeline.id,
      title: redactBounded(pipeline.task.split("\n")[0] ?? "", OWN_LANE_TITLE_LIMIT),
      settled,
      updatedAt,
      ...(settled === "provisioning-failed"
        ? { detail: redactBounded(pipeline.stateDetail ?? "", OWN_LANE_DETAIL_LIMIT) || null }
        : {}),
      ...(settled === "needs_review" && pipelineReviewSummary(pipeline) ? { review: pipelineReviewSummary(pipeline)! } : {}),
      ...taskWaitField(pipeline),
    }));
}

/** A delivered lane announcement survives every check that could still offer
 * that lane. Prune only after the hot lane is gone or outside the same backlog
 * bound the decision uses; a fixed token count loses live deduplication. */
function retainedLaneAnnouncements(
  announced: readonly string[],
  pipelines: readonly Pipeline[],
  project: string,
  seat: SeatTickSeatInput | null,
  now: number,
  backlogAfterMs: number,
): string[] {
  const canonicalProject = seatProjectResolver();
  if (!seat) return [...announced];
  const eligible = new Set(pipelines.filter((pipeline) => {
    if (canonicalProject(pipeline.project) !== project || pipeline.srcConversationId !== seat.conversationId
      || pipeline.hiddenAt || pipeline.dismissedAt || pipeline.state === "closed") return false;
    const movedAt = laneMovedAt(pipeline);
    return movedAt !== null && Number.isFinite(Date.parse(movedAt)) && now - Date.parse(movedAt) < backlogAfterMs;
  }).map((pipeline) => pipeline.id));
  return announced.filter((token) => eligible.has(token.split(":", 1)[0]!));
}

/** Settled deployments of the seat's own one check carries (#2063). */
const SEAT_DEPLOY_LIMIT = 5;

/**
 * The deployments the seat started that have settled and that no landed wake
 * has announced (#2063).
 *
 * The seat ends its turn after `deploy_exact_sha`, because the promotion
 * replaces the host that turn runs on, so the deploy settling is what it is
 * waiting for. Only a deployment recorded against THIS seat's conversation is
 * here: the operator's deploys and another seat's wake nobody. A ledger that
 * cannot be read for one deployment leaves it out of this check only; the
 * next check asks again, and nothing is announced that was not seen.
 */
function recordedSeatDeploys(
  seat: SeatTickSeatInput | null,
  announced: readonly string[],
  context: { now: number; backlogAfterMs: number; catchUp?: boolean },
  sources: SeatTickSources,
): SeatTickDeployInput[] {
  if (!seat || !sources.seatDeployments || !sources.deployment) return [];
  const settled: SeatTickDeployInput[] = [];
  let records: readonly SeatDeploymentRecord[];
  try {
    records = sources.seatDeployments(seat.conversationId);
  } catch {
    return [];
  }
  for (const record of records) {
    if (announced.includes(record.deploymentId)) continue;
    /* A deployment settles after it is requested, so one requested past the
       backlog bound has settled past it too, and the decision would drop it.
       Skipping it before the ledger read keeps a deploy that settled while
       ticking was off from costing a read on every check until the record
       ages out. */
    const requestedAt = Date.parse(record.requestedAt);
    if (!Number.isFinite(requestedAt) || context.now - requestedAt >= context.backlogAfterMs) continue;
    const read = sources.deployment(record.deploymentId);
    const status = read.state === "ok" ? read.value : undefined;
    if (!status || !status.terminal) continue;
    settled.push({
      deploymentId: record.deploymentId,
      phase: status.phase,
      sha: status.revision,
      error: status.error ? redactBounded(status.error, OWN_LANE_DETAIL_LIMIT) : null,
      settledAt: status.updatedAt ?? null,
    });
  }
  return context.catchUp ? settled : settled.slice(-SEAT_DEPLOY_LIMIT);
}

async function settledSeatDeploys(
  seat: SeatTickSeatInput | null,
  announced: readonly string[],
  context: { now: number; backlogAfterMs: number; catchUp?: boolean },
  sources: SeatTickSources,
): Promise<SeatTickDeployInput[]> {
  const settled = recordedSeatDeploys(seat, announced, context, sources);
  // A pending request's remote lookup can outlast this project's deadline.
  // Deliver recorded settlements first on every gather, including the opening
  // priority hint. Unresolved attribution stays durable for a later check.
  if (settled.length || !seat || !sources.seatDeployments || !sources.deployment || !sources.deploymentByKey) return settled;
  try { await recoverSeatDeploymentRequests(seat.conversationId, sources.deploymentByKey); }
  catch { return []; }
  return recordedSeatDeploys(seat, announced, context, sources);
}

/**
 * Who paused a lane, read off the detail the pause wrote (#2063).
 *
 * The pause records its actor as `paused by operator` or `paused by <role>
 * <conversation>`; see `pauseResumeDetail`. The role an MCP caller is given
 * varies, so the conversation is what makes it this seat's.
 */
function pausedBy(pipeline: Pipeline, seat: SeatTickSeatInput | null): SeatTickPipelineInput["pausedBy"] {
  if (pipeline.state !== "paused") return undefined;
  const author = pipeline.pause?.actor;
  if (author?.kind === "operator") return "operator";
  if (author?.kind === "agent") return seat && author.conversationId === seat.conversationId ? "seat" : "other";
  const detail = pipeline.stateDetail?.trim() ?? "";
  if (detail === "paused by operator") return "operator";
  const actor = /^paused by \S+ (\S+)$/.exec(detail)?.[1];
  return seat && actor === seat.conversationId ? "seat" : "other";
}

/** Only cached quota rows are read, once per engine with a paused condition. */
function pauseInputs(pipelines: readonly Pipeline[], seat: SeatTickSeatInput | null, sources: SeatTickSources, now: number) {
  return withViewerOperation("seat-tick.pause-conditions", () => {
    const observations = new Map<string, readonly DurableQuotaObservation[]>();
    return new Map(pipelines.filter(pipeline => pipeline.state === "paused").map(pipeline => {
      const by = pausedBy(pipeline, seat);
      const condition = pipeline.pause?.resumeCondition;
      let pauseConditionMet = false;
      if (by !== "operator" && condition?.kind === "account-usage") {
        if (!observations.has(condition.engine)) {
          try { observations.set(condition.engine, sources.registry().quotaObservations(condition.engine)); }
          catch { observations.set(condition.engine, []); }
        }
        const observation = observations.get(condition.engine)?.find(row => row.engine === condition.engine && row.accountId === condition.accountId);
        const window = observation?.limits?.[condition.window];
        pauseConditionMet = liveFreshObservation(observation, now) && !!window
          && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent < condition.belowPercent;
      }
      return [pipeline.id, { pausedBy: by, pausedAt: pipeline.pausedAt ?? pipeline.createdAt,
        pauseGeneration: pipeline.controlGeneration, pause: pipeline.pause, pauseConditionMet }] as const;
    }));
  });
}

function taskSummary(task: BoardTask & { pipelineIds: string[] }): TaskSummary {
  return {
    id: task.id,
    project: task.project,
    status: task.status,
    text: task.text,
    updatedAt: task.updatedAt,
    assignments: task.assignments?.map((assignment) => ({ state: assignment.state, path: assignment.path, conversationId: assignment.conversationId ?? null })) ?? [],
    pipelineIds: task.pipelineIds,
  };
}

function openTickLanes(pipelines: readonly Pipeline[], project: string, canonical: (project: string) => string) {
  const tasks = new Set<string>();
  const lanes: Pipeline[] = [];
  for (const pipeline of pipelines) {
    if (pipeline.closedAt || pipeline.state === "completed" || pipeline.state === "closed") continue;
    if (canonical(pipeline.project) !== project) continue;
    for (const id of pipeline.taskIds) tasks.add(id);
    if (isOpen(pipeline)) lanes.push(pipeline);
  }
  return { lanes, tasks };
}

function activityOf(record: AgentLivenessRecord | undefined): SeatTickActivity | null {
  /* The row's own turn state travels with its verdict. Reading the verdict
     without it is how a settled turn that had simply gone quiet was reported as
     the seat's stall (#1262): the threshold measures silence, not an open
     turn. */
  if (!record) return null;
  return {
    verified: record.verified,
    conversationId: record.conversationId,
    lastRecordAt: record.lastRecordAt,
    activity: record.activity,
    lifecycle: record.lifecycle,
    reason: record.reason,
    turnState: record.turnState,
    ...(record.permission ? { permission: { tool: record.permission.tool, command: record.permission.command, reason: record.permission.reason } } : {}),
  };
}

/**
 * The liveness rows for a project, indexed by the pipeline each one is running.
 *
 * A liveness read that cannot answer answers with nothing. It never says
 * "dead", and a lane with no row is a lane the tick has no stall evidence
 * about — which the decision reads as "still in flight", never as "stuck".
 */
async function laneActivity(
  project: string, policy: SeatTickPolicy, sources: SeatTickSources,
  stages: ReadonlyMap<string, { stageId: string | null; number: number | null; conversationId: string | null }>,
): Promise<Map<string, SeatTickActivity>> {
  const byPipeline = new Map<string, SeatTickActivity>();
  let rows: AgentLivenessRecord[];
  try {
    await yieldToRuntime();
    rows = await sources.liveness({ project, stallAfterMs: policy.stallAfterMs, limit: LIVENESS_LIMIT });
    await yieldToRuntime();
  } catch {
    return byPipeline;
  }
  for (const row of rows) {
    const reference = row.pipeline;
    if (!reference || byPipeline.has(reference.pipelineId)) continue;
    const stage = stages.get(reference.pipelineId);
    if (!stage || reference.stageId !== stage.stageId || reference.attempt !== stage.number
      || row.conversationId !== stage.conversationId) continue;
    const pipelineId = reference.pipelineId;
    const activity = activityOf(row);
    if (activity) byPipeline.set(pipelineId, activity);
  }
  return byPipeline;
}

/**
 * The seat, with the registry's verdict on the turn it is holding.
 *
 * The verdict is only asked for when the registry says the turn is open, which
 * is the only case anything reads it: a settled turn is never skipped and never
 * signalled. Targeted by conversation id, the way `get_orchestrator` asks it —
 * the targeted branch resolves one transcript and never sweeps the catalog.
 */
/** The seat as the tick reads it: exported for the deputy command, which asks
    the same "is the seat's turn progressing" question (docs/design/ghost-seat.md §5). */
export async function seatInput(project: string, policy: SeatTickPolicy, sources: SeatTickSources): Promise<SeatTickSeatInput | null> {
  const seat = sources.seatFor(project).active;
  if (!seat?.conversationId) return null;
  const conversation = sources.registry().seatTickConversation(seat.conversationId);
  const turn = conversation?.turn.state ?? "unknown";
  let activity: SeatTickActivity | null = null;
  if (turn === "busy") {
    try {
      await yieldToRuntime();
      const rows = await sources.liveness({ reconcileStructuredIdle: true, conversationId: seat.conversationId, stallAfterMs: policy.stallAfterMs, limit: 1 });
      await yieldToRuntime();
      activity = activityOf(rows[0]);
    } catch {
      /* An unanswerable liveness read says nothing. The decision treats an
         absent verdict as "not provably progressing", so the tick keeps working
         rather than waiting behind a turn it cannot see. */
      activity = null;
    }
  }
  return {
    conversationId: seat.conversationId,
    seatEpoch: seat.seatEpoch,
    path: seat.path,
    /* The instant this epoch was designated (#1749), which is the clock a
       child's terminal instant is stale against. It comes off the seat row the
       rotation wrote, so it is the successor's own designation rather than the
       predecessor's — the difference the whole staleness rule rests on. */
    designatedAt: typeof seat.designatedAt === "string" ? seat.designatedAt : null,
    turn,
    activity,
    mandateCarriesTickContract: orchestratorMandateCarriesTickContract(seat),
  };
}

/** One sweep as the retirement journal keeps it: retirements whole, refusals
    as a count per clause, and `no-active-flags` refusals as a count per flag
    (#2137; empty for a sweep journaled before that count existed). */
export interface RetirementJournalSweep {
  finishedAt: string;
  retired: number;
  refusedByClause: Record<string, number>;
  refusedByFlag: Record<string, number>;
}

/** The sweeps inside a window, oldest first. `covered` says the journal
    reaches back past the window's start: a journal younger than the window
    cannot say that nothing retired across it. */
export interface RetirementJournalWindow {
  covered: boolean;
  sweeps: RetirementJournalSweep[];
}

/** The window a sweep that retires nothing is judged over. Four times the
    default six-hour idle bound, so an idle host has had every chance to go. */
export const RETIREMENT_STALL_WINDOW_MS = 24 * 3_600_000;
/** Refusals on one clause across the window that make a window without a
    retirement a stall rather than a quiet machine. */
export const RETIREMENT_STALL_REFUSALS = 1000;
/** These clauses read a live condition of the seat, turn, question, host or
    session, and a refusal on them holds for as long as that condition does.
    Every other clause reads durable bookkeeping (receipts, queues, cursors,
    transcripts, flags, identities) that only a defect leaves unsettled on an
    idle host, so a new clause counts toward the stall until it is listed here.
    `no-open-operation` is one of those: the production registry held 64 spawn
    receipts that had sat in a non-terminal state since July, and the journal
    counted about 3000 refusals on that clause in a day. The sweep now treats a
    receipt unsettled for over a day as abandoned
    (`RETIREMENT_ABANDONED_RECEIPT_MS`); other durable blockers, including a
    missing stamped receipt, can still appear under `no-open-operation`. */
const RETIREMENT_STALL_EXPECTED_CLAUSES = new Set([
  "seat-free",
  "turn-settled",
  "attention-settled",
  "host-idle-or-dead",
  "no-realtime-binding",
  "transcript-idle",
]);
/** Enough of the journal's tail to hold a day of sweeps several times over. */
const RETIREMENT_JOURNAL_TAIL_BYTES = 1024 * 1024;

/**
 * The clause holding hosts back, when a window of sweeps retired nothing
 * (#1818). A predicate stuck on one clause produces neither a failure nor an
 * undetermined refusal, so the report the other signal reads stays clean while
 * the host population grows; the journal's per-clause counts are where it
 * shows. Clauses that follow a live condition are not counted. Null when the
 * window is not fully observed, when anything retired, or when no clause
 * crossed the threshold.
 *
 * When that clause is `no-active-flags`, `flags` carries the flags it refused
 * on across the window, most frequent first: a flag the classifier does not
 * know refuses every host that carries it, and the name is the whole diagnosis
 * (#2137).
 */
export function stalledRetirementClause(
  window: RetirementJournalWindow,
  threshold: number = RETIREMENT_STALL_REFUSALS,
): { clause: string; refusals: number; sweeps: number; flags: [string, number][] } | null {
  if (!window.covered || window.sweeps.length === 0) return null;
  if (window.sweeps.some((sweep) => sweep.retired > 0)) return null;
  const totals = new Map<string, number>();
  const flagTotals = new Map<string, number>();
  for (const sweep of window.sweeps) {
    for (const [clause, count] of Object.entries(sweep.refusedByClause)) {
      if (!RETIREMENT_STALL_EXPECTED_CLAUSES.has(clause)) totals.set(clause, (totals.get(clause) ?? 0) + count);
    }
    for (const [flag, count] of Object.entries(sweep.refusedByFlag)) flagTotals.set(flag, (flagTotals.get(flag) ?? 0) + count);
  }
  let worst: { clause: string; refusals: number } | null = null;
  for (const [clause, refusals] of totals) if (!worst || refusals > worst.refusals) worst = { clause, refusals };
  if (!worst || worst.refusals <= threshold) return null;
  const flags = worst.clause === "no-active-flags"
    ? [...flagTotals].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    : [];
  return { ...worst, sweeps: window.sweeps.length, flags };
}

/** Flags named in the stall signal; the rest are counted, not listed, so an
    unexpected flood of flag names cannot swamp the tick's agenda. */
const RETIREMENT_STALL_FLAGS_SHOWN = 5;

function stalledRetirementFlags(flags: readonly [string, number][]): string {
  if (flags.length === 0) return "";
  const shown = flags.slice(0, RETIREMENT_STALL_FLAGS_SHOWN).map(([flag, count]) => `${flag} ${count}`).join(", ");
  const more = flags.length > RETIREMENT_STALL_FLAGS_SHOWN ? `, +${flags.length - RETIREMENT_STALL_FLAGS_SHOWN} more` : "";
  return ` (flags: ${shown}${more})`;
}

/** A journal record's `name -> count` map, keeping only finite counts. */
function journalCounts(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (value && typeof value === "object") {
    for (const [name, count] of Object.entries(value)) {
      if (typeof count === "number" && Number.isFinite(count)) counts[name] = count;
    }
  }
  return counts;
}

/** The journal's last `bytes`, as sweeps oldest first, and whether the read
    started mid-file. A line that does not parse is skipped. */
function retirementJournalTail(filename: string, bytes: number): { sweeps: RetirementJournalSweep[]; truncated: boolean } {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filename, "r");
  } catch {
    return { sweeps: [], truncated: false };
  }
  let text: string;
  let truncated: boolean;
  try {
    const size = fs.fstatSync(descriptor).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(descriptor, buffer, 0, buffer.length, start);
    text = buffer.toString("utf8");
    truncated = start > 0;
    if (truncated) text = text.slice(text.indexOf("\n") + 1);
  } catch {
    return { sweeps: [], truncated: false };
  } finally {
    fs.closeSync(descriptor);
  }
  const sweeps: RetirementJournalSweep[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { finishedAt?: unknown; retired?: unknown; refusedByClause?: unknown; refusedByFlag?: unknown };
      if (typeof record.finishedAt !== "string" || !Number.isFinite(Date.parse(record.finishedAt)) || !Array.isArray(record.retired)) continue;
      sweeps.push({
        finishedAt: record.finishedAt,
        retired: record.retired.length,
        refusedByClause: journalCounts(record.refusedByClause),
        refusedByFlag: journalCounts(record.refusedByFlag),
      });
    } catch { /* a torn line */ }
  }
  return { sweeps, truncated };
}

/**
 * The journal's sweeps since `sinceMs`, reading the rotated copy only when the
 * current file starts inside the window. Covered once a sweep older than the
 * window is seen; a tail that ends inside the window, or a journal that begins
 * inside it, is not.
 */
export function readRetirementJournalWindow(filename: string, sinceMs: number): RetirementJournalWindow {
  const sweeps: RetirementJournalSweep[] = [];
  for (const file of [filename, `${filename}.1`]) {
    const tail = retirementJournalTail(file, RETIREMENT_JOURNAL_TAIL_BYTES);
    const within = tail.sweeps.filter((sweep) => Date.parse(sweep.finishedAt) >= sinceMs);
    sweeps.unshift(...within);
    if (within.length < tail.sweeps.length) return { covered: true, sweeps };
    if (tail.truncated) break;
  }
  return { covered: false, sweeps };
}

function signals(project: string, seat: SeatTickSeatInput | null, sources: SeatTickSources): SeatTickSignalInput[] {
  const found: SeatTickSignalInput[] = telegramPostSignals(project, sources.tasks(), loadSeatRounds(project));
  if (viewerOwnProjectKeys().includes(project)) {
    found.push(...selfUpdateSignals(readAuto(statePath("self-update", "auto.json"))));
  }
  /* The LATEST deployment, asked for as such. The ledger's default ordering is
     by entity id — a random UUID — so taking an element out of a one-row "tail"
     reported a rolled-back deploy from earlier in the day while the four newest
     had all succeeded (#1262). A signal that says production rolled back is one
     an orchestrator acts on, so it has to be about the deployment that actually
     happened last. */
  const latest = sources.latestDeployment();
  const last = latest.state === "ok" ? latest.value : null;
  if (last && last.terminal && last.phase !== "succeeded") {
    found.push({ id: "deploy", label: `the last deployment ended ${last.phase}` });
  }
  const report = sources.retirementReport();
  if (report) {
    const registry = sources.registry();
    const canonicalProject = seatProjectResolver();
    // Read only report subjects. Missing ownership cannot disclose a target to
    // this project's seat, even when a launcher points at that seat.
    const subject = (conversationId: string | null) => {
      if (!conversationId) return null;
      const conversation = registry.conversation(conversationId as ViewerConversationId);
      const owner = conversation?.projectOwnership?.project;
      return owner && canonicalProject(owner) === project ? conversation : null;
    };
    const unknown = report.refused.filter(refusal => refusal.undetermined).flatMap(refusal => {
      const conversation = subject(refusal.conversationId);
      if (!conversation) return [];
      const own = Boolean(seat && conversation.launcher?.conversationId === seat.conversationId);
      const title = conversation.generations.at(-1)?.launchProfile.title ?? "agent";
      return [{ own, label: `${redactBounded(title, 60)} (${refusal.conversationId}) ${refusal.clause}: ${redactBounded(refusal.reason, 100)}${own ? " (launched by you)" : ""}` }];
    });
    const failed = report.failed.flatMap(failure => {
      const conversation = subject(failure.conversationId);
      if (!conversation) return [];
      const own = Boolean(seat && conversation.launcher?.conversationId === seat.conversationId);
      const title = conversation.generations.at(-1)?.launchProfile.title ?? "agent";
      return [{ own, label: `${redactBounded(title, 60)} (${failure.conversationId}) failed: ${redactBounded(failure.error, 100)}${own ? " (launched by you)" : ""}` }];
    });
    const subjects = [...failed, ...unknown].sort((a, b) => Number(b.own) - Number(a.own));
    if (subjects.length > 0) {
      const more = subjects.length > 3 ? `; and ${subjects.length - 3} more` : "";
      const names = `: ${subjects.slice(0, 3).map(subject => subject.label).join("; ")}${more}`;
      found.push({ id: "host-retirement", actionable: true, label: redactBounded(`host retirement: ${failed.length} failed, ${unknown.length} undetermined${names}`, 800) });
    }
  }
  const stalled = sources.retirementJournal
    ? stalledRetirementClause(sources.retirementJournal(sources.now() - RETIREMENT_STALL_WINDOW_MS))
    : null;
  if (stalled) {
    found.push({
      id: "host-retirement-stalled",
      actionable: false,
      label: `host retirement: nothing retired in ${stalled.sweeps} sweeps over ${RETIREMENT_STALL_WINDOW_MS / 3_600_000}h while ${stalled.clause} refused ${stalled.refusals} times${stalledRetirementFlags(stalled.flags)}`,
    });
  }
  /* The one signal that is about the seat itself: its own turn has stopped
     progressing. The tick's wake is what brings such a seat back, which is the
     reversal recorded in this PR's ADR — and, because this is a signal, it is
     agenda enough for the hourly interval to carry it. */
  const seatActivity = seat?.activity;
  if (seat && seat.turn === "busy" && seatActivity && seatStalled(seatActivity)) {
    found.push({ id: "seat-host", label: `the seat's own turn is ${seatActivity.lifecycle} in ${project} (${seatActivity.reason})` });
  }
  return found;
}

async function diskPressureSignals(sources: SeatTickSources): Promise<SeatTickSignalInput[]> {
  if (!sources.diskPressure) return [];
  let pressure: DiskPressure;
  try {
    pressure = await sources.diskPressure();
  } catch {
    /* A failed volume read wakes nobody; the System panel still shows the last one. */
    return [];
  }
  /* One item per episode: it waits for the consumer sizes, so the one the
     orchestrator gets names them. */
  return pressure.episode && diskPressureWakeReady(pressure) ? [{ id: "disk-space", episode: pressure.episode, label: diskPressureLabel(pressure) }] : [];
}

export function selfUpdateSignals(auto: Pick<AutoState, "off" | "noticeAt" | "waitingSince" | "waitingTarget" | "lastBlockers" | "pending"> & Pick<Partial<AutoState>, "drain">): SeatTickSignalInput[] {
  if (auto.off) return [{ id: "self-update-off", label: `self-update: automatic updates turned off — ${auto.off.reason}` }];
  if (auto.drain?.overranAt) {
    const blockers = auto.drain.blockers;
    const names = [...(blockers?.stageList ?? []).map((stage) => `${stage.stageId} · ${stage.task}`),
      ...(blockers?.turnList ?? []).map((turn) => turn.seat ? turn.project ?? turn.conversationId : `${turn.engine} · ${turn.conversationId}`)].join(", ");
    if (auto.drain.acknowledgedAt) return [];
    return [{ id: "self-update-drain-overran", label: `self-update: admission remains held after 6 h; still blocked by ${names || "unreadable activity"}; the operator can deploy now or keep waiting in Needs-you` }];
  }
  return [];
}

/**
 * Whether the seat's own turn has stopped, in the sense the signal claims.
 *
 * `gone` is the host: it is dead whatever the turn was doing, and resuming it
 * is what the wake is for. `stalled` is the one that needed narrowing. It has
 * two roots — a dead host or an expired launch under an OPEN turn, and a
 * transcript silent past the threshold — and the second fires on silence alone,
 * so a seat that finished its turn cleanly and sat quiet for forty minutes was
 * reported stalled to itself (#1262). The transcript's own turn state, which is
 * what the verdict was computed from, is what tells the two apart; the
 * registry's turn record is a different fact and is stale in exactly this case.
 */
function seatStalled(activity: SeatTickActivity): boolean {
  if (activity.lifecycle === "gone") return true;
  return activity.lifecycle === "stalled" && activity.turnState === "busy";
}

/** The repository a project's `gh` reads run in: the newest pipeline that named
    one. Null when nothing ever did, and the proposal then ranks the board alone. */
export function repoDirForProject(
  project: string,
  sources: SeatTickSources,
  /** Lanes the caller has already read out of cold storage. A project whose
      every lane has been archived still has a repository, and asking `gh`
      nothing because the hot store happens to be empty is the same silence
      read off a different shelf (#1289). Never read here on its own: the
      caller pays for the archive when it has already decided to. */
  archived: readonly Pipeline[] = [],
): string | null {
  const canonicalProject = seatProjectResolver();
  const canonical = canonicalProject(project);
  const named = [...sources.pipelines(), ...archived]
    .filter((pipeline) => pipeline.repoDir && canonicalProject(pipeline.project) === canonical)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return named[0]?.repoDir ?? null;
}

/**
 * A digest of everything a wake could change. Two equal fingerprints across two
 * wakes is exactly what "that wake changed nothing" means.
 *
 * Every field a wake reason is decided from has to be in here, because this
 * digest is also what identifies a retry-guard entry: a guard keyed on less
 * than the condition it guards outlives that condition. A card's `updatedAt` is
 * the case #1262 produced — it decides whether the card is an unstarted task or
 * backlog, so moving a stale card is precisely the act that should bring the
 * reason back, and while it was missing from here the guard held the reason
 * suppressed with the card's movement invisible to it.
 */
function changeFingerprint(
  pipelines: readonly SeatTickPipelineInput[],
  tasks: readonly SeatTickTaskInput[],
  children: readonly SeatTickChildInput[],
  pullRequests: readonly SeatTickPullRequestInput[],
  pullRequestsUnavailable: SeatTickPullRequestGap | null,
  ownLanes: readonly SeatTickOwnLaneInput[],
  settledDeploys: readonly SeatTickDeployInput[] = [],
  settledMaintenance: readonly MaintenanceRun[] = [],
  purpose: "guard" | "digest" = "guard",
  pullRequestsObserved = true,
): string {
  /* A child's status and outcome instant decide two wake reasons (#1465), so
     they are in the half the guard reads: a child finishing, or a harvested one
     leaving the projection, is the movement that resets the guard. A source
     that could not be read contributes nothing here — the children list is
     empty then, and the gap beside it keeps the check from concluding quiet. */
  const board = [
    ...pipelines.map((pipeline) => `p:${pipeline.id}:${pipeline.state}:${pipeline.updatedAt ?? ""}:${JSON.stringify([pipeline.pausedBy, pipeline.pausedAt, pipeline.pauseGeneration, pipeline.pause, pipeline.pauseConditionMet])}${purpose === "digest" ? `:${JSON.stringify([pipeline.stageId, pipeline.stageState, pipeline.stageAttempt, pipeline.stageAttemptState])}` : ""}`),
    // Notes, details and report bookkeeping bump task timestamps. The guard
    // needs those instants for backlog eligibility; a digest needs state changes.
    ...tasks.map((task) => `t:${task.id}:${task.status}:${task.owned}:${purpose === "guard" ? task.updatedAt ?? "" : ""}:${JSON.stringify([task.accepted, task.hold, purpose === "guard" ? task.waitingSince : null])}`),
    ...children.map((child) => `c:${child.conversationId}:${child.outcomeId ?? ""}:${child.status}:${child.terminalAt ?? ""}`),
    /* The seat's own settled lanes decide a wake reason of their own (#1749),
       so the guard has to see them move: closing the lane out is the discharge,
       and a guard blind to it would suppress the reason while a second lane
       settled behind the first. */
    ...ownLanes.map((lane) => `o:${lane.id}:${lane.settled}:${lane.updatedAt ?? ""}`),
    /* A settled deploy decides a wake reason of its own (#2063), and a second
       deploy settling behind the first is movement the guard has to see. */
    ...settledDeploys.map((deploy) => `d:${deploy.deploymentId}:${deploy.phase}`),
    ...settledMaintenance.map(run => `m:${run.runId}:${run.state}`),
  ].sort();
  /* The set of unmerged pull requests, for the same reason the card's movement
     instant is in the half above: it decides a wake reason, so a guard keyed on
     less than it would hold the reason suppressed while a SECOND pull request
     went unmerged behind the first. A merge or a close removes the row, which is
     what lets the guard reset the moment the seat acts.

     Its own half, because a read that FAILED contributes the same nothing a
     merge does and the guard must not read one as the other (#1298). An
     unreadable source says `unread` here and the guard declines to conclude
     anything from this half at all. */
  const open = pullRequests.map((pullRequest) => `pr:${pullRequest.number}:${pullRequest.pipelineId}`).sort();
  return `${purpose === "digest" ? "digest-v1:" : ""}${digest(board)}.${pullRequestsUnavailable || (purpose === "digest" && !pullRequestsObserved) ? FINGERPRINT_UNREAD : digest(open)}`;
}

function seatTickFingerprint(
  pipelines: readonly SeatTickPipelineInput[], tasks: readonly SeatTickTaskInput[], children: readonly SeatTickChildInput[],
  pullRequests: readonly SeatTickPullRequestInput[], pullRequestsUnavailable: SeatTickPullRequestGap | null,
  ownLanes: readonly SeatTickOwnLaneInput[], settledDeploys: readonly SeatTickDeployInput[],
  settledMaintenance: readonly MaintenanceRun[],
): string {
  const rows = pipelines.length + tasks.length + children.length + pullRequests.length + ownLanes.length
    + settledDeploys.length + settledMaintenance.length;
  return performanceSpans.sync("seat-tick.project", () => changeFingerprint(pipelines, tasks, children,
    pullRequests, pullRequestsUnavailable, ownLanes, settledDeploys, settledMaintenance), rows);
}

function digest(parts: readonly string[]): string {
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

/** Projects worth checking: everyone with a seat, plus everyone with work and
    nobody to do it. A project with neither is not a project the tick has an
    opinion about. */
export function seatTickProjects(sources: SeatTickSources): string[] {
  const canonicalProject = seatProjectResolver();
  const projects = new Set(sources.activeSeats().map(canonicalOrchestratorProject));
  for (const pipeline of sources.pipelines()) {
    if (isOpen(pipeline) && pipeline.project) projects.add(canonicalProject(pipeline.project));
  }
  const tasks = sources.tasks();
  const linked = tasks.some((task) => task.machine) ? linkedContext() : null;
  for (const task of tasks) {
    if (linked && !runsHere(task, linked)) continue;
    if ((task.status === "inbox" || task.status === "assigned") && task.project) projects.add(canonicalProject(task.project));
  }
  return [...projects].sort();
}

/**
 * Everything past the seat's own event cursor.
 *
 * The lifecycle digest's per-subscriber cursor is not used here, and the reason
 * is the one rule this whole file is arranged around: that cursor advances when
 * the relay is READ, and an acknowledged event is never offered again. A wake
 * that is then refused at the seat epoch, held by a migration, or queued behind
 * a host that never takes it would leave the seat permanently unaware of the
 * lane event that produced it. So the tick keeps its own cursor in its own row
 * and moves it only when a wake actually landed — and, exactly as the digest
 * does, it asks about a pending terminal event over the whole range rather than
 * one page of it.
 */
function eventsSince(
  project: string,
  cursor: number | null,
  openPipelineIds: ReadonlySet<string>,
  pipelines: readonly Pipeline[],
  sources: SeatTickSources,
  catchUp = false,
): { events: SeatTickEventInput[]; cursor: number } {
  const canonicalProject = seatProjectResolver();
  const journal = sources.lifecycleJournal();
  /* `lastSeq` is the head the journal maintains; the newest event's seq is the
     same number written a second way, and taking the larger keeps a head that
     somehow lagged its own events from replaying them as new. */
  const head = Math.max(journal.lastSeq, journal.events.at(-1)?.seq ?? 0);
  /* The first check for a project SEALS the cursor at the head instead of
     reading from zero. A first run has no backlog to catch up on: everything
     already in the journal happened before the tick existed for this seat, and
     handing it over as the seat's instruction for the turn is what #1262
     records — four-day-old merges listed as work, with ninety-three more items
     held back. The seal is written once and only once; from then on the cursor
     is the seat's, and it moves only when a wake lands. */
  if (cursor === null) return { events: [], cursor: head };
  const page = pageFromEvents(journal, { project, afterSeq: cursor, limit: EVENT_PAGE });
  const merged = new Map(pipelines.filter(lane => lane.merge?.state === "merged").map(lane => [lane.id, lane]));
  return {
    events: (catchUp ? journal.events.filter(event => event.seq > cursor && event.project !== null && canonicalProject(event.project) === project) : page.events).map((event) => {
      const lane = event.pipelineId ? merged.get(event.pipelineId) : undefined;
      return {
        seq: event.seq,
        at: event.at,
        type: event.type,
        // Enrich older journal summaries from the durable lane while it is hot.
        summary: event.type === "pipeline_merged" && lane
          ? `pull request #${lane.merge!.prNumber} merged, head ${shortId(lane.merge!.mergedHead ?? "unavailable")} — ${redactBounded(lane.task.split("\n")[0] ?? "", OWN_LANE_TITLE_LIMIT)}`
          : event.summary,
        pipelineId: event.pipelineId,
        /* An open lane is always in the hot store; the archive only ever takes
           SETTLED records. So a pipeline id the store no longer lists names a
           lane that ended long enough ago to have been archived, and reading it
           as terminal is the same answer arrived at from the other side. An event
           that names no pipeline is never terminal here — nothing about a deploy
           outcome or a held delivery has finished (#1285). */
        pipelineTerminal: event.pipelineId !== null && !openPipelineIds.has(event.pipelineId),
      };
    }),
    cursor,
  };
}

/**
 * Pull requests the project's finished lanes left open (#1289).
 *
 * The correlation is the lane's own branch against the pull request's head
 * ref — durable on both sides, and the only tie that survives the lane being
 * closed, its worktree being removed and its host being reaped.
 *
 * The bounds keep it cheap and keep it from becoming a route around the hourly
 * wake. It is read only when a wake could actually be raised from it — the tick
 * is on for this project, the interval has elapsed, there is a seat to wake and
 * its turn is not already moving — only when the project has a finished lane to
 * attribute one to, and only when some pipeline named a repository to ask in.
 * Each of those is an answer: this check would raise no wake from this reason
 * whatever GitHub said. A read that FAILED is not an answer, and leaves with
 * {@link SeatTickPullRequestGap} rather than an empty list.
 *
 * One more bound joined them (#1298): a source that has been failing for longer
 * than a whole wake interval is asked once per interval rather than once per
 * check. That one saves a subprocess and nothing else — the failure it already
 * established is replayed on every check in between, so no check between two
 * attempts is entitled to a conclusion the attempt would have denied it. The
 * bound covers BOTH reads below, because either of them can be the one that is
 * permanently broken; where each is gated is decided in the body, by what a
 * fresh read of that source on that check would have produced.
 *
 * The lanes come from the hot store AND the archive, because the obligation is
 * the pull request still being open and that outlives the lane's three days of
 * residence. Reading only the hot store made the reason decay on a timer: a
 * tick switched off, a seat busy for days, or a `gh` unreachable until the lane
 * settled out all arrive at the first eligible check with nothing to attribute
 * a pull request to, and report quiet over one still sitting open — the same
 * twelve-hour silence #1289 exists to end, taken slowly. The retry guard does
 * not cover the gap either: it counts wakes that changed nothing, and a wake
 * that was never sent has nothing to count. The archive is cold storage, so it
 * is read only after every cheap gate above has passed, at which point the
 * check has already committed to a `gh` subprocess and a snapshot read is the
 * cheaper half of the pair.
 */
interface PullRequestEvidence {
  pullRequests: SeatTickPullRequestInput[];
  localPending: SeatTickSignalInput[];
  observed: boolean;
  /** Null means the question was answered — including answered with nothing
      open, which is what the tick is entitled to go quiet on. */
  unavailable: SeatTickPullRequestGap | null;
  /** The source's run of failures as this check leaves it (#1298). Carried on
      the row so the next check knows whether this is weather or configuration,
      and so a standing outage is reported once rather than every five minutes. */
  gap: SeatTickSourceGap | null;
  localScanCursor?: string | null;
}

const execFileAsync = promisify(execFile);

/** A local lane tip outside its recorded local base is actionable without any
 * forge account, remote, or `gh` response. The lane row and its accepted SHA
 * identify the exact work; the signal version includes that SHA so a later
 * accepted revision is a new item. */
async function localFinishedLaneSignals(project: string, pipelines: readonly Pipeline[], cursor: string | null): Promise<{ signals: SeatTickSignalInput[]; cursor: string | null }> {
  const canonicalProject = seatProjectResolver();
  const finished = [...new Map(pipelines
    .filter((pipeline) => canonicalProject(pipeline.project) === project && !pipeline.hiddenAt && isFinished(pipeline)
      && !(pipeline.merge && (PIPELINE_MERGE_LIVE_STATES.has(pipeline.merge.state) || pipeline.merge.state === "refreshing")))
    .map((pipeline) => [pipeline.id, pipeline] as const)).values()]
    .sort((left, right) => {
      const stamp = (pipeline: Pipeline) => {
        const value = Date.parse(pipeline.closedAt ?? pipeline.createdAt);
        return Number.isFinite(value) ? value : 0;
      };
      return stamp(right) - stamp(left) || left.id.localeCompare(right.id);
    });
  if (finished.length === 0) return { signals: [], cursor };
  const afterPrevious = cursor ? finished.findIndex((pipeline) => pipeline.id === cursor) + 1 : 0;
  const start = afterPrevious > 0 ? afterPrevious % finished.length : 0;
  const scanCount = Math.min(finished.length, LOCAL_FINISHED_LANE_LIMIT);
  const candidates = Array.from({ length: scanCount }, (_, index) => finished[(start + index) % finished.length]!);
  let lastScanned: string | undefined;
  const found: SeatTickSignalInput[] = [];
  let localProbeFailures = 0;
  let firstLocalProbeFailure: string | null = null;
  const noteLocalProbeFailure = (detail: string) => {
    localProbeFailures++;
    firstLocalProbeFailure ??= detail;
  };
  {
    const remaining = LOCAL_GIT_TIMEOUT_MS;
    const batch = candidates.slice(0, LOCAL_GIT_BATCH_SIZE);
    const outcomes = await Promise.all(batch.map(async (pipeline) => {
      const sha = pipeline.lastPassedCommit;
      const base = pipeline.baseBranch;
      if (!pipeline.repoDir || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)
        || !base || !/^[A-Za-z0-9._/-]+$/.test(base) || base.includes("..") || base.startsWith("/")) return null;
      if (pipeline.merge?.state === "merged"
        && (pipeline.merge.reviewedHead === sha || pipeline.merge.chain.includes(sha) || pipeline.merge.mergedHead === sha)) return null;
      const refs = [`refs/remotes/origin/${base}`, `refs/heads/${base}`];
      for (const ref of refs) {
        try {
          await execFileAsync("git", ["merge-base", "--is-ancestor", `${sha}^{commit}`, `${ref}^{commit}`], {
            cwd: pipeline.repoDir, timeout: remaining, encoding: "utf8", maxBuffer: 16 * 1024,
          });
          return null;
        } catch (error) {
          const code = String((error as NodeJS.ErrnoException).code);
          if (code === "1") return { pipeline, sha };
          if (code !== "128") {
            noteLocalProbeFailure(`${pipeline.id}: ${code}`);
            return null;
          }
        }
      }
      noteLocalProbeFailure(`${pipeline.id}: ${base}`);
      return null;
    }));
    lastScanned = batch.at(-1)!.id;
    for (const outcome of outcomes) {
      if (!outcome) continue;
      const { pipeline, sha } = outcome;
      found.push({
        id: `local-unmerged-lane:${pipeline.id}`,
        actionable: true,
        episode: `${pipeline.baseBranch}:${sha}`,
        label: redactBounded(`finished lane ${pipeline.id} has local commits not merged into ${pipeline.baseBranch}; last passed commit ${sha.slice(0, 12)}`, 800),
      });
    }
  }
  if (lastScanned) cursor = lastScanned;
  if (localProbeFailures) {
    console.error(`[seat tick] local Git ancestry unavailable for ${localProbeFailures} finished lanes; first ${firstLocalProbeFailure}`);
  }
  return { signals: found, cursor };
}

async function readPullRequestsWithinBudget(
  source: () => Promise<OpenPullRequestsResult>,
): Promise<OpenPullRequestsResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      source(),
      new Promise<OpenPullRequestsResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, unavailable: "timed-out" }), PULL_REQUEST_ENRICHMENT_BUDGET_MS);
      }),
    ]);
  } catch {
    return { ok: false, unavailable: "command-failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function unmergedPullRequests(context: {
  project: string;
  seat: SeatTickSeatInput | null;
  wakeDue: boolean;
  enabled: boolean;
  now: number;
  wakeIntervalMs: number;
  /** What the previous checks made of this source. */
  gap: SeatTickSourceGap | null;
  localScanCursor: string | null;
  sources: SeatTickSources;
}): Promise<PullRequestEvidence> {
  let canonicalProject = seatProjectResolver();
  /* Nothing was asked, so nothing is concluded — and the run of failures is
     left exactly as it stands. A gate is a statement about this check, never
     about whether the source can be read. */
  const unasked: PullRequestEvidence = { pullRequests: [], localPending: [], observed: false, unavailable: null, gap: context.gap, localScanCursor: context.localScanCursor ?? null };
  if (!context.wakeDue || !context.enabled) return unasked;
  /* The other two ways a check can be unable to raise any reason at all: a
     project with nobody to wake ends in `no-seat`, and a seat whose turn is
     genuinely moving ends in `skipped`, both before a wake reason is composed.
     Without this clause a seat that stays busy for hours pays a `gh` subprocess
     every five minutes for the whole turn, to answer a question that check was
     never going to ask. */
  if (!context.seat || seatTurnProgressing(context.seat)) return unasked;

  const at = new Date(context.now).toISOString();
  let localScanCursor = context.localScanCursor ?? null;
  const failed = (kind: SeatTickPullRequestGap, localPending: SeatTickSignalInput[] = []): PullRequestEvidence => ({
    pullRequests: [],
    localPending,
    observed: false,
    unavailable: kind,
    gap: seatTickSourceGapAfterFailure(context.gap, kind, at),
    localScanCursor,
  });

  /* The archive is an evidence source too, and a permanent failure of it has to
     be bounded by the same backoff (#1298). A lane store that can never be read
     — the snapshot is corrupt, its directory is gone — failed on every check
     five minutes apart for as long as no delivered wake moved the hourly stamp,
     which is exactly the unbounded retry the backoff below exists to stop.
     Standing failures of this class are asked at the wake interval, and the
     fresh failures inside the first interval still retry at every check.

     Its gate is HERE rather than beside the one below, and the difference is
     what a fresh read would have produced. The gates in between say this check
     had nothing to ask — no finished lane, no repository — and are themselves
     read out of the archive, so a check that cannot enumerate the lanes cannot
     reach any of them: a fresh read fails on this very line and reports the gap
     unconditionally. Replaying it above them is therefore the same verdict, not
     a gap outliving its question. */
  const standing = context.gap;
  if (standing?.gap === "lanes-unreadable" && !seatTickSourceRetryDue(standing, context.now, context.wakeIntervalMs)) {
    return { pullRequests: [], localPending: [], observed: false, unavailable: standing.gap as SeatTickPullRequestGap, gap: standing };
  }

  let archived: readonly Pipeline[];
  try {
    archived = await (context.sources.archivedPipelinesAsync ?? context.sources.archivedPipelines)();
  } catch {
    /* Lanes half-read are obligations half-seen, and an obligation that cannot
       be seen is exactly what gets reported as quiet. */
    return failed("lanes-unreadable");
  }
  canonicalProject = seatProjectResolver();
  const projectLanes = [...context.sources.pipelines(), ...archived]
    .filter((pipeline) => canonicalProject(pipeline.project) === context.project && !pipeline.hiddenAt);
  const finished = projectLanes.filter(isFinished);
  if (finished.length === 0) return unasked;
  const localScan = await localFinishedLaneSignals(context.project, projectLanes, localScanCursor);
  const localPending = localScan.signals;
  localScanCursor = localScan.cursor;
  const cwd = repoDirForProject(context.project, context.sources, archived);
  if (!cwd) return { ...unasked, localPending, localScanCursor };

  /* The same bound for the `gh` read: a source that has been unreadable for
     longer than a whole wake interval is asked at that interval and no faster
     (#1298). The gap it already produced is replayed in between, so every check
     still refuses to call this quiet — what the backoff saves is the `gh`
     subprocess, never a conclusion.

     It sits BELOW the two gates above, because a replayed gap must not outlive
     the question it answers. Each of those gates is this check finding there is
     nothing to ask: no finished lane left anything open, or the project has no
     repository to ask about. A fresh read on such a check reports no gap at all,
     so replaying one above them would name an unreadable source for the rest of
     the backoff window on a check that would have succeeded trivially, and would
     refuse a quiet the evidence allows. Everything between the gates and here is
     a local read; the subprocess below is the only thing THIS gate saves. */
  if (context.gap && !seatTickSourceRetryDue(context.gap, context.now, context.wakeIntervalMs)) {
    return { pullRequests: [], localPending, observed: false, unavailable: context.gap.gap as SeatTickPullRequestGap, gap: context.gap, localScanCursor };
  }

  let result: OpenPullRequestsResult;
  try {
    /* The seam answers with a result; a seam that throws instead is the same
       fact arriving by exception, and neither is an empty list. */
    result = await readPullRequestsWithinBudget(() => context.sources.openPullRequests({ cwd, limit: PULL_REQUEST_LIMIT }));
  } catch {
    result = { ok: false, unavailable: "command-failed" };
  }
  if (!result.ok) return failed(result.unavailable, localPending);
  const open = result.pullRequests;
  canonicalProject = seatProjectResolver();
  const byBranch = new Map<string, Pipeline[]>();
  for (const pipeline of projectLanes) {
    const delivery = pipeline.delivery?.target;
    const heads = [pipeline.branch];
    if (delivery?.branch && canonicalProject(delivery.repository) === context.project) {
      heads.push(delivery.branch.replace(/^refs\/heads\//, ""));
    }
    for (const head of heads.filter(Boolean)) {
      const lanes = byBranch.get(head) ?? [];
      if (!lanes.some((lane) => lane.id === pipeline.id)) lanes.push(pipeline);
      byBranch.set(head, lanes);
    }
  }
  for (const lanes of byBranch.values()) lanes.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const found: SeatTickPullRequestInput[] = [];
  for (const pullRequest of open) {
    const lanes = byBranch.get(pullRequest.headRefName) ?? [];
    const named = (lane: Pipeline) => (lane.delivery?.target.pr === pullRequest.number
      && canonicalProject(lane.delivery.target.repository) === context.project)
      || lane.runs.some((run) => run.attempts.some((attempt) => attempt.report?.provenance?.pullRequest?.number === pullRequest.number));
    const openedAt = Date.parse(pullRequest.createdAt);
    /* A later lane reusing this head owns PRs opened after it started, even if
       it is still running. Completion alone does not end ownership: a PR can
       be opened on the unchanged head after the lane automatically closes. */
    const owner = lanes.find((candidate) => {
      const bornAt = Date.parse(candidate.createdAt);
      return Number.isFinite(bornAt) && openedAt >= bornAt;
    });
    const lane = lanes.find(named) ?? owner;
    if (!lane || !isFinished(lane)) continue;
    /* #2187 §4.6: a pull request the merge runner is working on is the
       runner's, not the seat's; one it stopped on comes back with its reason. */
    if (lane.merge && (PIPELINE_MERGE_LIVE_STATES.has(lane.merge.state) || lane.merge.state === "refreshing")) continue;
    found.push({
      number: pullRequest.number,
      title: redactBounded(pullRequest.title, PULL_REQUEST_TITLE_LIMIT),
      pipelineId: lane.id,
      pipelineTitle: redactBounded(lane.task.split("\n")[0] ?? "", PULL_REQUEST_TITLE_LIMIT),
      updatedAt: pullRequest.updatedAt,
      ...(pipelineCompletedUnreviewed(lane) ? { lastFixUnreviewed: true as const } : {}),
      ...(lane.merge?.state === "blocked" && lane.merge.reason ? { mergeBlocked: redactBounded(lane.merge.reason, PULL_REQUEST_TITLE_LIMIT) } : {}),
      ...taskWaitField(lane),
    });
  }
  /* An answer, so the run of failures is over: the source spoke, whatever it
     said. This is the only thing that clears the row, which is what makes the
     next outage a fresh run with its own report. */
  return { pullRequests: found.sort((left, right) => left.number - right.number), localPending, observed: true, unavailable: null, gap: null, localScanCursor };
}


/* Standalone child discovery uses indexed lineage pages. Persistent FIFO
 * tickets poll proven child generations and retain owed outcomes until landing.
 * Running activity and terminal ledger evidence are separate projections. */

const LIVE_CHILD_RECEIPT_STATES: ReadonlySet<SpawnReceipt["state"]> = new Set(["starting", "pane-bound", "host-verified", "prompt-delivered", "path-pending"]);
const LIVE_CHILD_HOST_STATES: ReadonlySet<AgentRegistryEntry["status"]> = new Set(["starting", "live", "idle", "handoff"]);
const CONTAINER_MEMBERSHIPS: ReadonlySet<string> = new Set(["pipeline", "flow", "orchestrator"]);
/** Ledger bytes one check reads across all of a seat's children, and the most
    one child's visit takes of it. Sized to real ledgers (#1465): measured on
    one machine they run to a median of 0.7 MB, a p99 of 13 MB and a maximum of
    80 MB, and grow by some hundreds of megabytes a day across every host. One
    visit reads a p99 ledger whole, so a child's terminal record is reached in
    the check that follows it rather than hours later, and a check every five
    minutes with this budget reads an order of magnitude more than the day's
    growth. The line-framed reader takes tens of milliseconds for the lot. */
export const TICK_LEDGER_BYTES = 32 * 1024 * 1024;
const CHILD_LEDGER_BYTES = 16 * 1024 * 1024;
/** FIFO visits per check, sharing the sixty-row projection budget with
    discovery and ready outcomes. Cold tickets retain reserved visits while
    running transitions and new terminal children receive priority. */
export const POLL_VISITS = 40;
/** Lineage edges one discovery page reads. */
const DISCOVERY_PAGE = 20;

/**
 * The last record of a transcript the Viewer can actually resolve (#1783).
 *
 * Two things at once, because they are one read. The instant is the child's
 * own — a transcript is appended to by the child and by nothing else — where
 * `turn.observedAt` and the conversation's `updatedAt` are the registry's, and
 * a rescan or a host-retirement sweep stamps hundreds of conversations with a
 * single one of those. Reading them as a terminal time is what left the #1749
 * age test excluding nothing. And null is the other half: a path outside every
 * scanner root, or one no longer on disk, is a child the Viewer can never read
 * or harvest, whichever seat is asked to.
 *
 * The roots are passed in, read once per check: enumerating them walks the
 * account homes, and this runs once per projected child.
 *
 * Containment is asked of the path as recorded AND of the file it resolves to
 * (#1881). A transcript recorded through a link into a root — the shared
 * Claude store behind an account's `projects`, a dotfile manager's
 * `~/.claude` — is the same file, and a prefix test on the text alone called
 * it outside every root, so a child that had just finished was never offered.
 * When it cannot be read, the reason travels with it: a count of unreadable
 * children with no reason attached is what left #1881 undiagnosable.
 */
function transcriptRecordAt(transcriptPath: string, roots: SeatTickTranscriptRoots): { record: string; reason: null } | { record: null; reason: SeatTickTranscriptGap } {
  const inside = (candidate: string, list: readonly string[]) => list.some((root) => candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
  let stat: fs.Stats;
  try { stat = fs.statSync(transcriptPath); } catch {
    return { record: null, reason: inside(transcriptPath, roots.recorded) ? "missing" : "outside-roots" };
  }
  if (!stat.isFile()) return { record: null, reason: "missing" };
  if (!inside(transcriptPath, roots.recorded)) {
    let real: string;
    try { real = fs.realpathSync(transcriptPath); } catch { return { record: null, reason: "missing" }; }
    if (!inside(real, roots.resolved)) return { record: null, reason: "outside-roots" };
  }
  return { record: new Date(stat.mtimeMs).toISOString(), reason: null };
}

/** The scanner roots once per check, as listed and as they resolve on disk. */
interface SeatTickTranscriptRoots { recorded: readonly string[]; resolved: readonly string[] }

function transcriptRoots(): SeatTickTranscriptRoots {
  const recorded = scanRootEntries().map(([, root]) => root);
  const resolved = recorded.flatMap((root) => { try { return [fs.realpathSync(root)]; } catch { return []; } });
  return { recorded, resolved };
}

/** The registry entries that could be hosting this child, by every session key
    the records tie to it. */
function childHostEntries(file: RegistryFile, edge: SpawnLineageEdge, receipt: SpawnReceipt | null, transcriptKey: SessionKey | null): AgentRegistryEntry[] {
  const keys = [receipt?.key, edge.childSessionKey, transcriptKey].filter((key): key is SessionKey => Boolean(key));
  return [...new Set(keys.map(sessionKeyId))].flatMap((key) => (file.entries[key] ? [file.entries[key]!] : []));
}

/** Whether anything may still run this child: live entries, retained process
    custody, queued recovery, or a launch still inside its admission lease.
    An expired reservation with no custody is no evidence of a host. */
function childHosted(receipt: SpawnReceipt | null, entries: readonly AgentRegistryEntry[], now: number): boolean {
  // Retained custody is not proof of death. The registry's recovery owns
  // clearing it; the tick does not probe processes or wait for them.
  if (entries.some((entry) => LIVE_CHILD_HOST_STATES.has(entry.status) || entry.host || entry.structuredHost?.process
    || entry.structuredTerminationSurvivors?.length)) return true;
  if (receipt?.admissionOwner || receipt?.queuedPinnedSpawn || receipt?.retryClaim) return true;
  if (!receipt || !LIVE_CHILD_RECEIPT_STATES.has(receipt.state)) return false;
  if (receipt.state !== "starting") return true;
  const createdAt = Date.parse(receipt.createdAt);
  return Number.isFinite(createdAt) && now - createdAt <= SPAWN_STARTING_ADMISSION_LEASE_MS;
}

interface ProjectedChild {
  input: SeatTickChildInput;
  /** The registry's turn record, for deciding whether to ask the liveness plane. */
  turn: "busy" | "idle" | "terminal" | "unknown";
  hosted: boolean;
  createdAt: string;
}

/** One child, classified from the snapshot alone. Null for a child that is
    not this seat's to see. */
function projectChild(
  file: RegistryFile,
  lookup: ReturnType<typeof readOnlyConversationLookupFromSnapshot>,
  edge: SpawnLineageEdge,
  project: string,
  now: number,
  roots: SeatTickTranscriptRoots,
): ProjectedChild | null {
  if (edge.source !== "viewer-spawn") return null;
  const childId = lookup.canonicalConversationId(edge.childConversationId);
  if ((file.memberships[childId] ?? []).some((membership) => CONTAINER_MEMBERSHIPS.has(membership.kind))) return null;
  const receipt = edge.evidence.launchId ? file.receipts[edge.evidence.launchId] ?? null : null;
  const conversation = lookup.conversation(childId);
  const generation = conversation?.generations.at(-1) ?? null;
  const transcriptKey = conversation && generation ? sessionKeyFromTranscript(conversation.engine, generation.path) : null;
  const entries = childHostEntries(file, edge, receipt, transcriptKey);
  const attributed = resolveProjectAttribution({
    projectOwnership: conversation?.projectOwnership ?? null,
    cwd: receipt?.cwd ?? entries[0]?.cwd ?? null,
    launchProfileProject: receipt?.launchProfile.project ?? generation?.launchProfile.project ?? null,
  }).project;
  if (!attributed || canonicalOrchestratorProject(attributed) !== project) return null;

  const title = redactBounded(
    receipt?.launchProfile.title ?? generation?.launchProfile.title ?? edge.role ?? "spawned child",
    CHILD_TITLE_LIMIT,
  );
  const hosted = childHosted(receipt, entries, now);
  const turn = conversation?.turn.state ?? "unknown";
  /* The child's own instants, and the only ones a terminal time may come from
     (#1783): its recorded terminal instant, else the last record of its
     transcript. A transcript the Viewer cannot resolve says so here and is
     never offered as harvestable work. */
  const read = generation ? transcriptRecordAt(generation.path, roots) : { record: null, reason: "no-transcript" as const };
  const record = read.record;
  const settledAt = conversation?.turn.terminalAt ?? record;
  /* `lastRecordAt` rides on EVERY branch below, terminal or not (#1783 round
     two). A child whose host died over an open turn never gets a terminal
     instant at all — the conversation row stays `busy` for ever — so the
     branches that report it running were handing the age test a null, and a
     null excludes nothing. The transcript's own last record is the instant
     that child has. */
  /* One line for the pair the same read produced, and the publication gate is
     why: a line that begins `transcript:` reads as a quoted transcript key. */
  /* The reason rides beside an unreadable transcript and the path beside a
     readable one (#1881): the first is what the wake names, the second is
     where the controller reads the child's final message from once a wake is
     going out. Neither is read here. */
  const base: Omit<SeatTickChildInput, "status" | "outcome" | "terminalAt"> = {
    conversationId: childId,
    title,
    activity: null,
    lastRecordAt: record, transcript: record === null ? "unresolvable" as const : "readable" as const,
    ...(read.reason ? { transcriptReason: read.reason } : generation && conversation ? { transcriptPath: generation.path, engine: conversation.engine } : {}),
    spawnedAt: edge.createdAt,
    ...(conversation?.launcher?.notify && receipt?.transport === "structured"
      && lookup.canonicalConversationId(conversation.launcher.conversationId) === lookup.canonicalConversationId(edge.parentConversationId)
      ? { launcherNotice: true } : {}),
  };
  const createdAt = edge.createdAt;
  if (hosted && turn !== "terminal") return { input: { ...base, status: "running", outcome: null, terminalAt: null }, turn, hosted, createdAt };
  /* A launch that failed or conflicted before it ran: terminal, outcome
     failed. The receipt is the whole record of it. */
  if (receipt && (receipt.rejection || receipt.state === "failed" || receipt.state === "conflicted")) {
    /* A launch that failed before it ran has no transcript and needs none: the
       receipt is the whole record, and its instant is the receipt's own, so
       the transcript test does not apply to it (#1783). */
    const { transcriptReason: _none, ...launched } = base;
    return { input: { ...launched, transcript: "readable", status: "terminal", outcome: "failed", terminalAt: receipt.rejection?.rejectedAt ?? receipt.createdAt }, turn, hosted, createdAt };
  }
  if (!conversation) return { input: { ...base, status: "unknown", outcome: null, terminalAt: null }, turn, hosted, createdAt };
  if (turn === "terminal") {
    return { input: { ...base, status: "terminal", outcome: "finished", terminalAt: settledAt }, turn, hosted, createdAt };
  }
  /* No host anywhere. A settled turn with nothing running it is a worker that
     finished and whose host was released — the seat's to harvest. An OPEN turn
     with nothing running it is a stall the registry can see on its own, and
     it is reported as such, never as finished. A turn the registry never
     observed is unknown, and stays unknown. */
  if (turn === "idle") {
    return { input: { ...base, status: "terminal", outcome: "finished", terminalAt: settledAt }, turn, hosted, createdAt };
  }
  if (turn === "busy") {
    return {
      input: { ...base, status: "running", outcome: null, terminalAt: null, activity: { lifecycle: "gone", reason: "host_gone_turn_open", turnState: "busy" } },
      turn,
      hosted,
      createdAt,
    };
  }
  return { input: { ...base, status: "unknown", outcome: null, terminalAt: null }, turn, hosted, createdAt };
}

interface ChildEvidence {
  children: SeatTickChildInput[];
  unavailable: SeatTickChildrenGap | null;
  catchUpPending: boolean;
}

/** The one token a check carries when several conditions stand: the first in
    {@link SEAT_TICK_CHILDREN_GAPS}, which is ordered most severe first. */
function worstChildrenGap(gaps: ReadonlySet<SeatTickChildrenGap>): SeatTickChildrenGap | null {
  return SEAT_TICK_CHILDREN_GAPS.find((gap) => gaps.has(gap)) ?? null;
}

/** The token a blocked or unfinished accounting import stands under. */
function accountingGap(gap: string | null): SeatTickChildrenGap | null {
  if (gap === null) return null;
  return gap === "legacy-migration-pending" ? "migration-pending" : "migration-blocked";
}

/**
 * The seat's spawned children (#1465): discovered through indexed lineage
 * pages, polled through FIFO tickets, their terminal outcomes read from their
 * event ledgers and retained as owed rows until a landed wake names them.
 *
 * Four bounded passes keep new arrivals separate from historical work:
 *
 * - **Discovery.** The active seat's next page of {@link DISCOVERY_PAGE}
 *   edges, in insertion order past a durable anchor, on EVERY check — so a new
 *   worker is known one check after its edge exists whether the seat has
 *   four children or four hundred, and however many predecessors the seat
 *   file has retired before it. Bootstrap keeps a separate cursor for every
 *   older edge. A predecessor takes a turn when the discovery budget allows. A child discovery already finds terminal enters the poll queue at
 *   its head, so its ledger is read this check.
 * - **Running.** The first {@link RUNNING_PAGE} running tickets are observed,
 *   with a liveness read for a hosted open turn, and the first
 *   {@link RUNNING_ROTATE} move to the tail — so consecutive checks overlap and
 *   a stall on the thirteenth child is seen twice in a row like a stall on the
 *   first. A child seen settling — its turn no longer open, its host gone, or
 *   the child gone from the seat — is polled right here, ahead of the queue
 *   and with the ledger budget still whole: the moment its outcome is owed is
 *   the moment its ledger is read.
 * - **Poll.** Up to {@link POLL_VISITS} tickets, with eight cold visits reserved, are
 *   re-projected and their ledgers read within {@link TICK_LEDGER_BYTES}, then
 *   re-queued — at the tail once read to the end, at the head when the budget
 *   cut the read, so the next check resumes it first. Every child is reached
 *   in turn; none is ever skipped for being past a page bound.
 * - **Ready.** Owed outcomes are handed to the decision in ready order.
 *
 * What a check could not account for leaves as a token, never as silence:
 * each condition has its own name in {@link SeatTickChildrenGap}, and the
 * check carries the most severe one that stands.
 */
async function childWork(
  project: string,
  seat: SeatTickSeatInput | null,
  state: SeatTickProjectState,
  policy: SeatTickPolicy,
  sources: SeatTickSources,
): Promise<ChildEvidence> {
  if (!seat) return { children: [], unavailable: null, catchUpPending: false };
  if (!state.accounting) return { children: [], unavailable: "registry-unreadable", catchUpPending: false };
  assertSeatTickWork();
  const accounting = guardedSeatTickPort(new SeatTickAccounting(state.accounting.filename, project), "accounting.children");
  const registry = sources.registry();
  const now = sources.now();
  const catchingUp = !!seatTickCatchUp({ state, now, settings: effectiveSeatTickSettings(sources.settings(project), now, SEAT_TICK_WAKE_INTERVAL_MS), seat });
  const gaps = new Set<SeatTickChildrenGap>();
  const migration = accountingGap(state.accounting.gap);
  if (migration) gaps.add(migration);
  const children: SeatTickChildInput[] = [];
  /* Enumerated once per check and handed to every projection (#1783): the
     roots decide whether a child's transcript is one this Viewer can read. */
  const roots = transcriptRoots();
  const classify = (page: SeatChildrenPage, id: string) => {
    const edge = page.file.lineageEdges[id];
    if (!edge) return null;
    return projectChild(page.file, readOnlyConversationLookupFromSnapshot(page.file), edge, project, now, roots);
  };
  const pages = new Map<string, SeatChildrenPage>();
  let projectedRows = 0;
  const seatChildren = (...args: Parameters<typeof registry.pageSeatChildren>) => {
    const [owner, , limit, keys] = args;
    const cached = keys?.length === 1 ? pages.get(`${owner}/${keys[0]}`) : null;
    if (cached) return cached;
    if (projectedRows + limit > 60) { gaps.add("ledger-pending"); return null; }
    const page = registry.pageSeatChildren(...args);
    projectedRows += page?.keys.length ?? 0;
    for (const id of page?.keys ?? []) pages.set(`${owner}/${id}`, page!);
    if (!page) { gaps.add("children-unindexed"); return null; }
    return page;
  };
  let bytesLeft = TICK_LEDGER_BYTES;
  const coldVisits: AccountingChild[] = [];

  /** One owner's next discovery page. */
  const discover = (owner: AccountingOwner): boolean => {
    const page = seatChildren(owner.conversationId, owner.after, DISCOVERY_PAGE);
    if (!page) return false;
    const discoveries = [page];
    let bootstrap = owner.bootstrap;
    let after = page.after;
    if (!owner.after && !owner.bootstrap && !page.complete) {
      // Capture the tail independently; the unread history keeps its own cursor.
      bootstrap = { after: page.after };
      after = page.latest ?? page.after;
    } else if (bootstrap && projectedRows <= 20) {
      const history = seatChildren(owner.conversationId, bootstrap.after, DISCOVERY_PAGE);
      if (history) {
        discoveries.push(history);
        bootstrap = history.complete ? undefined : { after: history.after };
      }
    }
    const discovered: { child: AccountingChild; position: TicketPosition }[] = [];
    for (const discoveredPage of discoveries) for (const id of discoveredPage.keys) {
      const edge = discoveredPage.file.lineageEdges[id];
      const child = classify(discoveredPage, id);
      if (child && edge?.evidence.launchId) discovered.push({
        child: accounting.child(id, owner.conversationId, edge.evidence.launchId, child.input),
        position: child.input.status === "terminal" ? "head" : "tail",
      });
    }
    accounting.discovery({ ...owner, after: page.evidenceGap ? owner.after : after, bootstrap }, discovered);
    if (bootstrap || discoveries.some((value) => value.evidenceGap || !value.complete)) gaps.add("discovery-incomplete");
    return true;
  };

  /** One child's poll, from a page already read: re-projected, its ledger
      read from its cursor within what is left of the check's budget, and its
      ticket re-queued. A settled child whose read the budget cut is an
      outcome owed and not yet known, and the check says so. */
  const poll = (child: AccountingChild, page: SeatChildrenPage, projected: ProjectedChild | null): void => {
    // Discovery predates the loop's yield. A newly hosted child must not get
    // a failure receipt or an unknown-turn completion from that old snapshot.
    if (projected && !projected.hosted && (projected.input.status === "unknown" || projected.input.transcript === "unresolvable")) {
      pages.delete(`${child.owner}/${child.rowKey}`);
      const fresh = seatChildren(child.owner, null, 1, [child.rowKey]);
      if (!fresh) { accounting.promote(child); return; }
      page = fresh;
      projected = classify(page, child.rowKey);
    }
    const previousInput = child.input;
    const previousResolvedGeneration = child.resolvedGeneration ?? null;
    const previousGeneration = child.generationIndex;
    const edge = page.file.lineageEdges[child.rowKey];
    if (!projected || !edge || edge.parentConversationId !== child.owner || edge.evidence.launchId !== child.launchId) {
      accounting.ingest({ ...child, input: { ...child.input, status: "unknown", outcome: null } }, null, []);
      gaps.add("child-departed");
      return;
    }
    child.input = projected.input;
    const unplaced = () => {
      if (child.input.status === "unknown") { children.push(child.input); gaps.add("child-unplaced"); }
    };
    const lookup = readOnlyConversationLookupFromSnapshot(page.file);
    const conversation = lookup.conversation(edge.childConversationId);
    const generations = conversation?.generations ?? [];
    const generation = generations[child.generationIndex % Math.max(1, generations.length)];
    const receipt = page.file.receipts[child.launchId];
    // A failed receipt after materialization cannot establish pre-execution failure.
    const failure = !projected.hosted && receipt?.state === "failed" && receipt.key === null && receipt.artifactPath === null && generations.length === 0;
    if (!generation) {
      const abandoned = !projected.hosted && !!receipt;
      if (abandoned) child.input = { ...child.input, status: "terminal", outcome: "failed", terminalAt: receipt.createdAt };
      accounting.ingest(child, null, [], failure || (abandoned ? "launch-unmaterialized" : false));
      unplaced();
      return;
    }
    const source = accounting.source(child, conversation!.engine, generation.id);
    const previousCursor = source.cursor;
    const budget = Math.min(bytesLeft, CHILD_LEDGER_BYTES);
    const read = readChildLedger(path.join(statePath("structured-host-events"), `${encodeURIComponent(generation.id)}.jsonl`), source.cursor, budget);
    source.cursor = read.cursor;
    const latestGeneration = generations.at(-1);
    const validatedLatestSettlement = read.cursor.gap === null
      && read.cursor.atEnd && read.cursor.activeTurn === null && read.cursor.settledThrough > 0;
    if (validatedLatestSettlement && latestGeneration === generation
      && (projected.turn === "idle" || projected.turn === "terminal" || (!projected.hosted && projected.turn === "unknown"))) {
      child.resolvedGeneration = generation.id;
      child.input = { ...child.input, status: "terminal", outcome: "finished", terminalAt: child.input.terminalAt ?? child.input.lastRecordAt ?? null };
    }
    const lost = !projected.hosted && child.input.transcript === "unresolvable"
      && generation === generations.at(-1)
      && ((read.cursor.identity === null && read.cursor.gap === null) || read.cursor.gap === "ledger-missing");
    const abandonedActiveTurn = !projected.hosted && child.input.transcript === "unresolvable"
      && generation === latestGeneration && read.cursor.gap === null && read.cursor.atEnd
      && read.cursor.activeTurn !== null;
    const retainedLatestSettlement = latestGeneration !== generation && projected.turn === "unknown" && !projected.hosted
      && previousResolvedGeneration === latestGeneration?.id && previousInput.status === "terminal"
      && previousInput.outcome !== null;
    if (lost || abandonedActiveTurn) {
      child.resolvedGeneration = generation.id;
      child.input = { ...child.input, status: "terminal", outcome: "failed", terminalAt: child.input.terminalAt ?? child.input.lastRecordAt ?? child.input.spawnedAt ?? null };
    } else if (retainedLatestSettlement) {
      child.input = { ...child.input, status: "terminal", outcome: previousInput.outcome, terminalAt: previousInput.terminalAt };
    }
    unplaced();
    bytesLeft -= read.bytes;
    // A vanished host and both records gone have a named failure receipt.
    // Keep the cursor and every earlier outcome for a later recovery.
    if (source.cursor.gap !== null && !lost) gaps.add("ledger-gap");
    child.generationIndex = (child.generationIndex + 1) % generations.length;
    /* A read the budget stopped short of the end resumes first next check. */
    const cut = !read.cursor.atEnd && (read.bytes >= budget || read.outcomes.length >= OUTCOME_LIMIT);
    if (child.input.status === "terminal" && read.bytes === 0 && read.outcomes.length === 0 && read.cursor.atEnd
      && child.generationIndex === previousGeneration && JSON.stringify(previousCursor) === JSON.stringify(read.cursor)
      && JSON.stringify(previousInput) === JSON.stringify(child.input)) coldVisits.push(child);
    else accounting.ingest(child, source, read.outcomes, lost || abandonedActiveTurn ? "host-gone-no-transcript" : false, cut ? "head" : "tail");
    if (cut && projected.turn !== "busy") gaps.add("ledger-pending");
  };

  let catchUpPending = false;
  try {
    const active = accounting.owner(seat.conversationId, seat.seatEpoch);
    if (accounting.discoverRevokedOwners(statePath("orchestrator-seats.json"), (ownerProject) => canonicalOrchestratorProject(ownerProject) === project)) {
      gaps.add("discovery-incomplete");
    }
    if (discover(active)) {
      /* The active owner's ticket just moved to the tail, so the head of the
         owner queue is the predecessor whose turn it is — unless the active
         seat is the only owner there is. */
      const ticket = accounting.page("owner-poll", 1)[0];
      if (projectedRows <= 20 && ticket?.kind === "owner-poll") {
        const owner = accounting.get(ticket.target);
        if (!owner || owner.kind !== "owner") throw new Error("missing owner provenance");
        const migrated = owner.pollKey ? owner : accounting.owner(owner.conversationId, owner.epoch);
        if (migrated.pollKey !== ticket.key) accounting.drop(ticket);
        else if (migrated.key !== active.key) discover(migrated);
      }
    }
    const observedRunning = new Set<string>();
    const running = accounting.page("running", RUNNING_PAGE);
    for (const ticket of running) {
      await yieldToRuntime();
      if (ticket.kind !== "running") continue;
      const child = accounting.get(ticket.target);
      if (!child || child.kind !== "child") throw new Error("missing running child");
      const page = seatChildren(child.owner, null, 1, [child.rowKey]);
      if (!page) break;
      const projected = classify(page, child.rowKey);
      /* A child whose turn has settled, whose host is gone, or that left the
         seat: its outcome is owed the moment its ledger is read, so it is read
         now. What the budget cannot reach goes to the head of the poll queue,
         and until it is read the check may not call the board quiet. */
      if (!projected || projected.input.status !== "running" || projected.turn === "idle" || projected.turn === "terminal") {
        if (bytesLeft > 0) poll(child, page, projected);
        else { accounting.promote(child); gaps.add("ledger-pending"); }
        if (!projected || projected.input.status !== "running") continue;
        /* Still hosted with a settled turn and nothing new in its ledger: a
           worker idling at its prompt, which is open work like any other. */
        if (child.input.status !== "running") continue;
      }
      let input = projected.input;
      if (projected.turn === "busy" && projected.hosted) {
        try { input = { ...input, activity: activityOf((await sources.liveness({ conversationId: input.conversationId, stallAfterMs: policy.stallAfterMs, limit: 1 }))[0]) }; }
        catch { input = { ...input, activity: null }; }
      }
      children.push(input);
      observedRunning.add(child.key);
    }
    accounting.rotateRunning(running.slice(0, RUNNING_ROTATE));
    const catchUpPollThrough = catchingUp && !gaps.has("discovery-incomplete")
      ? accounting.beginCatchUpPoll()
      : null;
    const pollTickets = accounting.pollPage(POLL_VISITS).filter(ticket => {
      if (!catchingUp || catchUpPollThrough === null) return true;
      if (ticket.kind !== "poll") return false;
      // Priority tickets represent a ledger read cut during this same outage.
      // Keep following them even though their replacement ticket has a newer
      // sequence than the frozen snapshot.
      if (ticket.key.startsWith(`poll/${encodeURIComponent(project)}/!`)) return true;
      return Number(ticket.key.slice(ticket.key.lastIndexOf("/") + 1)) <= catchUpPollThrough;
    });
    for (const ticket of pollTickets) {
      await yieldToRuntime();
      if (bytesLeft <= 0) break;
      if (ticket.kind !== "poll") throw new Error("invalid poll ticket");
      let child = accounting.get(ticket.target);
      if (!child || child.kind !== "child") throw new Error("missing child provenance");
      child = accounting.adoptPoll(child, ticket.key);
      if (child.pollKey !== ticket.key) { accounting.drop(ticket); continue; }
      // Keep twenty uncached projections available for ready outcomes.
      if (projectedRows >= 40 && !pages.has(`${child.owner}/${child.rowKey}`)) break;
      const page = seatChildren(child.owner, null, 1, [child.rowKey]);
      if (!page) break;
      const projected = classify(page, child.rowKey);
      poll(child, page, projected);
      // A cold child re-instructed since its last poll contributes immediately.
      if (child.input.status === "running" && !observedRunning.has(child.key)) {
        children.push(child.input);
        observedRunning.add(child.key);
      }
    }
    // Cold visits count as covered by this pass too; rotate their ticket
    // before checking the frozen snapshot so an unchanged ledger does not
    // force an unnecessary extra catch-up check.
    accounting.rotateCold(coldVisits);
    if (catchUpPollThrough !== null) {
      const next = accounting.page("poll", 1)[0];
      const pending = next?.kind === "poll" && (next.key.startsWith(`poll/${encodeURIComponent(project)}/!`)
        || Number(next.key.slice(next.key.lastIndexOf("/") + 1)) <= catchUpPollThrough);
      catchUpPending = !!pending;
      if (pending) gaps.add("ledger-pending");
      else accounting.endCatchUpPoll();
    }
    // Page the persisted ready queue, yielding between pages. The cutoff is
    // the snapshot gathered by this check; deliveries acknowledge its exact ids.
    const ready = async function* () {
      if (!catchingUp) {
        yield* accounting.ready(20); return;
      }
      let after: string | undefined;
      const cutoff = accounting.row()!.sequence;
      for (;;) {
        const page = accounting.page("ready", 64, after);
        for (const ticket of page) {
          if (Number(ticket.key.slice(ticket.key.lastIndexOf("/") + 1)) > cutoff) return;
          if (ticket.kind !== "ready") throw new Error("invalid ready ticket");
          const outcome = accounting.get(ticket.target);
          if (!outcome || outcome.kind !== "outcome") throw new Error("missing ready outcome");
          if (outcome.status === "owed" && !outcome.gap) yield outcome;
        }
        if (page.length < 64) return;
        after = page.at(-1)!.key;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    };
    for await (const outcome of ready()) {
      await yieldToRuntime();
      if (catchingUp && projectedRows >= 40) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        pages.clear();
        projectedRows = 0;
      }
      const child = accounting.get(outcome.child);
      if (!child || child.kind !== "child") throw new Error("missing ready child");
      const page = seatChildren(child.owner, null, 1, [child.rowKey]);
      if (!page) break;
      const projected = classify(page, child.rowKey);
      if (!projected || page.file.lineageEdges[child.rowKey]?.parentConversationId !== child.owner) { accounting.defer(outcome); gaps.add("child-departed"); continue; }
      /* The harvest stamp travels with the outcome (#1749). The row is the
         child's, the outcome is one turn of one generation of it, and the
         decision needs both to tell a result nobody has taken from a fresh
         projection of one a retired seat took weeks ago.

         The terminal time and the transcript come off the projection this
         check just made, not off the frozen row (#1783). An outcome is minted
         the moment its ledger yields an ended turn, which is routinely a
         check where the child's own turn had not settled yet: the row froze
         `terminalAt: null` then, and 130 of the 209 owed rows on the board
         this was filed from carry exactly that — a null the age test cannot
         test. The child as it stands now is what the test must read. */
      const { terminalAt, lastRecordAt, transcript, transcriptReason, transcriptPath, engine, spawnedAt } = projected.input;
      const { transcriptReason: _frozen, transcriptPath: _frozenPath, ...frozen } = outcome.input;
      children.push({
        ...frozen,
        terminalAt: terminalAt ?? outcome.input.terminalAt,
        lastRecordAt,
        transcript,
        ...(transcriptReason ? { transcriptReason } : {}),
        ...(transcriptPath ? { transcriptPath, engine } : {}),
        ...(spawnedAt ? { spawnedAt } : {}),
        ...(child.harvestedEpoch === undefined ? {} : { harvestedEpoch: child.harvestedEpoch }),
      });
    }
  } catch { gaps.add("registry-unreadable"); }
  return { children, unavailable: worstChildrenGap(gaps), catchUpPending };
}

function stageAttempt(lane: Pipeline) {
  const stageId = lane.cursor?.stageId;
  return stageId ? lane.runs.find((run) => run.stageId === stageId)?.attempts.at(-1) ?? null : null;
}

function stageAttemptIdentity(lane: Pipeline): string | null {
  const attempt = stageAttempt(lane);
  return attempt ? JSON.stringify([attempt.n, attempt.conversationId ?? null, attempt.startedAt ?? null]) : null;
}

/** Refresh the cheap durable alarm sources after asynchronous evidence reads.
 * Liveness belongs to the stage that was observed; a new stage inherits none.
 */
export function refreshSeatTickInput(input: SeatTickCheckInput, sources: SeatTickSources): SeatTickCheckInput {
  const hotLanes = sources.pipelines();
  const sourceTasks = sources.tasks();
  const now = sources.now();
  const settings = effectiveSeatTickSettings(sources.settings(input.project), now, SEAT_TICK_WAKE_INTERVAL_MS);
  const announcedKey = announcedLaneKey(input.state, seatTickCatchUp({ ...input, now, settings })?.key ?? null);
  const cache = seatTickRefreshCache.get(input);
  if (cache && Object.isFrozen(hotLanes) && Object.isFrozen(sourceTasks)
    && cache.pipelinesSource === hotLanes && cache.tasksSource === sourceTasks
    && cache.project === input.project && cache.seatKey === seatInputKey(input.seat)
    && cache.announcedKey === announcedKey
    && cache.aliasesKey === `${projectRowsAliasKey(hotLanes)}\0${projectRowsAliasKey(sourceTasks)}`
    && cache.linkedKey === (cache.linkedKey === null ? null : JSON.stringify(linkedContext()))) {
    return reuseSeatTickProjection(input, sources, cache, now, settings);
  }
  const canonicalProject = seatProjectResolver();
  const { lanes: openLanes, tasks: openTasks } = performanceSpans.sync("seat-tick.project",
    () => openTickLanes(projectRows(hotLanes, input.project), input.project, canonicalProject), hotLanes.length);
  const evidence = performanceSpans.sync("seat-tick.project", () => openLanes.map(pipelineEvidence), openLanes.length);
  const previous = new Map(input.pipelines.map((lane) => [lane.id, lane]));
  const pauses = pauseInputs(openLanes, input.seat, sources, now);
  const pipelines = openLanes.map((lane, index): SeatTickPipelineInput => ({
    id: lane.id, title: evidence[index]!.title, state: evidence[index]!.state, updatedAt: evidence[index]!.updatedAt,
    stageId: lane.cursor?.stageId ?? null,
    stageState: lane.cursor?.state ?? null,
    stageAttemptState: stageAttempt(lane)?.state ?? null,
    stageAttempt: stageAttemptIdentity(lane),
    stageActivity: previous.get(lane.id)?.stageId === (lane.cursor?.stageId ?? null)
      && previous.get(lane.id)?.stageAttempt === stageAttemptIdentity(lane)
      && previous.get(lane.id)?.updatedAt === evidence[index]!.updatedAt
      ? previous.get(lane.id)?.stageActivity ?? null : null,
    ...pauses.get(lane.id),
  }));
  const sourceById = performanceSpans.sync("seat-tick.project", () => new Map(projectRows(sourceTasks, input.project).map(task => [task.id, task] as const)), sourceTasks.length);
  const board = performanceSpans.sync("seat-tick.project", () => seatTaskPipelineIds(projectRows(sourceTasks, input.project), hotLanes));
  const taskEvidence = performanceSpans.sync("seat-tick.project", () => board.map(task => taskEvidenceFor(sourceById.get(task.id) ?? task, task.pipelineIds)), board.length);
  const linked = board.some((task) => task.machine) ? linkedContext() : null;
  const tasks: SeatTickTaskInput[] = board.map((task, index) => ({
    id: task.id, title: taskEvidence[index]!.title, status: task.status, owned: task.chosen === true ? openTasks.has(task.id) : taskEvidence[index]!.owner !== null,
    updatedAt: task.updatedAt ?? null, dueAt: task.dueAt,
    accepted: task.chosen === true, hold: task.hold, waitingSince: task.statusBy?.at ?? task.createdAt ?? task.updatedAt,
    ...(linked && !runsHere(task, linked) ? { runsOn: machineLabel(task.machine!, linked).label } : {}),
  }));
  const ownLanes = performanceSpans.sync("seat-tick.project", () => ownSettledLanes(
    input.project, input.seat, input.state.announcedLanes ?? [], projectRows(hotLanes, input.project), !!seatTickCatchUp({ ...input, now, settings })), hotLanes.length);
  const openIds = openSeatPipelineIds(hotLanes);
  const refreshed: SeatTickCheckInput = {
    ...input, now, pipelines, tasks, ownLanes,
    overdueTasks: overdueTaskInputs(sources, input.project, now, openTasks, input.state.itemsShown ?? []),
    ...(sources.memoryProblems ? { signals: [...input.signals.filter(signal => !signal.id.startsWith("memory-problem:")), ...sources.memoryProblems(input.project, input.state.itemsShown ?? [], input.seat?.conversationId ? input.seat : null)] } : {}),
    events: input.events.map((event) => ({ ...event, pipelineTerminal: event.pipelineId !== null && !openIds.has(event.pipelineId) })),
    settings,
    changeFingerprint: seatTickFingerprint(pipelines, tasks, input.children, input.pullRequests, input.pullRequestsUnavailable, ownLanes,
      input.settledDeploys ?? [], input.settledMaintenance ?? []),
    digestFingerprint: changeFingerprint(pipelines, tasks, input.children, input.pullRequests, input.pullRequestsUnavailable, ownLanes, input.settledDeploys, input.settledMaintenance, "digest", input.pullRequestsObserved !== false),
  };
  if (Object.isFrozen(hotLanes) && Object.isFrozen(sourceTasks)) {
    seatTickRefreshCache.set(refreshed, {
      pipelinesSource: hotLanes, tasksSource: sourceTasks, project: input.project,
      seatKey: seatInputKey(input.seat), announcedKey,
      aliasesKey: `${projectRowsAliasKey(hotLanes)}\0${projectRowsAliasKey(sourceTasks)}`, pipelines, tasks, ownLanes,
      linkedKey: linked ? JSON.stringify(linked) : null,
      openIds, openTasks, pausedLanes: hotLanes.filter(lane => lane.state === "paused" && canonicalProject(lane.project) === input.project),
      pipelineById: new Map(pipelines.map(pipeline => [pipeline.id, pipeline])),
      children: refreshed.children, pullRequests: refreshed.pullRequests,
      pullRequestsUnavailable: refreshed.pullRequestsUnavailable, settledDeploys: refreshed.settledDeploys,
      settledMaintenance: refreshed.settledMaintenance, fingerprint: refreshed.changeFingerprint,
    });
  }
  return refreshed;
}

type SeatTickRefreshCache = {
  pipelinesSource: readonly Pipeline[];
  tasksSource: readonly BoardTask[];
  project: string;
  seatKey: string;
  announcedKey: string;
  aliasesKey: string;
  linkedKey: string | null;
  pipelines: SeatTickPipelineInput[];
  tasks: SeatTickTaskInput[];
  ownLanes: SeatTickOwnLaneInput[];
  openIds: Set<string>;
  openTasks: Set<string>;
  pausedLanes: readonly Pipeline[];
  pipelineById: Map<string, SeatTickPipelineInput>;
  children: SeatTickCheckInput["children"];
  pullRequests: SeatTickCheckInput["pullRequests"];
  pullRequestsUnavailable: SeatTickCheckInput["pullRequestsUnavailable"];
  settledDeploys: SeatTickCheckInput["settledDeploys"];
  settledMaintenance: SeatTickCheckInput["settledMaintenance"];
  fingerprint: string;
};
const seatTickRefreshCache = new WeakMap<SeatTickCheckInput, SeatTickRefreshCache>();
function seatInputKey(seat: SeatTickSeatInput | null): string {
  return JSON.stringify(seat ? [seat.conversationId, seat.seatEpoch] : null);
}
function sameTaskSource(current: readonly BoardTask[], prepared: readonly BoardTask[]): boolean {
  if (current === prepared || (current.length === 0 && prepared.length === 0)) return true;
  if (current.length !== prepared.length) return false;
  for (let index = 0; index < current.length; index++) {
    if (current[index] === prepared[index] && deeplyFrozen(current[index])) continue;
    if (JSON.stringify(current[index]) !== JSON.stringify(prepared[index])) return false;
  }
  return true;
}
function samePipelineSource(current: readonly Pipeline[], prepared: readonly Pipeline[]): boolean {
  if (current === prepared) return true;
  if (current.length !== prepared.length) return false;
  for (let index = 0; index < current.length; index++) {
    if (current[index] === prepared[index] && deeplyFrozen(current[index])) continue;
    if (laneEvidenceHash(current[index]!) !== laneEvidenceHash(prepared[index]!)) return false;
  }
  return true;
}
function announcedLaneKey(state: SeatTickProjectState, catchUpKey: string | null): string {
  return JSON.stringify([state.announcedLanes ?? [], catchUpKey]);
}
function reuseSeatTickProjection(input: SeatTickCheckInput, sources: SeatTickSources, cache: SeatTickRefreshCache,
  now: number, settings: ReturnType<typeof effectiveSeatTickSettings>): SeatTickCheckInput {
  const pauses = performanceSpans.sync("seat-tick.project", () => pauseInputs(cache.pausedLanes, input.seat, sources, now), cache.pausedLanes.length);
  let pauseChanged = false;
  for (const [id, pause] of pauses) {
    const previous = cache.pipelineById.get(id);
    if (!previous || previous.pausedAt !== pause.pausedAt || previous.pauseGeneration !== pause.pauseGeneration
      || previous.pauseConditionMet !== pause.pauseConditionMet || JSON.stringify(previous.pause) !== JSON.stringify(pause.pause)) {
      pauseChanged = true; break;
    }
  }
  const pipelines = pauseChanged ? cache.pipelines.map(pipeline => {
    const { pausedAt: _pausedAt, pauseGeneration: _pauseGeneration, pause: _pause, pauseConditionMet: _condition, ...base } = pipeline;
    return { ...base, ...pauses.get(pipeline.id) };
  }) : cache.pipelines;
  const linked = input.events.map(event => ({ ...event, pipelineTerminal: event.pipelineId !== null && !cache.openIds.has(event.pipelineId) }));
  const signals = sources.memoryProblems
    ? [...input.signals.filter(signal => !signal.id.startsWith("memory-problem:")), ...sources.memoryProblems(input.project, input.state.itemsShown ?? [], input.seat?.conversationId ? input.seat : null)]
    : input.signals;
  const fingerprintStable = pipelines === cache.pipelines && input.children === cache.children
    && input.pullRequests === cache.pullRequests && input.pullRequestsUnavailable === cache.pullRequestsUnavailable
    && input.settledDeploys === cache.settledDeploys && input.settledMaintenance === cache.settledMaintenance;
  const refreshed: SeatTickCheckInput = {
    ...input, now, pipelines, tasks: cache.tasks, ownLanes: cache.ownLanes, events: linked, signals, settings,
    overdueTasks: overdueTaskInputs(sources, input.project, now, cache.openTasks, input.state.itemsShown ?? []),
    changeFingerprint: fingerprintStable ? cache.fingerprint : seatTickFingerprint(pipelines, cache.tasks, input.children,
      input.pullRequests, input.pullRequestsUnavailable, cache.ownLanes, input.settledDeploys ?? [], input.settledMaintenance ?? []),
  };
  seatTickRefreshCache.set(refreshed, { ...cache, pipelines, children: input.children, pullRequests: input.pullRequests,
    pullRequestsUnavailable: input.pullRequestsUnavailable, settledDeploys: input.settledDeploys,
    settledMaintenance: input.settledMaintenance, pipelineById: pauseChanged
      ? new Map(pipelines.map(pipeline => [pipeline.id, pipeline])) : cache.pipelineById,
    fingerprint: refreshed.changeFingerprint });
  return refreshed;
}

/** Refresh after the immutable evidence rows have been prepared in bounded
 * slices. A row may have arrived since the preceding await, so every refresh
 * prepares the currently published source set before using its projection. */
async function refreshSeatTickInputCooperatively(
  input: SeatTickCheckInput,
  sources: SeatTickSources,
): Promise<SeatTickCheckInput> {
  return withViewerOperation("seat-tick.check", async () => {
    let pipelines = sources.pipelines(), tasks = sources.tasks();
    /* Even a projection cache hit crosses preparation once so durable alias
       changes invalidate its in-memory grouping before the rows are reused. */
    for (let attempt = 0; ; attempt++) {
      pipelines = sources.pipelines();
      tasks = sources.tasks();
      await performanceSpans.wait("seat-tick.project", () => prepareSeatTickProjection(sources, input.project, pipelines, tasks));
      // Prefer the replacement, but bound preparation under continuous churn.
      // The captured rows already have their metadata prepared; projecting
      // that snapshot keeps the alarm progressing without claiming later rows.
      if ((sources.pipelines() === pipelines || samePipelineSource(projectRows(sources.pipelines(), input.project), projectRows(pipelines, input.project)))
        && (sources.tasks() === tasks || sameTaskSource(projectRows(sources.tasks(), input.project), projectRows(tasks, input.project)))) break;
      if (attempt >= 2) break;
    }
    const preparedSources = Object.create(sources) as SeatTickSources;
    preparedSources.pipelines = () => pipelines;
    preparedSources.tasks = () => tasks;
    return performanceSpans.sync("seat-tick.project", () => refreshSeatTickInput(input, preparedSources));
  });
}

/* Keep the byte-proportional evidence projection with its immutable source row.
   Warm refreshes then visit only row identities and small derived fields; a
   mutable adapter/test row always takes the uncached path. */
const seatProjectionHost = globalThis as typeof globalThis & {
  __llvSeatTickPipelineEvidence?: WeakMap<Pipeline, EvidenceItem>;
  __llvSeatTickTaskEvidence?: WeakMap<object, EvidenceItem>;
  __llvSeatTickPipelineMovement?: WeakMap<Pipeline, string | null>;
  __llvSeatTickPipelineSettlement?: WeakMap<Pipeline, SeatTickOwnLaneInput["settled"] | null>;
};
function pipelineEvidence(pipeline: Pipeline): EvidenceItem {
  const cache = seatProjectionHost.__llvSeatTickPipelineEvidence ??= new WeakMap();
  const cached = deeplyFrozen(pipeline) ? cache.get(pipeline) : undefined;
  if (cached) return cached;
  const evidence = evidenceFromPipelines([pipelineSummary(pipeline)])[0]!;
  if (deeplyFrozen(pipeline)) cache.set(pipeline, evidence);
  return evidence;
}
async function preparePipelineEvidence(pipeline: Pipeline): Promise<void> {
  const cache = seatProjectionHost.__llvSeatTickPipelineEvidence ??= new WeakMap();
  if (deeplyFrozen(pipeline) && cache.has(pipeline)) return;
  const metadata = await preparePipelineMetadata(pipeline);
  const summary: PipelineSummary = {
    id: pipeline.id, task: pipeline.task, project: pipeline.project, state: pipeline.state,
    createdAt: pipeline.createdAt, closedAt: pipeline.closedAt,
    ...(pipeline.spec ? { spec: pipeline.spec } : {}), activityAt: metadata.movement ? [metadata.movement] : [],
  };
  const evidence = await evidenceFromPipelineCooperatively(summary);
  if (deeplyFrozen(pipeline)) {
    cache.set(pipeline, evidence);
  }
}
async function preparePipelineMetadata(pipeline: Pipeline): Promise<{ movement: string | null; settlement: SeatTickOwnLaneInput["settled"] | null }> {
  const movementCache = seatProjectionHost.__llvSeatTickPipelineMovement ??= new WeakMap();
  const settlementCache = seatProjectionHost.__llvSeatTickPipelineSettlement ??= new WeakMap();
  if (deeplyFrozen(pipeline) && movementCache.has(pipeline) && settlementCache.has(pipeline)) {
    return { movement: movementCache.get(pipeline) ?? null, settlement: settlementCache.get(pipeline) ?? null };
  }
  let movement: string | null = null, movementTime = Number.NEGATIVE_INFINITY;
  let newest: Pipeline["runs"][number]["attempts"][number] | null = null, newestTime = Number.NEGATIVE_INFINITY, attempts = 0;
  const observeMovement = (value: string | null | undefined) => {
    if (!value) return;
    const time = Date.parse(value);
    if (Number.isFinite(time) && time > movementTime) { movement = value; movementTime = time; }
  };
  observeMovement(pipeline.pausedAt);
  observeMovement(pipeline.resumedAt);
  let started = performance.now();
  for (const run of pipeline.runs) for (const attempt of run.attempts) {
    attempts++;
    observeMovement(attempt.startedAt);
    observeMovement(attempt.completedAt);
    const time = Date.parse(attempt.completedAt ?? attempt.startedAt ?? "");
    if (Number.isFinite(time) && time >= newestTime) { newest = attempt; newestTime = time; }
    if (performance.now() - started >= 8) { await yieldToRuntime(); started = performance.now(); }
  }
  let settlement: SeatTickOwnLaneInput["settled"] | null = null;
  if (!pipeline.hiddenAt && !pipeline.dismissedAt && pipeline.state !== "closed") {
    if (pipeline.state === "needs_review" || pipeline.pausedState === "needs_review") settlement = "needs_review";
    else if (pipeline.state === "completed") settlement = "completed";
    else if (pipeline.state === "needs_decision" || pipeline.pausedState === "needs_decision") settlement = attempts === 0 ? "provisioning-failed" : "needs_decision";
    else if (newest?.state === "failed") settlement = "failed";
    else if (newest?.state === "needs_decision") settlement = "needs_decision";
    else if (pipeline.state === "running" && attempts === 1) settlement = "provisioned";
  }
  if (deeplyFrozen(pipeline)) {
    movementCache.set(pipeline, movement);
    settlementCache.set(pipeline, settlement);
  }
  return { movement: movement ?? null, settlement };
}
function taskEvidenceFor(task: BoardTask, pipelineIds: readonly string[] = []): EvidenceItem {
  const cache = seatProjectionHost.__llvSeatTickTaskEvidence ??= new WeakMap();
  const cached = deeplyFrozen(task) ? cache.get(task) : undefined;
  const evidence = cached ?? evidenceFromTasks([taskSummary({ ...task, pipelineIds: [] })])[0]!;
  if (!cached && deeplyFrozen(task)) cache.set(task, evidence);
  return pipelineIds[0] ? { ...evidence, owner: `pipeline ${pipelineIds[0]}` } : evidence;
}

type ProjectRow = { project: string };
// Weak keys release old publications. Only the current alias generation is
// retained per publication; mutable adapters never reuse a projection.
const projectRowsCache = new WeakMap<readonly ProjectRow[], {
  aliases: string; byProject: Map<string, readonly ProjectRow[]>; ready: Promise<void>; complete: boolean; taskLanes: Map<string, Pipeline[]>; openIds: Set<string>; order: Map<Pipeline, number>;
}>();
async function prepareProjectRows(rows: readonly ProjectRow[], snapshot = projectAliasSnapshot()): Promise<void> {
  if (!Object.isFrozen(rows)) return;
  const aliases = JSON.stringify(snapshot.aliases);
  const held = projectRowsCache.get(rows);
  if (held?.aliases === aliases) return held.ready;
  const canonical = projectAliasResolver(snapshot);
  const byProject = new Map<string, ProjectRow[]>();
  const entry = { aliases, byProject, ready: Promise.resolve(), complete: false,
    taskLanes: new Map<string, Pipeline[]>(), openIds: new Set<string>(), order: new Map<Pipeline, number>() };
  let reusable = true;
  entry.ready = forEachSharedRow(rows, (row, index) => {
    if (!Object.isFrozen(row)) reusable = false;
    const project = canonical(row.project);
    const group = byProject.get(project) ?? [];
    if (!byProject.has(project)) byProject.set(project, group);
    group.push(row);
    if ("taskIds" in row && Array.isArray(row.taskIds)) {
      const pipeline = row as Pipeline;
      if (!Object.isFrozen(pipeline.taskIds)) reusable = false;
      entry.order.set(pipeline, index);
      if (isOpen(pipeline)) entry.openIds.add(pipeline.id);
      for (const id of new Set(pipeline.taskIds)) {
        const lanes = entry.taskLanes.get(id) ?? [];
        if (!entry.taskLanes.has(id)) entry.taskLanes.set(id, lanes);
        lanes.push(pipeline);
      }
    }
  }, { batchSize: 256, timeBudgetMs: 8 }).then(() => {
    entry.complete = true;
    if (!reusable && projectRowsCache.get(rows) === entry) projectRowsCache.delete(rows);
  }).catch(error => {
    if (projectRowsCache.get(rows) === entry) projectRowsCache.delete(rows);
    throw error;
  });
  projectRowsCache.set(rows, entry);
  await entry.ready;
}
function projectRows<T extends ProjectRow>(rows: readonly T[], project: string): readonly T[] {
  const held = Object.isFrozen(rows) ? projectRowsCache.get(rows) : undefined;
  // Alias freshness is sampled at the async preparation boundary. Every
  // projection lookup after that boundary is an in-memory map access.
  if (held?.complete) return (held.byProject.get(project) ?? []) as readonly T[];
  const canonical = seatProjectResolver();
  const selected = rows.filter(row => canonical(row.project) === project);
  return selected.length === rows.length ? rows : selected;
}
function projectRowsAliasKey(rows: readonly ProjectRow[]): string | null {
  return Object.isFrozen(rows) ? projectRowsCache.get(rows)?.aliases ?? null : null;
}

function seatTaskPipelineIds(tasks: readonly BoardTask[], pipelines: readonly Pipeline[]) {
  const held = Object.isFrozen(pipelines) ? projectRowsCache.get(pipelines) : undefined;
  if (!held?.complete) return projectTaskPipelineIds(tasks, pipelines);
  const linked = new Map<string, Pipeline>();
  for (const task of tasks) for (const lane of held.taskLanes.get(task.id) ?? []) linked.set(lane.id, lane);
  return projectTaskPipelineIds(tasks, [...linked.values()].sort((left, right) => held.order.get(left)! - held.order.get(right)!));
}
function openSeatPipelineIds(pipelines: readonly Pipeline[]): Set<string> {
  const held = Object.isFrozen(pipelines) ? projectRowsCache.get(pipelines) : undefined;
  return held?.complete ? held.openIds : new Set(pipelines.filter(isOpen).map(lane => lane.id));
}

async function prepareSeatTickProjection(
  sources: SeatTickSources,
  project: string,
  pipelines: readonly Pipeline[] = sources.pipelines(),
  tasks: readonly BoardTask[] = sources.tasks(),
): Promise<void> {
  const aliases = projectAliasSnapshot();
  const aliasesKey = JSON.stringify(aliases.aliases);
  await prepareProjectRows(pipelines, aliases);
  await prepareProjectRows(tasks, aliases);
  await forEachCooperatively(projectRows(pipelines, project), async pipeline => {
    await preparePipelineMetadata(pipeline);
    if (isOpen(pipeline)) await preparePipelineEvidence(pipeline);
  }, { batchSize: 4, timeBudgetMs: 8 });
  await forEachCooperatively(projectRows(tasks, project), task => {
    if (deeplyFrozen(task)) taskEvidenceFor(task);
  }, { batchSize: 4, timeBudgetMs: 8 });
  if (JSON.stringify(projectAliasSnapshot().aliases) !== aliasesKey) {
    throw new Error("seat project aliases changed while preparing the project projection");
  }
}

/** The source read completed, but its evidence key moved again before the
 * alarm could use it. Keep the refreshed gap available to the controller so
 * canceling an unsent alarm does not erase a real source failure. */
export class SeatTickEvidenceRefreshCanceledError extends Error {
  constructor(readonly pullRequestGap: SeatTickSourceGap | null) {
    super("Seat alarm sources changed while refreshing pull-request evidence; retry on the next tick");
    this.name = "SeatTickEvidenceRefreshCanceledError";
  }
}

// Weak keys retain only source versions while the shared frozen row is alive.
// Mutable test/adaptor rows are still hashed from their current contents.
const evidenceHashHost = globalThis as typeof globalThis & {
  __llvSeatTickEvidenceHashes?: WeakMap<Pipeline, string>;
  __llvSeatTickDeepFrozen?: WeakSet<object>;
  __llvSeatTickEvidenceVersion?: number;
};
function deeplyFrozen(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  const cache = evidenceHashHost.__llvSeatTickDeepFrozen ??= new WeakSet();
  if (cache.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  for (const child of Object.values(value)) if (!deeplyFrozen(child)) return false;
  cache.add(value);
  return true;
}

function laneEvidenceHash(lane: Pipeline): string {
  const cache = evidenceHashHost.__llvSeatTickEvidenceHashes ??= new WeakMap<Pipeline, string>();
  const held = cache.get(lane);
  if (held) return held;
  const frozen = deeplyFrozen(lane);
  if (frozen) {
    /* Immutable row identity is its content version. Stringifying the full
       spec here would block before the cooperative evidence pass can answer. */
    const version = `immutable:${evidenceHashHost.__llvSeatTickEvidenceVersion = (evidenceHashHost.__llvSeatTickEvidenceVersion ?? 0) + 1}`;
    cache.set(lane, version);
    return version;
  }
  const hash = crypto.createHash("sha256").update(JSON.stringify(lane)).digest("hex");
  return hash;
}

async function pullRequestEvidenceKey(input: Pick<SeatTickCheckInput, "project" | "now" | "settings" | "seat" | "state">, sources: SeatTickSources): Promise<string> {
  return withViewerOperation("seat-tick.check", async () => {
    const seatIdentity = () => {
      const seat = sources.seatFor(input.project).active;
      return JSON.stringify([seat?.conversationId, seat?.seatEpoch]);
    };
    const seat = seatIdentity();
    const now = sources.now(), settings = effectiveSeatTickSettings(sources.settings(input.project), now, SEAT_TICK_WAKE_INTERVAL_MS);
    if (seatIdentity() !== seat || settings.enabled !== input.settings.enabled || settings.wakeIntervalMs !== input.settings.wakeIntervalMs
      || seatTickWakeDue(input.state.lastWakeAt, now, settings.wakeIntervalMs) !== seatTickWakeDue(input.state.lastWakeAt, input.now, input.settings.wakeIntervalMs)) {
      throw new SeatTickEvidenceRefreshCanceledError(input.state.pullRequestGap);
    }
    return crypto.createHash("sha256").update(JSON.stringify([
      input.settings.enabled,
      seatTickWakeDue(input.state.lastWakeAt, input.now, input.settings.wakeIntervalMs),
      input.settings.wakeIntervalMs,
      input.seat ? seatTurnProgressing(input.seat) : null,
      seat,
    ])).digest("hex");
  });
}

/** PR evidence is one observation per eligible check, with lane associations
 * captured by that read. Local agenda refreshes must not invalidate it as lanes
 * advance. Changed eligibility still asks the newly enabled question, and a
 * second eligibility change keeps the alarm unsent. The next check reads PRs
 * again; delivery credits only the outcomes its frozen payload actually names.
 */
export async function refreshSeatTickEvidence(input: SeatTickCheckInput, sources: SeatTickSources): Promise<SeatTickCheckInput> {
  let fresh = await refreshSeatTickInputCooperatively(input, sources);
  const key = await pullRequestEvidenceKey(fresh, sources);
  fresh = await refreshSeatTickInputCooperatively(fresh, sources);
  const currentlyOwned = () => {
    const canonicalProject = seatProjectResolver();
    const currentLanes = [...sources.pipelines(), ...sources.archivedPipelines()]
      .filter(lane => canonicalProject(lane.project) === fresh.project && !lane.hiddenAt);
    return new Set(currentLanes.filter((lane) => lane.merge
      && (PIPELINE_MERGE_LIVE_STATES.has(lane.merge.state) || lane.merge.state === "refreshing"
        || (lane.merge.state === "merged" && (lane.merge.reviewedHead === lane.lastPassedCommit
          || lane.merge.chain.includes(lane.lastPassedCommit) || lane.merge.mergedHead === lane.lastPassedCommit)))).map(lane => lane.id));
  };
  const excludeCurrentlyOwned = (value: SeatTickCheckInput): SeatTickCheckInput => {
    if (!value.pullRequests.length && !value.signals.some(signal => signal.id.startsWith("local-unmerged-lane:"))) return value;
    const owners = currentlyOwned();
    return {
      ...value,
      pullRequests: value.pullRequests.filter(pr => !owners.has(pr.pipelineId)),
      signals: value.signals.filter(signal => !signal.id.startsWith("local-unmerged-lane:")
        || !owners.has(signal.id.slice("local-unmerged-lane:".length))),
    };
  };
  if (key === input.pullRequestEvidenceKey) return excludeCurrentlyOwned(fresh);
  const evidence = await unmergedPullRequests({
    project: fresh.project, seat: fresh.seat,
    wakeDue: seatTickWakeDue(fresh.state.lastWakeAt, fresh.now, fresh.settings.wakeIntervalMs),
    enabled: fresh.settings.enabled, now: fresh.now, wakeIntervalMs: fresh.settings.wakeIntervalMs,
    gap: fresh.state.pullRequestGap, localScanCursor: fresh.state.localFinishedLaneCursor ?? null, sources,
  });
  fresh = await refreshSeatTickInputCooperatively(fresh, sources);
  fresh = await refreshSeatTickInputCooperatively({ ...fresh,
    pullRequestsUnavailable: evidence.unavailable, pullRequestEvidenceKey: key,
    pullRequestsObserved: evidence.observed,
    signals: [...fresh.signals.filter((signal) => !signal.id.startsWith("local-unmerged-lane:")), ...evidence.localPending],
    pullRequests: evidence.pullRequests,
    state: { ...fresh.state, pullRequestGap: evidence.gap, localFinishedLaneCursor: evidence.localScanCursor } }, sources);
  if (await pullRequestEvidenceKey(fresh, sources) !== key) throw new SeatTickEvidenceRefreshCanceledError(fresh.state.pullRequestGap);
  fresh = await refreshSeatTickInputCooperatively(fresh, sources);
  return excludeCurrentlyOwned(fresh);
}

/** The opening check needs only a priority hint, without PR, report or
 * pipeline preparation. The full observation is made after wake settlement. */
export async function seatTickDeployPending(project: string, state: SeatTickProjectState,
  policy: SeatTickPolicy, sources: SeatTickSources): Promise<boolean> {
  const active = sources.seatFor(project).active;
  if (!active?.conversationId) return false;
  const seat: SeatTickSeatInput = { ...active, conversationId: active.conversationId,
    turn: "unknown", activity: null, mandateCarriesTickContract: orchestratorMandateCarriesTickContract(active) };
  return (await settledSeatDeploys(seat, state.announcedDeploys ?? [],
    { now: sources.now(), backlogAfterMs: policy.backlogAfterMs }, sources)).length > 0;
}

/** A deployment is a durable obligation independent of PR/history evidence.
 * Keep its delivery on the normal authority, admission and accounting path. */
export async function gatherSeatTickDeployInput(project: string, state: SeatTickProjectState,
  policy: SeatTickPolicy, sources: SeatTickSources, reports?: SeatTickReportsInput | null): Promise<SeatTickCheckInput | null> {
  const active = sources.seatFor(project).active;
  if (!active?.conversationId) return null;
  const now = sources.now();
  const identity: SeatTickSeatInput = { ...active, conversationId: active.conversationId,
    turn: "unknown", activity: null, mandateCarriesTickContract: orchestratorMandateCarriesTickContract(active) };
  const settledDeploys = await settledSeatDeploys(identity, state.announcedDeploys ?? [],
    { now, backlogAfterMs: policy.backlogAfterMs }, sources);
  if (!settledDeploys.length) return null;
  const seat = await seatInput(project, policy, sources);
  if (!seat || seat.conversationId !== identity.conversationId || seat.seatEpoch !== identity.seatEpoch) return null;
  /* Reports enrich a deploy wake, but they share a serial worker with unrelated
     projects. Accept a fast read and fall back immediately when that worker is
     occupied, so optional evidence cannot consume the settlement deadline. */
  const observedReports = reports === undefined ? await deployWakeReportsInput(project, sources) : reports ?? undefined;
  assertSeatTickWork();
  const current = sources.seatFor(project).active;
  if (current?.conversationId !== seat.conversationId || current?.seatEpoch !== seat.seatEpoch) return null;
  const settings = effectiveSeatTickSettings(sources.settings(project), sources.now(), SEAT_TICK_WAKE_INTERVAL_MS);
  const paused = projectRows(sources.pipelines(), project).filter(lane => isOpen(lane) && lane.state === "paused");
  const pauses = pauseInputs(paused, seat, sources, sources.now());
  const pipelines: SeatTickPipelineInput[] = [];
  await forEachCooperatively(paused, lane => {
    const evidence = evidenceFromPipelines([{ id: lane.id, task: lane.task, project: lane.project,
      state: lane.state, createdAt: lane.createdAt, closedAt: lane.closedAt, activityAt: [] }])[0]!;
    pipelines.push({ id: lane.id, title: evidence.title, state: evidence.state, updatedAt: lane.pausedAt ?? lane.createdAt,
      stageActivity: null, stageId: lane.cursor?.stageId ?? null, ...pauses.get(lane.id) });
  }, { batchSize: 4, timeBudgetMs: 8 });
  return { project, now: sources.now(), seat, state, policy, settings,
    pipelines, tasks: [], events: [], children: [], childrenUnavailable: null,
    ownLanes: [], pullRequests: [], pullRequestsUnavailable: null, pullRequestsObserved: false,
    signals: [], settledDeploys, deploySettlementWakeDue: true, ...(observedReports ? { reports: observedReports } : {}),
    changeFingerprint: seatTickFingerprint(pipelines, [], [], [], null, [], settledDeploys, []),
    digestFingerprint: state.checkFingerprint ?? undefined,
  };
}

export async function gatherSeatTickInput(
  project: string,
  state: SeatTickProjectState,
  policy: SeatTickPolicy,
  sources: SeatTickSources,
): Promise<SeatTickCheckInput> {
  return withViewerOperation("seat-tick.check", () => performanceSpans.wait("seat-tick.check", async () => {
    await sources.prepareRead?.();
    return gatherSeatTickInputWork(project, state, policy, sources);
  }));
}

async function gatherSeatTickInputWork(
  project: string,
  state: SeatTickProjectState,
  policy: SeatTickPolicy,
  sources: SeatTickSources,
): Promise<SeatTickCheckInput> {
  let canonicalProject = seatProjectResolver();
  const now = sources.now();
  const canonical = canonicalProject(project);
  const settings = effectiveSeatTickSettings(sources.settings(canonical), now, SEAT_TICK_WAKE_INTERVAL_MS);
  const seat = await seatInput(canonical, policy, sources);

  const catchUp = !!seatTickCatchUp({ state, now, settings, seat });
  canonicalProject = seatProjectResolver();
  const hotLanes = performanceSpans.sync("seat-tick.project", sources.pipelines);
  const hotTasks = sources.tasks();
  await prepareSeatTickProjection(sources, canonical, hotLanes, hotTasks);
  const { lanes: openLanes, tasks: openTasks } = performanceSpans.sync("seat-tick.project",
    () => openTickLanes(projectRows(hotLanes, canonical), canonical, canonicalProject), hotLanes.length);
  const evidence = performanceSpans.sync("seat-tick.project", () => openLanes.map(pipelineEvidence), openLanes.length);
  const observedStages = new Map(openLanes.map((lane) => {
    const attempt = stageAttempt(lane);
    return [lane.id, { stageId: lane.cursor?.stageId ?? null, attempt: stageAttemptIdentity(lane),
      number: attempt?.n ?? null, conversationId: attempt?.conversationId ?? null }] as const;
  }));
  const activity = openLanes.length > 0 ? await laneActivity(canonical, policy, sources, observedStages) : new Map<string, SeatTickActivity>();
  const pauses = pauseInputs(openLanes, seat, sources, now);
  const pipelines: SeatTickPipelineInput[] = openLanes.map((pipeline, index) => ({
    id: pipeline.id,
    title: evidence[index]!.title,
    state: evidence[index]!.state,
    updatedAt: evidence[index]!.updatedAt,
    stageActivity: activity.get(pipeline.id) ?? null,
    stageId: observedStages.get(pipeline.id)!.stageId,
    stageState: pipeline.cursor?.state ?? null,
    stageAttemptState: stageAttempt(pipeline)?.state ?? null,
    stageAttempt: observedStages.get(pipeline.id)!.attempt,
    ...pauses.get(pipeline.id),
  }));

  /* Pipeline membership is the read model the board itself uses, so "owned"
     means the same thing here as it does on the card. */
  canonicalProject = seatProjectResolver();
  const sourceById = performanceSpans.sync("seat-tick.project", () => new Map(projectRows(hotTasks, canonical).map(task => [task.id, task] as const)), hotTasks.length);
  const board = performanceSpans.sync("seat-tick.project", () => seatTaskPipelineIds(projectRows(hotTasks, canonical), hotLanes));
  const taskEvidence = performanceSpans.sync("seat-tick.project", () => board.map(task => taskEvidenceFor(sourceById.get(task.id) ?? task, task.pipelineIds)), board.length);
  const linked = board.some((task) => task.machine) ? linkedContext() : null;
  const tasks: SeatTickTaskInput[] = board.map((task, index) => ({
    id: task.id,
    title: taskEvidence[index]!.title,
    status: task.status,
    owned: task.chosen === true ? openTasks.has(task.id) : taskEvidence[index]!.owner !== null,
    updatedAt: task.updatedAt ?? null, dueAt: task.dueAt,
    accepted: task.chosen === true, hold: task.hold, waitingSince: task.statusBy?.at ?? task.createdAt ?? task.updatedAt,
    /* The guard is the guarantee; this only saves wakes (M.4). */
    ...(linked && !runsHere(task, linked) ? { runsOn: machineLabel(task.machine!, linked).label } : {}),
  }));

  const announcedLanes = retainedLaneAnnouncements(state.announcedLanes ?? [], projectRows(hotLanes, canonical), canonical, seat, now, policy.backlogAfterMs);
  const ownLanes = performanceSpans.sync("seat-tick.project",
    () => ownSettledLanes(canonical, seat, announcedLanes, projectRows(hotLanes, canonical), catchUp), hotLanes.length);
  const settledDeploys = await settledSeatDeploys(seat, state.announcedDeploys ?? [], { now, backlogAfterMs: policy.backlogAfterMs, catchUp }, sources);
  let endedMaintenance: readonly MaintenanceRun[] = [];
  try { endedMaintenance = sources.maintenanceRuns?.(canonical) ?? []; }
  catch { /* The maintenance controller journals its own store failure; unrelated seat work still wakes. */ }
  const settledMaintenance = endedMaintenance.filter(run => !maintenanceRunIsLive(run) && run.endedAt && now - Date.parse(run.endedAt) <= policy.backlogAfterMs && !(state.announcedMaintenance ?? []).includes(run.runId)).slice(catchUp ? 0 : -3);
  const releaseAlerts: NonNullable<SeatTickCheckInput["releaseAlerts"]> = [];
  try {
    const release = readReleaseProject(canonical);
    for (const run of release.history) if (now - run.at <= policy.backlogAfterMs) releaseAlerts.push({ kind: "release-settled", id: `release-settled:${run.key}:${run.at}`, label: `Release ${run.outcome}; task ${run.taskId}, lane ${run.pipelineId}. Read its stage summaries for any product defect seen in the README pictures.` });
    if (release.blocked && now - release.blocked.since >= 24 * 3_600_000) releaseAlerts.push({ kind: "release-blocked", id: `release-blocked:${release.blocked.episode}`, label: `A due release has waited 24 hours: ${release.observation?.reason ?? "unreadable blocker"}. Read seat_tick_settings release status.` });
  } catch { /* The release controller journals store failures; other seat work still wakes. */ }


  /* The open set spans EVERY project, not this one's lanes: an event is history
     because its own lane finished, and reading a lane from another project as
     terminal because it is not in this project's slice would be the same claim
     made about the wrong pipeline. */
  const openPipelineIds = openSeatPipelineIds(hotLanes);
  /* The projection writes stage, verdict and deploy events into the journal;
     nothing else runs it on a schedule, so the tick runs it before it reads. */
  try {
    sources.refreshLifecycle?.(hotLanes);
  } catch (error) {
    console.error("[seat tick] lifecycle projection failed", error instanceof Error ? error.name : "unknown");
  }
  const { events, cursor } = eventsSince(canonical, state.eventsThrough, openPipelineIds, hotLanes, sources, catchUp);
  await yieldToRuntime();
  const { children, unavailable: childrenUnavailable, catchUpPending: childrenCatchUpPending } = await withViewerOperation("seat-tick.children", () => childWork(canonical, seat, state, policy, sources));
  /* An unreadable board costs this check its routed asks, never the check:
     the waits stay routed and the next check reads them again. */
  let workerAsks: readonly SeatTickWorkerAskInput[] = [];
  if (seat && settings.enabled && sources.workerAsks) {
    try { workerAsks = await sources.workerAsks(canonical); }
    catch (error) { console.error("[seat tick] routed asks unavailable", error instanceof Error ? error.name : "unknown"); }
  }
  /* The children source's run of failures (#1465), kept exactly as the
     pull-request source's: advanced by a check that could not account for
     every child, cleared by one that could, and reported once by the decision
     when it has outlived the wake interval. A project with no seat asked
     nothing, and leaves the run as it stands. */
  const childrenGap = !seat ? state.childrenGap
    : childrenUnavailable ? seatTickSourceGapAfterFailure(state.childrenGap, childrenUnavailable, new Date(now).toISOString()) : null;
  const harvestedChildren = state.harvestedChildren;
  await yieldToRuntime();
  const pullRequestEvidenceKeyAtRead = await pullRequestEvidenceKey({ project: canonical, now, settings, seat, state }, sources);
  const { pullRequests, localPending, localScanCursor, observed: pullRequestsObserved, unavailable: pullRequestsUnavailable, gap: pullRequestGap } = await unmergedPullRequests({
    project: canonical,
    seat,
    /* The same clause the decision applies, asked here because the read behind
       it is a subprocess: a reason that cannot be raised this check is a reason
       whose evidence is not worth fetching. The decision applies the bound
       again on its own terms — this is a cost gate, never the bound itself. */
    wakeDue: seatTickWakeDue(state.lastWakeAt, now, settings.wakeIntervalMs),
    enabled: settings.enabled,
    now,
    wakeIntervalMs: settings.wakeIntervalMs,
    gap: state.pullRequestGap,
    localScanCursor: state.localFinishedLaneCursor ?? null,
    sources,
  });

  await yieldToRuntime();
  const gathered: SeatTickCheckInput = {
    project: canonical,
    now,
    seat,
    workers: { ...(() => {
      const limit = effectiveWorkerLimit(canonical);
      return { limit: limit.value, source: limit.source, machine: limit.machine };
    })(), running: sources.workerCounts?.().byProject.get(canonical) ?? 0 },
    ...(seat ? {} : { seatEverHeld: sources.seatEverHeld?.(canonical) ?? true }),
    pipelines,
    tasks,
    overdueTasks: overdueTaskInputs(sources, canonical, now, openTasks, state.itemsShown ?? []),
    ...(workerAsks.length ? { workerAsks } : {}),
    events,
    pullRequests,
    pullRequestsUnavailable,
    pullRequestsObserved,
    pullRequestEvidenceKey: pullRequestEvidenceKeyAtRead,
    signals: [...signals(canonical, seat, sources), ...(localPending ?? []), ...(sources.memoryProblems?.(canonical, state.itemsShown ?? [], seat?.conversationId ? seat : null) ?? []), ...await diskPressureSignals(sources)],
    ownLanes,
    settledDeploys,
    settledMaintenance,
    releaseAlerts,
    children,
    childrenUnavailable,
    childrenCatchUpPending,
    changeFingerprint: seatTickFingerprint(pipelines, tasks, children, pullRequests, pullRequestsUnavailable, ownLanes, settledDeploys, settledMaintenance),
    digestFingerprint: changeFingerprint(pipelines, tasks, children, pullRequests, pullRequestsUnavailable, ownLanes, settledDeploys, settledMaintenance, "digest", pullRequestsObserved),
    /* The sealed cursor travels on the state the decision carries forward, so a
       check of any verdict — a skip included, which remembers nothing else —
       persists where the journal stood when the tick first saw this project.
       The source's run of failures rides out the same way (#1298): the gather
       is what attempted the read, so the gather is what records what became of
       it, and the decision reads that row to know whether this is the outage
       worth putting on the board. */
    state: { ...state, announcedLanes, eventsThrough: cursor, pullRequestGap, localFinishedLaneCursor: localScanCursor, childrenGap, harvestedChildren, accounting: state.accounting ? guardedSeatTickPort(new SeatTickAccounting(state.accounting.filename, canonical), "accounting.sources").readState().accounting : undefined },
    policy,
    settings,
    ...await (async () => {
      const reports = await reportsInput(canonical, sources);
      return reports ? { reports } : {};
    })(),
  };
  if (Object.isFrozen(hotLanes) && Object.isFrozen(hotTasks)
    && samePipelineSource(sources.pipelines(), hotLanes) && sameTaskSource(sources.tasks(), hotTasks)) {
    seatTickRefreshCache.set(gathered, {
      pipelinesSource: hotLanes, tasksSource: hotTasks, project: canonical,
      seatKey: seatInputKey(seat),
      announcedKey: announcedLaneKey(gathered.state, seatTickCatchUp(gathered)?.key ?? null),
      aliasesKey: `${projectRowsAliasKey(hotLanes)}\0${projectRowsAliasKey(hotTasks)}`, pipelines, tasks, ownLanes,
      linkedKey: linked ? JSON.stringify(linked) : null,
      openIds: openPipelineIds, openTasks,
      pipelineById: new Map(pipelines.map(pipeline => [pipeline.id, pipeline])),
      pausedLanes: hotLanes.filter(pipeline => pipeline.state === "paused" && canonicalProject(pipeline.project) === canonical),
      children: gathered.children, pullRequests: gathered.pullRequests,
      pullRequestsUnavailable: gathered.pullRequestsUnavailable, settledDeploys: gathered.settledDeploys,
      settledMaintenance: gathered.settledMaintenance, fingerprint: gathered.changeFingerprint,
    });
  }
  return gathered;
}
