import { afterAll, afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RESIDENT_WORKER_MIN_AGE_ENV, RESIDENT_WORKER_RSS_LIMIT_ENV, residentWorkerMinAgeMs, residentWorkerOverLimit, residentWorkerRssLimitBytes } from "@/lib/residentWorkerMemory";
import { McpTaskExecutor } from "./taskExecutor";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-worker-memory-"));
const worker = path.resolve("src/lib/mcpTask.worker.ts");
const executors: McpTaskExecutor[] = [];
let generation = 0;

/* The real task worker behind a one-line entry that records each process the
   executor starts. */
function executorWithLimit(limitMb: string | undefined, minAgeSeconds = "0") {
  const directory = path.join(root, `generation-${generation++}`);
  const state = path.join(directory, "state");
  fs.mkdirSync(state, { recursive: true });
  const spawns = path.join(directory, "spawns.log");
  const entry = path.join(directory, "entry.ts");
  fs.writeFileSync(entry, `require("node:fs").appendFileSync(${JSON.stringify(spawns)}, process.pid + "\\n");\nawait import(${JSON.stringify(worker)});\n`);
  const executor = new McpTaskExecutor({
    launch: { executable: process.execPath, workerPath: entry },
    env: { LLV_STATE_DIR: state, PORT: "", LLV_TOKEN: "", [RESIDENT_WORKER_RSS_LIMIT_ENV]: limitMb, [RESIDENT_WORKER_MIN_AGE_ENV]: minAgeSeconds },
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

/* Every request here lands just after the previous reply, which is when a
   worker over its limit announces retirement. A call that reached the
   retiring process was never started, and its successor answers it. */
test("requests sent back to back to a worker over its limit are all answered", async () => {
  const { executor, pids } = executorWithLimit("1");
  const failures: string[] = [];
  for (let index = 0; index < 12; index++) {
    try { expect(await executor.identifyCapability("unknown-capability")).toBeNull(); }
    catch (error) { failures.push((error as Error).message); }
  }
  expect(failures).toEqual([]);
  expect(pids().length).toBeGreaterThan(1);
}, 120_000);

/* A worker whose steady size is above its limit must not pay a cold start
   per request: memory retires no process younger than the age floor. */
test("a young task worker over its memory limit keeps serving from the same process", async () => {
  const { executor, pids } = executorWithLimit("1", "");
  for (let index = 0; index < 4; index++) {
    expect(await executor.identifyCapability("unknown-capability")).toBeNull();
    await Bun.sleep(400);
  }
  expect(pids()).toHaveLength(1);
  expect(alive(pids()[0]!)).toBe(true);
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
  const over = { defaultLimitBytes: 1_000, rssBytes: 2_000, pid: 7, ageMs: 600_000, log, env: {} };
  expect(residentWorkerOverLimit("fixture", { ...over, served: 0 })).toBe(false);
  expect(residentWorkerOverLimit("fixture", { ...over, served: 1, rssBytes: 1_000 })).toBe(false);
  // Five minutes is the age floor unless the override names another.
  expect(residentWorkerOverLimit("fixture", { ...over, served: 1, ageMs: 299_000 })).toBe(false);
  expect(residentWorkerOverLimit("fixture", { ...over, served: 1, ageMs: 5_000, env: { [RESIDENT_WORKER_MIN_AGE_ENV]: "10" } })).toBe(false);
  expect(lines).toHaveLength(0);
  expect(residentWorkerOverLimit("fixture", { ...over, served: 1, ageMs: 11_000, env: { [RESIDENT_WORKER_MIN_AGE_ENV]: "10" } })).toBe(true);
  expect(residentWorkerOverLimit("fixture", { ...over, served: 1 })).toBe(true);
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1]!.slice(lines[1]!.indexOf("{")))).toEqual({ name: "fixture", pid: 7, rssBytes: 2_000, limitBytes: 1_000, served: 1, ageMs: 600_000 });
  // Zero switches the ceiling off; a larger override raises it; nonsense keeps the default.
  expect(residentWorkerOverLimit("fixture", { ...over, served: 1, env: { [RESIDENT_WORKER_RSS_LIMIT_ENV]: "0" } })).toBe(false);
  expect(residentWorkerOverLimit("fixture", { ...over, served: 1, env: { [RESIDENT_WORKER_RSS_LIMIT_ENV]: "1" } })).toBe(false);
  expect(residentWorkerRssLimitBytes(1_000, { [RESIDENT_WORKER_RSS_LIMIT_ENV]: "2" })).toBe(2 * 1024 * 1024);
  expect(residentWorkerRssLimitBytes(1_000, { [RESIDENT_WORKER_RSS_LIMIT_ENV]: "many" })).toBe(1_000);
  expect(residentWorkerRssLimitBytes(1_000, { [RESIDENT_WORKER_RSS_LIMIT_ENV]: "-5" })).toBe(1_000);
  expect(residentWorkerMinAgeMs({})).toBe(300_000);
  expect(residentWorkerMinAgeMs({ [RESIDENT_WORKER_MIN_AGE_ENV]: "soon" })).toBe(300_000);
});
