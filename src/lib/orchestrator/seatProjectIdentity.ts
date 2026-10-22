import fs from "node:fs";
import { isCanonicalProjectId } from "@/lib/projects/identity";
import { namedProjectDirectory, resolveNamedProject, ProjectNameRefusal, type NamedProjectSources } from "@/lib/projects/nameResolution";
import { canonicalProject } from "@/lib/projects/aliases";
import { lastScannedFiles, lastScannedProjectCatalog } from "@/lib/scanner/scanCache";
import { projectInfoFromCwd } from "@/lib/scanner/describe";

import { agentRegistry } from "@/lib/agent/registry";
import { projectSuccessionFor, recordProjectSuccessions, type ProjectSuccession } from "@/lib/projects/succession";

import { activeOrchestratorSeats, orchestratorSeatFor, readOrchestratorSeatFileOrNull, type OrchestratorSeat } from "./seats";

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
export function recordSeatProjectSuccessions(cwdOf: SeatCwdOf = seatLaunchCwd, legacyOnly = false): ProjectSuccession[] {
  const file = readOrchestratorSeatFileOrNull();
  const seats = file ? [...Object.values(file.seats), ...Object.values(file.pending), ...file.history.map(row => row.seat)] : [];
  const pathMoves = legacyOnly ? [] : recordProjectSuccessions(Object.values(file?.seats ?? {}).map((seat) => successionForSeat(seat, cwdOf)));
  const legacy = seats.filter(seat => !isCanonicalProjectId(canonicalProject(seat.project)));
  if (!legacy.length) return pathMoves;
  const sources = seatProjectSources();
  const last = sources.lastCompletedCatalog?.();
  const roots = new Map<string, ReturnType<typeof projectInfoFromCwd>>();
  const seatRoots = new Map<OrchestratorSeat, string>();
  const blocked = new Set<string>();
  for (const seat of legacy) {
    let cwd: string | null = null;
    try { cwd = seat.conversationId ? cwdOf(seat.conversationId) : null; }
    catch { blocked.add(seat.project); }
    if (cwd) {
      seatRoots.set(seat, cwd);
      if (!roots.has(cwd)) roots.set(cwd, projectInfoFromCwd(cwd));
    }
  }
  const directory = namedProjectDirectory({ canonicalOnly: true, lastCompletedCatalog: () => ({
    files: last?.files ?? [], projectCatalog: [...(last?.projectCatalog ?? []),
      ...[...roots].flatMap(([cwd, info]) => info ? [{ ...info, projectRoot: cwd }] : []),
    ],
  }) });
  // Migration needs a unique name, even when only one candidate has a seat.
  directory.active.clear();
  const moves: ProjectSuccession[] = [];
  for (const seat of legacy) {
    try {
      let target = resolveNamedProject(seat.project, directory);
      const cwd = seatRoots.get(seat);
      pathMoves.push(...recordProjectSuccessions([projectSuccessionFor(target, cwd)]));
      const displayName = directory.labels.get(target) ?? target;
      target = canonicalProject(target);
      const info = roots.get(cwd ?? "");
      if (info && canonicalProject(info.project) !== target) { blocked.add(seat.project); continue; }
      if (isCanonicalProjectId(target)) moves.push({ source: seat.project, target, displayName });
    } catch (error) {
      if (!(error instanceof ProjectNameRefusal)) throw error;
      // Unproven or ambiguous identities stay separate until more evidence exists.
    }
  }
  return [...pathMoves, ...recordProjectSuccessions(moves.filter(move => !blocked.has(move.source)))];
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

/** The same retained-name resolver used by create_pipeline. A checkout may
 * introduce a new canonical identity, but cannot make an unknown name valid. */
export function resolveSeatProject(named: string, cwd?: string, sources: NamedProjectSources = seatProjectSources()): { project: string; displayName: string } {
  recordSeatProjectSuccessions(seatLaunchCwd, true);
  const info = cwd ? projectInfoFromCwd(cwd) : null;
  const last = sources.lastCompletedCatalog?.();
  const pending = isCanonicalProjectId(canonicalProject(named)) ? orchestratorSeatFor(named).pending : null;
  const directory = namedProjectDirectory({ ...sources, canonicalOnly: true,
    lastCompletedCatalog: () => ({ files: last?.files ?? [], projectCatalog: [
      ...(last?.projectCatalog ?? []), ...(info ? [{ ...info, projectRoot: cwd }] : []),
    ] }),
  }, pending ? [pending.project] : []);
  const resolved = resolveNamedProject(named, directory);
  const label = directory.labels.get(resolved) ?? resolved;
  const displayName = isCanonicalProjectId(label) ? info?.displayName ?? label : label;
  const succession = projectSuccessionFor(resolved, cwd);
  recordProjectSuccessions([succession ? { ...succession, displayName } : null]);
  const project = canonicalProject(resolved);
  if (info && project !== canonicalProject(info.project)) throw new ProjectNameRefusal("project contradicts the canonical project of cwd", {
    code: "project_mismatch", canonicalProject: canonicalProject(info.project), admission: "refused",
  });
  return { project, displayName };
}

function seatProjectSources(): NamedProjectSources {
  return { lastCompletedCatalog: () => {
    const projectCatalog = lastScannedProjectCatalog();
    const files = lastScannedFiles();
    return projectCatalog && files ? { projectCatalog, files } : null;
  } };
}
