import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { waitForStateLock } from "@/lib/state/lockWait";
import { yieldToRuntime } from "@/lib/cooperative";
import { findPipelineRecord } from "@/lib/pipelines/store";
import { pipelineActivitySettled, type Pipeline } from "@/lib/pipelines/types";
import { memorySelection, roleSelectionCollection, selectionKey, type RoleMemorySelection } from "./roleSelection";

export const ROLE_SELECTION_RETENTION_MS = 86_400_000;
type Settlement = (row: RoleMemorySelection) => Promise<string | null>;
function settlementFrom(pipeline: Pipeline | null, row: RoleMemorySelection): string | null {
  const run = pipeline?.runs.find(run => run.stageId === row.stageId);
  const attempt = run?.attempts.find(attempt => attempt.n === row.attempt);
  if (!pipeline || !attempt?.completedAt || !["passed", "failed", "skipped"].includes(attempt.state)
    || attempt.unresolvedTermination || attempt.activation && attempt.activation.phase !== "settled") return null;
  if (pipeline.unconfirmedHosts?.some(host => host.stageId === row.stageId && host.attempt === row.attempt)
    || ["completed", "closed"].includes(pipeline.state) && !pipelineActivitySettled(pipeline)) return null;
  // A passed report can still owe publication or a producer repair turn.
  if (pipeline.cursor?.stageId === row.stageId && run?.attempts.filter(attempt => !attempt.historical).at(-1)?.n === row.attempt) return null;
  const reap = pipeline.terminalReap?.settledAttempts.includes(`${row.stageId}:${row.attempt}`) ? pipeline.terminalReap : null;
  const times = [attempt.completedAt, pipeline.closedAt, pipeline.delivery?.releasedAt, reap?.lastAt, reap?.settledAt]
    .flatMap(at => at && Number.isFinite(Date.parse(at)) ? [Date.parse(at)] : []);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}
const settledAt: Settlement = async row => settlementFrom(findPipelineRecord(row.pipelineId), row);
/** One page per minute. Unproven settlement retains the row. The caller owns
 * the cursor; no tick reads the complete selection or pipeline collection. */
export async function sweepRoleSelections(after = "", now = Date.now(), settlement: Settlement = settledAt, active = () => true): Promise<string> {
  return withViewerOperation("memory.select", async () => {
    if (!active()) return after;
    const store = roleSelectionCollection();
    if (!store) return "";
    let page: RoleMemorySelection[];
    try { page = store.keyPage(after, 32); } finally { store.close(); }
    const expired = (at: string | null) => at !== null && Number.isFinite(Date.parse(at)) && now - Date.parse(at) >= ROLE_SELECTION_RETENTION_MS;
    for (const row of page) {
      await yieldToRuntime();
      if (!active()) return after;
      if (!expired(await settlement(row))) continue;
      await waitForStateLock("memory.selection-retention", async () => {
        const observed = await settlement(row);
        if (!expired(observed) || !active()) return;
        // Open the pipeline reader before taking the writer; its cold boot may
        // need collection initialization under this asynchronous admission.
        findPipelineRecord(row.pipelineId);
        const current = memorySelection(row);
        if (!current || JSON.stringify(current) !== JSON.stringify(row)) return;
        const writer = roleSelectionCollection()!;
        try { writer.boundedPatch(2, tx => {
          // This database writer excludes a concurrent pipeline transition.
          // Re-read the authoritative settlement inside its commit boundary.
          const pipeline = findPipelineRecord(row.pipelineId);
          const proof = pipeline || settlement === settledAt ? settlementFrom(pipeline, row) : observed;
          if (active() && expired(proof) && JSON.stringify(tx.get(selectionKey(row))) === JSON.stringify(row)) tx.delete(selectionKey(row));
        }); } finally { writer.close(); }
      });
    }
    return page.length === 32 ? selectionKey(page.at(-1)!) : "";
  });
}

const owner = globalThis as typeof globalThis & { __delegatusRoleSelectionRetention?: ReturnType<typeof createRoleSelectionRetention> };
export function createRoleSelectionRetention(ports: {
  active?: () => Promise<boolean>;
  sweep?: typeof sweepRoleSelections;
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
} = {}) {
  let stopped = false, cursor = "", timer: ReturnType<typeof setTimeout> | undefined;
  const schedule: NonNullable<typeof ports.schedule> = ports.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const active = ports.active ?? (async () => (await import("@/lib/viewerInstrumentation")).viewerReleaseOwnsTraffic());
  const arm = () => {
    if (stopped) return;
    timer = schedule(() => {
      void (async () => {
        if (!await active() || stopped) { stopped = true; return; }
        cursor = await (ports.sweep ?? sweepRoleSelections)(cursor, Date.now(), undefined, () => !stopped);
      })().catch(error => console.warn("[role-memory] selection retention unavailable", error instanceof Error ? error.name : "unknown")).finally(arm);
    }, 60_000);
    timer.unref?.();
  };
  arm();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
/** Only the Viewer startup path starts this clock; importing launch policy
 * in a build, MCP process or agent never starts a background writer. */
export function startRoleSelectionRetention(): void {
  owner.__delegatusRoleSelectionRetention ??= createRoleSelectionRetention();
}
