import fs from "node:fs";

import { agentRegistry } from "@/lib/agent/registry";
import { projectSuccessionFor, recordProjectSuccessions, type ProjectSuccession } from "@/lib/projects/succession";

import { activeOrchestratorSeats, orchestratorSeatFor, type OrchestratorSeat } from "./seats";

function isDirectory(candidate: string): boolean {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}

/** The checkout a seat's conversation was launched in, newest generation first. */
export function seatLaunchCwd(conversationId: string): string | null {
  const conversation = agentRegistry().conversation(conversationId as `conversation_${string}`);
  if (!conversation) return null;
  for (let index = conversation.generations.length - 1; index >= 0; index -= 1) {
    const candidate = conversation.generations[index]?.launchProfile?.cwd;
    if (candidate && isDirectory(candidate)) return candidate;
  }
  return null;
}

export type SeatCwdOf = (conversationId: string) => string | null;

function successionForSeat(seat: OrchestratorSeat, cwdOf: SeatCwdOf): ProjectSuccession | null {
  if (!seat.conversationId) return null;
  let cwd: string | null = null;
  try { cwd = cwdOf(seat.conversationId); } catch { cwd = null; }
  return projectSuccessionFor(seat.project, cwd);
}

/**
 * Detect and record the identity successions the seated projects owe (#1874):
 * a seat designated before its folder gained a repository or an origin is keyed
 * by the folder's old identity, while every lane it creates is keyed by the new
 * one. Recording the succession re-keys the seat through the seat store's own
 * canonical read, epoch and authority intact, and with it the tasks, board and
 * bindings of the old key. Idempotent; the seat tick runs it at boot and before
 * every sweep.
 */
export function recordSeatProjectSuccessions(cwdOf: SeatCwdOf = seatLaunchCwd): ProjectSuccession[] {
  return recordProjectSuccessions(activeOrchestratorSeats().map((seat) => successionForSeat(seat, cwdOf)));
}

/**
 * The project a seat serves NOW: the key its folder resolves to when the seat's
 * own key is a path identity that folder has since moved on from, else its own.
 * The seat tick and attention authority read seats through this, so a seat is
 * its project's seat before its succession is recorded, and whenever it cannot
 * be.
 */
export function seatProjectNow(seat: OrchestratorSeat, cwdOf: SeatCwdOf = seatLaunchCwd): string {
  return successionForSeat(seat, cwdOf)?.target ?? seat.project;
}

/** Active seats, each under the project it serves now. */
export function activeSeatsByCurrentProject(cwdOf: SeatCwdOf = seatLaunchCwd): OrchestratorSeat[] {
  return activeOrchestratorSeats().map((seat) => {
    const project = seatProjectNow(seat, cwdOf);
    return project === seat.project ? seat : { ...seat, project };
  });
}

/** {@link orchestratorSeatFor}, falling back to the seat whose folder now
    resolves to `project` when none is stored under it. */
export function orchestratorSeatForCurrentProject(project: string, cwdOf: SeatCwdOf = seatLaunchCwd): ReturnType<typeof orchestratorSeatFor> {
  const stored = orchestratorSeatFor(project);
  if (stored.active) return stored;
  const moved = activeSeatsByCurrentProject(cwdOf).find((seat) => seat.project === project) ?? null;
  return moved ? { ...stored, active: moved } : stored;
}
