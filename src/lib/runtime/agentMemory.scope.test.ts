import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AgentMemoryCell, GIB, wrapAgentCommand, type AgentMemoryPlan } from "./agentMemory";

const scopeTest = process.env.LLV_AGENT_MEMORY_SCOPE_TEST === "1" ? test : test.skip;
scopeTest("real scope preserves the agent PID, observes its OOM and collects its private unit", async () => {
  const runner = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"] });
  const slice = `delegatus-agents-test-${process.pid}.slice`;
  const unit = `delegatus-agent-test-${process.pid}.scope`;
  const plan: AgentMemoryPlan = { mechanism: "scope", platform: "linux", limitBytes: 64 * 2 ** 20, budgetBytes: GIB, reserveBytes: GIB, totalBytes: 8 * GIB,
    score: 500, unit, slice, viewerUnit: null, systemdVersion: 255 };
  let child: ReturnType<typeof spawn> | null = null;
  const cell = new AgentMemoryCell(plan);
  try {
    runner("systemctl", ["--user", "set-property", "--runtime", slice, `MemoryMax=${GIB}`]);
    const wrapped = wrapAgentCommand(plan, process.execPath, ["-e", 'process.stdout.write("ready\\n"); setTimeout(() => { const bytes = new Uint8Array(256 * 1024 * 1024); for (let i = 0; i < bytes.length; i += 4096) bytes[i] = 1; process.stdout.write(String(bytes.length)); }, 500); setInterval(() => {}, 1000);']);
    child = spawn(wrapped.command, wrapped.args, { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", () => cell.settleExit({ expected: false }));
      child!.once("close", (code, signal) => resolve({ code, signal }));
    });
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.once("data", () => resolve());
      child!.once("error", reject);
      child!.once("close", () => reject(new Error("scope died before exec")));
    });
    const pid = child.pid!;
    expect(fs.readlinkSync(`/proc/${pid}/exe`)).toBe(fs.realpathSync(process.execPath));
    cell.attach(pid);
    const group = runner("systemctl", ["--user", "show", "--value", "-p", "ControlGroup", slice]).trim();
    expect(Number(fs.readFileSync(path.join("/sys/fs/cgroup", group, "memory.max"), "utf8"))).toBe(GIB);
    const result = await exited;
    expect(result.signal).toBe("SIGKILL");
    expect(cell.snapshot().lastKill).toMatchObject({ limit: "agent", limitBytes: 64 * 2 ** 20, fatal: true });
    let state = "";
    for (let i = 0; i < 50; i++) {
      state = runner("systemctl", ["--user", "show", "--value", "-p", "LoadState", unit]).trim();
      if (state === "not-found") break;
      await Bun.sleep(100);
    }
    expect(state).toBe("not-found");
  } finally {
    cell.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try { runner("systemctl", ["--user", "stop", slice]); } catch { /* Already collected. */ }
  }
}, 20_000);
