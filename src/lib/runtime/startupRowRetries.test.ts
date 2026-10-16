import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { StartupRowRetries, startupRowNotice, startupRowReason } from "./startupRowRetries";
import { AgentRegistry } from "@/lib/agent/registry";
import { loadTasks } from "@/lib/tasks/store";
import { statePath } from "@/lib/configDir";

const KEY = "codex:25300000-0000-0000-0000-000000000071";

test("backoff, quarantine and the missing-rollout reason survive real process restarts", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-retry-restart-"));
  const retryModule = path.join(import.meta.dir, "startupRowRetries.ts");
  const run = async (now: number) => {
    const child = Bun.spawn([process.execPath, "-e", `
      const { StartupRowRetries } = await import(${JSON.stringify(retryModule)});
      const store = new StartupRowRetries(${JSON.stringify(directory)});
      await store.load([${JSON.stringify(KEY)}]);
      const before = store.get(${JSON.stringify(KEY)});
      if (!store.due(${JSON.stringify(KEY)}, ${now})) console.log(JSON.stringify(before));
      else console.log(JSON.stringify(await store.failed(${JSON.stringify(KEY)}, "missing-rollout", ${now})));
    `], { cwd: process.cwd(), env: { ...process.env, LLV_STATE_OWNER: undefined }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(0);
    return JSON.parse(stdout);
  };
  try {
    expect(await run(1000)).toMatchObject({ attempts: 1, nextAt: 2000, quarantined: false });
    expect(await run(1500)).toMatchObject({ attempts: 1, nextAt: 2000 });
    expect(await run(2000)).toMatchObject({ attempts: 2, nextAt: 4000, quarantined: false });
    expect(await run(4000)).toMatchObject({ attempts: 3, nextAt: 64000, reason: "missing-rollout", quarantined: true });
    const store = new StartupRowRetries(directory);
    await store.load([KEY]);
    await store.notified(store.get(KEY)!);
    expect(store.get(KEY)?.noticePending).toBe(false);
    let now = 64000;
    for (let attempt = 4; attempt <= 11; attempt++) {
      const row = await store.failed(KEY, "incumbent-owned", now);
      expect(row.reason).toBe("missing-rollout");
      expect(row.noticePending).toBe(false);
      expect(row.nextAt - now).toBeLessThanOrEqual(900000);
      now = row.nextAt;
    }
    await store.clear(KEY);
    const restarted = new StartupRowRetries(directory); await restarted.load([KEY]);
    expect(restarted.get(KEY)).toBeUndefined();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("failure classification retains a fixed cause without persisting exception payloads", () => {
  expect(startupRowReason(new Error("no rollout found for thread id private-thread"))).toBe("missing-rollout");
  expect(startupRowReason(new Error("sensitive payload"))).toBe("adoption-failed");
  expect(startupRowReason(null)).toBe("adoption-failed");
});

test("a failed durable write leaves no in-memory budget and revoked ownership cannot publish", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-retry-refusal-"));
  const blocked = path.join(directory, "blocked"); fs.writeFileSync(blocked, "sentinel");
  try {
    const refused = new StartupRowRetries(blocked);
    await expect(refused.failed(KEY, "adoption-failed", 0)).rejects.toThrow();
    expect(refused.get(KEY)).toBeUndefined();
    expect(fs.readFileSync(blocked, "utf8")).toBe("sentinel");
    const store = new StartupRowRetries(path.join(directory, "rows"));
    await expect(store.failed(KEY, "adoption-failed", 0, () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
    expect(store.get(KEY)).toBeUndefined();
    expect(fs.readdirSync(path.join(directory, "rows"))).toEqual([]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("quarantine creates one seat-readable task, waits asynchronously for a peer writer and resolves it", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-retry-notice-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const entry = { key: { engine: "codex", sessionId: KEY.slice(6) }, cwd: directory } as never;
  const store = new StartupRowRetries(path.join(directory, "rows"));
  try {
    let row = await store.failed(KEY, "missing-rollout", 1000);
    row = await store.failed(KEY, "missing-rollout", row.nextAt);
    row = await store.failed(KEY, "missing-rollout", row.nextAt);
    // Initialize the task collection before its peer acquires the writer lock.
    await startupRowNotice(entry, row);
    const file = statePath("tasks.json");
    const peer = new Database(statePath("state.sqlite"));
    peer.exec("BEGIN IMMEDIATE");
    let timerAdvanced = false;
    const timer = setTimeout(() => { timerAdvanced = true; peer.exec("ROLLBACK"); }, 25);
    try { await startupRowNotice(entry, row); } finally { clearTimeout(timer); if (!timerAdvanced) peer.exec("ROLLBACK"); peer.close(); }
    expect(timerAdvanced).toBe(true);
    const tasks = loadTasks(file).filter(task => task.text.includes(KEY));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.text).toContain("missing-rollout");
    await startupRowNotice(entry, null);
    expect(loadTasks(file).find(task => task.id === tasks[0]!.id)?.status).toBe("done");
    await expect(startupRowNotice(entry, row, () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
    expect(loadTasks(file).find(task => task.id === tasks[0]!.id)?.status).toBe("done");
  } finally { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("two due rows each run once, serialize their work and discard a cleared timer", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-retry-fair-"));
  const store = new StartupRowRetries(directory);
  const other = "claude:25300000-0000-0000-0000-000000000075";
  const timers: (() => void)[] = [];
  const seen: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await store.failed(KEY, "incumbent-owned", 1000); await store.failed(other, "incumbent-owned", 1000);
    const schedule = (callback: () => void) => { timers.push(callback); return {}; };
    store.schedule(KEY, schedule, async () => { seen.push(KEY); await held; });
    store.schedule(KEY, schedule, async () => { throw new Error("duplicate timer"); });
    store.schedule(other, schedule, async () => { seen.push(other); });
    expect(timers).toHaveLength(2);
    timers[0]!(); timers[1]!();
    const deadline = performance.now() + 1000;
    while (seen.length === 0 && performance.now() < deadline) await Bun.sleep(1);
    expect(seen).toEqual([KEY]);
    release();
    while (seen.length < 2 && performance.now() < deadline) await Bun.sleep(1);
    expect(seen).toEqual([KEY, other]);
    store.schedule(KEY, schedule, async () => { seen.push("obsolete"); });
    await store.clear(KEY); timers[2]!();
    await Bun.sleep(1);
    expect(seen).toEqual([KEY, other]);
  } finally { release(); fs.rmSync(directory, { recursive: true, force: true }); }
});
