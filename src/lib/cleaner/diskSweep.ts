import fs from "node:fs";
import path from "node:path";
import { agentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { pipelineActivitySettled } from "@/lib/pipelines/types";
import { liveOrWaitingConversationCwds } from "@/lib/pipelines/worktreeSweep";
import { assertRetentionTestPath, retentionUnderTest } from "@/lib/retentionTestSafety";
import { AttemptTempStore, sweepAttemptTemps, type AttemptTempSweepOptions } from "@/lib/runtime/attemptTempRetention";
import { attemptTempAuthority } from "@/lib/runtime/attemptTempProduction";
import { attemptProcessReferencesClear, attemptReferencesClear } from "@/lib/runtime/attemptTempFilesystem";
import { attemptTempConfigParent } from "@/lib/runtime/attemptTempPaths";
import { attemptTempRemaining } from "@/lib/runtime/attemptTempDeadline";
import { runTemporaryDataSweep } from "@/lib/runtime/temporaryDataProduction";
import { retentionProcessScan } from "@/lib/selfUpdate/retentionInspection";
// eslint-disable-next-line no-restricted-imports -- Runs in the leased sweep helper, never on the Viewer loop.
import { scanProcesses } from "@/lib/tempSweep";
import { diskCleanerAllowed, readDiskCleanerPass } from "./diskState";
import { cleanerJournal, diskCleanerStateFile, type CleanerHold, type CleanerSlice } from "./diskJournal";

const THREE_HOURS = 3 * 60 * 60_000;
export type CleanerSweepRequest =
  | { id: string; class: "attempt-temp"; after: string }
  | { id: string; class: "evidence" };
export type CleanerSweepResult = CleanerSlice & { next: string | null; more: boolean };

function productionScan(directories: readonly string[]) {
  if (retentionUnderTest()) throw new Error("disk cleaner tests must supply a private process scan");
  const view = retentionProcessScan(path.dirname(directories[0]!));
  if (view.uncertain?.length) throw new Error("process reference inventory contains unreadable owners");
  // Preserve the full cwd inventory for checkout links as well as the
  // stricter observer's cross-mount references.
  const full = scanProcesses("/proc", directories);
  if (!full.ownNamespace) throw new Error("process reference inventory unavailable");
  return { ...full, processes: [...full.processes, ...view.processes] };
}

function scratchRoot(directory: string): boolean {
  const parent = path.dirname(directory), name = path.basename(directory);
  const admitted = parent === statePath("scratch") && /^llv-(?:read-only-stage|stage)-[A-Za-z0-9]{6}$/.test(name)
    || parent === attemptTempConfigParent() && /^llv-stage-config-[A-Za-z0-9]{6}$/.test(name);
  if (!admitted) return false;
  assertRetentionTestPath(directory);
  return fs.realpathSync(parent) === parent && !fs.existsSync(path.join(parent, ".delegatus-keep"));
}

function openLaneUses(directory: string): boolean {
  const overlaps = (other: string | null) => !!other && (
    other === directory || other.startsWith(directory + path.sep) || directory.startsWith(other + path.sep)
  );
  return loadPipelinesForList().some(lane => (lane.state !== "closed" && lane.state !== "completed" || !pipelineActivitySettled(lane))
    && (overlaps(lane.worktreeDir) || overlaps(lane.repoDir)))
    || liveOrWaitingConversationCwds(agentRegistry().worktreeProtectionSnapshot()).some(overlaps);
}

/** Runs in the leased sweep helper. The ledger and its owner perform the
 * removal. The cleaner supplies a bounded selection and tighter guards. */
export async function runCleanerSweep(request: CleanerSweepRequest, ports: {
  scan?: AttemptTempSweepOptions["scan"];
  containerReferences?: (roots: readonly string[]) => Promise<boolean>;
  now?: () => number;
} = {}): Promise<CleanerSweepResult> {
  const empty = { kept: [], errors: 0, next: null, more: false };
  const mode = readDiskCleanerPass()?.mode;
  const allowed = () => diskCleanerAllowed(request.id);
  if (!mode || !allowed()) return empty;
  const scan = ports.scan ?? productionScan;
  const journal = cleanerJournal(request.id, request.class);
  if (request.class === "evidence") {
    const report = await runTemporaryDataSweep({ scan, now: ports.now, containerReferences: ports.containerReferences,
      cleaner: { allowed, journal, processClear: (original, target) => attemptProcessReferencesClear(original, target, scan([original, target])) } },
      { ...process.env, LLV_TEMP_SWEEP: mode }, Date.now() + attemptTempRemaining(8000));
    return report ? { ...empty, kept: report.keptRows, errors: report.errors, more: report.more } : empty;
  }
  const store = new AttemptTempStore();
  try {
    const page = store.cleanerRoots(request.after);
    const kept: CleanerHold[] = [];
    const selected = new Map(page.filter(row => {
      try { if (scratchRoot(row.directory)) return true; } catch { /* Preserve unreadable ancestry. */ }
      kept.push({ path: row.directory, bytes: row.bytes, reason: "scratch ancestry or keep marker" });
      return false;
    }).map(row => [row.directory, row]));
    const authority: NonNullable<AttemptTempSweepOptions["authority"]> = (owner, inventory) =>
      attemptTempAuthority(owner, inventory, ports.now ?? Date.now, 0, true);
    const report = selected.size ? await sweepAttemptTemps(store, {
      now: ports.now, mode, scan, authority, state: async (owner, inventory) => (await authority(owner, inventory)).state,
      references: ports.containerReferences && ((original, target, observation) =>
        attemptReferencesClear(original, target, observation, ports.containerReferences)),
      runBudgetMs: 40_000,
      selection: {
        directories: [...selected.keys()],
        current: owner => {
          const row = selected.get(owner.directory);
          return !!row && row.identity === owner.identity && row.pipelineId === owner.pipelineId
            && row.launchId === owner.launchId && row.createdAt === owner.createdAt
            && row.released === owner.released && row.retainUntilClose === owner.retainUntilClose
            && scratchRoot(owner.directory) && !openLaneUses(owner.directory);
        },
        watches: [diskCleanerStateFile(), statePath("viewer-release.json"), statePath("scratch"), attemptTempConfigParent()]
          .filter(file => fs.existsSync(file)),
      },
      cleaner: { idleMs: THREE_HOURS, allowed, journal },
    }) : null;
    for (const row of report?.outcomes ?? []) {
      if (row.disposition !== "removed") kept.push({ path: row.directory, bytes: row.bytes, reason: row.reason });
    }
    // A slice can run out of budget before reaching its last item. Resume
    // after the last visited target; a single difficult root cannot starve
    // the page because its own owner already had a bounded inspection.
    const untouched = report?.outcomes.find(row => row.reason === "run budget exhausted; retry selected root");
    const last = untouched && page[0]?.directory !== untouched.directory
      ? page[page.findIndex(row => row.directory === untouched.directory) - 1] : page.at(-1);
    const more = !!untouched || page.length === 16;
    return { kept, errors: report?.errors ?? 0, next: more ? last?.directory ?? null : null, more };
  } finally { store.close(); }
}
