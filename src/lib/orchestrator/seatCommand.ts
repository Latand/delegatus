import type { NextRequest } from "next/server";
import fs from "node:fs";

import { ACCOUNT_MUTATION_WAIT_MS, ACCOUNT_STORE_BUSY_MESSAGE, AccountAdmissionChangedError, AccountMutationBusyError, isAccountAdmissionRetryable, withAccountMutationLock, withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
import {
  ENGINE_NOT_CONNECTED,
  engineNotConnectedDetails,
  engineNotConnectedMessage,
  engineReadiness,
  type EngineName,
  type EngineReadiness,
} from "@/lib/accounts/engineConnection";
import { validExplicitProject } from "@/lib/accounts/migration/contracts";
import { agentRegistry, identityMaterializationFence } from "@/lib/agent/registry";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { defaultModelFor, normalizeClaudeLaunchModel } from "@/lib/agent/models";
import { internalServiceHeaders, rotationActor, type ViewerActor } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { deliverConversationMessage } from "@/lib/delivery";
import { structuredHostsEnabled } from "@/lib/runtime/flags";
import { canonicalProject } from "@/lib/projects/aliases";
import { projectCurationSnapshot } from "@/lib/projects/curation";
import { projectSuccessionFor, recordProjectSuccessions } from "@/lib/projects/succession";
import { projectForCwd } from "@/lib/scanner/describe";
import { projectDirectoryFallbacks } from "@/lib/scanner/projectDirectories";
import { pathAllowed } from "@/lib/scanner/roots";
import { hasUserAuthoredMessage } from "@/lib/session/reader";
import { resolveSpawnRole } from "@/lib/roles/registry";
import { mappingRowRefusal, type LaunchRuntime } from "@/lib/roles/sizing";
import { loadRoleDefinitionsOrDefaults } from "@/lib/roles/store";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";
import { derivedSpawnTitle } from "@/lib/title";
import { telegramSetUp } from "@/lib/telegram/launchReadiness";
import { activeDrain } from "@/lib/selfUpdate/drain";
import { launchHoldRefusal } from "@/lib/selfUpdate/launchHold";

import {
  boundHistoryBody,
  composeSuccessorMandate,
  fallbackHistory,
  HANDOFF_BOARD_REPORT_POINTER,
  launchOverheadBytes,
  mandatePreflight,
  mandateTooLargeBody,
  splitMandate,
  summarizeHandoffsHeadless,
  type HandoffDigestOutcome,
  type HandoffDigestRequest,
  type HandoffParts,
} from "./handoffDigest";
import {
  ORCHESTRATOR_PROMPT_VERSION,
  ORCHESTRATOR_SYSTEM_PROMPT,
  orchestratorMandateForDelivery,
  orchestratorMandateStale,
  orchestratorMandateWithRoleTable,
  orchestratorRoleTable,
} from "./prompt";
import {
  abandonStillbornOrchestratorSeat,
  activeOrchestratorSeats,
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  confirmOrchestratorSeatMaterialization,
  failOrchestratorSeatIntent,
  canonicalOrchestratorProject,
  orchestratorRevocations,
  orchestratorSeatFor,
  repairOrchestratorSeatRuntimeIdentity,
  recordOrchestratorSeatAuthCredentialBaseline,
  type OrchestratorSeat,
  type OrchestratorSeatTerminalization,
  type StillbornSeatRollback,
  type OrchestratorSeatTrigger,
} from "./seats";

/* The one confirm behind the board draft's Orchestrator role: DESIGNATE this
 * project's orchestrator and INJECT the operator-edited mandate, atomically.
 *
 * "Atomically" here is the durable-intent shape, because delivery cannot always
 * settle synchronously (a structured spawn is accepted 202 and launches
 * deferred). The order is:
 *
 *  1. persist the PENDING intent (grants nothing, delivers nothing);
 *  2. run the one side effect that carries the mandate — a spawn whose first
 *     prompt IS the mandate (the durable launch receipt delivers it exactly
 *     once, replayed by `clientAttemptId`), or a message delivery to the
 *     selected EXISTING conversation (deduplicated by `clientMessageId`);
 *  3. ACTIVATE the seat in one write that also revokes a differing
 *     predecessor.
 *
 * A crash at any point leaves either nothing (intent pending, nothing
 * delivered) or a completed pair; the retry replays the same
 * `clientRequestId` through every layer and completes exactly once. A
 * designation with no delivered mandate, or a delivered mandate with no
 * designation, cannot survive a retry.
 *
 * An intent that recorded an error is the exception, and deliberately so
 * (issue #1067): it is TERMINAL, so the next begin clears it into durable
 * history and composes afresh rather than replaying the mandate that failed —
 * which is why no failed designation stays pending. Exactly-once still holds
 * there, because both delivery mechanisms above key on the request id itself.
 *
 * Selecting an existing conversation never spawns: mode is decided by the
 * presence of `conversationId`, and the delivery path reuses the composer's
 * own resume machinery, so a dead selected session is revived rather than
 * duplicated.
 */

/** Trusted in-process restrictions; request JSON cannot supply admission. */
export interface SeatLaunchAdmission {
  autonomous?: boolean;
  assertAccount?(accountId: string): void;
}

export interface SeatCommandDependencies {
  /** POST /api/spawn in-process, on the operator's own authority. */
  spawn(body: Record<string, unknown>, autonomous?: boolean, admission?: SeatLaunchAdmission): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Deliver the mandate to an existing conversation, idempotent on
      `clientMessageId`. */
  deliver(input: { conversationId: string; path: string | null; clientMessageId: string; text: string }): Promise<{ ok: boolean; error?: string; outcome?: string }>;
  /** Registry-backed eligibility of a conversation offered for adoption. */
  conversationTarget(conversationId: string): ExistingConversationTarget | null;
  /** Start the board maintenance report for a seat epoch that just became
      active (docs/design/board-maintenance-report.md §5.1), and return at
      once: the report is never awaited, and nothing it does reaches the seat
      command. Absent starts nothing, which is how a harness that does not
      model it stays exactly as it was. */
  startBoardReport?(seat: { project: string; seatEpoch: number; conversationId: string; path: string | null }): void;
  /** Compact the predecessor's prior handoffs into ONE bounded history
      section. Never blocks rotation: every unhappy path — no account, timeout,
      error, empty or over-budget output — answers `fallback` with its reason,
      and a thrown error is treated the same way. */
  summarizeHandoffs(request: HandoffDigestRequest): Promise<HandoffDigestOutcome>;
  /** Durable outcome of the spawn a pending intent's request attempted, read
      from the launch receipt, for reconciling an accepted launch whose
      accepting request died before activation. */
  launchSettlement(input: { launchId: string | null; clientRequestId: string }): LaunchSettlement;
  /** How long a designation queues for the account store; `SEAT_STORE_WAIT_MS`
      when absent. A seam for tests that hold the store past the bound. */
  seatStoreWaitMs?: number;
  /** Persist the active seat's role, membership, and rotation lineage. */
  stampRegistryIdentity(seat: OrchestratorSeat): void;
  /** Durable runtime identity for legacy seats that predate engine/model. */
  runtimeIdentity(conversationId: string): { engine: string | null; model: string | null };
  /** WHAT THE VIEWER CAN RESOLVE about a conversation, asked exactly the way
      the tools that read one ask it (#1757): a registry row, and a transcript
      generation under a scanner root.

      Deliberately NOT {@link SeatCommandDependencies.conversationTarget}, whose
      eligibility also requires the launch cwd to exist on disk and to resolve
      to a project. `get_conversation` and `conversation_messages` never look at
      a cwd, so an orchestrator whose worktree was deleted while it ran is
      perfectly readable — and judging it by the stricter bar would drop a live
      predecessor out of a handover, which is the same harm the issue is about.
      The cwd travels here for the checkout a rotation inherits, and its absence
      is never a reason to call a transcript unreadable.

      `holdsTurns` is the extra question only the handover asks, answered by a
      bounded scan that stops at the first turn rather than parsing a transcript
      that may be the longest-lived on the machine. */
  resolvedConversation(conversationId: string): ResolvedConversation | null;
  /** Whether the seat's engine can launch here (#1876): its command resolves
      and an account is signed in. Absent answers "connected", which leaves the
      launch's own refusal as the only check. */
  engineReadiness?(engine: EngineName, project: string): EngineReadiness;
  /** The folder this project was recorded at — the root "Create project"
      stored, else one the local state knows — when it exists on disk. */
  projectRoot?(project: string): string | null;
  now(): string;
}

/** One conversation as the Viewer can actually resolve it (#1757). */
export interface ResolvedConversation {
  conversationId: string;
  /** The transcript generation `conversation_messages` would page. */
  path: string;
  /** Whether that transcript records at least one turn to hand over. */
  holdsTurns: boolean;
  /** The launch checkout, when it is still on disk; null is not a defect. */
  cwd: string | null;
}

export type LaunchSettlement =
  /** The launch durably produced a conversation; the intent can activate on it. */
  | {
      kind: "settled";
      conversationId: string;
      path: string | null;
      launchId: string | null;
      engine?: string | null;
      model?: string | null;
    }
  /** The launch terminally failed; the intent can record the error. */
  | { kind: "failed"; error: string }
  /** No settled receipt to reconcile against — leave the intent alone. */
  | { kind: "unknown" };

export type ExistingConversationTarget =
  | {
      kind: "eligible";
      conversationId: string;
      path: string;
      cwd: string;
      project: string;
      /* The handoff summarizer parses the predecessor's transcript tail, and
         the two engines write different row shapes, so the engine is narrow
         and always present here. */
      engine: "claude" | "codex";
      model?: string | null;
    }
  | { kind: "ineligible"; code: "conversation_ineligible" | "invalid_cwd" | "missing_transcript" | "missing_project"; error: string };

function usableDirectory(candidate: string | undefined | null): candidate is string {
  if (!candidate) return false;
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}

/** The root a project was recorded at, found the way the files feed finds a
    project's folder: the root "Create project" stored for it, then the
    project directories the local state knows (#2167). A project created
    seconds ago has no conversation yet, so this is the only place its folder
    is written down. */
export function recordedProjectRoot(project: string): string | null {
  const created = projectCurationSnapshot().manualProjects
    .find((entry) => entry.project === project || canonicalProject(entry.project) === project);
  if (usableDirectory(created?.root)) return created.root;
  const known = projectDirectoryFallbacks([project])[project];
  return usableDirectory(known) ? known : null;
}

/** Issue #903: the spawn fallback must never be this server process's own
    working directory — in the deployed container that is `/app`, a path
    outside every scanner root, so the successor's transcript lands where the
    Viewer cannot see it and the seat holds its authority while permanently
    inert. With no explicit cwd and no operator override, the project's own
    newest existing checkout, then the folder the project was recorded at, are
    the only honest defaults; failing the call beats minting a dead seat. */
function resolveOrchestratorCwd(project: string, requested: unknown, dependencies: SeatCommandDependencies): string | null {
  if (typeof requested === "string" && requested.trim()) return requested.trim();
  const override = process.env.LLV_ORCHESTRATOR_CWD?.trim();
  if (override) return override;
  const conversations = Object.values(agentRegistry().readOnlySnapshot().conversations)
    .filter((conversation) => conversation.projectOwnership?.project === project
      || conversation.generations.some((generation) => generation.launchProfile?.project === project))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  for (const conversation of conversations) {
    for (let index = conversation.generations.length - 1; index >= 0; index -= 1) {
      const candidate = conversation.generations[index]?.launchProfile?.cwd;
      if (usableDirectory(candidate)) return candidate;
    }
  }
  return dependencies.projectRoot?.(project) ?? null;
}

async function postSpawnInProcess(body: Record<string, unknown>, autonomous = false, admission?: SeatLaunchAdmission): Promise<{ status: number; body: Record<string, unknown> }> {
  const { executeSpawnRequest, productionSpawnCommandDependencies } = await import("@/lib/agent/spawnCommand");
  /* An in-process call the VIEWER makes, on its own authority: the designation
     surfaces have already made their authority decision — the seat route by
     refusing an agent, the rotation route by naming one (#1402) — so this
     presents the operator spawn capability either way, the same lane the MCP
     server's spawn_agent uses. Who triggered the designation travels on the
     seat record; its autonomous admission restriction is rechecked under the
     spawn command's account lock. Only `headers` and `json` are read there. */
  const request = {
    headers: new Headers({
      host: "127.0.0.1",
      ...internalServiceHeaders("orchestrator"),
      [VIEWER_SPAWN_CAPABILITY_HEADER]: ensureOperatorSpawnCapability(),
    }),
    json: async () => body,
  } as unknown as NextRequest;
  const response = await executeSpawnRequest(request, { ...productionSpawnCommandDependencies,
    autonomousAdmissionHeld: () => autonomous && !!activeDrain(),
    assertAccountAdmission: admission?.assertAccount });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function deliverMandateInProcess(input: { conversationId: string; path: string | null; clientMessageId: string; text: string }): Promise<{ ok: boolean; error?: string; outcome?: string }> {
  if (structuredHostsEnabled()) {
    const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
    const structured = await enqueueStructuredMessage({
      path: input.path ?? "",
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      text: input.text,
      images: [],
    });
    if (structured) {
      return structured.ok
        ? { ok: true, outcome: "outcome" in structured && typeof structured.outcome === "string" ? structured.outcome : "delivered" }
        : { ok: false, error: structured.error };
    }
  }
  const outcome = await deliverConversationMessage({
    pid: null,
    path: input.path ?? "",
    conversationId: input.conversationId,
    clientMessageId: input.clientMessageId,
    text: input.text,
    images: [],
  });
  return outcome.ok
    ? { ok: true, outcome: outcome.outcome ?? "delivered" }
    : { ok: false, error: outcome.error };
}

export const productionSeatCommandDependencies: SeatCommandDependencies = {
  spawn: postSpawnInProcess,
  deliver: deliverMandateInProcess,
  conversationTarget: (conversationId) => {
    const conversation = agentRegistry().conversation(conversationId as `conversation_${string}`);
    if (!conversation) return null;
    if (conversation.supersededBy) {
      return { kind: "ineligible", code: "conversation_ineligible", error: "conversation is superseded" };
    }
    /* Copilot as an orchestrator seat is design slice 4. */
    if (conversation.engine === "copilot") {
      return { kind: "ineligible", code: "conversation_ineligible", error: "a Copilot conversation cannot hold the orchestrator seat yet" };
    }
    const generation = conversation.generations.at(-1);
    const transcriptPath = generation?.path?.trim();
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return { kind: "ineligible", code: "missing_transcript", error: "conversation transcript is unavailable" };
    }
    const cwd = generation?.launchProfile?.cwd?.trim();
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return { kind: "ineligible", code: "invalid_cwd", error: "conversation cwd is unavailable" };
    }
    const ownedProject = conversation.projectOwnership?.project ?? projectForCwd(cwd);
    if (!ownedProject) {
      return { kind: "ineligible", code: "missing_project", error: "conversation project is unavailable" };
    }
    return {
      kind: "eligible",
      conversationId: conversation.id,
      path: transcriptPath,
      cwd,
      project: canonicalOrchestratorProject(ownedProject),
      engine: conversation.engine,
      model: generation?.launchProfile.model?.trim() || defaultModelFor(conversation.engine),
    };
  },
  startBoardReport: (seat) => {
    void import("./boardReportRun").then(({ startBoardReport }) => startBoardReport(seat), (error: unknown) => {
      console.error("[board report] could not load", error instanceof Error ? error.name : "unknown");
    });
  },
  summarizeHandoffs: (request) => summarizeHandoffsHeadless(request),
  launchSettlement: ({ launchId, clientRequestId }) => {
    /* The seat spawn path always sends the intent's clientRequestId as the
       spawn clientAttemptId, so the durable receipt is found by it even when
       the intent never recorded a launchId before its request died. */
    const registry = agentRegistry();
    const receipt = registry.spawnReceiptForClientAttempt(clientRequestId);
    if (!receipt || (launchId && receipt.launchId !== launchId)) return { kind: "unknown" };
    if (receipt.rejection || receipt.state === "failed" || receipt.state === "conflicted") {
      return { kind: "failed", error: receipt.error ?? receipt.rejection?.guidance ?? `spawn receipt is terminally ${receipt.state}` };
    }
    /* An admitted receipt reserved its conversation at birth — the same
       durably-accepted evidence the synchronous 202 path activates on. */
    return {
      kind: "settled",
      conversationId: receipt.conversationId,
      path: identityMaterializationFence(registry.readOnlySnapshot()).allowsReceipt(receipt)
        ? receipt.artifactPath
        : null,
      launchId: receipt.launchId,
      engine: receipt.engine,
      model: receipt.launchProfile.model,
    };
  },
  resolvedConversation: (conversationId) => {
    if (!conversationId) return null;
    const conversation = agentRegistry().conversation(conversationId as `conversation_${string}`);
    if (!conversation) return null;
    const transcriptPath = conversation.generations.at(-1)?.path?.trim();
    /* `pathAllowed` resolves the real path before comparing it with the scanner
       roots, so a transcript that has been removed fails here too — the same
       two refusals `conversation_messages` answers with, and no others. */
    if (!transcriptPath || !pathAllowed(transcriptPath)) return null;
    const cwd = conversation.generations.at(-1)?.launchProfile?.cwd?.trim();
    return {
      conversationId: conversation.id,
      path: transcriptPath,
      holdsTurns: hasUserAuthoredMessage(transcriptPath, conversation.engine),
      cwd: cwd && isDirectory(cwd) ? cwd : null,
    };
  },
  runtimeIdentity: (conversationId) => {
    const conversation = agentRegistry().conversation(conversationId as `conversation_${string}`);
    const conversationModel = conversation
      ? conversation.generations.at(-1)?.launchProfile.model?.trim() || defaultModelFor(conversation.engine)
      : null;
    return {
      engine: conversation?.engine ?? null,
      model: conversationModel,
    };
  },
  stampRegistryIdentity: (seat) => {
    agentRegistry().stampOrchestratorSeatIdentity(seat);
  },
  engineReadiness: (engine, project) => engineReadiness(engine, project),
  projectRoot: recordedProjectRoot,
  now: () => new Date().toISOString(),
};

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** The seat a caller composed against is no longer the seated one, so its
    replacement would revoke an orchestrator it never read. */
function incumbentChangedResult(
  project: string,
  expectedSeatEpoch: number,
  current: OrchestratorSeat | null,
): SeatCommandResult {
  return {
    status: 409,
    body: {
      error: `the orchestrator seat for ${project} changed while this rotation composed its handoff (designation epoch ${expectedSeatEpoch} is no longer current); rotate again to hand off from the seated orchestrator`,
      code: "incumbent_changed",
      admission: "refused",
      currentSeatEpoch: current?.seatEpoch ?? null,
      currentConversationId: current?.conversationId ?? null,
    },
  };
}

export interface SeatCommandResult {
  status: number;
  body: Record<string, unknown>;
}

function agentSeatLaunchHold(project: string, clientRequestId: string, triggeredBy: OrchestratorSeatTrigger | null, autonomous = false): SeatCommandResult | null {
  const hold = autonomous || triggeredBy?.kind === "agent" ? activeDrain() : null;
  if (!hold) return null;
  // A pending replay may already have launched before its answer was lost.
  const replay = orchestratorSeatFor(project).pending?.intent.clientRequestId === clientRequestId;
  return { status: 409, body: { ...launchHoldRefusal(hold), ...(!replay ? { admission: "refused" } : {}) } };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function replayedSeatResponse(seat: OrchestratorSeat): SeatCommandResult {
  const accepted = seat.path === null && seat.intent.launchId !== null;
  return {
    status: 200,
    body: {
      ok: true,
      replayed: true,
      state: seat.path ? "settled" : accepted ? "accepted" : "starting",
      accepted,
      conversationId: seat.conversationId,
      path: seat.path,
      launchId: seat.intent.launchId,
      seat,
    },
  };
}

function inProgressSeatResponse(seat: OrchestratorSeat): SeatCommandResult {
  return {
    status: 409,
    body: {
      error: "an orchestrator seat transition is already in progress for this project",
      code: "seat_intent_in_progress",
      admission: "refused",
      seat,
    },
  };
}

/**
 * Activation epilogue shared by both modes: seat the conversation, revoke a
 * differing predecessor, and stamp the registry identity.
 *
 * AXIS SEPARATION (two-axis contract): revocation removes MANAGER-LEVEL
 * authority — manager voice and confirmation minting — and nothing else. The
 * predecessor's session, host and ordinary Viewer access are untouched; its
 * card stays on the board, linked to its successor by the durable lineage the
 * seat store records. Ordinary permissions are axis 1 and no seat operation
 * may reach them.
 */
async function activate(
  input: {
    project: string;
    clientRequestId: string;
    conversationId: string;
    path: string | null;
    launchId?: string | null;
    engine?: string | null;
    model?: string | null;
  },
  dependencies: SeatCommandDependencies,
): Promise<{ seat: OrchestratorSeat } | null> {
  let projectedSeat: OrchestratorSeat | null = null;
  /* Activation follows an await (the spawn, the delivery), so nothing here
     depends on staying synchronous, and by now a launch may already be running
     for this intent. It therefore queues for the lock instead of asking once:
     a writer that holds it for a few milliseconds must not cost the project
     the seat its launch was accepted for. */
  const completed = await withAccountMutationLockAsync(() => {
    const result = completeOrchestratorSeatIntent({
      project: input.project,
      clientRequestId: input.clientRequestId,
      conversationId: input.conversationId,
      path: input.path,
      launchId: input.launchId,
      engine: input.engine,
      model: input.model,
      now: dependencies.now(),
    });
    if (result.kind !== "missing") projectedSeat = reconcileAuthorityProjections(result.seat, dependencies);
    return result;
  }, { holder: "orchestrator seat activation", waitMs: dependencies.seatStoreWaitMs ?? SEAT_STORE_WAIT_MS });
  if (completed.kind === "missing") return null;
  const seat: OrchestratorSeat = projectedSeat ?? completed.seat;
  /* Once per new seat epoch — a fresh seat, an adopted conversation, a
     rotation — whatever produced it; the report's own claim makes a second
     activation of the same epoch a no-op. Never awaited, so the seat command
     answers exactly as fast as it did. */
  if (seat.state === "active" && seat.conversationId) {
    try {
      dependencies.startBoardReport?.({ project: seat.project, seatEpoch: seat.seatEpoch, conversationId: seat.conversationId, path: seat.path });
    } catch (error) {
      console.error("[board report] could not start", error instanceof Error ? error.name : "unknown");
    }
  }
  return { seat };
}

function reconcileAuthorityProjections(
  seat: OrchestratorSeat,
  dependencies: SeatCommandDependencies,
): OrchestratorSeat {
  if (!seat.conversationId) throw new Error("active orchestrator seat is missing its conversation identity");
  const durableRuntime = seat.engine && seat.model
    ? { engine: null, model: null }
    : dependencies.runtimeIdentity(seat.conversationId);
  const repaired = repairOrchestratorSeatRuntimeIdentity({
    project: seat.project,
    conversationId: seat.conversationId,
    engine: durableRuntime.engine,
    model: durableRuntime.model,
  }) ?? seat;
  dependencies.stampRegistryIdentity(repaired);
  return repaired;
}

function reconcileCompletedSeatReplay(
  project: string,
  clientRequestId: string,
  dependencies: SeatCommandDependencies,
): OrchestratorSeat | null {
  return withAccountMutationLock(() => {
    const seat = orchestratorSeatFor(project).active;
    if (!seat || seat.intent.clientRequestId !== clientRequestId) return null;
    return reconcileAuthorityProjections(seat, dependencies);
  });
}

/**
 * Reconcile the ACTIVE seat against the durable settlement of the launch it was
 * activated on (issue #1757).
 *
 * A seat activated on a durably ACCEPTED spawn is provisional: the conversation
 * id is reserved, the transcript does not exist yet, and `get_conversation`
 * answers «not found» until the launch materializes it. The pending intent had
 * a reconciler for exactly this window; the active seat had none, so a launch
 * that died after activation left the project seated on a conversation nobody
 * could read or reach, and the only record of the failure was a runtime host
 * timeout in a container log.
 *
 * Three outcomes, and each one ENDS the provisional state:
 *  - the launch produced a readable conversation → confirm it, drop the
 *    rollback, record the transcript path;
 *  - the launch terminally failed → roll the seat back: revoke the stillborn
 *    conversation, restore the predecessor it superseded, and terminalize the
 *    attempt into `intentHistory` with its reason;
 *  - the launch has not settled → leave it alone; an in-flight launch is not a
 *    failed one.
 *
 * Synchronous, like its pending sibling, so a request reaches its durable begin
 * with no await point in between.
 */
function reconcileActiveSeatLaunch(
  project: string,
  dependencies: SeatCommandDependencies,
): StillbornSeatRollback | null {
  const active = orchestratorSeatFor(project).active;
  if (!active?.conversationId || active.intent.mode !== "spawn" || active.path !== null) return null;
  /* READABLE OUTRANKS EVERY RECEIPT. An admitted receipt names a conversation
     long before a transcript exists under it, and a receipt can read terminal
     while the conversation it launched is alive and answering. So the question
     asked first is the one the operator would ask: can the Viewer resolve this
     conversation? If it can, the seat is real — confirmed, never rolled back.
     Asked through the resolution seam rather than adoption eligibility: a live
     orchestrator whose checkout was deleted is still one, and unseating it for
     a missing directory would be this recovery causing the outage it exists to
     end. */
  const resolved = dependencies.resolvedConversation(active.conversationId);
  if (resolved) {
    confirmOrchestratorSeatMaterialization({
      project,
      clientRequestId: active.intent.clientRequestId,
      conversationId: active.conversationId,
      path: resolved.path,
    });
    return null;
  }
  const settlement = dependencies.launchSettlement({
    launchId: active.intent.launchId,
    clientRequestId: active.intent.clientRequestId,
  });
  /* Unresolvable AND still launching is a seat in its boot window, which is
     not a failure; only a terminal launch makes it stillborn. */
  if (settlement.kind !== "failed") return null;
  const rolledBack = abandonStillbornOrchestratorSeat({
    project,
    clientRequestId: active.intent.clientRequestId,
    error: `the accepted launch failed before its conversation became readable: ${settlement.error}`,
    now: dependencies.now(),
    /* The predecessor is TESTED before the project is designated onto it again.
       During the provisional window it can stop being resolvable — the card
       closed, the transcript removed, its host retired after the rotation
       revoked it — and restoring one the Viewer cannot read would reach the
       state this recovery exists to prevent, by way of the repair. */
    resolvable: (conversationId) => dependencies.resolvedConversation(conversationId) !== null,
    restorableSeat: (input) => restorableSeatFromLineage(input, dependencies),
  });
  if (rolledBack) {
    console.warn(`orchestrator seat for ${project} was rolled back: its accepted launch failed before the conversation became readable (${settlement.error})`);
  }
  return rolledBack;
}

/**
 * The predecessor of a seat that was ALREADY provisional when this recovery
 * shipped (#1757).
 *
 * `rollbacks` is written at a provisional activation, so exactly the incident's
 * own shape — a seat standing on a stillborn conversation before this code
 * existed — has no entry to roll back to, and would end undesignated. The
 * revocation that seated it names the predecessor it superseded, which is the
 * lineage the handover already walks, so the store hands that identity here and
 * this composes the row to restore.
 *
 * One field cannot be recovered: the mandate that conversation ran under lived
 * on the seat row the rotation replaced, and nothing keeps a copy. The restored
 * row therefore carries the approved default at its current version rather than
 * a guess — the next rotation composes its handover from something true, and
 * the board reads a version it can check.
 */
function restorableSeatFromLineage(
  input: { conversationId: string; stillborn: OrchestratorSeat },
  dependencies: SeatCommandDependencies,
): OrchestratorSeat | null {
  const resolved = dependencies.resolvedConversation(input.conversationId);
  if (!resolved) return null;
  const runtime = dependencies.runtimeIdentity(input.conversationId);
  return {
    project: input.stillborn.project,
    /* Placeholder only: the store mints the fresh epoch that lifts the
       revocation, exactly as it does for a recorded rollback. */
    seatEpoch: input.stillborn.seatEpoch,
    conversationId: resolved.conversationId,
    path: resolved.path,
    engine: runtime.engine,
    model: runtime.model,
    runtimeIdentityFrozen: false,
    mandate: ORCHESTRATOR_SYSTEM_PROMPT,
    promptVersion: ORCHESTRATOR_PROMPT_VERSION,
    predecessorConversationId: null,
    triggeredBy: null,
    state: "active",
    /* An adoption, which is what this is: the conversation exists and is being
       designated again. The key is derived from the attempt being rolled back,
       so a replayed rollback writes the same row. */
    intent: { clientRequestId: `restored-${input.stillborn.intent.clientRequestId}`.slice(0, 128), mode: "existing", launchId: null, error: null },
    designatedAt: input.stillborn.designatedAt,
    activatedAt: null,
  };
}

/**
 * Reconcile ONE project's active seat against the launch it was activated on,
 * for a caller that is not serving a request (#1757).
 *
 * The provisional window has to be bounded by something that comes round on its
 * own: a seat activated on an accepted launch that then died would otherwise
 * hold the project until the next POST to the seat or rotate route — a call
 * that may never come, while the board goes on showing that seat's composer.
 * The seat tick is that driver, and it already visits every seated project.
 *
 * Reconciles only. It starts nothing, sends nothing, and never waits on a
 * launch: an unsettled one is left exactly where it is.
 */
export function reconcileActiveOrchestratorSeat(
  project: string,
  dependencies: SeatCommandDependencies = activeSeatCommandDependencies(),
): StillbornSeatRollback | null {
  return reconcileActiveSeatLaunch(canonicalOrchestratorProject(project), dependencies);
}

/**
 * Reconcile ONE project's designation against the launch it rests on, for the
 * read the pane polls.
 *
 * A pending intent used to be reconciled only by the next POST to the seat
 * route. When the request that began it lost its answer, nothing came round on
 * its own: the launch settled or failed, the task card said so, and the pane
 * went on reading «creating» from a record nobody was going to touch. The read
 * the pane already makes is the driver that is always there while somebody is
 * looking, and it survives a reload because it is the server's record that
 * moves. A provisional active seat is reconciled by the same call, so a launch
 * that dies after activation does not wait minutes for the seat tick.
 *
 * Starts nothing and waits on no launch. A busy store is the caller's to
 * swallow: the next poll asks again.
 *
 * A FAILED launch is recorded from here only once the intent is
 * {@link READ_FAILURE_GRACE_MS} old. A retry begins a fresh intent under the
 * key of a launch that already failed and then asks the spawn route to claim
 * that launch again; for the moment in between, the receipt still reads failed
 * under an intent whose request is alive. Recording it then would answer that
 * request «superseded» while its launch went on to start. Seating a settled
 * launch needs no such wait: the request and the read write the same row.
 */
export async function reconcileOrchestratorSeatLaunch(
  project: string,
  dependencies: SeatCommandDependencies = activeSeatCommandDependencies(),
): Promise<void> {
  const canonical = canonicalOrchestratorProject(project);
  reconcileActiveSeatLaunch(canonical, dependencies);
  const reconciliation = reconcilePendingSeatIntent(canonical, dependencies, READ_FAILURE_GRACE_MS);
  if (reconciliation) await reconciliation;
}

/** How old a pending intent must be before the pane's read records its launch
    as failed; see {@link reconcileOrchestratorSeatLaunch}. */
export const READ_FAILURE_GRACE_MS = 15_000;

/**
 * Reconcile a pending spawn intent against the durable settlement of the launch
 * its request attempted, so a 202 Accepted spawn converges to exactly one seat
 * whether or not the accepting request survived. A settled launch activates the
 * intent on its conversation (the same atomic write the surviving request would
 * have made — revoking a differing predecessor, so no interleaving yields two
 * seats or an accepted launch with no seat); a terminally failed one records
 * the error, which terminalizes the intent into durable history on the spot
 * (#1757). An unsettled launch is left pending — the genuinely in-flight guard
 * stays intact.
 *
 * Returns null — synchronously, with no await point — whenever there is
 * nothing to activate, so a request with no reconcilable intent still
 * progresses synchronously to its durable begin before yielding, which is what
 * keeps two concurrent requests serialized by the pending-intent write.
 */
function reconcilePendingSeatIntent(project: string, dependencies: SeatCommandDependencies, failureGraceMs = 0): Promise<unknown> | null {
  const pending = orchestratorSeatFor(project).pending;
  if (!pending || pending.intent.mode !== "spawn" || pending.intent.error !== null) return null;
  const settlement = dependencies.launchSettlement({
    launchId: pending.intent.launchId,
    clientRequestId: pending.intent.clientRequestId,
  });
  if (settlement.kind === "settled") {
    return activate({
      project,
      clientRequestId: pending.intent.clientRequestId,
      conversationId: settlement.conversationId,
      path: settlement.path,
      launchId: settlement.launchId ?? pending.intent.launchId,
      ...(settlement.engine ? { engine: settlement.engine } : {}),
      ...(settlement.model ? { model: settlement.model } : {}),
    }, dependencies);
  }
  if (settlement.kind === "failed") {
    const age = Date.parse(dependencies.now()) - Date.parse(pending.designatedAt);
    if (failureGraceMs > 0 && Number.isFinite(age) && age < failureGraceMs) return null;
    failOrchestratorSeatIntent(project, pending.intent.clientRequestId, settlement.error, dependencies.now());
  }
  return null;
}

/** How long a designation queues for the account store behind another writer
    before it gives up, in total across its replays. */
export const SEAT_STORE_WAIT_MS = ACCOUNT_MUTATION_WAIT_MS;
/** How many times a designation that met a busy store is replayed. Each replay
    first queues for the lock, so the number bounds a store that answers busy
    while reading free; the wait above bounds one that stays held. */
const SEAT_STORE_BUSY_REPLAYS = 3;
/** What a designation records and answers when the store stayed busy through
    every replay. It names no holder: which writer held the lock is nothing the
    operator chose and nothing they can act on. */
export const SEAT_STORE_BUSY_REASON = "the account store stayed busy, so the designation could not be recorded; try again";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Queue behind whoever holds the account store, within what is left of the
    budget. False when the budget ran out first. */
async function seatStoreReleased(deadline: number, attempt: number): Promise<boolean> {
  /* A store that answers busy while its lock reads free must not be replayed
     in a tight loop. */
  await delay(Math.min(25 * attempt, Math.max(0, deadline - performance.now())));
  const remaining = deadline - performance.now();
  if (remaining <= 0) return false;
  try {
    await withAccountMutationLockAsync(() => undefined, { holder: "orchestrator seat retry", waitMs: remaining });
    return true;
  } catch (error) {
    if (error instanceof AccountMutationBusyError) return false;
    throw error;
  }
}

/**
 * EVERY WAY OUT OF A SEAT TRANSITION IS A RECORD (issue #1757).
 *
 * The seat store is guarded by the account mutation lock, and its synchronous
 * form waits at most 25 ms for a foreign holder. Any throw
 * past the durable begin — that one, a registry read that blew up, a bug — used
 * to leave the route answering an unhandled 500 with no body, the burnt epoch
 * sitting in `pending` with `error: null`, and every later designation refused
 * as `seat_intent_in_progress` behind it. The operator's evidence was three
 * epochs missing from the record and a stack trace in a container log.
 *
 * So the two exported entry points are wrapped: the thrown reason is recorded
 * on the intent, which terminalizes it into `intentHistory`, and the caller is
 * answered with that row and a code it can act on.
 *
 * A BUSY STORE IS WAITED OUT FIRST. That lock is one lock for every account
 * write on the machine, and the account controller takes it on its own once a
 * minute for each Codex account with a login on record. A creation that asked
 * in the same few milliseconds failed with a message about an engine the
 * operator had not chosen, after its launch had already been accepted. The
 * request is idempotent by its key (the intent replays, the spawn answers from
 * its receipt, the mandate is deduplicated), so it queues for the lock and runs
 * again, up to {@link SEAT_STORE_BUSY_REPLAYS} times inside
 * {@link SEAT_STORE_WAIT_MS}. Only when that is spent does it answer 503.
 *
 * Even then an intent whose launch was ACCEPTED is left pending: an agent is
 * starting under it, and recording «failed» would tell the pane nothing is
 * running while the task card shows it working. The pane's read reconciles that
 * intent onto its launch on the next poll.
 */
async function guardedSeatTransition(
  rawBody: Record<string, unknown>,
  code: "seat_transition_failed" | "rotation_failed",
  run: () => Promise<SeatCommandResult>,
  busy: { replay: boolean; waitMs?: number; launchAccepted?: (clientRequestId: string) => boolean } = { replay: false },
): Promise<SeatCommandResult> {
  const deadline = performance.now() + (busy.waitMs ?? SEAT_STORE_WAIT_MS);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (thrown) {
      const storeBusy = isAccountAdmissionRetryable(thrown);
      if (storeBusy && busy.replay && attempt <= SEAT_STORE_BUSY_REPLAYS && await seatStoreReleased(deadline, attempt)) continue;
      const admissionChanged = thrown instanceof AccountAdmissionChangedError;
      const reason = admissionChanged ? thrown.message : storeBusy ? SEAT_STORE_BUSY_REASON : thrown instanceof Error ? thrown.message : String(thrown);
      const named = typeof rawBody.project === "string" ? validExplicitProject(rawBody.project) : null;
      const clientRequestId = text(rawBody.clientRequestId);
      let terminalized: OrchestratorSeatTerminalization | null = null;
      let launchAccepted = false;
      if (named && CLIENT_REQUEST_ID.test(clientRequestId)) {
        const project = canonicalOrchestratorProject(named);
        try {
          launchAccepted = storeBusy && busy.launchAccepted?.(clientRequestId) === true;
          if (!launchAccepted) terminalized = failOrchestratorSeatIntent(project, clientRequestId, reason);
        } catch {
          /* The store itself is what failed. Nothing to record, and the answer
             below still names the reason — silence is the one outcome this
             wrapper exists to prevent. */
        }
      }
      console.error(`orchestrator seat transition failed for ${String(rawBody.project)}: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
      return {
        status: storeBusy ? 503 : 500,
        body: {
          error: reason,
          code: admissionChanged ? "account_admission_changed" : storeBusy ? "seat_store_busy" : code,
          retryable: storeBusy,
          seat: terminalized?.seat ?? null,
        },
      };
    }
  }
}

/**
 * R1 for a seat an agent put in place (docs/design/model-sizing-tiers.md §2):
 * an agent may not seat an orchestrator on Claude Sonnet or Haiku. A rotation
 * that continues the incumbent's own runtime keeps a choice only the operator
 * could have made, and passes. The operator's own designations are not judged.
 */
function agentSeatSizingRefusal(
  triggeredBy: OrchestratorSeatTrigger | null,
  runtime: LaunchRuntime,
  incumbent: OrchestratorSeat | null,
): SeatCommandResult | null {
  if (triggeredBy?.kind !== "agent") return null;
  const continued = incumbent !== null && incumbent.engine === runtime.engine && (runtime.engine === "claude"
    ? normalizeClaudeLaunchModel(incumbent.model) === normalizeClaudeLaunchModel(runtime.model)
    : (incumbent.model ?? null) === runtime.model);
  const refusal = continued ? null : mappingRowRefusal("orchestrator", runtime);
  return refusal ? { status: 400, body: { error: refusal, code: "sizing_refused", admission: "refused" } } : null;
}

export function executeOrchestratorSeatRequest(
  rawBody: Record<string, unknown>,
  dependencies: SeatCommandDependencies = productionSeatCommandDependencies,
  /* Who triggered this designation, resolved from the REQUEST by the caller.
     Deliberately not a `rawBody` field: the body is caller-supplied JSON, and
     attribution that a caller can write is not attribution. */
  triggeredBy: OrchestratorSeatTrigger | null = null,
  admission?: SeatLaunchAdmission,
): Promise<SeatCommandResult> {
  return guardedSeatTransition(rawBody, "seat_transition_failed", () => runOrchestratorSeatRequest(rawBody, dependencies, triggeredBy, admission), {
    replay: true,
    waitMs: dependencies.seatStoreWaitMs,
    launchAccepted: (clientRequestId) => dependencies.launchSettlement({ launchId: null, clientRequestId }).kind === "settled",
  });
}

async function runOrchestratorSeatRequest(
  rawBody: Record<string, unknown>,
  dependencies: SeatCommandDependencies,
  triggeredBy: OrchestratorSeatTrigger | null,
  admission?: SeatLaunchAdmission,
): Promise<SeatCommandResult> {
  const namedProject = typeof rawBody.project === "string" ? validExplicitProject(rawBody.project) : null;
  if (!namedProject) return { status: 400, body: { error: "project must be a valid project key", admission: "refused" } };
  /* #1874: a key the named checkout has since moved on from (the folder gained
     a repository or an origin) is recorded as succeeded first, so the seat is
     designated under the key its lanes will be written to. */
  recordProjectSuccessions([projectSuccessionFor(canonicalOrchestratorProject(namedProject), text(rawBody.cwd))]);
  const project = canonicalOrchestratorProject(namedProject);
  const mandate = typeof rawBody.mandate === "string" ? rawBody.mandate : "";
  if (!mandate.trim()) return { status: 400, body: { error: "mandate is required", admission: "refused" } };
  const clientRequestId = text(rawBody.clientRequestId);
  if (!CLIENT_REQUEST_ID.test(clientRequestId)) {
    return { status: 400, body: { error: "clientRequestId must be 8-128 URL-safe characters", admission: "refused" } };
  }
  const existingConversationId = text(rawBody.conversationId);
  if (existingConversationId && !existingConversationId.startsWith("conversation_")) {
    return { status: 400, body: { error: "conversationId is invalid", admission: "refused" } };
  }
  const promptVersion = typeof rawBody.promptVersion === "number" && Number.isInteger(rawBody.promptVersion)
    ? rawBody.promptVersion
    : null;

  /* Issue #1067: the ONE size bound is the delivery bound. An oversized
     mandate used to pass a 64 KB API check, become a pending intent, and then
     die at the 32000-byte structured envelope — leaving a designation that
     could never be delivered and never stopped being pending. Measured here,
     before either begin, so no durable intent can exist for a mandate that
     cannot be delivered. */
  const preflight = mandatePreflight(mandate, existingConversationId ? "existing" : "spawn", rawBody.roleParams);
  if (!preflight.ok) return { status: 413, body: { ...mandateTooLargeBody(preflight), admission: "refused" } };

  /* Before anything reads the incumbent: a seat still standing on a launch that
     died is not an incumbent, and rolling it back here is what puts the
     predecessor back in front of this request (#1757). */
  reconcileActiveSeatLaunch(project, dependencies);
  const reconciliation = reconcilePendingSeatIntent(project, dependencies);
  if (reconciliation) await reconciliation;

  const completedReplay = reconcileCompletedSeatReplay(project, clientRequestId, dependencies);
  if (completedReplay) return replayedSeatResponse(completedReplay);

  /* Issue #1067: rotation reads its incumbent, then awaits the summarizer, and
     the reconciliation directly above can seat a launch that settled during
     that wait — an intent that was still `unknown` when the rotation read the
     project. Checked HERE, after reconciliation and with no await point left
     before the durable begin, so a rotation can never replace a seat it never
     read. It sits below the completed-replay short-circuit on purpose: a
     rotation replaying its OWN finished intent is idempotent, not stale.
     Callers that composed against no particular seat omit the field. */
  const expectedIncumbentSeatEpoch = typeof rawBody.expectedIncumbentSeatEpoch === "number"
    ? rawBody.expectedIncumbentSeatEpoch
    : null;
  if (expectedIncumbentSeatEpoch !== null) {
    const seated = orchestratorSeatFor(project).active;
    if (!seated || seated.seatEpoch !== expectedIncumbentSeatEpoch) {
      return incumbentChangedResult(project, expectedIncumbentSeatEpoch, seated);
    }
  }

  if (existingConversationId) {
    const target = dependencies.conversationTarget(existingConversationId);
    if (!target) return { status: 404, body: { error: "conversation is unknown to the registry", admission: "refused" } };
    if (target.kind === "ineligible") {
      return { status: 409, body: { error: target.error, code: target.code, admission: "refused" } };
    }
    if (target.project !== project) {
      return {
        status: 409,
        body: { error: "conversation belongs to a different project", code: "project_mismatch", admission: "refused" },
      };
    }
    const adoptedSizing = target.engine
      ? agentSeatSizingRefusal(triggeredBy, { engine: target.engine, model: target.model ?? null }, orchestratorSeatFor(project).active)
      : null;
    if (adoptedSizing) return adoptedSizing;

    const begun = beginOrchestratorSeatIntent({
      project,
      mandate,
      roleTable: orchestratorRoleTable(loadRoleDefinitionsOrDefaults()),
      clientRequestId,
      mode: "existing",
      conversationId: target.conversationId,
      engine: target.engine ?? null,
      model: target.model ?? null,
      promptVersion,
      triggeredBy,
      now: dependencies.now(),
    });
    if (begun.kind === "completed") {
      const repaired = reconcileCompletedSeatReplay(project, clientRequestId, dependencies);
      if (!repaired) return { status: 409, body: { error: "seat intent was superseded by a newer designation" } };
      return replayedSeatResponse(repaired);
    }
    if (begun.kind === "in_progress") return inProgressSeatResponse(begun.seat);

    /* The durable intent owns the target on replay. A retried request may carry
       a different conversation id after a caller restart; following it would
       let one idempotency key designate a different conversation. */
    const deliveryTarget = begun.kind === "replay"
      ? dependencies.conversationTarget(begun.seat.conversationId ?? "")
      : target;
    if (!deliveryTarget || deliveryTarget.kind === "ineligible" || deliveryTarget.project !== project) {
      const error = "the pending adoption target is no longer eligible";
      const terminalized = failOrchestratorSeatIntent(project, clientRequestId, error, dependencies.now());
      return { status: 409, body: { error, code: "adoption_target_unavailable", seat: terminalized?.seat ?? null } };
    }

    const delivery = await dependencies.deliver({
      conversationId: deliveryTarget.conversationId,
      path: deliveryTarget.path,
      /* Derived, never minted: a retry after a lost response reuses the same
         id and the delivery receipts answer it instead of delivering twice. */
      clientMessageId: `orchmandate_${clientRequestId}`,
      /* The intent's recorded mandate and role table are what completes: a
         pending replay whose caller recomposed its text, or whose registry
         changed since the first attempt, must not deliver a second variant
         under the same clientMessageId. */
      text: orchestratorMandateWithRoleTable(begun.seat.mandate, begun.seat.roleTable ?? null),
    });
    if (!delivery.ok) {
      const error = delivery.error ?? "mandate delivery failed";
      const terminalized = failOrchestratorSeatIntent(project, clientRequestId, error, dependencies.now());
      return {
        status: 502,
        body: {
          error,
          code: "mandate_delivery_failed",
          /* Recoverable, not a dead end: the incumbent (if any) still holds the
             seat, and the selected conversation can be resumed from the board
             before retrying. The intent this returns is TERMINAL (issue #1067)
             and already terminalized into `intentHistory` (issue #1757), so a
             retry — even under this same request id — composes afresh rather
             than replaying the mandate that failed. */
          seat: terminalized?.seat ?? null,
        },
      };
    }
    const activated = await activate({ project, clientRequestId, conversationId: deliveryTarget.conversationId, path: deliveryTarget.path }, dependencies);
    if (!activated) return { status: 409, body: { error: "seat intent was superseded by a newer designation" } };
    return {
      status: 200,
      body: {
        ok: true,
        state: "settled",
        conversationId: deliveryTarget.conversationId,
        path: deliveryTarget.path,
        delivery: delivery.outcome ?? "delivered",
        seat: activated.seat,
      },
    };
  }

  /* Spawn mode: a fresh orchestrator whose FIRST PROMPT is the mandate, so the
     durable launch receipt is the exactly-once delivery mechanism. */
  const incumbent = orchestratorSeatFor(project).active;
  if (incumbent && incumbent.intent.clientRequestId !== clientRequestId && rawBody.replaceIncumbent !== true) {
    /* HIGH 5 (#758 review): a fresh spawn-mode designation over a live seat is
       an ACCIDENTAL rotation — no handoff, no lineage notes, no stated intent —
       and an agent regenerating its idempotency key on retry would trigger it.
       Refused; rotation is the explicit way through, and callers that really
       mean "replace" (the rotation command, a deliberate board replace) say so
       with `replaceIncumbent: true`. */
    return {
      status: 409,
      body: {
        error: `an orchestrator is already designated for ${project}; use rotate_orchestrator for an explicit handoff, or pass replaceIncumbent: true to replace deliberately`,
        code: "already_designated",
        admission: "refused",
        incumbentSeatEpoch: incumbent.seatEpoch,
      },
    };
  }
  const resolvedRuntime = resolveSpawnRole({
    role: "orchestrator",
    roleParams: rawBody.roleParams,
    engine: rawBody.engine,
    model: rawBody.model,
    effort: rawBody.effort,
  });
  if (!resolvedRuntime.ok || !resolvedRuntime.value) {
    return { status: 400, body: { error: resolvedRuntime.ok ? "orchestrator runtime is unavailable" : resolvedRuntime.error, admission: "refused" } };
  }
  const spawnSizing = agentSeatSizingRefusal(triggeredBy, resolvedRuntime.value.config, incumbent);
  if (spawnSizing) return spawnSizing;
  // Reconciliation and completed replay above can settle admitted work. A
  // fresh agent spawn still needs admission after any awaited handoff work.
  const hold = agentSeatLaunchHold(project, clientRequestId, triggeredBy, admission?.autonomous);
  if (hold) return hold;
  if (admission?.assertAccount) admission.assertAccount(text(rawBody.accountId));
  /* A seat holds the grant wherever Telegram is set up, whatever its
     connection reads this minute: the launch repairs a connection that is down
     or starts without the tool, and the grant brings the tool back later. */
  const telegramGrant = telegramSetUp();
  const begun = beginOrchestratorSeatIntent({
    project,
    mandate,
    roleTable: orchestratorRoleTable(loadRoleDefinitionsOrDefaults()),
    clientRequestId,
    mode: "spawn",
    engine: resolvedRuntime.value.config.engine,
    model: resolvedRuntime.value.config.model,
    telegramGrant,
    promptVersion,
    triggeredBy,
    now: dependencies.now(),
  });
  if (begun.kind === "completed") {
    const repaired = reconcileCompletedSeatReplay(project, clientRequestId, dependencies);
    if (!repaired) return { status: 409, body: { error: "seat intent was superseded by a newer designation" } };
    return replayedSeatResponse(repaired);
  }
  if (begun.kind === "in_progress") return inProgressSeatResponse(begun.seat);
  if (begun.kind === "replay" && begun.seat.runtimeIdentityFrozen !== true) {
    const error = "legacy pending orchestrator runtime identity is unavailable; retry the designation with a new clientRequestId";
    const terminalized = failOrchestratorSeatIntent(project, clientRequestId, error, dependencies.now());
    return {
      status: 409,
      body: {
        error,
        code: "legacy_runtime_identity_unavailable",
        seat: terminalized?.seat ?? null,
      },
    };
  }
  if (begun.kind === "replay" && typeof begun.seat.telegramGrant !== "boolean") {
    const error = "legacy pending orchestrator Telegram selection is unavailable; retry the designation with a new clientRequestId";
    const terminalized = failOrchestratorSeatIntent(project, clientRequestId, error, dependencies.now());
    return { status: 409, body: { error, code: "legacy_telegram_selection_unavailable", seat: terminalized?.seat ?? null } };
  }
  /* A pending replay spawns the ORIGINAL intent's mandate and role table: the
     spawn receipt is matched by clientAttemptId AND request digest, so a
     recomposed retry, or one rendered from a registry edited since, would
     otherwise conflict with its own first attempt. */
  const spawnMandate = orchestratorMandateWithRoleTable(begun.seat.mandate, begun.seat.roleTable ?? null);

  const spawnFields = ["cwd", "effort", "fast", "accountId", "images", "roleParams", "allowSubagents"] as const;
  const spawnRuntime = begun.kind === "replay"
    ? {
        ...(begun.seat.engine ? { engine: begun.seat.engine } : {}),
        ...(begun.seat.model ? { model: begun.seat.model } : {}),
      }
    : {
        engine: resolvedRuntime.value.config.engine,
        model: resolvedRuntime.value.config.model,
      };
  /* An engine nobody is signed in to is the refusal the launch would give
     anyway, and the one the operator can act on, so it is answered before any
     question about folders (#2167). */
  const launchEngine: string = spawnRuntime.engine ?? resolvedRuntime.value.config.engine;
  const checkedEngine: EngineName | null = launchEngine === "claude" || launchEngine === "codex" ? launchEngine : null;
  const readiness = checkedEngine ? dependencies.engineReadiness?.(checkedEngine, project) ?? "connected" : "connected";
  if (checkedEngine && readiness !== "connected") {
    const refusal = { role: "orchestrator", engine: checkedEngine, reason: readiness };
    const error = engineNotConnectedMessage(refusal);
    const terminalized = failOrchestratorSeatIntent(project, clientRequestId, error, dependencies.now());
    return {
      status: 409,
      body: {
        error, code: ENGINE_NOT_CONNECTED, details: engineNotConnectedDetails(refusal), seat: terminalized?.seat ?? null,
        ...(begun.kind === "begun" ? { admission: "refused" } : {}),
      },
    };
  }
  const cwd = resolveOrchestratorCwd(project, rawBody.cwd, dependencies);
  if (!cwd) {
    const reason = "the project's folder could not be found on disk";
    const terminalized = failOrchestratorSeatIntent(project, clientRequestId, reason, dependencies.now());
    return {
      status: 400,
      body: {
        error: `${reason}: nothing recorded for this project points at a folder that still exists — check the project's folder, or pass cwd`,
        code: "cwd_unresolved",
        ...(begun.kind === "begun" ? { admission: "refused" } : {}),
        seat: terminalized?.seat ?? null,
      },
    };
  }
  const spawnBody: Record<string, unknown> = {
    ...Object.fromEntries(spawnFields.flatMap((field) => (rawBody[field] === undefined ? [] : [[field, rawBody[field]]]))),
    ...spawnRuntime,
    role: "orchestrator",
    ...(begun.seat.telegramGrant ? { mcpServers: ["telegram"] } : {}),
    roleParams: rawBody.roleParams ?? { mode: "standard" },
    project,
    cwd,
    ["prompt"]: spawnMandate,
    title: derivedSpawnTitle("orchestrator", spawnMandate, project),
    clientAttemptId: clientRequestId,
  };
  const spawnAdmission: SeatLaunchAdmission = { ...admission, assertAccount: (accountId) => {
    admission?.assertAccount?.(accountId);
    recordOrchestratorSeatAuthCredentialBaseline(project, clientRequestId, begun.seat.seatEpoch, launchEngine, accountId);
  } };
  const spawned = await dependencies.spawn(spawnBody, admission?.autonomous || begun.seat.triggeredBy?.kind === "agent", spawnAdmission);
  if (spawned.body.code === "AUTO_UPDATE_DRAIN") {
    // No receipt was admitted: keep the pending intent and its downstream key.
    return { status: 409, body: { ...spawned.body, code: "launch_held_for_update", seat: begun.seat } };
  }
  const spawnedConversationId = text(spawned.body.conversationId);
  const admitted = spawned.status >= 200 && spawned.status < 300 && spawned.body.ok !== false;
  const launchId = text(spawned.body.launchId);
  const acceptedPending = admitted
    && spawned.status === 202
    && Boolean(spawnedConversationId)
    && Boolean(launchId);
  const launched = admitted && spawned.body.launched !== false && Boolean(spawnedConversationId);
  if (!launched && !acceptedPending) {
    /* The spawn route answers its own busy store as a plain failure. It is the
       same wait as ours: nothing was launched, and the replay asks again under
       the same attempt id. */
    if (spawned.body.code === "account_admission_changed" || text(spawned.body.error) === "spawn account changed during admission") throw new AccountAdmissionChangedError();
    if (spawned.body.code === "account_store_busy" || text(spawned.body.error) === ACCOUNT_STORE_BUSY_MESSAGE || text(spawned.body.error).startsWith("account mutation is busy")) throw new AccountMutationBusyError();
    const error = text(spawned.body.error)
      || (!admitted
        ? `spawn was rejected with HTTP status ${spawned.status}`
        : !spawnedConversationId
          ? "spawn response omitted conversationId"
          : "spawn did not report an accepted launch");
    const terminalized = failOrchestratorSeatIntent(project, clientRequestId, error, dependencies.now());
    return { status: spawned.status, body: { ...spawned.body, seat: terminalized?.seat ?? null } };
  }
  const activated = await activate({
    project,
    clientRequestId,
    conversationId: spawnedConversationId,
    path: typeof spawned.body.path === "string" ? spawned.body.path : null,
    launchId: launchId || null,
    engine: resolvedRuntime.value.config.engine,
    model: resolvedRuntime.value.config.model,
  }, dependencies);
  if (!activated) return { status: 409, body: { error: "seat intent was superseded by a newer designation" } };
  return {
    status: spawned.status,
    body: {
      ...spawned.body,
      ...(acceptedPending ? { accepted: true, state: "accepted" } : {}),
      seat: activated.seat,
    },
  };
}

/** How far back a handover will walk a lineage looking for turns. A seat that
    rotated this many times with nothing readable behind it has no story to
    hand over, and the walk costs a transcript read per hop. */
const HANDOFF_LINEAGE_CAP = 8;

/** The one bounded read the successor is told to make, spelled the same way
    wherever the handover names a conversation. */
function predecessorReadCall(conversationId: string): string {
  return `conversation_messages({"clientRequestId":"rotation-predecessor-recent-turns-${conversationId}","conversationId":"${conversationId}","roles":["user","assistant"],"limit":40})`;
}

/**
 * The newest conversation in this seat's lineage that ACTUALLY HOLDS TURNS
 * (#1757), starting at the incumbent and walking back through the revocations.
 *
 * The incident: a rotation seated a conversation whose launch died before its
 * transcript existed, and the next rotation's handover told the successor to
 * read that conversation's recent turns. `conversation_messages` answered that
 * the transcript was outside the scanner roots, `get_conversation` answered
 * «conversation not found», and the successor was left with a lineage of one
 * dead link and no way to know the real predecessor was one hop further back.
 *
 * Each hop is judged by WHAT THE CALL THE HANDOVER PRESCRIBES NEEDS, and by
 * nothing else: `conversation_messages` wants a registry row and a transcript
 * generation under a scanner root, so those are the two facts asked for, plus
 * the one question a handover cares about — does it hold turns? A stillborn
 * link answers no to all three and is skipped, never followed.
 *
 * What is deliberately NOT asked is whether the launch cwd still exists. An
 * orchestrator that ran in a worktree somebody has since deleted reads its own
 * transcript perfectly well, and dropping it from the handover would lose the
 * story for the same reason the incident did.
 */
function readablePredecessor(
  project: string,
  incumbent: OrchestratorSeat,
  dependencies: SeatCommandDependencies,
): { conversationId: string; cwd: string | null } | null {
  const holdsTurns = (conversationId: string | null): { conversationId: string; cwd: string | null } | null => {
    if (!conversationId) return null;
    const resolved = dependencies.resolvedConversation(conversationId);
    return resolved?.holdsTurns ? { conversationId: resolved.conversationId, cwd: resolved.cwd } : null;
  };
  const incumbentHolds = holdsTurns(incumbent.conversationId);
  if (incumbentHolds) return incumbentHolds;
  /* Newest-first: each revocation names the seat that ended and the successor
     that replaced it, so following `successorConversationId` backwards from the
     incumbent walks the lineage without trusting any single seat row to carry
     more than its own predecessor. */
  const lineage = orchestratorRevocations().filter((revocation) => revocation.project === project);
  const seen = new Set<string>([incumbent.conversationId ?? ""]);
  let current = incumbent.conversationId;
  for (let hop = 0; hop < HANDOFF_LINEAGE_CAP && current; hop += 1) {
    const link = [...lineage].reverse().find((revocation) => revocation.successorConversationId === current);
    const candidate = link?.conversationId ?? null;
    if (!candidate || seen.has(candidate)) return null;
    seen.add(candidate);
    current = candidate;
    const held = holdsTurns(candidate);
    if (held) return held;
  }
  return null;
}

const HANDOFF_NOTES_CAP = 2_000;

/**
 * THE shared entry point for `POST /api/orchestrator/rotate` (#1402).
 *
 * The route is a Next module and may export only route fields, so the two steps
 * that decide a rotation live here instead: resolve WHO is asking with the one
 * rotation authority contract, and rotate. The `rotate_orchestrator` MCP tool
 * posts to that route and holds no copy of either step, so the tool's answer is
 * the route's answer by construction — for the actor it accepts and for every
 * refusal the rotation itself makes.
 *
 * Cross-origin rejection stays in the route, ahead of this: it is the perimeter.
 * Automatic-update admission can also defer fresh agent launches.
 */
export function handleOrchestratorRotationRequest(
  request: Pick<NextRequest, "headers">,
  rawBody: Record<string, unknown>,
  dependencies: SeatCommandDependencies = activeSeatCommandDependencies(),
): Promise<SeatCommandResult> {
  return executeOrchestratorRotation(rawBody, dependencies, rotationActor(request));
}

let seatCommandDependenciesForTests: SeatCommandDependencies | null = null;

/**
 * Tests only; `null` restores the production seams. Seamed here rather than in
 * the route, because a route module may export only route fields.
 *
 * `POST /api/orchestrator/rotate` is the surface the rotation contract is about
 * (#1402), so the regression drives the exported route itself over loopback —
 * and a route takes no dependency argument. This is how that run reaches a
 * rotation without spawning a process or delivering to a live host.
 */
export function setSeatCommandDependenciesForTests(dependencies: SeatCommandDependencies | null): void {
  seatCommandDependenciesForTests = dependencies;
}

function activeSeatCommandDependencies(): SeatCommandDependencies {
  return seatCommandDependenciesForTests ?? productionSeatCommandDependencies;
}

/** The caller's own seat epoch, when the caller IS a designated seat — which is
    what tells a self-rotation apart from a rotation ordered from elsewhere. */
function rotationTrigger(actor: ViewerActor): OrchestratorSeatTrigger {
  const seat = actor.conversationId
    ? activeOrchestratorSeats().find((candidate) => candidate.conversationId === actor.conversationId)
    : undefined;
  return { kind: actor.kind, conversationId: actor.conversationId, seatEpoch: seat?.seatEpoch ?? null };
}

/**
 * Rotation (two-axis contract): hand the seat to a fresh successor.
 *
 * The handoff is BOUNDED and durable-state-based: the successor's launch
 * prompt carries the incumbent's core mandate, the predecessor's identity and
 * exact bounded message-read call (available whether the incumbent is alive or
 * dead, which matters because a dead incumbent is a common reason to rotate),
 * a pointer to the board maintenance report, and any caller notes. Designation switches
 * atomically with the successor's activation; the predecessor loses
 * MANAGER-LEVEL authority only — its session, host, card and
 * ordinary Viewer access are untouched (axis 1) — and both cards stay linked
 * by the bidirectional lineage the seat store records.
 *
 * The handoff is also COMPACTED (issue #1067): the successor's mandate carries
 * the core mandate, one bounded "Rotation history" section standing in for
 * every earlier handoff, and this rotation's fresh handoff — so a seat that has
 * rotated a dozen times designates exactly as cheaply as one that never has.
 *
 * Context pressure only produces a recommendation (`./health`). The seat tick
 * automatically calls this path after an authentication failure, selecting
 * another allowed account; all other rotations are explicitly requested.
 */
export function executeOrchestratorRotation(
  rawBody: Record<string, unknown>,
  dependencies: SeatCommandDependencies = productionSeatCommandDependencies,
  /* WHO ordered this rotation. Never a refusal — rotation bans nobody — and
     never read off `rawBody`, so nothing a caller writes can claim to be
     someone else. Null is an in-process caller that named nobody, and records
     unknown provenance; the operator is never credited by default. */
  actor: ViewerActor | null = null,
  admission?: SeatLaunchAdmission,
): Promise<SeatCommandResult> {
  return guardedSeatTransition(rawBody, "rotation_failed", () => runOrchestratorRotation(rawBody, dependencies, actor, admission), {
    replay: true,
    waitMs: dependencies.seatStoreWaitMs,
    launchAccepted: (clientRequestId) => dependencies.launchSettlement({ launchId: null, clientRequestId }).kind === "settled",
  });
}

async function runOrchestratorRotation(
  rawBody: Record<string, unknown>,
  dependencies: SeatCommandDependencies,
  actor: ViewerActor | null,
  admission?: SeatLaunchAdmission,
): Promise<SeatCommandResult> {
  const triggeredBy = actor ? rotationTrigger(actor) : null;
  const namedProject = typeof rawBody.project === "string" ? validExplicitProject(rawBody.project) : null;
  if (!namedProject) return { status: 400, body: { error: "project must be a valid project key", admission: "refused" } };
  const project = canonicalOrchestratorProject(namedProject);
  const clientRequestId = text(rawBody.clientRequestId);
  if (!CLIENT_REQUEST_ID.test(clientRequestId)) {
    return { status: 400, body: { error: "clientRequestId must be 8-128 URL-safe characters", admission: "refused" } };
  }
  /* An accepted launch whose request died may hold the seat this rotation must
     replace, and one that DIED may still be holding it; converge both so the
     rotation sees its real incumbent (#1757). */
  const rolledBack = reconcileActiveSeatLaunch(project, dependencies);
  /* What the caller is owed when the seat it asked about turns out to have been
     stillborn: WHICH designation died and why, on the same answer as whatever
     this rotation goes on to do. Without it the incumbent silently changes
     identity between two calls and nothing says a rotation ever failed. */
  const rollbackReport = rolledBack
    ? {
      rolledBack: {
        conversationId: rolledBack.terminalized.seat.conversationId,
        seatEpoch: rolledBack.terminalized.seat.seatEpoch,
        error: rolledBack.terminalized.seat.intent.error,
        terminalizedAt: rolledBack.terminalized.terminalizedAt,
        /* WHICH conversation holds the project now, so the caller reads the
           whole outcome of the repair rather than only what died. Null is the
           honest answer when nothing restorable was left. */
        restoredConversationId: rolledBack.restored?.conversationId ?? null,
      },
    }
    : {};
  const reconciliation = reconcilePendingSeatIntent(project, dependencies);
  if (reconciliation) await reconciliation;
  const incumbent = orchestratorSeatFor(project).active;
  if (!incumbent?.conversationId) {
    return {
      status: 409,
      body: {
        error: "no orchestrator is designated for this project — use create_orchestrator instead of rotating",
        code: "no_incumbent",
        admission: "refused",
        ...rollbackReport,
      },
    };
  }
  if (typeof rawBody.expectedIncumbentSeatEpoch === "number"
    && rawBody.expectedIncumbentSeatEpoch !== incumbent.seatEpoch) {
    return incumbentChangedResult(project, Number(rawBody.expectedIncumbentSeatEpoch), incumbent);
  }
  // An accepted rotation can be replayed during a hold. Defer a fresh one
  // before composition, which may itself launch a handoff summarizer.
  const hold = incumbent.intent.clientRequestId === clientRequestId ? null : agentSeatLaunchHold(project, clientRequestId, triggeredBy, admission?.autonomous);
  if (hold) return { ...hold, body: { ...hold.body, triggeredBy } };

  const predecessorTarget = dependencies.conversationTarget(incumbent.conversationId);
  const predecessor = predecessorTarget?.kind === "eligible" ? predecessorTarget : null;
  /* WHICH predecessor the successor is told to READ (#1757). The seat it
     replaces and the conversation that holds the story are usually the same
     one, and when a rotation seated a conversation that never drew a breath
     they are not: the handover named that stillborn link anyway, and the
     successor's one instruction was to read a transcript that does not exist. */
  const readable = readablePredecessor(project, incumbent, dependencies);
  const notes = text(rawBody.handoffNotes).slice(0, HANDOFF_NOTES_CAP);
  const handoff: HandoffParts = {
    header: [
      `You are replacing orchestrator conversation ${incumbent.conversationId} for project ${project}. Its manager authority is revoked; its session and card remain on the board, linked to yours.`,
      ...(readable
        ? [
          readable.conversationId === incumbent.conversationId
            ? `Your predecessor's recent turns — decisions, blockers, in-flight work — are one call away: ${predecessorReadCall(readable.conversationId)}. Records are newest first; pass the returned cursor with a fresh clientRequestId for each older page. Read them before acting, and never open the transcript file. If the call reports that the conversation has no transcript, reconstruct state from the board.`
            : `The seat you are replacing holds no readable turns, so it is not what you read. The last predecessor in this lineage that does is ${readable.conversationId}: ${predecessorReadCall(readable.conversationId)}. Records are newest first; pass the returned cursor with a fresh clientRequestId for each older page. Read them before acting, and never open the transcript file.`,
        ]
        : [
          `No conversation in this seat's lineage holds readable turns — the seat you are replacing has none, and neither does any predecessor on record. There is no handover transcript to read: reconstruct state from the board maintenance report and from the notes in this mandate, and do not go looking for the predecessor's transcript file.`,
        ]),
    ],
    tasks: HANDOFF_BOARD_REPORT_POINTER,
    notes: notes || null,
  };

  /* An omitted mandate preserves the incumbent's core and bounded history,
     even when its prompt version is older. Only an explicit mandate replaces
     the core. The recorded version follows that choice (#1452). */
  const requested = text(rawBody.mandate);
  const base = requested || incumbent.mandate;
  const promptVersion = base === ORCHESTRATOR_SYSTEM_PROMPT
    ? ORCHESTRATOR_PROMPT_VERSION
    : base !== incumbent.mandate && orchestratorMandateStale(incumbent.promptVersion)
      ? null
      : incumbent.promptVersion;
  /* Awaited ONLY when there is something to summarize. A rotation with nothing
     to compact must reach its durable `begin` with no await point, which is
     what serializes it against a concurrent designation for the same project. */
  const composition = composeRotationMandate({
    project,
    clientRequestId,
    base,
    handoff,
    predecessor: predecessor ? { path: predecessor.path, engine: predecessor.engine } : null,
    roleParams: rawBody.roleParams,
    autonomousAdmissionHeld: admission?.autonomous || triggeredBy?.kind === "agent" ? () => !!activeDrain() : undefined,
  }, dependencies);
  const composed = composition instanceof Promise ? await composition : composition;
  const rotatedFrom = {
    conversationId: incumbent.conversationId,
    path: predecessor?.path ?? incumbent.path,
    seatEpoch: incumbent.seatEpoch,
  };
  /* The summarizer is an await point of up to HANDOFF_DIGEST_TIMEOUT_MS, and
     everything above — the incumbent, its mandate, the handoff header — was
     read BEFORE it. A designation that settled during that wait owns the seat
     now, and `replaceIncumbent: true` would revoke it on the strength of a
     stale read: the newer orchestrator would lose its authority to a successor
     carrying the superseded mandate, with the newer one's own handoff never
     written. Rotation replaces only the incumbent it actually read; anything
     else is a conflict the caller resolves by rotating again, which recomposes
     from the current seat. */
  const current = orchestratorSeatFor(project).active;
  if (!current || current.conversationId !== incumbent.conversationId || current.seatEpoch !== incumbent.seatEpoch) {
    const conflict = incumbentChangedResult(project, incumbent.seatEpoch, current);
    return { status: conflict.status, body: { ...conflict.body, rotatedFrom, triggeredBy } };
  }
  if (composed.kind === "too_large") return { status: 413, body: { ...composed.body, admission: "refused", rotatedFrom, triggeredBy } };

  const outcome = await executeOrchestratorSeatRequest({
    project,
    mandate: composed.mandate,
    clientRequestId,
    /* Rotation IS the explicit replacement, so it carries the opt-in the plain
       spawn-mode guard requires. */
    replaceIncumbent: true,
    /* ...but only of the seat this rotation actually read. The check above ran
       BEFORE the seat request's own reconciliation; this is what that request
       re-checks after it, which is the last read before the durable begin. */
    expectedIncumbentSeatEpoch: incumbent.seatEpoch,
    promptVersion,
    // Omitted runtime settings continue the incumbent. An explicit engine
    // switch uses the role validator to resolve its model.
    ...(rawBody.engine !== undefined ? { engine: rawBody.engine } : incumbent.engine ? { engine: incumbent.engine } : {}),
    ...(rawBody.model !== undefined ? { model: rawBody.model }
      : (rawBody.engine === undefined || rawBody.engine === incumbent.engine) && incumbent.model
        ? { model: incumbent.model } : {}),
    ...(rawBody.effort !== undefined ? { effort: rawBody.effort } : {}),
    ...(rawBody.fast !== undefined ? { fast: rawBody.fast } : {}),
    /* Issue #903: a rotation without an explicit cwd continues in the
       predecessor's checkout rather than falling through to the generic
       resolver — the successor inherits the incumbent's mandate, so it
       inherits its working directory too. When the seat being replaced cannot
       be resolved at all (#1757), the checkout comes from the same predecessor
       whose turns the handover names: rotating AWAY from a stillborn seat is
       precisely when the operator needs it to work. */
    ...(rawBody.cwd !== undefined
      ? { cwd: rawBody.cwd }
      : predecessor
        ? { cwd: predecessor.cwd }
        : readable?.cwd
          ? { cwd: readable.cwd }
          : {}),
    ...(rawBody.accountId !== undefined ? { accountId: rawBody.accountId } : {}),
  }, dependencies, triggeredBy, admission);
  return {
    status: outcome.status,
    body: {
      ...outcome.body,
      ...rollbackReport,
      rotatedFrom,
      /* Who ordered it, on the answer as well as on the durable record, so the
         caller reads back the attribution its rotation was recorded under. */
      triggeredBy: attributedTrigger(outcome.body, triggeredBy),
      mandateDisposition: requested ? "replaced" : "preserved",
      ...(composed.handoff ? { handoff: composed.handoff } : {}),
    },
  };
}

/**
 * THE ANSWER REPORTS WHAT THE RECORD HOLDS (#1402).
 *
 * Every outcome that reached a seat carries that seat, and the seat's own
 * `triggeredBy` was written by the request that created the intent. So an
 * idempotent replay — a lost response retried, whichever actor holds the key —
 * answers with the actor that ORDERED the rotation. The replaying caller's own
 * identity is a fact about the retry, and writing it over the attribution would
 * make the answer contradict the durable record it is reporting.
 *
 * When no seat was reached, the request was refused before anything was
 * recorded; there the answer names the actor that asked, and there is no record
 * for it to disagree with.
 */
function attributedTrigger(
  body: Record<string, unknown>,
  requested: OrchestratorSeatTrigger | null,
): OrchestratorSeatTrigger | null {
  const seat = body.seat;
  if (!seat || typeof seat !== "object" || Array.isArray(seat)) return requested;
  return (seat as OrchestratorSeat).triggeredBy ?? null;
}

type RotationMandate =
  | { kind: "composed"; mandate: string; handoff: Record<string, unknown> | null }
  | { kind: "too_large"; body: Record<string, unknown> };

/**
 * Issue #1067: the successor mandate is CORE + ONE history section + the fresh
 * handoff, never the incumbent's full text with another handoff appended.
 * Prior handoffs — however many stacked up before this change — are compacted
 * into the single history section, so the mandate's size is a function of the
 * core and the caps, not of how many rotations preceded it.
 *
 * Rotation never blocks on the summarizer: it gets one bounded try, and every
 * other outcome renders the deterministic verbatim tail instead. When even the
 * trimmed composition cannot be delivered, this refuses BEFORE the seat request
 * creates an intent, so the incumbent keeps its seat and nothing goes pending.
 */
interface RotationComposition {
  autonomousAdmissionHeld?: () => boolean;
  project: string;
  clientRequestId: string;
  base: string;
  handoff: HandoffParts;
  predecessor: { path: string; engine: "claude" | "codex" } | null;
  roleParams: unknown;
}

function composeRotationMandate(
  input: RotationComposition,
  dependencies: SeatCommandDependencies,
): RotationMandate | Promise<RotationMandate> {
  /* A retry of an in-flight intent delivers the stored mandate verbatim
     (`executeOrchestratorSeatRequest` replays it), so recomposing here would
     only spend another summarizer run on text nobody reads. */
  const pending = orchestratorSeatFor(input.project).pending;
  if (pending && pending.intent.clientRequestId === input.clientRequestId && pending.intent.error === null) {
    return { kind: "composed", mandate: pending.mandate, handoff: null };
  }
  const split = splitMandate(input.base);
  /* First rotation: no prior handoffs to compact, so no summarizer run — the
     fresh handoff already names the predecessor and its bounded message read. */
  if (split.history === null && split.handoffs.length === 0) {
    return renderRotationMandate(input, split.core, null, "none", null);
  }
  return (async (): Promise<RotationMandate> => {
    let outcome: HandoffDigestOutcome;
    try {
      outcome = await dependencies.summarizeHandoffs({
        project: input.project,
        clientRequestId: input.clientRequestId,
        autonomousAdmissionHeld: input.autonomousAdmissionHeld,
        priorHistory: split.history,
        priorHandoffs: split.handoffs,
        predecessor: input.predecessor,
      });
    } catch {
      outcome = { kind: "fallback", reason: "error" };
    }
    if (outcome.kind === "digest") {
      return renderRotationMandate(input, split.core, boundHistoryBody(outcome.text), "digest", null);
    }
    console.warn(`orchestrator rotation for ${input.project} used the verbatim handoff fallback: ${outcome.reason}`);
    return renderRotationMandate(input, split.core, fallbackHistory(split.history, split.handoffs, outcome.reason), "fallback", outcome.reason);
  })();
}

/** Core + history + fresh handoff, measured as delivered and trimmed to the
    envelope, or refused when even the trimmed composition cannot fit. */
function renderRotationMandate(
  input: RotationComposition,
  core: string,
  history: string | null,
  source: "digest" | "fallback" | "none",
  reason: string | null,
): RotationMandate {
  const overhead = launchOverheadBytes("spawn", input.roleParams);
  const roles = loadRoleDefinitionsOrDefaults();
  const composed = composeSuccessorMandate({
    core,
    history,
    handoff: input.handoff,
    budgetBytes: MAX_STRUCTURED_TEXT_BYTES - overhead,
    deliver: (mandate) => orchestratorMandateForDelivery(mandate, roles),
  });
  if (composed.kind === "too_large") {
    return {
      kind: "too_large",
      body: mandateTooLargeBody({
        ok: false,
        bytes: composed.bytes,
        overhead,
        bound: MAX_STRUCTURED_TEXT_BYTES,
        excess: composed.bytes - composed.budgetBytes,
      }),
    };
  }
  return {
    kind: "composed",
    mandate: composed.mandate,
    handoff: {
      history: source,
      reason,
      historyDropped: composed.historyDropped,
      notesTruncatedTo: composed.notesTruncatedTo,
      mandateBytes: composed.bytes,
    },
  };
}
