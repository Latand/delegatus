import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import { buildPipeline, savePipelines, withPipelineStartupAdmission } from "../store";

const [mode, root, waitArg] = process.argv.slice(2);
if (!root || !waitArg) throw new Error("deadline fixture requires mode, state root and wait budget");
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.LLV_PIPELINE_LOCK_WAIT_MS = waitArg;
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });

savePipelines([buildPipeline({ id: "deadline-seed", task: "deadline evidence", project: "fixture", repoDir: "/repo",
  stages: [{ id: "build", kind: "run", prompt: "build", next: null,
    effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
  srcPath: null, srcConversationId: null, now: "2026-10-20T00:00:00.000Z" })]);

if (mode === "sync-block") {
  console.log("READY");
  Bun.sleepSync(5_000);
  console.log(JSON.stringify({ blockedChildFinished: true }));
  process.exit(0);
}

const db = new Database(path.join(process.env.LLV_STATE_DIR, "state.sqlite"));
const prototype = SqliteStateCollection.prototype;
const originalAdmit = prototype.admit;
let invalidations = 0;
let invalidating = true;
prototype.admit = function<R>(this: SqliteStateCollection<unknown>, operation: () => R | Promise<R>, waitMs?: number, observe?: (ms: number) => void): Promise<R> {
  return originalAdmit.call(this, () => {
    if (invalidating) {
      db.query("UPDATE state_collections SET revision=revision+1 WHERE collection='pipelines'").run();
      invalidations++;
    }
    return operation();
  }, waitMs, observe) as Promise<R>;
};

console.log("READY");
try {
  const start = performance.now();
  const admitted = await withPipelineStartupAdmission(async available => available, "reconciling structured hosts", undefined, true);
  const elapsedMs = performance.now() - start;
  invalidating = false;
  const recovered = await withPipelineStartupAdmission(async available => available, "reconciling structured hosts", undefined, true);
  console.log(JSON.stringify({ elapsedMs, invalidations, admitted, refused: !admitted, recovered }));
} finally {
  prototype.admit = originalAdmit;
  db.close();
}
