import { NextRequest, NextResponse } from "next/server";

import { callerConversationId } from "@/lib/agent/operatorAuthority";
import {
  applySeatTickSettingsChange,
  readSeatTickSettings,
  writeSeatTickSettings,
  type SeatTickSettingsActor,
  type SeatTickSettingsChange,
} from "@/lib/monitor/seatTickSettings";
import { seatTickSettingsAnswer, type SeatTickSettingsAnswer } from "@/lib/monitor/seatTickSettingsAnswer";
import { canonicalOrchestratorProject, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One project's seat tick, read and changed from the browser (#1681).
 *
 * A thin route over the authoritative module, and deliberately nothing more:
 * every rule, every refusal's wording, the redaction and the prompt limit are
 * `applySeatTickSettingsChange`'s, exactly as they are for the
 * `seat_tick_settings` tool. There is no second settings model here, and no
 * validation of its own beyond the two things the tool's argument schema
 * covers instead — a project has to be named, and `untilMinutes` has to be a
 * positive number of minutes.
 *
 * Two properties worth stating:
 *
 * - **The answer is a READ of the record.** A write is followed by
 *   `readSeatTickSettings`, so what comes back is what a later check will
 *   read rather than the echo of what was sent. A change with no fields is a
 *   read, as the tool's is.
 * - **Nobody is refused; everybody is attributed.** Controls are a capability
 *   (`rotationActor`, #1402): the browser records as `gateway` — the
 *   operator's own session, which is what the board card already calls it — a
 *   caller that named itself with the target project's active seat records as
 *   `manager` with that seat's epoch, and any other identified caller records
 *   as `agent` with its conversation. Nothing in the body can name who made a
 *   change. The perimeter is `rejectCrossOrigin`, which runs first on the
 *   write, as it does on every other mutating route here.
 */

function projectFrom(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? canonicalOrchestratorProject(value.trim()) : null;
}

/**
 * Who this request is, decided from the request alone.
 *
 * A seat governing its OWN project is the `manager` the record already knows,
 * carrying the epoch of the seat it holds; the same seat naming another
 * project is an `agent` there, which is what the card prints and what makes a
 * foreign change visible.
 */
function settingsActor(req: NextRequest, project: string): SeatTickSettingsActor {
  const conversationId = callerConversationId(req);
  if (!conversationId) return { kind: "gateway", conversationId: null, project: null, seatEpoch: null };
  const active = orchestratorSeatFor(project).active ?? null;
  return active && active.conversationId === conversationId
    ? { kind: "manager", conversationId, project, seatEpoch: active.seatEpoch }
    : { kind: "agent", conversationId, project: null, seatEpoch: null };
}

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest): Promise<NextResponse<SeatTickSettingsAnswer | ApiError>> {
  const project = projectFrom(req.nextUrl.searchParams.get("project"));
  if (!project) return NextResponse.json({ error: "project is required" }, { status: 400 });
  try {
    return NextResponse.json(seatTickSettingsAnswer(project, false, settingsActor(req, project)), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "seat tick settings are unreadable" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse<SeatTickSettingsAnswer | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: Record<string, unknown>;
  try {
    const parsed = (await req.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const project = projectFrom(body.project);
  if (!project) return NextResponse.json({ error: "project is required" }, { status: 400 });

  /* Handed through unchecked and untyped on purpose: the module below is the
     one place that decides what each field may be, and it names the field and
     the rule in the refusal it returns. */
  const change: SeatTickSettingsChange = {};
  if (body.enabled !== undefined) change.enabled = body.enabled as boolean;
  if (body.wakeIntervalMinutes !== undefined) change.wakeIntervalMinutes = body.wakeIntervalMinutes as number | null;
  if (body.reason !== undefined) change.reason = body.reason as string | null;
  if (body.monitorPrompt !== undefined) change.monitorPrompt = body.monitorPrompt as string | null;
  /* Converted exactly as the tool converts it: an expiry is offered in minutes
     from now, because that is the form the caller decided in. */
  if (body.untilMinutes !== undefined) {
    const minutes = body.untilMinutes;
    if (minutes === null) change.until = null;
    else if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
      return NextResponse.json({ error: "untilMinutes must be a positive number of minutes, or null for a setting that stands until it is changed" }, { status: 400 });
    } else {
      change.until = new Date(Date.now() + minutes * 60_000).toISOString();
    }
  }

  try {
    /* Inside the try: attribution reads the seat file, and an unreadable one
       must answer as a failure rather than as an uncaught throw. */
    const actor = settingsActor(req, project);
    if (Object.keys(change).length === 0) {
      return NextResponse.json(seatTickSettingsAnswer(project, false, actor), { headers: NO_STORE });
    }
    const applied = applySeatTickSettingsChange(readSeatTickSettings(project), change, { at: new Date().toISOString(), actor });
    if (!applied.ok) return NextResponse.json({ error: applied.error }, { status: 400 });
    writeSeatTickSettings(project, applied.settings);
    return NextResponse.json(seatTickSettingsAnswer(project, true, actor), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "seat tick settings could not be written" }, { status: 500 });
  }
}
