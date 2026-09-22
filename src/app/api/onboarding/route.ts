import fs from "node:fs";

import { NextRequest, NextResponse } from "next/server";

import { statePath } from "@/lib/configDir";
import { applyOnboardingPatch, parseOnboardingPatch, readOnboardingMarker, resolveOnboardingMarker, writeOnboardingMarker } from "@/lib/onboarding/marker";
import { DEFAULT_SEAT_TICK_POLICY, seatTickPolicy } from "@/lib/monitor/seatTick";
import { readOrchestratorSeatFile } from "@/lib/orchestrator/seats";
import { loadPipelines } from "@/lib/pipelines/store";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { loadTasks } from "@/lib/tasks/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Viewer-written state that marks an upgrade rather than a first run (#1876). */
function existingInstall(): boolean {
  const seats = readOrchestratorSeatFile();
  if (Object.keys(seats.seats).length || Object.keys(seats.pending).length || seats.revocations.length) return true;
  if (loadPipelines().length) return true;
  if (loadTasks().length) return true;
  return fs.existsSync(statePath("role-presets.json"));
}

/** The setup guide's marker; `marker: null` means it was never decided and the
    guide opens. The seat tick's check interval rides along for the tour's seat
    card, which names it; a tick turned off reads as the shipped interval. */
export async function GET(): Promise<NextResponse> {
  try {
    const checkIntervalMs = seatTickPolicy()?.checkIntervalMs ?? DEFAULT_SEAT_TICK_POLICY.checkIntervalMs;
    return NextResponse.json({ marker: resolveOnboardingMarker(existingInstall), seatTickCheckMinutes: Math.round(checkIntervalMs / 60_000) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const patch = parseOnboardingPatch(body);
  if (typeof patch === "string") return NextResponse.json({ error: patch }, { status: 400 });
  try {
    const marker = applyOnboardingPatch(readOnboardingMarker(), patch, new Date().toISOString());
    writeOnboardingMarker(marker);
    return NextResponse.json({ marker });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
