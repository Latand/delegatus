import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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

for (const mode of ["parse", "unmatched", "eof", "input-destroy", "output-error", "output-private-code", "input-error", "input-private-code", "write-ended"] as const) {
  test(`${mode} preserves a safe retirement class and never resends a pending mutation`, async () => {
    const worker = path.join(root, "diagnostic-worker.ts");
    const ready = path.join(root, "diagnostic-ready");
    const records = path.join(root, "diagnostic-records.jsonl");
    const generations = path.join(root, "diagnostic-generation");
    const effects = path.join(root, "diagnostic-effects");
    const sentinel = "P".repeat(43), frameReason = "private-frame-reason";
    fs.writeFileSync(worker, `
      import fs from "node:fs";
      import { createInterface } from "node:readline";
      const generation = fs.existsSync(${JSON.stringify(generations)}) ? 2 : 1;
      fs.writeFileSync(${JSON.stringify(generations)}, String(generation));
      let count = 0;
      const input = createInterface({ input: process.stdin });
      setInterval(() => {}, 1000);
      input.on("close", () => { if (generation === 2 || ${JSON.stringify(mode)} !== "input-destroy") process.exit(0); });
      input.on("line", line => {
        const request = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(records)}, JSON.stringify({ generation, name: request.name, key: request.args.clientRequestId }) + "\\n");
        if (generation === 2 || count++ === 0) {
          if (request.name === "identifyCapability") process.stdout.write(JSON.stringify({ id: request.id, result: { conversationId: null } }) + "\\n");
          else {
            const replayed = fs.existsSync(${JSON.stringify(effects)});
            if (!replayed) fs.writeFileSync(${JSON.stringify(effects)}, "1");
            process.stdout.write(JSON.stringify({ id: request.id, result: { ok: true, toolName: "update_task", replayed, revision: 1 } }) + "\\n");
          }
          return;
        }
        if (count !== 3) return;
        const mode = ${JSON.stringify(mode)};
        if (mode === "parse") process.stdout.write(${JSON.stringify(sentinel + " Authorization: Bearer " + frameReason + "\n")});
        if (mode === "unmatched") process.stdout.write('{"id":9999,"result":{"conversationId":null}}\\n');
        if (mode === "eof") process.stdout.end();
        fs.writeFileSync(${JSON.stringify(ready)}, "ready");
      });
    `);
    const logs: string[] = [];
    const logging = spyOn(console, "error").mockImplementation(value => { logs.push(String(value)); });
    const executor = new McpTaskExecutor({ launch: { executable: process.execPath, workerPath: worker }, now: () => FIXED_NOW,
      schedule: () => () => {},
      env: { HOME: root, XDG_CONFIG_HOME: root, TMPDIR: root, LLV_STATE_DIR: path.join(root, "state"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" } });
    executors.push(executor);
    try {
      await executor.identifyCapability("fixture");
      const child = (executor as unknown as { child: ChildProcess }).child!;
      const input = leasedHelperInput(child);
      const peer = call(executor, "update_task", { clientRequestId: "diagnostic-peer" }).catch(error => error);
      const identity = executor.identifyCapability("fixture").catch(error => error);
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await Bun.sleep(5);
      expect(fs.existsSync(ready)).toBe(true);
      // The guardian also owns stdout. End the parent's stream explicitly to
      // exercise EOF while that real worker remains alive behind its lease.
      if (mode === "eof") child.stdout!.emit("end");
      let extra: Promise<unknown> | undefined;
      if (mode === "input-destroy") input.destroy(Object.assign(new Error(`${sentinel} ${frameReason}`), { code: "EPIPE" }));
      if (mode === "write-ended") {
        input.end();
        extra = executor.identifyCapability("fixture").catch(error => error);
      }
      if (mode.startsWith("input-") && mode !== "input-destroy" || mode.startsWith("output-")) {
        const stream = mode.startsWith("input-") ? input : child.stdout!;
        stream.emit("error", Object.assign(new Error(`${sentinel} ${frameReason}`), { code: mode.endsWith("private-code") ? "EPRIVATE_FRAME_REASON" : "EPIPE" }));
      }
      const expected = mode === "parse" ? "reply-unparseable" : mode === "unmatched" ? "reply-invalid"
        : mode === "eof" ? "output-ended" : mode === "input-destroy" ? "input-error:EPIPE"
        : mode === "write-ended" ? "input-write-failed" : mode.startsWith("input-") ? `input-error${mode.endsWith("private-code") ? "" : ":EPIPE"}`
        : `output-error${mode.endsWith("private-code") ? "" : ":EPIPE"}`;
      const answers = [await peer, await identity, ...(extra ? [await extra] : [])];
      for (const answer of answers) {
        expect(answer).toBeInstanceOf(Error);
        expect(String(answer)).toContain(`task executor stopped (${expected}) before its reply`);
        expect(String(answer)).not.toContain(sentinel); expect(String(answer)).not.toContain(frameReason);
      }
      const retirement = logs.filter(line => line.includes("task-executor-retire"));
      expect(retirement).toHaveLength(1);
      expect(retirement[0]).toContain(`"detail":"stopped (${expected})"`);
      for (const value of [sentinel, frameReason, "EPRIVATE_FRAME_REASON"]) expect(retirement[0]).not.toContain(value);
      expect(fs.existsSync(effects)).toBe(false);
      const readRecords = () => fs.readFileSync(records, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(readRecords().filter(row => row.key === "diagnostic-peer")).toEqual([{ generation: 1, name: "update_task", key: "diagnostic-peer" }]);
      expect(await call(executor, "update_task", { clientRequestId: "diagnostic-peer" })).toMatchObject({ ok: true, replayed: false, revision: 1 });
      expect(await call(executor, "update_task", { clientRequestId: "diagnostic-peer" })).toMatchObject({ ok: true, replayed: true, revision: 1 });
      expect(fs.readFileSync(effects, "utf8")).toBe("1");
      expect(readRecords().filter(row => row.key === "diagnostic-peer").map(row => row.generation)).toEqual([1, 2, 2]);
    } finally { await executor.close(); logging.mockRestore(); }
  }, 15_000);
}

for (const mode of ["viewer-idle", "worker-idle", "heartbeat", "closed-after-exit", "exited", "could-not-start"] as const) {
  test(`${mode} keeps its explicit retirement reason`, async () => {
    const worker = path.join(root, "idle-worker.ts");
    fs.writeFileSync(worker, `
      import { createInterface } from "node:readline";
      setInterval(() => {}, 1000);
      createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({ id: request.id, result: { conversationId: null } }) + "\\n");
      });
    `);
    const logs: string[] = [];
    const callbacks = new Map<number, () => void>();
    const originalTimeout = globalThis.setTimeout;
    const timing = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number, ...args: unknown[]) => {
      if (delay === 13_337 || delay === 31_000) callbacks.set(delay, callback);
      return originalTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    const logging = spyOn(console, "error").mockImplementation(value => { logs.push(String(value)); });
    const executor = new McpTaskExecutor({ launch: { executable: process.execPath, workerPath: worker }, idleMs: 13_337,
      env: { LLV_STATE_DIR: path.join(root, "state") } });
    executors.push(executor);
    try {
      await executor.identifyCapability("fixture");
      const child = (executor as unknown as { child: ChildProcess }).child!;
      if (mode === "viewer-idle") callbacks.get(13_337)!();
      if (mode === "heartbeat" || mode === "worker-idle") {
        child.stdout!.emit("data", Buffer.from(JSON.stringify({ id: 0, control: mode === "heartbeat" ? { heartbeat: true } : { retiring: true } }) + "\n"));
        if (mode === "heartbeat") callbacks.get(31_000)!();
      }
      if (mode === "could-not-start") child.emit("error", new Error("private startup reason"));
      if (mode === "closed-after-exit" || mode === "exited") {
        // Keep stdout EOF from winning this specific process-exit path.
        child.stdout!.removeAllListeners("end");
        if (mode === "closed-after-exit") {
          await new Promise<void>(resolve => { child.once("exit", () => { void executor.close().then(resolve); }); child.kill("SIGTERM"); });
        } else {
          await new Promise<void>(resolve => { child.once("close", () => resolve()); child.kill("SIGTERM"); });
        }
      }
      await executor.close();
      const reason = mode === "viewer-idle" ? "stopped (viewer-idle)" : mode === "worker-idle" ? "idle"
        : mode === "heartbeat" ? "stopped its heartbeat" : mode === "closed-after-exit" ? "stopped (closed-after-exit)"
        : mode === "could-not-start" ? "could not start" : "exited (143)";
      expect(logs.filter(line => line.includes("task-executor-retire"))).toHaveLength(1);
      expect(logs.join("\n")).toContain(`"detail":"${reason}"`);
      expect(logs.join("\n")).not.toContain("private startup reason");
    } finally { await executor.close(); logging.mockRestore(); timing.mockRestore(); }
  }, 10_000);
}
