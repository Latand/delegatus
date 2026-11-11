import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RESIDENT_WORKER_RSS_LIMIT_ENV, residentWorkerOverLimit, residentWorkerRssLimitBytes } from "@/lib/residentWorkerMemory";
import { McpTaskExecutor } from "./taskExecutor";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-worker-memory-"));
const worker = path.resolve("src/lib/mcpTask.worker.ts");
const executors: McpTaskExecutor[] = [];
let generation = 0;

/* The real task worker behind a one-line entry that records each process the
   executor starts. */
function executorWithLimit(limitMb: string | undefined) {
  const directory = path.join(root, `generation-${generation++}`);
  const state = path.join(directory, "state");
  fs.mkdirSync(state, { recursive: true });
  const spawns = path.join(directory, "spawns.log");
  const entry = path.join(directory, "entry.ts");
  fs.writeFileSync(entry, `require("node:fs").appendFileSync(${JSON.stringify(spawns)}, process.pid + "\\n");\nawait import(${JSON.stringify(worker)});\n`);
  const executor = new McpTaskExecutor({
    launch: { executable: process.execPath, workerPath: entry },
    env: { LLV_STATE_DIR: state, PORT: "", LLV_TOKEN: "", [RESIDENT_WORKER_RSS_LIMIT_ENV]: limitMb },
  });
  executors.push(executor);
  const pids = () => fs.existsSync(spawns) ? fs.readFileSync(spawns, "utf8").trim().split("\n").map(Number) : [];
  return { executor, pids };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await Bun.sleep(20);
  return condition();
}

afterEach(async () => { await Promise.all(executors.splice(0).map(executor => executor.close())); });
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

test("a task worker over its memory limit retires after its request and the next request starts a new one", async () => {
  // Any running worker holds more than one MiB.
  const { executor, pids } = executorWithLimit("1");
  expect(await executor.identifyCapability("unknown-capability")).toBeNull();
  const [first] = pids();
  expect(first).toBeGreaterThan(0);
  expect(await until(() => !alive(first!), 10_000)).toBe(true);
  expect(await executor.identifyCapability("unknown-capability")).toBeNull();
  expect(pids()).toHaveLength(2);
  expect(pids()[1]).not.toBe(first);
}, 60_000);

test("a task worker under its memory limit keeps serving from the same process", async () => {
  const { executor, pids } = executorWithLimit(undefined);
  expect(await executor.identifyCapability("unknown-capability")).toBeNull();
  await Bun.sleep(1_500);
  expect(await executor.identifyCapability("unknown-capability")).toBeNull();
  expect(pids()).toHaveLength(1);
  expect(alive(pids()[0]!)).toBe(true);
}, 60_000);

test("the shared ceiling spares a worker that served nothing and honours the override", () => {
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); };
  const over = { defaultLimitBytes: 1_000, rssBytes: 2_000, pid: 7, log, env: {} };
  expect(residentWorkerOverLimit("fixture", { ...over, served: 0 })).toBe(false);
  expect(residentWorkerOverLimit("fixture", { ...over, served: 1, rssBytes: 1_000 })).toBe(false);
  expect(lines).toHaveLength(0);
  expect(residentWorkerOverLimit("fixture", { ...over, served: 1 })).toBe(true);
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!.slice(lines[0]!.indexOf("{")))).toEqual({ name: "fixture", pid: 7, rssBytes: 2_000, limitBytes: 1_000, served: 1 });
  // Zero switches the ceiling off; a larger override raises it; nonsense keeps the default.
  expect(residentWorkerOverLimit("fixture", { ...over, served: 1, env: { [RESIDENT_WORKER_RSS_LIMIT_ENV]: "0" } })).toBe(false);
  expect(residentWorkerOverLimit("fixture", { ...over, served: 1, env: { [RESIDENT_WORKER_RSS_LIMIT_ENV]: "1" } })).toBe(false);
  expect(residentWorkerRssLimitBytes(1_000, { [RESIDENT_WORKER_RSS_LIMIT_ENV]: "2" })).toBe(2 * 1024 * 1024);
  expect(residentWorkerRssLimitBytes(1_000, { [RESIDENT_WORKER_RSS_LIMIT_ENV]: "many" })).toBe(1_000);
  expect(residentWorkerRssLimitBytes(1_000, { [RESIDENT_WORKER_RSS_LIMIT_ENV]: "-5" })).toBe(1_000);
});
