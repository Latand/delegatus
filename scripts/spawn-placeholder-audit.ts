/*
 * Read-only spawn placeholder inventory (#342).
 *
 * Run before and after deploying the projection retirement bound to prove the
 * no-loss contract: receipts, conversations, lineage edges, tasks, and
 * transcripts must be identical, while the projected placeholder count
 * converges to the recent window. The script never writes anything.
 *
 *   bun scripts/spawn-placeholder-audit.ts
 */
/* This operator audit deliberately reads the live registry, tasks and scan
   roots. The claim must precede their module graph; startup mutations remain
   fenced to the serving Viewer and runtime host. */
import "@/lib/state/owner/tool";

import fs from "node:fs";

import { agentRegistry } from "@/lib/agent/registry";
import { preallocatedStructuredSpawnCards } from "@/lib/agent/spawnProjection";
import { listFiles } from "@/lib/scanner";
import { loadTasks } from "@/lib/tasks/store";

async function main(): Promise<void> {
  const snapshot = agentRegistry().readOnlySnapshot();
  const receiptsByState: Record<string, number> = {};
  for (const receipt of Object.values(snapshot.receipts)) {
    receiptsByState[receipt.state] = (receiptsByState[receipt.state] ?? 0) + 1;
  }
  const files = await listFiles();
  const transcripts = files.filter((entry) => entry.path.endsWith(".jsonl"));
  const onDiskTranscripts = transcripts.filter((entry) => fs.existsSync(entry.path));
  const placeholders = preallocatedStructuredSpawnCards(files, snapshot);
  const placeholdersByReason: Record<string, number> = {};
  for (const card of placeholders) {
    const reason = card.activityReason ?? "unknown";
    placeholdersByReason[reason] = (placeholdersByReason[reason] ?? 0) + 1;
  }
  const tasks = loadTasks();
  const assignmentsByState: Record<string, number> = {};
  for (const task of tasks) {
    for (const assignment of task.assignments) {
      assignmentsByState[assignment.state] = (assignmentsByState[assignment.state] ?? 0) + 1;
    }
  }

  console.log(JSON.stringify({
    auditedAt: new Date().toISOString(),
    registry: {
      receipts: Object.keys(snapshot.receipts).length,
      receiptsByState,
      conversations: Object.keys(snapshot.conversations).length,
      lineageEdges: Object.keys(snapshot.lineageEdges).length,
      memberships: Object.keys(snapshot.memberships).length,
      heldDeliveries: Object.keys(snapshot.heldDeliveries).length,
    },
    scan: {
      transcripts: transcripts.length,
      onDiskTranscripts: onDiskTranscripts.length,
    },
    projection: {
      placeholders: placeholders.length,
      placeholdersByReason,
    },
    tasks: {
      tasks: tasks.length,
      assignmentsByState,
    },
  }, null, 2));
}

await main();
