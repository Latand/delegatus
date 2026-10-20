import { SqliteStateCollection } from "@/lib/state/sqliteStateStore";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import { buildPipeline, pipelineStateCollectionSeeds, savePipelines, withPipelineStartupAdmission } from "../store";
import { initializeStateCollections } from "@/lib/state/sqliteStateStore";

const [mode, root, waitArg] = process.argv.slice(2);
if (!root || !waitArg) throw new Error("deadline fixture requires mode, state root and wait budget");
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.LLV_PIPELINE_LOCK_WAIT_MS = waitArg;
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });

const makePipeline = (id: string, task = "deadline evidence") => buildPipeline({ id, task, project: "fixture", repoDir: "/repo",
  stages: [{ id: "build", kind: "run", prompt: "build", next: null,
    effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
  srcPath: null, srcConversationId: null, now: "2026-10-20T00:00:00.000Z" });

if (mode === "cold-legacy" || mode === "cold-sqlite" || mode === "cold-cancel") {
  const padding = mode === "cold-sqlite" ? "x".repeat(256 * 1024) : "";
  const rows = Array.from({ length: 1024 }, (_, index) => makePipeline(`cold-${index}`, padding));
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR, "pipelines.json"), JSON.stringify({ schemaVersion: 5, pipelines: rows }));
  if (mode !== "cold-legacy") {
    // Seed authoritative SQLite rows without constructing the pipeline store.
    // The timed admission below must cover its first open as well as evidence.
    initializeStateCollections(path.join(process.env.LLV_STATE_DIR, "state.sqlite"), pipelineStateCollectionSeeds());
  }
  console.log("READY");
  const abort = new AbortController();
  const started = performance.now();
  if (mode === "cold-cancel") setTimeout(() => abort.abort(new Error("cold evidence cancelled")), 30);
  try {
    const admitted = await withPipelineStartupAdmission(async available => available, "reconciling structured hosts", undefined, true,
      { ...(mode === "cold-cancel" ? { signal: abort.signal } : {}) });
    const elapsedMs = performance.now() - started;
    const storeInitialized = fs.existsSync(path.join(process.env.LLV_STATE_DIR, "state.sqlite"));
    process.env.LLV_PIPELINE_LOCK_WAIT_MS = "5000";
    const recovered = await withPipelineStartupAdmission(async (available, refusal) => ({
      available, error: refusal instanceof Error ? refusal.message : String(refusal ?? ""),
    }), "reconciling structured hosts", undefined, true);
    console.log(JSON.stringify({ admitted, elapsedMs, recovered, cancelled: false, storeInitialized }));
  } catch (error) {
    const elapsedMs = performance.now() - started;
    if (mode !== "cold-cancel" || !abort.signal.aborted) throw error;
    const storeInitialized = fs.existsSync(path.join(process.env.LLV_STATE_DIR, "state.sqlite"));
    process.env.LLV_PIPELINE_LOCK_WAIT_MS = "5000";
    const recovered = await withPipelineStartupAdmission(async (available, refusal) => ({
      available, error: refusal instanceof Error ? refusal.message : String(refusal ?? ""),
    }), "reconciling structured hosts", undefined, true);
    console.log(JSON.stringify({ admitted: false, elapsedMs, recovered, cancelled: true, storeInitialized, error: error instanceof Error ? error.message : String(error) }));
  }
  process.exit(0);
}

savePipelines([makePipeline("deadline-seed")]);

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
