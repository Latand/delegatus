import { waitForStateLock } from "@/lib/state/lockWait";
import fs from "node:fs";

import { importLegacyTasks, loadTasks, mutateTasks, mutateTasksAsync, prepareTaskRows } from "./store";
import { patchTask } from "./commands";
import type { BoardTask } from "./types";

const [mode, filePath, arg, gate] = process.argv.slice(2);
if (!mode || !filePath) throw new Error("task store child arguments are required");

function waitFor(filename: string): void {
  while (!fs.existsSync(filename)) Bun.sleepSync(2);
}

function task(id: string): BoardTask {
  return {
    id,
    project: "proj",
    status: "inbox",
    text: id,
    placement: "unplaced",
    assignments: [],
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

if (mode === "keyed-patch") {
  if (gate) waitFor(gate);
  for (let index = 0; index < 3; index++) await mutateTasksAsync(tasks => {
    const result = patchTask(tasks, arg!, { note: `${arg}-${index}` }, "2026-11-01T00:00:00.000Z");
    if (!result.ok) throw new Error(result.error);
    return { tasks: result.tasks, result: undefined };
  }, filePath);
} else if (mode === "recover-preparation") {
  const changedRows = await waitForStateLock("tasks.prepare.recovery", () => prepareTaskRows(filePath));
  console.log(JSON.stringify({ changedRows, repeat: prepareTaskRows(filePath) }));
} else if (mode === "hold-preparation") {
  prepareTaskRows(filePath, { afterPersist: () => {
    fs.writeFileSync(arg!, "ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  } });
} else if (mode === "import") {
  if (gate) waitFor(gate);
  const outcome = await waitForStateLock("tasks.import", () => importLegacyTasks(filePath, { reconcile: true }));
  console.log(JSON.stringify({ state: outcome.state, digest: outcome.record.rowDigest, rows: outcome.record.rowCount }));
} else if (mode === "append") {
  if (gate) waitFor(gate);
  for (let index = 0; index < Number(arg); index += 1) {
    await mutateTasksAsync((tasks) => ({ tasks: [...tasks, task(`${process.pid}-${index}`)], result: undefined }), filePath);
  }
  console.log(JSON.stringify({ tasks: loadTasks(filePath).length }));
} else if (mode === "reopen") {
  await waitForStateLock("tasks.import", () => importLegacyTasks(filePath, { reconcile: true }));
  console.log(JSON.stringify(loadTasks(filePath).map(task => task.id)));
} else if (mode === "hold-mutate") {
  // Killed with SIGKILL while holding the collection lease mid-write.
  mutateTasks((tasks) => {
    fs.writeFileSync(arg!, "ready");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    return { tasks: [...tasks, task("never-committed")], result: undefined };
  }, filePath);
} else if (mode === "hold-import") {
  // Killed with SIGKILL inside the import's BEGIN IMMEDIATE transaction.
  importLegacyTasks(filePath, {
    reconcile: true,
    hooks: {
      beforeVerify: () => {
        fs.writeFileSync(arg!, "ready");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      },
    },
  });
} else {
  throw new Error(`unknown task store child mode: ${mode}`);
}
