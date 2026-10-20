import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpTaskExecutor } from "./taskExecutor";
import { runAsMcpHttpCaller } from "./callerContext";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-executor-lifetime-"));
const executors: McpTaskExecutor[] = [];
beforeEach(() => fs.mkdirSync(root, { recursive: true }));
const call = (executor: McpTaskExecutor, name: string, args: Record<string, unknown>, context = {}) =>
  runAsMcpHttpCaller({ capability: "fixture" }, () => executor.callTool(name, args, context));
afterEach(async () => {
  await Promise.all(executors.splice(0).map(executor => executor.close()));
  fs.rmSync(root, { recursive: true, force: true });
});

for (const mode of ["cancel", "close", "close-timeout"]) test(`${mode} preserves peer calls until their replies settle`, async () => {
  const worker = path.join(root, "held-worker.ts");
  const ready = path.join(root, "held-ready"), release = path.join(root, "held-release"), admitted = path.join(root, "held-admitted");
  fs.writeFileSync(worker, `
    import fs from "node:fs";
    import { createInterface } from "node:readline";
    const jobs = new Map();
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
      jobs.set(request.id, request);
      if (jobs.size === 2) {
        fs.writeFileSync(${JSON.stringify(admitted)}, "ready");
        const timer = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(release)})) return;
          clearInterval(timer);
          for (const job of jobs.values()) process.stdout.write(JSON.stringify({ id: job.id,
            result: { ok: true, toolName: "update_task", clientRequestId: job.args.clientRequestId, replayed: false, revision: 1 } }) + "\\n");
        }, 10);
      }
    });
  `);
  const executor = new McpTaskExecutor({ launch: { executable: process.execPath, workerPath: worker },
    drainMs: mode === "close-timeout" ? 1000 : 35_000,
    env: { HOME: root, XDG_CONFIG_HOME: root, TMPDIR: root, LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" } });
  executors.push(executor);
  await executor.identifyCapability("fixture");
  const abort = new AbortController();
  const cancelled = call(executor, "update_task", { clientRequestId: "cancel-one" }, { signal: abort.signal }).catch(error => error);
  const peer = call(executor, "update_task", { clientRequestId: "commit-peer" }).catch(error => error);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(admitted) && Date.now() < deadline) await Bun.sleep(10);
  expect(fs.existsSync(admitted)).toBe(true);
  let closing: Promise<void> | undefined;
  if (mode === "cancel") abort.abort(); else closing = executor.close();
  while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
  expect(fs.existsSync(ready)).toBe(true);
  // An owned barrier deliberately exceeds the old one-second kill deadline.
  // The worker heartbeat proves this is cancellation retirement, not a stall.
  if (mode === "cancel") await Bun.sleep(1200);
  else await expect(call(executor, "update_task", { clientRequestId: "late-key" })).rejects.toThrow("before dispatch");
  if (mode === "close-timeout") {
    await closing;
    for (const answer of [await cancelled, await peer]) {
      expect(answer).toBeInstanceOf(Error);
      expect(answer.message).toContain("drain deadline exceeded");
    }
    return;
  }
  fs.writeFileSync(release, "go");
  if (mode === "cancel") expect(await cancelled).toBeInstanceOf(Error);
  else expect(await cancelled).toMatchObject({ ok: true, revision: 1 });
  expect(await peer).toMatchObject({ ok: true, revision: 1 });
  await closing;
}, 15_000);
