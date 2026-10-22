import { resolveSeatProject } from "@/lib/orchestrator/seatProjectIdentity";
import { ProjectNameRefusal } from "@/lib/projects/nameResolution";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import fs from "node:fs";
import os from "node:os";

import { NextRequest, NextResponse } from "next/server";

import { canonicalProject } from "@/lib/projects/aliases";
import { isCanonicalProjectId } from "@/lib/projects/identity";
import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { viewerMcpRegistered } from "@/lib/agent/spawnPolicy";
import { executeOrchestratorSeatRequest, reconcileOrchestratorSeatLaunch } from "@/lib/orchestrator/seatCommand";
import { deputiesForSeatIn, deputyConversationRefsIn, readDeputyFileOrNull, type OrchestratorDeputy, type RetiredDeputyRef } from "@/lib/orchestrator/deputies";
import { seatDeputyView, type SeatDeputyView } from "@/lib/orchestrator/deputyView";
import { allSeatConversationsIn, orchestratorSeatIn, previousOrchestratorSeatsIn, readOrchestratorSeatFileOrNull, seatTaskLookup, type OrchestratorSeat, type PreviousOrchestratorSeat, type SeatConversations, type SeatNotesTask } from "@/lib/orchestrator/seats";
import { currentSeatFailure, type SeatHostObservation } from "@/lib/orchestrator/seatFailure";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { loadTasksForList } from "@/lib/tasks/store";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

import { productionIncumbentDependencies } from "./status/incumbent";

/* The board draft's Orchestrator confirm surface (designate + inject) and its
   status read. Everything with behavior lives in
   `@/lib/orchestrator/seatCommand` — a route module may export only the
   documented route fields, so the logic sits where its tests can import it. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SeatStatus {
  project: string;
  displayName: string;
  seat: OrchestratorSeat | null;
  pending: OrchestratorSeat | null;
  /** The latest terminal failure still needing attention. Its durable history
      remains available after host recovery or a later successful designation. */
  lastFailure: SeatFailure | null;
  settledFailureRequestId: string | null;
  hostObservation: SeatHostObservation | null;
  /** Whether the active seat's transcript is still on disk; false invites a
      resume or a replacement from the same draft surface. */
  exists: boolean;
  viewerMcpRegistered: boolean;
  /** The seats that held the project before this one, newest first (#1841),
      each with the task that keeps its notes. */
  previous: PreviousSeatRow[];
  /** The task that keeps the CURRENT seat's notes, with its title and whether
      it has notes at all (#1841). Carried on the answer because the phone's
      seat screens and the collapsed strip name the live seat without holding
      the project's task list. */
  currentTask: SeatNotesTask | null;
  /** Every conversation ANY project's seat record names (#1841), from the same
      read. A surface that spans projects — the Overview's board — keeps seat conversations out of its rows wherever they are seated, and a
      seat of another project is no more a task than this project's is. Null
      when the record could not be read, which hides nothing. */
  all: SeatConversations | null;
  /** The active seat's deputies, the live one and the newest ended ones;
      absent when it has none, so an answer without them is unchanged. */
  deputies?: SeatDeputyView[];
}

/** The project-less read (`?scope=all`): the Overview names no project, so it
    is answered with the cross-project seat conversations alone. */
interface SeatConversationsAnswer {
  all: SeatConversations | null;
}

interface PreviousSeatRow extends PreviousOrchestratorSeat {
  title: string | null;
  taskId: string | null;
  /** Whether that task carries notes; a seat with none draws no Notes control. */
  hasNotes: boolean;
}

interface SeatFailure {
  error: string;
  clientRequestId: string;
  seatEpoch: number;
  conversationId: string | null;
  predecessorConversationId?: string | null;
  designatedAt: string;
  terminalizedAt: string;
  automaticReplacement?: { conversationId: string; seatEpoch: number };
}

export async function GET(req: NextRequest): Promise<NextResponse<SeatStatus | SeatConversationsAnswer | ApiError>> {
  return withViewerOperation("seat.panel", async () => {
  let project = req.nextUrl.searchParams.get("project")?.trim() ?? "";
  let displayName = project;
  const cwd = req.nextUrl.searchParams.get("cwd")?.trim() || undefined;
  if (req.nextUrl.searchParams.get("scope")?.trim() === "all") {
    return NextResponse.json({ all: withDeputyRefs(allSeatConversationsIn(readOrchestratorSeatFileOrNull()), readDeputyFileOrNull()) });
  }
  if (!project) return NextResponse.json({ error: "project is required" }, { status: 400 });
  try {
    ({ project, displayName } = resolveSeatProject(project, cwd, undefined, isCanonicalProjectId(canonicalProject(project))
      ? { reconcileExistingSeats: false, includeActiveSeats: false }
      : {}));
  }
  catch (error) {
    // Historical unknown keys remain readable while their identity is unproven.
    if (!(error instanceof ProjectNameRefusal)) throw error;
    if (error.details.code !== "unknown_project") return NextResponse.json({ error: error.message, ...error.details }, { status: 400 });
  }
  const home = process.env.HOME?.trim() || os.homedir();
  /* ONE read of the seat record for the whole answer. Every part of it — this
     project's seat, the seats that held it before, and the conversations every
     OTHER project's seat names — comes out of the same parse: this is a poll,
     and three readers of one document would re-read and re-parse it three
     times per tick for one answer. */
  const record = await seatRecordReconciled(project);
  const deputyFile = readDeputyFileOrNull();
  const deputies = deputyFile?.deputies ?? null;
  const { active, pending, history } = orchestratorSeatIn(record, project);
  const failed = [...history].reverse().find((entry) => entry.seat.intent.error !== null);
  const failure: SeatFailure | null = failed ? {
    error: failed.seat.intent.error ?? "",
    clientRequestId: failed.seat.intent.clientRequestId,
    seatEpoch: failed.seat.seatEpoch,
    conversationId: failed.seat.conversationId,
    predecessorConversationId: failed.seat.predecessorConversationId ?? null,
    designatedAt: failed.seat.designatedAt,
    terminalizedAt: failed.terminalizedAt,
    ...(failed.seat.intent.automaticReplacement ? { automaticReplacement: failed.seat.intent.automaticReplacement } : {}),
  } : null;
  let hostObservation: SeatHostObservation | null = null;
  // Only a still-current failure needs the targeted host read; healthy polls
  // and failures superseded by a successful designation keep their cheap read.
  if (active?.conversationId && currentSeatFailure(failure, active)) {
    const observedAt = new Date().toISOString();
    try {
      const liveness = await productionIncumbentDependencies.liveness(active.conversationId as ViewerConversationId);
      if (liveness) hostObservation = { conversationId: active.conversationId, seatEpoch: active.seatEpoch, hostState: liveness.hostState, observedAt };
    } catch { /* Unknown liveness cannot clear a failure. The next poll retries. */ }
  }
  const retired = previousOrchestratorSeatsIn(record, project);
  /* The task store is read only when there is a seat to find notes for. A
     failed read leaves the rows without notes; the seat answer still stands. */
  let tasks: ReturnType<typeof loadTasksForList> = [];
  if (retired.length || active) {
    try { tasks = loadTasksForList(); } catch { tasks = []; }
  }
  const seatDeputies = active?.conversationId && deputies
    ? deputiesForSeatIn(deputies, active.conversationId).map(seatDeputyView)
    : [];
  const taskForSeat = seatTaskLookup(tasks, project);
  const previous: PreviousSeatRow[] = retired.map((seat) => {
    const task = taskForSeat(seat);
    return { ...seat, title: task?.title ?? null, taskId: task?.taskId ?? null, hasNotes: task?.hasNotes ?? false };
  });
  return NextResponse.json({
    project, displayName,
    seat: active,
    pending,
    lastFailure: currentSeatFailure(failure, active, hostObservation),
    settledFailureRequestId: failure?.clientRequestId ?? null,
    hostObservation,
    exists: active !== null && (active.path === null || fs.existsSync(active.path)),
    viewerMcpRegistered: viewerMcpRegistered(home, cwd),
    previous,
    currentTask: active ? taskForSeat(active) : null,
    all: withDeputyRefs(allSeatConversationsIn(record), deputyFile),
    /* docs/design/ghost-seat.md §5: the seat's feed draws each deputy's block
       from these, and the seat head and card point at the live one. */
    ...(seatDeputies.length ? { deputies: seatDeputies } : {}),
  });
  });
}

/**
 * The seat record, with this project's designation brought up to date with the
 * launch it rests on.
 *
 * Only a designation that still WAITS on a launch costs anything: a pending
 * spawn intent, or a seat activated on an accepted launch whose transcript has
 * not appeared. Those are the two records that used to stay as they were until
 * somebody posted to the seat route again, so the pane read «creating» for as
 * long as it was open while the task card said the launch had failed. Every
 * other read is the one parse it always was.
 */
async function seatRecordReconciled(project: string): Promise<ReturnType<typeof readOrchestratorSeatFileOrNull>> {
  const record = readOrchestratorSeatFileOrNull();
  const { active, pending } = orchestratorSeatIn(record, project);
  const waiting = (pending?.intent.mode === "spawn" && pending.intent.error === null)
    || (active?.intent.mode === "spawn" && active.path === null && active.conversationId !== null);
  if (!waiting) return record;
  try {
    await reconcileOrchestratorSeatLaunch(project);
  } catch (error) {
    /* A busy store or a registry that could not be read changes nothing: the
       record is answered as it stands and the next poll asks again. */
    console.warn("[orchestrator seat] the designation could not be reconciled", error instanceof Error ? error.name : "unknown");
    return record;
  }
  return readOrchestratorSeatFileOrNull();
}

/** The seat record's conversations with every deputy's beside them (trimmed
    ones included, from what their records left on file), so the
    task bands and lists leave a seat's parallel self out with the seat. An
    unreadable deputy file, or one with no deputy, adds nothing. */
function withDeputyRefs(all: SeatConversations | null, file: { deputies: readonly OrchestratorDeputy[]; retired: readonly RetiredDeputyRef[] } | null): (SeatConversations & { deputies?: { conversationIds: string[]; paths: string[] } }) | null {
  if (!all) return null;
  const refs = file ? deputyConversationRefsIn(file.deputies, file.retired) : null;
  return refs && (refs.conversationIds.length || refs.paths.length) ? { ...all, deputies: refs } : all;
}

export async function POST(req: NextRequest): Promise<NextResponse<Record<string, unknown> | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return NextResponse.json({ ...await rejection.json(), admission: "refused" }, { status: rejection.status });
  /* Designation is operator-only for the same reason the legacy record's is:
     every manager gate keys off "is this a designated conversation", so a
     worker able to seat itself would inherit the manager surface in one move.
     Checked before the body is read; a refusal changes nothing. */
  const operator = requireOperatorAuthority(req);
  if (!operator.ok) {
    return NextResponse.json({ error: operator.error, admission: "refused" }, { status: operator.status });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON", admission: "refused" }, { status: 400 });
  }
  const result = await executeOrchestratorSeatRequest(body);
  return NextResponse.json(result.body, { status: result.status });
}
