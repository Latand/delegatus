/*
 * Settle the «Untitled task» backlog: placeholder tasks nothing will ever
 * name or work on (docs/settle-ghost-tasks.md).
 *
 * Dry run by default: prints what it would mark done, per project and kind,
 * and what it keeps and why. `--apply` marks those tasks done. Nothing is ever
 * deleted — a deleted task mints a replacement placeholder for each of its
 * conversations. The state directory is named explicitly, never assumed:
 *
 *   bun scripts/settle-ghost-tasks.ts --state-dir <dir>            # dry run
 *   bun scripts/settle-ghost-tasks.ts --state-dir <dir> --apply
 *   bun scripts/settle-ghost-tasks.ts --state-dir <dir> --idle-hours 12
 *
 * The output carries project keys and counts only: no titles, no paths.
 */
/* FIRST: the claim precedes the modules below, which resolve the state
   directory while they load (#1905). An operator run administers live state;
   startup mutations stay fenced to the Viewer and the runtime host. */
import "../src/lib/state/owner/tool";

import fs from "node:fs";
import path from "node:path";

interface Options {
  stateDir: string;
  apply: boolean;
  idleHours: number;
}

function parseOptions(argv: readonly string[]): Options {
  let stateDir: string | null = null;
  let apply = false;
  let idleHours = 6;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--apply") apply = true;
    else if (argument === "--dry-run") apply = false;
    else if (argument === "--state-dir") stateDir = argv[++index] ?? null;
    else if (argument === "--idle-hours") idleHours = Number(argv[++index]);
    else throw new Error(`unknown argument ${argument}`);
  }
  if (!stateDir) throw new Error("--state-dir <dir> is required: name the state directory this run settles");
  if (!Number.isFinite(idleHours) || idleHours < 1) throw new Error("--idle-hours must be a number of hours, at least 1");
  return { stateDir: path.resolve(stateDir), apply, idleHours };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!fs.existsSync(options.stateDir)) throw new Error(`state directory ${options.stateDir} does not exist`);
  /* Before any store loads: every store resolves its file from this. */
  process.env.LLV_STATE_DIR = options.stateDir;
  const { loadPipelines } = await import("../src/lib/pipelines/store");
  const { loadTasks, mutateTasks } = await import("../src/lib/tasks/store");
  const { applyGhostSettlement, planGhostSettlement } = await import("../src/lib/tasks/ghostSettlement");
  const { allSeatConversations } = await import("../src/lib/orchestrator/seats");

  const pipelineTaskIds = new Set(loadPipelines().flatMap((pipeline) => pipeline.taskIds ?? []));
  /* An unreadable seat record would let an active seat's task close: refuse. */
  const seats = allSeatConversations();
  if (!seats) throw new Error("the orchestrator seat record could not be read; nothing was settled");
  const seatIdentities = new Set([...seats.conversationIds, ...seats.paths]);
  const transcript = (file: string) => {
    try {
      return { mtimeMs: fs.statSync(file).mtimeMs };
    } catch {
      return { mtimeMs: null };
    }
  };
  const input = { pipelineTaskIds, seatIdentities, transcript, nowMs: Date.now(), idleMs: options.idleHours * 3_600_000 };
  const plan = planGhostSettlement({ ...input, tasks: loadTasks() });

  let settled: string[] = [];
  if (options.apply && plan.totals.settle > 0) {
    settled = mutateTasks((tasks) => {
      const outcome = applyGhostSettlement(tasks, plan, input, new Date().toISOString());
      return { tasks: outcome.settled.length ? outcome.tasks : undefined, result: outcome.settled };
    });
  }

  console.log(JSON.stringify({
    mode: options.apply ? "apply" : "dry-run",
    idleHours: options.idleHours,
    examined: plan.totals.examined,
    settle: plan.totals.settle,
    kept: plan.kept,
    byProject: plan.settle,
    ...(options.apply ? { settled: settled.length } : {}),
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
