import fs from "node:fs";
import os from "node:os";

import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { viewerMcpRegistered } from "@/lib/agent/spawnPolicy";
import { executeOrchestratorSeatRequest } from "@/lib/orchestrator/seatCommand";
import { allSeatConversationsIn, orchestratorSeatIn, previousOrchestratorSeatsIn, readOrchestratorSeatFileOrNull, seatTaskOf, type OrchestratorSeat, type PreviousOrchestratorSeat, type SeatConversations, type SeatNotesTask } from "@/lib/orchestrator/seats";
import { loadTasks } from "@/lib/tasks/store";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

/* The board draft's Orchestrator confirm surface (designate + inject) and its
   status read. Everything with behavior lives in
   `@/lib/orchestrator/seatCommand` — a route module may export only the
   documented route fields, so the logic sits where its tests can import it. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SeatStatus {
  seat: OrchestratorSeat | null;
  pending: OrchestratorSeat | null;
  /** The last designation attempt that FAILED, once it has left the pending
      position (issue #1757). A failure is terminalized into durable history the
      moment it happens, so without this the panel's reason banner would vanish
      the instant the record became complete — and a failure the operator did
      not personally submit (a rotation ordered from a seat, an accepted launch
      that died) would never reach them at all. */
  lastFailure: SeatFailure | null;
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
      read. A surface that spans projects — the Tasks panel in its «all» scope —
      keeps seat conversations out of its rows wherever they are seated, and a
      seat of another project is no more a task than this project's is. Null
      when the record could not be read, which hides nothing. */
  all: SeatConversations | null;
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
  designatedAt: string;
  terminalizedAt: string;
}

export async function GET(req: NextRequest): Promise<NextResponse<SeatStatus | SeatConversationsAnswer | ApiError>> {
  const project = req.nextUrl.searchParams.get("project")?.trim() ?? "";
  if (req.nextUrl.searchParams.get("scope")?.trim() === "all") {
    return NextResponse.json({ all: allSeatConversationsIn(readOrchestratorSeatFileOrNull()) });
  }
  if (!project) return NextResponse.json({ error: "project is required" }, { status: 400 });
  const cwd = req.nextUrl.searchParams.get("cwd")?.trim() || undefined;
  const home = process.env.HOME?.trim() || os.homedir();
  /* ONE read of the seat record for the whole answer. Every part of it — this
     project's seat, the seats that held it before, and the conversations every
     OTHER project's seat names — comes out of the same parse: this is a poll,
     and three readers of one document would re-read and re-parse it three
     times per tick for one answer. */
  const record = readOrchestratorSeatFileOrNull();
  const { active, pending, history } = orchestratorSeatIn(record, project);
  const failed = [...history].reverse().find((entry) => entry.seat.intent.error !== null);
  const retired = previousOrchestratorSeatsIn(record, project);
  /* The task store is read only when there is a seat to find notes for. A
     failed read leaves the rows without notes; the seat answer still stands. */
  let tasks: ReturnType<typeof loadTasks> = [];
  if (retired.length || active) {
    try { tasks = loadTasks(); } catch { tasks = []; }
  }
  const previous: PreviousSeatRow[] = retired.map((seat) => {
    const task = seatTaskOf(tasks, project, seat);
    return { ...seat, title: task?.title ?? null, taskId: task?.taskId ?? null, hasNotes: task?.hasNotes ?? false };
  });
  return NextResponse.json({
    seat: active,
    pending,
    lastFailure: failed
      ? {
        error: failed.seat.intent.error ?? "",
        clientRequestId: failed.seat.intent.clientRequestId,
        seatEpoch: failed.seat.seatEpoch,
        conversationId: failed.seat.conversationId,
        designatedAt: failed.seat.designatedAt,
        terminalizedAt: failed.terminalizedAt,
      }
      : null,
    exists: active !== null && (active.path === null || fs.existsSync(active.path)),
    viewerMcpRegistered: viewerMcpRegistered(home, cwd),
    previous,
    currentTask: active ? seatTaskOf(tasks, project, active) : null,
    all: allSeatConversationsIn(record),
  });
}

export async function POST(req: NextRequest): Promise<NextResponse<Record<string, unknown> | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  /* Designation is operator-only for the same reason the legacy record's is:
     every manager gate keys off "is this a designated conversation", so a
     worker able to seat itself would inherit the manager surface in one move.
     Checked before the body is read; a refusal changes nothing. */
  const operator = requireOperatorAuthority(req);
  if (!operator.ok) {
    return NextResponse.json({ error: operator.error }, { status: operator.status });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const result = await executeOrchestratorSeatRequest(body);
  return NextResponse.json(result.body, { status: result.status });
}
