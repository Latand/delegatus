import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { McpTaskExecutor } from "./taskExecutor";
import { runAsMcpHttpCaller } from "./callerContext";
import { leasedHelperInput } from "@/lib/helperLease";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-executor-lifetime-"));
const FIXED_NOW = Date.parse("2026-10-20T00:00:00.000Z");
const executors: McpTaskExecutor[] = [];
beforeEach(() => fs.mkdirSync(root, { recursive: true }));
const call = (executor: McpTaskExecutor, name: string, args: Record<string, unknown>, context = {}) =>
  runAsMcpHttpCaller({ capability: "fixture" }, () => executor.callTool(name, args, context));
afterEach(async () => {
  await Promise.all(executors.splice(0).map(executor => executor.close()));
  fs.rmSync(root, { recursive: true, force: true });
});

for (const mode of ["abort-draining", "deadline-draining", "close", "close-timeout"]) test(`${mode} preserves peer calls until their replies settle`, async () => {
  const worker = path.join(root, "held-worker.ts");
  const ready = path.join(root, "held-ready"), release = path.join(root, "held-release"), admitted = path.join(root, "held-admitted");
  const receiptsPath = path.join(root, "held-receipts.json");
  const effectsPath = path.join(root, "held-effects.json");
  fs.writeFileSync(worker, `
    import fs from "node:fs";
    import { createInterface } from "node:readline";
    const jobs = new Map();
    const receiptsPath = ${JSON.stringify(receiptsPath)};
    const receipts = new Map(Object.entries(fs.existsSync(receiptsPath) ? JSON.parse(fs.readFileSync(receiptsPath, "utf8")) : {}));
    const effectsPath = ${JSON.stringify(effectsPath)};
    const effects = fs.existsSync(effectsPath) ? JSON.parse(fs.readFileSync(effectsPath, "utf8")) : {};
    const input = createInterface({ input: process.stdin });
    input.on("close", () => fs.writeFileSync(${JSON.stringify(ready)}, "eof"));
    input.on("line", line => {
      const request = JSON.parse(line);
      if (request.name === "identifyCapability") {
        process.stdout.write(JSON.stringify({ id: request.id, result: { conversationId: null } }) + "\\n");
        return;
      }
      if (request.shutdown) process.exit(0);
      if (request.cancel) {
        process.stdout.write(JSON.stringify({ id: 0, control: { heartbeat: true } }) + "\\n");
        fs.writeFileSync(${JSON.stringify(ready)}, "ready");
        return;
      }
      const key = request.args.clientRequestId;
      if (receipts.has(key)) {
        process.stdout.write(JSON.stringify({ id: request.id, result: { ...receipts.get(key), replayed: true } }) + "\\n");
        return;
      }
      jobs.set(request.id, request);
      if (jobs.size === 2) {
        fs.writeFileSync(${JSON.stringify(admitted)}, "ready");
        const timer = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(release)})) return;
          clearInterval(timer);
          for (const job of jobs.values()) {
            effects[job.args.clientRequestId] = (effects[job.args.clientRequestId] ?? 0) + 1;
            fs.writeFileSync(effectsPath, JSON.stringify(effects));
            const result = { ok: true, toolName: "update_task", clientRequestId: job.args.clientRequestId, replayed: false, revision: 1 };
            receipts.set(job.args.clientRequestId, result);
            fs.writeFileSync(receiptsPath, JSON.stringify(Object.fromEntries(receipts)));
            process.stdout.write(JSON.stringify({ id: job.id, result }) + "\\n");
          }
        }, 10);
      }
    });
  `);
  const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  const executor = new McpTaskExecutor({ launch: { executable: process.execPath, workerPath: worker },
    drainMs: mode === "close-timeout" ? 1000 : 35_000,
    schedule: (callback, delayMs) => {
      const entry = { callback, delayMs, cancelled: false };
      scheduled.push(entry);
      return () => { entry.cancelled = true; };
    },
    now: () => FIXED_NOW,
    env: { HOME: root, XDG_CONFIG_HOME: root, TMPDIR: root, LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" } });
  executors.push(executor);
  await executor.identifyCapability("fixture");
  const child = (executor as unknown as { child: ChildProcess }).child!;
  const input = leasedHelperInput(child);
  const write = input.write.bind(input);
  let cancellationWritesAfterEnd = 0;
  input.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    if (input.writableEnded && String(chunk).includes('"cancel"')) cancellationWritesAfterEnd++;
    return (write as (...values: unknown[]) => boolean)(chunk, ...args);
  }) as typeof input.write;
  const abort = new AbortController();
  const deadlineAt = FIXED_NOW + 10_000;
  const cancelled = call(executor, "update_task", { clientRequestId: "cancel-one" }, {
    ...(mode === "abort-draining" ? { signal: abort.signal } : mode === "deadline-draining" ? { deadlineAt } : {}),
  }).catch(error => error);
  let peerSettled = false;
  const peer = call(executor, "update_task", { clientRequestId: "commit-peer" }).then(result => { peerSettled = true; return result; }, error => { peerSettled = true; return error; });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(admitted) && Date.now() < deadline) await Bun.sleep(10);
  expect(fs.existsSync(admitted)).toBe(true);
  let closing: Promise<void> | undefined;
  if (mode === "abort-draining" || mode === "deadline-draining" || mode === "close" || mode === "close-timeout") closing = executor.close();
  while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
  expect(fs.existsSync(ready)).toBe(true);
  if (mode === "abort-draining") abort.abort();
  if (mode === "deadline-draining") {
    const timer = scheduled.find(entry => !entry.cancelled && entry.delayMs <= 10_000)!;
    expect(timer).toBeDefined();
    timer.callback();
  }
  expect(cancellationWritesAfterEnd).toBe(0);
  if (mode === "close-timeout") {
    scheduled.find(entry => !entry.cancelled && entry.delayMs === 1000)!.callback();
  } else {
    await expect(Promise.resolve().then(() => call(executor, "update_task", { clientRequestId: "late-key" })))
      .rejects.toThrow("before dispatch");
  }
  if (mode === "close-timeout") {
    await closing;
    for (const answer of [await cancelled, await peer]) {
      expect(answer).toBeInstanceOf(Error);
      expect(answer.message).toContain("drain deadline exceeded");
    }
    return;
  }
  fs.writeFileSync(release, "go");
  if (mode === "abort-draining" || mode === "deadline-draining") expect(await cancelled).toBeInstanceOf(Error);
  else expect(await cancelled).toMatchObject({ ok: true, revision: 1 });
  expect(await peer).toMatchObject({ ok: true, revision: 1 });
  expect(peerSettled).toBe(true);
  await closing;
  expect(await call(executor, "update_task", { clientRequestId: "commit-peer" })).toMatchObject({ replayed: true, revision: 1 });
  expect(JSON.parse(fs.readFileSync(effectsPath, "utf8"))).toMatchObject({ "commit-peer": 1 });
}, 15_000);
